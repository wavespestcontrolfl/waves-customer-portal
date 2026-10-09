/**
 * Rain fit for booking (owner 2026-10-06, GATE_BOOKING_RAIN_RANK, dark).
 *
 * Outdoor visits (pest exterior, lawn, tree & shrub, mosquito, termite
 * treatment) avoid wet hours; rain-OK visits (WaveGuard assessments and
 * estimates, WDO / termite inspections, rodent and trapping checks,
 * interior-only pest) are steered INTO wet hours, which keeps the dry hours
 * for spray work.
 *
 * "Wet" = the NWS hourly chance of rain is RAIN_PCT or more in any hour from
 * the visit's start through RAIN_AFTER_HOURS after its end (product needs
 * time to dry). Only the next RAIN_DAYS dates count: Florida hourly
 * forecasts past ~3 days are too weak to move a booking.
 *
 * Which services are rain-OK: a service with a catalog identity is rain-OK
 * only when its exact catalog key is on RAIN_OK_KEYS; any other identity is
 * outdoor. The word rules below are only the fallback for a service with no
 * catalog identity (owner 2026-10-08: ten Codex rounds on #6102 each found
 * another name the words sorted wrong).
 *
 * bookingRainFit reads the gate; withCatalogKeys reads the catalog.
 */
const logger = require('../logger');
const RAIN_PCT = 60;
const RAIN_AFTER_HOURS = 2;
const RAIN_DAYS = 3;

// ── Word rules: the fallback for a service with no catalog key ──────────
const RAIN_OK = /assess|estimate|inspect|\bwdo\b|wood[- ]?destroy|interior/i;
// Rodent work is rain-OK only as a check: trap checks, monitoring, an
// inspection. Exclusion and remediation (wire mesh, sealing) are outdoor
// jobs (Codex #6102 r2).
const RODENT = /rodent|\brats?\b|\bmice\b|\bmouse\b|trap/i;
const RODENT_CHECK = /check|monitor|inspect/i;
// Words that put a service outside whatever else it says. "Accepted
// estimate" is the placeholder line for a sold quote whose work is unknown
// (admin-customers scheduleLinesFromEstimate): treatment work, not an
// estimate visit (Codex #6102 r4). Treatment words win over an inspection
// word: "Termite Inspection & Spot Treatment" applies product (r8).
const OUTDOOR = /exterior|exclu|mesh|seal|remediat|accepted|treat|liquid|spot|applicat|spray|fumigat|foam/i;

// Interior-only lanes whose catalog names say "treatment" without saying
// "interior" (trace-eligibility.js: bed_bug, german_roach_knockdown,
// Codex #6102 r9). Checked before the treatment words; "exterior" still wins.
const INDOOR_TREATMENT = /bed ?bugs?|german (cock)?roach/i;

function rainOkService(name) {
  if (/exterior/i.test(name)) return false;
  if (INDOOR_TREATMENT.test(name)) return true;
  if (OUTDOOR.test(name)) return false;
  if (RAIN_OK.test(name)) return true;
  return RODENT.test(name) && RODENT_CHECK.test(name);
}

// The complete rain-OK list, by exact catalog key. A lane of the spray-trace
// registry is too coarse for this: its trap lane holds trap checks AND the
// first trap setup, its bait-station lane holds the station check AND the
// install, and a catch-all rodent service reuses the inspection form (Codex
// #6120 r1-r3). So a service is rain-OK only when its own key is here:
// nothing is applied outside and the work does not need dry weather. A test
// checks that none of these keys is a spray lane in the registry.
const RAIN_OK_KEYS = new Set([
  // assessments and inspections
  'waves_assessment', 'waves_assessment_plus', 'new_customer_inspection',
  'wdo_inspection', 'termite_inspection', 'pest_inspection', 'rodent_inspection', 'lawn_inspection',
  // interior-only treatment
  'bed_bug_treatment', 'german_roach', 'german_roach_initial', 'vehicle_german_roach',
  // rodent checks and attic work (not trap setup, exclusion or station install)
  'rodent_bait_quarterly', 'rodent_monitoring',
  'rodent_trapping_followup', 'rodent_trapping_followup_3pack', 'rodent_trap_check_additional',
  'rodent_sanitation_light', 'rodent_sanitation_standard', 'rodent_sanitation_medium', 'rodent_sanitation_heavy',
]);
// Not a visit's work at all: a billing rider (the registry's lane), or the
// generic appointment whose work is unknown. Left out of the booking's
// verdict. waveguard_initial_setup shares the appointment lane and is an
// onboarding visit with initial treatments, so only this one key is skipped
// (Codex #6120 r2).
const SKIP_KEYS = new Set(['general_appointment']);

// 'ok' | 'outdoor' | 'skip' for one service: { name, serviceKey,
// findingsType } or a bare name. A service with a catalog identity that is
// not on the list is outdoor — every spray lane, setup, install, exclusion,
// and any key added later: an unlisted service keeps a dry hour. Only a
// service with no catalog identity at all takes the word rules.
function rainClassOf(service) {
  const name = String((service && service.name) ?? service ?? '').trim();
  const serviceKey = (service && service.serviceKey) || null;
  const findingsType = (service && service.findingsType) || null;
  if (!serviceKey && !findingsType) return rainOkService(name) ? 'ok' : 'outdoor';
  if (RAIN_OK_KEYS.has(serviceKey)) return 'ok';
  if (SKIP_KEYS.has(serviceKey)) return 'skip';
  const { resolveTraceEligibility } = require('../service-report/trace-eligibility');
  return resolveTraceEligibility({ serviceKey, findingsType }).reason === 'billing_rider' ? 'skip' : 'outdoor';
}

// A booking is rain-OK only when EVERY service in it is: one outdoor
// service in the booking means work happens outside.
function rainFitFor(serviceTypes) {
  const classes = (Array.isArray(serviceTypes) ? serviceTypes : [serviceTypes])
    .filter((s) => String((s && s.name) ?? s ?? '').trim())
    .map(rainClassOf)
    .filter((c) => c !== 'skip');
  if (!classes.length) return 'neutral';
  return classes.every((c) => c === 'ok') ? 'prefer' : 'avoid';
}

// A booking holds a handful of services; anything past this is not a
// booking, and each entry costs catalog reads (Codex #6120 r1).
const MAX_BOOKING_SERVICES = 12;
const KEY_SHAPE = /^[a-z0-9_]{1,80}$/;
// Stands for every service past the cap: an identity no list knows, so outdoor.
const OVERFLOW_SERVICE = Object.freeze({ name: 'More services', serviceKey: 'booking_services_over_cap', findingsType: null });

// The booking's services with their stable identity, for rainFitFor: the
// catalog key and findings type the completion-profile resolver gives a
// visit. `items` are names or { name, serviceKey }; a key the screen sent
// (the selected catalog row) settles the identity ahead of the name, which
// is not unique in the catalog. Only while the caller's gate is on (the
// picker's by default); read one at a
// time; an entry that cannot be resolved (or a failed read) keeps its name
// and takes the word rules.
async function withCatalogKeys(items, db, { gate = 'GATE_BOOKING_RAIN_RANK' } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => ({ name: String((item && item.name) ?? item ?? '').trim(), serviceKey: (item && item.serviceKey) || null }))
    .filter((item) => item.name);
  const { gateEnvValue } = require('../../config/feature-gates');
  if (!list.length || !gateEnvValue(gate)) return list.map((item) => item.name);
  const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
  const out = [];
  for (const { name, serviceKey } of list) {
    try {
      const profile = await resolveCompletionProfileForScheduledService(
        { service_type: name, service_key_snapshot: serviceKey || undefined }, db,
      );
      out.push({ name, serviceKey: profile?.serviceKey || null, findingsType: profile?.findingsType || null });
    } catch (err) {
      logger.warn(`[rain-fit] service identity lookup failed (word rules used): ${err.message}`);
      out.push(name);
    }
  }
  return out;
}

// What an existing visit books, from its rows: { own, siblings }, each a
// list of { name, key }. `siblings` are the other live services on a shared
// stop (empty when the move takes this service alone), add-ons included.
// `span` is where those other services sit against this one's start, in
// minutes ({ startOffset <= 0, endOffset }): the stop moves as one, each
// service keeping its own window, so rain counts across all of them. null
// without siblings or without a readable window.
// null when the visit cannot be read: the caller keeps what the screen sent.
async function storedVisitServices(serviceId, { moveAlone = false } = {}, db) {
  try {
    const row = await db('scheduled_services').where({ id: serviceId })
      .first('id', 'service_type', 'service_key_snapshot', 'visit_id', 'window_start');
    if (!row) return null;
    const { TERMINAL_ROW_STATUSES } = require('../visit-context/statuses');
    const others = row.visit_id && !moveAlone
      ? await db('scheduled_services').where({ visit_id: row.visit_id }).whereNot('id', row.id)
        // A NULL status is a live row (rebooker.js, visit-groups.js); a bare
        // NOT IN would drop it.
        .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_ROW_STATUSES))
        .select('id', 'service_type', 'service_key_snapshot', 'window_start', 'window_end')
      : [];
    const addOns = await db('scheduled_service_addons')
      .whereIn('scheduled_service_id', [row.id, ...others.map((o) => o.id)])
      .select('scheduled_service_id', 'service_name', 'service_key_snapshot');
    const item = (name, key) => ({ name, key: key || '' });
    const withAddOns = (r) => [
      item(r.service_type, r.service_key_snapshot),
      ...addOns.filter((a) => String(a.scheduled_service_id) === String(r.id)).map((a) => item(a.service_name, a.service_key_snapshot)),
    ];
    return { own: withAddOns(row), siblings: others.flatMap(withAddOns), span: siblingSpan(row, others) };
  } catch (err) {
    logger.warn(`[rain-fit] visit services lookup failed (the screen's list used): ${err.message}`);
    return null;
  }
}

function siblingSpan(row, others) {
  const ownStart = toMin(row.window_start);
  if (ownStart == null) return null;
  let startOffset = 0;
  let endOffset = 0;
  for (const other of others) {
    const start = toMin(other.window_start);
    if (start == null) continue;
    const end = Math.max(start + 60, toMin(other.window_end) ?? start + 60);
    startOffset = Math.min(startOffset, start - ownStart);
    endOffset = Math.max(endOffset, end - ownStart);
  }
  return startOffset || endOffset ? { startOffset, endOffset } : null;
}

// A chip widened to everything that moves with it: `span` from
// storedVisitServices. The chip's own window is never shortened.
function widenToSpan(chip, span) {
  const start = toMin(chip.start_time);
  if (!span || start == null) return chip;
  const end = Math.max(start + 60, toMin(chip.end_time) ?? start + 60);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const clamp = (m) => Math.min(24 * 60 - 1, Math.max(0, m));
  return { ...chip, start_time: hhmm(clamp(start + span.startOffset)), end_time: hhmm(clamp(Math.max(end, start + span.endOffset))) };
}

// The find-time request's services for the ranking: the primary service and
// the rest of the booking, each with the catalog key the screen sent
// (`serviceKeys`, parallel to `serviceTypes`). Deduplicated and capped.
// Empty unless the request asks for the best-times rows, the only reader.
// For an existing visit (`serviceId`: Edit, Quick Move, the reschedule
// dialogs) the visit's own rows say what moves, so no screen can leave a
// service out: the stored primary service and add-ons, unless the screen
// sent its own list (the edit form's unsaved services), plus every live
// service that shares the stop, unless the move takes this one alone.
async function bookingServices(args, db) {
  return (await bookingRainPlan(args, db)).services;
}

// bookingServices plus `rainSpan`: the shared stop's reach around the
// tapped service (storedVisitServices `span`), or null.
async function bookingRainPlan({ bestRows, serviceType, serviceTypes, serviceKeys, serviceId, moveAlone = false }, db) {
  if (bestRows !== true) return { services: [], rainSpan: null };
  let names = Array.isArray(serviceTypes) ? serviceTypes : [];
  let keys = Array.isArray(serviceKeys) && serviceKeys.length === names.length ? serviceKeys : [];
  const stored = serviceId ? await storedVisitServices(serviceId, { moveAlone }, db) : null;
  if (stored) {
    const sent = names.some((name) => typeof name === 'string' && name.trim());
    const list = [...(sent ? names.map((name, i) => ({ name, key: keys[i] })) : stored.own), ...stored.siblings];
    names = list.map((item) => item.name);
    keys = list.map((item) => item.key || '');
  }
  const seen = new Map();
  let overflow = false;
  const add = (name, key) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const serviceKey = typeof key === 'string' && KEY_SHAPE.test(key) ? key : null;
    const id = `${serviceKey || ''}|${name.trim().toLowerCase()}`;
    if (seen.has(id)) return;
    if (seen.size >= MAX_BOOKING_SERVICES) { overflow = true; return; }
    seen.set(id, { name: name.trim(), serviceKey });
  };
  names.forEach((name, i) => add(name, keys[i]));
  // The primary service, unless the list already names it (with its key).
  const primary = typeof serviceType === 'string' ? serviceType.trim().toLowerCase() : '';
  if (primary && ![...seen.values()].some((item) => item.name.toLowerCase() === primary)) add(serviceType, null);
  // Services past the cap are not looked up, so they cannot be called
  // rain-OK: one unclassified entry makes the whole booking outdoor rather
  // than letting the classified ones speak for it (Codex #6120 r4).
  const services = await withCatalogKeys([...seen.values()], db);
  return { services: overflow ? [...services, OVERFLOW_SERVICE] : services, rainSpan: stored?.span || null };
}

// The ranking's forecast: NWS hourly, Open-Meteo when NWS fails; fail open
// to no rain. Labels only: a 1.5 s wait. Ranking: NWS gets 1.2 s so a slow
// failure still leaves the backup time inside a 2.5 s wait (Codex #6102
// r2); only a ranking read spends the longer wait (Codex #6102 r5).
const LABEL_WAIT_MS = 1500;
const RANK_WAIT_MS = 2500;
const RANK_NWS_MS = 1200;
function boundedHourlyRain(la, ln, ranking = false) {
  const { getHourlyRainOutlook } = require('../weather-forecast');
  const opts = ranking ? { budgetMs: RANK_WAIT_MS, nwsBudgetMs: RANK_NWS_MS } : undefined;
  let timer;
  return Promise.race([
    getHourlyRainOutlook(la, ln, opts).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(resolve, ranking ? RANK_WAIT_MS + 100 : LABEL_WAIT_MS, null); }),
  ]).finally(() => clearTimeout(timer));
}

// The booking's fit with the gate applied: 'neutral' (drive-only) while
// GATE_BOOKING_RAIN_RANK is off. Read at call time.
function bookingRainFit(serviceTypes) {
  const { gateEnvValue } = require('../../config/feature-gates');
  return gateEnvValue('GATE_BOOKING_RAIN_RANK') ? rainFitFor(serviceTypes) : 'neutral';
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function inRainHorizon(date, today) {
  return !!date && !!today && date >= today && date <= addDays(today, RAIN_DAYS - 1);
}

// True when any hour reads wet; false only when EVERY hour of the window has
// a dry reading; null when the date is past the horizon or any hour lacks a
// reading (unknown ≠ dry, Codex #6102 r3).
function isWetWindow(hourly, { date, start_time: start, end_time: end }, today) {
  if (!Array.isArray(hourly) || !inRainHorizon(date, today)) return null;
  const startMin = toMin(start);
  if (startMin == null) return null;
  const endMin = Math.max(startMin + 60, toMin(end) ?? startMin + 60);
  const lastMin = endMin + RAIN_AFTER_HOURS * 60;
  let missing = false;
  for (let m = Math.floor(startMin / 60) * 60; m < lastMin && m < 24 * 60; m += 60) {
    const key = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}`;
    const hour = hourly.find((h) => String(h.startTime).slice(0, 13) === key);
    if (!hour || !Number.isFinite(hour.rainChance)) missing = true;
    else if (hour.rainChance >= RAIN_PCT) return true;
  }
  return missing ? null : false;
}

// Sort tier: 0 sorts first. Rain moves only what the forecast knows:
//   avoid:  a wet hour 2; an hour inside the horizon the forecast cannot
//           read 1 (not promoted to dry); a dry hour 0.
//   prefer: a wet hour 0; every other hour 1.
// A date past the horizon is tier 0 for 'avoid' and 1 for 'prefer', the
// same as a dry hour: it competes on drive alone, as before rain ranking.
// (Owner 2026-10-08: with "unknown" between dry and wet, every dry hour in
// the next 3 days outranked all later dates for an outdoor booking, and a
// rain-OK booking's dry near hours ranked behind dates a week out.)
function rainTier(fit, wet, inHorizon = true) {
  if (fit === 'neutral') return 0;
  if (fit === 'prefer') return wet === true ? 0 : 1;
  if (wet === true) return 2;
  return wet == null && inHorizon ? 1 : 0;
}

// Whether ranking can use a forecast at all: a non-neutral booking with at
// least one candidate date inside the horizon. Otherwise every tier would be
// "unknown", so the caller need not wait for the forecast (Codex #6102 r3).
// Only days the rows can show count: the picked date, or an open day that is
// not a tech's day off (pickBestRows' own eligibility, Codex #6102 r8).
function rankingNeedsForecast(fit, days, today, pickedDate) {
  return fit !== 'neutral' && days.some((day) => day.hours.length && inRainHorizon(day.date, today)
    && (day.date === pickedDate || (!day.closed && day.status !== 'off')));
}

// The ranking's tier function for one forecast, or null (drive-only order)
// when there is no forecast or the booking is neutral. `span` widens each
// chip to the whole shared stop that moves with it.
function rainTierOf(fit, hourly, today, span = null) {
  if (fit === 'neutral' || !hourly) return null;
  return (chip) => rainTier(fit, isWetWindow(hourly, widenToSpan(chip, span), today), inRainHorizon(chip.date, today));
}

module.exports = { RAIN_OK_KEYS, boundedHourlyRain, rainFitFor, bookingRainFit, withCatalogKeys, bookingServices, bookingRainPlan, storedVisitServices, widenToSpan, rainClassOf, rainTierOf, rankingNeedsForecast, inRainHorizon, isWetWindow, rainTier, RAIN_PCT, RAIN_AFTER_HOURS, RAIN_DAYS };
