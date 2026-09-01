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

import { useEffect, useRef, useState } from 'react';
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
  // Informed-consent gate (Codex P1 on #3686): while the authorization is
  // collapsed and never yet viewed, the first checkbox interaction reveals
  // the terms instead of consenting — the box can only be checked once the
  // text has been on screen.
  const [viewedTerms, setViewedTerms] = useState(false);
  // Card and ACH carry DIFFERENT authorizations (NACHA/Reg E vs card
  // network) — having read one is not having read the other, and having
  // CONSENTED to one is not consent to the other. A real method switch
  // (not first mount) resets the viewed-gate AND withdraws an unlocked
  // checked state so the new authorization needs its own consent action
  // (Codex P1 on #3686, rounds 2–3). Locked required-save flows keep
  // their server-enforced checked state.
  const prevMethodRef = useRef(methodType);
  useEffect(() => {
    if (prevMethodRef.current === methodType) return;
    prevMethodRef.current = methodType;
    setViewedTerms(false);
    setExpanded(false);
    if (!locked && checked) onChange?.(false);
  }, [methodType, locked, checked, onChange]);
  const isAch = methodType === 'us_bank_account' || methodType === 'ach';
  const resolvedHeadline = headline ?? (isAch
    ? 'Save this bank account on file with Waves Pest Control'
    : 'Save this payment method on file with Waves Pest Control');
  const consentText = getConsentText(methodType);
  // Display-only paragraph breaks — the canonical consent string (and its
  // CONSENT_VERSION) is unchanged; splitting must never alter characters:
  // each segment keeps its trailing ". ", so joining the segments — DOM
  // textContent, copy/paste, screen readers — reproduces the canonical
  // string byte-for-byte (Codex P1 on #3686). match() with lookahead only:
  // lookbehind throws a syntax error on Safari/iOS < 16.4, which must
  // never break a public payment page (Codex P1, round 4).
  const paragraphs = consentText.match(/.*?\. (?=[A-Z])|.+$/g) || [consentText];
  const isChecked = locked ? true : !!checked;
  // The authorization may collapse only while UNCHECKED. Once the box is
  // checked — and always in locked required-save flows — the full canonical
  // text stays on screen so the recorded consent was visibly presented
  // (pre-push Codex P1: never hide an ACTIVE authorization behind a toggle).
  const showText = !collapsible || expanded || isChecked;
  const showToggle = collapsible && !isChecked;
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
        onChange={(e) => {
          if (locked) return;
          if (collapsible && !isChecked && !viewedTerms) {
            setExpanded(true);
            setViewedTerms(true);
            return;
          }
          onChange?.(e.target.checked);
        }}
        style={{
          width: 18, height: 18, accentColor: CONSENT_STYLE.text,
          marginTop: 2, flexShrink: 0,
          cursor: locked ? 'default' : 'pointer',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: CONSENT_STYLE.text, lineHeight: 1.35 }}>
          {resolvedHeadline}
        </div>
        {showToggle && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={(e) => {
              // Inside the <label>: without preventDefault the click would
              // also toggle the checkbox.
              e.preventDefault();
              setExpanded((v) => !v);
              setViewedTerms(true);
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
