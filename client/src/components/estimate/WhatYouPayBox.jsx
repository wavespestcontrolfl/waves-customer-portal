import React from 'react';
import { fmtMoney } from '../../lib/money';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

/**
 * "What you pay" (owner 2026-11-23): a plain box under the price on a residential recurring
 * estimate. People who got an estimate asked what the $99 line was, why booking showed $177 when the
 * estimate said $91.50 a month, and whether a service was billed monthly. The box shows the first
 * visit itemised, each application after that, and the setup fee in a sentence. It states no plan
 * total (AGENTS.md) and says nothing about when money moves or about prepay: the "Reserve your spot"
 * box owns payment timing and the prepay choice.
 *
 * It prices nothing. Every dollar is a figure the page already shows: the per-application price and
 * application count of each service (the monthly-average model, which reconciles them to the plan's
 * own monthly), and the server's setup fee. The per-application price stays THE price; a monthly
 * figure never appears here. `buildWhatYouPay` returns null whenever the first bill is not proven to
 * be those figures (a credit, another first-visit fee, an up-front row beside the setup fee, the
 * annual prepay choice), so the page then renders exactly as before.
 */

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sameCents = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const isSetupFee = (fee) => fee?.service === 'waveguard_setup';

const applicationsText = (visits) => (visits === 1 ? 'once a year' : `${visits} applications a year, counting the first`);

// This plan's own fee, not the general rule: the converter charges the setup only for a solo pest or
// mosquito plan and the lanes differ on when it is billed, so the sentence names neither. The waiver
// clause only when the page offers the annual prepay and the server marks this fee waivable with it.
function setupFeeSentence(fee, prepayWaivable) {
  const base = `This plan has a one-time ${fmtMoney(fee.amount)} setup fee.`;
  return prepayWaivable ? `${base} It is waived if you prepay the year.` : base;
}

// Fee rows the page holds, from every source. A row that carries a price but no usable `amount` (a frozen
// or legacy shape) cannot be read as "no fee", so it blocks the box.
const PRICE_KEYS = ['price', 'priceAfterDiscount', 'displayPrice', 'perTreatment'];
const hasPositiveAmount = (row) => Number.isFinite(Number(row?.amount)) && Number(row.amount) > 0;
const carriesPrice = (row) => PRICE_KEYS.some((key) => row?.[key] != null);
const feeRowsOf = (input) => [...(Array.isArray(input.fees) ? input.fees : []), ...(Array.isArray(input.otherFeeRows) ? input.otherFeeRows : [])]
  .filter((row) => row && typeof row === 'object');
const feeRowsUnreadable = (input) => feeRowsOf(input).some((row) => carriesPrice(row) && !hasPositiveAmount(row));

// The one-time breakdown must hold nothing, except the WaveGuard setup row the first-visit line itself
// proves (same amount as the line's setup). Any other row, of any kind, means a first bill this box
// cannot describe (a bait-station setup, an add-on, a discount): no box.
function breakdownIsClean(input) {
  // With a one-time option on the estimate the breakdown is the ALTERNATE one-time price (an either/or
  // choice, not a charge beside the plan), so it says nothing about this bill. The real recurring charges
  // are still read from the fee rows, the up-front rows and the first-visit line.
  if (input.showOneTimeOption === true) return true;
  const items = Array.isArray(input.oneTimeItems) ? input.oneTimeItems : [];
  const setup = Number(input.firstVisit?.setup);
  return items.every((item) => item?.service === 'waveguard_setup' && setup > 0 && sameCents(Number(item.amount), setup));
}

// Every displayed service must have its own priced row in the selected frequency: the first application
// the page quotes is read from those rows, and falls back to a same-day total when a row is unpriced
// (a partly priced bundle). Rows are matched by service key; an extra, missing or unpriced row means no box.
const ROW_PRICE_KEYS = ['displayPrice', 'priceAfterDiscount', 'netPerTreatment', 'price', 'perTreatment', 'perApp', 'perVisit', 'pa'];
const rowIsPriced = (row) => ROW_PRICE_KEYS.some((key) => Number(row?.[key]) > 0);
function everyServicePriced(input) {
  const rows = Array.isArray(input.treatmentRows) ? input.treatmentRows : [];
  const services = input.model.services;
  return rows.length === services.length && rows.every(rowIsPriced)
    && services.every((service) => rows.some((row) => row?.service === service.key));
}

// The plan the box describes: recurring, per application, billed by card, nothing else on the first bill.
// Fails closed: any doubt about a fee row or the one-time breakdown returns false.
function describablePlan(input) {
  const { model, serviceMode, invoiceMode, siteConfirmationHold, commercial, creditApplies, oneTimeExtrasTotal, upFrontRowCount } = input;
  if (serviceMode !== 'recurring' || invoiceMode || siteConfirmationHold || commercial) return false;
  if (input.paymentPreference === 'prepay_annual') return false;
  if (!model || model.credit || creditApplies || upFrontRowCount > 0 || Number(oneTimeExtrasTotal) > 0) return false;
  return !feeRowsUnreadable(input) && breakdownIsClean(input) && everyServicePriced(input);
}

// The setup fee comes from ONE place: the page's existing first-visit line (`firstVisit`, the figure
// PriceFollowUps prints, from firstVisitTotalPreview). Fee lists are not read to build a fee row:
// - the line exists: its application must be the sum of these prices to the cent; the fee is its setup
//   and the box's first-visit total is its total, never another figure;
// - no line: the box states no fee, and only when no fee row with a positive amount appears anywhere.
// Any mismatch or doubt returns null.
function proofOfFirstVisit(input, applications) {
  const line = input.firstVisit || null;
  if (!line) return feeRowsOf(input).some(hasPositiveAmount) ? null : { fee: 0, total: applications };
  if (input.model.services.length !== 1 || !sameCents(line.firstApplication, applications)) return null;
  // Another first-visit fee (the initial cockroach treatment) is more than the line's two parts.
  if (feeRowsOf(input).some((row) => hasPositiveAmount(row) && !isSetupFee(row))) return null;
  const fee = round2(line.setup);
  return sameCents(line.total, applications + fee) && fee > 0 ? { fee, total: round2(line.total) } : null;
}

// Everything the box prints, or null when the first bill is not proven to be these figures.
export function buildWhatYouPay(input = {}) {
  if (!describablePlan(input)) return null;
  const { model } = input;
  const applications = round2(model.services.reduce((sum, s) => sum + s.perApplication, 0));
  // The "Reserve your spot" box's first application is the sum of these prices to the cent.
  if (!(input.invoiceFirstVisit > 0) || !sameCents(input.invoiceFirstVisit, applications)) return null;
  const proof = proofOfFirstVisit(input, applications);
  if (!proof) return null;
  const feeRow = feeRowsOf(input).find((row) => isSetupFee(row) && hasPositiveAmount(row)) || null;
  const prepayWaivable = input.annualPrepayOffered === true && feeRow?.waivedWithPrepay === true;
  return {
    lines: model.services.map((s) => ({ key: s.key, label: s.label, amount: s.perApplication, visits: s.visits })),
    setup: proof.fee > 0 ? { amount: proof.fee } : null,
    firstVisitTotal: proof.total,
    setupSentence: proof.fee > 0 ? setupFeeSentence({ amount: proof.fee }, prepayWaivable) : null,
  };
}

const ROW = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', fontSize: 16, color: CUSTOMER_SURFACE.text };
const NUM = { fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' };
const SUB = { fontSize: 14, color: CUSTOMER_SURFACE.muted, fontWeight: 500, lineHeight: 1.5 };
const HEADING = { fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: CUSTOMER_SURFACE.muted };
const TOTAL = { ...ROW, fontWeight: 700, paddingTop: 8, borderTop: `1px solid ${W.offWhite}` };

function Row({ label, amount, sub = null }) {
  return (
    <div style={ROW}>
      <span>
        {label}
        {sub ? <div style={SUB}>{sub}</div> : null}
      </span>
      <span style={NUM}>{amount}</span>
    </div>
  );
}

export default function WhatYouPayBox({ box }) {
  if (!box) return null;
  const itemised = box.lines.length > 1 || box.setup;
  return (
    <section data-what-you-pay="" style={estimateCard()}>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={HEADING}>What you pay</div>
        <div style={{ ...HEADING, paddingTop: 4 }}>First visit</div>
        {box.lines.map((line) => <Row key={line.key} label={line.label} amount={fmtMoney(line.amount)} />)}
        {box.setup ? <Row label="Setup fee" amount={fmtMoney(box.setup.amount)} /> : null}
        {itemised ? <div data-first-visit-total="" style={TOTAL}><span>First visit total</span><span style={NUM}>{fmtMoney(box.firstVisitTotal)}</span></div> : null}
        <div style={{ ...HEADING, paddingTop: 8, borderTop: `1px solid ${W.offWhite}` }}>Each application after that</div>
        {box.lines.map((line) => <Row key={line.key} label={line.label} amount={fmtMoney(line.amount)} sub={applicationsText(line.visits)} />)}
      </div>
      {[box.setupSentence].filter(Boolean).map((text) => (
        <div key={text} style={{ marginTop: 10, ...SUB }}>{text}</div>
      ))}
    </section>
  );
}
