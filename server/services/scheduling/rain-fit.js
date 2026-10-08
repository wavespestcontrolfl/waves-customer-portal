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
 * Which services are outdoor: a service with a catalog key takes the
 * spray-trace registry's verdict (service-report/trace-eligibility.js, the
 * one registry of "does this service put product down outside", which a
 * contract test keeps complete for every active catalog key). The word
 * rules below are only the fallback for a service with no catalog key
 * (owner 2026-10-08: ten Codex rounds on #6102 each found another name the
 * words sorted wrong).
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

// Registry lanes where nothing is applied outside and the tech's work does
// not depend on dry weather: inspections, interior-only treatment, trap
// checks, attic sanitation.
const RAIN_OK_REASONS = new Set(['inspection_lane', 'interior_only_lane', 'trap_lane', 'sanitation_lane']);
// The bait-station lane mixes the recurring rodent station check (rain-OK,
// owner's "rodent checks") with installs: in-ground termite stations, and
// rodent_bait_setup, the one-time station placement that shares the check's
// findings type (Codex #6120 r1). Only the check's own catalog key is OK.
const RAIN_OK_KEYS = new Set(['rodent_bait_quarterly']);
// Not a visit's work at all: a billing rider, or the generic appointment
// whose work is unknown. Left out of the booking's verdict. Only that one
// key of the appointment lane: waveguard_initial_setup is in the same lane
// and is an onboarding visit with initial treatments (Codex #6120 r2).
const SKIP_REASONS = new Set(['billing_rider']);
const SKIP_KEYS = new Set(['general_appointment']);

// 'ok' | 'outdoor' | 'skip' for one service: { name, serviceKey,
// findingsType } or a bare name. Every other registry answer — a spray or
// outline lane, exclusion, localized nest work, mechanical lawn work,
// injection, pre-treatment, or an identity the registry does not know — is
// outdoor: an unknown service keeps a dry hour.
function rainClassOf(service) {
  const name = String((service && service.name) ?? service ?? '').trim();
  const serviceKey = (service && service.serviceKey) || null;
  const findingsType = (service && service.findingsType) || null;
  if (!serviceKey && !findingsType) return rainOkService(name) ? 'ok' : 'outdoor';
  const { resolveTraceEligibility } = require('../service-report/trace-eligibility');
  const verdict = resolveTraceEligibility({ serviceKey, findingsType });
  if (verdict.eligible) return 'outdoor';
  if (RAIN_OK_KEYS.has(serviceKey) || RAIN_OK_REASONS.has(verdict.reason)) return 'ok';
  return SKIP_REASONS.has(verdict.reason) || SKIP_KEYS.has(serviceKey) ? 'skip' : 'outdoor';
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

// The booking's services with their stable identity, for rainFitFor: the
// catalog key and findings type the completion-profile resolver gives a
// visit. `items` are names or { name, serviceKey }; a key the screen sent
// (the selected catalog row) settles the identity ahead of the name, which
// is not unique in the catalog. Only while the gate is on; read one at a
// time; an entry that cannot be resolved (or a failed read) keeps its name
// and takes the word rules.
async function withCatalogKeys(items, db) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => ({ name: String((item && item.name) ?? item ?? '').trim(), serviceKey: (item && item.serviceKey) || null }))
    .filter((item) => item.name);
  const { gateEnvValue } = require('../../config/feature-gates');
  if (!list.length || !gateEnvValue('GATE_BOOKING_RAIN_RANK')) return list.map((item) => item.name);
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

// The find-time request's services for the ranking: the primary service and
// the rest of the booking, each with the catalog key the screen sent
// (`serviceKeys`, parallel to `serviceTypes`). Deduplicated and capped.
// Empty unless the request asks for the best-times rows, the only reader.
function bookingServices({ bestRows, serviceType, serviceTypes, serviceKeys }, db) {
  if (bestRows !== true) return [];
  const names = Array.isArray(serviceTypes) ? serviceTypes : [];
  const keys = Array.isArray(serviceKeys) && serviceKeys.length === names.length ? serviceKeys : [];
  const seen = new Map();
  const add = (name, key) => {
    if (typeof name !== 'string' || !name.trim() || seen.size >= MAX_BOOKING_SERVICES) return;
    const serviceKey = typeof key === 'string' && KEY_SHAPE.test(key) ? key : null;
    const id = `${serviceKey || ''}|${name.trim().toLowerCase()}`;
    if (!seen.has(id)) seen.set(id, { name: name.trim(), serviceKey });
  };
  names.forEach((name, i) => add(name, keys[i]));
  // The primary service, unless the list already names it (with its key).
  const primary = typeof serviceType === 'string' ? serviceType.trim().toLowerCase() : '';
  if (primary && ![...seen.values()].some((item) => item.name.toLowerCase() === primary)) add(serviceType, null);
  return withCatalogKeys([...seen.values()], db);
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

// Sort tier: 0 sorts first. Unknown rain sits between: an 'avoid' booking
// prefers a known-dry hour over an unknown one, and a 'prefer' booking a
// known-wet hour over an unknown one.
function rainTier(fit, wet) {
  if (fit === 'neutral') return 0;
  if (wet == null) return 1;
  if (fit === 'avoid') return wet ? 2 : 0;
  return wet ? 0 : 2;
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
// when there is no forecast or the booking is neutral.
function rainTierOf(fit, hourly, today) {
  if (fit === 'neutral' || !hourly) return null;
  return (chip) => rainTier(fit, isWetWindow(hourly, chip, today));
}

module.exports = { rainFitFor, bookingRainFit, withCatalogKeys, bookingServices, rainClassOf, rainTierOf, rankingNeedsForecast, inRainHorizon, isWetWindow, rainTier, RAIN_PCT, RAIN_AFTER_HOURS, RAIN_DAYS };
