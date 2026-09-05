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
// The classifier that stamps service_records.service_line — a callback
// visit is 'pest' there, so the history filter must agree.
const { detectServiceLine } = require('./service-report/service-line-configs');
const { SEVERITY_RANK } = require('./service-report/pressure-trend');
const { addETDays, etDateString, etCalendarDayOf, parseETDateTime } = require('../utils/datetime-et');
const contextAggregator = require('./context-aggregator');

const { redactAccessCodes } = contextAggregator;
const { matchServiceProtocol } = require('./protocol-matcher');
const {
  buildPlanForService, matchCatalogProduct, buildProductInventorySnapshot, summarizeCalibration, getActiveCalibrations,
  itemHasNitrogen, itemHasPhosphorus, parseProtocolLines,
} = require('./waveguard-plan-engine');
const { stampedDivergesSql } = require('./stamped-address');
const { convertInventoryQuantity } = require('./inventory-units');
const { getAreaRainfall } = require('./lawn-water-area');
const { latestComparableGroupApplication, evaluateWaveGuardManagerApprovals } = require('./waveguard-approval-engine');

const PROMPT_VERSION = 'job_card_paragraph_v1';
// Office fallback when a property has no coordinates — the same point the
// day feed's current-conditions call uses (routes/admin-schedule.js).
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
/**
 * Strip the property's KNOWN code values from every string in the
 * model-safe facts: the keyword redactor cannot catch a bare "4545#" pasted
 * into a note, but the loader knows the exact values it must never ground.
 */
function scrubKnownCodes(value, codes) {
  // Every non-empty stored value (the property API sets no minimum length);
  // a short code is matched as a whole token so "12" does not eat dates.
  const known = codes.map((c) => String(c.code || '').trim()).filter(Boolean);
  if (!known.length) return value;
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Case-insensitive: a code stored as BLUE pasted as blue is still the code.
  // (a date's "-12" or "08.12" is not the code "12")
  const re = new RegExp(known.map((c) => (c.length < 4 ? `(?<![A-Za-z0-9.-])${esc(c)}(?![A-Za-z0-9.-])` : esc(c))).join('|'), 'gi');
  const walk = (v) => {
    if (typeof v === 'string') return v.replace(re, '[code]');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
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

// Away mode is a fact only while it is current (ET): a lapsed date is not
// "customer away".
function awayUntil(prefs, now = new Date()) {
  if (!prefs?.away_mode_until) return null;
  const until = etCalendarDayOf(prefs.away_mode_until);
  return until && until >= etDateString(now) ? until : null;
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
  // The canonical reader: null unless every day of the window is on file,
  // so a missed sync day never reads as a dry week.
  const today = etDateString(new Date());
  const since = etDateString(addETDays(new Date(), -6));
  return getAreaRainfall(customer.lawn_water_area_id, since, today, dbh);
}

async function loadLastVisit(dbh, customerId, serviceLine, beforeDate = null) {
  const record = await dbh('service_records as sr')
    .where({ 'sr.customer_id': customerId, 'sr.status': 'completed' })
    // History means BEFORE this visit — never the visit's own record or a
    // later one when an older appointment's card is opened.
    .modify((qb) => { if (beforeDate) qb.where('sr.service_date', '<', beforeDate); })
    .modify((qb) => { if (serviceLine) qb.where('sr.service_line', serviceLine); })
    .orderBy('sr.service_date', 'desc')
    .orderBy('sr.started_at', 'desc')
    .select('sr.id', 'sr.service_date', 'sr.started_at', 'sr.service_type', 'sr.technician_notes', 'sr.is_callback')
    .first()
    .catch(() => ({ unavailable: true }));
  // A failed lookup is not "no history" — the template says so instead
  // of claiming a first visit.
  if (record?.unavailable) return { unavailable: true };
  if (!record) return null;
  // severity is text: rank it (critical > high > medium > low > info)
  // with the report's own ranking, never alphabetically.
  // A failed findings read is not "no findings": the headline finding is
  // the visit's most important fact, so the history reads as unavailable.
  const findings = await dbh('service_findings')
    .where({ service_record_id: record.id })
    .select('title', 'severity')
    .catch(() => ({ unavailable: true }));
  if (findings?.unavailable) return { unavailable: true };
  const rank = (f) => SEVERITY_RANK[String(f?.severity || '').toLowerCase()] || 0;
  const finding = (Array.isArray(findings) ? findings : []).filter((f) => f?.title).sort((a, b) => rank(b) - rank(a))[0] || null;
  return {
    date: etCalendarDayOf(record.service_date),
    serviceType: clean(record.service_type, 60),
    summary: clean(finding?.title || record.technician_notes, 120),
    callback: Boolean(record.is_callback),
    // The instant "since the last visit" is measured from: the visit's
    // start when recorded, else ET midnight of its day. Stripped from the
    // model-safe facts by the loader.
    startedAt: record.started_at ? new Date(record.started_at) : parseETDateTime(`${etCalendarDayOf(record.service_date)}T00:00`),
  };
}

/**
 * Open service requests plus the last 90 days of complaints. Both reads fail
 * closed (503, like preferences): an URGENT open request is a safety-critical
 * fact the paragraph must carry, so a failed read must never render as
 * "nothing open". customer_interactions has no resolution state, so a
 * complaint is recent history — reported with its date, never as open.
 */
async function loadOpenIssues(dbh, customerId) {
  const [requests, complaints] = await Promise.all([
    dbh('service_requests')
      .where({ customer_id: customerId })
      .whereNotIn('status', OPEN_REQUEST_TERMINAL)
      // Urgent first: three newer routine requests must never push an
      // older urgent one past the cutoff.
      .orderByRaw("CASE WHEN urgency = 'urgent' THEN 0 ELSE 1 END")
      .orderBy('created_at', 'desc')
      .select('subject', 'category', 'urgency', 'created_at')
      .limit(3)
      .catch((err) => { throw unavailable('Open requests unavailable', err); }),
    dbh('customer_interactions')
      .where({ customer_id: customerId, interaction_type: 'complaint' })
      .where('created_at', '>', new Date(Date.now() - 90 * 86400000))
      .orderBy('created_at', 'desc')
      .select('subject', 'body', 'created_at')
      .limit(2)
      .catch((err) => { throw unavailable('Complaint history unavailable', err); }),
  ]);
  return {
    issues: requests.map((r) => ({ text: clean(r.subject || r.category, 80), urgent: r.urgency === 'urgent' })).filter((i) => i.text),
    recentComplaints: complaints.map((c) => ({ date: etDateString(c.created_at), text: clean(c.subject || c.body, 80) })).filter((c) => c.text),
  };
}

/**
 * Calls since the last visit, through the canonical reader
 * (context-aggregator.getRecentCalls): sandbox, spam, wrong-number, robocall
 * and vendor calls are excluded on every signal the processor persists
 * (source, processing_status, legacy extraction, validated V2 call_nature)
 * and summaries arrive code-redacted — a test call must never be rewritten
 * into the briefing. Its 60-day / 4-call window bounds the read. Null when
 * the lookup failed: the template says so instead of "no calls".
 */
async function loadCallsSince(customerId, sinceInstant, deps = {}) {
  const read = deps.getRecentCalls || ((id, opts) => contextAggregator.getRecentCalls(id, opts));
  const rows = await read(customerId, { sentinelOnError: true });
  if (!Array.isArray(rows)) return null;
  const since = sinceInstant ? new Date(sinceInstant).getTime() : 0;
  return rows
    .filter((r) => new Date(r.created_at).getTime() > since)
    .slice(0, 3)
    .map((r) => ({ summary: clean(r.call_summary, 140), direction: r.direction || null, date: etDateString(r.created_at) }));
}

/**
 * The visit's add-on lines (dispatch stores them per appointment). Fails
 * closed: a silently missing line would drop its products and precautions.
 */
async function loadAddons(dbh, serviceId) {
  const rows = await dbh('scheduled_service_addons as a')
    .leftJoin('services as s', 'a.service_id', 's.id')
    .where({ 'a.scheduled_service_id': serviceId })
    .orderBy('a.created_at', 'asc')
    .orderBy('a.id', 'asc')
    // Identity, not the display name: the category snapshot taken at booking,
    // else the live catalog row's category. No identity → no protocol.
    .select('a.service_name', dbh.raw('COALESCE(a.service_category_snapshot, s.category) as category'))
    .catch((err) => { throw unavailable('Add-on lines unavailable', err); });
  return rows.map((r) => ({ name: clean(r.service_name, 80), category: r.category || null })).filter((a) => a.name);
}

// Catalog category → treatment program. Inspection / specialty / other and
// an unknown category resolve no products: a name match is not proof that
// chemicals were booked (a "Pest Inspection Service" add-on is pest_control-
// adjacent by name and inspection by identity).
const ADDON_PROGRAM = Object.freeze({
  pest_control: 'pest', lawn_care: 'lawn', mosquito: 'mosquito', termite: 'termite', rodent: 'rodent', tree_shrub: 'tree_shrub',
});

/**
 * Everything the card needs about the visit, customer and property. Raw
 * access codes are returned under `access.codes` only.
 */
function unavailable(message, cause) {
  const err = new Error(message);
  err.statusCode = 503;
  err.isOperational = true;
  err.cause = cause;
  return err;
}

async function loadJobCardFacts(serviceId, dbh = db, deps = {}) {
  const svc = await dbh('scheduled_services as ss')
    .join('customers as c', 'ss.customer_id', 'c.id')
    .where('ss.id', serviceId)
    .select(
      'ss.id', 'ss.customer_id', 'ss.scheduled_date', 'ss.service_type', 'ss.status', 'ss.notes',
      'ss.job_card', 'ss.job_card_generated_at', 'ss.assigned_equipment_system_id', 'ss.assigned_calibration_id',
      'c.first_name', 'c.last_name', 'c.phone', 'c.lawn_water_area_id',
      // The booked property's pin: the visit's own lat/lng first; the
      // customer's primary pin only when the stamped address does not
      // diverge from it (dispatch's rule) — else no pin, office forecast.
      dbh.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.latitude END) as latitude`),
      dbh.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.longitude END) as longitude`),
      // The same predicate gates every property-bound preference below:
      // property_preferences is the primary home's row, so a visit stamped
      // elsewhere must not show that home's codes, entry, parking or
      // irrigation.
      dbh.raw(`(${stampedDivergesSql('ss', 'c')}) as address_diverges`),
      'c.waveguard_tier',
    )
    .first();
  if (!svc) return null;

  const serviceLine = detectServiceLine(svc.service_type);
  const [prefs, lastVisit, { issues, recentComplaints }, addons] = await Promise.all([
    // A failed preferences read is NOT an empty safety profile: the card
    // fails (503) rather than render without sensitivities, pet plan, codes.
    dbh('property_preferences').where({ customer_id: svc.customer_id }).first().catch((err) => { throw unavailable('Property preferences unavailable', err); }),
    loadLastVisit(dbh, svc.customer_id, serviceLine, etCalendarDayOf(svc.scheduled_date)),
    loadOpenIssues(dbh, svc.customer_id),
    loadAddons(dbh, svc.id),
  ]);
  const [calls, rain7d] = await Promise.all([
    loadCallsSince(svc.customer_id, lastVisit?.startedAt || null, deps),
    serviceLine === 'lawn' ? loadRain7d(dbh, svc) : Promise.resolve(null),
  ]);

  const alternateAddress = Boolean(svc.address_diverges);
  const propertyPrefs = alternateAddress ? null : prefs;
  // Every code on file is scrubbed from the grounding and checked in the
  // model output even when none is shown: a primary-home code pasted into a
  // visit note must not surface on an alternate-address card.
  const knownCodes = accessCodes(prefs);
  const codes = alternateAddress ? [] : knownCodes;
  const lastVisitFact = lastVisit ? (({ startedAt, ...rest }) => rest)(lastVisit) : null;
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
    addons,
    strip: { name, program, phone: clean(svc.phone, 24) || null },
    rig: rigAssignment(svc),
    access: { codes },
    knownCodes,
    // No pin (none stored, or the stamped address diverges from the primary
    // one) → no forecast at all: an office forecast would judge a property
    // elsewhere in the service area, and a verdict is acted on.
    coords: coords ? { ...coords, source: 'property' } : { lat: null, lng: null, source: 'none' },
    // Model-safe facts. Nothing below carries a code or a phone number:
    // keyword redaction in clean(), then the known code values themselves.
    facts: scrubKnownCodes({
      pets: petLine(prefs),
      petsSecured: clean(prefs?.pets_secured_plan, 80),
      gates: codes.map((c) => c.label),
      entry: clean(propertyPrefs?.access_notes || propertyPrefs?.side_gate_access, 120),
      parking: clean(propertyPrefs?.parking_notes, 80),
      alternateAddress,
      instructions: clean(prefs?.special_instructions, 120),
      contactPreference: prefs?.contact_preference || null,
      chemicalSensitivity: prefs?.chemical_sensitivities ? clean(prefs.chemical_sensitivity_details, 80) || 'yes' : '',
      awayUntil: awayUntil(prefs),
      visitNotes: clean(svc.notes, 140),
      lastVisit: lastVisitFact,
      issues,
      recentComplaints,
      calls,
      irrigation: serviceLine === 'lawn' ? wateringLine(propertyPrefs) : null,
      rain7d: alternateAddress ? null : rain7d,
    }, knownCodes),
    cache: { stored: parseJson(svc.job_card), generatedAt: svc.job_card_generated_at || null },
  };
}

// ── Paragraph ───────────────────────────────────────────────────────────────

/**
 * Deterministic 1–3 sentences from the facts, bounded to MAX_PARAGRAPH_WORDS
 * the same way the validator bounds model output: when populated records run
 * long, the lowest-value parts go first (drop rank, highest first; a part
 * with an `alt` shrinks to it before it goes). Pets, the pet plan, codes on
 * file, chemical sensitivity, away mode, urgent requests, the visit-history
 * line and the lawn irrigation line are never dropped — if those alone
 * exceed the limit the paragraph runs long rather than lose one. Used
 * verbatim when the model leg misses and as the grounding the model may
 * rephrase.
 */
function buildTemplateParagraph(facts, { isLawn = false } = {}) {
  const parts = [];
  const add = (s, text, drop = null, alt = null) => { if (text) parts.push({ s, text, drop, alt }); };

  if (facts.pets) add(1, `Pets: ${facts.pets}${facts.petsSecured ? ` (${facts.petsSecured})` : ''}`);
  else if (facts.petsSecured) add(1, `Pets secured: ${facts.petsSecured}`);
  if (facts.gates.length) add(1, `${facts.gates.join(' and ').toLowerCase()} code on file, tap to show`);
  if (facts.alternateAddress) add(1, 'visit at a non-primary address — the home\'s access details are not shown');
  add(1, facts.entry, 4);
  add(1, facts.parking, 9);
  if (facts.chemicalSensitivity) add(1, `chemical sensitivity${facts.chemicalSensitivity !== 'yes' ? `: ${facts.chemicalSensitivity}` : ''}`);
  if (facts.awayUntil) add(1, `customer away until ${facts.awayUntil}`);
  if (facts.contactPreference && facts.contactPreference !== 'text') add(1, `prefers ${facts.contactPreference}`);

  if (facts.lastVisit?.unavailable) {
    add(2, 'Visit history unavailable right now');
  } else if (facts.lastVisit) {
    const bare = `Last visit ${facts.lastVisit.date}${facts.lastVisit.callback ? ' (callback)' : ''}`;
    if (facts.lastVisit.summary) add(2, `Last visit ${facts.lastVisit.date}: ${facts.lastVisit.summary}${facts.lastVisit.callback ? ' (callback)' : ''}`, 5, bare);
    else add(2, bare);
  } else {
    add(2, 'First visit on record');
  }
  const issueText = (list) => `open: ${list.map((i) => `${i.urgent ? 'URGENT ' : ''}${i.text}`).join('; ')}`;
  const urgent = facts.issues.filter((i) => i.urgent);
  if (urgent.length === facts.issues.length) add(2, facts.issues.length ? issueText(facts.issues) : '');
  else add(2, issueText(facts.issues), 2, urgent.length ? issueText(urgent) : null);
  const complaints = facts.recentComplaints || [];
  if (complaints.length) add(2, `recent complaints: ${complaints.map((c) => `${c.date} ${c.text}`).join('; ')}`, 7);
  if (facts.calls === null) add(2, 'call history unavailable right now');
  else if (facts.calls.length) add(2, `called ${facts.calls[0].date}: ${facts.calls[0].summary}`, 8);
  if (facts.visitNotes) add(2, `note: ${facts.visitNotes}`, 6);
  add(2, facts.instructions, 3);

  if (isLawn) {
    add(3, facts.irrigation ? `Irrigation ${facts.irrigation}` : 'No irrigation on file — ask the customer');
    if (facts.rain7d != null) add(3, `${facts.rain7d}" rain in the last 7 days`, 1);
  }

  const sentence = (n) => {
    const texts = parts.filter((p) => p.s === n).map((p) => p.text);
    return texts.length ? `${texts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : '';
  };
  const render = () => [1, 2, 3].map(sentence).filter(Boolean).join(' ');
  let text = render();
  while (wordCount(text) > MAX_PARAGRAPH_WORDS) {
    const droppable = parts.filter((p) => p.drop != null);
    if (!droppable.length) break;
    const victim = droppable.reduce((a, b) => (b.drop > a.drop ? b : a));
    if (victim.alt) Object.assign(victim, { text: victim.alt, alt: null, drop: null });
    else parts.splice(parts.indexOf(victim), 1);
    text = render();
  }
  return text;
}

// The validator's own count (whitespace tokens of the trimmed text).
function wordCount(text) {
  const body = String(text || '').trim();
  return body ? body.split(/\s+/).length : 0;
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
function validateParagraph(text, grounding, codes = [], critical = []) {
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
  if (wordCount(body) > MAX_PARAGRAPH_WORDS) return 'too_long';
  const lower = body.toLowerCase();
  for (const { code } of codes) {
    if (code && lower.includes(String(code).toLowerCase())) return 'code_leak';
  }
  // Every numeric token must come from the grounding AND keep its clause:
  // a content word within three words of it in the output must sit within
  // three words of the same token in the grounding (a "20" moved from
  // "runs 20 min" to "20 dogs" is an invented fact, not a rephrase).
  if (numbersOutOfContext(body, grounding)) return 'ungrounded_number';
  // A rewrite that drops a safety-critical fact is not a rewrite.
  for (const fact of critical) {
    if (fact && !lower.includes(String(fact).toLowerCase())) return 'critical_fact_dropped';
  }
  return null;
}

/**
 * Facts the model may rephrase but never omit: chemical sensitivity, the
 * pet-securing plan, urgent open requests. Each must appear verbatim
 * (case-insensitive) in the accepted paragraph.
 */
function criticalFacts(facts) {
  const out = [];
  if (facts.chemicalSensitivity) out.push(facts.chemicalSensitivity === 'yes' ? 'sensitiv' : facts.chemicalSensitivity);
  if (facts.petsSecured) out.push(facts.petsSecured);
  for (const issue of facts.issues || []) if (issue.urgent && issue.text) out.push(issue.text);
  // Current away mode: the paragraph is the only place the card says it.
  if (facts.awayUntil) out.push(facts.awayUntil);
  // Pet presence: the only pet warning when no securing plan is recorded.
  if (facts.pets) out.push(facts.pets);
  return out;
}

const CONTEXT_STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'and', 'is', 'are', 'in', 'at', 'to', 'with', 'for', 'has', 'have', 'was', 'were', 'from', 'by', 'that', 'this', 'it', 'its', 'or', 'as', 'be', 'about', 'per', 'last', 'next']);
function contextWords(text) {
  return String(text || '').toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);
}
function neighbours(words, i) {
  return words.slice(Math.max(0, i - 3), i).concat(words.slice(i + 1, i + 4)).filter((w) => !/\d/.test(w) && !CONTEXT_STOPWORDS.has(w));
}
// Neighbours never cross a sentence: "20 dogs. Irrigation …" must not
// borrow "irrigation" from the next sentence.
function sentenceWords(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map(contextWords).filter((w) => w.length);
}
function numbersOutOfContext(body, grounding) {
  const src = sentenceWords(grounding);
  for (const out of sentenceWords(body)) {
    for (let i = 0; i < out.length; i += 1) {
      if (!/\d/.test(out[i])) continue;
      const mine = neighbours(out, i);
      let seen = false;
      let bound = false;
      for (const s of src) {
        for (let j = 0; j < s.length; j += 1) {
          if (s[j] !== out[i]) continue;
          seen = true;
          const theirs = neighbours(s, j);
          if (!mine.length || !theirs.length || mine.some((w) => theirs.includes(w))) bound = true;
        }
      }
      if (!seen || !bound) return true;
    }
  }
  return false;
}

function groundingHash(template) {
  return crypto.createHash('sha256').update(`${PROMPT_VERSION}|${template}`).digest('hex');
}

/**
 * Model-written paragraph over the template grounding. Returns
 * { text, source: 'model' | 'template' }. Never throws.
 */
async function writeParagraph(template, codes = [], deps = {}, critical = []) {
  const fallback = { text: template, source: 'template' };
  if (!template) return fallback;
  if (!deps.callModel && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return fallback;
  const validate = (result) => validateParagraph(result?.text, template, codes, critical);
  const callModel = deps.callModel
    || ((payload, opts) => dispatchWithFallback(MODELS.TEXT_POLICIES.jobCardParagraph, {
      laneId: 'job_card_paragraph',
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
    if (validateParagraph(resp.text, template, codes, critical)) return fallback;
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
  const written = await writeParagraph(template, facts.knownCodes || facts.access.codes, deps, criticalFacts(facts.facts));
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
    minTempF: num(product.min_temp_f),
    maxTempF: num(product.max_temp_f),
    maxWindMph: num(product.max_wind_mph),
    // rainfast_minutes is the canonical label interval (rain_free_hours is
    // the legacy column some rows still carry alone).
    rainFreeHours: num(product.rainfast_minutes) > 0 ? num(product.rainfast_minutes) / 60 : (num(product.rain_free_hours) > 0 ? num(product.rain_free_hours) : null),
  };
}

/**
 * Verdict per product over the next SPRAY_WINDOW_HOURS of NWS hourly
 * periods. `hold` when any hour in the window breaks a label limit;
 * `unknown` when the product carries no limits; `ok` otherwise. A missing
 * forecast makes every product `unknown` with reason `no_forecast`.
 */
// Null when nothing was measured — never a reassuring 0.
function maxOrNull(values) {
  const known = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  return known.length ? Math.max(...known) : null;
}

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
      windMph: maxOrNull(window.map((h) => h.windMph)),
      rainPct: maxOrNull(window.map((h) => h.rainChance)),
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
    const hasLimits = [limits.minTempF, limits.maxTempF, limits.maxWindMph, limits.rainFreeHours].some((v) => v != null);
    if (!hasLimits) return { productId: product.id, verdict: 'unknown', reason: 'No limit on file' };
    // The catalog contract: unverified label values are not judged against.
    if (!product.label_verified_at) return { productId: product.id, verdict: 'unknown', reason: 'Label limits not yet verified' };
    if (!window.length) return { productId: product.id, verdict: 'unknown', reason: 'No forecast' };
    const reasons = [];
    const missing = [];
    // A limit can only pass when EVERY hour it is judged over carries the
    // measurement; a null reading is "unknown", never a pass.
    // A known breach in any hour is a Hold even when another hour's reading
    // is missing; a limit only PASSES when every hour of the interval is
    // present and carries the measurement.
    const judge = ({ rows, hours, key, label, limit, floor, reason }) => {
      const breach = floor != null ? (v) => v < floor : (v) => v > limit;
      if (rows.some((h) => h[key] != null && breach(h[key]))) { reasons.push(reason); return; }
      if (!covers(rows, hours) || rows.some((h) => h[key] == null)) { if (!missing.includes(label)) missing.push(label); }
    };
    if (limits.minTempF != null) {
      judge({ rows: window, hours: SPRAY_WINDOW_HOURS, key: 'temperatureF', label: 'temperature', floor: limits.minTempF, reason: `under ${limits.minTempF}°F` });
    }
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
  'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rain_free_hours', 'signal_word', 'ppe_required', 'reentry_text',
  'customer_safety_summary', 'pet_kid_guidance_text', 'service_report_summary',
  'inventory_on_hand', 'inventory_unit', 'low_stock_threshold',
  'best_price_amount_cached', 'best_price_updated_at', 'label_verified_at',
];

// A failed catalog read is an outage (503), never an empty protocol: "no
// products matched" would hide every precaution and spray verdict.
async function loadCatalog(dbh = db) {
  const products = await dbh('products_catalog')
    .where(function activeOrUnknown() { this.where({ active: true }).orWhereNull('active'); })
    .select(PRODUCT_COLUMNS)
    .catch((err) => { throw unavailable('Product catalog unavailable', err); });
  if (!products.length) return [];
  // Alias-only protocol lines (EDDHA iron, organic acidifier …) resolve
  // through this table, so its outage is the catalog's outage.
  const aliases = await dbh('product_aliases')
    .whereIn('product_id', products.map((p) => p.id))
    .select('product_id', 'alias_name')
    .catch((err) => { throw unavailable('Product catalog unavailable', err); });
  const byProduct = aliases.reduce((acc, row) => {
    (acc[row.product_id] = acc[row.product_id] || []).push(row.alias_name);
    return acc;
  }, {});
  return products.map((p) => ({ ...p, aliases: byProduct[p.id] || [] }));
}

// The canonical pack per product: the active, verified mapping with the
// highest confidence, its pack_size (the package contents, "2.5 gal" —
// case_quantity is units per case, not contents). Null when the read failed
// (ordering is withheld — a 1-unit fallback would under-order a multi-unit
// pack); {} when nothing verified is mapped.
async function loadPackSizes(dbh, productIds) {
  if (!productIds.length) return {};
  const rows = await dbh('distributor_product_map')
    .whereIn('product_id', productIds)
    .where({ active: true, mapping_status: 'verified' })
    .whereNotNull('pack_size')
    .orderBy('mapping_confidence', 'desc')
    .orderBy('updated_at', 'desc')
    .select('product_id', 'pack_size')
    .catch(() => null);
  if (!rows) return null;
  return rows.reduce((acc, r) => { if (!acc[r.product_id] && r.pack_size) acc[r.product_id] = r.pack_size; return acc; }, {});
}

// The appointment's rig assignment (the Lawn plan's equipment pick).
function rigAssignment(svc) {
  return { equipmentSystemId: svc?.assigned_equipment_system_id || null, calibrationId: svc?.assigned_calibration_id || null };
}

// The plan engine's calibration resolution and validation (assigned rig
// first, one active rig otherwise, ambiguous / expired / not field
// verified = no mix) decide the tank; only the wording is the card's.
const TANK_BLOCK_REASON = {
  missing_calibration: 'No rig calibration on file',
  equipment_selection_required: 'More than one rig is active — assign the rig on the Lawn plan',
  expired_calibration: 'Rig calibration expired',
  calibration_not_field_verified: 'Rig calibration not field verified',
};

async function loadRigCalibrations(dbh, rig) {
  return getActiveCalibrations(dbh, { equipmentSystemId: rig?.equipmentSystemId || null, calibrationId: rig?.calibrationId || null });
}

// The instant a calibration must still be valid at: the later of now and
// noon ET on the service day.
function serviceDayInstant(serviceDate, now = new Date()) {
  const noon = serviceDate ? parseETDateTime(`${serviceDate}T12:00`) : null;
  return noon && noon.getTime() > now.getTime() ? noon : now;
}

function tankFromCalibrations(rows, now = new Date()) {
  const { selected: cal, blocks } = summarizeCalibration({ calibrations: Array.isArray(rows) ? rows : [], date: now });
  const block = blocks[0] || null;
  const carrier = Number(cal?.carrier_gal_per_1000 || 0);
  return {
    calibrated: !block && carrier > 0,
    reason: block ? (TANK_BLOCK_REASON[block.code] || block.message) : (carrier > 0 ? null : 'No carrier rate on file'),
    carrierGalPer1000: carrier > 0 ? carrier : null,
    tankCapacityGal: cal?.tank_capacity_gal != null ? Number(cal.tank_capacity_gal) : null,
    expiresAt: cal?.expires_at || null,
    systemName: cal?.system_name || null,
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
  // Four decimals: a 1-gal dose of a 0.113 oz/1,000 product at 2 gal/1,000
  // is 0.0565 oz, which two decimals would inflate by 6 %.
  return { amount: Math.round(amount * 10000) / 10000, unit: rateUnit || null, gallons: gal, coversSqft: Math.round((gal / carrier) * 1000), reason: null };
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
  // The product-specific pet / child guidance carries the actionable detail
  // (bait stations, keep pets off treated turf) the generic summary omits.
  const parts = [clean(product.customer_safety_summary, 160), clean(product.pet_kid_guidance_text, 160), clean(product.reentry_text, 100)].filter(Boolean);
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
const PLAN_UNAVAILABLE = { code: 'plan_unavailable', message: 'Lawn plan unavailable right now.' };
const APPROVALS_UNAVAILABLE = { code: 'approvals_unavailable', message: 'Approval checks unavailable right now.' };

/** { plan } or { plan: null, error } — a failed build is its own block. */
async function loadLawnPlan(serviceId, { dbh = db, deps = {}, now = new Date() } = {}) {
  try {
    // strict: the plan engine's own catalog read throws instead of reading
    // as an empty catalog, so an outage is a visible plan block, never
    // "no products matched".
    return { plan: await (deps.buildPlan || buildPlanForService)(serviceId, { db: dbh, now, strict: true }) };
  } catch (err) {
    logger.warn(`[job-card] plan unavailable for ${serviceId}: ${err.message}`);
    return { plan: null, error: err };
  }
}

function planBlocksOf({ plan }) {
  if (!plan) return [PLAN_UNAVAILABLE];
  return (plan.propertyGate?.blocks || []).map((b) => ({ code: b.code || null, message: clean(b.message, 200) })).filter((b) => b.message);
}

/**
 * The ordinance guard applied to ONE searched product: the property's
 * active N / P blackout windows with the plan engine's own predicates.
 * (Off-protocol, conditional, PGR, max-rate and rotation are the manager-
 * approval engine's — see mixForProduct.)
 */
function productBlocksUnderPlan({ plan }, product) {
  if (!plan) return [];
  const item = { product, raw: product.name || '' };
  const gate = plan.propertyGate || {};
  const blocks = [];
  for (const w of gate.activeOrdinanceWindows || []) {
    const where = w.jurisdictionName ? ` (${clean(w.jurisdictionName, 60)})` : '';
    if (w.restrictedNitrogen && itemHasNitrogen(item)) blocks.push({ code: 'nitrogen_blackout', message: `Nitrogen blackout is active${where} — this product carries nitrogen.` });
    if (w.restrictedPhosphorus && itemHasPhosphorus(item)) blocks.push({ code: 'phosphorus_blackout', message: `Phosphorus blackout is active${where} — this product carries phosphorus.` });
  }
  return blocks;
}

async function resolveVisitProducts({ facts, protocols, catalog, dbh = db, deps = {}, now = new Date() }) {
  if (facts.isLawn) {
    const loaded = await loadLawnPlan(facts.serviceId, { dbh, deps, now });
    const plan = loaded.plan;
    if (!plan) return { visit: null, lines: [], blocks: planBlocksOf(loaded) };
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
    // The plan's blocking conditions (ordinance blackout, calibration,
    // inventory, missing profile / area, PGR on stressed turf) ride along:
    // a blocked plan shows its products but no amounts.
    const blocks = planBlocksOf(loaded);
    return { visit: gate.month ? { month: gate.month, visit: gate.visit || null } : null, lines, blocks };
  }
  return { ...resolveProtocolLines(facts.serviceType, facts.scheduledDate, protocols, catalog), blocks: [] };
}

/**
 * One protocol service line (non-lawn) → its matched visit and product
 * lines. programKey (add-ons): the program is fixed by the add-on's catalog
 * identity; the matcher's rule-picked visit is used only when it agrees on
 * the program, so a display name can never swap the protocol.
 */
function resolveProtocolLines(serviceType, scheduledDate, protocols, catalog, { programKey = null } = {}) {
  const match = matchServiceProtocol(protocols, serviceType);
  const program = programKey ? (protocols?.[programKey] || null) : match?.program;
  const ruleVisit = !programKey || match?.programKey === programKey ? match?.matchedVisit : null;
  const visit = seasonalVisit(program, scheduledDate) || ruleVisit || program?.visits?.[0] || null;
  if (!visit) return { visit: null, lines: [] };
  const lines = linesFromLineMeta(visit, catalog);
  // Protocol visits without lineMeta (tree & shrub, termite …) name their
  // products in the text itself — the same parse + catalog match the plan
  // engine runs on lawn lines. Secondary lines are the visit's "if needed".
  for (const line of linesFromProtocolText(visit, catalog)) {
    if (!lines.some((l) => l.product.id === line.product.id)) lines.push(line);
  }
  return { visit, lines };
}

/**
 * The primary line plus every add-on line attached to the visit. Add-ons
 * resolve through the protocol path with their own seasonal pick; a product
 * already on the card from the primary line is not repeated. A lawn add-on
 * has no per-appointment plan of its own (the plan engine keys on the
 * appointment's service type), so it is reported, never dosed.
 */
async function resolveVisitLines({ facts, protocols, catalog, dbh = db, deps = {}, now = new Date() }) {
  const primary = await resolveVisitProducts({ facts, protocols, catalog, dbh, deps, now });
  const lines = [...primary.lines];
  const addons = [];
  for (const { name, category } of facts.addons || []) {
    const programKey = ADDON_PROGRAM[category] || null;
    if (!programKey) { addons.push({ name, products: 0, visit: null, note: `No treatment protocol for this add-on (${category || 'no catalog identity'})` }); continue; }
    if (programKey === 'lawn') { addons.push({ name, products: 0, visit: null, note: 'Lawn add-on — no plan for this line on the card' }); continue; }
    const resolved = resolveProtocolLines(name, facts.scheduledDate, protocols, catalog, { programKey });
    // Every add-on line rides through buildProductCards' per-product merger:
    // a product the primary lists as conditional and the add-on as selected
    // base work renders ONE card, and the selected line wins it.
    for (const line of resolved.lines) lines.push({ ...line, source: name });
    addons.push({
      name,
      products: resolved.lines.length,
      visit: resolved.visit ? { number: resolved.visit.visit || null, month: resolved.visit.month || null } : null,
      note: resolved.visit ? null : 'No protocol matched this add-on',
    });
  }
  return { ...primary, lines, addons };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * A month-keyed program (tree & shrub: visit 1 = Jan … 12 = Dec) resolves
 * by the appointment's ET month — the matcher's service-name fallback would
 * hand every recurring visit January's products. Programs whose visits are
 * "Any" (pest, termite …) return null and keep the matcher's pick.
 */
function seasonalVisit(program, scheduledDate) {
  const visits = program?.visits || [];
  const month = MONTHS[Number(String(scheduledDate || '').slice(5, 7)) - 1];
  if (!month || !visits.some((v) => MONTHS.includes(String(v?.month || '')))) return null;
  return visits.find((v) => v?.month === month) || null;
}

/**
 * De-branded lines carry their catalog product under lineMeta; the role
 * comes from where the line sits — a secondary line is the visit's
 * "if needed", never selected base work.
 */
function linesFromLineMeta(visit, catalog) {
  const secondary = String(visit?.secondary || '');
  const hints = new Map();
  for (const [raw, meta] of Object.entries(visit?.lineMeta || {})) {
    for (const hint of meta?.catalogProductHints || []) {
      if (!hints.has(hint)) hints.set(hint, raw);
    }
  }
  const lines = [];
  for (const [hint, raw] of hints) {
    const product = matchCatalogProduct({ raw: hint, catalogProductHints: [hint] }, catalog);
    if (!product || lines.some((l) => l.product.id === product.id)) continue;
    // Conditional when the line sits in the visit's secondary text OR is
    // phrased as a condition ("… if crawlers are present") — the parser's
    // own rule (parseProtocolLines), applied to lineMeta lines too.
    const conditional = Boolean(raw && (secondary.includes(raw) || /^if\b/i.test(raw) || /\bif\b/i.test(raw)));
    lines.push({ raw, product, role: conditional ? 'conditional' : 'base', selected: !conditional });
  }
  return lines;
}

function linesFromProtocolText(visit, catalog) {
  const parsed = [...parseProtocolLines(visit?.primary, 'base'), ...parseProtocolLines(visit?.secondary, 'conditional')];
  const out = [];
  for (const line of parsed) {
    const product = matchCatalogProduct(line, catalog);
    // The parser's own condition flag: a primary line phrased "if …"
    // (Distance IGR "if rotation calls for IRAC 7C") is conditional work,
    // never selected base work — the same rule the plan engine applies.
    const conditional = Boolean(line.conditional);
    if (product && !out.some((l) => l.product.id === product.id)) out.push({ raw: line.raw, product, role: conditional ? 'conditional' : 'base', selected: !conditional });
  }
  return out;
}

// Dosing values never ride in the descriptive line text: a rate shown there
// would survive every withhold (unverified, held, blocked). Rates come only
// from the resolved, permitted mix (`planned`).
const RATE_TOKEN_RE = /\b\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:%|(?:fl\.?\s?oz|oz|lbs?|pounds?|gal(?:lons?)?|ml|l|g|kg|pts?|qts?|tsp|tbsp|cc)\b\.?)(?:\s*(?:\/|per)\s*(?:\d[\d,]*\s*)?(?:sq\.?\s?ft|k|m|gal(?:lons?)?|acre|1,?000|100)\b)?/gi;
// Owner-only unit prices the protocol text carries ("($6.08)") never reach a
// technician's card either.
const PRICE_TOKEN_RE = /\(\s*\$\s*\d[\d.,]*\s*\)/g;
function describeLine(raw) {
  return String(raw || '')
    .replace(PRICE_TOKEN_RE, ' ')
    .replace(RATE_TOKEN_RE, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+\)/g, ')')
    .replace(/:\s*,/g, ':')
    .replace(/,\s*,/g, ',')
    .replace(/\s+([,;.)])/g, '$1')
    .replace(/[,;:]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function buildProductCards({ facts, lines, verdicts, packSizes, blocked = false, tankReason = null, includePricing = false, dbh = db }) {
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
    // The catalog contract holds on this path too: a rate whose label
    // provenance is unverified is not shown as an actionable amount.
    const unverified = line.planMix?.amount > 0 && !p.label_verified_at;
    // The plan validates the rig at noon on the service day; the card judges
    // it at the later of noon and now (tankFromCalibrations). A rig that
    // lapsed since noon withholds every planned amount here too, with the
    // Tank section's own reason.
    const demandMix = line.selected !== false && line.planMix?.amount > 0 ? line.planMix : null;
    // A spray-check Hold withholds the amount on the card exactly as it does
    // in the tank search — a held product is not dosed anywhere.
    const held = verdict.verdict === 'hold';
    const plannedMix = !blocked && !tankReason && !unverified && !held ? demandMix : null;
    // Unrounded: the client converts small doses to g / mL and rounds once.
    const planned = plannedMix ? { amount: Number(plannedMix.amount), unit: plannedMix.amountUnit || p.rate_unit || null } : null;
    // Unit-aware: the planned amount is in the application unit (fl oz),
    // stock in the inventory unit (gal) — the plan engine's snapshot owns
    // that conversion. Unconvertible pairs are not "short", they are flagged.
    // Demand is the plan's selected mix even while the display amount is
    // withheld: a stock block must not erase the shortage it is about.
    const inventory = buildProductInventorySnapshot(p, demandMix);
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
      line: [line.substitutedFor ? `Substitute for ${line.substitutedFor}` : null, line.source ? `${line.source}: ${describeLine(line.raw)}` : describeLine(line.raw), ...line.extraLines.map(describeLine)].map((r) => clean(r, 120)).filter(Boolean).join(' · '),
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
      planned,
      // The plan's requirement for the shortage line — never an actionable
      // dose (it survives every withhold so "On hand X vs Y" stays whole).
      demand: demandMix ? { amount: Number(demandMix.amount), unit: demandMix.amountUnit || p.rate_unit || null } : null,
      amountNote: unverified
        ? 'Label rate not yet verified — amount withheld'
        : (tankReason && demandMix ? `${tankReason} — amount withheld` : (held && demandMix ? `Spray check: ${verdict.reason} — amount withheld` : null)),
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
      order: packSizes ? orderFor(p, packSizes[p.id], short ? inventory.plannedAmountInventoryUnit - onHand : null, { includePricing }) : null,
    });
  }
  return cards;
}

/**
 * What "Order more" asks for, in the product's inventory unit: the visit's
 * shortage when there is one, else one distributor pack converted to that
 * unit, else a single unit. The cached best price is owner-only (the same
 * role line admin-inventory's technician projection draws): it is carried
 * only when the caller says the viewer may see pricing.
 */
function orderFor(product, packSize, shortage, { includePricing = false } = {}) {
  const unit = product.inventory_unit || product.rate_unit || null;
  let quantity = null;
  if (shortage > 0) quantity = Math.ceil(shortage * 100) / 100;
  else {
    const m = String(packSize || '').match(/(\d+(?:\.\d+)?)\s*([a-z_ ]+)/i);
    if (m && unit) {
      const packUnit = m[2].trim().toLowerCase().replace(/\s+/g, '_');
      quantity = packUnit === String(unit).toLowerCase() ? Number(m[1]) : convertInventoryQuantity(Number(m[1]), packUnit, unit);
      // A pack whose unit cannot be converted withholds ordering (quantity
      // null → button disabled) rather than requesting one unit of it.
      if (!(quantity > 0)) quantity = null;
    } else {
      quantity = 1;
    }
  }
  return {
    packSize: packSize || null,
    ...(includePricing ? { lastPrice: product.best_price_amount_cached != null ? Number(product.best_price_amount_cached) : null } : {}),
    unit,
    quantity,
  };
}

async function rotationNote(dbh, facts, product) {
  // MOA is a rotation group too (the approval engine's rule) — common
  // insecticides carry only that one.
  const group = ['frac', 'irac', 'hrac', 'moa'].find((g) => product[`${g}_group`]);
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

/**
 * The spray check is a same-day call: a visit on another day is judged on
 * that day (the next 4 h of weather say nothing about tomorrow). Shared by
 * the card and the tank search so both judge the same forecast.
 */
async function forecastAt({ coords, scheduledDate, now = new Date(), deps = {} }) {
  const isToday = scheduledDate === etDateString(now);
  const hourly = isToday && coords?.lat != null
    ? await (deps.getHourly || getHourlyRainOutlook)(coords.lat, coords.lng).catch(() => null)
    : null;
  return { isToday, hourly };
}

async function buildJobCard(serviceId, { dbh = db, deps = {}, now = new Date(), includePricing = false } = {}) {
  const facts = await loadJobCardFacts(serviceId, dbh, deps);
  if (!facts) return null;
  const protocols = deps.protocols || require('../config/protocols.json');

  // The rig must still be in calibration ON the service day.
  const serviceInstant = serviceDayInstant(facts.scheduledDate, now);
  const [paragraph, catalog, calibrations, { isToday, hourly }] = await Promise.all([
    paragraphForVisit(facts, { dbh, deps }),
    loadCatalog(dbh),
    loadRigCalibrations(dbh, facts.rig),
    forecastAt({ coords: facts.coords, scheduledDate: facts.scheduledDate, now, deps }),
  ]);
  const tank = tankFromCalibrations(calibrations, serviceInstant);
  const { visit, lines, blocks, addons } = await resolveVisitLines({ facts, protocols, catalog, dbh, deps, now });
  const products = lines.map((l) => l.product);
  const sprayCheck = buildSprayCheck({ products, hourly, now });
  const packSizes = await loadPackSizes(dbh, products.map((p) => p.id));
  const cards = await buildProductCards({ facts, lines, verdicts: sprayCheck.verdicts, packSizes, blocked: blocks.length > 0, tankReason: tank.calibrated ? null : tank.reason, includePricing, dbh });

  return {
    enabled: true,
    serviceId: facts.serviceId,
    customerId: facts.customerId,
    serviceLine: facts.serviceLine,
    strip: { ...facts.strip, access: facts.access },
    paragraph,
    sprayCheck: { ...sprayCheck, coordsSource: facts.coords.source, window: isToday ? 'today' : 'not_today' },
    tank,
    products: cards,
    planBlocks: blocks,
    visit: visit ? { number: visit.visit || null, month: visit.month || null } : null,
    addons,
  };
}

/**
 * Mix helper for the Tank section's product search: amount of one catalog
 * product for 110 or 1 gallons of water on the visit's rig (the
 * appointment's assigned equipment, else the one active rig).
 */
async function mixForProduct(productId, gallons, { serviceId, dbh = db, deps = {}, now = new Date(), includePricing = false } = {}) {
  const [product, svc] = await Promise.all([
    dbh('products_catalog').where({ id: productId }).where(function activeProducts() { this.where({ active: true }).orWhereNull('active'); }).select('id', 'name', 'category', 'application_method', 'analysis_n', 'analysis_p', 'analysis_k', 'default_rate_per_1000', 'rate_unit', 'default_rate', 'default_unit', 'inventory_on_hand', 'inventory_unit', 'best_price_amount_cached', 'label_verified_at', 'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rain_free_hours', 'rainfast_minutes').first().catch((err) => { throw unavailable('Product catalog unavailable', err); }),
    serviceId
      ? dbh('scheduled_services as ss')
        .join('customers as c', 'ss.customer_id', 'c.id')
        .where('ss.id', serviceId)
        .select(
          'ss.customer_id', 'ss.scheduled_date', 'ss.service_type', 'ss.assigned_equipment_system_id', 'ss.assigned_calibration_id',
          // The booked property's pin, by the card's own rule (see loadJobCardFacts).
          dbh.raw(`COALESCE(ss.lat, CASE WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.latitude END) as latitude`),
          dbh.raw(`COALESCE(ss.lng, CASE WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.longitude END) as longitude`),
        )
        .first()
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  // Fail closed: no visit row (missing id, unknown id, query failure) means
  // no rig assignment to trust, so no dose — never "any active rig".
  if (!product || !svc) return null;
  const tank = tankFromCalibrations(await loadRigCalibrations(dbh, rigAssignment(svc)), serviceDayInstant(etCalendarDayOf(svc.scheduled_date || now), now));
  // A product booked through a non-lawn add-on is judged under that add-on's
  // protocol, not the primary lawn plan (an off-protocol / blackout block of
  // the lawn plan says nothing about a pest or tree & shrub mix).
  const addonLine = await addonLineForProduct(dbh, serviceId, product, etCalendarDayOf(svc.scheduled_date || now), deps);
  // A lawn visit's plan governs the search too: its blocks withhold the dose
  // exactly as they withhold the card's amounts, and a product the plan
  // already resolved (substitution rate override, nutrient-target rate)
  // is dosed at the plan's rate, never the catalog default.
  const plan = !addonLine && detectServiceLine(svc.service_type) === 'lawn' ? await loadLawnPlan(serviceId, { dbh, deps, now }) : null;
  const planned = plan?.plan ? [...(plan.plan.mixCalculator?.items || []), ...(plan.plan.mixCalculator?.conditionalOptions || [])].find((i) => i.product?.id === product.id) : null;
  const ratePer1000 = planned?.mix?.ratePer1000 != null ? planned.mix.ratePer1000 : product.default_rate_per_1000;
  const rateUnit = planned?.mix?.rateUnit || product.rate_unit;
  // Pest / tree products whose label rate is per gallon of finished spray
  // (default_rate "X" or "X-Y" + default_unit "<unit>/gal") dilute straight
  // into the tank — no carrier calibration involved.
  const perGallon = ratePer1000 == null ? perGallonRate(product) : null;
  // Plan-wide blocks first; then THIS product through the same guards the
  // closeout applies (manager approvals: off-protocol, unselected
  // conditional, PGR on stressed turf, label max rate, rotation) plus the
  // ordinance blackout — the search is not a way around the plan.
  const planWide = plan ? planBlocksOf(plan) : [];
  const productBlocks = plan?.plan
    ? [
      ...productBlocksUnderPlan(plan, product),
      ...(await (deps.evaluateApprovals || evaluateWaveGuardManagerApprovals)(dbh, {
        customerId: svc.customer_id,
        service: svc,
        plan: plan.plan,
        products: [{ productId: product.id, name: product.name, rate: ratePer1000, rateUnit }],
        serviceDate: etCalendarDayOf(svc.scheduled_date || now),
        // strict: the engine's own reads (catalog, rotation, turf profile)
        // throw instead of reading as "nothing to block" — a failed safety
        // lookup withholds the dose.
        strict: true,
      }).catch((err) => { logger.warn(`[job-card] approval check failed: ${err.message}`); return { blocks: [APPROVALS_UNAVAILABLE] }; })).blocks.map((b) => ({ code: b.code || null, message: clean(b.message, 200) })),
    ]
    : [];
  const planBlocks = [...planWide, ...productBlocks];
  const tankMixable = isTankMixable(product);
  // The same spray check as a card product, at the same forecast.
  const coords = propertyCoords(svc.latitude, svc.longitude);
  const { isToday, hourly } = await forecastAt({ coords, scheduledDate: etCalendarDayOf(svc.scheduled_date || now), now, deps });
  const sprayVerdict = buildSprayCheck({ products: [product], hourly, now }).verdicts[0];
  const sprayCheck = !isToday
    ? { verdict: 'unknown', reason: 'Judged on the visit day' }
    : (!coords ? { verdict: 'unknown', reason: 'No property pin on file — no forecast' } : { verdict: sprayVerdict.verdict, reason: sprayVerdict.reason });
  // Withhold reasons in guard order — the first that applies wins; the
  // catalog contract (label_verified_at) and a spray Hold sit among them.
  const withheld = [
    [planWide.length > 0, 'Lawn plan blocked — amounts withheld'],
    [productBlocks.length > 0, clean(productBlocks[0]?.message, 160)],
    [!tankMixable, 'Not a tank mix — apply as labeled'],
    [!product.label_verified_at, 'Label rate not yet verified'],
    [sprayCheck.verdict === 'hold', `Spray check: ${sprayCheck.reason}`],
  ].find(([applies]) => applies);
  const mix = withheld
    ? { amount: null, unit: rateUnit || null, reason: withheld[1] }
    : (perGallon ? buildPerGallonAmount(perGallon, gallons) : buildMixAmount({ ratePer1000, rateUnit, carrierGalPer1000: tank.calibrated ? tank.carrierGalPer1000 : null, gallons }));
  const packSizes = await loadPackSizes(dbh, [product.id]);
  // The label rate is itself a dosing instruction: it rides only with a
  // permitted amount, never alongside a withheld one.
  const permitted = mix.amount != null;
  return {
    productId: product.id,
    name: product.name,
    ratePer1000: permitted && ratePer1000 != null ? Number(ratePer1000) : null,
    ratePerGallon: permitted ? perGallon : null,
    rateSource: planned ? 'plan' : 'catalog',
    rateVerified: Boolean(product.label_verified_at),
    tankMixable,
    sprayCheck,
    context: addonLine ? { line: addonLine } : { line: null },
    ...mix,
    planBlocks,
    tank,
    order: packSizes ? orderFor(product, packSizes[product.id], null, { includePricing }) : null,
  };
}

/**
 * The add-on (by catalog identity) whose treatment protocol names this
 * product, if any: the product is matched the way the card matched it
 * (name + aliases against that program's visit). Null when the product is
 * not an add-on line's, or the visit has no add-ons.
 */
async function addonLineForProduct(dbh, serviceId, product, scheduledDate, deps = {}) {
  const addons = await loadAddons(dbh, serviceId);
  const candidates = addons.filter((a) => ADDON_PROGRAM[a.category] && ADDON_PROGRAM[a.category] !== 'lawn');
  if (!candidates.length) return null;
  const aliases = await dbh('product_aliases').where({ product_id: product.id }).select('alias_name')
    .catch((err) => { throw unavailable('Product catalog unavailable', err); });
  const catalog = [{ ...product, aliases: aliases.map((r) => r.alias_name) }];
  const protocols = deps.protocols || require('../config/protocols.json');
  for (const addon of candidates) {
    const { lines } = resolveProtocolLines(addon.name, scheduledDate, protocols, catalog, { programKey: ADDON_PROGRAM[addon.category] });
    if (lines.some((l) => l.product.id === product.id)) return addon.name;
  }
  return null;
}

function perGallonRate(product) {
  const m = String(product.default_unit || '').trim().toLowerCase().match(/^([a-z_]+)\/gal$/);
  const r = String(product.default_rate || '').trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
  if (!m || !r) return null;
  const lo = Number(r[1]);
  const hi = r[2] != null ? Number(r[2]) : lo;
  if (!(lo > 0)) return null;
  return { lo, hi: hi > lo ? hi : lo, unit: m[1] };
}

function buildPerGallonAmount(rate, gallons) {
  const gal = Number(gallons);
  if (!TANK_GALLONS.includes(gal)) return { amount: null, unit: rate.unit, reason: 'Pick 110 or 1 gallons' };
  const round = (v) => Math.round(v * 10000) / 10000;
  return { amount: round(rate.lo * gal), amountMax: rate.hi > rate.lo ? round(rate.hi * gal) : null, unit: rate.unit, gallons: gal, basis: 'per_gallon', reason: null };
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
  tankFromCalibrations,
  resolveVisitProducts,
  resolveVisitLines,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  _test: { accessCodes, petLine, wateringLine, precautionText, groundingHash, propertyCoords, isTankMixable, scrubKnownCodes, loadLastVisit, loadOpenIssues, loadCallsSince, loadCatalog, criticalFacts, linesFromProtocolText, linesFromLineMeta, orderFor, perGallonRate, numbersOutOfContext, serviceDayInstant, seasonalVisit, buildProductCards, rotationNote, awayUntil, loadPackSizes, loadAddons, describeLine },
};
