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
 *     property-alerts compiler);
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
const { compilePropertyAlerts } = require('./property-alerts');
const { normalizeServiceType, detectServiceCategory } = require('../utils/service-normalizer');
const { etDateString } = require('../utils/datetime-et');

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

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
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

async function loadRecentServiceRecords(dbh, customerId, serviceType) {
  const rows = await dbh('service_records')
    .where({ customer_id: customerId, status: 'completed' })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .limit(10)
    .select('id', 'customer_id', 'service_type', 'service_line', 'service_date', 'started_at', 'pressure_index')
    .catch(() => []);
  let lastLine = null;
  try {
    const { detectServiceLine } = require('./service-report/service-line-configs');
    const visitLine = detectServiceLine(serviceType);
    lastLine = rows.find(
      (r) => (String(r.service_line || '').trim() || detectServiceLine(r.service_type)) === visitLine,
    ) || null;
  } catch {
    lastLine = null;
  }
  return { last: rows[0] || null, lastLine, recent: rows.slice(0, 5) };
}

async function loadProductHistory(dbh, recordIds) {
  if (!recordIds.length) return [];
  return dbh('service_products as sp')
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
}

// Lawn visits: ONLY the products active for the current protocol window
// (month + grass track scoped) — the owner's bounded-product constraint.
async function loadLawnWindowGuidance(dbh, customerId, scheduledDate) {
  try {
    const { loadCustomerGrassContext } = require('./lawn-grass-context');
    const { getProtocolWindowContext, summarizeProtocolContext } = require('./lawn-protocol-operating-layer');
    const grass = await loadCustomerGrassContext(customerId, dbh);
    const serviceDate = scheduledDate
      ? new Date(`${dateOnly(scheduledDate)}T12:00:00-05:00`)
      : new Date();
    const context = await getProtocolWindowContext(dbh, {
      serviceDate,
      grassTrack: grass.trackKey || 'st_augustine',
    });
    const summary = summarizeProtocolContext(context);
    if (!summary) {
      return { source: 'lawn_protocol_window', available: false, window: null, products: [] };
    }
    return {
      source: 'lawn_protocol_window',
      available: !!summary.window,
      grassTrack: grass.trackKey || null,
      window: summary.window ? {
        key: summary.window.key,
        month: summary.window.month,
        title: summary.window.title,
        visitType: summary.window.visitType,
        goal: cleanText(summary.window.goal, 300),
      } : null,
      products: (summary.products || []).map((p) => ({
        name: cleanText(p.productName, 120),
        role: cleanText(p.role, 60),
        applicationMode: cleanText(p.applicationMode, 40),
        ratePer1000: p.ratePer1000,
        rateUnit: cleanText(p.rateUnit, 20),
        defaultInPlan: p.defaultInPlan === true,
      })).filter((p) => p.name),
    };
  } catch (err) {
    logger.warn(`[previsit-brief] lawn protocol window lookup failed: ${err.message}`);
    return { source: 'lawn_protocol_window', available: false, window: null, products: [] };
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
  const category = detectServiceCategory(normalizedType);

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

  const { last, lastLine, recent } = await loadRecentServiceRecords(dbh, svc.customer_id, svc.service_type);
  const lastVisitRecord = lastLine || last;
  const productRows = await loadProductHistory(dbh, recent.map((r) => r.id));
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
        record: { ...lastVisitRecord, service_date: dateOnly(lastVisitRecord.service_date) },
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
    productGuidance = await loadLawnWindowGuidance(dbh, svc.customer_id, svc.scheduled_date);
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

  const genuinelyNew = !last;
  const access = buildAccessBlock(prefs, svc, genuinelyNew, normalizedType);

  // The ONLY facts the LLM may see: already-redacted context slices plus
  // deterministic history/label facts. No access block, no raw
  // property_preferences, no raw technician notes (serviceHistory notes are
  // the reviewed customer-safe parse), no call transcripts.
  const llmFacts = {
    visit: {
      serviceType: normalizedType,
      scheduledDate: dateOnly(svc.scheduled_date),
      isRecurring: !!svc.is_recurring,
      newCustomer: genuinelyNew,
    },
    lastVisit: lastVisitRecord ? {
      date: dateOnly(lastVisitRecord.service_date),
      serviceType: cleanText(lastVisitRecord.service_type, 120),
      productNames: lastVisitProducts.map((p) => p.name).filter(Boolean),
      sinceLastVisit: sinceLastVisit ? {
        pressureLine: sinceLastVisit.pressureLine || null,
        activityLine: sinceLastVisit.activityLine || null,
        actionLine: sinceLastVisit.actionLine || null,
      } : null,
    } : null,
    serviceHistory: (context?.serviceHistory || []).map((s) => ({
      type: cleanText(s.type, 120),
      date: dateOnly(s.date),
      notes: cleanText(s.notes, 500),
    })),
    propertyProfile: context?.propertyProfile || null,
    flags: (context?.flags || []).map((f) => ({
      type: f.type,
      severity: f.severity,
      detail: cleanText(f.detail, 200),
    })),
    recentCalls: (context?.recentCalls || []).map((c) => ({
      date: dateOnly(c.date),
      direction: c.direction || null,
      summary: cleanText(c.summary, 500),
    })),
    recentInteractions: (context?.recentInteractions || []).map((i) => ({
      type: i.type,
      subject: cleanText(i.subject, 160),
      date: dateOnly(i.date),
    })),
    openScope,
    productGuidance: {
      source: productGuidance.source,
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
    llmFacts,
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

async function generateBriefBody(grounding, deps = {}) {
  const fallback = () => ({ via: 'template', body: templateBriefBody(grounding) });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return fallback();
  const callModel = deps.callModel
    || ((payload) => dispatchWithFallback(MODELS.TEXT_POLICIES.visitBrief, {
      jsonMode: true,
      maxTokens: 1000,
      ...payload,
    }));
  try {
    const resp = await callModel({
      system: SYSTEM_PROMPT,
      text: `Grounding facts:\n${JSON.stringify(grounding.llmFacts, null, 2)}\n\nReturn only the JSON object.`,
    });
    if (!resp || !resp.ok || !resp.json || typeof resp.json !== 'object') {
      logger.warn(`[previsit-brief] LLM miss (${resp?.reason || 'no json'}); using deterministic template`);
      return fallback();
    }
    const body = {
      priorities: sanitizeList(resp.json.priorities, 3),
      watch_items: sanitizeList(resp.json.watch_items, 6),
      last_visit_summary: cleanText(resp.json.last_visit_summary, 500),
      open_scope: cleanText(resp.json.open_scope, 400),
      customer_context: cleanText(resp.json.customer_context, 500),
    };
    // Defensive: forbidden genera must never appear anywhere in the prose.
    if (FORBIDDEN_TARGET_RE.test([body.last_visit_summary, body.open_scope, body.customer_context].join(' '))) {
      logger.warn('[previsit-brief] LLM output named a forbidden target; using deterministic template');
      return fallback();
    }
    return { via: 'llm', body };
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
      date: grounding.lastVisitRecord ? dateOnly(grounding.lastVisitRecord.service_date) : null,
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
    templateBriefBody,
    generateBriefBody,
    buildAccessBlock,
    safeTargets,
    stableStringify,
    SYSTEM_PROMPT,
    PROMPT_VERSION,
  },
};
