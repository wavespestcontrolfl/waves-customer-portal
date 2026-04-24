// Reusable card-on-file opt-in. Drop it next to any Stripe Payment
// Element where we want the customer to consent to saving the card for
// future charges.
//
// Controlled: parent owns `checked` + `onChange`. Read `checked` to
// decide whether to pass setup_future_usage: 'off_session' on the
// PaymentIntent (or whether to create a SetupIntent at all).
//
// When `locked` is true the box is checked + disabled — use this in
// flows where saving is a precondition (onboarding, portal add-card
// modal). The authorization copy is still shown so consent is on record.

import { CONSENT_TEXT } from '../../lib/paymentMethodConsentText';

export default function SaveCardConsent({
  checked,
  onChange,
  locked = false,
  headline = 'Save this card on file with Waves Pest Control',
  style,
}) {
  const isChecked = locked ? true : !!checked;
  return (
    <label
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '12px 14px',
        background: '#F8F8F8',
        border: '1px solid #E5E5E5',
        borderRadius: 10,
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
          width: 18, height: 18, accentColor: '#111',
          marginTop: 2, flexShrink: 0,
          cursor: locked ? 'default' : 'pointer',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111', lineHeight: 1.35 }}>
          {headline}
        </div>
        <div style={{ fontSize: 12, color: '#525252', marginTop: 6, lineHeight: 1.5 }}>
          {CONSENT_TEXT}
        </div>
      </div>
    </label>
  );
}
