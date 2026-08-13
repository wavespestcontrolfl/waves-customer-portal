/**
 * Pre-visit "pocket reference" brief — generalization of the WDO
 * pre-inspection brief to EVERY scheduled visit (owner GO 2026-08-06;
 * coverage = all scheduled visits, cadence = 5:15am ET morning-of sweep).
 *
 * DARK BY DEFAULT: inert unless GATE_PREVISIT_BRIEF is set to exactly
 * 'true' (same convention as GATE_COMPLIANCE / payerStatements). The gate
 * is guarded HERE — single source of truth — and re-checked by the cron
 * leg before sweeping. Off = bit-for-bit no-op: no reads beyond the gate
 * check, no writes, no LLM calls.
 *
 * Shape (mirrors the WDO skeleton in appointment-tagger.js):
 *   - deterministic grounding assembly reusing existing pieces
 *     (context-aggregator — already redacts access codes — plus
 *     since-last-visit, service_products history joined to
 *     products_catalog, the estimate source, and the shared
 *     nextstop-alerts compiler);
 *   - one LLM pass at the WORKHORSE-equivalent visitBrief text policy
 *     (jsonMode, cross-provider) rewriting PROSE only;
 *   - deterministic template fallback on any LLM miss — the brief must
 *     NEVER block or be required for a visit;
 *   - stored at scheduled_services.pre_service_brief with
 *     pre_service_brief_type = 'visit_brief_v1'. A WDO brief
 *     ('wdo_inspection' — appointment-tagger.triggerWDOPrep's type) is
 *     NEVER overwritten: WDO wins, those visits are skipped.
 *
 * Hard rules encoded here:
 *   - Access codes / pets / chemical sensitivities are copied
 *     DETERMINISTICALLY from property_preferences into the stored brief's
 *     `access` block and NEVER pass through the LLM. The LLM sees only
 *     the already-redacted context-aggregator output.
 *   - Product lists are DETERMINISTIC fields assembled outside the LLM
 *     output — the model must not add, remove, or rename products. Lawn
 *     visits list ONLY the current protocol window's products
 *     (lawn-protocol-operating-layer, month + grass-track scoped); never
 *     an open-ended AI product suggestion, never efficacy-ranked global
 *     lists. Non-lawn visits list prior products from service_products
 *     history only.
 *   - Ganoderma / Thielaviopsis are never prefilled as targets; an
 *     unknown target is omitted. No invented field observations —
 *     history + label facts only, no predictions of what the tech "will
 *     find".
 *   - Input-hash cache (visit-summary-narrative precedent): the grounding
 *     hash is stored inside the brief jsonb; regeneration no-ops when the
 *     hash is unchanged, keeping the daily sweep near-free on stable
 *     routes.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const { compilePropertyAlerts } = require('./nextstop-alerts');
// The shared deterministic access-code redactor (context-aggregator's own
// layer) — re-applied here to EVERY free-text slice at the LLM boundary.
const { redactAccessCodes } = require('./context-aggregator');
const { normalizeServiceType, detectServiceCategory } = require('../utils/service-normalizer');
const { etDateString, etCalendarDayOf, parseETDateTime } = require('../utils/datetime-et');

// Exact stored type strings. WDO_BRIEF_TYPE mirrors
// appointment-tagger.js triggerWDOPrep (pre_service_brief_type:
// 'wdo_inspection') — the single value this lane must never clobber.
const VISIT_BRIEF_TYPE = 'visit_brief_v1';
const WDO_BRIEF_TYPE = 'wdo_inspection';

const PROMPT_VERSION = 'previsit_brief_v1';

// Statuses that are no longer an upcoming visit (mirrors
// PREP_TERMINAL_STATUSES in appointment-tagger.js / the admin-schedule
// terminal set) — the sweep and generator skip them.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']);

// ⛔ Never prefill these genera as targets (compliance rule — they require
// lab confirmation). Deterministic target lists are filtered; LLM list
// items mentioning them are dropped defensively too.
const FORBIDDEN_TARGET_RE = /ganoderma|thielaviopsis/i;

function briefGateEnabled() {
  return process.env.GATE_PREVISIT_BRIEF === 'true';
}

// Order-independent stringify (visit-summary-narrative precedent) so the
// grounding hash is stable across property insertion order.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function cleanText(value, max = 400) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

// Calendar day of a pg DATE value (scheduled_date, service_date) —
// node-postgres materializes DATE columns as UTC-midnight Dates, and the
// server runs UTC on Railway, so process-local getters are wrong twice a
// day. etCalendarDayOf handles exactly this shape (see datetime-et.js).
function calendarDay(value) {
  if (!value) return null;
  try {
    return etCalendarDayOf(value);
  } catch {
    return null; // unparseable input — omit rather than mislabel the day
  }
}

// ET calendar day of a REAL timestamp (created_at etc.) — a post-8pm-ET
// event on a UTC box must not label as the next day.
function timestampDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return etDateString(d);
  } catch {
    return null;
  }
}

// Deep-apply the access-code redactor to every string in the LLM payload.
// The aggregator already redacts its own slices; this boundary pass also
// covers strings assembled HERE from raw rows (pet/sensitivity flag
// details, call summaries, estimate service_interest, since-last lines) so
// no free-text path can carry a credential into a prompt.
function redactDeep(value) {
  if (typeof value === 'string') return redactAccessCodes(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

function parseStoredBrief(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// Deterministic target list: history values only, forbidden genera dropped,
// unknown/empty omitted (never guessed).
function safeTargets(targets) {
  const list = Array.isArray(targets) ? targets : [];
  return list
    .map((t) => cleanText(t, 80))
    .filter(Boolean)
    .filter((t) => !FORBIDDEN_TARGET_RE.test(t));
}

// service_products rows (joined to products_catalog label facts) → the
// deterministic product entries the brief stores. Label facts only.
function shapeHistoryProduct(row) {
  return {
    name: cleanText(row.catalog_name || row.product_name, 120),
    activeIngredient: cleanText(row.active_ingredient || row.catalog_active_ingredient, 120),
    epaRegNumber: cleanText(row.epa_reg_number, 40),
    moaGroup: cleanText(row.moa_group, 30),
    rate: row.application_rate != null ? Number(row.application_rate) : null,
    rateUnit: cleanText(row.rate_unit, 20),
    targets: safeTargets(row.targets),
  };
}

// ── Deterministic grounding assembly ────────────────────────────────────────

// Returns { available, last, lineRecords }. STRICTLY line-scoped via the
// shared paged walk (utils/last-line-service): a pest visit must never
// surface lawn/termite/tree records or their products — no same-line
// history means an EMPTY section, never a cross-line fallback. `last` is
// the any-line newest record and feeds ONLY the new-customer check. A
// query FAILURE is not an empty history: available:false marks the history
// UNREADABLE so no caller can turn an outage into the false fact "this is
// a first visit" (the new-customer claim is omitted entirely then).
async function loadRecentServiceRecords(dbh, customerId, serviceType) {
  try {
    const { loadRecentLineServices } = require('../utils/last-line-service');
    const { last, lineRecords, visitLine } = await loadRecentLineServices(dbh, customerId, serviceType, { limit: 5 });
    return { available: true, last, lineRecords, visitLine };
  } catch (err) {
    logger.warn(`[previsit-brief] service history unreadable for customer ${customerId}: ${err.message}`);
    return { available: false, last: null, lineRecords: [], visitLine: null };
  }
}

// The visit's service-line verdict — the SAME classifier the line-scoped
// history walk uses. null when the classifier is unavailable, and callers
// fail closed (drop the section) rather than leak cross-line rows.
function visitLineOf(serviceType) {
  try {
    const { detectServiceLine } = require('./service-report/service-line-configs');
    return detectServiceLine(serviceType) || null;
  } catch {
    return null;
  }
}

// Catalog vocabulary for the ungrounded-claim scan: every products_catalog
// name and label target term. Returns null when the catalog is unreadable
// (the caller fails CLOSED to the deterministic template — an unvalidatable
// LLM output is treated like a failed one).
async function loadCatalogVocabulary(dbh) {
  try {
    const rows = await dbh('products_catalog').select('name', 'target_pests');
    const names = new Set();
    const targets = new Set();
    for (const row of rows || []) {
      const name = cleanText(row.name, 120);
      if (name && name.length >= 4) names.add(name.toLowerCase());
      let pests = row.target_pests;
      if (typeof pests === 'string') {
        try { pests = JSON.parse(pests); } catch { pests = pests.split(','); }
      }
      for (const pest of Array.isArray(pests) ? pests : []) {
        const term = cleanText(pest, 80);
        if (term && term.length >= 4) targets.add(term.toLowerCase());
      }
    }
    return { names: [...names], targets: [...targets] };
  } catch (err) {
    logger.warn(`[previsit-brief] products_catalog vocabulary unreadable: ${err.message}`);
    return null;
  }
}

// recordIds arrive NEWEST-VISIT-FIRST from the line-scoped history walk,
// and that visit-recency order — not child-row created_at — orders the
// returned rows. Reopening an old recap deletes and reinserts its
// service_products (pest-recap.js), which gives a stale visit's rows the
// newest created_at; sorted by created_at, an edited old record could
// displace the latest visits' products from the 8-name guidance cap.
// created_at desc is kept only as the within-record tiebreak.
async function loadProductHistory(dbh, recordIds) {
  if (!recordIds.length) return [];
  const rows = await dbh('service_products as sp')
    .leftJoin('products_catalog as pc', 'sp.product_id', 'pc.id')
    .whereIn('sp.service_record_id', recordIds)
    .orderBy('sp.created_at', 'desc')
    .select(
      'sp.service_record_id',
      'sp.product_name',
      'sp.active_ingredient',
      'sp.moa_group',
      'sp.application_rate',
      'sp.rate_unit',
      'sp.targets',
      'pc.name as catalog_name',
      'pc.active_ingredient as catalog_active_ingredient',
      'pc.epa_reg_number',
    )
    .catch(() => []);
  const rank = new Map(recordIds.map((id, i) => [String(id), i]));
  // Array.prototype.sort is stable, so within-record created_at order holds.
  return rows.slice().sort((a, b) => (
    (rank.get(String(a.service_record_id)) ?? recordIds.length)
    - (rank.get(String(b.service_record_id)) ?? recordIds.length)
  ));
}

// One protocol-window product → the deterministic brief entry.
function shapeWindowProduct(p) {
  return {
    name: cleanText(p.productName, 120),
    role: cleanText(p.role, 60),
    applicationMode: cleanText(p.applicationMode, 40),
    ratePer1000: p.ratePer1000,
    rateUnit: cleanText(p.rateUnit, 20),
  };
}

// default_in_plan ≠ unconditional: default rows can carry gates too
// (maxTempF, soil/stress conditions, blackout sensitivity). No side-effect-
// free evaluator for this jsonb exists (the plan engine's conditional
// logic reads protocol text lines; the approvals engine persists), so the
// brief does not try to evaluate weather/soil gates — it classifies: only
// a default row with NO gates is fixed guidance.
function hasProductGates(p) {
  const gates = (p.gates && typeof p.gates === 'object') ? p.gates : {};
  return Object.keys(gates).length > 0;
}

const NO_LAWN_GUIDANCE = Object.freeze({
  source: 'lawn_protocol_window',
  available: false,
  window: null,
  products: [],
  conditional_products: [],
});

// Lawn visits: ONLY the products active for the visit's protocol window —
// the owner's bounded-product constraint. Window resolution order:
//   1. the visit's ASSIGNED window (scheduled_services.lawn_protocol_
//      window_key + lawn_protocol_key/version, same columns dynamic-context
//      and the plan engine read) — catch-up/rescheduled/manual assignments
//      must not be re-derived from the calendar;
//   2. otherwise month-of-service on the customer's KNOWN grass track.
// FAIL CLOSED: an unknown grass track (and no assignment) yields NO product
// guidance rather than a guessed St. Augustine window. The window's
// products split base (default_in_plan) vs conditional (gated/optional,
// each labeled with its trigger) mirroring the plan engine's
// base/conditional split — conditional rows are never presented as fixed.
async function loadLawnWindowGuidance(dbh, svc) {
  try {
    const { loadCustomerGrassContext } = require('./lawn-grass-context');
    const { getProtocolWindowContext, summarizeProtocolContext } = require('./lawn-protocol-operating-layer');
    const grass = await loadCustomerGrassContext(svc.customer_id, dbh);
    const scheduledDay = calendarDay(svc.scheduled_date);
    const serviceDate = scheduledDay ? parseETDateTime(`${scheduledDay}T12:00`) : new Date();

    const assignedWindowKey = svc.lawn_protocol_window_key || null;
    const query = { serviceDate };
    if (assignedWindowKey) {
      query.windowKey = assignedWindowKey;
      // Resolve the assigned protocol row (key + version, newest match —
      // mirrors dynamic-context.resolveAssignedProtocolId) so the window
      // key is looked up on the protocol it was assigned FROM.
      if (svc.lawn_protocol_key) {
        const protocolQuery = dbh('lawn_protocols').where({ protocol_key: svc.lawn_protocol_key });
        if (svc.lawn_protocol_version) protocolQuery.where({ version: svc.lawn_protocol_version });
        const protocolRow = await protocolQuery
          .orderBy('effective_from', 'desc')
          .orderBy('created_at', 'desc')
          .first('id')
          .catch(() => null);
        if (protocolRow?.id) {
          query.protocolId = protocolRow.id;
        } else if (!grass.trackKey) {
          // Assigned protocol unresolvable AND no known track to fall back
          // to — fail closed rather than resolving the key against an
          // arbitrary active protocol.
          return { ...NO_LAWN_GUIDANCE, reason: 'assigned_protocol_unresolved' };
        } else {
          query.grassTrack = grass.trackKey;
        }
      } else if (grass.trackKey) {
        query.grassTrack = grass.trackKey;
      } else {
        return { ...NO_LAWN_GUIDANCE, reason: 'unknown_grass_track' };
      }
    } else {
      // No assignment: month-of-service on the KNOWN track only — never
      // default a missing track to st_augustine.
      if (!grass.trackKey) {
        return { ...NO_LAWN_GUIDANCE, reason: 'unknown_grass_track' };
      }
      query.grassTrack = grass.trackKey;
    }

    const context = await getProtocolWindowContext(dbh, query);
    const summary = summarizeProtocolContext(context);
    if (!summary) {
      return { ...NO_LAWN_GUIDANCE, reason: 'no_active_protocol' };
    }
    const shaped = (summary.products || [])
      .map((p) => ({
        shapedEntry: shapeWindowProduct(p),
        // FIXED only when default-in-plan AND gate-free — a default row
        // with gates (maxTempF, soil conditions, blackout sensitivity) is
        // still conditional guidance.
        fixed: p.defaultInPlan === true && !hasProductGates(p),
        gates: (p.gates && typeof p.gates === 'object') ? p.gates : {},
      }))
      .filter((p) => p.shapedEntry.name);
    return {
      source: 'lawn_protocol_window',
      available: !!summary.window,
      grassTrack: grass.trackKey || null,
      assignedWindowKey,
      window: summary.window ? {
        key: summary.window.key,
        month: summary.window.month,
        title: summary.window.title,
        visitType: summary.window.visitType,
        goal: cleanText(summary.window.goal, 300),
      } : null,
      // Fixed guidance = default-in-plan, gate-free products only.
      products: shaped.filter((p) => p.fixed).map((p) => p.shapedEntry),
      // Everything gated or optional, carrying the COMPLETE gate object
      // (never just gates.trigger — premiumTier / soilPIndexBelow / maxTempF
      // and the rest must survive) plus the trigger convenience field.
      conditional_products: shaped.filter((p) => !p.fixed)
        .map((p) => ({
          ...p.shapedEntry,
          conditional: true,
          gates: p.gates,
          trigger: cleanText(p.gates.trigger, 120),
        })),
    };
  } catch (err) {
    logger.warn(`[previsit-brief] lawn protocol window lookup failed: ${err.message}`);
    return { ...NO_LAWN_GUIDANCE, reason: 'lookup_failed' };
  }
}

async function loadEstimateSource(dbh, sourceEstimateId) {
  if (!sourceEstimateId) return null;
  const est = await dbh('estimates')
    .where({ id: sourceEstimateId })
    .first('id', 'status', 'waveguard_tier', 'service_interest', 'monthly_total', 'onetime_total')
    .catch(() => null);
  if (!est) return null;
  return {
    status: est.status || null,
    tier: est.waveguard_tier || null,
    serviceInterest: cleanText(est.service_interest, 200),
    monthlyTotal: est.monthly_total != null ? Number(est.monthly_total) : null,
    onetimeTotal: est.onetime_total != null ? Number(est.onetime_total) : null,
  };
}

// The deterministic access block — copied straight from
// property_preferences, NEVER given to the LLM. The shared alerts compiler
// keeps this identical to what the tech Next-Stop card shows.
function buildAccessBlock(prefs, svc, genuinelyNew, normalizedType) {
  return {
    codes: {
      neighborhoodGate: prefs?.neighborhood_gate_code || null,
      propertyGate: prefs?.property_gate_code || null,
      garage: prefs?.garage_code || null,
      lockbox: prefs?.lockbox_code || null,
    },
    pets: prefs?.pet_details || (prefs?.pet_count > 0 ? `${prefs.pet_count} pet(s)` : null),
    petsSecuredPlan: prefs?.pets_secured_plan || null,
    chemicalSensitivities: prefs?.chemical_sensitivities
      ? (prefs.chemical_sensitivity_details || 'Chemical sensitivity')
      : null,
    accessNotes: prefs?.access_notes || null,
    parkingNotes: prefs?.parking_notes || null,
    specialInstructions: prefs?.special_instructions || null,
    alerts: compilePropertyAlerts({
      prefs,
      notes: svc.notes,
      genuinelyNew,
      servicePreferences: svc.service_preferences,
      normalizedServiceType: normalizedType,
    }),
  };
}

async function assembleGrounding(svc, dbh = db) {
  const customer = svc.customer_id
    ? await dbh('customers').where({ id: svc.customer_id }).first().catch(() => null)
    : null;
  if (!customer) return { error: 'no_customer', svc };

  const normalizedType = normalizeServiceType(svc.service_type);
  // Category classifies on the RAW service_type: normalizeServiceType maps
  // "Tree & Shrub Fertilization" / "Palm Fertilization" → "Lawn
  // Fertilization", which would route tree/shrub visits into the TURF
  // protocol window. detectServiceCategory handles the tree/shrub-vs-lawn
  // precedence itself on the raw string; normalization stays display-only.
  const category = detectServiceCategory(svc.service_type);

  // Redacted customer context (context-aggregator owns the access-code
  // redaction layer). Fail-soft — a context miss degrades the brief, never
  // blocks it.
  let context = null;
  try {
    const ContextAggregator = require('./context-aggregator');
    context = await ContextAggregator.getContextForCustomer(customer);
  } catch (err) {
    logger.warn(`[previsit-brief] context aggregation failed for ${svc.id}: ${err.message}`);
  }

  const prefs = await dbh('property_preferences')
    .where({ customer_id: svc.customer_id })
    .first()
    .catch(() => null);

  const history = await loadRecentServiceRecords(dbh, svc.customer_id, svc.service_type);
  const visitLine = history.visitLine ?? visitLineOf(svc.service_type);
  // Same-line ONLY — no any-line fallback: a cross-line "last visit" would
  // drag another line's products and notes into this visit's brief.
  const lastVisitRecord = history.lineRecords[0] || null;
  const productRows = await loadProductHistory(dbh, history.lineRecords.map((r) => r.id));
  const lastVisitProducts = lastVisitRecord
    ? productRows.filter((r) => r.service_record_id === lastVisitRecord.id).map(shapeHistoryProduct)
    : [];

  // Since-last-visit lines (pressure delta + recorded findings) for the
  // last same-line completed record.
  let sinceLastVisit = null;
  if (lastVisitRecord) {
    try {
      const { buildSinceLastVisitContext } = require('./service-report/since-last-visit');
      sinceLastVisit = await buildSinceLastVisitContext({
        record: { ...lastVisitRecord, service_date: calendarDay(lastVisitRecord.service_date) },
        knex: dbh,
      }) || null;
    } catch (err) {
      logger.warn(`[previsit-brief] since-last-visit failed for ${svc.id}: ${err.message}`);
    }
  }

  // Product guidance — deterministic, per the owner constraint. Lawn
  // visits: current protocol window ONLY. Everything else: prior products
  // from history only (deduped by name, newest first).
  let productGuidance;
  if (category === 'lawn') {
    productGuidance = await loadLawnWindowGuidance(dbh, svc);
  } else {
    const seen = new Set();
    const products = [];
    for (const row of productRows) {
      const shaped = shapeHistoryProduct(row);
      const key = (shaped.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      products.push(shaped);
      if (products.length >= 8) break;
    }
    productGuidance = { source: 'service_history', products };
  }

  const openScope = {
    sourceEstimate: await loadEstimateSource(dbh, svc.source_estimate_id),
    pendingEstimate: context?.pendingEstimate || null,
  };

  // First-visit is a POSITIVE claim: it may only be made when history was
  // actually readable and empty. An outage (available:false) asserts
  // nothing — no new-customer alert, no first-visit prompt fact.
  const genuinelyNew = history.available ? !history.last : false;
  const access = buildAccessBlock(prefs, svc, genuinelyNew, normalizedType);

  const catalogVocabulary = await loadCatalogVocabulary(dbh);

  // The ONLY facts the LLM may see: already-redacted context slices plus
  // deterministic history/label facts. No access block, no raw
  // property_preferences, no raw technician notes (serviceHistory notes are
  // the reviewed customer-safe parse), no call transcripts.
  const llmFacts = {
    visit: {
      serviceType: normalizedType,
      scheduledDate: calendarDay(svc.scheduled_date),
      isRecurring: !!svc.is_recurring,
      // Omitted entirely when history is unreadable — the model must not
      // see (and the template must not assert) a first-visit claim that an
      // outage manufactured.
      ...(history.available ? { newCustomer: genuinelyNew } : {}),
    },
    history: { available: history.available },
    lastVisit: lastVisitRecord ? {
      date: calendarDay(lastVisitRecord.service_date),
      serviceType: cleanText(lastVisitRecord.service_type, 120),
      productNames: lastVisitProducts.map((p) => p.name).filter(Boolean),
      sinceLastVisit: sinceLastVisit ? {
        pressureLine: sinceLastVisit.pressureLine || null,
        activityLine: sinceLastVisit.activityLine || null,
        actionLine: sinceLastVisit.actionLine || null,
      } : null,
    } : null,
    // Same-line ONLY, same verdict as loadRecentLineServices — the
    // aggregator's history is cross-line, and a pest brief must not
    // summarize lawn/termite/tree work. Classifier unavailable ⇒ the
    // section is dropped (fail closed), never passed unfiltered.
    serviceHistory: visitLine == null ? [] : (context?.serviceHistory || [])
      .filter((s) => visitLineOf(s.type) === visitLine)
      .map((s) => ({
        type: cleanText(s.type, 120),
        date: calendarDay(s.date),
        notes: cleanText(s.notes, 500),
      })),
    propertyProfile: context?.propertyProfile || null,
    flags: (context?.flags || []).map((f) => ({
      type: f.type,
      severity: f.severity,
      detail: cleanText(f.detail, 200),
    })),
    recentCalls: (context?.recentCalls || []).map((c) => ({
      date: timestampDay(c.date),
      direction: c.direction || null,
      summary: cleanText(c.summary, 500),
    })),
    recentInteractions: (context?.recentInteractions || []).map((i) => ({
      type: i.type,
      subject: cleanText(i.subject, 160),
      date: timestampDay(i.date),
    })),
    openScope,
    productGuidance: {
      source: productGuidance.source,
      // FIXED products only — conditional/gated rows are never handed to
      // the LLM as fixed guidance (they live, labeled, in the stored
      // brief's conditional_products).
      productNames: (productGuidance.products || []).map((p) => p.name).filter(Boolean),
      window: productGuidance.window || null,
    },
  };

  return {
    svc,
    customer,
    normalizedType,
    category,
    access,
    productGuidance,
    lastVisitRecord,
    lastVisitProducts,
    sinceLastVisit,
    openScope,
    catalogVocabulary,
    // Every free-text slice is run through the shared access-code redactor
    // at this boundary (belt over the context-aggregator's own layer):
    // pet/sensitivity flag details and call summaries arrive as raw
    // operator/customer text. The deterministic stored access block above
    // is intentionally NOT redacted.
    llmFacts: redactDeep(llmFacts),
  };
}

// ── LLM pass + deterministic fallback ───────────────────────────────────────

const SYSTEM_PROMPT = `You write an INTERNAL pre-visit pocket-reference brief for a Waves Pest Control technician. It is never shown to customers.

You are given deterministic grounding facts: the visit, the customer's prior visits and reviewed notes, property profile notes, account flags, recent call summaries, open estimate scope, and the deterministic product list for this visit.

Rules:
- Use ONLY the grounding facts. Never invent field observations, conditions, or history. Never predict what the technician "will find".
- Products: the product list is fixed. Never add, remove, rename, or rank products; prose may reference them by the given names only.
- Never name a pest or organism target that is not in the facts. Never mention Ganoderma or Thielaviopsis.
- Never include gate codes, garage codes, lockbox codes, or any credential — you have not been given them and must not guess.
- Plain, terse field language. No greetings, no markdown, no headings.

Return VALID JSON ONLY:
{"priorities": ["<up to 3 short action items for this visit>"], "watch_items": ["<known issues/quirks worth a glance, from the facts>"], "last_visit_summary": "<1-2 sentences on the last visit, from the facts>", "open_scope": "<open estimate/quote scope in one sentence, or empty string>", "customer_context": "<1-2 sentences of customer quirks/preferences from calls, notes, flags>"}`;

function sanitizeList(value, max, itemMax = 200) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => cleanText(item, itemMax))
    .filter(Boolean)
    .filter((item) => !FORBIDDEN_TARGET_RE.test(item))
    .slice(0, max);
}

// The always-safe brief body: deterministic facts, no prose generation.
function templateBriefBody(grounding) {
  const { llmFacts, sinceLastVisit } = grounding;
  const priorities = [];
  const highFlags = (llmFacts.flags || []).filter((f) => f.severity === 'high');
  for (const f of highFlags.slice(0, 2)) {
    priorities.push(`Account flag: ${f.detail || f.type}`);
  }
  if (llmFacts.visit.newCustomer) priorities.push('First visit — walk the property and set expectations');
  if (!priorities.length && llmFacts.lastVisit) {
    priorities.push(`Continue ${llmFacts.lastVisit.serviceType || 'service'} program from ${llmFacts.lastVisit.date || 'last visit'}`);
  }

  const watchItems = [];
  if (sinceLastVisit?.activityLine) watchItems.push(sinceLastVisit.activityLine);
  if (sinceLastVisit?.actionLine) watchItems.push(sinceLastVisit.actionLine);
  for (const f of (llmFacts.flags || [])) {
    if (f.severity !== 'high' && f.detail) watchItems.push(`${f.type}: ${f.detail}`);
  }

  const lastVisitSummaryParts = [];
  if (llmFacts.lastVisit) {
    lastVisitSummaryParts.push(`${llmFacts.lastVisit.serviceType || 'Visit'} on ${llmFacts.lastVisit.date || 'unknown date'}.`);
    if (sinceLastVisit?.pressureLine) lastVisitSummaryParts.push(sinceLastVisit.pressureLine + '.');
  }

  const openScopeParts = [];
  if (llmFacts.openScope.sourceEstimate) {
    openScopeParts.push(`Booked from estimate (${llmFacts.openScope.sourceEstimate.status || 'status unknown'}${llmFacts.openScope.sourceEstimate.tier ? `, ${llmFacts.openScope.sourceEstimate.tier}` : ''}).`);
  }
  if (llmFacts.openScope.pendingEstimate) {
    openScopeParts.push(`Open estimate pending (${llmFacts.openScope.pendingEstimate.tier || 'untiered'}).`);
  }

  return {
    priorities: sanitizeList(priorities, 3),
    watch_items: sanitizeList(watchItems, 6),
    last_visit_summary: lastVisitSummaryParts.join(' ') || null,
    open_scope: openScopeParts.join(' ') || null,
    customer_context: null,
  };
}

// Generic filler words that assert nothing on their own — trimmed out of
// extracted references before the fuzzy grounding check so "for the
// garage area" doesn't demand a literal grounded phrase.
const REFERENCE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'with',
  'for', 'from', 'this', 'that', 'any', 'all', 'new', 'known', 'active',
  'possible', 'potential', 'near', 'along', 'around', 'inside', 'outside',
  'under', 'over', 'front', 'back', 'side', 'corner', 'edge', 'line',
  'area', 'areas', 'yard', 'property', 'home', 'house', 'exterior',
  'interior', 'perimeter', 'activity', 'signs', 'sign', 'visit', 'service',
]);

// A reference is grounded when the whole normalized phrase appears in the
// grounding payload, or (fuzzy tier — word order/articles vary in prose)
// when every significant word of it does. A phrase left with no
// significant words asserts nothing and passes.
function isGroundedReference(candidate, groundedText) {
  const phrase = String(candidate || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
  if (!phrase) return true;
  if (groundedText.includes(phrase)) return true;
  const words = phrase.split(' ')
    .filter((w) => /^[a-z][a-z'-]{3,}$/.test(w) && !REFERENCE_STOP_WORDS.has(w));
  if (!words.length) return true;
  return words.every((w) => groundedText.includes(w));
}

// Allowlist-extraction of product-ish / target-ish references from brief
// prose (no NLP): every extracted reference must fuzzy-match the grounding
// or the response is rejected. This is the WHOLLY-NOVEL-name complement to
// the catalog scan below — a model-invented "PhantomGuard X" appears in no
// catalog, so iterating known vocabulary can never catch it.
// Product-ish: (a) mixed-internal-cap tokens ("PhantomGuard");
// (b) runs of 2+ Capitalized/ALLCAPS tokens ("Termidor SC", "Bifen IT") —
// letterless followers excluded so "July 15" isn't product-shaped;
// (c) the Capitalized phrase following an application verb.
// Target-ish: the lowercase phrase following "for"/"targeting"/"against" —
// how prose names what a product is applied against.
function extractOutputReferences(text) {
  const products = new Set();
  const targets = new Set();
  const push = (set, value) => {
    const t = String(value || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    if (t) set.add(t);
  };
  for (const m of text.matchAll(/\b[A-Z][a-z]+[A-Z][A-Za-z]*\b/g)) push(products, m[0]);
  for (const m of text.matchAll(/\b[A-Z][A-Za-z]+(?:\s+(?:[A-Z][A-Za-z]*[a-z][A-Za-z]*|[A-Z]{1,5}\d*|\d*[A-Z]+[A-Za-z\d]*))+/g)) push(products, m[0]);
  // Verb alternatives cover both sentence case and lowercase WITHOUT the /i
  // flag — under /i the [A-Z] anchor in the capture would match lowercase
  // words and flag ordinary prose ("use caution") as product references.
  for (const m of text.matchAll(/\b(?:[Aa]ppl(?:y|ied|ying)|[Ss]pray(?:ed|ing)?|[Uu]s(?:e|ed|ing)|[Tt]reat(?:ed|ing)?)(?:\s+(?:with|the|a|an|some))*\s+([A-Z][\w.-]*(?:\s+(?!(?:for|to|on|in|at|the|a|an|and|or|with|along|around|near)\b)[\w.-]+){0,3})/g)) push(products, m[1]);
  for (const m of text.matchAll(/\b(?:for|targeting|against)\s+((?:[a-z][a-z'-]*\s+){0,3}[a-z][a-z'-]*)/g)) push(targets, m[1]);
  return { products: [...products], targets: [...targets] };
}

// Ungrounded-claim scan: the model may only mention product names and pest
// or organism targets that appeared in its OWN input (the redacted
// llmFacts, which carry the deterministic fixed product-name lists). Two
// complementary passes share the grounding text:
//  1. catalog vocabulary — a KNOWN term in the output that is absent from
//     the input is an invented/renamed product or an ungrounded target;
//  2. extracted references (above) — a WHOLLY NOVEL name matches no
//     catalog term, so every product-ish/target-ish reference must
//     fuzzy-match the grounding to survive.
// Returns the offending term or null.
function findUngroundedClaim(body, grounding) {
  const vocab = grounding.catalogVocabulary;
  if (!vocab) return null; // caller handles the unreadable-catalog case
  const outputFields = [
    ...(body.priorities || []),
    ...(body.watch_items || []),
    body.last_visit_summary,
    body.open_scope,
    body.customer_context,
  ].filter(Boolean);
  if (!outputFields.length) return null;
  const outputText = outputFields.join(' ').toLowerCase();
  const groundedText = JSON.stringify(grounding.llmFacts).toLowerCase();
  const escapeRe = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const kind of ['names', 'targets']) {
    for (const term of vocab[kind] || []) {
      const re = new RegExp(`\\b${escapeRe(term)}\\b`);
      if (re.test(outputText) && !re.test(groundedText)) {
        return { kind, term };
      }
    }
  }
  // Extraction runs PER FIELD — joined text lets the capitalized-run and
  // verb-object regexes span a field boundary and manufacture phantom
  // references ("... Bifen IT" + "Chemical-sensitivity ..." is not a
  // product called "Bifen IT Chemical").
  for (const field of outputFields) {
    const refs = extractOutputReferences(String(field));
    for (const term of refs.products) {
      if (!isGroundedReference(term, groundedText)) return { kind: 'novel_product', term };
    }
    for (const term of refs.targets) {
      if (!isGroundedReference(term, groundedText)) return { kind: 'novel_target', term };
    }
  }
  return null;
}

// Full domain validation of one LLM JSON response. Returns
// { reason } on rejection or { body } (the sanitized brief body) on
// success. Runs INSIDE dispatchWithFallback's validate option so a bad
// primary response fails over to the secondary provider before the
// deterministic template — and again on the accepted response as defense
// in depth (test/mocked dispatch paths included).
//
// Shape rules close the {}-response trap: a truthy-but-empty object used
// to sanitize into all-empty fields, store generated_via:'llm', and the
// grounding hash then blocked regeneration until inputs changed.
function validateBriefJson(json, grounding) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { reason: 'not_an_object' };
  if (!Array.isArray(json.priorities)) return { reason: 'priorities_not_array' };
  if (!Array.isArray(json.watch_items)) return { reason: 'watch_items_not_array' };
  for (const field of ['last_visit_summary', 'open_scope', 'customer_context']) {
    if (json[field] != null && typeof json[field] !== 'string') return { reason: `${field}_not_string` };
  }
  // Banned genera anywhere in the RAW response (lists included) reject the
  // whole leg — never silently dropped item-by-item.
  const rawText = [...json.priorities, ...json.watch_items, json.last_visit_summary, json.open_scope, json.customer_context]
    .filter((v) => typeof v === 'string')
    .join(' ');
  if (FORBIDDEN_TARGET_RE.test(rawText)) return { reason: 'forbidden_genus' };
  const body = {
    priorities: sanitizeList(json.priorities, 3),
    watch_items: sanitizeList(json.watch_items, 6),
    last_visit_summary: cleanText(json.last_visit_summary, 500),
    open_scope: cleanText(json.open_scope, 400),
    customer_context: cleanText(json.customer_context, 500),
  };
  const ungrounded = findUngroundedClaim(body, grounding);
  if (ungrounded) {
    const kindLabel = {
      names: 'product',
      targets: 'target',
      novel_product: 'novel_product',
      novel_target: 'novel_target',
    }[ungrounded.kind] || ungrounded.kind;
    return { reason: `ungrounded_${kindLabel}:${ungrounded.term}` };
  }
  return { body };
}

async function generateBriefBody(grounding, deps = {}) {
  const fallback = () => ({ via: 'template', body: templateBriefBody(grounding) });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return fallback();
  // An unreadable catalog means NO response can be validated — fail closed
  // to the template without spending an LLM call at all.
  if (!grounding.catalogVocabulary) {
    logger.warn('[previsit-brief] catalog vocabulary unavailable — output unvalidatable; using deterministic template');
    return fallback();
  }
  const validate = (result) => {
    if (!result?.json) return 'no_json';
    return validateBriefJson(result.json, grounding).reason || null;
  };
  const callModel = deps.callModel
    || ((payload, opts) => dispatchWithFallback(MODELS.TEXT_POLICIES.visitBrief, {
      jsonMode: true,
      maxTokens: 1000,
      ...payload,
    }, opts));
  try {
    const resp = await callModel({
      system: SYSTEM_PROMPT,
      text: `Grounding facts:\n${JSON.stringify(grounding.llmFacts, null, 2)}\n\nReturn only the JSON object.`,
    }, { validate });
    if (!resp || !resp.ok || !resp.json) {
      logger.warn(`[previsit-brief] LLM miss (${resp?.reason || 'no json'}); using deterministic template`);
      return fallback();
    }
    // Defense in depth: the dispatcher already ran this validator per leg,
    // but injected/mocked call paths may not — never trust an unvalidated
    // response into the stored brief.
    const verdict = validateBriefJson(resp.json, grounding);
    if (verdict.reason) {
      logger.warn(`[previsit-brief] LLM output rejected (${verdict.reason}); using deterministic template`);
      return fallback();
    }
    return { via: 'llm', body: verdict.body };
  } catch (err) {
    logger.warn(`[previsit-brief] LLM pass failed: ${err.message}; using deterministic template`);
    return fallback();
  }
}

// ── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate (or refresh) the visit brief for one scheduled service.
 * Returns { generated: true, brief } on a write,
 * { skipped: true, reason } otherwise. Never throws for a per-visit data
 * problem; the sweep and the route both surface `reason`.
 */
async function generateVisitBrief(scheduledServiceId, { dbh = db, deps = {} } = {}) {
  if (!briefGateEnabled()) return { skipped: true, reason: 'gate_off' };

  const svc = await dbh('scheduled_services')
    .where({ 'scheduled_services.id': scheduledServiceId })
    .first();
  if (!svc) return { skipped: true, reason: 'not_found' };

  // WDO wins — never clobber a WDO brief, and never generate a generic
  // brief for a WDO-classified visit (the tagger owns that slot). Checked
  // BEFORE the grounding assembly so WDO visits pay nothing here.
  if (String(svc.pre_service_brief_type || '') === WDO_BRIEF_TYPE) {
    return { skipped: true, reason: 'wdo_brief_present' };
  }
  try {
    const AppointmentTagger = require('./appointment-tagger');
    if (AppointmentTagger.classifyAppointmentType(svc.service_type).tag === WDO_BRIEF_TYPE) {
      return { skipped: true, reason: 'wdo_visit' };
    }
  } catch { /* classifier unavailable — the stored-type guard above still holds */ }

  if (TERMINAL_STATUSES.has(String(svc.status || '').toLowerCase())) {
    return { skipped: true, reason: 'terminal_status' };
  }

  const grounding = await assembleGrounding(svc, dbh);
  if (grounding.error) return { skipped: true, reason: grounding.error };

  // Input-hash cache: everything that lands in the stored brief hashes in,
  // so any grounding change regenerates and an unchanged route no-ops.
  const groundingHash = crypto.createHash('sha256')
    .update(`${PROMPT_VERSION}|${stableStringify({
      llmFacts: grounding.llmFacts,
      access: grounding.access,
      productGuidance: grounding.productGuidance,
      lastVisitProducts: grounding.lastVisitProducts,
    })}`)
    .digest('hex');

  const existing = parseStoredBrief(svc.pre_service_brief);
  if (
    String(svc.pre_service_brief_type || '') === VISIT_BRIEF_TYPE
    && existing?.grounding_hash === groundingHash
  ) {
    return { skipped: true, reason: 'unchanged', brief: existing };
  }

  const { via, body } = await generateBriefBody(grounding, deps);

  const brief = {
    version: VISIT_BRIEF_TYPE,
    grounding_hash: groundingHash,
    generated_via: via,
    priorities: body.priorities,
    watch_items: body.watch_items,
    last_visit: {
      // date + products are DETERMINISTIC fields — never the LLM's.
      date: grounding.lastVisitRecord ? calendarDay(grounding.lastVisitRecord.service_date) : null,
      summary: body.last_visit_summary,
      products: grounding.lastVisitProducts,
    },
    open_scope: body.open_scope,
    customer_context: body.customer_context,
    product_guidance: grounding.productGuidance,
    // Deterministic access block — copied from property_preferences,
    // never through the LLM.
    access: grounding.access,
  };

  // The WDO guard rides the UPDATE too (not just the read above) so a
  // concurrently-written WDO brief can never be clobbered in the race
  // window between our read and this write.
  const updated = await dbh('scheduled_services')
    .where({ id: scheduledServiceId })
    .where(function notWdo() {
      this.whereNull('pre_service_brief_type').orWhereNot('pre_service_brief_type', WDO_BRIEF_TYPE);
    })
    .update({
      pre_service_brief: JSON.stringify(brief),
      pre_service_brief_type: VISIT_BRIEF_TYPE,
      pre_service_brief_generated_at: new Date(),
    });
  if (!updated) return { skipped: true, reason: 'wdo_brief_present' };

  return { generated: true, via, brief };
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/**
 * Morning-of sweep: generate briefs for TODAY's (ET) scheduled,
 * non-terminal visits. Entirely inert when the gate is off. One visit
 * failing never stops the rest.
 */
async function runSweep(dbh = db) {
  if (!briefGateEnabled()) return { skipped: true, reason: 'gate_off' };

  const todayEt = etDateString();
  const visits = await dbh('scheduled_services as s')
    .join('customers as c', 's.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    .where('s.scheduled_date', todayEt)
    .whereNotIn('s.status', [...TERMINAL_STATUSES])
    .orderBy('s.route_order', 'asc')
    .select('s.id');

  const result = { considered: visits.length, generated: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const visit of visits) {
    try {
      const outcome = await generateVisitBrief(visit.id, { dbh });
      if (outcome.generated) result.generated += 1;
      else if (outcome.reason === 'unchanged') result.unchanged += 1;
      else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`[previsit-brief] sweep generation failed for ${visit.id}: ${err.message}`);
    }
  }
  return result;
}

module.exports = {
  briefGateEnabled,
  generateVisitBrief,
  runSweep,
  VISIT_BRIEF_TYPE,
  WDO_BRIEF_TYPE,
  _test: {
    assembleGrounding,
    findUngroundedClaim,
    extractOutputReferences,
    isGroundedReference,
    validateBriefJson,
    redactDeep,
    loadCatalogVocabulary,
    templateBriefBody,
    generateBriefBody,
    buildAccessBlock,
    safeTargets,
    stableStringify,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
  },
};
