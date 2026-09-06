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
const { reviewedWeather, checkReviewedWeatherSources } = require('./product-label-weather');
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
const { convertInventoryQuantity, normalizeInventoryUnit } = require('./inventory-units');
const { parsePackSize } = require('./product-costing');
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
// The known codes as one pattern: every non-empty stored value (the property
// API sets no minimum length) plus its bare alphanumeric form, so "4545#"
// on file also catches a note's "Try 4545 first". A short or bare form is
// matched as a whole token so "12" does not eat dates ("-12", "08.12").
// Case-insensitive: a code stored as BLUE pasted as blue is still the code.
function knownCodePattern(codes, flags = 'i') {
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bounded = (c) => `(?<![A-Za-z0-9.-])${esc(c)}(?![A-Za-z0-9.-])`;
  // Literal forms before bare forms: "1234+" must be eaten whole, not as
  // another code's bare "1234" leaving the "+".
  const literals = [];
  const bares = [];
  for (const code of codes.map((c) => String(c.code || '').trim()).filter(Boolean)) {
    literals.push(code.length < 4 ? bounded(code) : esc(code));
    const bare = code.replace(/[^A-Za-z0-9]/g, '');
    if (bare && bare !== code) bares.push(bounded(bare));
  }
  const parts = [...literals, ...bares];
  return parts.length ? new RegExp(parts.join('|'), flags) : null;
}
function scrubKnownCodes(value, codes) {
  const re = knownCodePattern(codes, 'gi');
  if (!re) return value;
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
// The booked property's pin, one source per pair: the visit's own lat/lng
// when BOTH are stored; else the customer's primary pair, only when the
// stamped address does not diverge from it (dispatch's rule) — else no
// pin, no forecast. Never one coordinate from each source (the arrival
// detector's rule): a hybrid point is a wrong location with a real verdict.
function visitPinSql(visitCol, customerCol) {
  return `CASE WHEN ss.lat IS NOT NULL AND ss.lng IS NOT NULL THEN ss.${visitCol} WHEN NOT ${stampedDivergesSql('ss', 'c')} THEN c.${customerCol} END`;
}
function propertyCoords(latRaw, lngRaw) {
  if (latRaw == null || latRaw === '' || lngRaw == null || lngRaw === '') return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

// The 7 days ending on the viewed visit's date (today at the latest): a
// historical card's grounding is that week's rain, not this week's.
async function loadRain7d(dbh, customer, serviceDate = null, deps = {}) {
  if (!customer?.lawn_water_area_id) return null;
  const today = etDateString(new Date());
  const until = serviceDate && serviceDate < today ? serviceDate : today;
  const since = etDateString(addETDays(parseETDateTime(`${until}T12:00`), -6));
  // The canonical reader: null unless every day of the window is on file,
  // so a missed sync day never reads as a dry week.
  return (deps.getAreaRainfall || getAreaRainfall)(customer.lawn_water_area_id, since, until, dbh);
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
// Calls between the previous visit and THIS visit's start: a historical
// card must not show later conversations as its pre-visit context.
async function loadCallsSince(customerId, sinceInstant, deps = {}, untilInstant = null) {
  const read = deps.getRecentCalls || ((id, opts) => contextAggregator.getRecentCalls(id, opts));
  const rows = await read(customerId, { sentinelOnError: true });
  if (!Array.isArray(rows)) return null;
  const since = sinceInstant ? new Date(sinceInstant).getTime() : 0;
  const until = untilInstant ? new Date(untilInstant).getTime() : Infinity;
  return rows
    .filter((r) => { const t = new Date(r.created_at).getTime(); return t > since && t < until; })
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
    // else the live catalog row's category. No identity → no protocol. The
    // service key (same rule) fixes the protocol visit where a matcher rule
    // claims it.
    .select('a.service_name', dbh.raw('COALESCE(a.service_category_snapshot, s.category) as category'), dbh.raw('COALESCE(a.service_key_snapshot, s.service_key) as service_key'))
    .catch((err) => { throw unavailable('Add-on lines unavailable', err); });
  return rows.map((r) => ({ name: clean(r.service_name, 80), category: r.category || null, serviceKey: r.service_key || null })).filter((a) => a.name);
}

// Catalog category → the treatment programs it may resolve to (the
// matcher's pick is honoured only inside `any`, else the category's
// `fallback`), so "Initial German Roach Knockdown" under pest_control
// resolves the cockroach program and "Quarterly Pest + Termite Bait
// Station" the termite-bait protocol (the matcher's deliberate composite
// pick — the tech needs the station steps), while "Pest Inspection
// Service" — inspection by identity, pest by name — resolves nothing. Specialty is a
// grab-bag (tick, wildlife, bee/wasp, the general appointment …) with no
// category default: its treatments are admitted by catalog identity
// (`keys`: fire ant, flea, tick → the pest program's matcher visit; the
// bed-bug treatment → its own program) or, for the bed-bug rows booked
// before the catalog link, by name. Inspection / other and an unknown
// category resolve no products. `nonChemical` service keys — the mechanical
// lawn services (core aeration, dethatching, plugging, top dressing) and
// the rodent rows whose catalog scope has no bait or rodenticide (trapping
// and its follow-ups, the trap-only retainers, exclusion / wire mesh / bird
// box, the trapping + exclusion + sanitation bundles, the paid inspection,
// the guarantee, sanitation) — are work without a chemical program: the
// catalog classifies them lawn_care / rodent, so the category alone would
// hand them the program's lines (rodent visit 2 mixes trap setup with
// Contrac Blox bait stations) and let the tank search dose any pesticide
// on them. The bait-station services keep the program.
const ADDON_PROGRAMS = Object.freeze({
  pest_control: { any: ['pest', 'cockroach', 'bed_bug', 'termite'], fallback: 'pest' },
  lawn_care: { any: ['lawn'], fallback: 'lawn', nonChemical: ['lawn_aeration', 'dethatching', 'plugging', 'top_dressing'] },
  mosquito: { any: ['mosquito'], fallback: 'mosquito' },
  termite: { any: ['termite'], fallback: 'termite' },
  rodent: {
    any: ['rodent'],
    fallback: 'rodent',
    nonChemical: [
      'rodent_sanitation_light', 'rodent_sanitation_medium', 'rodent_sanitation_standard', 'rodent_sanitation_heavy',
      'rodent_trapping', 'rodent_trapping_followup', 'rodent_trapping_followup_3pack',
      'trap_only_retainer_standard', 'trap_only_retainer_plus', 'trap_only_retainer_monthly',
      'rodent_exclusion_only', 'rodent_wire_mesh', 'rodent_bird_box',
      'rodent_trapping_exclusion', 'rodent_trapping_sanitation', 'rodent_trapping_exclusion_sanitation',
      'rodent_inspection', 'rodent_guarantee',
    ],
  },
  tree_shrub: { any: ['tree_shrub', 'palm_injection'], fallback: 'tree_shrub' },
  specialty: { any: ['bed_bug'], fallback: null, keys: { fire_ant: 'pest', flea_tick: 'pest', tick_control: 'pest', bed_bug_treatment: 'bed_bug' } },
});
function addonProgramKey(category, name, protocols, serviceKey = null) {
  const rule = ADDON_PROGRAMS[category];
  if (!rule) return null;
  if (serviceKey && rule.nonChemical?.includes(serviceKey)) return null;
  if (serviceKey && rule.keys?.[serviceKey]) return rule.keys[serviceKey];
  const picked = matchServiceProtocol(protocols, name, { serviceKey })?.programKey;
  return rule.any.includes(picked) ? picked : rule.fallback;
}

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
    .leftJoin('services as s', 'ss.service_id', 's.id')
    .where('ss.id', serviceId)
    .select(
      'ss.id', 'ss.customer_id', 'ss.scheduled_date', 'ss.service_type', 'ss.status', 'ss.notes',
      // The primary line's catalog identity (booking snapshot, else the live
      // row); null on legacy rows booked before the catalog link existed.
      dbh.raw('COALESCE(ss.service_category_snapshot, s.category) as service_category'),
      dbh.raw('COALESCE(ss.service_key_snapshot, s.service_key) as service_key'),
      'ss.job_card', 'ss.job_card_generated_at', 'ss.assigned_equipment_system_id', 'ss.assigned_calibration_id', 'ss.window_start',
      'c.first_name', 'c.last_name', 'c.phone', 'c.lawn_water_area_id',
      dbh.raw(`${visitPinSql('lat', 'latitude')} as latitude`),
      dbh.raw(`${visitPinSql('lng', 'longitude')} as longitude`),
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
    loadCallsSince(svc.customer_id, lastVisit?.startedAt || null, deps, svc.scheduled_date ? serviceStartInstant(etCalendarDayOf(svc.scheduled_date), svc.window_start) : null),
    serviceLine === 'lawn' ? loadRain7d(dbh, svc, etCalendarDayOf(svc.scheduled_date), deps) : Promise.resolve(null),
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
    serviceCategory: svc.service_category || null,
    serviceKey: svc.service_key || null,
    serviceLine,
    isLawn: serviceLine === 'lawn',
    addons,
    strip: { name, program, phone: clean(svc.phone, 24) || null },
    rig: rigAssignment(svc),
    windowStart: svc.window_start || null,
    access: { codes },
    // Display copies of the notes, complete and code-scrubbed: the facts
    // below are bounded for the model grounding and may lose a restriction
    // stated later in the text.
    notes: scrubKnownCodes({
      instructions: clean(propertyPrefs?.special_instructions, 2000) || null,
      visitNotes: clean(svc.notes, 2000) || null,
      chemicalSensitivity: propertyPrefs?.chemical_sensitivities ? (clean(propertyPrefs.chemical_sensitivity_details, 2000) || 'yes') : null,
      petsSecured: clean(propertyPrefs?.pets_secured_plan, 2000) || null,
    }, knownCodes),
    knownCodes,
    // No pin (none stored, or the stamped address diverges from the primary
    // one) → no forecast at all: an office forecast would judge a property
    // elsewhere in the service area, and a verdict is acted on.
    coords: coords ? { ...coords, source: 'property' } : { lat: null, lng: null, source: 'none' },
    // Model-safe facts. Nothing below carries a code or a phone number:
    // keyword redaction in clean(), then the known code values themselves.
    facts: scrubKnownCodes({
      // Pets are the primary home's too: unknown at an alternate address.
      pets: petLine(propertyPrefs),
      petsSecured: clean(propertyPrefs?.pets_secured_plan, 80),
      gates: codes.map((c) => c.label),
      entry: clean(propertyPrefs?.access_notes || propertyPrefs?.side_gate_access, 120),
      parking: clean(propertyPrefs?.parking_notes, 80),
      alternateAddress,
      instructions: clean(propertyPrefs?.special_instructions, 120),
      contactPreference: prefs?.contact_preference || null,
      // The sensitivity is the primary home's household's too (Codex r15):
      // unknown at an alternate address, said so in the paragraph.
      chemicalSensitivity: propertyPrefs?.chemical_sensitivities ? clean(propertyPrefs.chemical_sensitivity_details, 80) || 'yes' : '',
      awayUntil: awayUntil(propertyPrefs),
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
  if (facts.alternateAddress) add(1, 'visit at a non-primary address — the home\'s pets, sensitivities and access details are not shown');
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
const NEGATION_RE = /\b(?:no|not|never|none|nothing|without|free of)\b|n't\b/;

/**
 * Model output is accepted only when it is 1–3 sentences, ≤ 60 words, carries
 * no emoji, no bullet/heading markup, no code-looking token, every critical
 * fact, and every clause inside one grounding clause with its polarity.
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
  const codeRe = knownCodePattern(codes);
  if (codeRe && codeRe.test(body)) return 'code_leak';
  // A rewrite that drops a safety-critical fact is not a rewrite.
  if (critical.some((fact) => fact && !lower.includes(String(fact).toLowerCase()))) return 'critical_fact_dropped';
  // Clause by clause against the grounding (see clauseMismatch).
  return clauseMismatch(body, grounding);
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

const CONTEXT_STOPWORDS = new Set(['a', 'an', 'the', 'on', 'of', 'and', 'is', 'are', 'in', 'at', 'to', 'with', 'for', 'has', 'have', 'was', 'were', 'from', 'by', 'that', 'this', 'it', 'its', 'or', 'as', 'be', 'about', 'per', 'last', 'next', 'no', 'not', 'there', 'you', 'your', 'can', 'will', 'any', 'all', 'so', 'if', 'but', 'also', 'then', 'they', 'them', 'their', 'one',
  // Function words a rewrite adds freely; never a fact on their own.
  'over', 'under', 'here', 'into', 'onto', 'after', 'before', 'during', 'while', 'when', 'where', 'which', 'who', 'what', 'how', 'than', 'still', 'just', 'now', 'only', 'very', 'much', 'more', 'most', 'some', 'such', 'each', 'every', 'other', 'same', 'both', 'too', 'again', 'ever', 'already', 'yet', 'once', 'out', 'up', 'down', 'off', 'back', 'please', 'today', 'customer', 'we', 'our', 'he', 'she', 'his', 'her', 'i', 'my', 'do', 'does', 'did', 'done', 'been', 'being', 'am', 'may', 'might', 'should', 'would', 'could', 'must', 'shall',
  "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't", "hasn't", "haven't", "won't", "can't", "cannot"]);
// Loose stem so "dogs" grounds "dog" and "sprayed" grounds "spray".
const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w).slice(0, 6);
function contextWords(text) {
  // "Mon/Thu" is two words.
  return String(text || '').toLowerCase().split(/[\s/]+/).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);
}
// Clauses: the template's facts are comma / colon / dash separated inside
// one sentence, and "and" joins whole clauses — so that is the grain a
// rewrite is checked at. A parenthetical stays with its fact ("dog (crated
// in garage)" is one clause).
function clauses(text) {
  return String(text || '').split(/[,;:.!?]|\s[—–-]\s|\band\b/).map((c) => c.replace(/[()]/g, ' ').trim().toLowerCase()).filter(Boolean);
}
function contentStems(text) {
  return contextWords(text).filter((w) => !CONTEXT_STOPWORDS.has(w)).map(stem);
}
// Every rewritten clause must sit inside ONE grounding clause — all of its
// content words (numbers included), with the same polarity. Words from two
// facts recombined into one clause ("Dog at side gate" over "Pets: dog,
// side gate"), an invented word ("Dog secured."), a moved number ("20
// dogs") or a reversed instruction ("No side gate.") are not rephrases.
function clauseMismatch(body, grounding) {
  const src = clauses(grounding).map((c) => ({ negated: NEGATION_RE.test(c), stems: new Set(contentStems(c)) }));
  for (const c of clauses(body)) {
    const stems = contentStems(c);
    if (!stems.length) continue;
    const within = src.filter((g) => stems.every((w) => g.stems.has(w)));
    if (!within.length) return 'ungrounded_clause';
    const negated = NEGATION_RE.test(c);
    if (!within.some((g) => g.negated === negated)) return 'polarity_flip';
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
    // Knex error messages carry the SQL with its bindings — the paragraph
    // itself. Log the visit and the driver code only, never the message.
    .catch((err) => logger.warn(`[job-card] cache write skipped for ${facts.serviceId}: ${err.code || err.name || 'error'}`));
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

function buildSprayCheck({ products = [], hourly = null, now = new Date(), labelSources = {} } = {}) {
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
    const review = reviewedWeather(product, labelSources[product.id]);
    if (review && !review.verified) return { productId: product.id, verdict: 'unknown', reason: review.reason };
    const limits = review?.limits || productLimits(product);
    const hasLimits = [limits.minTempF, limits.maxTempF, limits.maxWindMph, limits.rainFreeHours].some((v) => v != null);
    if (!hasLimits) return { productId: product.id, verdict: 'unknown', reason: review?.unresolved ? 'Conditional label restrictions need review' : 'No limit on file' };
    // The catalog contract: unverified label values are not judged against.
    if (!review && !product.label_verified_at) return { productId: product.id, verdict: 'unknown', reason: 'Label limits not yet verified' };
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
    if (review?.unresolved) return { productId: product.id, verdict: 'unknown', reason: 'Conditional label restrictions need review' };
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
  'label_url', 'sds_url', 'epa_reg_number', 'manufacturer', 'formulation', 'label_weather_review',
  'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rain_free_hours', 'signal_word', 'ppe_text', 'ppe_required', 'reentry_text',
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

// The plan engine's calibration resolution (assigned rig first, one active
// rig otherwise, none / ambiguous = no mix) decides the tank; only the
// wording is the card's.
const TANK_BLOCK_REASON = {
  missing_calibration: 'No rig calibration on file',
  equipment_selection_required: 'More than one rig is active — assign the rig on the Lawn plan',
};

// null = the read failed: the tank says the check is unavailable rather
// than "no rig on file", which would send the tech to assign a rig for a
// data outage.
async function loadRigCalibrations(dbh, rig) {
  try {
    return await getActiveCalibrations(dbh, { equipmentSystemId: rig?.equipmentSystemId || null, calibrationId: rig?.calibrationId || null }, { strict: true });
  } catch (err) {
    logger.warn(`[job-card] calibration read failed: ${err.message}`);
    return null;
  }
}
const TANK_UNAVAILABLE = { calibrated: false, unavailable: true, reason: 'Rig calibration check unavailable', carrierGalPer1000: null, tankCapacityGal: null, expiresAt: null, systemName: null };

// The instant a calibration must still be valid at: the later of now and
// the appointment start — window_start on the service day, noon ET when no
// window is booked. The spray check is judged from it: a 3 pm stop opened
// at 8 am is checked against the 3 pm hours.
function serviceStartInstant(serviceDate, windowStart = null) {
  const wall = /^\d{2}:\d{2}/.exec(String(windowStart || ''));
  return serviceDate ? parseETDateTime(`${serviceDate}T${wall ? wall[0] : '12:00'}`) : null;
}
function serviceDayInstant(serviceDate, now = new Date(), windowStart = null) {
  const start = serviceStartInstant(serviceDate, windowStart);
  return start && start.getTime() > now.getTime() ? start : now;
}

// Calibration expiry / field verification no longer block (owner ruling,
// #3935): the engine's remaining blocks are no rig and an ambiguous rig.
function tankFromCalibrations(rows) {
  if (rows === null) return { ...TANK_UNAVAILABLE };
  const { selected: cal, blocks } = summarizeCalibration({ calibrations: Array.isArray(rows) ? rows : [] });
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
  // Label-derived PPE (ppe_text, the tech-tools reader's source) first; the
  // legacy ppe_required list only when no verified text exists.
  const ppe = parseJson(product.ppe_required);
  const ppeText = clean(product.ppe_text, 120) || (Array.isArray(ppe) ? ppe.map((p) => clean(p, 30)).filter(Boolean).join(', ') : clean(ppe, 80));
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

function planBlocksOf({ plan, blocks }) {
  if (blocks) return blocks;
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

// The lawn plan is built from the customer's singleton turf profile — the
// primary home's grass, area, assessments and nutrient history. A lawn
// visit stamped elsewhere gets no plan and no amounts.
const ALTERNATE_ADDRESS_BLOCK = { code: 'alternate_address', message: 'Visit is at a non-primary address — the lawn plan on file is the primary home\'s, amounts withheld' };

async function resolveVisitProducts({ facts, protocols, catalog, dbh = db, deps = {}, now = new Date() }) {
  // Identity gates the primary line before any branch — a catalog
  // inspection or assessment resolves no treatment products even when its
  // name reads as lawn or pest. A legacy row without identity keeps the
  // name-based classification.
  const identityKey = facts.serviceCategory ? addonProgramKey(facts.serviceCategory, facts.serviceType, protocols, facts.serviceKey) : undefined;
  if (identityKey === null) return { visit: null, lines: [], blocks: [], note: `No treatment protocol for this service (${facts.serviceCategory})` };
  const isLawn = identityKey === undefined ? facts.isLawn : identityKey === 'lawn';
  if (isLawn) {
    if (facts.facts?.alternateAddress) return { visit: null, lines: [], blocks: [ALTERNATE_ADDRESS_BLOCK] };
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
  return { ...resolveProtocolLines(facts.serviceType, facts.scheduledDate, protocols, catalog, { programKey: identityKey || null, serviceKey: facts.serviceKey || null }), blocks: [] };
}

/**
 * One protocol service line (non-lawn) → its matched visit and product
 * lines. programKey (add-ons): the program is fixed by the add-on's catalog
 * identity; the matcher's rule-picked visit is used only when it agrees on
 * the program, so a display name can never swap the protocol. serviceKey:
 * the booking's catalog service key — a matcher rule that claims it fixes
 * the visit regardless of the display name.
 */
function resolveProtocolLines(serviceType, scheduledDate, protocols, catalog, { programKey = null, serviceKey = null } = {}) {
  const match = matchServiceProtocol(protocols, serviceType, { serviceKey });
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
  for (const { name, category, serviceKey = null } of facts.addons || []) {
    const programKey = addonProgramKey(category, name, protocols, serviceKey);
    if (!programKey) { addons.push({ name, products: 0, visit: null, note: `No treatment protocol for this add-on (${category || 'no catalog identity'})` }); continue; }
    if (programKey === 'lawn') { addons.push({ name, products: 0, visit: null, note: 'Lawn add-on — no plan for this line on the card' }); continue; }
    const resolved = resolveProtocolLines(name, facts.scheduledDate, protocols, catalog, { programKey, serviceKey });
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
  const lines = [];
  // One line per (raw line, product): a product on two treatment lines
  // (Alpine WSG perimeter + interior) keeps both — buildProductCards folds
  // them onto one card as extraLines.
  for (const [raw, meta] of Object.entries(visit?.lineMeta || {})) {
    for (const hint of meta?.catalogProductHints || []) {
      const product = matchCatalogProduct({ raw: hint, catalogProductHints: [hint] }, catalog);
      if (!product || lines.some((l) => l.raw === raw && l.product.id === product.id)) continue;
      // Conditional when the line sits in the visit's secondary text OR is
      // phrased as a condition (isConditionalLine).
      const conditional = Boolean(raw && (secondary.includes(raw) || isConditionalLine(raw)));
      lines.push({ raw, product, role: conditional ? 'conditional' : 'base', selected: !conditional });
    }
  }
  return lines;
}

// A protocol line that hangs on a diagnosis or a judgement call — "if
// rotation calls for IRAC 7C", "only when plant/weather safe", "where
// root/oomycete risk is justified", "for labeled leaf spot", "premium
// accounts only", "where target pest fits", "for premium/stressed
// accounts", "for high-pH chlorosis" (an account tier or a diagnosis, not
// a target pest). Placement, legality and target phrasing ("where label
// allows", "where ordinance allows", "where pets rest", "for whitefly/scale
// nymphs") is how base work is described, not a condition on it.
const CONDITIONAL_LINE_RE = /\b(?:if|only|as needed|where (?:needed|appropriate|justified|[^,;()]*?\b(?:justif\w*|fits?|supports?|warrants?|exists?))|for (?:confirmed|documented|diagnosed|labell?ed|premium|stressed|high-?ph|chlorosis)|when [^,;()]*?\b(?:active|present|safe|justif\w*|fits?|supports?|warrants?))\b/i;
// The clauses of a line: "TriTek spray oil: 1.0% standard, 1.5% only with
// active scale/mites" is a standard portion and a conditional step-up.
function lineClauses(raw) {
  return String(raw || '').split(/[,;]/).map((c) => c.trim()).filter(Boolean);
}
function isConditionalLine(raw) {
  const text = String(raw || '');
  if (!CONDITIONAL_LINE_RE.test(text)) return false;
  // A line that declares a standard portion beside its condition is base
  // work — the condition gates the step-up, not the product.
  return !lineClauses(text).some((clause) => /\bstandard\b/i.test(clause) && !CONDITIONAL_LINE_RE.test(clause));
}

// The tank rate a protocol line states, as a per-gallon band in the
// catalog's unit vocabulary: "6-8 fl oz/100 gal", "0.1-0.2 fl oz/gal",
// "1-2 qt/100 gal", "1-2 tsp/gal", "1.0%" (v/v of the spray: 1 % = 1.28 fl
// oz/gal). Read from the line's unconditional clauses only (the standard
// rate, never the step-up), with parenthesised text dropped first (prices,
// "(Southern Ag 27.15%)"). Null when the line states no per-gallon rate —
// "label rate", a dry weight, a per-1,000 sq ft rate.
const LINE_RATE_RE = /(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*(%|(?:fl\.?\s?oz|oz|qts?|pts?|tsp|tbsp|ml)\b\.?)(\s*(?:\/|per)\s*(100\s*)?gal(?:lons?)?\b)?/i;
const FL_OZ_PER = { floz: 1, qt: 32, pt: 16, tbsp: 0.5, tsp: 1 / 6 };
function lineRate(raw) {
  const text = lineClauses(String(raw || '').replace(/\([^)]*\)/g, ' ')).filter((clause) => !CONDITIONAL_LINE_RE.test(clause)).join(', ');
  const m = LINE_RATE_RE.exec(text);
  if (!m) return null;
  const [, lo, hi, unitRaw, perGal, per100] = m;
  const unit = unitRaw.toLowerCase().replace(/[.\s]/g, '').replace(/s$/, '');
  if (unit !== '%' && !perGal) return null;
  const factor = unit === '%' ? 1.28 : (FL_OZ_PER[unit] ?? 1) / (per100 ? 100 : 1);
  const round = (v) => Math.round(v * 100000) / 100000;
  const a = round(Number(lo) * factor);
  const b = hi != null ? round(Number(hi) * factor) : a;
  if (!(a > 0)) return null;
  return { lo: a, hi: Math.max(a, b), unit: unit === '%' || unit in FL_OZ_PER ? 'fl_oz' : unit };
}

// A line may name more than one product ("Distance or Talus", "Iron Plus
// + Mn Combo", "8-2-12 palm fertilizer and 13-0-13 ornamental fertilizer"):
// the whole line first (its best match), then each " or " / " and " / " + "
// segment, one card per product. "/" does not split — it would hand tiny
// fragments ("Mg") to the reverse alias match.
const LINE_ALTERNATIVES = /\s+(?:or|and)\s+|\s\+\s/i;
// A segment's trailing words ("Mn Combo foliar") defeat the alias match, so
// each segment is probed by its leading words down to two — never one, a
// lone word would reverse-match inside many aliases.
function leadingProbes(text) {
  const words = text.split(/\s+/);
  const out = [];
  for (let n = words.length; n >= 2; n -= 1) out.push(words.slice(0, n).join(' '));
  return out;
}
function productsOnLine(line, catalog) {
  const segments = String(line.raw || '').split(LINE_ALTERNATIVES).map((t) => t.trim()).filter(Boolean);
  const found = [];
  const add = (raw) => {
    const product = matchCatalogProduct({ ...line, raw }, catalog);
    if (product && !found.some((f) => f.id === product.id)) found.push(product);
    return Boolean(product);
  };
  add(line.raw);
  if (segments.length > 1) {
    for (const segment of segments) leadingProbes(segment).some(add);
  }
  return found;
}
function linesFromProtocolText(visit, catalog) {
  const parsed = [...parseProtocolLines(visit?.primary, 'base'), ...parseProtocolLines(visit?.secondary, 'conditional')];
  const out = [];
  for (const line of parsed) {
    // The parser's own flag (secondary text, "if …") plus the wider
    // condition phrasing the protocols use: a primary line the tech has to
    // justify is conditional work, never selected base work.
    const conditional = Boolean(line.conditional) || isConditionalLine(line.raw);
    for (const product of productsOnLine(line, catalog)) {
      if (!out.some((l) => l.product.id === product.id)) out.push({ raw: line.raw, product, role: conditional ? 'conditional' : 'base', selected: !conditional });
    }
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
    // No usable rig (none on file, ambiguous) withholds every planned
    // amount here too, with the Tank section's own reason.
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
    if (packSize && unit) {
      // The distributor's pack string through the costing parser (fractions,
      // mixed numbers, multipacks: "1/2 gal", "4 x 30g tubes"), then into the
      // inventory unit; a count pack ("12 each") orders that count when the
      // stock is counted too. A pack it cannot read, or whose unit cannot be
      // converted, withholds ordering (quantity null → button disabled)
      // rather than requesting the wrong amount.
      const pack = parsePackSize(String(packSize).replace(/_/g, ' '));
      if (pack) quantity = convertInventoryQuantity(pack.amount, pack.unit, unit);
      else {
        const count = /^\s*(\d+(?:\.\d+)?)\s*(?:each|ea|ct|count)\b/i.exec(String(packSize));
        quantity = count && normalizeInventoryUnit(unit) === 'each' ? Number(count[1]) : null;
      }
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
    // strict: a failed history read must not read as "no history".
    const last = await latestComparableGroupApplication(dbh, facts.customerId, product, group, product[`${group}_group`], facts.scheduledDate, { strict: true });
    if (!last) return null;
    return `${group.toUpperCase()} ${product[`${group}_group`]} last used ${etCalendarDayOf(last.service_date)}${last.product_name && last.product_name !== product.name ? ` (${clean(last.product_name, 40)})` : ''}`;
  } catch {
    // Non-lawn cards have no strict plan pass to surface the outage, so the
    // card says it: the group may repeat and nobody checked.
    return `${group.toUpperCase()} ${product[`${group}_group`]} rotation check unavailable — verify before applying`;
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

  // The spray-check limits are judged from the appointment start.
  const serviceInstant = serviceDayInstant(facts.scheduledDate, now, facts.windowStart);
  const [paragraph, catalog, calibrations, { isToday, hourly }] = await Promise.all([
    paragraphForVisit(facts, { dbh, deps }),
    loadCatalog(dbh),
    loadRigCalibrations(dbh, facts.rig),
    forecastAt({ coords: facts.coords, scheduledDate: facts.scheduledDate, now, deps }),
  ]);
  const tank = tankFromCalibrations(calibrations);
  const { visit, lines, blocks, addons, note } = await resolveVisitLines({ facts, protocols, catalog, dbh, deps, now });
  const products = lines.map((l) => l.product);
  // Limits are judged from the appointment start (now once the window has
  // begun): a 3 pm stop opened at 8 am is checked against the 3 pm hours.
  const labelSources = await checkReviewedWeatherSources(products);
  const sprayCheck = buildSprayCheck({ products, hourly, now: serviceInstant, labelSources });
  const packSizes = await loadPackSizes(dbh, products.map((p) => p.id));
  const cards = await buildProductCards({ facts, lines, verdicts: sprayCheck.verdicts, packSizes, blocked: blocks.length > 0, tankReason: tank.calibrated ? null : tank.reason, includePricing, dbh });

  return {
    enabled: true,
    serviceId: facts.serviceId,
    customerId: facts.customerId,
    serviceLine: facts.serviceLine,
    strip: { ...facts.strip, access: facts.access },
    paragraph,
    // Shown complete under the paragraph: the 60-word budget may trim them
    // out of the template, the rewrite need not keep them, and the grounding
    // copies are bounded.
    notes: facts.notes,
    sprayCheck: { ...sprayCheck, coordsSource: facts.coords.source, window: isToday ? 'today' : 'not_today' },
    tank,
    products: cards,
    planBlocks: blocks,
    visit: visit ? { number: visit.visit || null, month: visit.month || null } : null,
    lineNote: note || null,
    addons,
  };
}

/**
 * Mix helper for the Tank section's product search: amount of one catalog
 * product for 110 or 1 gallons of water on the visit's rig (the
 * appointment's assigned equipment, else the one active rig).
 */
// A base line the lawn resolver left unselected — the losing BRANCH_ONE_OF
// fertilizer for the property's soil-P result, PREMIUM_ONLY on an ineligible
// plan — sits in neither mixCalculator list, and the approval engine treats
// every protocol.base item as planned. The search blocks it itself.
const UNSELECTED_BASE_REASONS = {
  mutually_exclusive_branch_not_selected: 'Not the fertilizer branch this property\'s plan selected — amount withheld',
  premium_or_drought_prep_not_selected: 'Premium-only line, not on this plan — amount withheld',
};
function unselectedBaseBlock(plan, product) {
  const item = (plan?.protocol?.base || []).find((i) => i.product?.id === product.id && i.selected === false);
  return item ? { code: 'base_not_selected', message: UNSELECTED_BASE_REASONS[item.selectionReason] || 'Not selected by this visit\'s plan — amount withheld' } : null;
}

async function mixForProduct(productId, gallons, { serviceId, dbh = db, deps = {}, now = new Date(), includePricing = false } = {}) {
  const [product, svc] = await Promise.all([
    dbh('products_catalog').where({ id: productId }).where(function activeProducts() { this.where({ active: true }).orWhereNull('active'); }).select('id', 'name', 'epa_reg_number', 'formulation', 'label_weather_review', 'category', 'application_method', 'analysis_n', 'analysis_p', 'analysis_k', 'default_rate_per_1000', 'rate_unit', 'default_rate', 'default_unit', 'inventory_on_hand', 'inventory_unit', 'best_price_amount_cached', 'label_verified_at', 'min_temp_f', 'max_temp_f', 'max_wind_mph', 'rain_free_hours', 'rainfast_minutes').first().catch((err) => { throw unavailable('Product catalog unavailable', err); }),
    serviceId
      ? dbh('scheduled_services as ss')
        .join('customers as c', 'ss.customer_id', 'c.id')
        .leftJoin('services as s', 'ss.service_id', 's.id')
        .where('ss.id', serviceId)
        .select(
          'ss.customer_id', 'ss.scheduled_date', 'ss.service_type', 'ss.assigned_equipment_system_id', 'ss.assigned_calibration_id', 'ss.window_start',
          // The primary line's catalog identity, by the card's own rule.
          dbh.raw('COALESCE(ss.service_category_snapshot, s.category) as service_category'),
          dbh.raw('COALESCE(ss.service_key_snapshot, s.service_key) as service_key'),
          // The booked property's pin, by the card's own one-source rule.
          dbh.raw(`${visitPinSql('lat', 'latitude')} as latitude`),
          dbh.raw(`${visitPinSql('lng', 'longitude')} as longitude`),
          dbh.raw(`(${stampedDivergesSql('ss', 'c')}) as address_diverges`),
        )
        .first()
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  // Fail closed: no visit row (missing id, unknown id, query failure) means
  // no rig assignment to trust, so no dose — never "any active rig".
  if (!product || !svc) return null;
  const tank = tankFromCalibrations(await loadRigCalibrations(dbh, rigAssignment(svc)));
  // The non-lawn protocol line (primary visit or add-on) that names this
  // product: an add-on's product is judged under that add-on's protocol,
  // not the primary lawn plan (an off-protocol / blackout block of the lawn
  // plan says nothing about a pest or tree & shrub mix), and a line the
  // protocol lists as "if needed" is withheld exactly as the card does.
  const { line: addonLine, treatment, primaryIsLawn, lawnAddon } = await protocolLineForProduct(dbh, serviceId, svc, product, etCalendarDayOf(svc.scheduled_date || now), deps);
  // A lawn visit's plan governs the search too: its blocks withhold the dose
  // exactly as they withhold the card's amounts, and a product the plan
  // already resolved (substitution rate override, nutrient-target rate)
  // is dosed at the plan's rate, never the catalog default.
  // Same rule as the card: no plan at a non-primary address.
  const lawnPlan = primaryIsLawn ? (svc.address_diverges ? { plan: null, blocks: [ALTERNATE_ADDRESS_BLOCK] } : await loadLawnPlan(serviceId, { dbh, deps, now })) : null;
  const planned = lawnPlan?.plan ? [...(lawnPlan.plan.mixCalculator?.items || []), ...(lawnPlan.plan.mixCalculator?.conditionalOptions || [])].find((i) => i.product?.id === product.id) : null;
  // The lawn plan governs every product it names (rate, blocks, approvals)
  // even when a non-lawn add-on's line names it too — Iron Plus on a lawn
  // plan with a Tree & Shrub add-on doses at the plan's rate, as the card
  // shows it, and the add-on's "if needed" never withholds a plan-selected
  // product. An add-on line governs only a product the plan does not name,
  // and then the plan's blocks say nothing about that mix. A plan that
  // failed to load names nothing knowably: it keeps governing (its
  // plan_unavailable block, no dose). An alternate-address visit is not an
  // outage — its plan is known not to apply — so the add-on line governs.
  const protocolLine = planned || lawnPlan?.error ? null : addonLine;
  const plan = protocolLine ? null : lawnPlan;
  const ratePer1000 = planned?.mix?.ratePer1000 != null ? planned.mix.ratePer1000 : product.default_rate_per_1000;
  const rateUnit = planned?.mix?.rateUnit || product.rate_unit;
  // Pest / tree products whose label rate is per gallon of finished spray
  // (default_rate "X" or "X-Y" + default_unit "<unit>/gal") dilute straight
  // into the tank — no carrier calibration involved.
  const labelPerGallon = ratePer1000 == null ? perGallonRate(product) : null;
  // The matched protocol line's own band narrows the verified label band —
  // recognising the line can never widen the dose (March Tree & Shrub's
  // Distance IGR: 6-8 fl oz/100 gal on the protocol, 0.06-0.12 fl oz/gal on
  // the label → 0.06-0.08). A band outside the label, or on another unit,
  // leaves the label band standing.
  const protocolPerGallon = labelPerGallon && protocolLine?.rate ? narrowBand(labelPerGallon, protocolLine.rate) : null;
  const perGallon = protocolPerGallon || labelPerGallon;
  // Plan-wide blocks first; then THIS product through the same guards the
  // closeout applies (manager approvals: off-protocol, unselected
  // conditional, PGR on stressed turf, label max rate, rotation) plus the
  // ordinance blackout — the search is not a way around the plan.
  const planWide = plan ? planBlocksOf(plan) : [];
  const unselectedBase = planned ? null : unselectedBaseBlock(plan?.plan, product);
  const productBlocks = plan?.plan
    ? [
      ...(unselectedBase ? [unselectedBase] : []),
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
  // Limits are judged from the appointment start, as on the card.
  let sprayCheck;
  if (!isToday) {
    sprayCheck = { verdict: 'unknown', reason: 'Judged on the visit day' };
  } else if (!coords) {
    sprayCheck = { verdict: 'unknown', reason: 'No property pin on file — no forecast' };
  } else {
    const labelSources = await checkReviewedWeatherSources([product]);
    const sprayVerdict = buildSprayCheck({ products: [product], hourly, labelSources, now: serviceDayInstant(etCalendarDayOf(svc.scheduled_date || now), now, svc.window_start) }).verdicts[0];
    sprayCheck = { verdict: sprayVerdict.verdict, reason: sprayVerdict.reason };
  }
  // Withhold reasons in guard order — the first that applies wins; the
  // catalog contract (label_verified_at) and a spray Hold sit among them.
  const withheld = [
    // The visit's catalog identity is not a treatment (inspection,
    // assessment, the specialty grab-bag) and no booked add-on's protocol
    // names the product: the search is not a way to dose on an inspection.
    [!treatment && !protocolLine, `No treatment protocol for this visit (${svc.service_category})`],
    // A booked lawn add-on has no plan on this visit: a product no primary /
    // add-on protocol names is not dosed off the catalog past the lawn
    // plan's turf, ordinance, stress and approval guards.
    [!protocolLine && !primaryIsLawn && Boolean(lawnAddon), `${lawnAddon} has no plan on this visit — amount withheld`],
    [planWide.length > 0, 'Lawn plan blocked — amounts withheld'],
    [productBlocks.length > 0, clean(productBlocks[0]?.message, 160)],
    // The protocol lists this product as "if needed": no dose until the
    // call is made, exactly as the card withholds its amount.
    [protocolLine?.selected === false, `Listed as "if needed" on ${protocolLine?.addon || "this visit's protocol"} — confirm the call before mixing`],
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
    rateSource: planned ? 'plan' : (protocolPerGallon ? 'protocol' : 'catalog'),
    rateVerified: Boolean(product.label_verified_at),
    tankMixable,
    sprayCheck,
    context: protocolLine ? { line: protocolLine.addon, conditional: !protocolLine.selected } : { line: null },
    ...mix,
    planBlocks,
    tank,
    order: packSizes ? orderFor(product, packSizes[product.id], null, { includePricing }) : null,
  };
}

/**
 * The non-lawn protocol line that names this product — the primary visit's
 * (by catalog identity, name for a legacy row: resolveVisitProducts' rule)
 * or an add-on's — if any. The product is matched the way the card matched
 * it (the full catalog against that program's visit, then the id); `addon` is the add-on's
 * name (null for the primary line) and `selected` says whether the line is
 * booked work or the visit's "if needed" (a selected line anywhere wins
 * over a conditional one) and `rate` the line's own per-gallon band when it
 * states one; `line` is null when no non-lawn protocol names the product. `treatment` is the primary line's own eligibility (false
 * for an inspection / assessment / specialty grab-bag identity) and
 * `primaryIsLawn` whether the lawn plan governs it; `lawnAddon` names a
 * booked lawn add-on, which has no plan on this visit.
 */
async function protocolLineForProduct(dbh, serviceId, svc, product, scheduledDate, deps = {}) {
  const protocols = deps.protocols || require('../config/protocols.json');
  const primaryKey = svc.service_category ? addonProgramKey(svc.service_category, svc.service_type, protocols, svc.service_key) : undefined;
  const treatment = primaryKey !== null;
  const primaryIsLawn = treatment && (primaryKey === undefined ? detectServiceLine(svc.service_type) === 'lawn' : primaryKey === 'lawn');
  const addons = (await loadAddons(dbh, serviceId))
    .map((a) => ({ addon: a.name, name: a.name, programKey: addonProgramKey(a.category, a.name, protocols, a.serviceKey), serviceKey: a.serviceKey }));
  // A lawn add-on has no plan of its own on this visit (the plan engine keys
  // on the appointment's service type) — the search must not dose lawn
  // products off the catalog past the plan's guards.
  const lawnAddon = addons.find((a) => a.programKey === 'lawn')?.addon || null;
  const found = (line) => ({ line, treatment, primaryIsLawn, lawnAddon });
  const candidates = [
    ...(primaryKey !== null && !primaryIsLawn ? [{ addon: null, name: svc.service_type, programKey: primaryKey || null, serviceKey: svc.service_key || null }] : []),
    ...addons.filter((a) => a.programKey && a.programKey !== 'lawn'),
  ];
  if (!candidates.length) return found(null);
  // The lines resolve against the full catalog, exactly as on the card: a
  // one-product catalog would let a reverse-alias / first-two-word match
  // accept the wrong formulation ("Headway G" for Headway) and skip the
  // lawn plan on that false line.
  const catalog = await loadCatalog(dbh);
  let conditional = null;
  for (const c of candidates) {
    const { lines } = resolveProtocolLines(c.name, scheduledDate, protocols, catalog, { programKey: c.programKey || null, serviceKey: c.serviceKey || null });
    const hit = lines.find((l) => l.product.id === product.id);
    if (!hit) continue;
    if (hit.selected !== false) return found({ addon: c.addon, selected: true, rate: lineRate(hit.raw) });
    conditional = conditional || { addon: c.addon, selected: false, rate: null };
  }
  return found(conditional);
}

// The protocol band clipped to the verified label band, on one unit.
function narrowBand(label, line) {
  if (String(label.unit).toLowerCase() !== String(line.unit).toLowerCase()) return null;
  const lo = Math.max(label.lo, line.lo);
  const hi = Math.min(label.hi, line.hi);
  return lo <= hi ? { lo, hi, unit: label.unit } : null;
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
  _test: { accessCodes, petLine, loadRain7d, wateringLine, precautionText, groundingHash, propertyCoords, isTankMixable, scrubKnownCodes, loadLastVisit, loadOpenIssues, loadCallsSince, loadCatalog, criticalFacts, linesFromProtocolText, linesFromLineMeta, isConditionalLine, lineRate, orderFor, perGallonRate, clauseMismatch, serviceDayInstant, seasonalVisit, buildProductCards, rotationNote, awayUntil, loadPackSizes, loadAddons, describeLine, visitPinSql, loadRigCalibrations, tankFromCalibrations },
};
