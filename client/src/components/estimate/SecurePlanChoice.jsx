/**
 * Plan choice for the /secure appointment page (GATE_SECURE_PLAN_CHOICE
 * lane): pay per application vs. prepay the year. Purpose-built sibling of
 * PaymentPreferenceButtons — that component's props/copy are estimate-accept
 * shaped (reserve/invoice previews); this one renders purely from the
 * server's planContext payload. Every amount and label comes from the
 * server — no pricing constants live in the client (the $99 and the 5% are
 * server-derived; hardcoding either here is the drift the contract tests
 * reject).
 *
 * Visual spec: the owner-approved 2026-07-24 mockups (white selectable
 * cards, navy selection ring, soft blue selected wash, green/amber badges)
 * — estimateInnerBox + the W palette, same idiom as the estimate page's
 * frequency/preference pickers.
 */
import React from 'react';
import { estimateInnerBox } from './cardStyles';
import { W } from './tokens';
import { fmtMoney } from '../../lib/money';
import { CARD_SURCHARGE_DISCLOSURE } from './PaymentPreferenceButtons';

const NAVY = W.blueDeeper;

function Badge({ tone, children }) {
  const tones = {
    green: { background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#047857' },
    amber: { background: '#FFF9DB', border: '1px solid #F1E2A0', color: '#8A6D00' },
  };
  return (
    <span style={{
      display: 'inline-block',
      marginTop: 8,
      fontSize: 12,
      fontWeight: 700,
      padding: '3px 9px',
      borderRadius: 999,
      ...tones[tone],
    }}
    >
      {children}
    </span>
  );
}

function Radio({ selected }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 14,
        right: 14,
        width: 19,
        height: 19,
        borderRadius: '50%',
        border: `2px solid ${selected ? NAVY : '#D8D0C0'}`,
        background: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected ? <span style={{ width: 9, height: 9, borderRadius: '50%', background: NAVY }} /> : null}
    </span>
  );
}

function PlanOption({ selected, disabled, onClick, title, price, priceSuffix, strike, sub, badge }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      style={{
        ...estimateInnerBox({
          position: 'relative',
          width: '100%',
          textAlign: 'left',
          padding: '14px 14px 13px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }),
        ...(selected
          ? { border: `1.5px solid ${NAVY}`, boxShadow: `0 0 0 1px ${NAVY}`, background: '#F8FCFE' }
          : {}),
      }}
    >
      <Radio selected={selected} />
      <div style={{ fontSize: 15, fontWeight: 800, color: NAVY, paddingRight: 30 }}>{title}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: NAVY, marginTop: 5 }}>
        {strike ? (
          <span style={{ textDecoration: 'line-through', color: W.textCaption, fontWeight: 600, fontSize: 14, marginRight: 6 }}>
            {strike}
          </span>
        ) : null}
        {price}
        {priceSuffix ? (
          <span style={{ fontSize: 13, fontWeight: 600, color: W.textCaption }}> {priceSuffix}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 13, color: W.textBody, lineHeight: 1.5, marginTop: 5 }}>{sub}</div>
      {badge || null}
    </button>
  );
}

export default function SecurePlanChoice({ planContext, selected, onSelect, disabled = false }) {
  if (!planContext || planContext.mode !== 'recurring') return null;
  const { perVisit, visitsPerYear, annualBase, prepay, setupFee, planClass } = planContext;
  const discounted = planClass === 'discount' && prepay.discount > 0;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <PlanOption
          selected={selected === 'per_application'}
          disabled={disabled}
          onClick={() => onSelect('per_application')}
          title="Pay per application"
          price={fmtMoney(perVisit)}
          priceSuffix="/ application"
          sub={setupFee
            ? `Plus a one-time ${fmtMoney(setupFee.amount)} setup fee on your first visit's invoice. Nothing is charged today — your card is charged automatically after each completed service.`
            : 'Nothing is charged today — your card is charged automatically after each completed service.'}
          badge={setupFee ? <Badge tone="amber">{fmtMoney(setupFee.amount)} setup fee applies</Badge> : null}
        />
        <PlanOption
          selected={selected === 'prepay_annual'}
          disabled={disabled}
          onClick={() => onSelect('prepay_annual')}
          title={discounted ? `Prepay the year — save ${prepay.ratePctLabel}` : 'Prepay the year'}
          price={fmtMoney(prepay.total)}
          priceSuffix={`/ year · ${visitsPerYear} application${visitsPerYear === 1 ? '' : 's'}`}
          strike={discounted ? fmtMoney(annualBase) : null}
          sub={setupFee
            ? `Pay once today and the ${fmtMoney(setupFee.amount)} setup fee is waived. No charges after your visits.`
            : 'Pay once today. No charges after your visits.'}
          badge={setupFee
            ? <Badge tone="green">{fmtMoney(setupFee.amount)} setup fee waived</Badge>
            : (discounted ? <Badge tone="green">You save {fmtMoney(prepay.discount)}</Badge> : null)}
        />
      </div>
      <p style={{ fontSize: 12, color: W.textCaption, lineHeight: 1.5, marginTop: 11, marginBottom: 0 }}>
        {CARD_SURCHARGE_DISCLOSURE}
      </p>
    </div>
  );
}
