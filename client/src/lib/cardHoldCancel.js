const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * confirmCardHoldFeeChoice — shared pre-cancel step for the admin cancel
 * flows (dispatch delete, mobile appointment sheet, schedule sidebar).
 *
 * Fetches the card-hold cancel preview for the visit and, ONLY when
 * cancelling right now would charge the late-cancel fee, walks the operator
 * through the business-initiated-waive decision:
 *
 *   1. "This cancel charges $X — continue?"  Cancel → abort the whole cancel.
 *   2. "Waive the fee?"  OK → waive (Waves-initiated: rain-out, sick day);
 *      Cancel/Escape → charge (customer-initiated late cancel — the
 *      pre-existing default, so backing out of the prompt never silently
 *      waives disclosed revenue).
 *
 * The preview is best-effort: if it can't be fetched the cancel proceeds
 * with today's behavior (no waive) rather than blocking the operator.
 *
 * @returns {Promise<{proceed: boolean, waiveCardHoldFee: boolean}>}
 */
export async function confirmCardHoldFeeChoice(serviceId) {
  let preview = null;
  try {
    const r = await fetch(`${API_BASE}/admin/dispatch/${serviceId}/card-hold`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
    });
    if (r.ok) preview = await r.json();
  } catch (_) { /* best-effort — never block a cancel on the preview */ }

  if (!preview?.feeApplies) return { proceed: true, waiveCardHoldFee: false };

  const fee = Number(preview.feeAmount) > 0
    ? `the $${Number(preview.feeAmount).toFixed(0)} late-cancel fee`
    : 'the late-cancel fee';
  if (!window.confirm(
    `This one-time visit has a card on hold, and cancelling now is inside the late-cancel window — ${fee} will be charged.\n\nContinue with the cancellation?`,
  )) {
    return { proceed: false, waiveCardHoldFee: false };
  }
  const waive = window.confirm(
    `Waive ${fee}?\n\nOK = waive — Waves-initiated cancel (rain-out, sick day).\nCancel = charge the customer — customer-initiated late cancel.`,
  );
  return { proceed: true, waiveCardHoldFee: waive };
}
