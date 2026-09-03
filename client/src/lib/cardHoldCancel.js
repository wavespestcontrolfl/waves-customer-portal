import { getAdminAuthToken, getAdminUser } from './adminAuth';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function fmtFee(amount) {
  const n = Number(amount);
  if (!(n > 0)) return 'the late-cancel fee';
  return `the $${Number.isInteger(n) ? n : n.toFixed(2)} late-cancel fee`;
}

/**
 * fetchCardHoldCancelPreview — GET the read-only cancel preview for a visit:
 * { held, feeApplies, feeAmount?, unresolved?, rule: { code, willCharge, text } }.
 * Best-effort: resolves null when the preview can't be fetched.
 */
export async function fetchCardHoldCancelPreview(serviceId) {
  try {
    const r = await fetch(`${API_BASE}/admin/dispatch/${serviceId}/card-hold`, {
      headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
    });
    if (r.ok) return await r.json();
  } catch (_) { /* best-effort — never block a cancel on the preview */ }
  return null;
}

/**
 * confirmCardHoldFeeChoice — shared pre-cancel step for the admin cancel
 * flows (dispatch delete, mobile appointment sheet, schedule sidebar).
 *
 * Fetches the card-hold cancel preview for the visit and, ONLY when
 * cancelling right now would charge the late-cancel fee, walks the operator
 * through the fee decision:
 *
 *   1. "This cancel charges $X — continue?"  Cancel → abort the whole cancel.
 *   2. Admins only: "Waive the fee?"  OK → waive (Waves-initiated: rain-out,
 *      sick day); Cancel/Escape → charge (customer-initiated late cancel —
 *      the pre-existing default, so backing out of the prompt never silently
 *      waives disclosed revenue).
 *
 * The waive question is offered only when the stored admin user is
 * role=admin, mirroring the server's req.techRole === 'admin' gate on
 * waiveCardHoldFee — a technician would send a flag the server ignores and
 * the UI would falsely imply the fee was waived. Techs get the fee warning
 * only and always proceed with waiveCardHoldFee: false.
 *
 * The preview is best-effort: if it can't be fetched the cancel proceeds
 * with today's behavior (no waive) rather than blocking the operator.
 *
 * `preloaded` — a preview the cancel card already fetched (CancelFeeNotice)
 * so the prompt reads the same verdict the operator just saw, without a
 * second round trip. Omit it to fetch here.
 *
 * @returns {Promise<{proceed: boolean, waiveCardHoldFee: boolean}>}
 */
export async function confirmCardHoldFeeChoice(serviceId, preloaded = null) {
  const preview = preloaded || await fetchCardHoldCancelPreview(serviceId);

  if (!preview?.feeApplies) return { proceed: true, waiveCardHoldFee: false };

  const fee = fmtFee(preview.feeAmount);
  if (!window.confirm(
    `This one-time visit has a card on hold, and cancelling now is inside the late-cancel window — ${fee} will be charged.\n\nContinue with the cancellation?`,
  )) {
    return { proceed: false, waiveCardHoldFee: false };
  }
  if (getAdminUser()?.role !== 'admin') return { proceed: true, waiveCardHoldFee: false };
  const waive = window.confirm(
    `Waive ${fee}?\n\nOK = waive — Waves-initiated cancel (rain-out, sick day).\nCancel = charge the customer — customer-initiated late cancel.`,
  );
  return { proceed: true, waiveCardHoldFee: waive };
}
