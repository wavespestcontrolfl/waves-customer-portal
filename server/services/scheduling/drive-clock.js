/**
 * Drive clock (GATE_DRIVE_CLOCK, owner 2026-10-28: "add drive clock if its
 * free"). Our own GPS (visit_gps_legs, 100 visit-to-visit legs, Aug 27 - Oct 27
 * 2026, Theil-Sen fits) says a leg takes:
 *   minutes = 4.11 + 1.70 x GPS road miles     (a Google road time, curb to
 *             curb, misses ~4 minutes of pulling out, parking and idling)
 *   minutes = 7.88 + 2.20 x straight-line miles (the calibrated estimate is
 *             4.25 + 2.35; per leg, GPS minus estimate: median +1.9, p75 +7.6)
 * On, every drive leg in the scheduling math carries this: estimate legs use
 * the fitted pair, Google legs get the park minutes added when READ (never
 * stored in a cache, so turning the gate off restores the raw values at once).
 * Nothing is fitted or derived from Google answers (Google Maps terms).
 *
 * Read at CALL time via gateEnvValue: unset = off = byte for byte as before.
 * Settings (env, read at call time): a finite number inside its bounds, else
 * the default.
 */
const { gateEnvValue } = require('../../config/feature-gates');

const SETTINGS = {
  fixed: { env: 'DRIVE_CLOCK_FIXED_MINUTES', fallback: 7.9, min: 0, max: 30 },
  perMile: { env: 'DRIVE_CLOCK_MINUTES_PER_MILE', fallback: 2.2, min: 0.5, max: 6 },
  park: { env: 'DRIVE_CLOCK_PARK_MINUTES', fallback: 4, min: 0, max: 20 },
};
const GOOGLE_SOURCES = new Set(['google_traffic', 'google_road']);

// The drive clock refines the calibrated model, so it needs
// GATE_DRIVE_TIME_CALIBRATION too: with that off, every leg, Google's park
// minutes and the saved label all stay legacy (pre-push P1).
function driveClockLive() {
  return gateEnvValue('GATE_DRIVE_CLOCK') && gateEnvValue('GATE_DRIVE_TIME_CALIBRATION');
}

function driveClockSetting(name) {
  const { env, fallback, min, max } = SETTINGS[name];
  const raw = String(process.env[env] ?? '').trim();
  const value = raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Fitted minutes for a leg of `miles` straight-line miles (unrounded). */
function driveClockMinutes(miles) {
  return driveClockSetting('fixed') + miles * driveClockSetting('perMile');
}

/** A Google leg's minutes plus the park minutes (gate on), else unchanged. A
 * same-place leg (0 minutes) never carries them. */
function parkedMinutes(minutes) {
  if (!driveClockLive() || !(minutes > 0)) return minutes;
  return minutes + driveClockSetting('park');
}

/** A travel answer ({ minutes, source }) with the park minutes added when it
 * came from Google; a model or unverified answer is returned as is. */
function withDriveClockPark(answer) {
  if (!answer || !GOOGLE_SOURCES.has(answer.source) || !driveClockLive()) return answer;
  const minutes = parkedMinutes(answer.minutes);
  return minutes === answer.minutes ? answer : { ...answer, minutes };
}

/** The `drive_model` label saved with a day's quality numbers. */
function driveModelLabel() {
  if (driveClockLive()) return 'drive_clock';
  return gateEnvValue('GATE_DRIVE_TIME_CALIBRATION') ? 'calibrated' : 'legacy';
}

module.exports = { driveClockLive, driveClockSetting, driveClockMinutes, parkedMinutes, withDriveClockPark, driveModelLabel };
