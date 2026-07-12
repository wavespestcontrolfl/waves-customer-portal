import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { CARD_CONSENT_TEXT } from '../../lib/paymentMethodConsentText';

/**
 * Inline Auto Pay capture for the single-screen booking review (owner ask
 * 2026-07-12: book + opt into Auto Pay in ONE surface — less clicking, no
 * modal interrupt). Renders the Stripe Payment Element (wallets first —
 * Apple/Google Pay ride the card rails and most estimate opens are mobile)
 * plus the required consent checkbox, inside the review card.
 *
 * The PARENT owns the confirm gesture: it calls ref.confirmSetup() when the
 * customer taps the combined "Confirm booking & save card" CTA, then
 * proceeds to accept with the returned SetupIntent id — one tap, two
 * operations. This component only reports readiness ({ ready, agreed })
 * upward so the CTA can gate itself.
 *
 * Consent presentation (owner-approved 2026-07-12): a bold one-line
 * authorization summary labels the checkbox, with the FULL locked v9
 * consent text one tap away in an expander. The server still snapshots the
 * canonical v9 text — the summary never replaces the authorization of
 * record, it makes it readable at the moment of decision.
 */
const NAVY = '#04395E';

const InlineAutoPayCapture = forwardRef(function InlineAutoPayCapture(
  { intent, loadStripeSdk, glassActive = false, bodyColor = '#3E5B73', borderColor = 'rgba(4,57,94,0.18)', onStateChange },
  ref,
) {
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    onStateChange?.({ ready, agreed });
  }, [ready, agreed, onStateChange]);

  useEffect(() => {
    let cancelled = false;
    if (!intent?.clientSecret || !intent?.publishableKey) return undefined;
    loadStripeSdk().then((StripeCtor) => {
      if (cancelled || !mountRef.current) return;
      const stripe = StripeCtor(intent.publishableKey);
      const elements = stripe.elements({
        clientSecret: intent.clientSecret,
        appearance: glassActive
          ? { theme: 'stripe', variables: { borderRadius: '12px', colorPrimary: '#0A7EC2', colorText: NAVY, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } }
          : { theme: 'stripe', variables: { borderRadius: '8px' } },
      });
      const paymentElement = elements.create('payment');
      paymentElement.mount(mountRef.current);
      paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
      stripeRef.current = stripe;
      elementsRef.current = elements;
    }).catch(() => {
      if (!cancelled) setError('Could not load the secure card form. Check your connection and try again.');
    });
    return () => { cancelled = true; };
  }, [intent, loadStripeSdk, glassActive]);

  useImperativeHandle(ref, () => ({
    isReady: () => ready && agreed,
    /**
     * Confirm the SetupIntent with what the customer entered. Returns
     * { ok, setupIntentId } or { ok: false, error } — never throws into
     * the caller's confirm gesture. Mirrors RecurringCardModal's handler
     * including the succeeded-replay short-circuit.
     */
    async confirmSetup() {
      if (!stripeRef.current || !elementsRef.current) {
        return { ok: false, error: 'The secure card form is still loading — try again in a moment.' };
      }
      setError(null);
      try {
        const existing = await stripeRef.current.retrieveSetupIntent(intent.clientSecret);
        if (existing?.setupIntent?.status === 'succeeded') {
          return { ok: true, setupIntentId: existing.setupIntent.id };
        }
        const result = await stripeRef.current.confirmSetup({
          elements: elementsRef.current,
          confirmParams: { return_url: window.location.href },
          redirect: 'if_required',
        });
        if (result.error) {
          const message = result.error.message || 'We could not save that card. Try another card.';
          setError(message);
          return { ok: false, error: message };
        }
        const si = result.setupIntent;
        if (si && si.status === 'succeeded') {
          return { ok: true, setupIntentId: si.id };
        }
        const message = 'That card could not be saved. Try again in a moment.';
        setError(message);
        return { ok: false, error: message };
      } catch {
        const message = 'We could not save that card. Try again.';
        setError(message);
        return { ok: false, error: message };
      }
    },
  }), [ready, agreed, intent]);

  return (
    <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${borderColor}`, textAlign: 'left' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: NAVY }}>Auto Pay — nothing charged today</div>
      <div style={{ fontSize: 14, color: bodyColor, lineHeight: 1.5, marginTop: 4 }}>
        After each completed service, your card is charged that service&rsquo;s
        amount automatically.
      </div>
      <div ref={mountRef} style={{ marginTop: 14 }} />
      <div style={{ fontSize: 14, color: bodyColor, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden="true">🔒</span>
        <span>Secured by Stripe — remove your card anytime in the Waves app.</span>
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          style={{ marginTop: 3, width: 16, height: 16, flex: 'none' }}
        />
        <span style={{ fontSize: 14, color: NAVY, lineHeight: 1.5, fontWeight: 600 }}>
          I authorize Waves to charge this card after each completed service —
          cancel anytime.
        </span>
      </label>
      <button
        type="button"
        onClick={() => setTermsOpen((v) => !v)}
        style={{ background: 'none', border: 'none', padding: 0, marginTop: 8, marginLeft: 26, fontSize: 14, color: NAVY, textDecoration: 'underline', cursor: 'pointer' }}
      >{termsOpen ? 'Hide full terms' : 'View full terms'}</button>
      {termsOpen ? (
        <div style={{ fontSize: 14, color: bodyColor, lineHeight: 1.5, marginTop: 8, marginLeft: 26 }}>
          {CARD_CONSENT_TEXT}
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={{ color: '#C8312F', fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
      ) : null}
    </div>
  );
});

export default InlineAutoPayCapture;
