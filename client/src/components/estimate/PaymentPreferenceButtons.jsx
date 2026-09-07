import React from 'react';
import { estimateCard } from './cardStyles';
import { fmtMoney } from '../../lib/money';
import { CARD_CONSENT_TEXT } from '../../lib/paymentMethodConsentText';
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

// Quantified card-fee disclosure for every point where the customer consents
// to a card on file. The "up to X%" phrase is extracted VERBATIM from the
// canonical, versioned consent copy (lib/paymentMethodConsentText.js — the
// client mirror of server/services/payment-method-consent-text.js, which is
// version-locked to the server surcharge policy in
// server/services/stripe-pricing.js / computeChargeAmount). Never hardcode a
// percentage here and never derive one from a second client-side rate
// constant (lib/cardSurcharge.js is charge-preview MATH, not disclosure
// copy): AGENTS.md classifies a disclosure figure drifting from the server
// policy as a P0. When the rate changes, the consent module bumps its
// version and this copy follows automatically.
const SURCHARGE_RATE_PHRASE = (CARD_CONSENT_TEXT.match(/up to \d+(?:\.\d+)?%/) || [])[0];
export const CARD_SURCHARGE_DISCLOSURE = SURCHARGE_RATE_PHRASE
  ? `A credit card surcharge of ${SURCHARGE_RATE_PHRASE} may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.`
  // Fail-safe: if the consent copy is ever reworded so the phrase can't be
  // extracted, disclose unquantified rather than a possibly-stale number.
  // (The unit test asserts extraction works, so CI catches the rewording.)
  : 'A credit card surcharge may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.';


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
  // Up-front rows beyond the membership setup — the rodent bait-station
  // setup (codex #3591 r33 P1): invoiced WITH the first application by both
  // accept paths, never deferred to "after completion". [{ label, amount }]
  extraInvoiceRows = [],
  // GATE_PREPAY_CARD_AND_CHARGE (server /data recurringCardPolicy.prepayInLane):
  // prepay rides the card lane — the customer saves a card at checkout and
  // the 12-month total is charged on confirmation, so the copy must not
  // promise an invoice pay link that never comes.
  prepayInLane = false,
  // Whether an in-lane prepay accept actually CAPTURES a card at checkout
  // (server recurringCardPolicy.required). False for auto-satisfy accepts
  // (saved card / Auto Pay already active) — the saved method, which may be
  // a BANK account, is charged directly with no save step, so the copy must
  // stay tender-neutral and not instruct a card save (Codex #3492 r10).
  prepayCardCapture = false,
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
  const hasWaveGuardSetupRow = Number.isFinite(setupAmount) && setupAmount > 0;
  const upFrontRows = [
    ...(hasWaveGuardSetupRow ? [{ label: 'WaveGuard Membership Setup', amount: setupAmount }] : []),
    ...(Array.isArray(extraInvoiceRows) ? extraInvoiceRows : [])
      .filter((row) => Number(row?.amount) > 0)
      .map((row) => ({ label: row.label || 'Setup', amount: Math.round(Number(row.amount) * 100) / 100 })),
  ];
  const hasSetupInvoice = upFrontRows.length > 0;
  const firstVisit = firstVisitAmount(selectedFrequency || {});

  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
    // Both option buttons share one height so the two columns line up even
    // when one label wraps.
    minHeight: 54,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  };
  const optionNote = {
    fontSize: 14,
    color: W.textCaption,
    lineHeight: 1.5,
    marginTop: 8,
    padding: '0 2px',
    textAlign: 'center',
  };
  const optionWrap = { textAlign: 'center' };
  // Held estimates preview NO exact invoice rows — a "First service visit $X"
  // figure would contradict the "$X–$Y, confirmed on site" range, and the
  // accept intentionally creates no invoice to open.
  const invoiceRows = heldRecurring ? [] : [
    ...upFrontRows,
    ...(firstVisit ? [{ label: 'Per application', amount: firstVisit }] : []),
  ];
  const invoiceTotal = Math.round(invoiceRows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;
  // Prepay preview mirrors the per-application invoice box, but shows only
  // the plan's LIST annual — never a "total" row: the invoiced amount is
  // resolved server-side (prepay discount, margin floor, commercial tax) and
  // can differ in either direction. The exact charge is quoted at the
  // confirm step (prepayChargeQuote / the minted invoice).
  const annualAmount = firstPositiveNumber(selectedFrequency?.annual);
  const prepayRows = !heldRecurring && annualAmount ? [
    ...(hasSetupInvoice && waivableSetupFee ? [{ label: 'WaveGuard Membership Setup', amountText: 'Waived' }] : []),
    // The rodent bait-station setup is NOT prepay-waived — the converter
    // adds it to the annual prepay invoice as its own collectible line
    // (codex #3591 r80 P2), so the preview must show it too or the
    // customer approves a prepay $99 under the minted invoice.
    ...(Array.isArray(extraInvoiceRows) ? extraInvoiceRows : [])
      .filter((row) => Number(row?.amount) > 0)
      .map((row) => ({ label: row.label || 'Setup', amountText: fmtMoney(Math.round(Number(row.amount) * 100) / 100) })),
    { label: '12-month plan', amountText: fmtMoney(annualAmount) },
  ] : [];
  const invoiceBox = {
    // Fill the shared box row so both boxes match top AND bottom.
    alignSelf: 'stretch',
    marginTop: 16,
    border: `1px solid ${W.border}`,
    borderRadius: 12,
    padding: 16,
    background: '#F8FAFC',
    textAlign: 'left',
  };
  const invoiceRowStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'baseline',
    fontSize: 14,
    color: W.navy,
    lineHeight: 1.35,
    marginBottom: 8,
  };
  const invoiceTotalStyle = {
    borderTop: `1px solid ${W.border}`,
    paddingTop: 12,
    marginTop: 2,
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'baseline',
    fontSize: 14,
    fontWeight: 700,
    color: W.blueDeeper,
  };
  const hasFirstVisitInvoice = Number(firstVisit || 0) > 0;
  const payPerApplicationInvoiceLabel = hasSetupInvoice && hasFirstVisitInvoice
    ? 'setup + first application invoice'
    : hasSetupInvoice
      ? 'setup invoice'
      : hasFirstVisitInvoice
        ? 'first application invoice'
        : 'invoice';
  const payPerApplicationLabel = isOneTime ? 'Book visit' : 'Pay per application';
  // No combined fineprint when both breakdown boxes render (owner
  // 2026-08-30) — the offerPrepay branch below never shows it.
  const fineprint = invoiceMode
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
      ? 'Approve now — invoice and secure payment after you approve.'
      : 'Approve now — your first application is billed after completion.';

  if (invoiceMode) {
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 14, fontWeight: 600, color: W.textCaption,
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

        <div style={{ fontSize: 14, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
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
    const feeText = fmtMoney(cardHold?.noShowFeeAmount != null ? cardHold.noShowFeeAmount : 75);
    const windowText = `${cardHold?.cancelWindowHours != null ? cardHold.cancelWindowHours : 24} hours`;
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 14, fontWeight: 600, color: W.textCaption,
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

        <div style={{ fontSize: 14, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
          {holdRequired
            ? `We don't charge you today. Your card is charged the final total after your visit is completed. A ${feeText} fee applies only if you cancel within ${windowText} or aren't home. Rescheduling is free but doesn't reset the cancellation window. ${CARD_SURCHARGE_DISCLOSURE}`
            : fineprint}
        </div>
      </div>
    );
  }

  return (
    <div style={estimateCard()}>
      <div style={{ fontSize: 14, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16 }}>
        {isOneTime ? 'Book your visit' : 'Reserve your spot'}
      </div>

      {/* Stacked (owner 2026-08-30): prepay sits BELOW the full pay-per-application
          block — button, note, breakdown — never beside it. */}
      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: '1fr' }}>
        <div style={optionWrap}>
          {invoiceRows.length > 0 ? (
            <div style={invoiceBox}>
              {invoiceRows.map((row) => (
                <div key={row.label} style={invoiceRowStyle}>
                  <span>{row.label}</span>
                  <strong style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(row.amount)}</strong>
                </div>
              ))}
              {invoiceTotal > 0 ? (
                <div style={invoiceTotalStyle}>
                  <span>Invoice total</span>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(invoiceTotal)}</strong>
                </div>
              ) : null}
              {prepayCardCapture || Number(oneTimeExtrasTotal) > 0 ? (
                <div style={{ fontSize: 14, color: W.textCaption, lineHeight: 1.5, marginTop: 12 }}>
                  {prepayCardCapture ? 'Nothing due today — Auto Pay bills your card after your first application.' : ''}
                  {Number(oneTimeExtrasTotal) > 0
                    ? ` One-time services (${fmtMoney(oneTimeExtrasTotal)}) are billed after completion.`
                    : ''}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect('pay_at_visit')}
            style={{ ...btnBase, background: ACTION_BG, color: W.white, marginTop: invoiceRows.length > 0 ? 16 : 0 }}
          >{payPerApplicationLabel}</button>
          {invoiceRows.length === 0 ? <div style={optionNote}>{payPerApplicationOptionNote}</div> : null}
        </div>
        {offerPrepay && (
          <div style={optionWrap}>
            {prepayRows.length > 0 ? (
              <div style={invoiceBox}>
                {prepayRows.map((row) => (
                  <div key={row.label} style={invoiceRowStyle}>
                    <span>{row.label}</span>
                    <strong style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{row.amountText}</strong>
                  </div>
                ))}
                {prepayInLane ? (
                  <div style={{ fontSize: 14, color: W.textCaption, lineHeight: 1.5, marginTop: 12 }}>
                    One payment covers the year — charged when you approve.
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect('prepay_annual')}
              style={{ ...btnBase, background: ACTION_BG, color: W.white, position: 'relative', marginTop: prepayRows.length > 0 ? 16 : 0 }}
            >
              Prepay 12 months
            </button>
            {prepayRows.length === 0 ? <div style={optionNote}>
              {(() => {
                // Tender-accurate in-lane copy (Codex #3492 r10): a card
                // capture instructs the save step; an auto-satisfy accept
                // charges the SAVED method (card or bank) with no save step.
                const inLaneNote = prepayCardCapture
                  ? 'Save your card at checkout; the 12-month total is charged when you confirm.'
                  : 'Your saved payment method on file is charged the 12-month total when you confirm.';
                return waivableSetupFee
                  ? `Approve the year up front — setup fee waived.${prepayInLane ? ` ${inLaneNote}` : ''}`
                  : prepayInLane
                    ? inLaneNote
                    : '12-month invoice opens after you approve.';
              })()}
            </div> : null}
          </div>
        )}
      </div>

      {/* With both breakdown boxes on screen the combined summary line is
          redundant (owner 2026-08-30) — the boxes each carry their own
          when-money-moves sentence. Other branches keep their fineprint. */}
      {!offerPrepay ? (
        <div style={{ fontSize: 14, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
          {fineprint}
        </div>
      ) : null}
    </div>
  );
}
