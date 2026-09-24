// Recurring-plan classification for a lead's `service_interest` string.
// Scope doc: lead-inspection-link-scope.md §2, §7 ("Form leads classify from
// the form"). Deterministic, cheap, no DB or LLM call — reads only the
// pre-computed label the intake paths already wrote.
//
// A lead is "recurring" when service_interest either:
//   (a) starts with the "Recurring " label lead-webhook.js's
//       formatServiceInterestForFrequency() writes for form leads whose
//       posted `frequency` is `ongoing` (FREQUENCY_LABELS.ongoing ===
//       'Recurring'), e.g. "Recurring Pest Control"; or
//   (b) names a recurring pest program from the call path — the same
//       RECURRING_PEST_PROGRAMS set call-recording-processor.js resolves
//       into service_interest for call leads, e.g. "Quarterly Pest Control
//       Service" — so this classifier can never drift from what the call
//       processor already decided.
//
// NOTE: lead-webhook.js also maps a `not-sure` frequency to the "Consultation"
// label, but the live website form has no such option (only `ongoing` |
// `one-time` are ever posted) — that mapping is dead code. 'Consultation' is
// deliberately NOT treated as recurring here; blank/unknown/One-Time all
// resolve to false, the safe default ("never promise an owner visit we
// didn't mean to").
const { RECURRING_PEST_PROGRAMS, normalizeServiceKey } = require('../config/recurring-pest-programs');

function leadWantsRecurringPlan(lead) {
  const raw = lead?.service_interest;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^recurring\b/i.test(trimmed)) return true;
  return RECURRING_PEST_PROGRAMS.has(normalizeServiceKey(trimmed));
}

module.exports = { leadWantsRecurringPlan };
