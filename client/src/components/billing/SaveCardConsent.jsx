// Reusable save-payment-method opt-in. Drop it next to any Stripe Payment
// Element where we want the customer to consent to saving the method for
// future charges.
//
// Controlled: parent owns `checked` + `onChange`. Read `checked` to
// decide whether to pass setup_future_usage: 'off_session' on the
// PaymentIntent (or whether to create a SetupIntent at all).
//
// When `locked` is true the box is checked + disabled — use this in
// flows where saving is a precondition (onboarding, portal add-card
// modal). The authorization copy is still shown so consent is on record.
//
// `methodType` selects the authorization copy. Card-on-file and ACH have
// different regulatory floors (NACHA/Reg E adds requirements for ACH),
// so the text is not interchangeable. Pass 'us_bank_account' or 'ach'
// for ACH; anything else (or omitted) renders the card variant.

import { useState } from 'react';
import { getConsentText } from '../../lib/paymentMethodConsentText';
import { CUSTOMER_SURFACE } from '../../theme-customer';

const CONSENT_STYLE = {
  soft: CUSTOMER_SURFACE.page,
  border: CUSTOMER_SURFACE.border,
  text: CUSTOMER_SURFACE.text,
  muted: CUSTOMER_SURFACE.muted,
};

export default function SaveCardConsent({
  checked,
  onChange,
  locked = false,
  methodType = 'card',
  headline,
  style,
  collapsible = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const isAch = methodType === 'us_bank_account' || methodType === 'ach';
  const resolvedHeadline = headline ?? (isAch
    ? 'Save this bank account on file with Waves Pest Control'
    : 'Save this payment method on file with Waves Pest Control');
  const consentText = getConsentText(methodType);
  // Display-only paragraph breaks — the canonical consent string (and its
  // CONSENT_VERSION) is unchanged; splitting must never alter characters.
  const paragraphs = consentText.split(/(?<=\.) (?=[A-Z])/);
  const isChecked = locked ? true : !!checked;
  const showText = !collapsible || expanded;
  return (
    <label
      data-glass="soft"
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: 14,
        background: CONSENT_STYLE.soft,
        border: `1px solid ${CONSENT_STYLE.border}`,
        borderRadius: 8,
        cursor: locked ? 'default' : 'pointer',
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={isChecked}
        disabled={locked}
        onChange={(e) => !locked && onChange?.(e.target.checked)}
        style={{
          width: 18, height: 18, accentColor: CONSENT_STYLE.text,
          marginTop: 2, flexShrink: 0,
          cursor: locked ? 'default' : 'pointer',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 850, color: CONSENT_STYLE.text, lineHeight: 1.35 }}>
          {resolvedHeadline}
        </div>
        {collapsible && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(e) => {
              // Inside the <label>: without preventDefault the click would
              // also toggle the checkbox.
              e.preventDefault();
              setExpanded((v) => !v);
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              marginTop: 6, padding: 0,
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 14, color: CONSENT_STYLE.muted,
              textDecoration: 'underline', fontFamily: 'inherit',
            }}
          >
            {expanded ? 'Hide full authorization' : 'View full authorization'}
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 150ms ease', transform: expanded ? 'rotate(180deg)' : 'none' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
        {showText && paragraphs.map((p, i) => (
          <p key={i} style={{ fontSize: 14, color: CONSENT_STYLE.muted, margin: '6px 0 0', lineHeight: 1.5 }}>
            {p}
          </p>
        ))}
      </div>
    </label>
  );
}
