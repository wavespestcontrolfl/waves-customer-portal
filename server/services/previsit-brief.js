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
    );
  // No .catch(() => []) here: only a SUCCESSFUL empty query means "no
  // products". A transient DB/join failure collapsed to [] changes the
  // grounding hash and would persist a brief with the product guidance
  // erased over a valid cached one; propagate instead — runSweep counts
  // the visit failed and the prior brief survives.
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
    // strict — an outage here read as unknown_grass_track would hash
    // empty lawn guidance over a valid cached brief.
    const grass = await loadCustomerGrassContext(svc.customer_id, dbh, { strict: true });
    const scheduledDay = calendarDay(svc.scheduled_date);
    const serviceDate = scheduledDay ? parseETDateTime(`${scheduledDay}T12:00`) : new Date();

    const assignedWindowKey = svc.lawn_protocol_window_key || null;
    // strict: a transient protocol/product query failure must throw, not
    // read as "no guidance" — an emptied lawn block changes the grounding
    // hash and would overwrite a valid cached brief (runSweep counts the
    // visit failed and the prior brief survives).
    const query = { serviceDate, strict: true };
    if (assignedWindowKey) {
      query.windowKey = assignedWindowKey;
      // Resolve the assigned protocol row (key + version, newest match —
      // mirrors dynamic-context.resolveAssignedProtocolId) so the window
      // key is looked up on the protocol it was assigned FROM.
      if (svc.lawn_protocol_key) {
        const protocolQuery = dbh('lawn_protocols').where({ protocol_key: svc.lawn_protocol_key });
        if (svc.lawn_protocol_version) protocolQuery.where({ version: svc.lawn_protocol_version });
        // No .catch: a lookup OUTAGE must propagate — collapsing it into
        // "unresolved" would store assigned_protocol_unresolved guidance
        // over a valid cached brief.
        const protocolRow = await protocolQuery
          .orderBy('effective_from', 'desc')
          .orderBy('created_at', 'desc')
          .first('id');
        if (protocolRow?.id) {
          query.protocolId = protocolRow.id;
        } else {
          // Assigned protocol unresolvable — fail closed even when the
          // grass track is known: resolving the assigned window key
          // against the currently ACTIVE protocol can yield different
          // products/rates than the version this visit was assigned from
          // (lawn-protocol authority rule).
          return { ...NO_LAWN_GUIDANCE, reason: 'assigned_protocol_unresolved' };
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
    // PROTOCOL-level gates (calibration requirements, ordinance blackouts,
    // annual-rate ceilings) apply to the whole visit and cannot be
    // evaluated here — fail closed: while any exist, NO product presents
    // as fixed; everything ships as conditional with the protocol gates
    // attached so the tech sees the constraint (never a blocked product
    // as the fixed list).
    const protocolGates = (summary.gates || []).map((g) => ({
      key: g.key || null,
      type: g.type || null,
      severity: g.severity || null,
      title: cleanText(g.title, 160),
      ruleText: cleanText(g.ruleText, 300),
    }));
    const shaped = (summary.products || [])
      .map((p) => ({
        shapedEntry: shapeWindowProduct(p),
        // FIXED only when default-in-plan AND gate-free at BOTH layers —
        // a default row with product gates (maxTempF, soil conditions,
        // blackout sensitivity) or any protocol-wide gate is still
        // conditional guidance.
        fixed: p.defaultInPlan === true && !hasProductGates(p) && protocolGates.length === 0,
        gates: (p.gates && typeof p.gates === 'object') ? p.gates : {},
      }))
      .filter((p) => p.shapedEntry.name);
    return {
      source: 'lawn_protocol_window',
      available: !!summary.window,
      grassTrack: grass.trackKey || null,
      assignedWindowKey,
      protocol_gates: protocolGates,
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
    // Propagate — the lookups run strict for exactly this reason: a
    // transient failure converted to empty guidance would be hashed and
    // stored over a valid cached brief. runSweep counts the visit failed
    // and the prior brief survives.
    logger.warn(`[previsit-brief] lawn protocol window lookup failed: ${err.message}`);
    throw err;
  }
}

async function loadEstimateSource(dbh, sourceEstimateId) {
  if (!sourceEstimateId) return null;
  // No .catch — a lookup outage collapsed to null would hash and store a
  // brief missing the estimate scope over a valid cached one.
  const est = await dbh('estimates')
    .where({ id: sourceEstimateId })
    .first('id', 'status', 'waveguard_tier', 'service_interest', 'monthly_total', 'onetime_total');
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
  // redaction layer). NOT fail-soft: a context outage nulls fields that
  // feed the grounding hash, so continuing would replace a complete
  // cached brief with one missing account flags, calls, and pending
  // scope. Propagate — runSweep counts the visit failed and the prior
  // brief survives.
  const ContextAggregator = require('./context-aggregator');
  const context = await ContextAggregator.getContextForCustomer(customer);
  // Source-health sentinel: a recent-calls lookup FAILURE (not a quiet
  // phone) must abort — hashed as "no calls" it would overwrite a valid
  // cached brief.
  if (context?.sourceHealth?.recentCalls === 'unavailable') {
    throw new Error('recent-calls lookup unavailable — refusing to regenerate over the cached brief');
  }
  // The aggregator's own billing sentinel: an invoice-query outage also
  // zeroes the balance and drops the overdue flag — hashed, that would
  // overwrite a valid cached brief without its billing warning.
  if (context?.billing?.unavailable) {
    throw new Error('billing context unavailable — refusing to regenerate over the cached brief');
  }

  // Access/pet/chemical guidance is copied DETERMINISTICALLY from this
  // row — a lookup outage must not collapse into "no preferences": the
  // emptied access block changes the grounding hash and the sweep would
  // overwrite a valid cached brief without gate codes or pet warnings.
  // Propagate instead; runSweep counts the visit failed and the prior
  // brief survives untouched.
  const prefs = await dbh('property_preferences')
    .where({ customer_id: svc.customer_id })
    .first();

  const history = await loadRecentServiceRecords(dbh, svc.customer_id, svc.service_type);
  // available:false = history UNREADABLE, not empty. Continuing would hash
  // and persist a brief with last-visit and product guidance erased over a
  // valid cached one — abort this visit's generation instead (runSweep
  // counts it failed; the prior brief survives).
  if (!history.available) {
    throw new Error('service history unreadable — refusing to regenerate over the cached brief');
  }
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
    // strict + no swallow: an outage here hashed as "nothing since last
    // visit" would overwrite a valid cached brief.
    const { buildSinceLastVisitContext } = require('./service-report/since-last-visit');
    sinceLastVisit = await buildSinceLastVisitContext({
      record: { ...lastVisitRecord, service_date: calendarDay(lastVisitRecord.service_date) },
      knex: dbh,
      strict: true,
    }) || null;
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
- mentioned_terms: list EVERY product name and EVERY pest/organism/disease you mention anywhere in your response, lowercased. Empty array only if you mention none. A term you mention but do not list makes the response invalid.

Return VALID JSON ONLY:
{"priorities": ["<up to 3 short action items for this visit>"], "watch_items": ["<known issues/quirks worth a glance, from the facts>"], "last_visit_summary": "<1-2 sentences on the last visit, from the facts>", "open_scope": "<open estimate/quote scope in one sentence, or empty string>", "customer_context": "<1-2 sentences of customer quirks/preferences from calls, notes, flags>", "mentioned_terms": ["<every product and pest/organism/disease named in this response, lowercased>"]}`;

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
  'increased', 'decreased', 'reduced', 'elevated', 'ongoing', 'recent',
  'continued', 'heavy', 'light', 'minor', 'major', 'previous', 'general',
  'overall', 'seasonal', 'pest', 'insect',
]);

// Ordinary field-prose vocabulary (verbs/nouns/adjectives a brief uses,
// plus calendar words). The rare-word pass below rejects any output word
// outside this set, the stopwords, the grounding, and the self-reported
// terms — prose validation cannot prove a free sentence names no novel
// organism, so an unrecognized rare word fails the leg to the template
// (safe degradation; the brief must never carry invented guidance).
const COMMON_PROSE_WORDS = new Set([
  'about', 'above', 'access', 'account', 'action', 'address', 'after', 'again', 'ahead', 'alert',
  'along', 'amount', 'annual', 'apply', 'applied', 'applying', 'appointment', 'approach', 'arrival', 'arrive',
  'arriving', 'asked', 'attention', 'avoid', 'balance', 'baseboard', 'baseboards', 'basement', 'bathroom', 'bedroom',
  'before', 'begin', 'behind', 'below', 'between', 'billing', 'booked', 'booking', 'bring', 'building',
  'cabinet', 'cabinets', 'called', 'calling', 'cancel', 'cancelled', 'carefully', 'caution', 'check', 'checked',
  'checking', 'clear', 'close', 'closet', 'complete', 'completed', 'concern', 'concerns', 'condition', 'conditions',
  'confirm', 'confirmed', 'contact', 'continue', 'continued', 'corner', 'corners', 'coverage', 'covered', 'crawl',
  'credit', 'current', 'customer', 'cycle', 'damage', 'daytime', 'detail', 'details', 'discussed', 'dispatch',
  'document', 'driveway', 'during', 'earlier', 'early', 'entry', 'estimate', 'evening', 'every', 'expect',
  'expects', 'extra', 'family', 'fence', 'fencing', 'first', 'flag', 'flagged', 'focus', 'follow',
  'following', 'front', 'garage', 'garden', 'gate', 'gates', 'gutter', 'gutters', 'heavy', 'hedge',
  'hedges', 'history', 'home', 'hours', 'inspect', 'inspected', 'inspection', 'inside', 'invoice', 'issue',
  'issues', 'items', 'kitchen', 'knock', 'landscape', 'lanai', 'later', 'lawn', 'leave', 'light',
  'listed', 'locked', 'maintain', 'maintenance', 'member', 'membership', 'message', 'meter', 'monitor', 'monitoring',
  'month', 'monthly', 'morning', 'mulch', 'needs', 'nothing', 'note', 'noted', 'notes', 'notice',
  'notify', 'number', 'office', 'onsite', 'orders', 'other', 'outdoor', 'owner', 'panel', 'parking',
  'patio', 'payment', 'pending', 'perimeter', 'phone', 'photo', 'photos', 'place', 'placed', 'planned',
  'plans', 'plants', 'please', 'pool', 'porch', 'prefer', 'preference', 'preferences', 'prefers', 'pressure',
  'previous', 'prior', 'program', 'progress', 'quote', 'rate', 'ready', 'recap', 'recent', 'recently',
  'recheck', 'record', 'records', 'reminder', 'renewal', 'repair', 'report', 'reported', 'request', 'requested',
  'reschedule', 'rescheduled', 'resolve', 'resolved', 'response', 'return', 'review', 'reviewed', 'right', 'roof',
  'route', 'routine', 'schedule', 'scheduled', 'scope', 'screen', 'screened', 'season', 'secure', 'secured',
  'sensitive', 'sensitivity', 'setup', 'sheet', 'shrubs', 'siding', 'since', 'skip', 'slab', 'small',
  'soffit', 'spray', 'sprayed', 'spraying', 'spot', 'staff', 'start', 'started', 'status', 'still',
  'stone', 'stops', 'sweep', 'swept', 'technician', 'texts', 'thorough', 'through', 'times', 'today',
  'touch', 'toward', 'treat', 'treated', 'treatment', 'treatments', 'trees', 'update', 'updated', 'upcoming',
  'verify', 'visit', 'visits', 'walk', 'walkthrough', 'warrant', 'warrants', 'watch', 'water', 'weather',
  'weeks', 'weekly', 'window', 'windows', 'within', 'worth', 'yesterday', 'trail', 'trails', 'chemical', 'chemicals', 'across', 'during', 'under', 'beside', 'beneath', 'against',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // 4-letter prose words (threshold dropped to 4 so short organism names
  // like mice/rats are scanned; ordinary short words must stay known).
  'have', 'been', 'will', 'must', 'then', 'than', 'they', 'them', 'when', 'each',
  'only', 'also', 'some', 'more', 'most', 'done', 'sure', 'fine', 'good', 'open',
  'next', 'last', 'line', 'side', 'gate', 'note', 'call', 'text', 'week', 'days',
  'date', 'time', 'door', 'wall', 'lawn', 'turf', 'tree', 'were', 'work', 'both',
  'here', 'there', 'keep', 'left', 'high', 'look', 'like', 'plan', 'stop', 'take',
  'told', 'used', 'want', 'well', 'your', 'their', 'after', 'need', 'needs', 'ask',
  'asks', 'same', 'soon', 'once', 'twice', 'edge', 'best', 'back', 'full', 'half',
  'away', 'near', 'upon', 'very', 'much', 'many', 'wear', 'shoe', 'shoes', 'rain',
  'wind', 'heat', 'cold', 'warm', 'soil', 'seed', 'file', 'down', 'knock', 'card', 'paid', 'owed', 'owes', 'due', 'dues', 'crew', 'team', 'unit', 'step', 'path', 'walk', 'tarp', 'hose', 'pump', 'tank', 'mask', 'kit',
]);

// Short/common organism names — too short (or too domain-loaded) for the
// rare-word scan and unsound to substring-ground ('rat' matches inside
// 'operator'). Every occurrence must be WORD-BOUNDARY grounded.
const SHORT_ORGANISM_RE = /\b(rats?|mouse|mice|ants?|bees?|fly|flies|wasps?|ticks?|fleas?|moths?|slugs?|grubs?|mites?|voles?|moles?|gnats?|weeds?|aphids?)\b/g;

// Light stemming for the rare-word pass — plurals/participles of known or
// grounded words must not read as novel.
function wordVariants(word) {
  const out = [word];
  if (word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.endsWith('s')) out.push(word.slice(0, -1));
  if (word.endsWith('ing')) out.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
  if (word.endsWith('ed')) out.push(word.slice(0, -2), word.slice(0, -1));
  if (word.endsWith('ly')) out.push(word.slice(0, -2));
  return out;
}

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
  const instructed = new Set();
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
  // Capture is case-INSENSITIVE on the object ("apply bifen sc" must be
  // seen, not just "Apply Bifen SC"); the all-words-common skip in the
  // validator keeps ordinary prose objects ("use caution") from
  // over-rejecting.
  for (const m of text.matchAll(/\b(?:[Aa]ppl(?:y|ied|ying)|[Ss]pray(?:ed|ing)?|[Uu]s(?:e|ed|ing)|[Tt]reat(?:ed|ing)?)(?:\s+(?:with|the|a|an|some))*\s+([A-Za-z][\w.-]*(?:\s+(?!(?:for|to|on|in|at|the|a|an|and|or|with|along|around|near|across|into|onto|over|under|before|after|during|per|by|from)\b)[\w.-]+){0,3})/g)) push(instructed, m[1]);
  for (const m of text.matchAll(/\b(?:for|targeting|against)\s+((?:[a-z][a-z'-]*\s+){0,3}[a-z][a-z'-]*)/g)) push(targets, m[1]);
  // Organism references that never pass a preposition: "<X> activity/
  // damage/infestation" and "signs/evidence of <X>" ("Emerald ash borer
  // activity warrants inspection"). Case-insensitive captures — organisms
  // appear sentence-initial too; the stopword filter absorbs generic
  // modifiers ("increased", "ongoing") the captures drag in.
  for (const m of text.matchAll(/\b((?:[A-Za-z][\w'-]*\s+){0,3}[A-Za-z][\w'-]*?)\s+(?:activity|infestation|damage|pressure|droppings|nesting|sightings?)\b/g)) push(targets, m[1]);
  for (const m of text.matchAll(/\b(?:signs?|evidence|presence|history)\s+of\s+((?:[A-Za-z][\w'-]*\s+){0,3}[A-Za-z][\w'-]*)/g)) push(targets, m[1]);
  return { products: [...products], instructed: [...instructed], targets: [...targets] };
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
  // Product references ground on the EXACT normalized phrase — the fuzzy
  // every-word tier would let a renamed/recombined variant ("Bifen SC")
  // ride on a grounded sibling ("Bifen IT") because short suffixes fall
  // under the significant-word threshold. Targets keep the fuzzy tier
  // (word order and articles vary in organism prose).
  const groundedExact = (term) => {
    const phrase = String(term || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    return !phrase || groundedText.includes(phrase);
  };
  // Ordinary-prose verb objects ("use caution", "apply along the fence"):
  // a capture whose every word is a stopword/common-prose word is not a
  // product reference — the rare-word pass still owns single novel words.
  const allWordsCommon = (term) => String(term).toLowerCase().split(/\s+/).every((w) => (
    w.length < 4 || REFERENCE_STOP_WORDS.has(w) || COMMON_PROSE_WORDS.has(w)
  ));
  // Instruction fields (priorities, watch_items) direct the technician —
  // an application-verb product reference there must name a product on
  // the CURRENT visit's fixed list, not merely anything in the grounding:
  // last visit's product rides in llmFacts as history and must never
  // become an instruction when the current window excludes it
  // (lawn-protocol authority rule). Descriptive fields (last-visit
  // summary, context) may reference any grounded product.
  const fixedNames = (grounding.llmFacts?.productGuidance?.productNames || [])
    .map((n) => String(n).toLowerCase().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // EXACT normalized name only — either-side substring would let
  // "Apply Bifen" ride on fixed "Bifen IT", a renaming the prompt
  // forbids and the product authority rule rejects.
  // A capitalized capture is a PRODUCT (vs a service/street/person name)
  // when it matches the catalog vocabulary or any product list in the
  // grounding (fixed or historical).
  const knownProductNames = new Set([
    ...(vocab?.names || []),
    ...fixedNames,
    ...((grounding.llmFacts?.lastVisit?.productNames || []).map((n) => String(n).toLowerCase().replace(/\s+/g, ' ').trim())),
  ].filter(Boolean));
  const isKnownProductName = (term) => {
    const phrase = String(term || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    return !!phrase && knownProductNames.has(phrase);
  };
  const onFixedList = (term) => {
    const phrase = String(term || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    return !phrase || fixedNames.includes(phrase);
  };
  const labeledFields = [
    ...(body.priorities || []).map((text) => ({ text, instructional: true })),
    ...(body.watch_items || []).map((text) => ({ text, instructional: true })),
    { text: body.last_visit_summary, instructional: false },
    { text: body.open_scope, instructional: false },
    { text: body.customer_context, instructional: false },
  ].filter((f) => f.text);
  for (const field of labeledFields) {
    const refs = extractOutputReferences(String(field.text));
    for (const term of refs.products) {
      if (allWordsCommon(term)) continue;
      // A sentence-case application verb rides into the capitalized-run
      // capture ("Applied Prodiamine") — the verb is not part of the
      // product name; ground the remainder.
      const bare = String(term).replace(/^(?:appl(?:y|ied|ying)|spray(?:ed|ing)?|us(?:e|ed|ing)|treat(?:ed|ing)?)\s+/i, '');
      if (!groundedExact(bare)) return { kind: 'novel_product', term };
      // In instruction fields even a BARE product mention directs the
      // technician ("priorities: ['Bifen IT']") — when it names a known
      // product that is off the current fixed list, reject; grounded
      // non-product capitalized phrases (service names, streets) don't
      // match the catalog and pass through.
      if (field.instructional && isKnownProductName(bare) && !onFixedList(bare)) {
        return { kind: 'novel_product', term };
      }
    }
    for (const term of refs.instructed) {
      if (allWordsCommon(term)) continue;
      if (field.instructional) {
        if (!onFixedList(term)) return { kind: 'novel_product', term };
      } else if (!groundedExact(term)) {
        return { kind: 'novel_product', term };
      }
    }
    for (const term of refs.targets) {
      if (!isGroundedReference(term, groundedText)) return { kind: 'novel_target', term };
    }
  }
  // Rare-word pass — the shape regexes above cannot see every sentence
  // form ("Inspect unicorn beetles near the garage" passes them). Any
  // output word that is not stopword/common-prose, not in the grounding,
  // and not a (grounded-verified) self-reported term is treated as a
  // novel reference.
  const selfReported = new Set(
    (body.mentioned_terms || []).flatMap((t) => String(t).toLowerCase().split(/\s+/)),
  );
  // Organism boundary pass: short pest names checked with word-boundary
  // grounding (substring would false-ground 'rat' inside 'operator');
  // singular grounds on plural and vice versa.
  for (const field of outputFields) {
    for (const m of String(field).toLowerCase().matchAll(SHORT_ORGANISM_RE)) {
      const organism = m[1];
      const stems = [...new Set([organism, organism.replace(/s$/, ''), `${organism}s`,
        organism === 'mice' ? 'mouse' : organism, organism === 'flies' ? 'fly' : organism])];
      const escapeStem = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const grounded = stems.some((stem) => new RegExp(`\\b${escapeStem(stem)}s?\\b`).test(groundedText));
      if (!grounded) return { kind: 'novel_target', term: organism };
    }
  }
  const wordKnown = (word) => wordVariants(word).some((v) => (
    REFERENCE_STOP_WORDS.has(v)
    || COMMON_PROSE_WORDS.has(v)
    || selfReported.has(v)
    || groundedText.includes(v)
  ));
  for (const field of outputFields) {
    // 4+ characters: 'mice'/'rats'/'tick'/'flea'-length organisms must
    // not slip under the scan (3-letter singulars are covered in practice
    // by substring grounding — 'ant' grounds on 'ants').
    for (const m of String(field).toLowerCase().matchAll(/[a-z][a-z'-]{3,}/g)) {
      const word = m[0];
      // Hyphenated prose ("re-check", "walk-through"): known when every
      // part is known; short parts are below the rare-word threshold.
      const parts = word.split('-').filter(Boolean);
      const known = parts.length > 1
        ? parts.every((part) => part.length < 4 || wordKnown(part))
        : wordKnown(word);
      if (!known) return { kind: 'novel_term', term: word };
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
  // Structured self-report (complement to the prose regexes below, which
  // only see a few sentence shapes): the model must list every product
  // and pest/organism it mentions, and every listed term must be
  // grounded. A missing list rejects the leg.
  if (!Array.isArray(json.mentioned_terms)) return { reason: 'mentioned_terms_not_array' };
  const selfReportGrounding = JSON.stringify(grounding.llmFacts).toLowerCase();
  for (const term of json.mentioned_terms) {
    if (typeof term !== 'string') return { reason: 'mentioned_terms_not_string' };
    if (FORBIDDEN_TARGET_RE.test(term)) return { reason: 'forbidden_genus' };
    // EXACT normalized phrase, never the fuzzy word tier: "bifen sc"
    // must not ground on "Bifen IT" via the shared 'bifen' word (the
    // two-letter suffix is under the significant-word threshold).
    const phrase = String(term).toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    if (phrase && !selfReportGrounding.includes(phrase)) {
      return { reason: `ungrounded_term:${cleanText(term, 60)}` };
    }
  }
  const body = {
    priorities: sanitizeList(json.priorities, 3),
    watch_items: sanitizeList(json.watch_items, 6),
    last_visit_summary: cleanText(json.last_visit_summary, 500),
    open_scope: cleanText(json.open_scope, 400),
    customer_context: cleanText(json.customer_context, 500),
  };
  // Semantically empty output is a MISS, not a brief: cached as
  // generated_via 'llm' it would block regeneration (unchanged grounding
  // hash) while showing the tech nothing. Reject so the deterministic
  // template serves instead.
  const hasContent = body.priorities.length > 0
    || body.watch_items.length > 0
    || body.last_visit_summary
    || body.open_scope
    || body.customer_context;
  if (!hasContent) return { reason: 'empty_output' };
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
  const hashOf = (g) => crypto.createHash('sha256')
    .update(`${PROMPT_VERSION}|${stableStringify({
      llmFacts: g.llmFacts,
      access: g.access,
      productGuidance: g.productGuidance,
      lastVisitProducts: g.lastVisitProducts,
    })}`)
    .digest('hex');
  const groundingHash = hashOf(grounding);

  const existing = parseStoredBrief(svc.pre_service_brief);
  if (
    String(svc.pre_service_brief_type || '') === VISIT_BRIEF_TYPE
    && existing?.grounding_hash === groundingHash
  ) {
    return { skipped: true, reason: 'unchanged', brief: existing };
  }

  const { via, body } = await generateBriefBody(grounding, deps);

  // The LLM leg can run minutes. The CAS below only defends against
  // OTHER brief writers — preferences, protocol guidance, or the visit
  // itself may have changed with no competing write. Re-read the
  // deterministic grounding and verify the hash right before persisting;
  // a mismatch means this body was built from obsolete facts (stale
  // access codes included) — drop it and let the next sweep tick
  // regenerate from the fresh grounding.
  if (via !== 'template' || body) {
    const freshSvc = await dbh('scheduled_services')
      .where({ 'scheduled_services.id': scheduledServiceId })
      .first();
    if (!freshSvc) return { skipped: true, reason: 'not_found' };
    if (TERMINAL_STATUSES.has(String(freshSvc.status || '').toLowerCase())) {
      return { skipped: true, reason: 'terminal_status' };
    }
    const freshGrounding = await assembleGrounding(freshSvc, dbh);
    if (freshGrounding.error) return { skipped: true, reason: freshGrounding.error };
    if (hashOf(freshGrounding) !== groundingHash) {
      return { skipped: true, reason: 'grounding_changed' };
    }
  }

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

  // Compare-and-swap: generation can spend minutes in the LLM fallback
  // chain, and a concurrent regeneration (fresher grounding, fresher
  // access codes) may have written meanwhile — this run's stale brief
  // must never overwrite it. The row must still carry the exact
  // generated_at stamp read at load (or none), and the WDO guard rides
  // the same UPDATE so a concurrently-written WDO brief can never be
  // clobbered either. 0 rows = a newer writer won; nothing stored.
  const priorGeneratedAt = svc.pre_service_brief_generated_at || null;
  const updated = await dbh('scheduled_services')
    .where({ id: scheduledServiceId })
    .where(function notWdo() {
      this.whereNull('pre_service_brief_type').orWhereNot('pre_service_brief_type', WDO_BRIEF_TYPE);
    })
    .where(function sameGeneration() {
      if (priorGeneratedAt) this.where('pre_service_brief_generated_at', priorGeneratedAt);
      else this.whereNull('pre_service_brief_generated_at');
    })
    .update({
      pre_service_brief: JSON.stringify(brief),
      pre_service_brief_type: VISIT_BRIEF_TYPE,
      pre_service_brief_generated_at: new Date(),
    });
  if (!updated) return { skipped: true, reason: 'superseded' };

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
  // Bounded concurrency, not a serial walk: one provider stall can hold a
  // visit for the fallback chain's full multi-minute budget, and serially
  // that delay multiplies by route length while runExclusive keeps later
  // cron ticks from helping — the tail of the route would start briefless
  // exactly during an outage. Four workers bound the worst case without
  // hammering the provider.
  const queue = [...visits];
  const worker = async () => {
    for (let visit = queue.shift(); visit; visit = queue.shift()) {
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
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
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
