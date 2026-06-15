// Builds the enriched grounding context for the customer-facing "Generate AI
// service report" copy (the WHAT WE DID / WHAT WE FOUND sections). The goal is to
// hand the model real, visit-specific facts so the output stops reading like a
// template: prior-visit copy to deliberately differ from, pest-pressure trend,
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

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

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

// 'YYYY-MM-DD' date-only strings parse as UTC midnight, which an ET formatter
// renders as the PRIOR day. Anchor those at noon UTC so the calendar date never
// shifts; pass through everything else.
function parseServiceDate(value) {
  if (value == null || value === '') return new Date();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (ymd) return new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12));
  return new Date(value);
}

function formatShortDate(value) {
  const d = parseServiceDate(value);
  if (Number.isNaN(d.getTime())) return 'prior visit';
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
}

// fetchServiceWeekWeather needs a Date or 'YYYY-MM-DD' — the client sends a long
// US date ("June 15, 2026"), which it would slice into an invalid range and
// silently drop trailing-rainfall context. Normalize to 'YYYY-MM-DD' from the
// date's own components so the server's timezone can't shift the calendar day
// (date-only strings are noon-UTC anchored; long dates parse at local midnight,
// and both expose the intended Y/M/D directly).
function pad2(n) { return String(n).padStart(2, '0'); }
function toYmd(value) {
  const d = parseServiceDate(value);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}`;
}

function etMonth(serviceDate) {
  try {
    const d = serviceDate ? parseServiceDate(serviceDate) : new Date();
    const monthName = d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'long' });
    const monthNum = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric' }));
    return { monthName, monthNum: Number.isFinite(monthNum) ? monthNum : new Date().getMonth() + 1 };
  } catch {
    const now = new Date();
    return { monthName: now.toLocaleString('en-US', { month: 'long' }), monthNum: now.getMonth() + 1 };
  }
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

// Last N completed visits on the same service line, with their findings. The
// technician_notes carry the previously generated report copy — feeding it back
// lets the model see what it already said and deliberately vary, and surfaces
// recurring pests across visits.
async function loadPriorVisits({ customerId, serviceLine, serviceType, knex, limit = 2 }) {
  if (!customerId) return [];
  try {
    const rows = await knex('service_records')
      .where({ customer_id: customerId, status: 'completed' })
      .where(function sameLine() {
        if (serviceLine) {
          this.where({ service_line: serviceLine })
            .orWhere(function legacy() { this.whereNull('service_line').where({ service_type: serviceType }); });
        }
      })
      .orderBy('service_date', 'desc')
      .limit(limit)
      .select('id', 'service_date', 'service_type', 'technician_notes');
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
      notes: truncate(r.technician_notes, 600),
      findings: (byRecord[String(r.id)] || []).map((f) => ({ severity: cleanText(f.severity), title: cleanText(f.title) })),
    }));
  } catch (err) {
    logger.warn(`[report-copy-context] prior-visit load failed: ${err.message}`);
    return [];
  }
}

// Re-entry / rainfast / active-ingredient data for the products applied today,
// matched by catalog name. Drives concrete, label-accurate safety lines.
async function loadProductSafety(productNames, knex) {
  const names = [...new Set((productNames || []).map(cleanText).filter(Boolean))];
  if (!names.length) return [];
  try {
    const rows = await knex('products_catalog')
      .whereIn('name', names)
      .select('name', 'active_ingredient', 'epa_reg_number', 'rei_hours', 'rainfast_minutes', 'reentry_text');
    return rows.map((r) => ({
      name: cleanText(r.name),
      activeIngredient: cleanText(r.active_ingredient) || null,
      reiHours: finiteOrNull(r.rei_hours),
      rainfastMinutes: finiteOrNull(r.rainfast_minutes),
      reentryText: truncate(r.reentry_text, 200) || null,
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
    return {
      pets: Number(prefs.pet_count) > 0 ? (cleanText(prefs.pet_details) || `${prefs.pet_count} pet(s) on site`) : null,
      chemicalSensitivity: prefs.chemical_sensitivities
        ? (cleanText(prefs.chemical_sensitivity_details) || 'chemical sensitivity noted')
        : null,
      accessNotes: truncate(prefs.access_notes, 160) || null,
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
  const names = (Array.isArray(products) && products.length)
    ? products.map((p) => p.name).filter(Boolean)
    : productNames;

  const customer = await loadCustomer(customerId, knex);
  const lat = finiteOrNull(customer?.latitude);
  const lng = finiteOrNull(customer?.longitude);

  // Fan out the independent loads concurrently; each is individually fail-soft.
  const [priorVisits, productSafety, property, conditions, weekWeather, pressureTrend] = await Promise.all([
    loadPriorVisits({ customerId, serviceLine: line, serviceType, knex }),
    loadProductSafety(names, knex),
    loadPropertyContext(customerId, knex),
    (lat != null && lng != null)
      ? fetchApplicationConditions({ latitude: lat, longitude: lng }).catch(() => null)
      : Promise.resolve(null),
    (lat != null && lng != null)
      ? fetchServiceWeekWeather({ latitude: lat, longitude: lng, serviceDate: toYmd(serviceDate) }).catch(() => null)
      : Promise.resolve(null),
    customerId
      ? buildPressureTrendContext({
        record: { id: 'pending', customer_id: customerId, service_type: serviceType, service_line: line, pressure_index: null },
        knex,
      }).catch(() => null)
      : Promise.resolve(null),
  ]);

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

  if (pressureTrend?.customerSummary) {
    const dir = pressureTrend.direction && pressureTrend.direction !== 'unknown' ? ` [${pressureTrend.direction}]` : '';
    sections.push(`PEST PRESSURE TREND${dir}: ${cleanText(pressureTrend.customerSummary)}`);
  }

  const condLine = conditionsLine(conditions);
  if (condLine || weekWeather?.rainInches != null) {
    const wx = [
      condLine ? `At service: ${condLine}.` : null,
      weekWeather?.rainInches != null ? `Trailing 7-day rainfall: ${weekWeather.rainInches}".` : null,
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
      property.chemicalSensitivity ? `chemical sensitivity: ${property.chemicalSensitivity}` : null,
      property.accessNotes ? `access: ${property.accessNotes}` : null,
    ].filter(Boolean).join(' · ');
    if (bits) sections.push(`HOUSEHOLD NOTES: ${bits}`);
  }

  if (priorVisits.length) {
    const lines = priorVisits.map((v, i) => {
      const when = v.serviceDate ? formatShortDate(v.serviceDate) : 'prior visit';
      const found = v.findings.length ? ` Findings: ${v.findings.map((f) => `${f.title}${f.severity ? ` (${f.severity})` : ''}`).join('; ')}.` : '';
      const copy = v.notes ? ` Report copy: "${v.notes}"` : '';
      return `${i === 0 ? 'Most recent' : 'Earlier'} (${when}, ${cleanText(v.serviceType) || 'service'}):${found}${copy}`;
    });
    sections.push(`PRIOR VISITS (do NOT repeat this wording — vary it, and note what has CHANGED since):\n${lines.join('\n')}`);
  }

  const contextText = sections.length
    ? `\n\nGROUNDING CONTEXT (real facts for THIS customer — build the copy from these; never state anything not supported here or in the service notes)\n\n${sections.join('\n\n')}`
    : '';

  const signals = {
    hasCustomer: !!customer,
    priorVisitCount: priorVisits.length,
    productSafetyCount: productSafety.length,
    hasConditions: !!condLine,
    hasPressureTrend: !!pressureTrend?.customerSummary,
    targets,
    monthNum,
  };

  return { contextText, signals };
}

module.exports = {
  buildReportCopyContext,
  SWFL_SEASON_BY_MONTH,
};
