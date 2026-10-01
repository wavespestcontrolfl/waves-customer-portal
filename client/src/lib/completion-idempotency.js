// Whether a failed /complete submit may start a NEW completion attempt.
// The server claims attempts by idempotency key and rejects a reused key
// whose payload changed (idempotency_key_mismatch), even on a failed
// attempt. So a DEFINITIVE pre-commit rejection (a 4xx other than the
// "already pending / committed" 409s) gets a fresh key for the corrected
// resubmit, while an uncertain outcome (network drop, 5xx) keeps the key so
// a same-payload retry can replay or resume instead of double-completing.
// Shared by the full completion form (SchedulePage) and the tech Fast
// Complete sheet.
export function shouldResetCompletionIdempotencyKey(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status) || status < 400 || status >= 500) return false;
  if (status !== 409) return true;
  return ["lawn_assessment_stale", "completion_pricing_changed", "property_service_area_changed"].includes(error?.code);
}
