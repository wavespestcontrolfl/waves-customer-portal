// client/src/pages/PayPageV2.jsx
//
// Customer-facing pay page (V2). Renders the Stripe Payment Element,
// credit-card surcharge (up to 3%) disclosure, save-card consent, and on success
// redirects to /receipt/:token. The single most security-and-money-
// critical page in the customer-facing portal.
//
// Endpoints:
//   GET  /api/billing/v2/invoice/:token        (invoice details by
//                                               public token, no auth)
//   POST /api/billing/v2/intent                (create PaymentIntent,
//                                               server computes amount)
//   POST /api/billing/v2/card                  (save method post-pay)
//   GET  /api/billing/v2/cards                 (list saved methods)
//
// Server orchestrators Codex follows via the endpoints above:
//   server/services/stripe.js                  (computeChargeAmount,
//                                               ensureStripeCustomer,
//                                               PI create/confirm)
//   server/routes/billing-v2.js                (PI route handler)
//   server/routes/stripe-webhook.js            (signature verify,
//                                               idempotency table,
//                                               event dispatch)
//   server/services/billing-cron.js            (monthly billing,
//                                               retry ladder Day 1/3/5)
//   server/services/payment-router.js          (processor abstraction)
//
// Customer-facing styling (CLAUDE.md): warm tone, Luckiest Guy /
// Baloo 2, gold pill, mascot. Do NOT apply admin monochrome rules.
//
// Audit focus — CLIENT:
// - Stripe SDK loaded once, cached in module scope. Confirm subsequent
//   page mounts don't re-load the script (would re-prompt user agents
//   and slow first-paint).
// - Surcharge disclosure: two-step quote/finalize flow ensures the customer
//   sees the exact surcharge before payment. Credit cards = up to 3%.
//   Debit/prepaid/ACH = 0%. Server is authoritative for surcharge calculation.
// - Confirm button single-flight: Stripe Payment Intent confirm is
//   slow (~2-5s). Double-click must not double-confirm. Standard
//   pattern is disable-on-submit + idempotency key.
// - Save-card consent: SaveCardConsent checkbox state must persist
//   to the payment method row only when true. A consent miss here
//   creates a future autopay charge the customer never agreed to.
// - Token validation: GET /api/billing/v2/invoice/:token has no auth
//   (it's a public link). Server must validate the token format
//   (cryptographic, not sequential) and rate-limit guesses.
// - Receipt redirect: on success, redirect to /receipt/:token. Confirm
//   the redirect happens AFTER the webhook confirms payment (or that
//   the receipt page handles "still confirming" gracefully) — a
//   premature redirect on a 3DS-required payment shows "paid" before
//   the auth completes.
//
// Audit focus — SERVER (Codex follows imports):
// - stripe-webhook.js signature verification: stripe.webhooks
//   .constructEvent must run BEFORE any DB writes. A handler that
//   processes the body before verifying is the standard
//   Stripe-webhook-replay-attack vulnerability.
// - Idempotency table (stripe_webhook_events): event.id must be
//   recorded BEFORE processing. If the table write happens after,
//   a Stripe retry races and we double-credit the invoice.
// - computeChargeAmount: credit-card surcharge (up to 3%) for confirmed
//   credit cards; 0% for debit/prepaid/unknown/ACH. Server-side
//   quoteInvoiceSurcharge determines the exact amount based on PM funding.
// - ensureStripeCustomer: customer-stripe linking. Confirm we don't
//   accidentally create a NEW Stripe Customer for an existing
//   customer (= duplicated card on file, broken autopay).
// - billing-cron.js monthly-billing guards: autopay disabled /
//   paused / wrong billing day must each skip the charge. Retry
//   ladder Day 1/3/5 must STOP on first success (no double-charge
//   if first retry succeeds but logs a transient error).
// - service_paused_at flag: a paused-service customer must not be
//   billed. Verify the cron checks this at fire time, not just at
//   enqueue time.
// - Refund webhook (charge.refunded): must update invoice status +
//   reverse the surcharge in our books to keep the revenue dashboard
//   accurate.
// - Dispute webhook (dispute.created): must flag the customer for
//   the operator to review before any further charges fire.
import { COLORS, FONTS } from '../theme-brand';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Icon from '../components/Icon';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';
import SaveCardConsent from '../components/billing/SaveCardConsent';
import { computeCardTotal } from '../lib/cardSurcharge';
import { formatInvoiceDate, isInvoiceDueDateOverdue } from '../lib/invoiceDates';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function shouldDefaultSaveCard(search = '') {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('saveCard') || params.get('save_card') || params.get('save-card');
    return /^(1|true|yes|default)$/i.test(String(raw || ''));
  } catch {
    return false;
  }
}

// ── Stripe SDK loader (loads once, caches) ─────────────────────────
let stripePromise = null;
function getStripe(publishableKey) {
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe(publishableKey));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.onload = () => resolve(window.Stripe(publishableKey));
    script.onerror = () => reject(new Error('Failed to load Stripe'));
    document.head.appendChild(script);
  });
  return stripePromise;
}

function paymentErrorPayload(err, extra = {}) {
  return {
    message: err?.message || extra.message || 'Payment error',
    code: err?.code || err?.decline_code || err?.raw?.code || extra.code || null,
    stripeType: err?.type || err?.raw?.type || null,
    ...extra,
  };
}

function serverReportedError(message) {
  const err = new Error(message || 'Payment error');
  err.serverReported = true;
  return err;
}

function reportPaymentError(token, payload = {}) {
  if (!token || !payload.message) return;
  try {
    fetch(`${API_BASE}/pay/${token}/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Best-effort telemetry only. Never block the customer payment UI.
  }
}

function fmtCurrency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtFileSize(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function isDiscountLineItem(item) {
  const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
  return item?._kind === 'discount' || item?.discount_for || amount < 0;
}

function fmtDate(d) {
  return formatInvoiceDate(d);
}

const subtlePanel = {
  background: '#FAF8F3',
  border: '1px solid #E7E2D7',
  borderRadius: 8,
};

const eyebrow = {
  fontSize: 12,
  color: 'var(--text-muted)',
  fontWeight: 850,
  letterSpacing: 0,
  textTransform: 'uppercase',
};

function fullName(customer = {}) {
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Waves customer';
}

function cityStateZip(customer = {}) {
  const region = [customer.state || (customer.city ? 'FL' : ''), customer.zip].filter(Boolean).join(' ');
  return [customer.city, region].filter(Boolean).join(customer.city && region ? ', ' : '');
}

function StatusPill({ tone = 'neutral', children }) {
  const tones = {
    neutral: { bg: '#FAF8F3', color: 'var(--text)', border: '#E7E2D7' },
    due: { bg: '#EEF6FF', color: '#065A8C', border: '#BFE4F8' },
    overdue: { bg: 'rgba(200,16,46,0.08)', color: 'var(--danger)', border: 'rgba(200,16,46,0.22)' },
    secure: { bg: '#F0FDF4', color: 'var(--success)', border: '#BBF7D0' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 28,
      padding: '5px 9px',
      borderRadius: 8,
      background: t.bg,
      border: `1px solid ${t.border}`,
      color: t.color,
      fontSize: 12,
      fontWeight: 850,
      letterSpacing: 0,
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function DetailBlock({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...eyebrow, marginBottom: 7 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.55 }}>
        {children}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, strong, muted }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 16,
      padding: strong ? '12px 0 0' : '7px 0',
      marginTop: strong ? 8 : 0,
      borderTop: strong ? '1px solid var(--border)' : 'none',
      color: strong ? 'var(--text)' : 'var(--text-muted)',
      fontSize: strong ? 16 : 14,
      fontWeight: strong ? 850 : 500,
      fontFamily: strong ? FONTS.body : FONTS.body,
    }}>
      <span>{label}</span>
      <span style={{
        color: muted ? 'var(--text-muted)' : 'var(--text)',
        fontFamily: FONTS.mono,
        fontWeight: strong ? 850 : 650,
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}

// ── Stripe Payment Element wrapper ─────────────────────────────────
function PaymentForm({ publishableKey, clientSecret, amount, paymentIntentId, token, cardSurchargeRate, onSuccess, onError, saveCard, onSaveCardChange, customerName, customerEmail, onPaymentIntentReplaced }) {
  const mountRef = useRef(null);
  const expressMountRef = useRef(null);
  const elementsRef = useRef(null);
  const stripeRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elementError, setElementError] = useState(null);
  const [selectedMethod, setSelectedMethod] = useState('card');
  // Initial fallback uses the same two-step rounding as server
  // computeChargeAmount so the customer's first paint matches the
  // PaymentIntent total even if the /update-amount sync fails.
  // Phase 1: PI starts at base amount — surcharge added at /finalize after PM inspection.
  const [displayedBase, setDisplayedBase] = useState(amount);
  const [displayedSurcharge, setDisplayedSurcharge] = useState(0);
  const [displayedTotal, setDisplayedTotal] = useState(amount);
  const [syncingAmount, setSyncingAmount] = useState(false);
  const [amountSyncError, setAmountSyncError] = useState(false);
  const selectedMethodRef = useRef('card');
  const syncingAmountRef = useRef(false);
  const amountSyncSeqRef = useRef(0);

  useEffect(() => {
    selectedMethodRef.current = selectedMethod;
  }, [selectedMethod]);

  const syncAmountForMethod = useCallback(async (methodCategory, saveCardOverride, options = {}) => {
    if (!paymentIntentId || !token) return;
    const syncSeq = amountSyncSeqRef.current + 1;
    amountSyncSeqRef.current = syncSeq;
    syncingAmountRef.current = true;
    setSyncingAmount(true);
    setAmountSyncError(false);
    try {
      const res = await fetch(`${API_BASE}/pay/${token}/update-amount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentIntentId,
          methodCategory,
          saveCard: saveCardOverride !== undefined ? saveCardOverride : !!saveCard,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw serverReportedError(data.error || 'Could not update payment total');
      }
      // The server minted a fresh PaymentIntent for this tender (the old one
      // had an incompatible PaymentMethod attached and couldn't be re-locked).
      // The old clientSecret is now dead, so hand the new one up to the parent
      // and let it re-mount Elements — fetchUpdates against the old secret
      // would fail.
      if (data.replaced && data.clientSecret) {
        onPaymentIntentReplaced?.({
          clientSecret: data.clientSecret,
          paymentIntentId: data.paymentIntentId,
          baseAmount: data.base,
          methodCategory,
        });
        return;
      }
      if (!options.skipFetchUpdates && elementsRef.current?.fetchUpdates) {
        const { error: fetchError } = await elementsRef.current.fetchUpdates();
        if (fetchError) {
          throw new Error(fetchError.message || 'Could not refresh the payment form');
        }
      }
      if (syncSeq !== amountSyncSeqRef.current || selectedMethodRef.current !== methodCategory) return;
      setDisplayedBase(data.base);
      setDisplayedSurcharge(data.surcharge);
      setDisplayedTotal(data.total);
    } catch (err) {
      setAmountSyncError(true);
      const methodLabel = methodCategory === 'us_bank_account' ? 'bank-transfer' : 'card';
      setElementError(err.message || `Could not update the ${methodLabel} total. Select another method or try again.`);
      if (!err.serverReported) {
        reportPaymentError(token, paymentErrorPayload(err, {
          phase: 'update_amount',
          methodCategory,
          paymentIntentId,
        }));
      }
    } finally {
      if (syncSeq === amountSyncSeqRef.current) {
        syncingAmountRef.current = false;
        setSyncingAmount(false);
      }
    }
  }, [paymentIntentId, token, saveCard, onPaymentIntentReplaced]);

  // Re-sync the PI whenever the save-card checkbox toggles — Stripe's
  // mandate wording switches between one-time and recurring on the
  // setup_future_usage change.
  useEffect(() => {
    if (!paymentIntentId || awaitingConfirm) return;
    syncAmountForMethod(selectedMethod, !!saveCard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveCard]);

  useEffect(() => {
    if (!publishableKey || !clientSecret) return;
    let cancelled = false;

    (async () => {
      try {
        const stripe = await getStripe(publishableKey);
        if (cancelled) return;
        stripeRef.current = stripe;

        const elements = stripe.elements({
          clientSecret,
          paymentMethodCreation: 'manual',
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: COLORS.blueDeeper,
              colorBackground: COLORS.white,
              colorText: COLORS.navy,
              colorDanger: COLORS.red,
              fontFamily: FONTS.body,
              borderRadius: '8px',
              spacingUnit: '4px',
            },
            rules: {
              '.Input': {
                border: '1px solid #E2E8F0',
                boxShadow: 'none',
                padding: '12px 14px',
              },
              '.Input:focus': {
                border: '1px solid #1B2C5B',
                boxShadow: '0 0 0 3px rgba(27,44,91,0.18)',
              },
              '.Label': {
                fontSize: '13px',
                fontWeight: '500',
                color: COLORS.textBody,
              },
              '.Tab': {
                border: '1px solid #E2E8F0',
                borderRadius: '8px',
              },
              '.Tab--selected': {
                borderColor: COLORS.blueDeeper,
                backgroundColor: 'rgba(27,44,91,0.08)',
              },
            },
          },
        });

        if (cancelled) return;
        elementsRef.current = elements;

        // ── Express Checkout Element — prominent wallet button
        //
        // Renders Apple Pay / Google Pay / Link as a branded one-tap
        // pill at the top of the form (image reference: google-pay.png).
        // The card preview + last-four in the button are Google's own
        // surface, shown when the customer has a saved card in Google
        // Pay and our domain is registered with Stripe.
        //
        // Phase 1: no surcharge on Express Checkout (wallets).
        // PI stays at base amount — wallet sheet shows the quoted price.
        const express = elements.create('expressCheckout', {
          buttonTheme: { applePay: 'black', googlePay: 'black' },
          buttonType:  { applePay: 'buy',   googlePay: 'buy' },
          buttonHeight: 52,
          paymentMethodOrder: ['applePay', 'googlePay', 'link'],
          paymentMethods: { googlePay: 'always' },
        });

        express.on('ready', async () => {
          if (cancelled) return;
          // Phase 1: No surcharge on Express Checkout (wallets).
          // PI stays at base amount — wallet sheet shows the quoted amount.
        });

        express.on('confirm', async () => {
          if (cancelled) return;
          try {
            const { error, paymentIntent } = await stripeRef.current.confirmPayment({
              elements: elementsRef.current,
              confirmParams: { return_url: window.location.href },
              redirect: 'if_required',
            });
            if (error) {
              setElementError(error.message);
              reportPaymentError(token, paymentErrorPayload(error, {
                phase: 'express_confirm',
                methodCategory: 'express_checkout',
                paymentIntentId,
              }));
              return;
            }
            if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
              onSuccess?.(paymentIntent, 'express_checkout');
            } else if (paymentIntent && paymentIntent.status === 'requires_action') {
              setElementError('Additional verification required. Please follow the prompts.');
            }
          } catch (err) {
            setElementError(err.message || 'Payment failed');
            reportPaymentError(token, paymentErrorPayload(err, {
              phase: 'express_confirm',
              methodCategory: 'express_checkout',
              paymentIntentId,
            }));
          }
        });

        if (expressMountRef.current) express.mount(expressMountRef.current);

        // ── Payment Element — manual card + ACH
        //
        // Wallets moved into the Express Checkout Element above, so we
        // hide them here to avoid duplicate wallet buttons. ACH stays in
        // the accordion below.
        // Pre-fill billing details from the invoice's customer record.
        // us_bank_account (ACH) confirmation requires a full name and email;
        // without them Stripe rejects the confirm with "Please provide your
        // full name". Seeding defaultValues means the ACH fields aren't blank
        // by default, while card payments simply ignore the unused name field.
        const billingDetails = {};
        if (customerName) billingDetails.name = customerName;
        if (customerEmail) billingDetails.email = customerEmail;

        const paymentElement = elements.create('payment', {
          layout: {
            type: 'accordion',
            defaultCollapsed: false,
            radios: true,
            spacedAccordionItems: true,
          },
          paymentMethodOrder: ['card', 'us_bank_account'],
          wallets: { applePay: 'never', googlePay: 'never' },
          ...(Object.keys(billingDetails).length ? { defaultValues: { billingDetails } } : {}),
        });

        paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
        paymentElement.on('change', (event) => {
          if (cancelled) return;
          // Clear pending surcharge quote on any element change — the customer
          // may have edited card details, making the old PM stale.
          setAwaitingConfirm(false);
          setQuoteData(null);
          setElementError(event.error?.message || null);
          const nextMethod = event.value?.type || null;
          if (nextMethod && nextMethod !== selectedMethodRef.current) {
            if (nextMethod !== 'us_bank_account') setAmountSyncError(false);
            selectedMethodRef.current = nextMethod;
            setSelectedMethod(nextMethod);
            setAwaitingConfirm(false);
            setQuoteData(null);
            syncAmountForMethod(nextMethod);
          }
        });

        paymentElement.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) {
          const message = err.message || 'Failed to initialize payment form';
          onError?.(message);
          reportPaymentError(token, paymentErrorPayload(err, {
            phase: 'payment_form_init',
            methodCategory: selectedMethodRef.current,
            paymentIntentId,
            message,
          }));
        }
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey, clientSecret]);

  const isCardFamily = selectedMethod !== 'us_bank_account';
  const pct = '3';
  const buttonAmount = displayedTotal;

  const selectPaymentMethod = (methodCategory) => {
    if (!ready || processing || syncingAmount || syncingAmountRef.current || methodCategory === selectedMethod) return;
    // Clear any pending card quote when switching methods
    setAwaitingConfirm(false);
    setQuoteData(null);
    selectedMethodRef.current = methodCategory;
    setSelectedMethod(methodCategory);
    syncAmountForMethod(methodCategory);
  };

  // Two-step surcharge disclosure: createPaymentMethod → quote → confirm → finalize.
  // ACH payments skip the quote step and go straight to confirmPayment.
  const [quoteData, setQuoteData] = useState(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);

  const handleSubmit = async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setElementError(null);

    // ACH: use the existing confirmPayment flow (no surcharge)
    if (selectedMethodRef.current === 'us_bank_account') {
      try {
        const { error, paymentIntent: pi } = await stripeRef.current.confirmPayment({
          elements: elementsRef.current,
          confirmParams: { return_url: window.location.href },
          redirect: 'if_required',
        });
        if (error) {
          setElementError(error.message);
          reportPaymentError(token, paymentErrorPayload(error, {
            phase: 'stripe_confirm',
            methodCategory: 'us_bank_account',
            paymentIntentId,
          }));
          setProcessing(false);
          return;
        }
        if (pi && (pi.status === 'succeeded' || pi.status === 'processing')) onSuccess?.(pi, 'us_bank_account');
        else if (pi?.status === 'requires_action') { setElementError('Additional verification required.'); setProcessing(false); }
        else onSuccess?.(pi, 'us_bank_account');
      } catch (err) {
        setElementError(err.message || 'Payment failed');
        reportPaymentError(token, paymentErrorPayload(err, {
          phase: 'stripe_confirm',
          methodCategory: 'us_bank_account',
          paymentIntentId,
        }));
        setProcessing(false);
      }
      return;
    }

    // Card: Step 1 — create PaymentMethod from Elements, then get surcharge quote
    try {
      const { error: submitError } = await elementsRef.current.submit();
      if (submitError) {
        setElementError(submitError.message);
        reportPaymentError(token, paymentErrorPayload(submitError, {
          phase: 'payment_form_submit',
          methodCategory: selectedMethodRef.current,
          paymentIntentId,
        }));
        setProcessing(false);
        return;
      }

      const { error: pmError, paymentMethod } = await stripeRef.current.createPaymentMethod({ elements: elementsRef.current });
      if (pmError) {
        setElementError(pmError.message);
        reportPaymentError(token, paymentErrorPayload(pmError, {
          phase: 'payment_method_create',
          methodCategory: selectedMethodRef.current,
          paymentIntentId,
        }));
        setProcessing(false);
        return;
      }

      const quoteRes = await fetch(`${API_BASE}/pay/${token}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethodId: paymentMethod.id }),
      });
      const quote = await quoteRes.json().catch(() => ({}));
      if (!quoteRes.ok) throw serverReportedError(quote.error || 'Could not get surcharge quote');

      // Show the surcharge confirmation UI
      setDisplayedBase(quote.base);
      setDisplayedSurcharge(quote.surcharge);
      setDisplayedTotal(quote.total);
      setQuoteData({ ...quote, paymentMethodId: paymentMethod.id });
      setAwaitingConfirm(true);
      setProcessing(false);
    } catch (err) {
      setElementError(err.message || 'Payment failed');
      if (!err.serverReported) {
        reportPaymentError(token, paymentErrorPayload(err, {
          phase: 'quote',
          methodCategory: selectedMethodRef.current,
          paymentIntentId,
        }));
      }
      setProcessing(false);
    }
  };

  const handleFinalizePayment = async () => {
    if (!quoteData || processing) return;
    setProcessing(true);
    setElementError(null);

    try {
      const finalRes = await fetch(`${API_BASE}/pay/${token}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteToken: quoteData.quoteToken, saveCard: !!saveCard }),
      });
      const result = await finalRes.json().catch(() => ({}));
      if (!finalRes.ok) throw serverReportedError(result.error || 'Payment failed');

      if (result.requiresAction && result.clientSecret) {
        const { error: actionError, paymentIntent: actionPI } = await stripeRef.current.handleNextAction({ clientSecret: result.clientSecret });
        if (actionError) {
          setElementError(actionError.message);
          reportPaymentError(token, paymentErrorPayload(actionError, {
            phase: 'next_action',
            methodCategory: selectedMethodRef.current,
            paymentIntentId: result.paymentIntentId || paymentIntentId,
          }));
          setProcessing(false);
          return;
        }
        if (actionPI && (actionPI.status === 'succeeded' || actionPI.status === 'processing')) {
          onSuccess?.({ id: actionPI.id, status: actionPI.status, payment_method: actionPI.payment_method }, selectedMethodRef.current);
          return;
        }
        const statusMessage = 'Payment could not be completed. Please try again.';
        setElementError(statusMessage);
        reportPaymentError(token, {
          phase: 'payment_status',
          methodCategory: selectedMethodRef.current,
          paymentIntentId: result.paymentIntentId || paymentIntentId,
          message: `${statusMessage} Stripe status: ${actionPI?.status || 'unknown'}`,
        });
        setProcessing(false);
        return;
      }

      if (result.status === 'succeeded' || result.status === 'processing') {
        onSuccess?.({ id: result.paymentIntentId, status: result.status, payment_method: result.paymentMethodId }, selectedMethodRef.current);
      } else {
        const statusMessage = 'Payment was not completed. Please try again or use a different payment method.';
        setElementError(statusMessage);
        reportPaymentError(token, {
          phase: 'payment_status',
          methodCategory: selectedMethodRef.current,
          paymentIntentId: result.paymentIntentId || paymentIntentId,
          message: `${statusMessage} Stripe status: ${result.status || 'unknown'}`,
        });
        setProcessing(false);
        setAwaitingConfirm(false);
        setQuoteData(null);
      }
    } catch (err) {
      setElementError(err.message || 'Payment failed');
      if (!err.serverReported) {
        reportPaymentError(token, paymentErrorPayload(err, {
          phase: 'finalize',
          methodCategory: selectedMethodRef.current,
          paymentIntentId,
        }));
      }
      setProcessing(false);
      setAwaitingConfirm(false);
      setQuoteData(null);
    }
  };

  const disabled = !ready || processing || syncingAmount || amountSyncError;
  const methodControlsDisabled = !ready || processing || syncingAmount;
  const methodOptions = [
    { value: 'card', title: 'Card or wallet', detail: 'Up to 3% credit card surcharge', icon: 'card' },
    { value: 'us_bank_account', title: 'Bank account', detail: 'No added fee', icon: 'building' },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: 14,
        borderRadius: 8,
        background: '#EEF6FF',
        border: '1px solid #BFE4F8',
        fontSize: 14,
        lineHeight: 1.5,
        color: 'var(--text)',
      }}>
        <span style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          background: '#FFFFFF',
          color: '#065A8C',
          border: '1px solid #BFE4F8',
        }}>
          <Icon name="card" size={17} strokeWidth={2} />
        </span>
        <span>
          Credit cards may add up to 3%. You will see the exact total before payment. Debit cards, prepaid cards,
          and bank transfers have no added card surcharge.
        </span>
      </div>

      <div>
        <div style={{ ...eyebrow, marginBottom: 8 }}>
          Payment method
        </div>
        <div role="group" aria-label="Payment method" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          {methodOptions.map((method) => {
            const active = selectedMethod === method.value;
            return (
              <button
                key={method.value}
                type="button"
                aria-pressed={active}
                onClick={() => selectPaymentMethod(method.value)}
                disabled={methodControlsDisabled}
                style={{
                  minHeight: 72,
                  borderRadius: 8,
                  border: `1px solid ${active ? COLORS.blueDeeper : 'var(--border)'}`,
                  background: active ? '#F8FCFE' : COLORS.white,
                  color: 'var(--text)',
                  padding: 12,
                  textAlign: 'left',
                  cursor: methodControlsDisabled ? 'not-allowed' : 'pointer',
                  opacity: methodControlsDisabled ? 0.72 : 1,
                  boxShadow: active ? '0 0 0 3px rgba(0,156,222,0.13)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  background: active ? '#FFFFFF' : '#FAF8F3',
                  border: '1px solid #E7E2D7',
                  color: active ? COLORS.blueDeeper : 'var(--text-muted)',
                }}>
                  <Icon name={method.icon} size={17} strokeWidth={2} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 850, fontSize: 14, marginBottom: 3 }}>
                    {method.title}
                  </span>
                  <span style={{ display: 'block', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.3 }}>
                    {method.detail}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Express wallet button (Google Pay / Apple Pay / Link) —
          Stripe only renders one on browser + device combos where the
          customer actually has a wallet set up, so this div will be
          empty for most desktop Chrome users without a Google Pay card
          on file. That's the Stripe-recommended behavior. */}
      <div ref={expressMountRef} style={{ display: isCardFamily ? 'block' : 'none' }} />
      <div ref={mountRef} style={{ minHeight: 90 }} />

      {/* Save-payment-method opt-in. methodType drives both the headline
          and the authorization copy (ACH variant satisfies NACHA/Reg E,
          card variant covers card-network + TILA disclosures). */}
      <div>
        <SaveCardConsent
          checked={!!saveCard}
          onChange={(v) => onSaveCardChange?.(v)}
          methodType={selectedMethod}
        />
      </div>

      <div style={{
        padding: 16,
        borderRadius: 8,
        background: '#FAF8F3',
        border: '1px solid #E7E2D7',
        fontFamily: FONTS.mono,
        fontSize: 14,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: 'var(--text-muted)', fontFamily: FONTS.body }}>
            Invoice total
          </span>
          <span style={{ color: 'var(--text)' }}>{fmtCurrency(displayedBase)}</span>
        </div>
        {isCardFamily && displayedSurcharge > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontFamily: FONTS.body }}>
              Credit card surcharge ({pct}%)
            </span>
            <span style={{ color: 'var(--text)' }}>+ {fmtCurrency(displayedSurcharge)}</span>
          </div>
        )}
        {isCardFamily && quoteData && quoteData.funding !== 'credit' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontFamily: FONTS.body }}>
              No card surcharge ({quoteData.funding || 'debit'} card)
            </span>
            <span style={{ color: 'var(--text)' }}>$0.00</span>
          </div>
        )}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          paddingTop: 10, marginTop: 8, borderTop: '1px solid var(--border)',
          fontWeight: 700, color: 'var(--text)',
        }}>
          <span style={{ fontFamily: FONTS.body }}>
            {isCardFamily ? 'Total charged' : 'Total (bank transfer)'}
          </span>
          <span>{fmtCurrency(buttonAmount)}</span>
        </div>
      </div>

      {elementError && (
        <div style={{
          background: 'rgba(200,16,46,0.06)',
          border: '1px solid var(--danger)',
          borderRadius: 8,
          padding: '12px 14px',
          fontSize: 14,
          color: 'var(--danger)',
        }}>
          {elementError}
        </div>
      )}

      <BrandButton variant="primary" fullWidth onClick={awaitingConfirm ? handleFinalizePayment : handleSubmit} disabled={disabled}>
        {processing
          ? 'Processing…'
          : !ready
            ? 'Loading payment form…'
            : syncingAmount
              ? 'Updating total…'
              : amountSyncError
                ? 'Update total to continue'
                : awaitingConfirm
                  ? `Confirm & Pay ${fmtCurrency(displayedTotal)}`
                  : isCardFamily
                    ? 'Continue to review'
                    : `Pay ${fmtCurrency(buttonAmount)}`}
      </BrandButton>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 7,
        fontSize: 14,
        color: 'var(--text-muted)',
      }}>
        <Icon name="lock" size={14} strokeWidth={2} />
        <span>256-bit encrypted · Processed by Stripe</span>
      </div>
    </div>
  );
}

// ── Main /pay/:token V2 page ───────────────────────────────────────
export default function PayPageV2() {
  const { token } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const saveCardDefault = shouldDefaultSaveCard(location.search);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentState, setPaymentState] = useState('idle');
  const [paymentError, setPaymentError] = useState(null);
  const [stripeSetup, setStripeSetup] = useState(null);
  const [saveCard, setSaveCard] = useState(saveCardDefault);

  useEffect(() => {
    fetch(`${API_BASE}/pay/${token}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Invoice not found' : 'Failed to load');
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [token]);

  // Stripe redirect return (3DS, bank redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirectStatus = params.get('redirect_status');
    if (redirectStatus === 'succeeded') {
      navigate(`/receipt/${token}?fresh=1`, { replace: true });
    }
  }, [navigate, token]);

  // Already paid / ACH pending → redirect to receipt page (no ?fresh=1 — this is a return visit)
  useEffect(() => {
    if (data?.invoice?.status === 'paid' || data?.invoice?.status === 'processing') {
      navigate(`/receipt/${token}`, { replace: true });
    }
  }, [data, navigate, token]);

  // Create Stripe PaymentIntent once invoice data loads
  useEffect(() => {
    if (!data || data.invoice.status === 'paid' || data.invoice.status === 'processing') return;
    if (!data.stripe?.available || !data.stripe?.publishableKey) {
      const message = 'Payment processing is temporarily unavailable. Please call (941) 297-5749.';
      setPaymentError(message);
      setPaymentState('error');
      reportPaymentError(token, {
        phase: 'setup',
        methodCategory: 'card',
        message,
        code: 'stripe_unavailable',
      });
      return;
    }
    setPaymentState('setup');
    fetch(`${API_BASE}/pay/${token}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveCard: saveCardDefault }),
    })
      .then(async (r) => {
        const setup = await r.json().catch(() => ({}));
        if (!r.ok) throw serverReportedError(setup.error || 'Failed to initialize payment');
        return setup;
      })
      .then((setup) => {
        setStripeSetup({
          clientSecret: setup.clientSecret,
          paymentIntentId: setup.paymentIntentId,
          baseAmount: setup.baseAmount ?? setup.amount,
          cardSurchargeRate: setup.cardSurchargeRate ?? 0.03,
          publishableKey: setup.publishableKey || data.stripe.publishableKey,
        });
        setPaymentState('ready');
      })
      .catch((err) => {
        setPaymentState('error');
        setPaymentError(err.message);
        if (!err.serverReported) {
          reportPaymentError(token, paymentErrorPayload(err, {
            phase: 'setup',
            methodCategory: 'card',
          }));
        }
      });
  }, [data, token, saveCardDefault]);

  useEffect(() => {
    if (saveCardDefault) setSaveCard(true);
  }, [saveCardDefault]);

  // The server replaced the PaymentIntent for a tender switch (the old PI had
  // an incompatible PaymentMethod attached). Swap in the fresh clientSecret —
  // PaymentForm is keyed by paymentIntentId, so it fully re-mounts Stripe
  // Elements against the new intent.
  const handlePaymentIntentReplaced = useCallback(({ clientSecret, paymentIntentId, baseAmount }) => {
    if (!clientSecret || !paymentIntentId) return;
    setPaymentError(null);
    setStripeSetup((prev) => (prev ? {
      ...prev,
      clientSecret,
      paymentIntentId,
      baseAmount: baseAmount ?? prev.baseAmount,
    } : prev));
  }, []);

  const handlePaymentSuccess = async (paymentIntent, methodCategory = null) => {
    try {
      const confirmRes = await fetch(`${API_BASE}/pay/${token}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: paymentIntent.id, methodCategory }),
      });
      const confirmBody = await confirmRes.json().catch(() => ({}));
      if (!confirmRes.ok) {
        throw serverReportedError(confirmBody.error || 'Local payment confirmation failed');
      }
    } catch (err) {
      // Stripe already charged — webhook will reconcile if confirm failed
      console.error('Confirm call failed (webhook will reconcile):', err);
      if (!err.serverReported) {
        reportPaymentError(token, paymentErrorPayload(err, {
          phase: 'confirm',
          methodCategory,
          paymentIntentId: paymentIntent.id,
        }));
      }
    }

    // Record save-payment-method consent if the customer opted in. The
    // server derives the correct authorization variant (card vs ACH —
    // they differ for NACHA/Reg E reasons) from the Stripe PaymentMethod
    // type, so we don't pass methodType from the client. The Stripe
    // webhook handles persisting the payment_methods row asynchronously
    // and back-fills the FK on the consent record.
    //
    // We check res.ok and retry once on transient failure — the server
    // can return 409/502/503 if it cannot verify the PaymentIntent or
    // method type. Payment has already succeeded by this point, so on
    // persistent failure we flag it via a query param on the receipt
    // redirect so the receipt page can surface the issue. The card may
    // be saved by Stripe (setup_future_usage) without a matching consent
    // row in that window — flagging it ensures the customer sees the
    // problem and Waves can reach out to re-confirm authorization.
    let consentFailed = false;
    if (saveCard && paymentIntent.payment_method) {
      const postConsent = () => fetch(`${API_BASE}/pay/${token}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stripePaymentMethodId: paymentIntent.payment_method, methodCategory }),
      });
      try {
        let res = await postConsent();
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 800));
          res = await postConsent();
        }
        if (!res.ok) {
          consentFailed = true;
          console.error(`Consent record failed: HTTP ${res.status}`);
        }
      } catch (err) {
        consentFailed = true;
        console.error('Consent record failed:', err);
        reportPaymentError(token, paymentErrorPayload(err, {
          phase: 'consent',
          methodCategory,
          paymentIntentId: paymentIntent.id,
        }));
      }
    }

    const params = consentFailed ? '?fresh=1&consent_failed=1' : '?fresh=1';
    navigate(`/receipt/${token}${params}`, { replace: true });
  };

  if (loading) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ padding: '64px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading invoice…
        </div>
      </WavesShell>
    );
  }

  if (error || !data) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            <SerifHeading style={{ marginBottom: 12 }}>We couldn't find that invoice</SerifHeading>
            <p style={{ margin: 0, fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
              The link may have expired or been mistyped. Give us a call and we'll sort it out — <HelpPhoneLink tone="dark" inline />.
            </p>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  const { invoice, service, customer } = data;
  const visibleLineItems = (invoice.lineItems || []).filter(item => !isDiscountLineItem(item));
  const invoiceAttachments = invoice.attachments || [];
  const isOverdue = invoice.status !== 'paid'
    && isInvoiceDueDateOverdue(invoice.dueDate);
  const serviceLabel = invoice.title || service.type || 'Service';
  const dueLabel = invoice.dueDate ? fmtDate(invoice.dueDate) : null;
  const serviceDateLabel = service.date ? fmtDate(service.date) : null;
  const locationLine = cityStateZip(customer);
  const invoiceStatusLabel = isOverdue ? 'Overdue' : dueLabel ? `Due ${dueLabel}` : 'Due now';

  return (
    <WavesShell variant="customer" topBar="solid">
      <div className="waves-customer-page waves-receipt-page">
        {isOverdue && (
          <div style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 8,
            background: 'rgba(200,16,46,0.08)',
            border: '1px solid rgba(200,16,46,0.28)',
            color: 'var(--danger)',
            fontSize: 14,
            fontWeight: 750,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <Icon name="warning" size={17} strokeWidth={2} />
            <span>This invoice is overdue. Please pay at your earliest convenience.</span>
          </div>
        )}

        <BrandCard padding={28}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            marginBottom: 18,
          }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', minWidth: 0 }}>
              <span style={{
                width: 46,
                height: 46,
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: isOverdue ? 'rgba(200,16,46,0.08)' : '#EEF6FF',
                color: isOverdue ? 'var(--danger)' : '#065A8C',
                border: `1px solid ${isOverdue ? 'rgba(200,16,46,0.22)' : '#BFE4F8'}`,
              }}>
                <Icon name={isOverdue ? 'warning' : 'document'} size={22} strokeWidth={2.4} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ ...eyebrow, marginBottom: 8 }}>
                  Invoice · {invoice.invoiceNumber}
                </div>
                <SerifHeading style={{ marginBottom: 8 }}>Review and pay</SerifHeading>
                <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {serviceLabel}
                  {serviceDateLabel ? ` · ${serviceDateLabel}` : ''}
                </p>
              </div>
            </div>
            <StatusPill tone={isOverdue ? 'overdue' : 'due'}>
              {invoiceStatusLabel}
            </StatusPill>
          </div>

          <div style={{
            ...subtlePanel,
            padding: 18,
            marginBottom: 20,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 18,
            alignItems: 'center',
          }}>
            <div>
              <div style={eyebrow}>Amount due</div>
              <div style={{ marginTop: 6, fontSize: 34, lineHeight: 1, fontWeight: 850, color: 'var(--text)', fontFamily: FONTS.body }}>
                {fmtCurrency(invoice.total)}
              </div>
              <div style={{ marginTop: 8, fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Pay securely online. Credit card surcharge, if any, is shown before payment.
              </div>
            </div>
            <span style={{
              width: 42,
              height: 42,
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--brand)',
              background: '#FFFFFF',
              border: '1px solid var(--border)',
            }}>
              <Icon name="document" size={20} strokeWidth={2} />
            </span>
          </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 16,
              marginBottom: 20,
            }}>
              <DetailBlock label="Billed to">
                <div style={{ fontWeight: 800 }}>{fullName(customer)}</div>
                {customer.address && <div>{customer.address}</div>}
                {locationLine && <div>{locationLine}</div>}
              </DetailBlock>
              <DetailBlock label="Service">
                <div style={{ fontWeight: 800 }}>{serviceLabel}</div>
                {serviceDateLabel && <div>{serviceDateLabel}</div>}
                {service.techName && <div style={{ color: 'var(--text-muted)' }}>Technician: {service.techName}</div>}
              </DetailBlock>
            </div>

            {visibleLineItems.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ ...eyebrow, marginBottom: 8 }}>Invoice items</div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: '0 14px',
                    padding: '10px 12px',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    fontWeight: 850,
                    textTransform: 'uppercase',
                    background: '#FAF8F3',
                    borderBottom: '1px solid #E7E2D7',
                  }}>
                    <div>Description</div>
                    <div style={{ textAlign: 'right' }}>Qty</div>
                    <div style={{ textAlign: 'right', minWidth: 82 }}>Amount</div>
                  </div>
                  {visibleLineItems.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto auto',
                        gap: '0 14px',
                        padding: '12px',
                        borderBottom: idx < visibleLineItems.length - 1 ? '1px solid var(--border)' : 'none',
                        fontSize: 14,
                        color: 'var(--text)',
                        alignItems: 'start',
                      }}
                    >
                      <div style={{ lineHeight: 1.45, minWidth: 0 }}>{item.description}</div>
                      <div style={{ textAlign: 'right', fontFamily: FONTS.mono }}>
                        {item.quantity || 1}
                      </div>
                      <div style={{ textAlign: 'right', fontFamily: FONTS.mono, minWidth: 82, fontWeight: 650 }}>
                        {fmtCurrency(item.amount ?? (item.quantity || 1) * (item.unit_price || 0))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {invoiceAttachments.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ ...eyebrow, marginBottom: 8 }}>Attachments</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {invoiceAttachments.map((attachment) => (
                    <a
                      key={attachment.id}
                      href={`${API_BASE}/pay/${token}/attachments/${attachment.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        minHeight: 44,
                        display: 'grid',
                        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        color: 'var(--text)',
                        textDecoration: 'none',
                        background: '#FFFFFF',
                      }}
                    >
                      <Icon name="paperclip" size={16} strokeWidth={2} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{
                          display: 'block',
                          fontSize: 14,
                          fontWeight: 750,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {attachment.fileName}
                        </span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                          {fmtFileSize(attachment.fileSizeBytes)}
                        </span>
                      </span>
                      <Icon name="download" size={16} strokeWidth={2} style={{ color: 'var(--brand)' }} />
                    </a>
                  ))}
                </div>
              </div>
            )}

            <div style={{ ...subtlePanel, padding: 16, marginBottom: 24 }}>
              <SummaryRow label="Subtotal" value={fmtCurrency(invoice.subtotal)} />
              {invoice.discountAmount > 0 && (
                <SummaryRow label={invoice.discountLabel || 'Discount'} value={`− ${fmtCurrency(invoice.discountAmount)}`} />
              )}
              {invoice.taxAmount > 0 && customer?.isCommercial && (
                <SummaryRow label={`Tax (${(Number(invoice.taxRate || 0) * 100).toFixed(2)}%)`} value={fmtCurrency(invoice.taxAmount)} />
              )}
              <SummaryRow label="Total due" value={fmtCurrency(invoice.total)} strong />
            </div>

            {invoice.notes && (
              <div style={{ marginBottom: 24, ...subtlePanel, padding: 16 }}>
                <div style={{ ...eyebrow, marginBottom: 8 }}>Notes</div>
                <p style={{ margin: 0, fontSize: 15, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {invoice.notes}
                </p>
              </div>
            )}

            <div className="waves-pay-payment-panel">
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 16,
            }}>
              <div>
                <div style={{ ...eyebrow, marginBottom: 6 }}>Pay securely</div>
                <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--text)', lineHeight: 1 }}>
                  {fmtCurrency(invoice.total)}
                </div>
                <div style={{ marginTop: 6, fontSize: 14, color: 'var(--text-muted)' }}>
                  {invoiceStatusLabel}
                </div>
              </div>
              <StatusPill tone="secure">
                <Icon name="lock" size={13} strokeWidth={2} />
                Secure
              </StatusPill>
            </div>

            {paymentError && (
              <div style={{
                background: 'rgba(200,16,46,0.06)',
                border: '1px solid var(--danger)',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 14,
                color: 'var(--danger)',
                marginBottom: 16,
                lineHeight: 1.45,
              }}>
                {paymentError}
              </div>
            )}
            {paymentState === 'ready' && stripeSetup ? (
              <PaymentForm
                key={stripeSetup.paymentIntentId}
                publishableKey={stripeSetup.publishableKey}
                clientSecret={stripeSetup.clientSecret}
                amount={stripeSetup.baseAmount}
                paymentIntentId={stripeSetup.paymentIntentId}
                token={token}
                cardSurchargeRate={stripeSetup.cardSurchargeRate}
                onSuccess={handlePaymentSuccess}
                onError={(msg) => setPaymentError(msg)}
                saveCard={saveCard}
                onSaveCardChange={setSaveCard}
                customerName={[customer.firstName, customer.lastName].filter(Boolean).join(' ')}
                customerEmail={customer.email}
                onPaymentIntentReplaced={handlePaymentIntentReplaced}
              />
            ) : paymentState === 'error' ? null : (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                Loading payment form…
              </div>
            )}
            </div>

            <div style={{ marginTop: 22, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 14 }}>
              <a
                href={`${API_BASE}/pay/${token}/invoice.pdf`}
                style={{
                  minHeight: 40,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-strong)',
                  color: 'var(--brand)',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 800,
                  background: '#FFFFFF',
                }}
              >
                <Icon name="download" size={16} strokeWidth={2} />
                Invoice PDF
              </a>
              <button
                type="button"
                onClick={() => window.print()}
                style={{
                  minHeight: 40,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-strong)',
                  color: 'var(--brand)',
                  background: '#FFFFFF',
                  fontSize: 14,
                  fontWeight: 800,
                  cursor: 'pointer',
                  fontFamily: FONTS.body,
                }}
              >
                <Icon name="print" size={16} strokeWidth={2} />
                Print
              </button>
            </div>
          </BrandCard>

        <div style={{ marginTop: 28, textAlign: 'center', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Questions about this invoice? <HelpPhoneLink tone="dark" inline /> or reply to the text or email.
        </div>
      </div>
    </WavesShell>
  );
}
