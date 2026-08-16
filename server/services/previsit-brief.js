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
const PROMPT_VERSION = 'previsit_brief_v2';

// Statuses that are no longer an upcoming visit (mirrors
// PREP_TERMINAL_STATUSES in appointment-tagger.js / the admin-schedule
// terminal set) — the sweep and generator skip them.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']);

// ⛔ Never prefill these genera as targets (compliance rule — they require
// lab confirmation). Deterministic target lists are filtered; LLM list
// items mentioning them are dropped defensively too.
const FORBIDDEN_TARGET_RE = /ganoderma|thielaviopsis/i;
// The retired company name must never appear in generated output — the
// company is "Waves Pest Control" (AGENTS.md; codex #3423 r9 showed the
// phrase riding through common words with 'waves' allowlisted).
// \W+ separators cover space, hyphen, slash, plus, comma, ampersand —
// "Waves Lawn-Pest" and "Waves Lawn/Pest" are the same retired name (r14).
// Either word order — "Waves Pest & Lawn" is the same retired name (r15).
// The real brand ("Waves Pest Control & Lawn Care") stays safe: 'control'
// is a word, so \W-only separators never bridge pest→lawn across it.
const RETIRED_NAME_RE = /waves\W+(?:lawn\W*(?:and\W+)?\W*pest|pest\W*(?:and\W+)?\W*lawn)/i;
// The APPROVED company name, as a whole normalized phrase — prose, not a
// product reference (r17: bare 'waves' is no longer common prose).
// Canonical name ONLY per AGENTS.md — no blessed variants (codex r19).
const APPROVED_NAME_TERM_RE = /^waves\s+pest\s+control$/;
// The canonical phrase followed by a brand-connector is a suffixed
// variant ("Waves Pest Control & Lawn") — reject it outright (r20).
// …followed by an actual brand term — bare punctuation after the name
// ("Waves Pest Control - scheduled service") is ordinary prose (r21 P2).
// Connector optional (r22): "Waves Pest Control Pest Services" is a
// suffixed variant too — a brand word directly after the name rejects;
// ordinary prose ("- routine service", "serviced the yard") does not.
const NONCANONICAL_SUFFIX_RE = /waves\s+pest\s+control(?:\w|\s*(?:(?:&|\+|\/|-|,|\band\b)\s*)?(?:lawn|pest|care|control|l\.?l\.?c|l\.?l\.?p|l\.?p|inc|corp|co|ltd)\.?\b)/i;

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
      const limits = await LimitChecker.checkLimits(svc.customer_id, entry.productId, serviceDate);
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
    if (typeof svcPrefs?.exterior_sweep === 'boolean') flags.exteriorSweep = svcPrefs.exterior_sweep;
    if (Object.keys(flags).length) servicePrefFlags = flags;
  }
  const access = buildAccessBlock(prefs, svc, genuinelyNew, normalizedType, rawServicePreferences);

  const catalogVocabulary = await loadCatalogVocabulary(dbh);

  // The ONLY facts the LLM may see: already-redacted context slices plus
  // deterministic history/label facts. No access block, no raw
  // property_preferences, no raw technician notes (serviceHistory notes are
  // the reviewed customer-safe parse), no call transcripts.
  const llmFacts = {
    visit: {
      serviceType: serviceIdentity,
      scheduledDate: calendarDay(svc.scheduled_date),
      isRecurring: !!svc.is_recurring,
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
        notes: cleanText(customerSafeVisitNotes(r.technician_notes), 500),
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
  'about', 'above', 'account', 'action', 'address', 'after', 'again', 'ahead', 'alert',
  'along', 'amount', 'annual', 'apply', 'applied', 'applying', 'appointment', 'approach', 'arrival', 'arrive',
  'arriving', 'asked', 'attention', 'avoid', 'balance', 'baseboard', 'baseboards', 'basement', 'bathroom', 'bedroom',
  'before', 'begin', 'behind', 'below', 'between', 'booked', 'booking', 'bring', 'building',
  'cabinet', 'cabinets', 'called', 'calling', 'cancel', 'cancelled', 'carefully', 'caution', 'check', 'checked',
  'checking', 'clear', 'close', 'closet', 'complete', 'completed', 'concern', 'concerns', 'condition', 'conditions',
  'confirm', 'confirmed', 'contact', 'continue', 'continued', 'corner', 'corners', 'coverage', 'covered', 'crawl',
  'current', 'customer', 'cycle', 'daytime', 'detail', 'details', 'discussed', 'dispatch',
  'document', 'driveway', 'during', 'earlier', 'early', 'entry', 'evening', 'every', 'expect',
  'expects', 'extra', 'family', 'fence', 'fencing', 'first', 'flag', 'flagged', 'focus', 'follow',
  'following', 'front', 'garage', 'garden', 'gutter', 'gutters', 'heavy', 'hedge',
  'hedges', 'history', 'home', 'hours', 'inspect', 'inspected', 'inspection', 'inside', 'issue',
  'issues', 'items', 'kitchen', 'knock', 'landscape', 'lanai', 'later', 'lawn', 'leave', 'light',
  'listed', 'locked', 'maintain', 'maintenance', 'member', 'membership', 'message', 'meter', 'monitor', 'monitoring',
  'month', 'monthly', 'morning', 'mulch', 'needs', 'nothing', 'note', 'noted', 'notes', 'notice',
  'notify', 'number', 'office', 'onsite', 'orders', 'other', 'outdoor', 'owner', 'panel', 'parking',
  'patio', 'pending', 'perimeter', 'phone', 'photo', 'photos', 'place', 'placed', 'planned',
  'plans', 'plants', 'please', 'pool', 'porch', 'prefer', 'preference', 'preferences', 'prefers',
  'previous', 'prior', 'program', 'progress', 'rate', 'ready', 'recap', 'recent', 'recently',
  'recheck', 'record', 'records', 'reminder', 'renewal', 'repair', 'report', 'reported', 'request', 'requested',
  'reschedule', 'rescheduled', 'resolve', 'resolved', 'response', 'return', 'review', 'reviewed', 'right', 'roof',
  'route', 'routine', 'schedule', 'scheduled', 'scope', 'screen', 'screened', 'season', 'secure', 'secured',
  'sensitive', 'sensitivity', 'setup', 'sheet', 'shrubs', 'siding', 'since', 'skip', 'slab', 'small',
  'soffit', 'spray', 'sprayed', 'spraying', 'spot', 'staff', 'start', 'started', 'status', 'still',
  'stone', 'stops', 'sweep', 'swept', 'technician', 'texts', 'thorough', 'through', 'times', 'today',
  'touch', 'toward', 'treat', 'treated', 'trees', 'update', 'updated', 'upcoming',
  'verify', 'visit', 'visits', 'walk', 'walkthrough', 'warrant', 'warrants', 'watch', 'water', 'weather',
  'weeks', 'weekly', 'window', 'windows', 'within', 'worth', 'yesterday', 'trail', 'trails', 'chemical', 'chemicals', 'across', 'during', 'under', 'beside', 'beneath', 'against',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // 4-letter prose words (threshold dropped to 4 so short organism names
  // like mice/rats are scanned; ordinary short words must stay known).
  'have', 'been', 'will', 'must', 'then', 'than', 'they', 'them', 'when', 'each',
  'only', 'also', 'some', 'more', 'most', 'done', 'sure', 'fine', 'good', 'open',
  'next', 'last', 'line', 'side', 'note', 'call', 'text', 'week', 'days',
  'date', 'time', 'door', 'wall', 'lawn', 'turf', 'tree', 'were', 'work', 'both',
  'here', 'there', 'keep', 'left', 'high', 'look', 'like', 'plan', 'stop', 'take',
  'told', 'used', 'want', 'well', 'your', 'their', 'after', 'need', 'needs', 'ask',
  'asks', 'same', 'soon', 'once', 'twice', 'edge', 'best', 'back', 'full', 'half',
  'away', 'near', 'upon', 'very', 'much', 'many', 'wear', 'shoe', 'shoes', 'rain',
  'wind', 'heat', 'cold', 'warm', 'soil', 'seed', 'file', 'down', 'knock', 'paid', 'owed', 'owes', 'due', 'dues', 'crew', 'team', 'unit', 'step', 'path', 'walk', 'tarp', 'hose', 'pump', 'tank', 'mask', 'kit',
  // Generic vocabulary from the live rejection histogram (08-14/15: 96% of
  // briefs template-fell on words like "perform" ×79, "provide",
  // "availability"). Deliberately NO organisms, product names, or
  // direction/scope words (interior/attic-class) — those must still ground,
  // and the preference-conflict scan enforces opted-out scopes regardless.
  // NOT here (codex #3423 r1+r2): tier names (bronze/silver/gold/platinum)
  // — an ungrounded tier claim is an invented business fact, handled by
  // the grounded-tier skip in the product pass instead; rooms/credentials
  // — actionable instruction objects that must keep grounding (rooms?
  // also joins the interior opt-out conflict regex); product-shaped words
  // (structural/control — "Apply Structural Control" must park as a
  // product) and condition-bearing descriptors (severe/regrowth/raised/
  // missing/recovery/occupancy/presence — "Watch for severe regrowth" is
  // an invented field condition unless the facts state it); customer
  // equipment (camera/cameras/irrigation/runtime — "Check cameras" on
  // empty facts is an unsupported equipment instruction) and
  // service-history claim words (missed/application(s) — "Missed
  // application" must come from the facts; both appear in real groundings
  // whenever the claim is true). The action verbs below (perform/provide/
  // retrieve/vacuum/document/discuss) are additionally in the
  // directive-verb capture so their OBJECTS still ground strictly.
  'with',
  'perform', 'performs', 'performed', 'performing', 'provide', 'provides', 'provided', 'providing',
  'context', 'account', 'accounts',
  'information',
  'retrieve',
  'introduction', 'discuss', 'discussing', 'relevant', 'mindful',
  'vacuum', 'vacuuming', 'follow-up', 'walk-through',
]);

// Business-state vocabulary, never common prose: WaveGuard tier names
// (codex #3423 r1) and cadence/acceptance terms (r4 — "Apply Initial
// Treatment" / "Payment accepted" on empty facts would store an invented
// cadence or account status). These words must be word-boundary grounded;
// when they are, a capitalized capture carrying them ("Accepted Bronze")
// is prose about the account, not a product reference.
const GROUNDED_ONLY_WORDS = new Set([
  'bronze', 'silver', 'gold', 'platinum',
  'accepted', 'accepting', 'initial', 'initially', 'recurring',
  // r5: "Customer available Monday" is a scheduling fact, not prose.
  'available', 'availability',
  // r10: money words require a money fact VALUE in every field — an
  // estimate-status 'accepted' must not let "Payment accepted" through
  // when no payment fact exists.
  'payment', 'payments', 'invoice', 'invoices', 'refund', 'refunds', 'billing',
  // r21: scheduling STATUSES ("Scheduling confirmed/cancelled") are
  // appointment-state claims in ANY field, not just instructions.
  'scheduling', 'reschedule', 'rescheduling',
  // r23: treatment claims ("Performed treatment") assert service history
  // in ANY field — a brief may only claim treatment a fact evidences.
  'treatment', 'treatments',
  // r24/r25: "Estimate provided" / "Quote provided" are money-delivery
  // claims in ANY field (quotes ARE estimates in this system).
  'estimate', 'estimates', 'quote', 'quotes',
  // r28: entry/payment-method state ("provided gate access"/"credit card")
  // is claimable in ANY field — and access codes never pass through the
  // LLM by design, so an ungrounded access claim is always invented.
  // 'key'/'keys' are NOT here (r29 P2): "Key concern" is ordinary
  // emphasis — credential usage is detected contextually via
  // KEY_CREDENTIAL_RE instead.
  'gate', 'gates', 'access', 'card', 'cards', 'fob', 'fobs', 'credit', 'credits',
]);

// 'key' as an access credential ("door key", "key under the mat") must
// ground; 'key' as emphasis ("key concern") is prose (codex #3423 r29).
const KEY_CREDENTIAL_RE = /\b(?:gate|door|house|office|garage|spare|access|lockbox|shed)\s+(?:keys?|pins?|codes?)\b|\b(?:keys?|pins?)\s+(?:under|hidden|inside|behind|left|beneath|provided)\b|\b(?:pins?|codes?)\s+(?:numbers?|on\s+file)\b/i;

// Instruction objects carrying these words direct real business actions
// ("Provide estimate", "Discuss payment", "Perform treatment") — inside
// priorities/watch_items the word must be evidenced in the fact VALUES
// even though it is ordinary prose in descriptive fields (codex #3423 r9).
// (payment/invoice/refund/billing graduated to GROUNDED_ONLY_WORDS in r10
// — they require evidence in EVERY field, not just instructions.)
const INSTRUCTION_EVIDENCE_WORDS = new Set([
  'balance', 'discount', 'discounts',
  // r15: access-security objects ("Retrieve gate key/access card") are
  // fabricatable from common words — the access noun must be evidenced.
  // r19: scheduling directives ("Discuss schedule") assert a real action.
  // 'scheduled' (adjective — "a prior scheduled service") stays prose.
  'schedule', 'schedules',
  // r27: safety-related directives ("Discuss chemical sensitivity") must
  // derive from a sensitivity fact.
  'chemical', 'chemicals', 'sensitivity', 'sensitivities',
  // r29: account-lifecycle directives ("Discuss renewal/membership").
  'renewal', 'renewals', 'membership', 'memberships', 'member', 'members',
  // r34: pet guidance is deterministic-block-only by design — an LLM pet
  // directive must derive from a fact (e.g. a flag mentioning the pet).
  'pet', 'pets', 'dog', 'dogs', 'cat', 'cats',
]);

// Word-level grounding for one candidate word ACROSS its stem variants.
// Grounded-only vocabulary must match on a WORD BOUNDARY — substring
// grounding let 'silver' ground on "silverfish" and 'gold' on "marigold"
// (codex #3423 r5) — and strictness is decided by the BASE word, not the
// variant: wordVariants('accepted') yields 'accept', which is not in the
// set, so a per-variant check fell back to substring and "unaccepted
// offer" grounded "Payment accepted" (r6). Every variant of a
// grounded-only word boundary-matches; ordinary words keep substring
// matching (the light-stem tiers rely on it).
// Leaf VALUES of the grounding facts, without key names — strict grounding
// must never ride on a field NAME: every payload carries keys like
// history.available, which grounded "Customer available Monday" even when
// the value was false (codex #3423 r9). Booleans excluded — true/false
// carry no vocabulary.
function collectFactValues(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((c) => collectFactValues(c, out)); return out; }
  if (typeof node === 'object') { Object.values(node).forEach((c) => collectFactValues(c, out)); return out; }
  return out;
}

function groundedWordOk(word, groundedText, strictText = groundedText) {
  const strict = wordVariants(word).some((v) => GROUNDED_ONLY_WORDS.has(v));
  return wordVariants(word).some((v) => (strict
    ? new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(strictText)
    : groundedText.includes(v)));
}

// Short/common organism names — too short (or too domain-loaded) for the
// rare-word scan and unsound to substring-ground ('rat' matches inside
// 'operator'). Every occurrence must be WORD-BOUNDARY grounded.
const SHORT_ORGANISM_RE = /\b(rats?|bats?|mouse|mice|ants?|bees?|fly|flies|wasps?|ticks?|fleas?|moths?|slugs?|grubs?|mites?|voles?|moles?|gnats?|weeds?|aphids?)\b/g;

// Ordinary short ALLCAPS abbreviations a brief legitimately uses without
// grounding (times, zones, business boilerplate) — everything else
// ALLCAPS-short must ground or reject (bare-product scan below).
// 'sms' deliberately NOT here (codex #3423 r9): "Customer prefers SMS" is a
// contact-preference claim — a grounded payload mentions sms, an invented
// preference does not, so SMS goes through the normal grounded-ALLCAPS path.
const ACRONYM_PROSE_WORDS = new Set(['am', 'pm', 'et', 'est', 'edt', 'asap', 'hoa', 'ac', 'id', 'ok', 'po', 'llc', 'inc', 'na']);

// Light stemming for the rare-word pass — plurals/participles of known or
// grounded words must not read as novel.
function wordVariants(word) {
  const out = [word];
  if (word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.endsWith('s')) out.push(word.slice(0, -1));
  if (word.endsWith('ing')) out.push(word.slice(0, -3), `${word.slice(0, -3)}e`);
  if (word.endsWith('ed')) out.push(word.slice(0, -2), word.slice(0, -1));
  if (word.endsWith('ly')) out.push(word.slice(0, -2));
  // initial <-> initially likewise (r33 P2).
  if (word === 'initial') out.push('initially');
  // available <-> availability are one evidence family (r31 P2) — model
  // paraphrase between them must not defeat a real availability fact.
  if (word === 'available') out.push('availability');
  if (word === 'availability') out.push('available');
  // -ies plural (r28): 'sensitivities' must reach 'sensitivity'.
  if (word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
  // Noun-of-action inflection (r24, narrowed r29): ONLY the intentional
  // treatment<->treat pair — a generic -ment rule equated department with
  // depart and settlement with settle, false-grounding invented claims.
  if (word === 'treatment' || word === 'treatments') {
    out.push('treat', 'treated', 'treating', 'treats');
  }
  return out;
}

// A reference is grounded when the whole normalized phrase appears in the
// grounding payload, or (fuzzy tier — word order/articles vary in prose)
// when every significant word of it does. A phrase left with no
// significant words asserts nothing and passes.
function isGroundedReference(candidate, groundedText, strictText = groundedText) {
  const phrase = String(candidate || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
  if (!phrase) return true;
  if (groundedText.includes(phrase)) return true;
  // Common-prose words assert nothing product- or organism-wise — the same
  // principle as the rare-word pass and the instructed-claim skip — so only
  // the remaining words must ground, with the same light stemming
  // ("monitors" grounds on "monitor"). Requiring literal grounding of
  // ordinary prose rejected ~96% of live briefs (prod histogram 08-14/15:
  // "a prior scheduled service", "customer monitors camera"). Organisms and
  // product names are never in the prose sets, so they still must ground.
  const words = phrase.split(' ')
    .filter((w) => /^[a-z][a-z'-]{3,}$/.test(w))
    .filter((w) => wordVariants(w).some((v) => GROUNDED_ONLY_WORDS.has(v))
      || !wordVariants(w).some((v) => REFERENCE_STOP_WORDS.has(v) || COMMON_PROSE_WORDS.has(v)));
  if (!words.length) return true;
  return words.every((w) => groundedWordOk(w, groundedText, strictText));
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
  const directives = new Set();
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
  for (const m of text.matchAll(/\b(?:[Aa]ppl(?:y|ied|ying)|[Ss]pray(?:ed|ing)?|[Uu]s(?:e|ed|ing)|[Tt]reat(?:ed|ing)?)(?:\s+(?:with|the|a|an|some))*\s+([A-Za-z][\w.-]*(?:\s+(?!(?:for|to|on|in|at|and|or|along|around|near|across|into|onto|over|under|before|after|during|per|by|from)\b)[\w.-]+){0,3})/gi)) push(instructed, m[1]);
  // NON-treatment imperatives ("Inspect interior", "Check attic",
  // "Monitor bait stations"): instruction fields must ground these
  // objects too — the treatment-verb capture above covers only
  // apply/spray/use/treat, and an ungrounded "Inspect interior" on an
  // exterior-only visit is exactly as contradictory as "Treat interior".
  // Same connector skip and follower-stop as the treatment capture.
  for (const m of text.matchAll(/\b(?:[Ii]nspect(?:ed|ing|s)?|[Cc]heck(?:ed|ing|s)?|[Rr]e-?check(?:ed|ing|s)?|[Mm]onitor(?:ed|ing|s)?|[Ee]xamin(?:e|ed|ing|es)|[Vv]erif(?:y|ied|ies|ying)|[Ss]ecur(?:e|ed|ing|es)|[Rr]emov(?:e|ed|ing|es)|[Ii]nstall(?:ed|ing|s)?|[Pp]lac(?:e|ed|ing|es)|[Cc]lean(?:ed|ing|s)?|[Cc]lear(?:ed|ing|s)?|[Ss]weep(?:ing|s)?|[Bb]ait(?:ed|ing|s)?|[Tt]arget(?:ed|ing|s)?|[Aa]ddress(?:ed|ing|es)?|[Ff]ocus(?:ed|ing|es)?(?:\s+on)?|[Pp]erform(?:ed|ing|s)?|[Pp]rovid(?:e|es|ed|ing)|[Rr]etriev(?:e|es|ed|ing)|[Vv]acuum(?:ed|ing|s)?|[Dd]ocument(?:ed|ing|s)?|[Dd]iscuss(?:ed|ing|es)?)(?:\s+(?:the|a|an|all|any|some))*\s+([A-Za-z][\w.-]*(?:\s+(?!(?:for|to|on|in|at|and|or|along|around|near|across|into|onto|over|under|before|after|during|per|by|from)\b)[\w.-]+){0,3})/gi)) push(directives, m[1]);
  for (const m of text.matchAll(/\b(?:for|targeting|against)\s+((?:[a-z][a-z'-]*\s+){0,3}[a-z][a-z'-]*)/g)) push(targets, m[1]);
  // Organism references that never pass a preposition: "<X> activity/
  // damage/infestation" and "signs/evidence of <X>" ("Emerald ash borer
  // activity warrants inspection"). Case-insensitive captures — organisms
  // appear sentence-initial too; the stopword filter absorbs generic
  // modifiers ("increased", "ongoing") the captures drag in.
  for (const m of text.matchAll(/\b((?:[A-Za-z][\w'-]*\s+){0,3}[A-Za-z][\w'-]*?)\s+(?:activity|infestation|damage|pressure|droppings|nesting|sightings?)\b/g)) push(targets, m[1]);
  for (const m of text.matchAll(/\b(?:signs?|evidence|presence|history)\s+of\s+((?:[A-Za-z][\w'-]*\s+){0,3}[A-Za-z][\w'-]*)/g)) push(targets, m[1]);
  return { products: [...products], instructed: [...instructed], directives: [...directives], targets: [...targets] };
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
  // Strict (grounded-only / evidence-word) matches scope to fact VALUES —
  // key names must never ground a business-state claim (codex #3423 r9).
  // visit.isRecurring === true is the ONLY cadence fact an ordinary
  // recurring visit carries; excluding booleans (r9) must not strip it or
  // every truthful "recurring" brief re-templates (codex #3423 r10).
  const groundedValueText = [
    ...collectFactValues(grounding.llmFacts),
    ...(grounding.llmFacts?.visit?.isRecurring === true ? ['recurring'] : []),
    // visit.newCustomer === true is likewise the only first-visit fact —
    // without this token every truthful "Initial visit" re-templates (r14).
    ...(grounding.llmFacts?.visit?.newCustomer === true ? ['initial'] : []),
    // A present estimate object is THE estimate fact (r24) — its values
    // rarely contain the literal word.
    ...(grounding.llmFacts?.openScope?.pendingEstimate || grounding.llmFacts?.openScope?.sourceEstimate ? ['estimate', 'quote'] : []),
    // A present membership object IS the membership fact (r29).
    ...(grounding.llmFacts?.membership ? ['membership', 'member'] : []),
    // The overdue_balance flag IS billing evidence — its detail ('$100.00
    // outstanding') doesn't carry the words (r27 P2).
    ...((grounding.llmFacts?.flags || []).some((f) => f?.type === 'overdue_balance') ? ['billing', 'invoice', 'payment', 'balance'] : []),
  ].join(' ').toLowerCase();
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
  // Capitalized-run business-state prose ("Accepted Bronze"): a
  // grounded-only word makes the capture product-shaped, but when it IS
  // grounded the phrase is a sentence about the account, not a product
  // name. Ungrounded grounded-only words never pass (and the rare-word
  // pass rejects them in any field). Used by the capitalized-run product
  // path ONLY — application-verb objects keep the strict skip so "Apply
  // Silver Control" still parks as a product.
  const boundaryGroundedWord = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(groundedValueText);
  const commonOrGroundedProse = (term) => String(term).toLowerCase().split(/\s+/).every((w) => (
    w.length < 4 || REFERENCE_STOP_WORDS.has(w) || COMMON_PROSE_WORDS.has(w)
    || (GROUNDED_ONLY_WORDS.has(w) && boundaryGroundedWord(w))
  ));
  // Instruction fields (priorities, watch_items) direct the technician —
  // an application-verb product reference there must name a product on
  // the CURRENT visit's fixed list, not merely anything in the grounding:
  // last visit's product rides in llmFacts as history and must never
  // become an instruction when the current window excludes it
  // (lawn-protocol authority rule). Descriptive fields (last-visit
  // summary, context) may reference any grounded product.
  // Companion-line guidance products count as fixed too: on a combined
  // visit they were handed to the LLM as that line's guidance, so an
  // instruction naming them is grounded direction, not a violation.
  const fixedNames = [
    ...(grounding.llmFacts?.productGuidance?.productNames || []),
    ...(grounding.llmFacts?.productGuidance?.companions || []).flatMap((c) => c.productNames || []),
  ]
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
  // Strict grounding for instructional verb-object claims: unlike
  // isGroundedReference, stop/common words stay significant — they carry
  // the DIRECTION of an instruction ("interior", "attic"). The whole
  // normalized phrase, or every 4+-letter word of it (light-stemmed),
  // must appear in the grounding; a claim the grounding never mentions is
  // invented guidance regardless of how ordinary its vocabulary is.
  const instructedClaimGrounded = (term) => {
    const phrase = String(term || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    if (!phrase) return true;
    const words = phrase.split(' ').filter((w) => w.length >= 4);
    // Money/scope-bearing and grounded-only objects require VALUE evidence
    // BEFORE the whole-phrase fast path (codex #3423 r9+r12): every real
    // payload carries keys like sourceEstimate/pendingEstimate even when
    // their values are null, and `groundedText.includes('estimate')`
    // matched the KEY — so "Provide estimate" validated with no estimate.
    const evidence = words.filter((w) => INSTRUCTION_EVIDENCE_WORDS.has(w) || GROUNDED_ONLY_WORDS.has(w));
    if (evidence.length && !evidence.every((w) => wordVariants(w).some(
      (v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(groundedValueText),
    ))) return false;
    if (groundedText.includes(phrase)) return true;
    // No 4+-letter words at all does NOT make the claim grounded: a
    // short verb object ("Use DDT" → 'ddt') is exactly the shape every
    // length-gated pass ignores (rare-word scan starts at 4, catalog
    // vocabulary at 4) — and the whole-phrase check above already
    // failed, so the claim appears nowhere in the grounding. Fail
    // closed rather than accept it vacuously.
    if (!words.length) return false;
    // Ordinary prose vocabulary self-grounds ("treated", "carefully") —
    // requiring it verbatim would template-fallback normal sentences.
    // Reference STOPWORDS do NOT: they carry the direction of the claim
    // (interior/exterior/perimeter-class words), which is exactly what
    // an ungrounded instruction smuggles. An object left with only
    // prose words asserts nothing beyond its verb.
    const significant = words.filter((w) => !COMMON_PROSE_WORDS.has(w));
    if (!significant.length) return true;
    return significant.every((w) => groundedWordOk(w, groundedText, groundedValueText));
  };
  const labeledFields = [
    ...(body.priorities || []).map((text) => ({ text, instructional: true })),
    ...(body.watch_items || []).map((text) => ({ text, instructional: true })),
    { text: body.last_visit_summary, instructional: false },
    { text: body.open_scope, instructional: false },
    { text: body.customer_context, instructional: false },
  ].filter((f) => f.text);
  const escapeReTerm = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Deterministic service-preference conflicts: grounding text cannot
  // express negation — an "exterior only — no interior" preference (or
  // historical interior notes) GROUNDS the word "interior", so a
  // grounding check alone would accept "Treat interior" on an
  // exterior-only visit. Instruction fields must not mention the
  // opted-out scope AT ALL (even an agreeing restatement — the
  // deterministic alert already carries the opt-out, and a rejected leg
  // falls to the template which includes it).
  const prefConflicts = [];
  const svcPrefFlags = grounding.llmFacts?.servicePreferences || null;
  if (svcPrefFlags?.interiorSpray === false) {
    // Interior room nouns included (codex #3423 r1+r13): "Vacuum basement" /
    // "Check kitchen" IS an interior instruction regardless of verb.
    // plural 'rooms' only — singular is the spacing idiom ("leave room"), r19 P2.
    prefConflicts.push({ re: /\b(?:interior|inside|indoors?|rooms|basements?|attics?|closets?|bedrooms?|bathrooms?|kitchens?)\b|\b(?:in|within)\s+the\s+(?:home|house)\b/, term: 'interior' });
  }
  if (svcPrefFlags?.exteriorSweep === false) {
    prefConflicts.push({ re: /\b(?:eaves?|cobwebs?)\b/, term: 'eave sweep' });
  }
  // A positive payment-state phrase under an overdue_balance flag asserts
  // the OPPOSITE of the customer's billing state — flattened token pools
  // cannot see the contradiction, so it is checked as a phrase (r32).
  if ((grounding.llmFacts?.flags || []).some((f) => f?.type === 'overdue_balance')
    && /\bpayment\s+(?:accepted|received|completed?|made|confirmed)\b|\bpaid\s+in\s+full\b|\b(?:balance|invoice)\s+(?:paid|cleared|settled)\b/i.test(outputText)) {
    return { kind: 'payment_state_conflict', term: 'overdue balance on file' };
  }
  // Estimate/quote LIFECYCLE wording must match the actual estimate
  // object's status — the estimate token asserts existence, never state
  // (r33: "Estimate cancelled" over an accepted estimate is fabricated).
  const estimateStatuses = [
    grounding.llmFacts?.openScope?.sourceEstimate?.status,
    grounding.llmFacts?.openScope?.pendingEstimate?.status,
  ].filter(Boolean).map((v) => String(v).toLowerCase().replace(/^canceled$/, 'cancelled'));
  // A pendingEstimate object IS the pending state, status field or not.
  if (grounding.llmFacts?.openScope?.pendingEstimate) estimateStatuses.push('pending');
  if (estimateStatuses.length) {
    for (const m of outputText.matchAll(/\b(?:estimates?|quotes?)\s+(?:was\s+|is\s+)?(accepted|declined|cancelled|canceled|pending|sent|expired|rejected|completed|closed|approved|finalized|voided)\b|\b(accepted|declined|cancelled|canceled|pending|sent|expired|rejected|completed|closed|approved|finalized|voided)\s+(?:estimates?|quotes?)\b/g)) {
      const claimed = String(m[1] || m[2]).replace(/^canceled$/, 'cancelled');
      if (!estimateStatuses.includes(claimed)) {
        return { kind: 'estimate_state_conflict', term: claimed };
      }
    }
  }
  // Evidence-bearing words are validated FIELD-WIDE in instructions —
  // capture geometry (token caps, connectors) must never decide whether
  // "estimate"/"payment"-class words reach the gate (codex #3423 r20).
  const evidenceWordGrounded = (w) => wordVariants(w).some(
    (v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(groundedValueText),
  );
  for (const field of labeledFields) {
    if (field.instructional) {
      // {2,} so 3-letter credential nouns ('key', 'fob') reach the set (r25);
      // hyphenated compounds are split so "Chemical-sensitivity" cannot
      // hide its evidence word inside one token (r32).
      for (const raw of (String(field.text).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])) {
        for (const w of raw.split('-').filter(Boolean)) {
          if (INSTRUCTION_EVIDENCE_WORDS.has(w) && !evidenceWordGrounded(w)) {
            return { kind: 'instruction', term: w };
          }
        }
      }
    }
    if (field.instructional && prefConflicts.length) {
      const fieldText = String(field.text).toLowerCase();
      for (const conflict of prefConflicts) {
        if (conflict.re.test(fieldText)) return { kind: 'preference_conflict', term: conflict.term };
      }
    }
    // Instruction fields: scan for EVERY known product name regardless of
    // casing — the capitalized extractors miss "priorities: ['bifen it']",
    // and a known-but-off-fixed-list name is an instruction toward a
    // product the current visit excludes.
    if (field.instructional) {
      const fieldText = String(field.text).toLowerCase();
      for (const name of knownProductNames) {
        if (new RegExp(`\\b${escapeReTerm(name)}\\b`).test(fieldText) && !fixedNames.includes(name)) {
          return { kind: 'novel_product', term: name };
        }
      }
    }
    const refs = extractOutputReferences(String(field.text));
    for (const term of refs.products) {
      // The canonical name inside a prose run ("Call Waves Pest Control"):
      // strip it and skip when the remainder is ordinary prose (r25 P2) —
      // a novel token beside it ("PhantomGuard Waves Pest Control") still
      // parks, and NONCANONICAL_SUFFIX_RE already rejected brand suffixes.
      const withoutName = String(term).replace(/\bwaves\s+pest\s+control\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (withoutName !== String(term).trim() && (withoutName === '' || allWordsCommon(withoutName))) continue;
      if (commonOrGroundedProse(term)) continue;
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
      if (allWordsCommon(term)) {
        // Common vocabulary proves prose-shape, not evidence: an
        // application-verb object made only of common/scope words still
        // directs the technician ("Treat interior" on an exterior-only
        // visit), and the fuzzy tier can't see it — scope words like
        // interior/exterior are reference STOPWORDS there. In instruction
        // fields the claim must appear in the grounding with its scope
        // words kept significant; descriptive prose keeps the skip.
        if (field.instructional && !instructedClaimGrounded(term)) {
          return { kind: 'instruction', term };
        }
        continue;
      }
      if (field.instructional) {
        if (!onFixedList(term)) return { kind: 'novel_product', term };
      } else if (!groundedExact(term)) {
        return { kind: 'novel_product', term };
      }
    }
    // Non-treatment imperatives direct the technician exactly like
    // application verbs — "Inspect interior" on an exterior-only visit
    // is as contradictory as "Treat interior". Same strict grounding
    // (scope words significant); descriptive prose is not a directive.
    if (field.instructional) {
      for (const term of refs.directives) {
        if (!instructedClaimGrounded(term)) return { kind: 'instruction', term };
      }
    }
    for (const term of refs.targets) {
      if (!isGroundedReference(term, groundedText, groundedValueText)) return { kind: 'novel_target', term };
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
  // Bare short ALLCAPS product tokens ("DDT" as a whole priority): no
  // verb for the instructed/directive captures, a single token for the
  // capitalized-run regex (needs 2+), and under the rare-word scan's
  // 4-letter floor — with mentioned_terms omitted, nothing sees it. Any
  // standalone 2–6-char ALLCAPS token must be word-boundary grounded,
  // self-reported (mentioned_terms are exact-grounded above), or
  // ordinary abbreviation prose; otherwise it is an invented product.
  for (const field of outputFields) {
    for (const m of String(field).matchAll(/\b[A-Z]{2,6}\d{0,3}\b/g)) {
      const token = m[0].toLowerCase();
      if (ACRONYM_PROSE_WORDS.has(token)) continue;
      if (REFERENCE_STOP_WORDS.has(token) || COMMON_PROSE_WORDS.has(token)) continue;
      if (selfReported.has(token)) continue;
      if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(groundedText)) continue;
      return { kind: 'novel_product', term: m[0] };
    }
  }
  const wordKnown = (word) => {
    // Grounded-only status (on ANY stem variant) outranks prose-set
    // membership — 'scheduling' stems to common 'schedule', which must not
    // launder an appointment-state claim past the evidence check (r21).
    if (wordVariants(word).some((v) => GROUNDED_ONLY_WORDS.has(v))) {
      // Self-report is a CLAIM, not evidence — grounded-only words need a
      // fact value regardless of mentioned_terms (r26).
      return groundedWordOk(word, groundedText, groundedValueText);
    }
    return wordVariants(word).some((v) => (
      REFERENCE_STOP_WORDS.has(v)
      || COMMON_PROSE_WORDS.has(v)
      || selfReported.has(v)
    )) || groundedWordOk(word, groundedText, groundedValueText);
  };
  // The approved company name self-grounds as a PHRASE only — a bare
  // 'waves' outside it is a rare word ("Apply Waves" is a nonexistent
  // product, codex #3423 r17).
  const APPROVED_NAME_RE = /\bwaves\s+pest\s+control\b/gi;
  for (const rawField of outputFields) {
    const field = String(rawField).replace(APPROVED_NAME_RE, ' ');
    // 4+ characters: 'mice'/'rats'/'tick'/'flea'-length organisms must
    // not slip under the scan (3-letter singulars are covered in practice
    // by substring grounding — 'ant' grounds on 'ants').
    for (const m of String(field).toLowerCase().matchAll(/[a-z][a-z'-]{2,}/g)) {
      const word = m[0];
      // Short tokens are only examined when they are grounded-only
      // vocabulary ('fob') or credential 'key' usage — everything else
      // below 4 letters keeps the historical exemption (r28/r29).
      if (word.length < 4) {
        if (GROUNDED_ONLY_WORDS.has(word) && !groundedWordOk(word, groundedText, groundedValueText)) {
          return { kind: 'novel_term', term: word };
        }
        if ((word === 'key' || word === 'pin') && KEY_CREDENTIAL_RE.test(String(field)) && !groundedWordOk(word, groundedText, groundedValueText)) {
          return { kind: 'novel_term', term: word };
        }
        continue;
      }
      // Hyphenated prose ("re-check", "walk-through"): known when every
      // part is known; short parts are below the rare-word threshold.
      const parts = word.split('-').filter(Boolean);
      const known = parts.length > 1
        ? parts.every((part) => part.length < 4 || wordKnown(part))
        : wordKnown(word);
      if (!known) return { kind: 'novel_term', term: word };
    }
  }
  // Numeric claims: every digit-run in the output must appear
  // digit-bounded in the grounding — the scans above are alphabetic, so
  // an invented "$500" in quote context would be cached and repeated to
  // staff as pricing. Thousand-separator commas are folded on both
  // sides; trailing ".00" grounds on the bare integer.
  const groundedNumeric = groundedText.replace(/(\d),(?=\d{3}\b)/g, '$1');
  for (const field of outputFields) {
    for (const m of String(field).replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/\d+(?:\.\d+)?/g)) {
      const token = m[0];
      // Trailing-zero decimals only ("100.00" → "100") — "100.50" must
      // never ground on a bare 100.
      const variants = [...new Set([token, token.replace(/\.0+$/, '')])].filter(Boolean);
      const grounded = variants.some((v) => new RegExp(`(?<!\\d)${v.replace('.', '\\.')}(?![\\d.])`).test(groundedNumeric));
      if (!grounded) return { kind: 'numeric', term: token };
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
  if (RETIRED_NAME_RE.test(rawText)) return { reason: 'retired_company_name' };
  if (NONCANONICAL_SUFFIX_RE.test(rawText)) return { reason: 'noncanonical_company_name' };
  // Structured self-report (complement to the prose regexes below, which
  // only see a few sentence shapes): the model must list every product
  // and pest/organism it mentions, and every listed term must be
  // grounded. A missing list rejects the leg.
  if (!Array.isArray(json.mentioned_terms)) return { reason: 'mentioned_terms_not_array' };
  const selfReportGrounding = JSON.stringify(grounding.llmFacts).toLowerCase();
  // Grounded-only words in a self-reported term must match fact VALUES —
  // the serialized form contains null keys like openScope.sourceEstimate,
  // which must never ground 'estimate' (codex #3423 r26).
  const selfReportValueText = collectFactValues(grounding.llmFacts).join(' ').toLowerCase();
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
    const strictWords = phrase.split(/\s+/).filter((w) => wordVariants(w).some((v) => GROUNDED_ONLY_WORDS.has(v)));
    if (strictWords.some((w) => !groundedWordOk(w, selfReportGrounding, selfReportValueText))) {
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
      // 1000 truncated real responses mid-JSON (prod 08-14/15: 36 empty_json
      // legs + "not_an_object (response truncated at max_tokens=1000)") —
      // the body plus mentioned_terms self-report doesn't reliably fit.
      maxTokens: 2000,
      // 2000 crosses OPENAI_REASONING_FLOOR_TOKENS, which would silently
      // flip the GPT fallback from 'none' to default 'low' reasoning on
      // this high-volume summarization lane (codex #3423 r2) — the raise
      // is JSON headroom only, never a reasoning upgrade.
      reasoningEffort: 'none',
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
  // Template-generated briefs are NOT a permanent cache hit: they exist
  // because a provider was down or a response was rejected, and an
  // unchanged grounding would otherwise pin the reduced template forever.
  // Each sweep retries the LLM; a repeat miss just re-stores the template.
  if (
    String(svc.pre_service_brief_type || '') === VISIT_BRIEF_TYPE
    && existing?.grounding_hash === groundingHash
    && existing.generated_via !== 'template'
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
  generateVisitBrief,
  briefClearOnReclassification,
  briefStaleReason,
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
