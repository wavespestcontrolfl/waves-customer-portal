/**
 * "Have a promo code?" on the invoice pay page (GATE_PAY_PROMO_CODE, owner
 * 2026-11-18). Renders only from the pay payload's `promoCode` block, which
 * the server sends while a code can be entered on the invoice (the field) and
 * once one is on it (the note).
 *
 * Entering a code only saves it. The page then reloads, and the payment setup
 * that follows posts the credit and lowers the amount due, so every figure
 * the customer sees and pays comes from the server.
 *
 * Props:
 *   promoCode  — { canEnter, applied: { code, creditAmount } | null }
 *   submitCode — async (code) => { ok } | { ok: false, error }
 *   onSaved    — called once the code is saved (the page reloads)
 *   panelStyle — the pay page's panel style, so the field matches its cards
 */
import { useState } from 'react';
import { fmtMoney } from '../../lib/money';
import { DOC, DOC_FONT, FS, FW, LH, RADIUS, SP, docButton } from '../../theme-doc';

const REFUSALS = {
  invalid_code: 'That code isn’t valid for this invoice.',
  code_already_entered: 'This invoice already has a promo code.',
};
const FALLBACK = 'That didn’t go through. Please try again.';

const label = { fontFamily: DOC_FONT, fontSize: FS.body, fontWeight: FW.bold, color: DOC.ink, lineHeight: LH.body };
const text = { margin: 0, fontFamily: DOC_FONT, fontSize: FS.body, color: DOC.muted, lineHeight: LH.body };

export default function PayPromoCode({ promoCode, submitCode, onSaved, panelStyle = {} }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!promoCode) return null;
  const panel = { ...panelStyle, padding: SP.md, marginBottom: SP.xl };

  if (promoCode.applied) {
    return (
      <div data-glass="soft" data-section="promo-code" className="waves-no-print" style={panel}>
        <div style={label}>Promo code {promoCode.applied.code}</div>
        <p style={text}>{fmtMoney(promoCode.applied.creditAmount)} credit toward this invoice.</p>
      </div>
    );
  }
  if (!promoCode.canEnter) return null;

  const idle = busy || !code.trim();
  const onSubmit = async (event) => {
    event.preventDefault();
    if (idle) return;
    setBusy(true);
    setError('');
    try {
      const result = await submitCode(code.trim());
      if (result?.ok) {
        onSaved();
        return;
      }
      setError(REFUSALS[result?.error] || FALLBACK);
    } catch {
      setError(FALLBACK);
    }
    setBusy(false);
  };

  return (
    <div data-glass="soft" data-section="promo-code" className="waves-no-print" style={panel}>
      <label htmlFor="pay-promo-code" style={{ ...label, display: 'block', marginBottom: SP.xs }}>Have a promo code?</label>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: SP.xs }}>
        <input
          id="pay-promo-code"
          type="text"
          name="promoCode"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={50}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={busy}
          style={{
            flex: '1 1 160px', minWidth: 0, minHeight: 48, padding: '0 14px', boxSizing: 'border-box',
            fontFamily: DOC_FONT, fontSize: FS.bodyLg, color: DOC.ink, background: DOC.surface,
            border: `1px solid ${DOC.border}`, borderRadius: RADIUS.input,
          }}
        />
        <button type="submit" disabled={idle} style={{ ...docButton('chip'), opacity: idle ? 0.6 : 1, cursor: idle ? 'default' : 'pointer' }}>
          {busy ? 'Checking…' : 'Apply'}
        </button>
      </form>
      {error ? <p role="alert" style={{ ...text, marginTop: SP.xs, color: DOC.danger }}>{error}</p> : null}
    </div>
  );
}
