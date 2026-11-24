import React from 'react';
import { fmtMoney } from '../../lib/money';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { estimateCard } from './cardStyles';
import { W } from './tokens';
import { FIRST_INVOICE_AT_CONFIRM_COPY } from '../../lib/paymentTiming';
import { payPerApplicationTimingNote } from './PaymentPreferenceButtons';

/**
 * "What you pay and when" (owner 2026-11-23): a plain box under the price on a residential recurring
 * estimate. People who got an estimate asked what the $99 line was, why booking showed $177 when the
 * estimate said $91.50 a month, and whether a service was billed monthly. The box answers in order:
 * what is due today, the first visit itemised, each visit after, the first year, and the setup fee.
 *
 * It prices nothing. Every dollar is a figure the page already shows: the per-application price and
 * visit count of each service (the monthly-average model, which reconciles them to the plan's own
 * monthly), and the server's setup fee. The per-application price stays THE price; a monthly figure
 * never appears here. `buildWhatYouPay` returns null whenever the first bill is not proven to be
 * those figures (a credit, another first-visit fee, an up-front row beside the setup fee), so the
 * page then renders exactly as before.
 */

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const sameCents = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const isSetupFee = (fee) => fee?.service === 'waveguard_setup';
const positiveFees = (fees) => (Array.isArray(fees) ? fees : []).filter((fee) => Number(fee?.amount) > 0);

const visitsText = (visits) => (visits === 1 ? 'once a year' : `${visits} visits a year in all, the first one included`);

// The one answer to "what is due today", for the choice the customer is looking at. Pay per
// application reads the same sentence the "Reserve your spot" box prints; the prepay lines mirror
// that box's and the confirm step's.
export function dueTodayText({
  paymentPreference = null, prepayInLane = false, prepayAfterVisit = false, prepayCardCapture = false,
  paymentTiming = null, setupBilledWithFirstVisit = false, hasUpFrontInvoice = true,
} = {}) {
  if (paymentPreference === 'prepay_annual') return prepayText({ prepayInLane, prepayAfterVisit });
  const note = payPerApplicationTimingNote({ setupBilledWithFirstVisit, paymentTiming, prepayCardCapture });
  if (note) return note;
  if (paymentTiming?.firstInvoice === 'at_confirm') return FIRST_INVOICE_AT_CONFIRM_COPY;
  return hasUpFrontInvoice
    ? 'We send your first invoice after you approve, with a link to pay.'
    : 'Nothing due today. Your first visit is billed after it is completed.';
}

function prepayText({ prepayInLane, prepayAfterVisit }) {
  if (prepayInLane && prepayAfterVisit) return 'Nothing due today. You pay the year in one payment, after your first visit.';
  if (prepayInLane) return 'You pay the year in one payment when you approve.';
  return 'We open your 12-month invoice after you approve.';
}

function setupFeeSentence(fee, prepayWaivable) {
  const amount = fmtMoney(fee.amount);
  const base = `The ${amount} setup fee is a one-time charge to start a plan with one service. Plans with two or more services do not pay it.`;
  return prepayWaivable ? `${base} It is also waived if you prepay the year.` : base;
}

function prepayOfferSentence({ setupFee, prepayWaivable, prepayInLane, prepayAfterVisit }) {
  if (!prepayWaivable) return 'You can also prepay the year in one payment. We show your exact total before you confirm.';
  const when = prepayInLane
    ? (prepayAfterVisit ? 'You pay once, after your first visit.' : 'You pay once, when you approve.')
    : 'You pay once, by invoice after you approve.';
  return `Prepay the year and the ${fmtMoney(setupFee.amount)} setup fee is waived. ${when}`;
}

// The plan the box describes: recurring, per application, billed by card, nothing else on the first bill.
function describablePlan(input) {
  const { model, serviceMode, invoiceMode, siteConfirmationHold, commercial, creditApplies, oneTimeExtrasTotal, upFrontRowCount } = input;
  if (serviceMode !== 'recurring' || invoiceMode || siteConfirmationHold || commercial) return false;
  if (!model || model.credit || creditApplies || upFrontRowCount > 0 || Number(oneTimeExtrasTotal) > 0) return false;
  const charged = positiveFees(input.fees);
  // Another first-visit fee (the initial cockroach treatment): the first bill is more than the lines here.
  if (charged.some((fee) => !isSetupFee(fee))) return false;
  // The setup fee is charged on a one-service plan only; a bundle that carries one is not a plan this box describes.
  return !(charged.length > 0 && model.multi);
}

// A prepaid year with the setup fee waived is the visits at their price. Any other prepay carries a
// server-side discount this page does not know, so no figure is promised for it.
function yearFigures({ prepaySelected, prepayWaivable, visitsTotal, feeAmount }) {
  if (prepaySelected) return { yearTotal: prepayWaivable ? visitsTotal : null, yearNote: null };
  return { yearTotal: round2(visitsTotal + feeAmount), yearNote: feeAmount > 0 ? `Includes the ${fmtMoney(feeAmount)} setup fee.` : null };
}

const sumOf = (services, pick) => round2(services.reduce((sum, s) => sum + pick(s), 0));

// Everything the box prints, or null when the first bill is not proven to be these figures.
export function buildWhatYouPay(input = {}) {
  if (!describablePlan(input)) return null;
  const { model, paymentPreference = null, due = {} } = input;
  const firstApplications = sumOf(model.services, (s) => s.perApplication);
  // The proof: the "Reserve your spot" box's first application is the sum of these prices to the cent.
  if (!(input.invoiceFirstVisit > 0) || !sameCents(input.invoiceFirstVisit, firstApplications)) return null;
  const setupFee = positiveFees(input.fees).find(isSetupFee) || null;
  const prepayWaivable = setupFee?.waivedWithPrepay === true;
  const prepaySelected = paymentPreference === 'prepay_annual';
  const feeAmount = setupFee ? round2(setupFee.amount) : 0;
  const visitsTotal = sumOf(model.services, (s) => s.perApplication * s.visits);
  return {
    dueToday: dueTodayText({ ...due, paymentPreference }),
    prepaySelected,
    lines: model.services.map((s) => ({ key: s.key, label: s.label, amount: s.perApplication, visits: s.visits })),
    setup: setupFee ? { amount: feeAmount, waived: prepaySelected && prepayWaivable } : null,
    firstVisitTotal: round2(firstApplications + feeAmount),
    ...yearFigures({ prepaySelected, prepayWaivable, visitsTotal, feeAmount }),
    setupSentence: setupFee ? setupFeeSentence(setupFee, prepayWaivable) : null,
    prepaySentence: input.annualPrepayOffered && !prepaySelected
      ? prepayOfferSentence({ setupFee, prepayWaivable, prepayInLane: due.prepayInLane, prepayAfterVisit: due.prepayAfterVisit })
      : null,
    // The page also shows a monthly figure; say once that it is the year averaged, not a bill.
    averageSentence: input.monthlyShown ? 'Any monthly figure on this page is the year averaged out. It is not a bill.' : null,
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

function FirstVisitRows({ box }) {
  const itemised = box.lines.length > 1 || box.setup;
  return (
    <>
      <div style={HEADING}>First visit</div>
      {box.lines.map((line) => <Row key={line.key} label={line.label} amount={fmtMoney(line.amount)} />)}
      {box.setup ? <Row label="Setup fee" amount={fmtMoney(box.setup.amount)} /> : null}
      {itemised ? <div data-first-visit-total="" style={TOTAL}><span>First visit total</span><span style={NUM}>{fmtMoney(box.firstVisitTotal)}</span></div> : null}
      <div style={{ ...HEADING, paddingTop: 8, borderTop: `1px solid ${W.offWhite}` }}>Each visit after that</div>
      {box.lines.map((line) => <Row key={line.key} label={line.label} amount={fmtMoney(line.amount)} sub={visitsText(line.visits)} />)}
    </>
  );
}

function PrepayRows({ box }) {
  return (
    <>
      <div style={HEADING}>If you prepay the year</div>
      {box.setup?.waived ? <Row label="Setup fee" amount="Waived" /> : null}
      <Row
        label="12 months of service"
        amount={box.yearTotal == null ? 'Shown before you confirm' : fmtMoney(box.yearTotal)}
        sub={box.lines.map((line) => `${line.label}: ${fmtMoney(line.amount)} × ${line.visits}`).join(' · ')}
      />
    </>
  );
}

export default function WhatYouPayBox({ box }) {
  if (!box) return null;
  return (
    <section data-what-you-pay="" style={estimateCard()}>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={HEADING}>What you pay and when</div>
        <div style={{ ...HEADING, paddingTop: 4 }}>Due today</div>
        <div data-due-today="" style={{ fontSize: 16, color: CUSTOMER_SURFACE.text, lineHeight: 1.5 }}>{box.dueToday}</div>
        <div style={{ borderTop: `1px solid ${W.offWhite}` }} />
        {box.prepaySelected ? <PrepayRows box={box} /> : <FirstVisitRows box={box} />}
        {!box.prepaySelected && box.yearTotal != null ? (
          <div data-year-total="" style={TOTAL}>
            <span>
              First year total
              {box.yearNote ? <div style={SUB}>{box.yearNote}</div> : null}
            </span>
            <span style={NUM}>{fmtMoney(box.yearTotal)}</span>
          </div>
        ) : null}
      </div>
      {[box.setupSentence, box.prepaySentence, box.averageSentence].filter(Boolean).map((text) => (
        <div key={text} style={{ marginTop: 10, ...SUB }}>{text}</div>
      ))}
    </section>
  );
}
