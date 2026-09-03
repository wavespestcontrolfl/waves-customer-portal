import { useEffect, useState } from 'react';
import { fetchCardHoldCancelPreview } from '../../lib/cardHoldCancel';

// Foot of the admin cancel card: states whether the customer's saved card
// WILL be charged by this cancel and the exact rule that decides it, in both
// directions ("why it will" / "why it won't"). The sentence comes from the
// server's cancel-fee preview (`rule.text`) so the card, the fee prompt, and
// the charge path all read the same verdict. Owner request 2026-09-03 after
// a $75 warning fired on a visit a week out.
//
// Display-only: the fee-choice prompt at confirm time fetches its own fresh
// preview (a copy taken when the card opened can go stale).

// Series cancels fan out server-side: every target visit is judged on its
// own saved card, and the ONE waive choice from the next prompt is applied
// to all of them — the operator must hear both (Codex #3800 pre-push P1).
const SERIES_CAVEAT = 'This verdict covers this appointment only. The other appointments being cancelled are judged on their own saved cards — any of them inside its own late-cancel window may be charged without a preview here — and if you waive the fee at the next prompt, that waiver applies to all of them.';

// The verdict as label + sentence, shared by the Tailwind notice below and
// the inline-styled EditServiceModal cancel dialog (SchedulePage.jsx —
// retained V1 module, D palette, so it renders its own markup).
// `enabled` defers the fetch until the cancel dialog is actually open.
export function useCancelFeeNotice(serviceId, { enabled = true, scope = 'this_only' } = {}) {
  const [state, setState] = useState({ status: 'loading', preview: null });

  useEffect(() => {
    // Disabled (dialog closed) or no visit: drop the cached verdict so a
    // reopen — possibly for a different visit — never flashes stale
    // billing copy (Codex #3806 r3 P2).
    if (!enabled || !serviceId) { setState({ status: 'loading', preview: null }); return undefined; }
    let cancelled = false;
    setState({ status: 'loading', preview: null });
    fetchCardHoldCancelPreview(serviceId).then((preview) => {
      if (cancelled) return;
      setState({ status: preview ? 'ready' : 'unavailable', preview });
    });
    return () => { cancelled = true; };
  }, [serviceId, enabled]);

  const rule = state.preview?.rule;
  let label = 'Saved card';
  let tone = 'neutral';
  let text;
  if (state.status === 'loading') {
    text = 'Checking whether the saved card will be charged…';
  } else if (state.status === 'unavailable' || !rule) {
    // No verdict to relay — and the two rails handle a failed check
    // differently (review park vs free release), so promise neither.
    text = "Couldn't check the saved card right now. The confirmation step re-checks before anything is charged; if it still can't verify, check the visit's billing after cancelling.";
  } else {
    text = rule.text;
    if (rule.willCharge === true) { label = 'Card will be charged'; tone = 'charge'; }
    else if (rule.willCharge === false) { label = 'Card will not be charged'; }
    else { label = 'Charge undetermined'; tone = 'undetermined'; }
  }
  // Series cancels fan out server-side; each sibling's saved card is judged
  // on its own there, so the single-visit verdict must say what it covers
  // (Codex #3800 r1 P1).
  if (scope !== 'this_only') text = `${text} ${SERIES_CAVEAT}`;
  return { status: state.status, code: rule?.code || '', label, tone, text };
}

export default function CancelFeeNotice({ serviceId, scope = 'this_only' }) {
  const { code, label, tone, text } = useCancelFeeNotice(serviceId, { scope });
  const labelClass = tone === 'charge' ? 'text-alert-fg' : 'text-zinc-500';
  return (
    <div
      className="mt-4 border-t border-hairline border-zinc-200 pt-3"
      role="status"
      aria-live="polite"
      data-testid="cancel-fee-notice"
      data-rule-code={code}
    >
      <div className={`text-13 font-medium uppercase tracking-label ${labelClass}`}>{label}</div>
      <p className="mt-1 text-14 leading-6 text-zinc-900">{text}</p>
    </div>
  );
}
