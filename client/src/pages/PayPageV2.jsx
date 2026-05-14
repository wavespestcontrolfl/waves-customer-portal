// client/src/pages/PayPageV2.jsx
//
// Customer-facing pay page (V2). Renders the Stripe Payment Element,
// 3.99% credit-card surcharge preview, save-card consent, and on success
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
// - 3.99% surcharge preview client-side vs authoritative server-side
//   computeChargeAmount. The two MUST agree on every payment method
//   (card / apple_pay / google_pay = 3.99%; ACH = 0%). Drift = customer
//   sees one number and gets charged another.
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
// - computeChargeAmount: 3.99% surcharge logic for card / apple_pay /
//   google_pay; 0% for ACH. Any other method (Cash App, Klarna)
//   needs an explicit branch — silently defaulting to 0% loses
//   money on every transaction.
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
import { useParams, useNavigate } from 'react-router-dom';
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

function fmtCurrency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isDiscountLineItem(item) {
  const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
  return item?._kind === 'discount' || item?.discount_for || amount < 0;
}

function fmtDate(d) {
  return formatInvoiceDate(d);
}

const subtlePanel = {
  background: '#F8FAFC',
  border: '1px solid #E1E7EF',
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
    neutral: { bg: '#F8FAFC', color: 'var(--text)', border: '#E1E7EF' },
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
function PaymentForm({ publishableKey, clientSecret, amount, paymentIntentId, token, cardSurchargeRate, onSuccess, onError, saveCard, onSaveCardChange }) {
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
  const initialCharge = computeCardTotal(amount, cardSurchargeRate || 0.0399);
  const [displayedBase, setDisplayedBase] = useState(amount);
  const [displayedSurcharge, setDisplayedSurcharge] = useState(initialCharge.surcharge);
  const [displayedTotal, setDisplayedTotal] = useState(initialCharge.total);
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
        throw new Error(data.error || 'Could not update payment total');
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
    } finally {
      if (syncSeq === amountSyncSeqRef.current) {
        syncingAmountRef.current = false;
        setSyncingAmount(false);
      }
    }
  }, [paymentIntentId, token, saveCard]);

  // Re-sync the PI whenever the save-card checkbox toggles — Stripe's
  // mandate wording switches between one-time and recurring on the
  // setup_future_usage change.
  useEffect(() => {
    if (!paymentIntentId) return;
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
        // We pre-apply the card-family surcharge on mount so the wallet
        // sheet displays the correct total ($X + 3.99%) — wallets are
        // always card-family, and updating the PI from inside the click
        // handler has too tight a deadline (1s).
        const express = elements.create('expressCheckout', {
          buttonTheme: { applePay: 'black', googlePay: 'black' },
          buttonType:  { applePay: 'buy',   googlePay: 'buy' },
          buttonHeight: 52,
          paymentMethodOrder: ['applePay', 'googlePay', 'link'],
          paymentMethods: { googlePay: 'always' },
        });

        express.on('ready', async () => {
          if (cancelled) return;
          // Surcharge wallets = card-family × 1.0399. Pre-apply now so the
          // wallet sheet shows the right total instead of the base amount.
          if (selectedMethodRef.current !== 'card') return;
          try { await syncAmountForMethod('card', saveCard); } catch { /* non-fatal */ }
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
              return;
            }
            if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
              onSuccess?.(paymentIntent, selectedMethodRef.current);
            } else if (paymentIntent && paymentIntent.status === 'requires_action') {
              setElementError('Additional verification required. Please follow the prompts.');
            }
          } catch (err) {
            setElementError(err.message || 'Payment failed');
          }
        });

        if (expressMountRef.current) express.mount(expressMountRef.current);

        // ── Payment Element — manual card + ACH
        //
        // Wallets moved into the Express Checkout Element above, so we
        // hide them here to avoid duplicate wallet buttons. ACH stays in
        // the accordion below.
        const paymentElement = elements.create('payment', {
          layout: {
            type: 'accordion',
            defaultCollapsed: false,
            radios: true,
            spacedAccordionItems: true,
          },
          paymentMethodOrder: ['card', 'us_bank_account'],
          wallets: { applePay: 'never', googlePay: 'never' },
        });

        paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
        paymentElement.on('change', (event) => {
          if (cancelled) return;
          setElementError(event.error?.message || null);
          const nextMethod = event.value?.type || null;
          if (nextMethod && nextMethod !== selectedMethodRef.current) {
            if (nextMethod !== 'us_bank_account') setAmountSyncError(false);
            selectedMethodRef.current = nextMethod;
            setSelectedMethod(nextMethod);
            syncAmountForMethod(nextMethod);
          }
        });

        paymentElement.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) onError?.(err.message || 'Failed to initialize payment form');
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey, clientSecret]);

  const isCardFamily = selectedMethod !== 'us_bank_account';
  const pct = (((cardSurchargeRate || 0.0399) * 100).toFixed(2)).replace(/\.?0+$/, '');
  const buttonAmount = isCardFamily ? displayedTotal : displayedBase;

  const selectPaymentMethod = (methodCategory) => {
    if (!ready || processing || syncingAmount || syncingAmountRef.current || methodCategory === selectedMethod) return;
    selectedMethodRef.current = methodCategory;
    setSelectedMethod(methodCategory);
    syncAmountForMethod(methodCategory);
  };

  const handleSubmit = async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setElementError(null);

    try {
      const { error, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });

      if (error) {
        setElementError(error.message);
        setProcessing(false);
        return;
      }

      if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
        onSuccess?.(paymentIntent, selectedMethodRef.current);
      } else if (paymentIntent && paymentIntent.status === 'requires_action') {
        setElementError('Additional verification required. Please follow the prompts.');
        setProcessing(false);
      } else {
        onSuccess?.(paymentIntent, selectedMethodRef.current);
      }
    } catch (err) {
      setElementError(err.message || 'Payment failed');
      setProcessing(false);
    }
  };

  const disabled = !ready || processing || syncingAmount || amountSyncError;
  const methodControlsDisabled = !ready || processing || syncingAmount;
  const methodOptions = [
    { value: 'card', title: 'Card or wallet', detail: `${pct}% processing fee`, icon: 'card' },
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
          A {pct}% processing fee is added to credit/debit card and wallet payments.
          Bank transfers (ACH) pay the quoted amount with no added fee.
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
                  background: active ? '#EEF6FF' : COLORS.white,
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
                  background: active ? '#FFFFFF' : '#F8FAFC',
                  border: '1px solid #E1E7EF',
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
        background: '#F8FAFC',
        border: '1px solid var(--border)',
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
              Card processing fee ({pct}%)
            </span>
            <span style={{ color: 'var(--text)' }}>+ {fmtCurrency(displayedSurcharge)}</span>
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

      <BrandButton variant="primary" fullWidth onClick={handleSubmit} disabled={disabled}>
        {processing
          ? 'Processing…'
          : !ready
            ? 'Loading payment form…'
            : syncingAmount
              ? 'Updating total…'
              : amountSyncError
                ? 'Update total to continue'
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentState, setPaymentState] = useState('idle');
  const [paymentError, setPaymentError] = useState(null);
  const [stripeSetup, setStripeSetup] = useState(null);
  const [saveCard, setSaveCard] = useState(false);

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
      setPaymentError('Payment processing is temporarily unavailable. Please call (941) 297-5749.');
      setPaymentState('error');
      return;
    }
    setPaymentState('setup');
    fetch(`${API_BASE}/pay/${token}/setup`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Failed to initialize payment'); return r.json(); })
      .then((setup) => {
        setStripeSetup({
          clientSecret: setup.clientSecret,
          paymentIntentId: setup.paymentIntentId,
          baseAmount: setup.baseAmount ?? setup.amount,
          cardSurchargeRate: setup.cardSurchargeRate ?? 0.0399,
          publishableKey: setup.publishableKey || data.stripe.publishableKey,
        });
        setPaymentState('ready');
      })
      .catch((err) => {
        setPaymentState('error');
        setPaymentError(err.message);
      });
  }, [data, token]);

  const handlePaymentSuccess = async (paymentIntent, methodType) => {
    try {
      await fetch(`${API_BASE}/pay/${token}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
      });
    } catch (err) {
      // Stripe already charged — webhook will reconcile if confirm failed
      console.error('Confirm call failed (webhook will reconcile):', err);
    }

    // Record save-payment-method consent if the customer opted in. The
    // Stripe webhook handles persisting the payment_methods row
    // asynchronously and will back-fill the FK on the consent record.
    // methodType lets the server snapshot the correct authorization
    // variant (card vs ACH — they differ for NACHA/Reg E reasons).
    if (saveCard && paymentIntent.payment_method) {
      try {
        await fetch(`${API_BASE}/pay/${token}/consent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stripePaymentMethodId: paymentIntent.payment_method,
            methodType: methodType || 'card',
          }),
        });
      } catch (err) {
        console.error('Consent record failed:', err);
      }
    }

    navigate(`/receipt/${token}?fresh=1`, { replace: true });
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
  const isOverdue = invoice.status !== 'paid'
    && isInvoiceDueDateOverdue(invoice.dueDate);
  const serviceLabel = invoice.title || service.type || 'Service';
  const dueLabel = invoice.dueDate ? fmtDate(invoice.dueDate) : null;
  const serviceDateLabel = service.date ? fmtDate(service.date) : null;
  const locationLine = cityStateZip(customer);

  return (
    <WavesShell variant="customer" topBar="solid">
      <div className="waves-customer-page waves-pay-page">
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

        <div className="waves-billing-grid">
          <BrandCard padding={28}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 18 }}>
              <div>
                <div style={{ ...eyebrow, marginBottom: 8 }}>Invoice {invoice.invoiceNumber}</div>
                <SerifHeading style={{ marginBottom: 8 }}>Review and pay</SerifHeading>
                <div style={{ fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {serviceLabel}
                  {serviceDateLabel ? ` · ${serviceDateLabel}` : ''}
                </div>
              </div>
              <StatusPill tone={isOverdue ? 'overdue' : 'due'}>
                {isOverdue ? 'Overdue' : dueLabel ? `Due ${dueLabel}` : 'Due now'}
              </StatusPill>
            </div>

            <div style={{
              ...subtlePanel,
              padding: 18,
              marginBottom: 18,
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
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
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
                    background: '#F8FAFC',
                    borderBottom: '1px solid var(--border)',
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

            <div style={{ ...subtlePanel, padding: 16 }}>
              <SummaryRow label="Subtotal" value={fmtCurrency(invoice.subtotal)} />
              {invoice.discountAmount > 0 && (
                <SummaryRow label={invoice.discountLabel || 'Discount'} value={`− ${fmtCurrency(invoice.discountAmount)}`} />
              )}
              {invoice.taxAmount > 0 && customer?.isCommercial && (
                <SummaryRow label={`Tax (${(Number(invoice.taxRate || 0) * 100).toFixed(2)}%)`} value={fmtCurrency(invoice.taxAmount)} />
              )}
              <SummaryRow label="Total due" value={fmtCurrency(invoice.total)} strong />
            </div>

            <div style={{ marginTop: 16 }}>
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
                <Icon name="document" size={16} strokeWidth={2} />
                Invoice PDF
              </a>
            </div>
          </BrandCard>

          <BrandCard padding={24} style={{ position: 'sticky', top: 84 }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 16,
            }}>
              <div>
                <div style={{ ...eyebrow, marginBottom: 6 }}>Pay securely</div>
                <div style={{ fontSize: 20, fontWeight: 850, color: 'var(--text)', lineHeight: 1.2 }}>
                  {fmtCurrency(invoice.total)}
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
              />
            ) : paymentState === 'error' ? null : (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                Loading payment form…
              </div>
            )}
          </BrandCard>
        </div>

        <div style={{ marginTop: 28, textAlign: 'center', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Questions about this invoice? <HelpPhoneLink tone="dark" inline /> or reply to the text or email.
        </div>
      </div>
    </WavesShell>
  );
}
