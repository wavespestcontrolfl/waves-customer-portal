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
export default function CancelFeeNotice({ serviceId }) {
  const [state, setState] = useState({ status: 'loading', preview: null });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', preview: null });
    fetchCardHoldCancelPreview(serviceId).then((preview) => {
      if (cancelled) return;
      setState({ status: preview ? 'ready' : 'unavailable', preview });
    });
    return () => { cancelled = true; };
  }, [serviceId]);

  const rule = state.preview?.rule;
  let label = 'Saved card';
  let labelClass = 'text-zinc-500';
  let text;
  if (state.status === 'loading') {
    text = 'Checking whether the saved card will be charged…';
  } else if (state.status === 'unavailable' || !rule) {
    text = "Couldn't check the saved card right now. Nothing is charged automatically without a verified fee rule — the cancel is parked for billing review if a card is on file.";
  } else {
    text = rule.text;
    if (rule.willCharge === true) { label = 'Card will be charged'; labelClass = 'text-alert-fg'; }
    else if (rule.willCharge === false) { label = 'Card will not be charged'; }
    else { label = 'Charge undetermined'; }
  }

  return (
    <div
      className="mt-4 border-t border-hairline border-zinc-200 pt-3"
      role="status"
      aria-live="polite"
      data-testid="cancel-fee-notice"
      data-rule-code={rule?.code || ''}
    >
      <div className={`text-13 font-medium uppercase tracking-label ${labelClass}`}>{label}</div>
      <p className="mt-1 text-14 leading-6 text-zinc-900">{text}</p>
    </div>
  );
}
