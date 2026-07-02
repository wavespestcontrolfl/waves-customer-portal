// Marketing-attribution fresh-start floor.
//
// The four hub city-page tracking numbers doubled as the GBP-listed lines for
// months, so call/lead attribution before the dedicated per-profile GBP
// tracking numbers went live (2026-06-28) blends GBP dials into the
// "Website — X (city page)" buckets; per-source monthly costs were only
// corrected to real spend on 2026-07-01. Every window on the Marketing
// Attribution panels is floored at this ET date so ytd / last_90 / custom
// lookbacks report only the clean era instead of averaging known-wrong
// history into the mix.
//
// Env-overridable (ATTRIBUTION_FRESH_START=YYYY-MM-DD) for a future re-reset;
// set it empty to disable the floor. Invalid values fail open (no floor).

const { etDateString, parseETDateTime } = require('./datetime-et');

const DEFAULT_ATTRIBUTION_FRESH_START = '2026-07-01';

// Resolve the floor to an ET date string (the attribution window math is
// string-based), or null when disabled/invalid.
function resolveAttributionFreshStart(raw = process.env.ATTRIBUTION_FRESH_START) {
  const value = raw ?? DEFAULT_ATTRIBUTION_FRESH_START;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // parseETDateTime builds the date with Date.UTC(), which silently rolls a
  // non-existent calendar date over (2026-02-30 → Mar 2) instead of failing.
  // Round-trip through ET and reject any mismatch so a typoed env falls open
  // to "no floor" rather than a wrong cutoff.
  const d = parseETDateTime(`${value}T00:00`);
  if (!(d instanceof Date) || Number.isNaN(d.getTime()) || etDateString(d) !== value) return null;
  return value;
}

// Floor a resolved attribution window ({from, to, label} of ET date strings)
// at the fresh start. Unchanged when the floor doesn't bind; when it does,
// the window carries `freshStart` and a label suffix so the dashboard card
// (and the leads drill it hands the window to) shows the range was clipped.
function applyAttributionFreshStart(win, freshStart) {
  if (!freshStart || !win || !win.from || win.from >= freshStart) return win;
  return {
    ...win,
    from: freshStart,
    freshStart,
    label: `${win.label} (data since ${freshStart})`,
  };
}

module.exports = {
  DEFAULT_ATTRIBUTION_FRESH_START,
  resolveAttributionFreshStart,
  applyAttributionFreshStart,
};
