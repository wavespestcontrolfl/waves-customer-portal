/**
 * Pre-visit "pocket reference" brief — generalization of the WDO
 * pre-inspection brief to EVERY scheduled visit (owner GO 2026-08-06;
 * coverage = all scheduled visits, cadence = 5:19am ET morning-of sweep
 * plus half-hourly :19/:49 backstops through 19:49).
 *
 * DARK BY DEFAULT: inert unless GATE_PREVISIT_BRIEF is set to exactly
 * 'true' (same convention as GATE_COMPLIANCE / payerStatements). The gate
 * is guarded HERE — single source of truth — and re-checked by the cron
 * leg before sweeping. Off = bit-for-bit no-op: no reads beyond the gate
 * check, no writes, no LLM calls.
 *
 * NO MODEL CALL: every brief is built from templateBriefBody. A model
 * used to rewrite the prose, behind GATE_PREVISIT_BRIEF_LLM (owner
 * decision 2026-09-26, #5044). Prod evidence then (llm_dispatch_log
 * 2026-09-25..26): the grounding validator rejected the Claude leg 76 of
 * 77 times and the OpenAI fallback 52 of 76. The gate was later found on
 * with no record of the flip (2026-10-02: 96 calls, all 48 Claude legs
 * rejected), so the gate and the provider call were removed (owner
 * 2026-10-03), and with them the validator that only checked model
 * output (its catalog-vocabulary read included).
 * A stored template is stamped llm_miss_kind 'gate_off' — the same stamp
 * the gate-off path wrote, so briefs stored before the removal stay cache
 * hits. A brief stored any other way (an old model rewrite, or a template
 * stuck 'validator'/'transient') is replaced with a template on its next
 * regeneration.
 *
 * Shape (mirrors the WDO skeleton in appointment-tagger.js):
 *   - deterministic grounding assembly reusing existing pieces
 *     (context-aggregator — already redacts access codes — plus
 *     since-last-visit, service_products history joined to
 *     products_catalog, the estimate source, and the shared
 *     nextstop-alerts compiler);
 *   - the deterministic template (templateBriefBody) as the brief body
 *     — the brief must NEVER block or be required for a visit;
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
const { compilePropertyAlerts } = require('./nextstop-alerts');
// The shared deterministic access-code redactor (context-aggregator's own
// layer) — re-applied here to EVERY free-text slice at the LLM boundary.
const { redactAccessCodes, customerSafeVisitNotes } = require('./context-aggregator');
const { normalizeServiceType, stripServiceSuffixes, detectServiceCategory } = require('../utils/service-normalizer');
const { etDateString, etCalendarDayOf, parseETDateTime } = require('../utils/datetime-et');

// Exact stored type strings. WDO_BRIEF_TYPE mirrors
// appointment-tagger.js triggerWDOPrep (pre_service_brief_type:
// 'wdo_inspection') — the single value this lane must never clobber.
const VISIT_BRIEF_TYPE = 'visit_brief_v1';
const WDO_BRIEF_TYPE = 'wdo_inspection';

// v2 (codex #3423 r15): the grounding-validator tightening must invalidate
// cached v1 briefs — an unchanged grounding hash would keep serving
// pre-tightening bodies (e.g. a cached retired-name mention) forever.
// v4: schema-constrained output (jsonSchema) — separates prompt-only JSON
// briefs from provider-constrained ones in the cache key.
// v5: the validator repair round. Bumped so templates capped under v4
// (llm_attempts at the cap, same grounding) hash differently and get their
// one repair round instead of returning validator_capped forever.
// v6: visit.oneTime fact + 'one-time' grounding token — the bump invalidates
// same-hash validator_capped templates so capped visits regenerate (codex
// #4198 r1 P2).
const PROMPT_VERSION = 'previsit_brief_v6';

// Statuses that are no longer an upcoming visit (mirrors
// PREP_TERMINAL_STATUSES in appointment-tagger.js / the admin-schedule
// terminal set) — the sweep and generator skip them.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']);

// ⛔ Never prefill these genera as targets (compliance rule — they require
// lab confirmation). Deterministic target lists are filtered.
const FORBIDDEN_TARGET_RE = /ganoderma|thielaviopsis/i;

function briefGateEnabled() {
  return process.env.GATE_PREVISIT_BRIEF === 'true';
}

// Deterministic visit facts for the tech Visit Brief read path — served by
// GET /admin/schedule/:id/visit-brief alongside a `{brief: null}` answer
// (none stored, gate off, or stale) so the field tech still gets the
// verified facts: the access block (gate/garage/lockbox codes, pets,
// chemical sensitivities, parking/access notes) and the last same-line
// visit's products. Zero LLM calls, zero storage. Dark behind its own
// flag because serving raw access codes on a path that previously
// answered `{brief: null}` is a new exposure surface, however
// tech-ownership-scoped the route already is.
function visitFactsGateEnabled() {
  return process.env.GATE_VISIT_FACTS === 'true';
}

// Unlike brief GENERATION (strict-fail so an outage never overwrites a
// valid cached brief), this is a read-path convenience with no cached
// artifact to protect — every lookup is FAIL-SOFT and a partial answer
// beats a 500. The route omits the key entirely if this still throws.
async function deterministicVisitFacts(svc, dbh = db) {
  let prefs = null;
  let prefsUnavailable = false;
  try {
    prefs = await dbh('property_preferences').where({ customer_id: svc.customer_id }).first();
  } catch (err) {
    prefsUnavailable = true;
    logger.warn(`[previsit-brief] visit-facts property_preferences unreadable for customer ${svc.customer_id}: ${err.message}`);
  }
  const history = await loadRecentServiceRecords(dbh, svc.customer_id, svc.service_type);
  // First-visit is a POSITIVE claim (same rule as assembleGrounding):
  // unreadable history (available:false) asserts nothing.
  const genuinelyNew = history.available ? !history.last : false;
  // A prefs OUTAGE yields access: null, never an empty access block — the
  // clients prefer live facts over a cached brief's access, and a truthy
  // codes-cleared block would suppress the valid cached codes. Only a
  // successful lookup (row present or genuinely absent) asserts access.
  // rawServicePreferences stays null here: the pest opt-out alerts already
  // ride the day payload's propertyAlerts — facts add codes/notes/pets.
  const access = prefsUnavailable
    ? null
    : buildAccessBlock(prefs, svc, genuinelyNew, normalizeServiceType(svc.service_type), null);
  let lastVisit = null;
  const lastRecord = history.available ? history.lineRecords[0] || null : null;
  if (lastRecord) {
    let products = [];
    try {
      products = dedupeHistoryProducts(await loadProductHistory(dbh, [lastRecord.id]));
    } catch (err) {
      logger.warn(`[previsit-brief] visit-facts product history unreadable for record ${lastRecord.id}: ${err.message}`);
    }
    lastVisit = {
      date: calendarDay(lastRecord.service_date),
      type: cleanText(lastRecord.service_type, 120),
      products,
    };
  }
  // customerFlagged (PR 3a — customer photos before a visit, dark behind
  // GATE_VISIT_PREP_PHOTOS): present ONLY when the gate is live AND the
  // stop's CURRENT membership has submissions — visitPrepPhotosLive() is
  // the canonical reader (server/config/feature-gates.js), read fresh on
  // every call, same convention as every other gate check in this file.
  // Gate off ⇒ the key is never even attempted, so facts stay byte-
  // identical to before this lane. Fail-soft like every other block here:
  // an outage omits the key rather than failing the whole facts read.
  let customerFlagged = null;
  if (require('../config/feature-gates').visitPrepPhotosLive()) {
    try {
      customerFlagged = await require('./visit-prep').customerFlaggedFacts(svc, dbh);
    } catch (err) {
      logger.warn(`[previsit-brief] visit-facts customerFlagged unreadable for service ${svc.id}: ${err.message}`);
    }
  }
  return { access, last_visit: lastVisit, ...(customerFlagged ? { customerFlagged } : {}) };
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

// Newest-first product dedupe (by name, cap 8) shared by the primary
// history-guidance path and combined-visit companion blocks.
function dedupeHistoryProducts(productRows) {
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
  return products;
}

// Completion-profile companion type → the service line whose history
// backs its guidance block. Companion types whose sections carry no
// product history semantics simply don't map.
const COMPANION_TYPE_LINES = {
  tree_shrub: 'tree_shrub',
  termite_bait_station: 'termite',
  rodent_bait_station: 'rodent',
};

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
    const query = { serviceDate, strict: true, planning: true };
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
        productId: p.productId || null,
        // FIXED only when default-in-plan AND gate-free at BOTH layers —
        // a default row with product gates (maxTempF, soil conditions,
        // blackout sensitivity) or any protocol-wide gate is still
        // conditional guidance.
        fixed: p.defaultInPlan === true && !hasProductGates(p) && protocolGates.length === 0,
        gates: (p.gates && typeof p.gates === 'object') ? p.gates : {},
      }))
      .filter((p) => p.shapedEntry.name);

    // Customer-specific application limits (annual max apps, cumulative
    // rate, minimum interval, MOA rotation — application-limits.js, the
    // SAME checker the completion path enforces): static gate absence is
    // not eligibility. A would-be-fixed product at one of THIS
    // customer's limits for the scheduled date demotes to conditional
    // with the violations attached — the pocket reference must never
    // direct a product the completion flow would flag as blocked or at
    // its edge. Checker outages propagate (strict): a limit-blind fixed
    // list must not hash over a valid cached brief.
    const LimitChecker = require('./application-limits');
    for (const entry of shaped) {
      if (!entry.fixed || !entry.productId) continue;
      // The treated property and this visit scope the history, as the plan engine scopes it:
      // another property's applications, and this visit's own ledger rows, are not held against it.
      const limits = await LimitChecker.checkLimits(svc.customer_id, entry.productId, serviceDate, undefined, {
        propertyId: svc.property_id || null, excludeScheduledServiceId: svc.id,
      });
      const violations = [
        ...(limits.blocks || []).map((v) => ({ severity: 'block', type: v.type || null, message: cleanText(v.message || v.description, 200) })),
        ...(limits.warnings || []).map((v) => ({ severity: v.severity || 'warn', type: v.type || null, message: cleanText(v.message || v.description, 200) })),
      ];
      if (violations.length) {
        entry.fixed = false;
        entry.gates = {
          ...entry.gates,
          applicationLimits: violations,
          trigger: entry.gates.trigger || violations[0].message || 'application limit',
        };
      }
    }
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
// The brief's stable service identity: the raw label with only cosmetic
// duration/price suffixes stripped. Deliberately NOT normalizeServiceType
// — that collapses distinct services ("Tree & Shrub Fertilization" →
// "Lawn Fertilization"), which would both misdescribe specialty visits
// to the LLM and blind the staleness stamp to a rewrite between them.
// Used for the hashed llmFacts.visit.serviceType, the stored for_service
// stamp, and briefStaleReason's comparison — one derivation, three
// sites, so hash, stamp, and read can never desync.
function briefServiceIdentity(rawServiceType) {
  return stripServiceSuffixes(rawServiceType) || 'General Service';
}

// rawServicePreferences comes from the CUSTOMER row —
// customers.service_preferences is where estimate acceptance persists the
// opt-outs (estimate-public.js); scheduled_services has no such column,
// so reading it off svc silently disabled the alert forever.
function buildAccessBlock(prefs, svc, genuinelyNew, normalizedType, rawServicePreferences = null) {
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
      servicePreferences: rawServicePreferences,
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
  // The brief's grounded service identity: raw label with only
  // duration/price suffixes stripped. normalizeServiceType COLLAPSES
  // distinct services ("Tree & Shrub Fertilization" → "Lawn
  // Fertilization"), which would tell the LLM the wrong visit type for
  // specialty visits and blind the for_service staleness stamp to a
  // rewrite between them — while a fully raw stamp would desync from the
  // hash on a cosmetic suffix edit. This identity feeds llmFacts (so it
  // is a hashed fact), the stored for_service stamp, and
  // briefStaleReason's comparison — all three stay aligned.
  const serviceIdentity = briefServiceIdentity(svc.service_type);
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
    productGuidance = { source: 'service_history', products: dedupeHistoryProducts(productRows) };
  }

  // Combined visits ("Lawn + Tree & Shrub", "Pest & Rodent Control", …)
  // are ONE appointment covering every declared section — the completion
  // profile's companion list is the EXISTING mechanism that declares
  // them (docs/design/combined-service-completions.md), so the brief
  // resolves the same profile instead of re-deriving combos from label
  // tokens. Each companion line gets its own line-scoped history
  // guidance block; the single-category primary guidance is unchanged.
  // Resolution/walk failures propagate — companion guidance is hashed,
  // and an outage-shaped empty must abort rather than overwrite a
  // complete cached brief (same sentinel rule as the primary walk).
  // strict: the resolver's DEFAULT swallows a schema-probe failure into
  // "table unavailable" → default profile with companions: [] — exactly
  // the outage-shaped empty this caller must never hash.
  const companionGuidance = [];
  {
    const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
    const profile = await resolveCompletionProfileForScheduledService(svc, dbh, { strict: true });
    const seenLines = new Set([history.visitLine].filter(Boolean));
    for (const companion of profile?.companions || []) {
      const line = COMPANION_TYPE_LINES[companion.type];
      // Unknown companion types carry no product semantics here (their
      // typed findings section still rides the completion flow); a
      // companion on the visit's own line adds nothing.
      if (!line || seenLines.has(line)) continue;
      seenLines.add(line);
      const { loadRecentLineServices } = require('../utils/last-line-service');
      const companionHistory = await loadRecentLineServices(dbh, svc.customer_id, svc.service_type, { limit: 5, line });
      const companionRows = await loadProductHistory(dbh, companionHistory.lineRecords.map((r) => r.id));
      companionGuidance.push({ line, source: 'service_history', products: dedupeHistoryProducts(companionRows) });
    }
  }
  if (companionGuidance.length) productGuidance = { ...productGuidance, companions: companionGuidance };

  const openScope = {
    sourceEstimate: await loadEstimateSource(dbh, svc.source_estimate_id),
    pendingEstimate: context?.pendingEstimate || null,
  };

  // First-visit is a POSITIVE claim: it may only be made when history was
  // actually readable and empty. An outage (available:false) asserts
  // nothing — no new-customer alert, no first-visit prompt fact.
  const genuinelyNew = history.available ? !history.last : false;

  // Current service opt-outs from the CUSTOMER row —
  // customers.service_preferences is where estimate acceptance persists
  // them (estimate-public.js); scheduled_services has no such column, so
  // an svc read is always undefined and would disable both the deterministic
  // alert and these flags. Same tolerant parse and pest scoping as the
  // nextstop-alerts compiler; boolean whitelist only.
  const rawServicePreferences = customer.service_preferences ?? null;
  let servicePrefFlags = null;
  if (/pest/i.test(normalizedType)) {
    let svcPrefs = null;
    try {
      svcPrefs = typeof rawServicePreferences === 'string'
        ? JSON.parse(rawServicePreferences || '{}')
        : (rawServicePreferences || null);
    } catch { svcPrefs = null; }
    const flags = {};
    if (typeof svcPrefs?.interior_spray === 'boolean') flags.interiorSpray = svcPrefs.interior_spray;
    // Away Mode (cancel-flow C2): a dated exterior-only state — while the
    // date is ahead, interior work is off regardless of the base pref.
    if (prefs?.away_mode_until && String(prefs.away_mode_until).slice(0, 10) >= require('../utils/datetime-et').etDateString()) {
      flags.interiorSpray = false;
    }
    if (typeof svcPrefs?.exterior_sweep === 'boolean') flags.exteriorSweep = svcPrefs.exterior_sweep;
    if (Object.keys(flags).length) servicePrefFlags = flags;
  }
  const access = buildAccessBlock(prefs, svc, genuinelyNew, normalizedType, rawServicePreferences);

  // The ONLY facts the LLM may see: already-redacted context slices plus
  // deterministic history/label facts. No access block, no raw
  // property_preferences, no raw technician notes (serviceHistory notes are
  // the reviewed customer-safe parse), no call transcripts.
  const llmFacts = {
    visit: {
      serviceType: serviceIdentity,
      scheduledDate: calendarDay(svc.scheduled_date),
      isRecurring: !!svc.is_recurring,
      // One-off stop: present ONLY when the canonical recurring-lineage
      // trio is clear (is_recurring / recurring_parent_id / recurring_pattern
      // — same set as previsit-card-request-sweep and pay-v2) AND the visit
      // is not a plan callback. A series
      // booster carries is_recurring=false WITH a parent id and must never
      // ground a "one-time" cadence claim (codex #4198 r1 P1).
      // Free re-service callbacks carry no lineage markers but exist only
      // for covered plan customers — never a one-time stop (codex #4198 r2 P1).
      ...(!svc.is_recurring && !svc.recurring_parent_id && !svc.recurring_pattern && !svc.is_callback ? { oneTime: true } : {}),
      // Omitted entirely when history is unreadable — the model must not
      // see (and the template must not assert) a first-visit claim that an
      // outage manufactured.
      ...(history.available ? { newCustomer: genuinelyNew } : {}),
    },
    // Current service opt-outs (NON-SECRET whitelist — never the raw
    // jsonb): the model must SEE "exterior only" or it will echo
    // historical interior work as guidance, and the validator's
    // deterministic conflict check keys off these same hashed flags
    // (grounding text alone cannot express a negation — "no interior"
    // in a preference string GROUNDS the word "interior").
    ...(servicePrefFlags ? { servicePreferences: servicePrefFlags } : {}),
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
    // Same-line ONLY, from the paged line walk itself — filtering the
    // aggregator's newest-5-any-line list instead silently EMPTIES this
    // section for a multi-line customer whose newest visits are other
    // lines, even though older same-line records exist. lineRecords are
    // already line-classified (classifier unavailable ⇒ the walk threw ⇒
    // available:false and an empty list — fail closed, never cross-line);
    // notes go through the same reviewed customer-safe parse the
    // aggregator uses (raw technician notes never reach the LLM).
    serviceHistory: (history.lineRecords || [])
      .slice(0, 3)
      .map((r) => ({
        type: cleanText(r.service_type, 120),
        date: calendarDay(r.service_date),
        notes: cleanText(customerSafeVisitNotes(r), 500),
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
      // Combined-visit companion lines (hashed facts — a companion
      // change regenerates like any other grounding change).
      ...(productGuidance.companions ? {
        companions: productGuidance.companions.map((c) => ({
          line: c.line,
          source: c.source,
          productNames: (c.products || []).map((p) => p.name).filter(Boolean),
        })),
      } : {}),
    },
  };

  return {
    svc,
    customer,
    normalizedType,
    serviceIdentity,
    category,
    access,
    productGuidance,
    lastVisitRecord,
    lastVisitProducts,
    sinceLastVisit,
    openScope,
    // Every free-text slice is run through the shared access-code redactor
    // at this boundary (belt over the context-aggregator's own layer):
    // pet/sensitivity flag details and call summaries arrive as raw
    // operator/customer text. The deterministic stored access block above
    // is intentionally NOT redacted.
    llmFacts: redactDeep(llmFacts),
  };
}

// ── Template body ───────────────────────────────────────────────────────────

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

// The stored brief's cache key: the prompt version plus everything that
// lands in the brief. A PROMPT_VERSION bump therefore invalidates every
// cached brief AND every validator-capped template (the cap is keyed on
// this hash). promptVersion is a parameter only so a test can build the
// hash a previous version stored.
function groundingHashFor(g, promptVersion = PROMPT_VERSION) {
  return crypto.createHash('sha256')
    .update(`${promptVersion}|${stableStringify({
      llmFacts: g.llmFacts,
      access: g.access,
      productGuidance: g.productGuidance,
      lastVisitProducts: g.lastVisitProducts,
    })}`)
    .digest('hex');
}

// The brief body: always the deterministic template, never a provider
// call. 'gate_off' is the stamp the removed GATE_PREVISIT_BRIEF_LLM-off path
// wrote; it is kept so briefs stored before the removal stay cache hits.
async function generateBriefBody(grounding) {
  return { via: 'template', body: templateBriefBody(grounding), missKind: 'gate_off' };
}

// ── Generator ───────────────────────────────────────────────────────────────

/**
 * Generate (or refresh) the visit brief for one scheduled service.
 * Returns { generated: true, brief } on a write,
 * { skipped: true, reason } otherwise. Never throws for a per-visit data
 * problem; the sweep and the route both surface `reason`.
 */
async function generateVisitBrief(scheduledServiceId, { dbh = db } = {}) {
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
  const hashOf = groundingHashFor;
  const groundingHash = hashOf(grounding);

  const existing = parseStoredBrief(svc.pre_service_brief);
  // Only a template already stamped 'gate_off' is a cache hit. A brief
  // stored any other way (an old model rewrite, or a template stuck
  // 'validator'/'transient' from when the rewrite ran) falls through and is
  // replaced with a fresh template (codex #5044 r1 P2-1).
  if (
    String(svc.pre_service_brief_type || '') === VISIT_BRIEF_TYPE
    && existing?.grounding_hash === groundingHash
    && existing?.generated_via === 'template'
    && existing?.llm_miss_kind === 'gate_off'
  ) {
    return { skipped: true, reason: 'unchanged', brief: existing };
  }

  const { via, body, missKind } = await generateBriefBody(grounding);


  // The CAS below only defends against OTHER brief writers — preferences,
  // protocol guidance, or the visit itself may have changed with no
  // competing write. Re-read the deterministic grounding and verify the
  // hash right before persisting; a mismatch means this body was built
  // from obsolete facts (stale access codes included) — drop it and let
  // the next sweep tick regenerate from the fresh grounding.
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
    // The stamp the unchanged-hash cache check above keys on. llm_attempts
    // stays in the stored shape (always 0) for readers of older briefs.
    llm_miss_kind: missKind,
    llm_attempts: 0,
    // The ET calendar day and service identity this brief was generated
    // FOR. Any writer can reschedule the visit or rewrite its
    // service_type directly (update-details is only ONE mover; estimate
    // acceptance rewrites service_type too) — the read path compares
    // these stamps against the row and withdraws mismatched guidance
    // (briefStaleReason) instead of serving another day's or another
    // service's products until a later sweep. The identity is the
    // suffix-stripped raw label, exactly the hashed
    // llmFacts.visit.serviceType (rationale at briefServiceIdentity):
    // any other choice either collapses specialty services or desyncs
    // from the hash, leaving the read withdrawing a brief the sweep's
    // unchanged-hash branch will never restamp.
    for_date: calendarDay(svc.scheduled_date),
    for_service: grounding.serviceIdentity,
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

// Read-path staleness check for a stored visit brief: null when
// servable, else the stale reason. The brief must have been generated
// FOR the visit's CURRENT scheduled date (ET) and CURRENT service_type:
// - date_moved: a reschedule strands the stored row on the old day's
//   grounding while the sweep's today-only filter won't reconsider the
//   visit until its new day (where the hash mismatch regenerates it) —
//   serving it in between hands the tech another day's guidance.
// - service_changed: many writers rewrite service_type directly (edit
//   modal, estimate acceptance, call flows) — clearing at every writer
//   can't be made exhaustive, so the read fails closed instead: history
//   products must never stand in for another service's authoritative
//   guidance (lawn-protocol authority rule). The sweep regenerates via
//   the grounding-hash mismatch (both stamps derive from hashed facts).
// Missing stamps fail closed too: the gate has never been on in prod,
// so no stamp-less legacy rows exist, and a brief that can't prove what
// it was generated for must not assert it.
function briefStaleReason(brief, svc) {
  if (!brief || !brief.for_date || brief.for_date !== calendarDay(svc.scheduled_date)) {
    return 'date_moved';
  }
  // Same derivation as the stamp and the hashed grounding fact
  // (briefServiceIdentity): a suffix-only label edit must neither
  // withdraw the brief nor demand a regeneration the 'unchanged' cache
  // branch will never perform, while a real service switch — specialty
  // services included, which normalizeServiceType would collapse — is
  // withdrawn.
  if (!brief.for_service || brief.for_service !== briefServiceIdentity(svc.service_type)) {
    return 'service_changed';
  }
  return null;
}

// Decision for update-details on an ACTUAL service_type change (callers
// must not invoke it for a same-value re-post — a label re-save must not
// wipe a good brief). Returns the clearing column updates, or null when
// the stored brief survives the edit:
//  - A generic visit brief clears on EVERY service change: its grounded
//    product guidance is service-scoped (pest → lawn swaps history
//    products for protocol-window products — lawn-protocol authority
//    rule), and the stale row stays immediately servable until a later
//    sweep tick, or past the 19:49 sweep, all night.
//  - A WDO brief clears only when the switch leaves the WDO boundary:
//    it belongs to the tagger, and a WDO-to-WDO relabel keeps it. A
//    stale WDO type would otherwise strand — regenerate-brief routes by
//    pre_service_brief_type into the WDO branch (where the tagger, now
//    classifying the new service as non-WDO, leaves the old brief
//    untouched) while generateVisitBrief refuses to overwrite WDO rows.
//  - Untyped/legacy briefs are not this lane's writes — left alone.
function briefClearOnReclassification(newTag, storedBriefType) {
  if (!storedBriefType) return null;
  const stored = String(storedBriefType);
  const clear = {
    pre_service_brief: null,
    pre_service_brief_type: null,
    pre_service_brief_generated_at: null,
  };
  if (stored === VISIT_BRIEF_TYPE) return clear;
  if (stored === WDO_BRIEF_TYPE && newTag !== 'wdo_inspection') return clear;
  return null;
}

module.exports = {
  briefGateEnabled,
  visitFactsGateEnabled,
  deterministicVisitFacts,
  generateVisitBrief,
  briefClearOnReclassification,
  briefStaleReason,
  runSweep,
  VISIT_BRIEF_TYPE,
  WDO_BRIEF_TYPE,
  _test: {
    assembleGrounding,
    deterministicVisitFacts,
    redactDeep,
    templateBriefBody,
    generateBriefBody,
    groundingHashFor,
    buildAccessBlock,
    safeTargets,
    stableStringify,
    PROMPT_VERSION,
  },
};
