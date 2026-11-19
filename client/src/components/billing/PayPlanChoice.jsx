/**
 * Pay per application or prepay the year, on the invoice pay page
 * (GATE_PAY_PLAN_CHOICE, owner 2026-11-19). Renders only from the pay
 * payload's `planChoice` block, which the server sends on the first invoice of
 * an accepted pay-per-application plan.
 *
 * Paying per application is paying this invoice as it stands, so that option
 * has no button here. Picking the year asks the server for the prepay
 * invoice's own pay link and goes there; every figure shown comes from the
 * server. This invoice stays payable after a pick.
 *
 * Props:
 *   planChoice — before a pick: { selected: false, serviceType, visitsPerYear,
 *                perApplication: { perVisit, setupFee, yearTotal },
 *                prepay: { total, setupFeeWaived, discount, discountLabel } }
 *                after one: { selected: true, prepay: { total } }
 *   choosePrepay — async () => { ok: true, payUrl } | { ok: false }
 *   onChosen   — called with the prepay invoice's pay link (the page goes there)
 *   panelStyle — the pay page's panel style, so the block matches its cards
 */
import { useState } from 'react';
import { fmtMoney } from '../../lib/money';
import { DOC, DOC_FONT, FS, FW, LH, SP, docButton } from '../../theme-doc';

const FAILED = 'That didn’t go through. Please try again, or pay this invoice instead.';

const heading = { fontFamily: DOC_FONT, fontSize: FS.bodyLg, fontWeight: FW.bold, color: DOC.ink, lineHeight: LH.body };
const prose = { margin: 0, fontFamily: DOC_FONT, fontSize: FS.bodyLg, color: DOC.muted, lineHeight: LH.body };

// What prepaying saves, in the customer's terms: the waived setup fee for
// pest and mosquito plans, the percentage for the discounted programs.
function savingLine(prepay) {
  if (prepay.setupFeeWaived > 0) return `The ${fmtMoney(prepay.setupFeeWaived)} setup fee is waived.`;
  if (prepay.discount > 0) {
    return `You save ${fmtMoney(prepay.discount)}${prepay.discountLabel ? ` (${prepay.discountLabel} off)` : ''}.`;
  }
  return '';
}

export default function PayPlanChoice({ planChoice, choosePrepay, onChosen, panelStyle = {} }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!planChoice?.prepay) return null;
  const panel = { ...panelStyle, padding: SP.md, marginBottom: SP.xl };
  const { prepay } = planChoice;

  const onPick = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await choosePrepay();
      if (result?.ok && result.payUrl) {
        onChosen(result.payUrl);
        return;
      }
      setError(FAILED);
    } catch {
      setError(FAILED);
    }
    setBusy(false);
  };

  const button = (text) => (
    <button
      type="button"
      onClick={onPick}
      disabled={busy}
      style={{ ...docButton('chip'), marginTop: SP.sm, whiteSpace: 'normal', opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer' }}
    >
      {busy ? 'One moment…' : text}
    </button>
  );
  const failure = error ? <p role="alert" style={{ ...prose, marginTop: SP.xs, color: DOC.danger }}>{error}</p> : null;

  if (planChoice.selected) {
    return (
      <div data-glass="soft" data-section="plan-choice" className="waves-no-print" style={panel}>
        <div style={heading}>You chose to prepay the year</div>
        <p style={prose}>
          Your annual prepay invoice is {fmtMoney(prepay.total)}. Paying it closes this invoice. If you would rather
          pay per application, pay this invoice instead.
        </p>
        {button('Go to the annual prepay invoice')}
        {failure}
      </div>
    );
  }

  const { perApplication, visitsPerYear, serviceType } = planChoice;
  const saving = savingLine(prepay);
  return (
    <div data-glass="soft" data-section="plan-choice" className="waves-no-print" style={panel}>
      <div style={heading}>Two ways to pay for your {serviceType}</div>
      <div style={{ marginTop: SP.sm }}>
        <div style={heading}>Pay per application</div>
        <p style={prose}>
          {fmtMoney(perApplication.perVisit)} per application, {visitsPerYear} applications a year
          {perApplication.setupFee > 0 ? `, plus the one-time ${fmtMoney(perApplication.setupFee)} setup fee` : ''}
          : {fmtMoney(perApplication.yearTotal)} for the year. This invoice is the first of those.
        </p>
      </div>
      <div style={{ marginTop: SP.sm }}>
        <div style={heading}>Prepay the year</div>
        <p style={prose}>
          {fmtMoney(prepay.total)} today covers all {visitsPerYear} applications, including the one on this invoice.
          {saving ? ` ${saving}` : ''}
        </p>
        {button(`Prepay the year for ${fmtMoney(prepay.total)}`)}
      </div>
      {failure}
    </div>
  );
}
