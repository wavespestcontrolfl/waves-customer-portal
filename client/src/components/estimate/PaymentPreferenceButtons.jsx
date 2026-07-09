import React from 'react';
import { estimateCard } from './cardStyles';
import { fmtMoney } from '../../lib/money';
import { W } from './tokens';

/**
 * Payment preference picker. Rendered after a slot is selected. Clicking
 * any button triggers the /reserve -> confirm -> /accept flow.
 *
 * Copy shifts when serviceMode='one_time' - the customer is booking a
 * single visit, so framing changes.
 *
 * Third annual prepay button renders when the server marks the
 * recurring service mix as annual-prepay eligible. Older pricing bundles can
 * still surface it through a waivable setupFee.
 * Selection encodes as 'pay_at_visit' or 'prepay_annual'. After confirmation
 * the server creates/sends the matching invoice and returns a pay link.
 */

const ACTION_BG = W.blueDeeper;


function billingIntervalMonths(frequency = {}) {
  const key = frequency.billingFrequencyKey || frequency.key;
  if (key === 'quarterly') return 3;
  if (key === 'bi_monthly' || key === 'bimonthly') return 2;
  return 1;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function treatmentRowAmount(row = {}) {
  return firstPositiveNumber(
    row.displayPrice,
    row.priceAfterDiscount,
    row.netPerTreatment,
    row.price,
    row.perTreatment,
    row.perApp,
    row.perVisit,
    row.pa,
  );
}

function firstVisitAmount(frequency = {}) {
  const monthly = Number(frequency.monthly);
  if (frequency.billingFrequencyKey === 'monthly') {
    return null;
  }
  const treatments = Array.isArray(frequency.perServiceTreatments) ? frequency.perServiceTreatments : [];
  const treatmentAmounts = treatments.map(treatmentRowAmount);
  const treatmentTotal = treatmentAmounts.length > 0 && treatmentAmounts.every((amount) => amount > 0)
    ? treatmentAmounts.reduce((sum, amount) => sum + amount, 0)
    : 0;
  if (treatmentTotal > 0) return Math.round(treatmentTotal * 100) / 100;
  const sameDayTreatmentTotal = Number(frequency.sameDayTreatmentTotal);
  if (Number.isFinite(sameDayTreatmentTotal) && sameDayTreatmentTotal > 0) {
    return Math.round(sameDayTreatmentTotal * 100) / 100;
  }
  const perVisit = firstPositiveNumber(frequency.perVisit, frequency.perApp, frequency.pa);
  if (perVisit) return Math.round(perVisit * 100) / 100;
  if (Number.isFinite(monthly) && monthly > 0) {
    return Math.round(monthly * billingIntervalMonths(frequency) * 100) / 100;
  }
  return null;
}

export default function PaymentPreferenceButtons({
  onSelect,
  disabled,
  serviceMode,
  setupFee,
  invoiceMode = false,
  // Payment-only accept (guarantee-only renewal): invoice mode with NO visit
  // to book — the one-time copy must not say "Book".
  invoiceOnly = false,
  annualPrepayEligible = false,
  selectedFrequency = null,
  cardHold = null,
  siteConfirmationHold = false,
  // Total of one-time services on the estimate that are NOT part of the
  // setup + first-application invoice (they're billed after completion).
  // Without this note, the invoice preview reads as the whole cost.
  oneTimeExtrasTotal = 0,
}) {
  const isOneTime = serviceMode === 'one_time';
  const oneTimeBooking = isOneTime && !invoiceOnly;
  // A narrow low-confidence commercial estimate is approved online but its exact
  // price is confirmed on site before any invoice — so the recurring flow must
  // NOT promise (or preview) an invoice, whatever the billing mode: the server
  // skips the first-invoice mint / first-application invoice / auto-send for
  // these accepts.
  const heldRecurring = siteConfirmationHold && !isOneTime;
  const heldForSiteConfirmation = invoiceMode && heldRecurring;
  const waivableSetupFee = setupFee && setupFee.waivedWithPrepay ? setupFee : null;
  // A ranged (site-confirmation) price must never be prepaid — the annual prepay
  // invoice is an exact 12-month amount, minted before the on-site confirmation.
  // The accept handler rejects it too (fail-closed); hiding it here keeps the
  // customer from selecting a dead-end option.
  const offerPrepay = !invoiceMode && !isOneTime && !siteConfirmationHold && (annualPrepayEligible || !!waivableSetupFee);
  const setupAmount = Number(setupFee?.amount);
  const hasSetupInvoice = Number.isFinite(setupAmount) && setupAmount > 0;
  const firstVisit = firstVisitAmount(selectedFrequency || {});

  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
  };
  const optionNote = {
    fontSize: 14,
    color: W.textCaption,
    lineHeight: 1.45,
    marginTop: 8,
    padding: '0 2px',
    textAlign: 'center',
  };
  const optionWrap = { textAlign: 'center' };
  // Held estimates preview NO exact invoice rows — a "First service visit $X"
  // figure would contradict the "$X–$Y, confirmed on site" range, and the
  // accept intentionally creates no invoice to open.
  const invoiceRows = heldRecurring ? [] : [
    ...(hasSetupInvoice ? [{ label: 'WaveGuard Membership Setup', amount: setupAmount }] : []),
    ...(firstVisit ? [{ label: 'First service visit', amount: firstVisit }] : []),
  ];
  const invoiceTotal = Math.round(invoiceRows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;
  const hasFirstVisitInvoice = Number(firstVisit || 0) > 0;
  const payPerApplicationInvoiceLabel = hasSetupInvoice && hasFirstVisitInvoice
    ? 'setup + first application invoice'
    : hasSetupInvoice
      ? 'setup invoice'
      : hasFirstVisitInvoice
        ? 'first application invoice'
        : 'invoice';

  const payPerApplicationLabel = isOneTime ? 'Book visit' : 'Pay per application';
  const fineprint = offerPrepay
    ? `Choose pay per application with a ${payPerApplicationInvoiceLabel} after confirmation, or annual prepay to approve the 12-month plan up front with setup included.`
    : invoiceMode
      ? 'No card setup here. Once you accept, we send an invoice pay link due immediately.'
      : isOneTime
        ? 'This books a single visit. We do not charge you now.'
        : heldRecurring
          ? 'No payment now — we confirm your exact price on a quick site visit, then bill each application after service.'
          : invoiceRows.length > 0
            ? `Choose pay per application and we will send the ${payPerApplicationInvoiceLabel} after confirmation.`
            : 'Choose pay per application. Your first service visit will be billed after completion.';
  const payPerApplicationOptionNote = heldRecurring
    ? 'Approve now — no payment today. We confirm your exact price on site before your first invoice.'
    : invoiceRows.length > 0
      ? 'Approve now; after confirmation we send the invoice and open secure payment.'
      : 'Approve now; your first service visit will be billed after completion.';

  if (invoiceMode) {
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16 }}>
          {oneTimeBooking ? 'Book your visit' : 'Accept your estimate'}
        </div>

        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('pay_at_visit')}
          style={{ ...btnBase, background: ACTION_BG, color: W.white }}
        >
          {heldForSiteConfirmation
            ? 'Accept your estimate'
            : oneTimeBooking ? 'Book + send invoice' : 'Accept + send invoice'}
        </button>

        <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
          {heldForSiteConfirmation
            ? 'No payment now — your Waves account manager confirms the exact price on a quick site visit, then sends your first invoice.'
            : fineprint}
        </div>
      </div>
    );
  }

  if (isOneTime) {
    // Card-on-file hold (dark until ONE_TIME_CARD_HOLD). When required, the
    // customer saves a card to reserve the visit — NOT charged today. The card
    // is charged the final total on completion; a flat fee applies only on a
    // no-show / late cancel. The selection stays 'pay_at_visit' — the hold is
    // an orthogonal saved card, captured at confirm time, not a new payment
    // method preference.
    const holdRequired = !!cardHold?.requiredForOneTime;
    const feeText = fmtMoney(cardHold?.noShowFeeAmount != null ? cardHold.noShowFeeAmount : 49);
    const windowText = `${cardHold?.cancelWindowHours != null ? cardHold.cancelWindowHours : 24} hours`;
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16 }}>
          {holdRequired ? 'Hold your appointment' : 'Book your visit'}
        </div>

        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('pay_at_visit')}
          style={{ ...btnBase, background: ACTION_BG, color: W.white }}
        >
          {holdRequired ? 'Add a card to hold your appointment' : 'Book + pay on service day'}
        </button>

        <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
          {holdRequired
            ? `We don't charge you today. Your card is charged the final total after your visit is completed. A ${feeText} fee applies only if you cancel within ${windowText} or aren't home. Credit cards add a small processing fee; debit and bank cards don't.`
            : fineprint}
        </div>
      </div>
    );
  }

  return (
    <div style={estimateCard()}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16 }}>
        {isOneTime ? 'Book your visit' : 'Reserve your spot'}
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div style={optionWrap}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect('pay_at_visit')}
            style={{ ...btnBase, background: ACTION_BG, color: W.white }}
          >{payPerApplicationLabel}</button>
          <div style={optionNote}>{payPerApplicationOptionNote}</div>
          {invoiceRows.length > 0 ? (
            <div style={{
              marginTop: 16,
              border: `1px solid ${W.border}`,
              borderRadius: 12,
              padding: 16,
              background: '#F8FAFC',
              textAlign: 'left',
            }}>
              {invoiceRows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'baseline',
                    fontSize: 14,
                    color: W.navy,
                    lineHeight: 1.4,
                    marginBottom: 8,
                  }}
                >
                  <span>{row.label}</span>
                  <strong style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(row.amount)}</strong>
                </div>
              ))}
              {invoiceTotal > 0 ? (
                <div style={{
                  borderTop: `1px solid ${W.border}`,
                  paddingTop: 12,
                  marginTop: 2,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  alignItems: 'baseline',
                  fontSize: 14,
                  fontWeight: 800,
                  color: W.blueDeeper,
                }}>
                  <span>Invoice total</span>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(invoiceTotal)}</strong>
                </div>
              ) : null}
              <div style={{ fontSize: 13, color: W.textCaption, lineHeight: 1.45, marginTop: 12 }}>
                No payment is charged on this page. After confirmation, we open the invoice
                {invoiceTotal > 0 ? ` for ${fmtMoney(invoiceTotal)}` : ''} so you can pay in-flow.
                {Number(oneTimeExtrasTotal) > 0
                  ? ` One-time services on this estimate (${fmtMoney(oneTimeExtrasTotal)}) are billed separately after they're completed.`
                  : ''}
              </div>
            </div>
          ) : null}
        </div>
        {offerPrepay && (
          <div style={optionWrap}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect('prepay_annual')}
              style={{ ...btnBase, background: ACTION_BG, color: W.white, position: 'relative' }}
            >
              Pay the 12-month plan in full
            </button>
            <div style={optionNote}>
              {waivableSetupFee
                ? `Approve annual prepay and the setup is included at no charge.`
                : '12-month invoice opens after confirmation.'}
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
        {fineprint}
      </div>
    </div>
  );
}
