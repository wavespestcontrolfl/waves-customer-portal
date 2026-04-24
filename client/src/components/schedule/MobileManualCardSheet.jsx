// In-app manual credit card entry sheet. Opened from MobilePaymentSheet's
// "Manual Credit Card Entry" row so the tech doesn't have to kick the
// customer to an external browser tab. Mirrors the Square-style layout
// per IMG_3861: large amount header, Stripe card fields, Charge button.
//
// Uses the existing invoice token flow:
//   POST /api/pay/:token/setup  { cardOnly: true }  → clientSecret
//   stripe.confirmPayment()                           → charge
//   POST /api/pay/:token/confirm                      → mark paid + SMS receipt

import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function loadStripeJs(publishableKey) {
  return new Promise((resolve) => {
    if (window.Stripe) return resolve(window.Stripe(publishableKey));
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => resolve(window.Stripe(publishableKey));
    document.head.appendChild(script);
  });
}

export default function MobileManualCardSheet({
  invoiceToken,
  amount,
  onClose,
  onChargeSuccess,
}) {
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);

  const [initError, setInitError] = useState(null);
  const [formError, setFormError] = useState(null);
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [paymentIntentId, setPaymentIntentId] = useState(null);

  const surcharge = Math.round(amount * 1.03 * 100) / 100;

  useEffect(() => {
    if (!invoiceToken) return;
    let cancelled = false;

    (async () => {
      try {
        const setupRes = await fetch(`${API_BASE}/pay/${invoiceToken}/setup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardOnly: true }),
        });
        if (!setupRes.ok) {
          const d = await setupRes.json().catch(() => ({}));
          throw new Error(d.error || 'Failed to set up payment');
        }
        const setup = await setupRes.json();
        if (cancelled) return;

        setPaymentIntentId(setup.paymentIntentId);

        const stripe = await loadStripeJs(setup.publishableKey);
        if (cancelled) return;
        stripeRef.current = stripe;

        const elements = stripe.elements({
          clientSecret: setup.clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#111111',
              colorBackground: '#FFFFFF',
              colorText: '#111111',
              colorDanger: '#C2410C',
              fontFamily: "'DM Sans', system-ui, sans-serif",
              borderRadius: '10px',
            },
            rules: {
              '.Input': {
                border: '1px solid #E5E5E5',
                boxShadow: 'none',
                padding: '14px 16px',
                fontSize: '16px',
              },
              '.Input:focus': {
                border: '1px solid #111111',
                boxShadow: '0 0 0 3px rgba(17,17,17,0.12)',
              },
              '.Label': { display: 'none' },
            },
          },
        });
        elementsRef.current = elements;

        const paymentElement = elements.create('payment', {
          layout: { type: 'tabs' },
          paymentMethodOrder: ['card'],
          wallets: { applePay: 'never', googlePay: 'never' },
        });

        paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
        paymentElement.on('change', (event) => {
          if (cancelled) return;
          setComplete(!!event.complete);
          setFormError(event.error?.message || null);
        });

        if (mountRef.current) paymentElement.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) setInitError(err.message || 'Payment setup failed');
      }
    })();

    return () => { cancelled = true; };
  }, [invoiceToken]);

  async function handleCharge() {
    if (processing || !ready || !complete) return;
    if (!stripeRef.current || !elementsRef.current) return;
    setProcessing(true);
    setFormError(null);
    try {
      const { error, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });

      if (error) {
        setFormError(error.message || 'Payment failed');
        setProcessing(false);
        return;
      }

      if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
        // Let the server mark the invoice paid + fire receipt SMS. Webhook
        // will reconcile if this call fails.
        try {
          await fetch(`${API_BASE}/pay/${invoiceToken}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
          });
        } catch { /* webhook will reconcile */ }
        onChargeSuccess?.({ paymentIntentId: paymentIntent.id, amount: surcharge });
        onClose?.();
        return;
      }

      setFormError('Payment did not complete — try again');
      setProcessing(false);
    } catch (err) {
      setFormError(err.message || 'Payment failed');
      setProcessing(false);
    }
  }

  const canCharge = ready && complete && !processing && !initError;

  return (
    <div className="fixed inset-0 z-[115] bg-white overflow-y-auto md:hidden">
      {/* Header */}
      <div
        className="sticky top-0 bg-white flex items-center px-3"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex items-center justify-center h-11 w-11 rounded-full u-focus-ring text-zinc-900"
          style={{ background: '#F4F4F5' }}
        >
          <ArrowLeft size={20} strokeWidth={2} />
        </button>
        <div className="flex-1" />
      </div>

      <div className="px-5 pt-2 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        {/* Amount */}
        <div
          className="text-zinc-900"
          style={{ fontSize: 56, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.05 }}
        >
          ${amount.toFixed(2)}
        </div>
        <div
          className="text-ink-secondary"
          style={{ fontSize: 15, marginTop: 8 }}
        >
          ${surcharge.toFixed(2)} with 3% credit card surcharge
        </div>

        {/* Card form — Stripe Payment Element restricted to card tender */}
        <div style={{ marginTop: 24 }}>
          <div ref={mountRef} style={{ minHeight: 180 }} />
          {initError && (
            <div className="text-alert-fg" style={{ fontSize: 13, marginTop: 10 }}>
              {initError}
            </div>
          )}
          {formError && !initError && (
            <div className="text-alert-fg" style={{ fontSize: 13, marginTop: 10 }}>
              {formError}
            </div>
          )}
        </div>

        {/* Charge */}
        <button
          type="button"
          onClick={handleCharge}
          disabled={!canCharge}
          className="w-full rounded-full u-focus-ring"
          style={{
            marginTop: 20,
            padding: '18px 24px',
            fontSize: 17,
            fontWeight: 600,
            background: canCharge ? '#111111' : '#E5E5E5',
            color: canCharge ? '#FFFFFF' : '#A3A3A3',
            border: 'none',
          }}
        >
          {processing ? 'Charging…' : 'Charge'}
        </button>
      </div>
    </div>
  );
}
