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
const positiveFees = (fees) => (Array.isArray(fees) ? fees : []).filter((fee) => Number(fee?.amount) > 0);

const applicationsText = (visits) => (visits === 1 ? 'once a year' : `${visits} applications a year, counting the first`);

// The waiver clause only when the page offers the annual prepay and the server marks this fee waivable with it.
function setupFeeSentence(fee, prepayWaivable) {
  const base = `The ${fmtMoney(fee.amount)} setup fee is a one-time charge to start a plan with one recurring service. Plans with two or more recurring services do not pay it.`;
  return prepayWaivable ? `${base} It is also waived if you prepay the year.` : base;
}

// The plan the box describes: recurring, per application, billed by card, nothing else on the first bill.
function describablePlan(input) {
  const { model, serviceMode, invoiceMode, siteConfirmationHold, commercial, creditApplies, oneTimeExtrasTotal, upFrontRowCount } = input;
  if (serviceMode !== 'recurring' || invoiceMode || siteConfirmationHold || commercial) return false;
  if (input.paymentPreference === 'prepay_annual') return false;
  if (!model || model.credit || creditApplies || upFrontRowCount > 0 || Number(oneTimeExtrasTotal) > 0) return false;
  const charged = positiveFees(input.fees);
  // Another first-visit fee (the initial cockroach treatment): the first bill is more than the lines here.
  if (charged.some((fee) => !isSetupFee(fee))) return false;
  // The setup fee is charged on a one-service plan only; a bundle that carries one is not a plan this box describes.
  return !(charged.length > 0 && model.multi);
}

// Everything the box prints, or null when the first bill is not proven to be these figures.
export function buildWhatYouPay(input = {}) {
  if (!describablePlan(input)) return null;
  const { model } = input;
  const firstApplications = round2(model.services.reduce((sum, s) => sum + s.perApplication, 0));
  // The proof: the "Reserve your spot" box's first application is the sum of these prices to the cent.
  if (!(input.invoiceFirstVisit > 0) || !sameCents(input.invoiceFirstVisit, firstApplications)) return null;
  const setupFee = positiveFees(input.fees).find(isSetupFee) || null;
  const feeAmount = setupFee ? round2(setupFee.amount) : 0;
  const prepayWaivable = input.annualPrepayOffered === true && setupFee?.waivedWithPrepay === true;
  return {
    lines: model.services.map((s) => ({ key: s.key, label: s.label, amount: s.perApplication, visits: s.visits })),
    setup: setupFee ? { amount: feeAmount } : null,
    firstVisitTotal: round2(firstApplications + feeAmount),
    setupSentence: setupFee ? setupFeeSentence(setupFee, prepayWaivable) : null,
    // The page also shows a monthly figure; say once that it is the year averaged, not a bill.
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
