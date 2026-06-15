// Builds the enriched grounding context for the customer-facing "Generate AI
// service report" copy (the WHAT WE DID / WHAT WE FOUND sections). The goal is to
// hand the model real, visit-specific facts so the output stops reading like a
// template: prior-visit findings (for continuity / recurring pests), pressure trend,
// live weather, product re-entry/rainfast data, property/pet context, and SW
// Florida seasonality.
//
// Everything here is best-effort and fail-soft: a missing table, a slow weather
// API, or a customer with no history must degrade to "less context", never an
// error. The route always has the technician's notes to fall back on.

const db = require('../../models/db');
const logger = require('../logger');
const { buildPressureTrendContext } = require('./pressure-trend');
const { fetchApplicationConditions, fetchServiceWeekWeather } = require('./application-conditions');
const { detectServiceLine } = require('./service-line-configs');
const { etDateString } = require('../../utils/datetime-et');
const { loadActiveConfig } = require('../pest-pressure/store');
const { buildPestPressureCustomerView } = require('../pest-pressure/customer-view');

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// service_records.id is a UUID column; the report being generated may not exist
// yet (we ground a pending completion), so use the nil UUID as a placeholder.
// A literal like 'pending' makes buildPressureTrendContext's whereNot({id}) throw
// "invalid input syntax for type uuid", which its .catch() then swallows —
// silently dropping the pressure trend on every grounded report.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// One-line SW Florida (Manatee / Sarasota / Charlotte) seasonal hint per month.
// These are CONTEXT for setting realistic expectations — not facts to assert
// verbatim. Index 0 unused; months are 1-12.
const SWFL_SEASON_BY_MONTH = {
  1: 'Cool, dry season. Insect pressure is generally low; rodents may push indoors seeking warmth. St. Augustine turf is semi-dormant with slow growth.',
  2: 'Still cool and dry. Ant activity beginning to stir; good window for summer pre-emergent weed control. Lawn waking but slow.',
  3: 'Warming up. Ant and occasional roach activity rising; spring green-up underway; weed pressure climbing.',
  4: 'Tail of the dry season. Subterranean termite swarms begin; lawns actively growing; start watching for chinch bugs in St. Augustine.',
  5: 'Heat building, rainy season approaching. Termite swarms peak; mosquito and ant pressure rising; chinch bug risk increasing.',
  6: 'Rainy season. High mosquito and ant pressure; lawn fungus (gray leaf spot, brown patch) appears with moisture; rapid growth; rainfast timing matters.',
  7: 'Peak rainy season. Mosquitoes, ants, and roaches high; turf disease pressure high; frequent afternoon storms make application timing and rainfast important.',
  8: 'Peak heat and rain. Mosquito/ant/roach pressure high; chinch bug and fungus risk peak; heavy lawn growth.',
  9: 'Rainy/storm season continues. High pest and fungus pressure; turf still vigorous.',
  10: 'Rain tapering. Pest pressure easing; rodent activity picks up as nights cool; watch for fall large-patch disease.',
  11: 'Cooler and drier. Pest pressure dropping; rodent push-indoors increases; lawn growth slowing.',
  12: 'Cool, dry season. Low insect pressure; rodents seek warmth indoors; turf dormant/slow.',
};

// Resolve a service date to a calendar 'YYYY-MM-DD'. Inputs vary: the client sends
// a long US date ("June 15, 2026"); scheduled_date / service_date come from pg
// `date` columns, which node-pg returns as a JS Date at UTC midnight. ET
// discipline (AGENTS.md), WITHOUT rolling a timezone-less date-only value back a
// day:
//   - a Date object (pg date) → read UTC parts (its intended calendar day)
//   - a 'YYYY-MM-DD' string    → keep the literal calendar date
//   - an ISO string WITH a time component → project onto the ET calendar day
//   - a bare calendar string ("June 15, 2026") → local-midnight parse, local parts
//   - empty / unparseable      → today in ET
function pad2(n) { return String(n).padStart(2, '0'); }
function toYmd(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return etDateString();
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return etDateString();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return etDateString();
  if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(raw)) return etDateString(d);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Short display date for a prior visit, derived from the normalized calendar day
// (noon UTC, formatted in UTC) so pg `date` values don't render as the prior day.
function formatShortDate(value) {
  const ymd = toYmd(value);
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'prior visit';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function etMonth(serviceDate) {
  const ymd = toYmd(serviceDate);
  const monthNum = Number(ymd.slice(5, 7)) || 1;
  const monthName = new Date(`${ymd}T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return { monthName, monthNum };
}

async function loadCustomer(customerId, knex) {
  if (!customerId) return null;
  try {
    return await knex('customers')
      .where({ id: customerId })
      .first('id', 'first_name', 'last_name', 'city', 'state', 'latitude', 'longitude', 'lawn_type', 'waveguard_tier');
  } catch (err) {
    logger.warn(`[report-copy-context] customer load failed: ${err.message}`);
    return null;
  }
}

// Last N completed visits on the same service line, summarized by their structured
// findings only. Raw technician_notes are deliberately NOT loaded: they are
// free-form and can carry tech-only secrets (gate / lockbox codes, handling notes)
// that must not reach a customer-facing LLM. Findings (title + severity) are
// authored as findings and give the model enough to spot recurring pests and note
// change across visits.
async function loadPriorVisits({ customerId, serviceLine, serviceType, beforeDate, knex, limit = 2 }) {
  if (!customerId) return [];
  try {
    const rows = await knex('service_records')
      .where({ customer_id: customerId, status: 'completed' })
      // Only visits strictly before this service date — a backfilled/late report
      // must not be grounded on findings from visits that happened after it.
      .modify((q) => { if (beforeDate) q.where('service_date', '<', beforeDate); })
      .where(function sameLine() {
        if (serviceLine) {
          this.where({ service_line: serviceLine })
            .orWhere(function legacy() { this.whereNull('service_line').where({ service_type: serviceType }); });
        }
      })
      .orderBy('service_date', 'desc')
      .limit(limit)
      .select('id', 'service_date', 'service_type');
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const findings = await knex('service_findings')
      .whereIn('service_record_id', ids)
      .select('service_record_id', 'severity', 'title')
      .catch(() => []);
    const byRecord = findings.reduce((acc, f) => {
      const key = String(f.service_record_id);
      (acc[key] = acc[key] || []).push(f);
      return acc;
    }, {});
    return rows.map((r) => ({
      serviceDate: r.service_date,
      serviceType: r.service_type,
      findings: (byRecord[String(r.id)] || []).map((f) => ({ severity: cleanText(f.severity), title: cleanText(f.title) })),
    }));
  } catch (err) {
    logger.warn(`[report-copy-context] prior-visit load failed: ${err.message}`);
    return [];
  }
}

// Mirror of report-data.js's customer-facing gate (approvedReportProductFacts):
// only catalog rows flagged approved_for_service_report may drive customer copy,
// and a pesticide must carry a real EPA reg number. Kept local so this module
// stays self-contained — see server/services/service-report/report-data.js.
function catalogApprovedForReport(row) {
  if (!row || !row.approved_for_service_report) return false;
  const category = String(row.product_type || row.category || '').toLowerCase();
  const isPesticide = String(row.product_type || '') === 'pesticide'
    || /(herbicide|insecticide|fungicide|pgr|growth)/.test(category);
  if (isPesticide) {
    const epa = String(row.epa_reg_number || '').trim();
    if (!epa || /^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(epa)) return false;
  }
  return true;
}

// Re-entry / rainfast / active-ingredient data for the products applied today.
// Matched by catalog id (preferred) or name, and filtered to APPROVED,
// label-verified rows only — unapproved catalog rows must not drive customer copy.
async function loadProductSafety(products, knex) {
  const list = Array.isArray(products) ? products : [];
  const ids = [...new Set(list.map((p) => p && p.productId).filter(Boolean))];
  const names = [...new Set(list.map((p) => cleanText(p && p.name)).filter(Boolean))];
  if (!ids.length && !names.length) return [];
  try {
    const rows = await knex('products_catalog')
      .where(function matchCatalog() {
        // Prefer ids; only fall back to free-form names when NO ids were supplied,
        // so a stale/duplicate name can't pull facts for an unselected product.
        if (ids.length) this.whereIn('id', ids);
        else if (names.length) this.whereIn('name', names);
        else this.whereRaw('1 = 0');
      })
      .select('id', 'name', 'category', 'product_type', 'active_ingredient', 'epa_reg_number',
        'rei_hours', 'rainfast_minutes', 'reentry_text', 'reentry_summary', 'approved_for_service_report');
    return rows
      .filter(catalogApprovedForReport)
      .map((r) => ({
        name: cleanText(r.name),
        activeIngredient: cleanText(r.active_ingredient) || null,
        reiHours: finiteOrNull(r.rei_hours),
        rainfastMinutes: finiteOrNull(r.rainfast_minutes),
        reentryText: truncate(r.reentry_summary || r.reentry_text, 200) || null,
      }));
  } catch (err) {
    logger.warn(`[report-copy-context] product-safety load failed: ${err.message}`);
    return [];
  }
}

async function loadPropertyContext(customerId, knex) {
  if (!customerId) return null;
  try {
    const prefs = await knex('property_preferences').where({ customer_id: customerId }).first();
    if (!prefs) return null;
    // Deliberately NOT included: access_notes / gate / lockbox details. Those can
    // carry entry codes; feeding them to a customer-facing LLM (alongside
    // untrusted visit notes) is not a safe boundary. Chemical sensitivity is
    // surfaced only as a redacted flag, never the free-text health detail.
    // Pet count only — pet_details is free-form and can hold names or tech-only
    // handling notes; a redacted count is enough for re-entry guidance.
    return {
      pets: Number(prefs.pet_count) > 0 ? String(prefs.pet_count) : null,
      chemicalSensitivity: prefs.chemical_sensitivities ? 'a household chemical sensitivity is on file' : null,
    };
  } catch (err) {
    logger.warn(`[report-copy-context] property-preferences load failed: ${err.message}`);
    return null;
  }
}

function conditionsLine(conditions) {
  if (!conditions) return null;
  const parts = [
    conditions.temp_f != null ? `${Math.round(conditions.temp_f)}°F` : null,
    conditions.humidity_pct != null ? `${Math.round(conditions.humidity_pct)}% humidity` : null,
    conditions.wind_mph != null ? `${Math.round(conditions.wind_mph)} mph wind` : null,
    conditions.rain_24h_in != null ? `${Number(conditions.rain_24h_in).toFixed(2)}" rain in last 24h` : null,
    conditions.sky ? cleanText(conditions.sky) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Assemble the grounding block. Returns { contextText, signals }:
//  - contextText: the formatted block to append to the user message (may be '')
//  - signals: compact object for response caching + diagnostics
async function buildReportCopyContext({
  customerId,
  serviceType,
  serviceLine,
  products = [],
  productNames = [],
  serviceDate,
  knex = db,
} = {}) {
  const line = serviceLine || detectServiceLine(serviceType) || null;
  // Product list for the catalog lookup: prefer the structured products (carry
  // productId + name); fall back to bare names parsed from the products string.
  const productList = (Array.isArray(products) && products.length)
    ? products
    : (Array.isArray(productNames) ? productNames : []).map((name) => ({ name }));
  // Single normalized ET calendar date for this service — reused for history
  // bounds, the weather window, and the real-time check.
  const serviceYmd = toYmd(serviceDate);
  // Live conditions are only usable when the report is generated ON the service
  // date; otherwise we skip the fetch entirely (no point paying FAWN/Open-Meteo
  // latency for a value we'd discard).
  const isRealTime = serviceYmd === etDateString();

  const customer = await loadCustomer(customerId, knex);
  const lat = finiteOrNull(customer?.latitude);
  const lng = finiteOrNull(customer?.longitude);

  // Fan out the independent loads concurrently; each is individually fail-soft.
  const [priorVisits, productSafety, property, conditions, weekWeather, pressureTrend, ppConfig] = await Promise.all([
    loadPriorVisits({ customerId, serviceLine: line, serviceType, beforeDate: serviceYmd, knex }),
    loadProductSafety(productList, knex),
    loadPropertyContext(customerId, knex),
    (isRealTime && lat != null && lng != null)
      ? fetchApplicationConditions({ latitude: lat, longitude: lng }).catch(() => null)
      : Promise.resolve(null),
    (lat != null && lng != null)
      ? fetchServiceWeekWeather({ latitude: lat, longitude: lng, serviceDate: serviceYmd }).catch(() => null)
      : Promise.resolve(null),
    customerId
      ? buildPressureTrendContext({
        record: { id: NIL_UUID, customer_id: customerId, service_type: serviceType, service_line: line, pressure_index: null },
        beforeDate: serviceYmd,
        knex,
      }).catch(() => null)
      : Promise.resolve(null),
    loadActiveConfig(knex).catch(() => null),
  ]);

  // Respect the same customer-visibility gate the normal report paths use: when
  // Pest Pressure is hidden (feature off, showOnCustomerReport off, service line
  // not enabled, or one-time/specialty excluded), buildPestPressureCustomerView
  // returns null — and we must NOT surface a pressure trend in the copy either.
  const pressureVisible = buildPestPressureCustomerView({
    config: ppConfig,
    scoreRow: null,
    serviceRecord: { service_line: line, service_type: serviceType },
  }) !== null;

  const { monthName, monthNum } = etMonth(serviceDate);
  const seasonHint = SWFL_SEASON_BY_MONTH[monthNum] || null;

  // Pest targets the tech tagged per product today (PR2 surfaces the UI; the
  // column already persists, so read it when present).
  const targets = [...new Set(
    (Array.isArray(products) ? products : []).flatMap((p) => (Array.isArray(p.targets) ? p.targets : [])).map(cleanText).filter(Boolean),
  )];

  const sections = [];

  if (customer) {
    const who = [
      customer.city ? `${cleanText(customer.city)}, ${cleanText(customer.state || 'FL')}` : null,
      customer.lawn_type ? `turf: ${cleanText(customer.lawn_type)}` : null,
      customer.waveguard_tier ? `plan: WaveGuard ${cleanText(customer.waveguard_tier)}` : null,
    ].filter(Boolean).join(' · ');
    if (who) sections.push(`PROPERTY / PLAN: ${who}`);
  }

  sections.push(`SEASON (SW Florida, ${monthName}): ${seasonHint || 'No specific seasonal note.'}`);

  if (targets.length) {
    sections.push(`PESTS TARGETED TODAY (tech-tagged): ${targets.join(', ')}`);
  }

  // The current visit isn't scored at generate time, so buildPressureTrendContext
  // computes the trend from PRIOR completed visits only (its placeholder "current"
  // point is really the last completed visit). Present it honestly as history
  // through the last visit — never as "this visit's" reading — and don't reuse the
  // helper's customerSummary, which is phrased as if the latest point were today.
  // direction is only 'down'/'flat'/'up' when there are >=2 prior visits. The
  // helper only loads a short recent window, so its percentChange is vs the oldest
  // row in that window, NOT the customer's true first visit — don't cite a percent
  // or "first visit" baseline that the data can't support; describe the direction.
  let pressureLine = null;
  if (pressureVisible && pressureTrend && ['down', 'flat', 'up'].includes(pressureTrend.direction)) {
    const cur = pressureTrend.current?.pressureIndex;
    const reading = typeof cur === 'number' ? ` Most recent reading ~${cur.toFixed(1)} on a 0–5 scale (lower is better).` : '';
    if (pressureTrend.direction === 'down') {
      pressureLine = `Across recent visits, pest pressure has trended down.${reading}`;
    } else if (pressureTrend.direction === 'flat') {
      pressureLine = `Pest pressure has held steady across recent visits.${reading}`;
    } else {
      pressureLine = `Pest pressure has been trending up across recent visits.${reading}`;
    }
    sections.push(`PEST PRESSURE (history through the last completed visit — NOT a reading for this visit): ${pressureLine}`);
  }

  // Live conditions are labeled "at service" only for a same-day report (the
  // fetch was already skipped otherwise); trailing rainfall stays valid either way.
  const condLine = isRealTime ? conditionsLine(conditions) : null;
  if (condLine || weekWeather?.rainInches != null) {
    const wx = [
      condLine ? `At service: ${condLine}.` : null,
      weekWeather?.rainInches != null ? `Rainfall in the 7 days ending on the service date: ${weekWeather.rainInches}".` : null,
    ].filter(Boolean).join(' ');
    if (wx) sections.push(`WEATHER: ${wx}`);
  }

  if (productSafety.length) {
    const lines = productSafety.map((p) => {
      const bits = [
        p.activeIngredient ? `active: ${p.activeIngredient}` : null,
        p.reiHours != null ? `REI ${p.reiHours} hr` : null,
        p.rainfastMinutes != null ? `rainfast ${p.rainfastMinutes >= 60 ? `${(p.rainfastMinutes / 60).toFixed(p.rainfastMinutes % 60 ? 1 : 0)} hr` : `${p.rainfastMinutes} min`}` : null,
        p.reentryText ? `label: ${p.reentryText}` : null,
      ].filter(Boolean).join('; ');
      return `- ${p.name}${bits ? ` (${bits})` : ''}`;
    });
    sections.push(`PRODUCT SAFETY / RE-ENTRY (label data — use for re-entry & rainfast guidance, do not invent numbers):\n${lines.join('\n')}`);
  }

  if (property) {
    const bits = [
      property.pets ? `pets on site: ${property.pets}` : null,
      property.chemicalSensitivity || null,
    ].filter(Boolean).join(' · ');
    if (bits) sections.push(`HOUSEHOLD NOTES: ${bits}`);
  }

  if (priorVisits.length) {
    const withFindings = priorVisits.filter((v) => v.findings.length);
    if (withFindings.length) {
      const lines = withFindings.map((v, i) => {
        const when = v.serviceDate ? formatShortDate(v.serviceDate) : 'a prior visit';
        const found = v.findings.map((f) => `${f.title}${f.severity ? ` (${f.severity})` : ''}`).join('; ');
        return `${i === 0 ? 'Most recent' : 'Earlier'} (${when}, ${cleanText(v.serviceType) || 'service'}): ${found}.`;
      });
      sections.push(`PRIOR VISIT FINDINGS (reflect continuity; if a pest recurs, note it honestly — don't imply a recurring issue is brand new):\n${lines.join('\n')}`);
    } else {
      sections.push('PRIOR VISITS: this is an established customer with recent prior service (no flagged findings in the recent visits sampled) — reflect continuity rather than writing as a first-time visit. Do not state a specific number of past visits.');
    }
  }

  const contextText = sections.length
    ? `\n\nGROUNDING CONTEXT (real facts for THIS customer — build the copy from these; never state anything not supported here or in the service notes)\n\n${sections.join('\n\n')}`
    : '';

  const signals = {
    hasCustomer: !!customer,
    priorVisitCount: priorVisits.length,
    productSafetyCount: productSafety.length,
    hasConditions: !!condLine,
    hasPressureTrend: !!pressureLine,
    targets,
    monthNum,
  };

  return { contextText, signals };
}

module.exports = {
  buildReportCopyContext,
  SWFL_SEASON_BY_MONTH,
};
