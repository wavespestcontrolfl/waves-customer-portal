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
 * Pure rules; bookingRainFit reads the gate.
 */
const RAIN_PCT = 60;
const RAIN_AFTER_HOURS = 2;
const RAIN_DAYS = 3;

// A booking is rain-OK only when EVERY service in it is: one outdoor
// service in the booking means work happens outside.
const RAIN_OK = /assess|estimate|inspect|\bwdo\b|wood[- ]?destroy|interior/i;
// Rodent work is rain-OK only as a check: trap checks, monitoring, an
// inspection. Exclusion and remediation (wire mesh, sealing) are outdoor
// jobs (Codex #6102 r2).
const RODENT = /rodent|\brats?\b|\bmice\b|\bmouse\b|trap/i;
const RODENT_CHECK = /check|monitor|inspect/i;
// Words that put a service outside whatever else it says.
const OUTDOOR = /exterior|exclu|mesh|seal|remediat/i;

function rainOkService(name) {
  if (OUTDOOR.test(name)) return false;
  if (RAIN_OK.test(name)) return true;
  return RODENT.test(name) && RODENT_CHECK.test(name);
}

function rainFitFor(serviceTypes) {
  const names = (Array.isArray(serviceTypes) ? serviceTypes : [serviceTypes])
    .map((s) => String(s || '').trim()).filter(Boolean);
  if (!names.length) return 'neutral';
  return names.every(rainOkService) ? 'prefer' : 'avoid';
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

// True / false for a chip inside the forecast horizon, null when the date is
// past it or the forecast has no reading for the window (unknown ≠ dry).
function isWetWindow(hourly, { date, start_time: start, end_time: end }, today) {
  if (!Array.isArray(hourly) || !date || !today) return null;
  if (date < today || date > addDays(today, RAIN_DAYS - 1)) return null;
  const startMin = toMin(start);
  if (startMin == null) return null;
  const endMin = Math.max(startMin + 60, toMin(end) ?? startMin + 60);
  const lastMin = endMin + RAIN_AFTER_HOURS * 60;
  let seen = false;
  for (let m = Math.floor(startMin / 60) * 60; m < lastMin && m < 24 * 60; m += 60) {
    const key = `${date}T${String(Math.floor(m / 60)).padStart(2, '0')}`;
    const hour = hourly.find((h) => String(h.startTime).slice(0, 13) === key);
    if (!hour || !Number.isFinite(hour.rainChance)) continue;
    seen = true;
    if (hour.rainChance >= RAIN_PCT) return true;
  }
  return seen ? false : null;
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

// The ranking's tier function for one forecast, or null (drive-only order)
// when there is no forecast or the booking is neutral.
function rainTierOf(fit, hourly, today) {
  if (fit === 'neutral' || !hourly) return null;
  return (chip) => rainTier(fit, isWetWindow(hourly, chip, today));
}

module.exports = { rainFitFor, bookingRainFit, rainTierOf, isWetWindow, rainTier, RAIN_PCT, RAIN_AFTER_HOURS, RAIN_DAYS };
