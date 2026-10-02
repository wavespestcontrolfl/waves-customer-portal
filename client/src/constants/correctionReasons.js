// The five correction reasons — mirrors server/services/correction-reasons.js
// (a server test pins the two lists equal). Shown as one-tap chips on the
// Agent Review cards and the Typed review tab; both write the same closed set.
export const CORRECTION_REASONS = [
  { value: "wrong_fact", label: "Wrong fact" },
  { value: "wrong_tone", label: "Wrong tone" },
  { value: "missing_promise", label: "Missing promise" },
  { value: "should_have_escalated", label: "Should have escalated" },
  { value: "other", label: "Other" },
];

export const correctionReasonLabel = (value) => CORRECTION_REASONS.find((r) => r.value === value)?.label || null;
