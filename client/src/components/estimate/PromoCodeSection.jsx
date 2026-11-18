/**
 * "Have a promo code?" on the customer estimate page (GATE_ESTIMATE_PROMO_CODE,
 * owner 2026-11-18). Renders only from /data's `promoCode` block, which the
 * server sends while the estimate can still be accepted (the field) and once
 * a code is on it (the note).
 *
 * A valid code is a one-time account credit posted when the estimate is
 * accepted; the price on the page never changes. The amount shown is the
 * server's, never typed here.
 *
 * Props:
 *   promoCode  — { canEnter, applied: { code, creditAmount, credited } | null }
 *   submitCode — async (code) => { ok, promoCode } | { ok: false, error }
 *                (the page owns the endpoint)
 *   staffView  — true: the field is inert (staff never enter a customer's code)
 */
import { useState } from 'react';
import { fmtMoney } from '../../lib/money';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

const REFUSALS = {
  invalid_code: 'That code isn’t valid for this estimate.',
  code_already_entered: 'This estimate already has a promo code.',
  discount_already_applied: 'This estimate already includes a discount, so a promo code can’t be added.',
};
const FALLBACK = 'That didn’t go through. Please try again.';

const heading = { fontSize: 20, fontWeight: 700, color: W.blueDeeper, margin: '0 0 8px' };
const body = { fontSize: 16, lineHeight: 1.5, color: W.textBody, margin: 0 };

export default function PromoCodeSection({ promoCode, submitCode, staffView = false }) {
  const [view, setView] = useState(promoCode || null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!view) return null;

  if (view.applied) {
    const amount = fmtMoney(view.applied.creditAmount);
    return (
      <section data-section="promo-code" style={estimateCard()}>
        <h2 style={heading}>Promo code {view.applied.code}</h2>
        <p style={body}>
          {view.applied.credited
            ? `A ${amount} credit was added to your account.`
            : `We’ll add a ${amount} credit to your account when you accept this estimate.`}
        </p>
      </section>
    );
  }
  if (!view.canEnter) return null;

  const onSubmit = async (event) => {
    event.preventDefault();
    const typed = code.trim();
    if (!typed || busy || staffView) return;
    setBusy(true);
    setError('');
    try {
      const result = await submitCode(typed);
      if (result?.ok && result.promoCode) setView(result.promoCode);
      else setError(REFUSALS[result?.error] || FALLBACK);
    } catch {
      setError(FALLBACK);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-section="promo-code" style={estimateCard()}>
      <h2 style={heading}>Have a promo code?</h2>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <input
          type="text"
          name="promoCode"
          aria-label="Promo code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={50}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={busy || staffView}
          style={{
            flex: '1 1 180px', minWidth: 0, minHeight: 48, padding: '0 14px', boxSizing: 'border-box',
            fontSize: 16, color: W.navy, background: W.white,
            border: `1px solid ${W.border}`, borderRadius: 10,
          }}
        />
        <button
          type="submit"
          disabled={busy || staffView || !code.trim()}
          style={{
            minHeight: 48, padding: '0 20px', border: 'none', borderRadius: 10,
            background: W.navyDeep, color: W.white, fontSize: 16, fontWeight: 600,
            cursor: busy || staffView || !code.trim() ? 'default' : 'pointer',
            opacity: busy || staffView || !code.trim() ? 0.6 : 1,
          }}
        >
          {busy ? 'Checking…' : 'Apply'}
        </button>
      </form>
      {staffView ? <p style={{ ...body, fontSize: 14, marginTop: 8 }}>Staff view. Customers enter their code here.</p> : null}
      {error ? <p role="alert" style={{ ...body, fontSize: 14, marginTop: 8, color: W.red }}>{error}</p> : null}
    </section>
  );
}
