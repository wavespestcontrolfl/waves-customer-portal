// The recurring pest programs (suffix-normalized), including the seeded-DB
// alias forms. The prod rows carry the "* Pest Control Service" names,
// active + booking_enabled (verified in prod 2026-07-11). Also used to
// RETARGET a model-picked cadence when the caller unambiguously chose a
// different one.
//
// Relocated verbatim from call-recording-processor.js (2026-09-23, the
// consultation-link lane) so server/services/lead-recurring-intent.js can
// share this set without requiring the 16k-line call-recording-processor.js
// module (which has import-time side effects). Byte-identical values and
// behavior — call-recording-processor.js now requires both from here.
const RECURRING_PEST_PROGRAMS = new Set([
  'monthly pest control',
  'bi-monthly pest control',
  'quarterly pest control',
  'semiannual pest control',
  'general pest control (monthly)',
  'general pest control (bi-monthly)',
  'general pest control (quarterly)',
  'general pest control (semiannual)',
]);

// Strips the "Service" token at the end OR before a parenthetical, so both
// "Quarterly Pest Control Service" and "General Pest Control Service
// (Bi-Monthly)" normalize to comparable keys.
const normalizeServiceKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+service(?=\s*\(|$)/, '');

module.exports = { RECURRING_PEST_PROGRAMS, normalizeServiceKey };
