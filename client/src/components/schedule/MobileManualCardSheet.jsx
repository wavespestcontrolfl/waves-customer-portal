// In-app manual credit card entry sheet. Opened from MobilePaymentSheet's
// "Manual Credit Card Entry" row so the tech doesn't have to kick the
// customer to an external browser tab. Mirrors the Square-style layout
// per IMG_3861: large amount header, Stripe card fields, Charge button.
//
// Uses the invoice token surcharge flow:
//   POST /api/pay/:token/setup  { cardOnly: true }  -> clientSecret
//   Stripe createPaymentMethod                       -> card funding lookup
//   POST /api/pay/:token/quote                       -> exact surcharge disclosure
//   POST /api/pay/:token/finalize                    -> server-side confirm
//   POST /api/pay/:token/confirm                     -> mark paid + SMS receipt

import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getStripe } from '../../lib/stripeLoader';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function MobileManualCardSheet({
  desktopVisible = false,
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
  const [quoteData, setQuoteData] = useState(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

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

        const stripe = await getStripe(setup.publishableKey);
        if (cancelled) return;
        stripeRef.current = stripe;

        const elements = stripe.elements({
          clientSecret: setup.clientSecret,
          paymentMethodCreation: 'manual',
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
          setAwaitingConfirm(false);
          setQuoteData(null);
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
      if (awaitingConfirm && quoteData?.quoteToken) {
        const finalRes = await fetch(`${API_BASE}/pay/${invoiceToken}/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quoteToken: quoteData.quoteToken }),
        });
        const finalized = await finalRes.json().catch(() => ({}));
        if (!finalRes.ok) throw new Error(finalized.error || 'Payment failed');

        let completedIntent = {
          id: finalized.paymentIntentId,
          status: finalized.status,
          payment_method: finalized.paymentMethodId,
        };

        if (finalized.requiresAction && finalized.clientSecret) {
          const { error: actionError, paymentIntent: actionPI } = await stripeRef.current.handleNextAction({
            clientSecret: finalized.clientSecret,
          });
          if (actionError) throw new Error(actionError.message || 'Additional verification failed');
          completedIntent = actionPI || completedIntent;
        }

        if (!completedIntent || !['succeeded', 'processing'].includes(completedIntent.status)) {
          throw new Error('Payment did not complete - try again');
        }

        // Let the server mark the invoice paid + fire receipt SMS. Webhook
        // will reconcile if this call fails.
        try {
          await fetch(`${API_BASE}/pay/${invoiceToken}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentIntentId: completedIntent.id }),
          });
        } catch { /* webhook will reconcile */ }
        onChargeSuccess?.({ paymentIntentId: completedIntent.id, amount: quoteData.total ?? amount });
        onClose?.();
        return;
      }

      const { error: submitError } = await elementsRef.current.submit();
      if (submitError) throw new Error(submitError.message || 'Payment details are incomplete');

      const { error: pmError, paymentMethod } = await stripeRef.current.createPaymentMethod({
        elements: elementsRef.current,
      });
      if (pmError) throw new Error(pmError.message || 'Could not prepare card payment');

      const quoteRes = await fetch(`${API_BASE}/pay/${invoiceToken}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: paymentMethod.id }),
      });
      const quote = await quoteRes.json().catch(() => ({}));
      if (!quoteRes.ok) throw new Error(quote.error || 'Could not calculate card total');

      setQuoteData({ ...quote, paymentMethodId: paymentMethod.id });
      setAwaitingConfirm(true);
      setProcessing(false);
    } catch (err) {
      setFormError(err.message || 'Payment failed');
      setProcessing(false);
      setAwaitingConfirm(false);
      setQuoteData(null);
    }
  }

  const canCharge = ready && complete && !processing && !initError;
  const displayedTotal = quoteData?.total ?? amount;

  return (
    <div className={`fixed inset-0 z-[115] bg-white overflow-y-auto ${desktopVisible ? '' : 'md:hidden'}`}>
      {/* Header */}
      <div
        className="sticky top-0 bg-white flex items-center px-3"
        style={{ height: 'calc(56px + env(safe-area-inset-top, 0px))', paddingTop: 'env(safe-area-inset-top, 0px)' }}
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
          ${displayedTotal.toFixed(2)}
        </div>
        <div
          className="text-ink-secondary"
          style={{ fontSize: 15, marginTop: 8 }}
        >
          {quoteData
            ? `$${quoteData.base.toFixed(2)} invoice + $${quoteData.surcharge.toFixed(2)} card fee`
            : 'Credit card fee shown before charging'}
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
          {processing ? 'Charging…' : awaitingConfirm ? `Confirm & charge $${displayedTotal.toFixed(2)}` : 'Continue'}
        </button>
      </div>
    </div>
  );
}
