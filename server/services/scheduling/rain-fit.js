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
// The bait-station lane mixes a rodent station check (rain-OK, owner's
// "rodent checks") with in-ground termite station installs (outdoor work).
const RAIN_OK_IDS = new Set(['rodent_bait_station']);
// Not a visit's work at all: a billing rider, or a generic appointment
// whose work is unknown. Left out of the booking's verdict.
const SKIP_REASONS = new Set(['billing_rider', 'appointment_lane']);

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
  if (RAIN_OK_IDS.has(serviceKey) || RAIN_OK_IDS.has(findingsType) || RAIN_OK_REASONS.has(verdict.reason)) return 'ok';
  return SKIP_REASONS.has(verdict.reason) ? 'skip' : 'outdoor';
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

// The booking's service names with their stable identity, for rainFitFor:
// the catalog key and findings type the completion-profile resolver gives a
// visit of that name (the same identity the spray-trace registry is keyed
// on). Only while the gate is on; a name it cannot resolve (or a failed
// read) stays a bare name and takes the word rules.
async function withCatalogKeys(names, db) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  const { gateEnvValue } = require('../../config/feature-gates');
  if (!list.length || !gateEnvValue('GATE_BOOKING_RAIN_RANK')) return list;
  const { resolveCompletionProfileForScheduledService } = require('../service-completion-profiles');
  return Promise.all(list.map(async (name) => {
    try {
      const profile = await resolveCompletionProfileForScheduledService({ service_type: name }, db);
      return { name, serviceKey: profile?.serviceKey || null, findingsType: profile?.findingsType || null };
    } catch (err) {
      logger.warn(`[rain-fit] service identity lookup failed (word rules used): ${err.message}`);
      return name;
    }
  }));
}

// The find-time request's services for the ranking: every service in the
// booking (the primary one and the rest), with identity. Empty unless the
// request asks for the best-times rows, the only reader.
function bookingServices({ bestRows, serviceType, serviceTypes }, db) {
  if (bestRows !== true) return [];
  const names = [serviceType].concat(Array.isArray(serviceTypes) ? serviceTypes : [])
    .filter((t) => typeof t === 'string' && t.trim());
  return withCatalogKeys(names, db);
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
