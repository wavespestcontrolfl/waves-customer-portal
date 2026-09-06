import { getAdminAuthToken, getAdminUser } from './adminAuth';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Undetermined (willCharge null) verdicts whose confirm-time check may still
// charge the displayed visit's own fee — the admin waiver applies to it.
const WAIVABLE_UNRESOLVED_CODES = new Set(['unresolved', 'capture_in_flight']);

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
 * An unavailable preview uses the undetermined confirmation and waiver
 * choices, just like an unsuccessful server-side fee lookup.
 *
 * Always fetches fresh at confirm time — the CancelFeeNotice at the foot of
 * the cancel card fetched its own copy when the card opened, but that copy
 * can go stale (card reopened later, visit crossing the window boundary,
 * card removed) and a stale verdict here would skip the warning or waive
 * revenue. The notice is display-only.
 *
 * @returns {Promise<{proceed: boolean, waiveCardHoldFee: boolean}>}
 */
export async function confirmCardHoldFeeChoice(serviceId, { scope = 'this_only' } = {}) {
  const preview = await fetchCardHoldCancelPreview(serviceId) || {
    rule: {
      code: 'unresolved',
      willCharge: null,
      text: "Couldn't check the saved card right now. Cancelling may charge a late-cancel fee. Check billing after cancelling if the fee remains unverified.",
    },
  };
  const isAdmin = () => getAdminUser()?.role === 'admin';
  // Series cancel (following / all): the server applies ONE waive choice to
  // every target, and siblings are judged on their own saved cards without
  // a preview here. When the displayed visit's own verdict would skip the
  // prompt, the admin still needs a place to waive a sibling's fee — a
  // Waves-initiated series cancel must not bill the customer for lack of a
  // prompt (Codex #3806 r3 P1). Undetermined / chargeable verdicts fall
  // through to their own prompts below, which already carry the waiver.
  const seriesWide = scope !== 'this_only';
  const seriesWaiverPrompt = () => window.confirm(
    'The other appointments in this series are cancelled with this one and are judged on their own saved cards. If any of them draws a late-cancel fee, waive it?\n\nOK = waive — Waves-initiated cancel (rain-out, sick day).\nCancel = charge the customer if it applies — customer-initiated late cancel.',
  );

  // Undetermined verdict: the in-window "will be charged" prompt would lie,
  // so show the rule's own neutral sentence (Codex #3800 r1 P1). The
  // waiver is still offered when the confirm-time check may still charge —
  // a RETRYABLE lookup failure ('unresolved') or a card capture that can
  // finish with fee consent first ('capture_in_flight') — because both
  // handlers honor waiveCardHoldFee before that check (Codex #3806 r2 P1,
  // r5 P1). A charge already in flight has nothing of ITS OWN left to
  // waive, but a series cancel still judges the siblings on their own
  // cards, so the series-wide waiver stays on offer (r5 P1).
  if (preview?.rule && preview.rule.willCharge === null) {
    if (!window.confirm(`${preview.rule.text}\n\nContinue with the cancellation?`)) {
      return { proceed: false, waiveCardHoldFee: false };
    }
    if (!isAdmin()) return { proceed: true, waiveCardHoldFee: false };
    if (!WAIVABLE_UNRESOLVED_CODES.has(preview.rule.code)) {
      return { proceed: true, waiveCardHoldFee: seriesWide ? seriesWaiverPrompt() : false };
    }
    const waiveIfApplies = window.confirm(
      `If the fee turns out to apply when you confirm, waive it?\n\nOK = waive — Waves-initiated cancel (rain-out, sick day).\nCancel = charge the customer if it applies — customer-initiated late cancel.`,
    );
    return { proceed: true, waiveCardHoldFee: waiveIfApplies };
  }

  if (!preview?.feeApplies) {
    if (seriesWide && isAdmin()) return { proceed: true, waiveCardHoldFee: seriesWaiverPrompt() };
    return { proceed: true, waiveCardHoldFee: false };
  }

  const fee = fmtFee(preview.feeAmount);
  // Prefer the server's rule sentence (sticky reschedules charge days
  // outside the visit's own window — "inside the late-cancel window" would
  // be wrong; Codex #3800 r4 P2). Older servers without `rule` keep the
  // legacy copy.
  const chargeCopy = preview.rule?.willCharge === true && preview.rule.text
    ? preview.rule.text
    : `This one-time visit has a card on hold, and cancelling now is inside the late-cancel window — ${fee} will be charged.`;
  if (!window.confirm(`${chargeCopy}\n\nContinue with the cancellation?`)) {
    return { proceed: false, waiveCardHoldFee: false };
  }
  if (!isAdmin()) return { proceed: true, waiveCardHoldFee: false };
  const waive = window.confirm(
    `Waive ${fee}?\n\nOK = waive — Waves-initiated cancel (rain-out, sick day).\nCancel = charge the customer — customer-initiated late cancel.`,
  );
  return { proceed: true, waiveCardHoldFee: waive };
}
