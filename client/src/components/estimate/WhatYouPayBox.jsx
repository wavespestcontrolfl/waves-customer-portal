import React from 'react';
import { fmtMoney } from '../../lib/money';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

/**
 * "What you pay" (owner 2026-11-23): a plain box under the price on a residential recurring
 * estimate. People who got an estimate asked what the $99 line was, why booking showed $177 when the
 * estimate said $91.50 a month, and whether a service was billed monthly.
 *
 * The page derives NOTHING here. The server's /data `whatYouPay` is built from the functions the accept path
 * mints the first invoice with (estimate-public.js whatYouPayForData) and is null whenever those cannot
 * resolve; this box prints it as given. The only client decision is whether the customer is still on the
 * selection the server priced: `whatYouPayForSelection` compares the selection identifiers, never a price.
 * It states no plan total and nothing about when money moves or about prepay: the "Reserve your spot" box
 * owns payment timing and the prepay choice. The one prepay mention is the setup fee's waiver clause.
 */

const sameCadences = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());

// The server payload when the page is on the selection it priced (frequency key + per-service cadences), else null.
export function whatYouPayForSelection(payload, { frequency = null, serviceCadences = null } = {}) {
  if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) return null;
  const selection = payload.selection || {};
  if (!frequency || selection.frequency !== frequency || !sameCadences(selection.serviceCadences, serviceCadences)) return null;
  return payload;
}

const applicationsText = (n) => (n === 1 ? 'once a year' : `${n} applications a year, counting the first`);

function setupFeeSentence(amount, waivedWithPrepay) {
  const base = `This plan has a one-time ${fmtMoney(amount)} setup fee.`;
  return waivedWithPrepay ? `${base} It is waived if you prepay the year.` : base;
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
  const hasSetup = Number(box.setupFee) > 0;
  return (
    <section data-what-you-pay="" style={estimateCard()}>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={HEADING}>What you pay</div>
        <div style={{ ...HEADING, paddingTop: 4 }}>First visit</div>
        {box.lines.map((line) => <Row key={line.key} label={line.label} amount={fmtMoney(line.perApplication)} />)}
        {hasSetup ? <Row label="Setup fee" amount={fmtMoney(box.setupFee)} /> : null}
        {box.lines.length > 1 || hasSetup ? (
          <div data-first-visit-total="" style={TOTAL}><span>First visit total</span><span style={NUM}>{fmtMoney(box.firstVisitTotal)}</span></div>
        ) : null}
        <div style={{ ...HEADING, paddingTop: 8, borderTop: `1px solid ${W.offWhite}` }}>Each application after that</div>
        {box.lines.map((line) => (
          <Row key={line.key} label={line.label} amount={fmtMoney(line.perApplication)} sub={applicationsText(line.applicationsPerYear)} />
        ))}
      </div>
      {hasSetup ? <div style={{ marginTop: 10, ...SUB }}>{setupFeeSentence(box.setupFee, box.setupWaivedWithPrepay === true)}</div> : null}
    </section>
  );
}
