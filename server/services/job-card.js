/**
 * Job card — the Service Protocol drawer's cliff-notes tab (GATE_JOB_CARD).
 *
 * One read assembles what a tech needs in the driveway:
 *   strip      name / program line / phone, plus the access codes the strip
 *              renders tap-to-reveal (raw codes live ONLY here — never in
 *              the paragraph or the model payload)
 *   paragraph  1–3 plain sentences written by a FAST-tier model from
 *              deterministic portal facts, with the deterministic template
 *              as both the grounding and the fallback; cached per visit on
 *              scheduled_services.job_card by grounding hash
 *   sprayCheck per-product verdict against NWS hourly at the property
 *   products   the visit's protocol products as cards (verdict, short,
 *              planned amount, precautions, label/SDS, rotation, order)
 *   tank       the active rig calibration the 110 / 1 gal mix helper uses
 *
 * Read-only apart from the paragraph cache. No comms of any kind.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { gateEnvValue } = require('../config/feature-gates');
const { dispatchWithFallback } = require('./llm/call');
const { getHourlyRainOutlook } = require('./weather-forecast');
const { detectServiceCategory } = require('../utils/service-normalizer');
const { addETDays, etDateString, etCalendarDayOf, parseETDateTime } = require('../utils/datetime-et');
const { redactAccessCodes } = require('./context-aggregator');
const { matchServiceProtocol } = require('./protocol-matcher');
const { buildPlanForService, matchCatalogProduct, buildProductInventorySnapshot, summarizeCalibration } = require('./waveguard-plan-engine');
const { latestComparableGroupApplication } = require('./waveguard-approval-engine');

const PROMPT_VERSION = 'job_card_paragraph_v1';
const LANE_ID = 'job_card_paragraph';
// Office fallback when a property has no coordinates — the same point the
// day feed's current-conditions call uses (routes/admin-schedule.js).
const OFFICE_COORDS = { lat: 27.40, lng: -82.40 };
const SPRAY_WINDOW_HOURS = 4;
const RAIN_HOLD_PCT = 50;
const TANK_GALLONS = [110, 1];
const MAX_PARAGRAPH_WORDS = 60;

function jobCardEnabled() {
  return gateEnvValue('GATE_JOB_CARD');
}

// ── Facts ───────────────────────────────────────────────────────────────────

const OPEN_REQUEST_TERMINAL = ['resolved', 'closed', 'cancelled'];

function parseJson(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function clean(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // The same redactor the customer-assistant grounding uses: a code typed
  // into a free-text note must not ride into the paragraph or the model.
  return redactAccessCodes(text).slice(0, max);
}
function cleanRaw(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : '';
}

function petLine(prefs) {
  if (!prefs) return '';
  const structured = parseJson(prefs.pets_structured);
  if (Array.isArray(structured) && structured.length) {
    const names = structured
      .map((p) => clean(p?.type || p?.species || p?.name, 30))
      .filter(Boolean);
    if (names.length) return names.join(', ');
  }
  const count = Number(prefs.pet_count || 0);
  const details = clean(prefs.pet_details, 120);
  if (details) return details;
  if (count > 0) return `${count} pet${count === 1 ? '' : 's'}`;
  return '';
}

function accessCodes(prefs) {
  if (!prefs) return [];
  return [
    ['Neighborhood gate', prefs.neighborhood_gate_code],
    ['Property gate', prefs.property_gate_code],
    ['Garage', prefs.garage_code],
    ['Lockbox', prefs.lockbox_code],
  ]
    .filter(([, code]) => cleanRaw(code, 40))
    .map(([label, code]) => ({ label, code: cleanRaw(code, 40) }));
}

function wateringLine(prefs) {
  if (!prefs || prefs.irrigation_system === false) return '';
  const days = parseJson(prefs.watering_days);
  const dayText = Array.isArray(days) && days.length ? days.map((d) => clean(d, 12)).filter(Boolean).join('/') : '';
  const minutes = Number(prefs.irrigation_run_minutes || 0);
  const inches = Number(prefs.irrigation_inches_per_week || 0);
  const parts = [];
  if (dayText) parts.push(dayText);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (inches > 0) parts.push(`${inches}"/wk`);
  return parts.join(', ');
}

// Present AND in range, checked before any numeric coercion (Number(null)
// and Number('') are 0, which would send the NWS lookup to the Gulf of
// Guinea instead of the office fallback).
function propertyCoords(latRaw, lngRaw) {
  if (latRaw == null || latRaw === '' || lngRaw == null || lngRaw === '') return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

async function loadRain7d(dbh, customer) {
  if (!customer?.lawn_water_area_id) return null;
  const since = addETDays(new Date(), -7);
  const row = await dbh('lawn_area_weather_daily')
    .where({ area_id: customer.lawn_water_area_id })
    .where('date', '>=', since)
    .sum({ total: 'rain_inches' })
    .first()
    .catch(() => null);
  const total = row?.total != null ? Number(row.total) : null;
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : null;
}

async function loadLastVisit(dbh, customerId, serviceLine) {
  const record = await dbh('service_records as sr')
    .where({ 'sr.customer_id': customerId, 'sr.status': 'completed' })
    .modify((qb) => { if (serviceLine) qb.where('sr.service_line', serviceLine); })
    .orderBy('sr.service_date', 'desc')
    .orderBy('sr.started_at', 'desc')
    .select('sr.id', 'sr.service_date', 'sr.service_type', 'sr.technician_notes', 'sr.is_callback')
    .first()
    .catch(() => null);
  if (!record) return null;
  const finding = await dbh('service_findings')
    .where({ service_record_id: record.id })
    .orderBy('severity', 'desc')
    .select('title')
    .first()
    .catch(() => null);
  return {
    date: etCalendarDayOf(record.service_date),
    serviceType: clean(record.service_type, 60),
    summary: clean(finding?.title || record.technician_notes, 120),
    callback: Boolean(record.is_callback),
  };
}

async function loadOpenIssues(dbh, customerId) {
  const [requests, complaints] = await Promise.all([
    dbh('service_requests')
      .where({ customer_id: customerId })
      .whereNotIn('status', OPEN_REQUEST_TERMINAL)
      .orderBy('created_at', 'desc')
      .select('subject', 'category', 'urgency', 'created_at')
      .limit(3)
      .catch(() => []),
    dbh('customer_interactions')
      .where({ customer_id: customerId, interaction_type: 'complaint' })
      .where('created_at', '>', new Date(Date.now() - 90 * 86400000))
      .orderBy('created_at', 'desc')
      .select('subject', 'body', 'created_at')
      .limit(2)
      .catch(() => []),
  ]);
  return [
    ...requests.map((r) => ({ kind: 'request', text: clean(r.subject || r.category, 80), urgent: r.urgency === 'urgent' })),
    ...complaints.map((c) => ({ kind: 'complaint', text: clean(c.subject || c.body, 80), urgent: false })),
  ].filter((i) => i.text);
}

async function loadCallsSince(dbh, customerId, sinceDate) {
  const query = dbh('call_log')
    .where({ customer_id: customerId })
    .whereNotNull('call_summary')
    .whereRaw('length(trim(call_summary)) > 0')
    .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
    .where('created_at', '>', sinceDate ? parseETDateTime(`${sinceDate}T00:00`) : new Date(Date.now() - 60 * 86400000))
    .orderBy('created_at', 'desc')
    .select('call_summary', 'direction', 'created_at')
    .limit(3);
  const rows = await query.catch(() => []);
  return rows.map((r) => ({ summary: clean(r.call_summary, 140), direction: r.direction || null, date: etDateString(r.created_at) }));
}

/**
 * Everything the card needs about the visit, customer and property. Raw
 * access codes are returned under `access.codes` only.
 */
async function loadJobCardFacts(serviceId, dbh = db) {
  const svc = await dbh('scheduled_services as ss')
    .join('customers as c', 'ss.customer_id', 'c.id')
    .where('ss.id', serviceId)
    .select(
      'ss.id', 'ss.customer_id', 'ss.scheduled_date', 'ss.service_type', 'ss.status', 'ss.notes',
      'ss.job_card', 'ss.job_card_generated_at',
      'c.first_name', 'c.last_name', 'c.phone', 'c.latitude', 'c.longitude', 'c.lawn_water_area_id',
      'c.waveguard_tier',
    )
    .first();
  if (!svc) return null;

  const serviceLine = detectServiceCategory(svc.service_type);
  const [prefs, lastVisit, issues] = await Promise.all([
    dbh('property_preferences').where({ customer_id: svc.customer_id }).first().catch(() => null),
    loadLastVisit(dbh, svc.customer_id, serviceLine),
    loadOpenIssues(dbh, svc.customer_id),
  ]);
  const [calls, rain7d] = await Promise.all([
    loadCallsSince(dbh, svc.customer_id, lastVisit?.date || null),
    serviceLine === 'lawn' ? loadRain7d(dbh, svc) : Promise.resolve(null),
  ]);

  const name = clean(`${svc.first_name || ''} ${svc.last_name || ''}`, 80);
  const program = clean(svc.waveguard_tier ? `${svc.service_type} · WaveGuard ${svc.waveguard_tier}` : svc.service_type, 80);
  const coords = propertyCoords(svc.latitude, svc.longitude);

  return {
    serviceId: svc.id,
    customerId: svc.customer_id,
    scheduledDate: etCalendarDayOf(svc.scheduled_date),
    serviceType: svc.service_type,
    serviceLine,
    isLawn: serviceLine === 'lawn',
    strip: { name, program, phone: clean(svc.phone, 24) || null },
    access: { codes: accessCodes(prefs) },
    coords: coords ? { ...coords, source: 'property' } : { ...OFFICE_COORDS, source: 'office' },
    // Model-safe facts. Nothing below carries a code or a phone number.
    facts: {
      pets: petLine(prefs),
      petsSecured: clean(prefs?.pets_secured_plan, 80),
      gates: accessCodes(prefs).map((c) => c.label),
      entry: clean(prefs?.access_notes || prefs?.side_gate_access, 120),
      parking: clean(prefs?.parking_notes, 80),
      instructions: clean(prefs?.special_instructions, 120),
      contactPreference: prefs?.contact_preference || null,
      chemicalSensitivity: prefs?.chemical_sensitivities ? clean(prefs.chemical_sensitivity_details, 80) || 'yes' : '',
      awayUntil: prefs?.away_mode_until ? etCalendarDayOf(prefs.away_mode_until) : null,
      visitNotes: clean(svc.notes, 140),
      lastVisit,
      issues,
      calls,
      irrigation: serviceLine === 'lawn' ? wateringLine(prefs) : null,
      rain7d,
    },
    cache: { stored: parseJson(svc.job_card), generatedAt: svc.job_card_generated_at || null },
  };
}

// ── Paragraph ───────────────────────────────────────────────────────────────

/**
 * Deterministic 1–3 sentences from the facts. Used verbatim when the model
 * leg misses and as the grounding the model is allowed to rephrase.
 */
function buildTemplateParagraph(facts, { isLawn = false } = {}) {
  const s1 = [];
  if (facts.pets) s1.push(`Pets: ${facts.pets}${facts.petsSecured ? ` (${facts.petsSecured})` : ''}`);
  if (facts.gates.length) s1.push(`${facts.gates.join(' and ').toLowerCase()} code on file, tap to show`);
  if (facts.entry) s1.push(facts.entry);
  if (facts.parking) s1.push(facts.parking);
  if (facts.chemicalSensitivity) s1.push(`chemical sensitivity${facts.chemicalSensitivity !== 'yes' ? `: ${facts.chemicalSensitivity}` : ''}`);
  if (facts.awayUntil) s1.push(`customer away until ${facts.awayUntil}`);
  if (facts.contactPreference && facts.contactPreference !== 'text') s1.push(`prefers ${facts.contactPreference}`);

  const s2 = [];
  if (facts.lastVisit) {
    s2.push(`Last visit ${facts.lastVisit.date}${facts.lastVisit.summary ? `: ${facts.lastVisit.summary}` : ''}${facts.lastVisit.callback ? ' (callback)' : ''}`);
  } else {
    s2.push('First visit on record');
  }
  if (facts.issues.length) s2.push(`open: ${facts.issues.map((i) => `${i.urgent ? 'URGENT ' : ''}${i.text}`).join('; ')}`);
  if (facts.calls.length) s2.push(`called ${facts.calls[0].date}: ${facts.calls[0].summary}`);
  if (facts.visitNotes) s2.push(`note: ${facts.visitNotes}`);
  if (facts.instructions) s2.push(facts.instructions);

  const s3 = [];
  if (isLawn) {
    if (facts.irrigation) s3.push(`Irrigation ${facts.irrigation}`);
    else s3.push('No irrigation on file — ask the customer');
    if (facts.rain7d != null) s3.push(`${facts.rain7d}" rain in the last 7 days`);
  }

  const sentence = (parts) => (parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : '');
  return [sentence(s1), sentence(s2), sentence(s3)].filter(Boolean).join(' ');
}

const SYSTEM_PROMPT = [
  'You rewrite a technician\'s pre-visit notes into one short paragraph of one to three plain sentences.',
  'Keep every fact that is given. Add nothing. No emojis, no bullet points, no headings, no greetings.',
  'Never invent numbers, names, dates or codes. If a line says a code is on file, say it is on file and can be shown — never print a code.',
  'Write for a technician standing in the driveway: direct, present tense, at most 60 words.',
  'Answer with the paragraph only.',
].join(' ');

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/**
 * Model output is accepted only when it is 1–3 sentences, ≤ 60 words, carries
 * no emoji, no bullet/heading markup, no code-looking token, and no number
 * that the grounding does not contain.
 */
function validateParagraph(text, grounding, codes = []) {
  // Raw text on purpose: the code check below must see a code as written.
  // (The context-aggregator redactor is NOT run on model output — it masks
  // every token near the words "gate code", which the paragraph legitimately
  // says; the known-code + grounded-number checks are the leak guard here.)
  const body = cleanRaw(text, 600);
  if (!body) return 'empty';
  if (/^[-*#>]/m.test(body) || /\n/.test(String(text || '').trim())) return 'markup';
  if (EMOJI_RE.test(body)) return 'emoji';
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length < 1 || sentences.length > 3) return 'sentence_count';
  if (body.split(/\s+/).length > MAX_PARAGRAPH_WORDS) return 'too_long';
  for (const { code } of codes) {
    if (code && body.includes(code)) return 'code_leak';
  }
  const groundedNumbers = new Set((grounding.match(/\d+(?:[.,]\d+)?/g) || []));
  for (const num of body.match(/\d+(?:[.,]\d+)?/g) || []) {
    if (!groundedNumbers.has(num)) return 'ungrounded_number';
  }
  return null;
}

function groundingHash(template) {
  return crypto.createHash('sha256').update(`${PROMPT_VERSION}|${template}`).digest('hex');
}

/**
 * Model-written paragraph over the template grounding. Returns
 * { text, source: 'model' | 'template' }. Never throws.
 */
async function writeParagraph(template, codes = [], deps = {}) {
  const fallback = { text: template, source: 'template' };
  if (!template) return fallback;
  if (!deps.callModel && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return fallback;
  const validate = (result) => validateParagraph(result?.text, template, codes);
  const callModel = deps.callModel
    || ((payload, opts) => dispatchWithFallback(MODELS.TEXT_POLICIES.jobCardParagraph, {
      laneId: LANE_ID,
      promptVersion: PROMPT_VERSION,
      jsonMode: false,
      maxTokens: 300,
      reasoningEffort: 'none',
      timeoutMs: 12000,
      ...payload,
    }, opts));
  try {
    const resp = await callModel({ system: SYSTEM_PROMPT, text: `Notes:\n${template}` }, { validate });
    if (!resp?.ok || !resp.text) {
      logger.warn(`[job-card] paragraph miss (${resp?.reason || 'no text'}); using template`);
      return fallback;
    }
    // Defense in depth for injected call paths that skip the dispatcher's
    // per-leg validate hook.
    if (validateParagraph(resp.text, template, codes)) return fallback;
    return { text: cleanRaw(resp.text, 600), source: 'model' };
  } catch (err) {
    logger.warn(`[job-card] paragraph failed: ${err.message}; using template`);
    return fallback;
  }
}

/**
 * Paragraph for one visit with the per-visit cache. A cached model
 * paragraph whose grounding hash matches is returned as-is; a cached
 * template is retried (a miss must not pin the template forever). The
 * write is compare-and-swap on job_card_generated_at so a concurrent
 * regeneration with fresher facts is never overwritten.
 */
async function paragraphForVisit(facts, { dbh = db, deps = {} } = {}) {
  const template = buildTemplateParagraph(facts.facts, { isLawn: facts.isLawn });
  const hash = groundingHash(template);
  const stored = facts.cache.stored;
  if (stored?.grounding_hash === hash && stored.source === 'model' && stored.text) {
    return { text: stored.text, source: 'model', cached: true };
  }
  const written = await writeParagraph(template, facts.access.codes, deps);
  const row = { version: PROMPT_VERSION, grounding_hash: hash, text: written.text, source: written.source };
  const prior = facts.cache.generatedAt;
  await dbh('scheduled_services')
    .where({ id: facts.serviceId })
    .where(function sameGeneration() {
      if (prior) this.where('job_card_generated_at', prior);
      else this.whereNull('job_card_generated_at');
    })
    .update({ job_card: JSON.stringify(row), job_card_generated_at: new Date() })
    .catch((err) => logger.warn(`[job-card] cache write skipped: ${err.message}`));
  return { ...written, cached: false };
}

// ── Spray check ─────────────────────────────────────────────────────────────

function productLimits(product) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return {
    maxTempF: num(product.max_temp_f),
    maxWindMph: num(product.max_wind_mph),
    rainFreeHours: num(product.rain_free_hours),
  };
}

/**
 * Verdict per product over the next SPRAY_WINDOW_HOURS of NWS hourly
 * periods. `hold` when any hour in the window breaks a label limit;
 * `unknown` when the product carries no limits; `ok` otherwise. A missing
 * forecast makes every product `unknown` with reason `no_forecast`.
 */
function buildSprayCheck({ products = [], hourly = null, now = new Date() } = {}) {
  const start = now.getTime();
  const window = Array.isArray(hourly)
    ? hourly.filter((h) => {
      const t = Date.parse(h.startTime);
      return Number.isFinite(t) && t + 3600000 > start && t < start + SPRAY_WINDOW_HOURS * 3600000;
    })
    : [];
  const summary = window.length
    ? {
      tempF: [Math.min(...window.map((h) => h.temperatureF ?? Infinity)), Math.max(...window.map((h) => h.temperatureF ?? -Infinity))].map((v) => (Number.isFinite(v) ? v : null)),
      windMph: Math.max(...window.map((h) => h.windMph ?? 0)),
      rainPct: Math.max(...window.map((h) => h.rainChance ?? 0)),
      shortForecast: window[0].shortForecast || null,
    }
    : null;

  // Hours covering [now, now + hours) from the FULL hourly input — a
  // product's rain-free interval can run past the 4 h spray window.
  const hoursAhead = (hours) => (Array.isArray(hourly) ? hourly : []).filter((h) => {
    const t = Date.parse(h.startTime);
    return Number.isFinite(t) && t + 3600000 > start && t < start + hours * 3600000;
  });
  // Continuous coverage from now through now + hours: each period must start
  // no later than the previous one ended (a 09:30 start needs the 13:00 row
  // for a 4 h window; an interior gap never passes).
  const covers = (rows, hours) => {
    const end = start + hours * 3600000;
    let cursor = start;
    const starts = rows.map((h) => Date.parse(h.startTime)).filter(Number.isFinite).sort((a, b) => a - b);
    for (const t of starts) {
      if (t > cursor) return false;
      cursor = Math.max(cursor, t + 3600000);
      if (cursor >= end) return true;
    }
    return cursor >= end;
  };

  const verdicts = products.map((product) => {
    const limits = productLimits(product);
    const hasLimits = [limits.maxTempF, limits.maxWindMph, limits.rainFreeHours].some((v) => v != null);
    if (!hasLimits) return { productId: product.id, verdict: 'unknown', reason: 'No limit on file' };
    if (!window.length) return { productId: product.id, verdict: 'unknown', reason: 'No forecast' };
    const reasons = [];
    const missing = [];
    // A limit can only pass when EVERY hour it is judged over carries the
    // measurement; a null reading is "unknown", never a pass.
    // A known breach in any hour is a Hold even when another hour's reading
    // is missing; a limit only PASSES when every hour of the interval is
    // present and carries the measurement.
    const judge = ({ rows, hours, key, label, limit, reason }) => {
      if (rows.some((h) => h[key] != null && h[key] > limit)) { reasons.push(reason); return; }
      if (!covers(rows, hours) || rows.some((h) => h[key] == null)) missing.push(label);
    };
    if (limits.maxTempF != null) {
      judge({ rows: window, hours: SPRAY_WINDOW_HOURS, key: 'temperatureF', label: 'temperature', limit: limits.maxTempF, reason: `over ${limits.maxTempF}°F` });
    }
    if (limits.maxWindMph != null) {
      judge({ rows: window, hours: SPRAY_WINDOW_HOURS, key: 'windMph', label: 'wind', limit: limits.maxWindMph, reason: `wind over ${limits.maxWindMph} mph` });
    }
    if (limits.rainFreeHours != null) {
      const label = `rain ${limits.rainFreeHours} h`;
      judge({ rows: hoursAhead(limits.rainFreeHours), hours: limits.rainFreeHours, key: 'rainChance', label, limit: RAIN_HOLD_PCT - 1, reason: `rain likely inside ${limits.rainFreeHours} h` });
    }
    if (reasons.length) return { productId: product.id, verdict: 'hold', reason: reasons.join(', ') };
    if (missing.length) return { productId: product.id, verdict: 'unknown', reason: `No ${missing.join(' / ')} forecast` };
    return { productId: product.id, verdict: 'ok', reason: null };
  });

  return {
    windowHours: SPRAY_WINDOW_HOURS,
    forecast: summary,
    hold: verdicts.some((v) => v.verdict === 'hold'),
    verdicts,
  };
}

// ── Products ────────────────────────────────────────────────────────────────

const PRODUCT_COLUMNS = [
  'id', 'name', 'category', 'active_ingredient', 'moa_group', 'frac_group', 'irac_group', 'hrac_group',
  'analysis_n', 'analysis_p', 'analysis_k',
  'default_rate_per_1000', 'rate_unit', 'default_rate', 'default_unit', 'application_method',
  'cost_per_unit', 'cost_unit', 'container_size', 'unit_size_oz',
  'mixing_order_category', 'mixing_instructions', 'rainfast_minutes', 'rei_hours',
  'labeled_turf_species', 'excluded_turf_species', 'requires_surfactant', 'allows_surfactant',
  'label_url', 'sds_url', 'epa_reg_number', 'manufacturer',
  'max_temp_f', 'max_wind_mph', 'rain_free_hours', 'signal_word', 'ppe_required', 'reentry_text',
  'customer_safety_summary', 'pet_kid_guidance_text', 'service_report_summary',
  'inventory_on_hand', 'inventory_unit', 'low_stock_threshold',
  'best_price_amount_cached', 'best_price_updated_at',
];

async function loadCatalog(dbh = db) {
  const products = await dbh('products_catalog')
    .where(function activeOrUnknown() { this.where({ active: true }).orWhereNull('active'); })
    .select(PRODUCT_COLUMNS)
    .catch(() => []);
  if (!products.length) return [];
  const aliases = await dbh('product_aliases')
    .whereIn('product_id', products.map((p) => p.id))
    .select('product_id', 'alias_name')
    .catch(() => []);
  const byProduct = aliases.reduce((acc, row) => {
    (acc[row.product_id] = acc[row.product_id] || []).push(row.alias_name);
    return acc;
  }, {});
  return products.map((p) => ({ ...p, aliases: byProduct[p.id] || [] }));
}

async function loadPackSizes(dbh, productIds) {
  if (!productIds.length) return {};
  const rows = await dbh('distributor_product_map')
    .whereIn('product_id', productIds)
    .whereNotNull('pack_size')
    .select('product_id', 'pack_size')
    .catch(() => []);
  return rows.reduce((acc, r) => { if (!acc[r.product_id]) acc[r.product_id] = r.pack_size; return acc; }, {});
}

async function getActiveCalibration(dbh = db) {
  return dbh('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where('ec.active', true)
    .where('es.active', true)
    .select('ec.carrier_gal_per_1000', 'ec.expires_at', 'ec.calibration_status', 'es.name as system_name', 'es.tank_capacity_gal')
    .orderByRaw("case when es.name ilike '110-Gallon Spray Tank #1%' then 0 when es.system_type = 'tank' then 1 else 2 end")
    .orderBy('es.name', 'asc')
    .first()
    .catch(() => null);
}

// The plan engine's calibration validation (expired / not field verified)
// decides whether a mix may be computed; only the wording is the card's.
const TANK_BLOCK_REASON = {
  missing_calibration: 'No rig calibration on file',
  expired_calibration: 'Rig calibration expired',
  calibration_not_field_verified: 'Rig calibration not field verified',
};

function tankFromCalibration(cal, now = new Date()) {
  if (!cal) return { calibrated: false, reason: TANK_BLOCK_REASON.missing_calibration, carrierGalPer1000: null, tankCapacityGal: null, expiresAt: null, systemName: null };
  const { blocks } = summarizeCalibration({ calibration: cal, date: now });
  const block = blocks[0] || null;
  const carrier = Number(cal.carrier_gal_per_1000 || 0);
  return {
    calibrated: !block && carrier > 0,
    reason: block ? (TANK_BLOCK_REASON[block.code] || block.message) : (carrier > 0 ? null : 'No carrier rate on file'),
    carrierGalPer1000: carrier > 0 ? carrier : null,
    tankCapacityGal: cal.tank_capacity_gal != null ? Number(cal.tank_capacity_gal) : null,
    expiresAt: cal.expires_at || null,
    systemName: cal.system_name || null,
  };
}

/**
 * Amount of product for `gallons` of water: the label rate per 1,000 sq ft
 * divided by the calibrated carrier gallons per 1,000 sq ft. Null with a
 * reason when either number is missing.
 */
function buildMixAmount({ ratePer1000, rateUnit, carrierGalPer1000, gallons }) {
  const gal = Number(gallons);
  if (!TANK_GALLONS.includes(gal)) return { amount: null, unit: rateUnit || null, reason: 'Pick 110 or 1 gallons' };
  const rate = Number(ratePer1000);
  const carrier = Number(carrierGalPer1000);
  if (!Number.isFinite(rate) || rate <= 0) return { amount: null, unit: rateUnit || null, reason: 'No verified rate on file' };
  if (!Number.isFinite(carrier) || carrier <= 0) return { amount: null, unit: rateUnit || null, reason: 'Rig not calibrated' };
  const amount = (rate / carrier) * gal;
  return { amount: Math.round(amount * 100) / 100, unit: rateUnit || null, gallons: gal, coversSqft: Math.round((gal / carrier) * 1000), reason: null };
}

/**
 * Only a product that goes in the spray tank gets a tank amount. Mirrors the
 * dispatch closeout's method inference (admin-dispatch.js): an explicit
 * granular / bait / station / injection method, a granular category or name,
 * or a dry-weight rate unit means "apply as labeled", not "mix in water".
 */
function isTankMixable(product = {}) {
  const method = String(product.application_method || '').toLowerCase();
  if (/granul|bait|gel|glue|station|trunk|inject/.test(method)) return false;
  const text = `${product.category || ''} ${product.name || ''}`.toLowerCase();
  if (/granul/.test(text) || /\bg\b$/.test(String(product.name || '').trim().toLowerCase())) return false;
  if (/\blbs?\b/.test(String(product.rate_unit || '').toLowerCase())) return false;
  return true;
}

function precautionText(product) {
  const parts = [clean(product.customer_safety_summary, 160), clean(product.reentry_text, 100)].filter(Boolean);
  const ppe = parseJson(product.ppe_required);
  const ppeText = Array.isArray(ppe) ? ppe.map((p) => clean(p, 30)).filter(Boolean).join(', ') : clean(ppe, 80);
  if (ppeText) parts.push(`PPE: ${ppeText}`);
  return parts.join(' ') || null;
}

/**
 * The visit's protocol product lines resolved to catalog rows. Lawn visits
 * reuse the appointment's resolved plan (buildPlanForService: turf profile,
 * soil P branch, tier, stress flags, saved substitutions with their rate
 * overrides, assigned calibration) so the card never disagrees with the
 * plan; other lines come from the matched protocol visit's catalog hints.
 */
async function resolveVisitProducts({ facts, protocols, catalog, dbh = db, deps = {}, now = new Date() }) {
  if (facts.isLawn) {
    let plan;
    try {
      plan = await (deps.buildPlan || buildPlanForService)(facts.serviceId, { db: dbh, now });
    } catch (err) {
      logger.warn(`[job-card] plan unavailable for ${facts.serviceId}: ${err.message}`);
      return { visit: null, lines: [] };
    }
    const items = [...(plan?.mixCalculator?.items || []), ...(plan?.mixCalculator?.conditionalOptions || [])];
    const lines = [];
    for (const item of items) {
      const product = item.product ? catalog.find((p) => p.id === item.product.id) : null;
      if (!product) continue;
      lines.push({
        raw: item.raw,
        role: item.role,
        selected: item.selected,
        product,
        planMix: item.mix || null,
        substitutedFor: item.substitution?.originalProductName || null,
      });
    }
    const gate = plan?.propertyGate || {};
    return { visit: gate.month ? { month: gate.month, visit: gate.visit || null } : null, lines };
  }
  const match = matchServiceProtocol(protocols, facts.serviceType);
  const visit = match?.matchedVisit || match?.program?.visits?.[0] || null;
  if (!visit) return { visit: null, lines: [] };
  const hints = new Map();
  for (const [raw, meta] of Object.entries(visit.lineMeta || {})) {
    for (const hint of meta?.catalogProductHints || []) {
      if (!hints.has(hint)) hints.set(hint, raw);
    }
  }
  const lines = [];
  for (const [hint, raw] of hints) {
    const product = matchCatalogProduct({ raw: hint, catalogProductHints: [hint] }, catalog);
    if (product && !lines.some((l) => l.product.id === product.id)) lines.push({ raw, product, role: 'base', selected: true });
  }
  return { visit, lines };
}

async function buildProductCards({ facts, lines, verdicts, packSizes, dbh = db }) {
  // One card per catalog product: two protocol lines can resolve to the same
  // row (a base line plus a conditional). The selected line wins the card;
  // the other line's text rides along.
  const byProduct = new Map();
  for (const line of lines) {
    const existing = byProduct.get(line.product.id);
    if (!existing) { byProduct.set(line.product.id, { ...line, extraLines: [] }); continue; }
    if (line.selected && !existing.selected) {
      byProduct.set(line.product.id, { ...line, extraLines: [existing.raw, ...existing.extraLines] });
    } else {
      existing.extraLines.push(line.raw);
    }
  }
  const cards = [];
  for (const line of byProduct.values()) {
    const p = line.product;
    const verdict = verdicts.find((v) => v.productId === p.id) || { verdict: 'unknown', reason: 'No limit on file' };
    // The appointment plan's own mix (lawn only) — never recomputed here.
    const plannedMix = line.selected !== false && line.planMix?.amount > 0 ? line.planMix : null;
    const planned = plannedMix ? { amount: Math.round(plannedMix.amount * 100) / 100, unit: plannedMix.amountUnit || p.rate_unit || null } : null;
    // Unit-aware: the planned amount is in the application unit (fl oz),
    // stock in the inventory unit (gal) — the plan engine's snapshot owns
    // that conversion. Unconvertible pairs are not "short", they are flagged.
    const inventory = buildProductInventorySnapshot(p, plannedMix);
    const onHand = inventory?.onHand ?? null;
    const short = Boolean(inventory && inventory.plannedAmountInventoryUnit != null && onHand != null && inventory.plannedAmountInventoryUnit > onHand);
    // Untracked stock is the catalog's normal state, not a warning worth a line.
    const stockNote = inventory?.warning && !short && inventory.status !== 'not_tracked' ? inventory.warning : null;
    const rotation = await rotationNote(dbh, facts, p);
    cards.push({
      id: p.id,
      name: p.name,
      role: line.role || 'base',
      conditional: line.selected === false,
      line: [line.substitutedFor ? `Substitute for ${line.substitutedFor}` : null, line.raw, ...line.extraLines].map((r) => clean(r, 120)).filter(Boolean).join(' · '),
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
      planned,
      short,
      stockNote,
      onHand,
      onHandUnit: inventory?.unit || null,
      lowStock: inventory?.status === 'low' || inventory?.status === 'depleted',
      signalWord: p.signal_word || null,
      precautions: precautionText(p),
      labelUrl: p.label_url || null,
      sdsUrl: p.sds_url || null,
      rotation,
      order: {
        packSize: packSizes[p.id] || null,
        lastPrice: p.best_price_amount_cached != null ? Number(p.best_price_amount_cached) : null,
        unit: p.inventory_unit || p.rate_unit || null,
      },
    });
  }
  return cards;
}

async function rotationNote(dbh, facts, product) {
  const group = ['frac', 'irac', 'hrac'].find((g) => product[`${g}_group`]);
  if (!group) return null;
  try {
    const last = await latestComparableGroupApplication(dbh, facts.customerId, product, group, product[`${group}_group`], facts.scheduledDate);
    if (!last) return null;
    return `${group.toUpperCase()} ${product[`${group}_group`]} last used ${etCalendarDayOf(last.service_date)}${last.product_name && last.product_name !== product.name ? ` (${clean(last.product_name, 40)})` : ''}`;
  } catch {
    return null;
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────────

async function buildJobCard(serviceId, { dbh = db, deps = {}, now = new Date() } = {}) {
  const facts = await loadJobCardFacts(serviceId, dbh);
  if (!facts) return null;
  const protocols = deps.protocols || require('../config/protocols.json');

  const [paragraph, catalog, calibration, hourly] = await Promise.all([
    paragraphForVisit(facts, { dbh, deps }),
    loadCatalog(dbh),
    getActiveCalibration(dbh),
    (deps.getHourly || getHourlyRainOutlook)(facts.coords.lat, facts.coords.lng).catch(() => null),
  ]);
  const tank = tankFromCalibration(calibration, now);
  const { visit, lines } = await resolveVisitProducts({ facts, protocols, catalog, dbh, deps, now });
  const products = lines.map((l) => l.product);
  const sprayCheck = buildSprayCheck({ products, hourly, now });
  const packSizes = await loadPackSizes(dbh, products.map((p) => p.id));
  const cards = await buildProductCards({ facts, lines, verdicts: sprayCheck.verdicts, packSizes, dbh });

  return {
    enabled: true,
    serviceId: facts.serviceId,
    customerId: facts.customerId,
    serviceLine: facts.serviceLine,
    strip: { ...facts.strip, access: facts.access },
    paragraph,
    sprayCheck: { ...sprayCheck, coordsSource: facts.coords.source },
    tank,
    products: cards,
    visit: visit ? { number: visit.visit || null, month: visit.month || null } : null,
  };
}

/**
 * Mix helper for the Tank section's product search: amount of one catalog
 * product for 110 or 1 gallons of water on the active rig.
 */
async function mixForProduct(productId, gallons, { dbh = db, now = new Date() } = {}) {
  const [product, calibration] = await Promise.all([
    dbh('products_catalog').where({ id: productId }).select('id', 'name', 'category', 'application_method', 'default_rate_per_1000', 'rate_unit', 'inventory_on_hand', 'inventory_unit', 'best_price_amount_cached', 'label_verified_at').first().catch(() => null),
    getActiveCalibration(dbh),
  ]);
  if (!product) return null;
  const tank = tankFromCalibration(calibration, now);
  // An expired calibration keeps its carrier number for display, but no
  // mix is computed from it — the same withholding the lawn-mix route does.
  const tankMixable = isTankMixable(product);
  const mix = tankMixable
    ? buildMixAmount({ ratePer1000: product.default_rate_per_1000, rateUnit: product.rate_unit, carrierGalPer1000: tank.calibrated ? tank.carrierGalPer1000 : null, gallons })
    : { amount: null, unit: product.rate_unit || null, reason: 'Not a tank mix — apply as labeled' };
  const packSizes = await loadPackSizes(dbh, [product.id]);
  return {
    productId: product.id,
    name: product.name,
    ratePer1000: product.default_rate_per_1000 != null ? Number(product.default_rate_per_1000) : null,
    rateVerified: Boolean(product.label_verified_at),
    tankMixable,
    ...mix,
    tank,
    order: {
      packSize: packSizes[product.id] || null,
      lastPrice: product.best_price_amount_cached != null ? Number(product.best_price_amount_cached) : null,
      unit: product.inventory_unit || product.rate_unit || null,
    },
  };
}

module.exports = {
  jobCardEnabled,
  buildJobCard,
  mixForProduct,
  loadJobCardFacts,
  buildTemplateParagraph,
  validateParagraph,
  writeParagraph,
  paragraphForVisit,
  buildSprayCheck,
  buildMixAmount,
  tankFromCalibration,
  resolveVisitProducts,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  _test: { accessCodes, petLine, wateringLine, precautionText, groundingHash, propertyCoords, isTankMixable },
};
