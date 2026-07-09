// client/src/pages/PayPageV2.jsx
//
// Customer-facing pay page (V2). Renders the Stripe Payment Element,
// credit-card surcharge (up to 2.9%) disclosure, save-card consent, and on success
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
//   sees the exact surcharge before payment. Credit cards = up to 2.9%.
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
// - computeChargeAmount: credit-card surcharge (up to 2.9%) for confirmed
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
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useGlassSurface } from '../glass/glass-engine';
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
import BrandFooter from '../components/BrandFooter';
import DocumentActionBar from '../components/DocumentActionBar';
import SaveCardConsent from '../components/billing/SaveCardConsent';
import { computeCardTotal, DEFAULT_CARD_SURCHARGE_RATE } from '../lib/cardSurcharge';
import { formatInvoiceDate, isInvoiceDueDateOverdue } from '../lib/invoiceDates';
import { getStripe } from '../lib/stripeLoader';

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

// Recurring acceptance pay links arrive with saveRequired=1
// (estimateInvoicePayUrlParams): a payment method on file is a signup
// precondition (owner ruling 2026-07-09 — per-application visits and prepay
// renewals auto-charge it), so the consent box renders checked + locked.
// URL param = pre-load display hint ONLY; the authority is the server's
// invoice.saveRequired (derived from billing_mode) and the pay endpoints
// force the flag server-side regardless of what the client sends
// (Codex #2507 P1 — a query param is user-editable).
function shouldRequireSaveCard(search = '') {
  try {
    const params = new URLSearchParams(search);
    return /^(1|true|yes)$/i.test(String(params.get('saveRequired') || ''));
  } catch {
    return false;
  }
}

function paymentErrorPayload(err, extra = {}) {
  return {
    message: err?.message || extra.message || 'Payment error',
    code: err?.code || err?.decline_code || err?.raw?.code || extra.code || null,
    stripeType: err?.type || err?.raw?.type || null,
    ...extra,
  };
}

// The Stripe instant bank-link (Financial Connections) can fail to finalize for
// certain institutions even after the bank reports success — the confirm returns
// "No account connected" / instant_verification_incomplete. Detect ONLY that
// specific case so the pay page can nudge the customer toward manual bank entry
// (routing + account), which sidesteps instant linking. Other errors are left
// untouched so the nudge never shows spuriously.
function isInstantLinkFailure(err) {
  const code = String(err?.code || err?.decline_code || err?.raw?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return code === 'instant_verification_incomplete'
    || msg.includes('no account connected')
    || msg.includes("account can't be connected")
    || msg.includes('account cannot be connected');
}

function serverReportedError(message, { status = null, inProgress = false, microdepositPending = false } = {}) {
  const err = new Error(message || 'Payment error');
  err.serverReported = true;
  if (status != null) err.status = status;
  err.inProgress = !!inProgress;
  err.microdepositPending = !!microdepositPending;
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

// Acceptance-deposit credit lines are prior payments, not discounts — they
// stay out of the item table but MUST surface in the totals block, or the
// visible rows won't reconcile to the total (subtotal $100 → total $51 with
// nothing explaining the gap).
function depositCreditTotalFromLineItems(lineItems) {
  return (lineItems || [])
    .filter((item) => item?.category === 'deposit_credit')
    .reduce((sum, item) => {
      const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
      return sum + (Number.isFinite(amount) ? Math.abs(amount) : 0);
    }, 0);
}

function fmtDate(d) {
  return formatInvoiceDate(d);
}

// Coverage sentence for an annual-prepay invoice. Returns null for ordinary
// invoices. prepay is the normalized descriptor from the /pay/:token payload.
function annualPrepayCalloutText(prepay) {
  if (!prepay) return null;
  const months = prepay.coverageMonths;
  const spanLabel = months ? `${months} months of service` : 'a full year of service';
  const start = prepay.termStart ? fmtDate(prepay.termStart) : null;
  const end = prepay.termEnd ? fmtDate(prepay.termEnd) : null;
  let body = `This is an annual prepayment — it covers ${spanLabel}`;
  if (start && end) body += `, ${start} through ${end}`;
  body += '.';
  if (prepay.setupFeeWaived) body += ' Your one-time setup fee is waived.';
  return body;
}

const subtlePanel = {
  background: CUSTOMER_SURFACE.page,
  border: `1px solid ${CUSTOMER_SURFACE.border}`,
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
    neutral: { bg: CUSTOMER_SURFACE.page, color: 'var(--text)', border: CUSTOMER_SURFACE.border },
    due: { bg: '#EEF6FF', color: '#065A8C', border: '#BFE4F8' },
    overdue: { bg: 'rgba(200,16,46,0.08)', color: 'var(--danger)', border: 'rgba(200,16,46,0.22)' },
    secure: { bg: '#F0FDF4', color: 'var(--success)', border: '#BBF7D0' },
  };
  const t = tones[tone] || tones.neutral;
  const glassClear = t === tones.neutral ? { 'data-glass-clear': '' } : {};
  return (
    <span {...glassClear} style={{
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

function annualPrepayStatusLabel(term = {}) {
  const status = String(term.status || '').toLowerCase();
  if (status === 'payment_pending') return 'Prepay invoice pending';
  if (status === 'active') return 'Annual prepay active';
  if (status === 'renewal_pending') return 'Renewal pending';
  if (status === 'cancelled' || status === 'canceled') return 'Cancelled';
  if (status === 'refunded') return 'Refunded';
  return status ? status.replace(/_/g, ' ') : 'Annual prepay';
}

function AnnualPrepayInvoicePanel({ term }) {
  if (!term) return null;
  const pending = term.status === 'payment_pending';
  return (
    <div style={{
      ...subtlePanel,
      padding: 14,
      marginBottom: 18,
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...eyebrow, color: pending ? '#9A6200' : 'var(--success)' }}>
          {annualPrepayStatusLabel(term)}
        </div>
        {term.prepayAmount != null && (
          <div style={{ fontFamily: FONTS.mono, fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
            {fmtCurrency(term.prepayAmount)}
          </div>
        )}
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)' }}>
        {term.planLabel || 'Annual prepay plan'}
        {term.termStart || term.termEnd
          ? ` · coverage ${fmtDate(term.termStart)} through ${fmtDate(term.termEnd)}`
          : ''}
      </div>
      {pending && (
        <div style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--text-muted)' }}>
          Annual prepaid coverage activates after this invoice is paid.
        </div>
      )}
    </div>
  );
}

// The individual visits an annual prepayment covers, with each visit's share of
// the total. Makes the "full year" concrete — it's four dated services, not one.
// Tagged "Prepaid" once the term is active, "Included" while the invoice is
// still pending payment.
function CoverageVisitsList({ visits, status }) {
  if (!Array.isArray(visits) || visits.length === 0) return null;
  const prepaid = ['active', 'renewed', 'renewal_pending', 'switch_plan']
    .includes(String(status || '').toLowerCase());
  const tag = prepaid ? 'Prepaid' : 'Included';
  return (
    <>
      <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 7 }}>
        {visits.map((v, i) => (
          <li key={i} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            fontSize: 14,
            lineHeight: 1.4,
            color: 'var(--text)',
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ color: 'var(--success)', display: 'inline-flex' }}>
                <Icon name="check" size={14} strokeWidth={3} />
              </span>
              <span>Visit {i + 1} of {visits.length} · target {fmtDate(v.date)}</span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
              {v.amount != null && (
                <span style={{ fontFamily: FONTS.mono, color: 'var(--text-muted)' }}>{fmtCurrency(v.amount)}</span>
              )}
              <span style={{ ...eyebrow, fontSize: 10, color: prepaid ? 'var(--success)' : '#9A6200' }}>{tag}</span>
            </span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4, color: 'var(--text-muted)' }}>
        Target dates — your actual visits follow your regular service route.
      </div>
    </>
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
function PaymentForm({ publishableKey, clientSecret, amount, paymentIntentId, token, cardSurchargeRate, onSuccess, onError, saveCard, saveCardLocked = false, onSaveCardChange, customerName, customerEmail, onPaymentIntentReplaced, thirdPartyBilled = false }) {
  const mountRef = useRef(null);
  const expressMountRef = useRef(null);
  const elementsRef = useRef(null);
  const stripeRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elementError, setElementError] = useState(null);
  // Shown only after an instant bank-link (Financial Connections) failure, to
  // steer the customer to the manual routing/account entry that avoids it.
  const [showManualEntryHint, setShowManualEntryHint] = useState(false);
  // Stripe.js failed to load (network/blocker). The shared loader already
  // auto-retries; this surfaces a one-tap Retry once those are exhausted so the
  // customer never has to reload the whole page to recover.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [selectedMethod, setSelectedMethod] = useState('card');
  // Initial fallback uses the same two-step rounding as server
  // computeChargeAmount so the customer's first paint matches the
  // PaymentIntent total even if the /update-amount sync fails.
  // Phase 1: PI starts at base amount — surcharge added at /finalize after PM inspection.
  const [displayedBase, setDisplayedBase] = useState(amount);
  const [displayedSurcharge, setDisplayedSurcharge] = useState(0);
  const [displayedTotal, setDisplayedTotal] = useState(amount);
  // Mirror of displayedBase readable inside the Payment Element's change
  // closure, so invalidating a quote can reset the totals to the base.
  const displayedBaseRef = useRef(amount);
  const [syncingAmount, setSyncingAmount] = useState(false);
  const [amountSyncError, setAmountSyncError] = useState(false);
  const selectedMethodRef = useRef('card');
  const syncingAmountRef = useRef(false);
  const amountSyncSeqRef = useRef(0);
  // Counts ALL in-flight /update-amount requests, not just the latest sequence.
  // syncingAmountRef must stay true until every overlapping request settles —
  // otherwise an older (out-of-order) request can rewrite the PI's tender after
  // a newer one cleared the flag, racing the ACH confirm lock.
  const pendingSyncCountRef = useRef(0);

  useEffect(() => {
    selectedMethodRef.current = selectedMethod;
  }, [selectedMethod]);

  // Returns a status object so callers that must gate on the tender lock — the
  // ACH submit path — can act deterministically instead of reading async React
  // state. Fire-and-forget callers (method-switch, save-card toggle) ignore it.
  //   { ok: true,  replaced: false, superseded: false } — PI locked to `methodCategory`
  //   { ok: true,  replaced: false, superseded: true  } — locked, but a newer sync took over
  //   { ok: true,  replaced: true  } — a fresh PI was minted; Elements re-mount
  //   { ok: false }                 — lock failed (error already surfaced)
  const syncAmountForMethod = useCallback(async (methodCategory, saveCardOverride, options = {}) => {
    if (!paymentIntentId || !token) return { ok: false };
    const syncSeq = amountSyncSeqRef.current + 1;
    amountSyncSeqRef.current = syncSeq;
    pendingSyncCountRef.current += 1;
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
        return { ok: true, replaced: true };
      }
      if (!options.skipFetchUpdates && elementsRef.current?.fetchUpdates) {
        const { error: fetchError } = await elementsRef.current.fetchUpdates();
        if (fetchError) {
          throw new Error(fetchError.message || 'Could not refresh the payment form');
        }
      }
      // A superseding sync (or a tender switch) means this lock is no longer the
      // authoritative one — a later request may still rewrite the PI. Report it
      // (superseded) so the ACH submit path aborts instead of confirming, and
      // skip the now-stale cosmetic amount refresh.
      if (syncSeq !== amountSyncSeqRef.current || selectedMethodRef.current !== methodCategory) {
        return { ok: true, replaced: false, superseded: true };
      }
      setDisplayedBase(data.base);
      displayedBaseRef.current = data.base;
      setDisplayedSurcharge(data.surcharge);
      setDisplayedTotal(data.total);
      return { ok: true, replaced: false, superseded: false };
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
      return { ok: false, replaced: false };
    } finally {
      // Clear the in-flight flag only once EVERY overlapping request has
      // settled, regardless of completion order — a stale older request that
      // resolves after a newer one must not leave the flag falsely clear.
      pendingSyncCountRef.current = Math.max(0, pendingSyncCountRef.current - 1);
      if (pendingSyncCountRef.current === 0) {
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
    if (loadFailed) setLoadFailed(false);

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
                border: `1px solid ${CUSTOMER_SURFACE.text}`,
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
          // 'auto' (Stripe default) — let Stripe gate each wallet on real
          // device/browser eligibility. Forcing googlePay 'always' rendered the
          // Google Pay button on iOS, where its popup flow is blocked and the
          // tap dead-ends on Google's OR_BIBED_15 "pop-ups may be turned off"
          // error. Apple Pay (native, eligible) is unaffected.
          paymentMethods: { googlePay: 'auto' },
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
              confirmParams: { return_url: redirectReturnUrl() },
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
          // may have edited card details, making the old PM stale — and reset
          // the displayed totals derived from it, so the previous card's
          // surcharge and "Total charged" don't linger on screen.
          setAwaitingConfirm(false);
          setQuoteData(null);
          setDisplayedSurcharge(0);
          setDisplayedTotal(displayedBaseRef.current);
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
          setLoadFailed(true);
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
  }, [publishableKey, clientSecret, loadNonce]);

  const isCardFamily = selectedMethod !== 'us_bank_account';
  const buttonAmount = displayedTotal;

  // Return URL for redirect tenders (bank auth, wallet handoff): component
  // state does not survive the redirect, so carry the LIVE consent-box
  // state as the pay link's own saveCard param — the page-level
  // redirect-return effect re-derives saveCardDefault from the URL and
  // would otherwise skip the consent POST for a box the customer ticked on
  // an optional link (Codex #2507 round-6 P1). Read through a ref because
  // the Express Checkout confirm handler is registered once on mount and
  // would close over a stale prop. Never cleared when unticked: the server
  // treats a non-opted-in PI's consent POST as a silent no-op.
  const saveCardRef = useRef(saveCard);
  useEffect(() => { saveCardRef.current = saveCard; }, [saveCard]);
  const redirectReturnUrl = () => {
    if (!saveCardRef.current) return window.location.href;
    const url = new URL(window.location.href);
    url.searchParams.set('saveCard', '1');
    return url.toString();
  };

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

  // Display the surcharge percent derived from the authoritative rate — the
  // server quote's rateBps when a quote exists, else the cardSurchargeRate prop,
  // else the client default — so the disclosure never drifts from what is
  // actually charged.
  const surchargeRatePct = (() => {
    const bps = Number(quoteData?.rateBps);
    if (Number.isFinite(bps) && bps > 0) return bps / 100;
    const rate = Number(cardSurchargeRate);
    if (Number.isFinite(rate) && rate > 0) return rate * 100;
    return DEFAULT_CARD_SURCHARGE_RATE * 100;
  })();
  const pct = Number(surchargeRatePct.toFixed(2)).toString();

  const handleSubmit = async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setElementError(null);
    setShowManualEntryHint(false);

    // ACH: use the existing confirmPayment flow (no surcharge)
    if (selectedMethodRef.current === 'us_bank_account') {
      // The invoice PaymentIntent is locked to ONE tender family server-side,
      // and reusing an open intent on a pay-page reload resets it to card-only.
      // If we confirm a bank PaymentMethod against a still-card-only intent,
      // Stripe rejects it ("The PaymentMethod provided (us_bank_account) is not
      // allowed for this PaymentIntent") — the silent failure customers hit.
      // Re-lock the intent to us_bank_account and wait for it before confirming.
      try {
        // Let any in-flight tender sync settle so we re-lock from a known state.
        for (let i = 0; i < 100 && syncingAmountRef.current; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => { setTimeout(resolve, 50); });
        }
        // Still running after the wait: a slow prior /update-amount could land
        // AFTER our bank lock but BEFORE confirmPayment and relock the PI to
        // card, recreating the very failure we're closing. Abort and let the
        // customer retry from a settled state rather than confirm into a race.
        if (syncingAmountRef.current) {
          setElementError('Still updating your payment — please try again in a moment.');
          setProcessing(false);
          return;
        }
        const lock = await syncAmountForMethod('us_bank_account');
        if (!lock || !lock.ok) {
          // syncAmountForMethod already surfaced the error to the customer.
          setProcessing(false);
          return;
        }
        if (lock.replaced) {
          // A fresh PI was minted; Elements re-mount and the customer submits
          // again cleanly — don't confirm against the dead intent.
          setProcessing(false);
          return;
        }
        if (lock.superseded || syncingAmountRef.current || selectedMethodRef.current !== 'us_bank_account') {
          // Our lock was superseded by a newer sync, a sync is still in flight,
          // or the tender changed mid-submit — any of these can rewrite the PI
          // before confirm. Abort and let the customer retry from a settled state.
          setElementError('Still updating your payment — please try again in a moment.');
          setProcessing(false);
          return;
        }
      } catch (lockErr) {
        setElementError(lockErr.message || 'Could not prepare the bank payment. Please try again.');
        reportPaymentError(token, paymentErrorPayload(lockErr, {
          phase: 'ach_tender_lock',
          methodCategory: 'us_bank_account',
          paymentIntentId,
        }));
        setProcessing(false);
        return;
      }
      try {
        const { error, paymentIntent: pi } = await stripeRef.current.confirmPayment({
          elements: elementsRef.current,
          confirmParams: { return_url: redirectReturnUrl() },
          redirect: 'if_required',
        });
        if (error) {
          setElementError(error.message);
          if (isInstantLinkFailure(error)) setShowManualEntryHint(true);
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
        if (isInstantLinkFailure(err)) setShowManualEntryHint(true);
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
      displayedBaseRef.current = quote.base;
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
    { value: 'card', title: 'Card or wallet', detail: `Up to ${pct}% credit card surcharge`, icon: 'card' },
    { value: 'us_bank_account', title: 'Bank account', detail: 'No added fee', icon: 'building' },
  ];

  if (loadFailed) {
    return (
      <div style={{
        display: 'grid',
        gap: 12,
        padding: 16,
        borderRadius: 8,
        background: '#FFF7ED',
        border: '1px solid #FED7AA',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)' }}>
          We couldn’t load the secure payment form. This is usually a brief network hiccup.
        </div>
        <button
          type="button"
          onClick={() => { onError?.(null); setLoadFailed(false); setLoadNonce((n) => n + 1); }}
          style={{
            justifySelf: 'center',
            padding: '10px 20px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--brand, #0a6cff)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

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
        <span data-glass="soft" style={{
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
          Credit cards may add up to {pct}%. You will see the exact total before payment. Debit cards, prepaid cards,
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
                {...(active ? {} : { 'data-glass': 'chip' })}
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
                <span {...(active ? { 'data-glass': 'soft' } : { 'data-glass-clear': '' })} style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  background: active ? '#FFFFFF' : CUSTOMER_SURFACE.page,
                  border: `1px solid ${CUSTOMER_SURFACE.border}`,
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
          card variant covers card-network + TILA disclosures). Hidden for
          third-party-billed invoices: the AP contact paying is not the
          account holder, so we never offer to save their method on the
          homeowner's account (the server refuses it regardless). */}
      {!thirdPartyBilled && (
        <div>
          <SaveCardConsent
            checked={!!saveCard}
            locked={saveCardLocked}
            headline={saveCardLocked
              ? 'Payment method on file — required for recurring service'
              : undefined}
            onChange={(v) => onSaveCardChange?.(v)}
            methodType={selectedMethod}
          />
        </div>
      )}

      <div data-glass-clear="" style={{
        padding: 16,
        borderRadius: 8,
        background: CUSTOMER_SURFACE.page,
        border: `1px solid ${CUSTOMER_SURFACE.border}`,
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

      {showManualEntryHint && !isCardFamily && (
        <div style={{
          background: 'var(--surface-subtle, rgba(0,0,0,0.03))',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '12px 14px',
          fontSize: 14,
          lineHeight: 1.5,
          color: 'var(--text)',
        }}>
          <strong>Trouble linking your bank?</strong> Some banks don't support instant
          linking. Choose <strong>“Enter bank details manually”</strong> above and type
          your routing and account number instead — it avoids this issue, and bank
          payments still have no added fee.
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

// ── Covered-by-credit method capture ───────────────────────────────
// Account credit fully paid a required-save invoice, so no PaymentIntent
// exists and the normal save-card path never runs — this compact form
// confirms the SetupIntent /setup minted and persists the method via
// /setup-complete. Money is already settled; the consent box renders
// locked exactly like every required save.
function SetupMethodForm({ publishableKey, clientSecret, setupIntentId, token, onDone, onBankPending, onAchBlocked }) {
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [formError, setFormError] = useState(null);
  const [methodType, setMethodType] = useState('card');

  useEffect(() => {
    if (!publishableKey || !clientSecret) return undefined;
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
            },
          },
        });
        if (cancelled) return;
        elementsRef.current = elements;
        const payment = elements.create('payment');
        payment.on('ready', () => { if (!cancelled) setReady(true); });
        payment.on('change', (e) => {
          if (!cancelled) setMethodType(e?.value?.type === 'us_bank_account' ? 'us_bank_account' : 'card');
        });
        if (mountRef.current) payment.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) setFormError(err.message || 'Could not load the payment form');
      }
    })();
    return () => { cancelled = true; };
  }, [publishableKey, clientSecret]);

  const submit = async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setFormError(null);
    try {
      // redirect:'if_required' — a 3DS/bank-auth redirect returns to this
      // page with setup_intent params (handled by the page-level return
      // effect; the setup_intent.succeeded webhook is the backstop when
      // the browser never comes back).
      const { error: confirmError, setupIntent } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });
      if (confirmError) throw new Error(confirmError.message || 'Could not save the payment method');
      // ACH micro-deposit verification finishes days later — the webhook
      // completes enrollment then; show the pending guidance now.
      if (setupIntent && setupIntent.status !== 'succeeded') {
        onBankPending?.();
        return;
      }
      const res = await fetch(`${API_BASE}/pay/${token}/setup-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupIntentId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.microdepositPending) { onBankPending?.(); return; }
        // The bank method saved but enrollment was refused (ACH state
        // unhealthy) — this SetupIntent already succeeded and can't be
        // re-confirmed, so restart capture: the fresh mint is card-only
        // while the bank state is unhealthy (Codex #2507 round-8).
        if (body.enrollReason === 'ach_blocked') { onAchBlocked?.(body.error); return; }
        throw new Error(body.error || 'Could not save the payment method');
      }
      onDone?.(body);
    } catch (err) {
      setFormError(err.message || 'Could not save the payment method');
      setProcessing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div ref={mountRef} style={{ minHeight: 90 }} />
      <SaveCardConsent
        checked
        locked
        headline="Payment method on file — required for recurring service"
        onChange={() => {}}
        methodType={methodType}
      />
      {formError && (
        <div style={{
          background: 'rgba(200,16,46,0.06)',
          border: '1px solid var(--danger)',
          borderRadius: 8,
          padding: '10px 12px',
          fontSize: 14,
          color: 'var(--danger)',
        }}>
          {formError}
        </div>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={!ready || processing}
        style={{
          padding: '14px 18px',
          borderRadius: 10,
          border: 'none',
          background: COLORS.blueDeeper,
          color: '#fff',
          fontFamily: FONTS.body,
          fontSize: 16,
          fontWeight: 700,
          cursor: !ready || processing ? 'default' : 'pointer',
          opacity: !ready || processing ? 0.6 : 1,
        }}
      >
        {processing ? 'Saving…' : 'Save payment method'}
      </button>
    </div>
  );
}

// ── Main /pay/:token V2 page ───────────────────────────────────────
export default function PayPageV2() {
  // Full liquid-glass scene (owner 2026-07-09 — the quiet 'pro' wash is
  // retired; the pay lane renders the same scene as every glass surface).
  // Native data-glass markup — no classify() walker on this page.
  useGlassSurface(true, 'full');
  const { token } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const urlSaveRequiredHint = shouldRequireSaveCard(location.search);
  const saveCardDefault = shouldDefaultSaveCard(location.search) || urlSaveRequiredHint;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentState, setPaymentState] = useState('idle');
  const [paymentError, setPaymentError] = useState(null);
  const [stripeSetup, setStripeSetup] = useState(null);
  // Set when /setup reports an in-flight payment (409 + inProgress) — most often
  // an ACH bank debit still `processing`. We render a self-contained "bank
  // payment processing" state here rather than navigating to /receipt, whose
  // processing copy is driven only by local invoice/payment rows that can lag
  // the webhook on a fresh return (the customer would otherwise see a neutral
  // receipt). This flag comes from the server's live PI read, so it's accurate
  // even before the local rows catch up.
  const [bankProcessing, setBankProcessing] = useState(false);
  // A bank payment is in flight (above), but specifically an ACH micro-deposit
  // verification the customer has NOT finished — so the "processing" copy would
  // wrongly imply there's nothing left to do. When set, the same in-flight panel
  // shows verification guidance instead.
  const [microdepositVerifying, setMicrodepositVerifying] = useState(false);
  // Account credit fully covered a REQUIRED-SAVE invoice: money is settled,
  // but the plan still needs a payment method on file (no PI was minted, so
  // the normal save-card path never ran). invoice.captureNeeded (from the
  // GET or the /setup response) drives a mint of the capture SetupIntent
  // via POST /capture-setup — re-derived on every load so the step is
  // resumable across reloads, mint failures, and Stripe redirects.
  // States: null | {status:'minting'} | {status:'mint-error',message} |
  // {status:'ready',clientSecret,setupIntentId,publishableKey} |
  // {status:'done'} | {status:'bank-pending'}
  const [setupCapture, setSetupCapture] = useState(null);
  // Guards POST /setup to once per (token, saveCard): the partial-credit display
  // sync below mutates `data`, which would otherwise re-run the setup effect and
  // re-POST /setup — churning the just-minted PaymentIntent (the second call sees
  // it as requires_payment_method and the stale-PI triage cancels/replaces it).
  const setupPostedRef = useRef(null);
  const [saveCard, setSaveCard] = useState(saveCardDefault);
  // Server-authoritative requirement (invoice.saveRequired from the GET);
  // the URL param only pre-locks the box before data arrives so it never
  // flashes unlocked. Once the server says required, force the state on —
  // the pay endpoints enforce it server-side anyway.
  const saveCardRequired = data?.invoice?.saveRequired ?? urlSaveRequiredHint;
  useEffect(() => {
    if (data?.invoice?.saveRequired) setSaveCard(true);
  }, [data?.invoice?.saveRequired]);

  useEffect(() => {
    fetch(`${API_BASE}/pay/${token}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Invoice not found' : 'Failed to load');
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [token]);

  // Stripe redirect return (3DS, bank redirect).
  //
  // We deliberately do NOT special-case `redirect_status=processing` here: the
  // URL param can't be trusted (a bookmarked/stale return), and the browser can
  // arrive before the webhook flips invoices.status, so jumping straight to the
  // receipt would race into its neutral state. The ACH-return case is instead
  // handled server-authoritatively by the /setup effect below — its 409 carries
  // an `inProgress` flag (set only when Stripe confirms the PI is actually
  // processing/succeeded), and only then do we route to the receipt.
  //
  // Two save-related jobs happen here (Codex #2507 P1 round-3):
  //  - setup_intent params = a covered-by-credit CAPTURE return — complete it
  //    server-side (/setup-complete verifies the SI; the webhook is the
  //    backstop if this never runs) and never bounce to a receipt that
  //    doesn't exist for credit coverage.
  //  - a save-card PAYMENT redirect (bank auth / 3DS) unloaded the page
  //    before the normal post-confirm consent POST — fire it now with an
  //    empty body (the server derives the method from the invoice's own
  //    PaymentIntent and fails closed when save wasn't opted in).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirectStatus = params.get('redirect_status');
    const returnedSetupIntentId = params.get('setup_intent');
    if (returnedSetupIntentId) {
      window.history.replaceState({}, '', window.location.pathname);
      if (redirectStatus === 'succeeded') {
        fetch(`${API_BASE}/pay/${token}/setup-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setupIntentId: returnedSetupIntentId }),
        })
          .then(async (r) => {
            const body = await r.json().catch(() => ({}));
            if (r.ok) {
              // settled:false = the held credit no longer fully covers —
              // the invoice is still payable; re-derive real state instead
              // of showing "covered, nothing due".
              if (body?.settled === false) {
                window.location.replace(window.location.pathname);
                return;
              }
              setSetupCapture({ status: 'done' });
              setData((prev) => (prev?.invoice ? { ...prev, invoice: { ...prev.invoice, captureNeeded: false } } : prev));
            } else {
              setSetupCapture(body.microdepositPending ? { status: 'bank-pending' } : { status: 'minting' });
            }
          })
          .catch(() => setSetupCapture({ status: 'minting' }));
      } else {
        // Failed/abandoned setup return — restart capture (state re-derives
        // from the GET's captureNeeded either way).
        setSetupCapture({ status: 'minting' });
      }
      return;
    }
    if (redirectStatus === 'succeeded') {
      const finish = (consentFailed) => navigate(
        `/receipt/${token}${consentFailed ? '?fresh=1&consent_failed=1' : '?fresh=1'}`,
        { replace: true },
      );
      // Save flows post consent; a plain one-time redirect goes straight
      // to the receipt (no false consent_failed banner on a payment that
      // never involved saving). The gate is URL-first but SERVER-decided
      // (Codex #2507 round-6 P1): the confirm return_url carries the live
      // box state as saveCard=1, so saveCardDefault covers ticked flows —
      // but a required-save invoice opened from a bare /pay/:token (old
      // link, stripped params) has nothing in the URL, so before skipping
      // we ask the GET payload's own invoice.saveRequired. Unknown (GET
      // unreachable) reads as a save flow: the consent POST is a silent
      // no-op on a non-opted-in PI, so guessing wrong costs one request.
      // The POST is AWAITED with one retry, mirroring the normal
      // post-confirm path (round-5 P1): webhook enrollment is
      // consent-gated, so a dropped consent here would defer Auto Pay
      // forever with no signal — a persistent failure flags
      // consent_failed on the receipt instead.
      const postConsent = () => fetch(`${API_BASE}/pay/${token}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      (async () => {
        let saveFlow = saveCardDefault;
        if (!saveFlow) {
          try {
            const r = await fetch(`${API_BASE}/pay/${token}`);
            const d = r.ok ? await r.json() : null;
            saveFlow = d ? !!d.invoice?.saveRequired : true;
          } catch { saveFlow = true; }
        }
        if (!saveFlow) { finish(false); return; }
        try {
          let res = await postConsent();
          if (!res.ok) {
            await new Promise((r) => setTimeout(r, 800));
            res = await postConsent();
          }
          finish(!res.ok);
        } catch {
          finish(true);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, token]);

  // Promote "capture needed, nothing started" → the minting state. Entry
  // points: the /setup response and a fresh GET (reload / redirect return).
  useEffect(() => {
    if (data?.invoice?.status === 'prepaid' && data?.invoice?.captureNeeded && !setupCapture) {
      setSetupCapture({ status: 'minting' });
    }
  }, [data?.invoice?.status, data?.invoice?.captureNeeded, setupCapture]);

  // Mint the covered-by-credit capture SetupIntent — fires exactly once per
  // entry into the 'minting' state (explicit retry re-enters it). The mint
  // is retryable and the need is re-derived server-side on every call, so a
  // transient Stripe failure can never permanently bypass required capture.
  useEffect(() => {
    if (setupCapture?.status !== 'minting') return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/pay/${token}/capture-setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Could not start the payment method setup');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        if (body.alreadyChargeable) {
          // settled:false = the held credit no longer fully covers — the
          // invoice is still payable; re-derive real state instead of
          // showing "covered, nothing due" (Codex #2507 round-9).
          if (body.settled === false) {
            window.location.replace(window.location.pathname);
            return;
          }
          setSetupCapture({ status: 'done' });
          setData((prev) => (prev?.invoice ? { ...prev, invoice: { ...prev.invoice, captureNeeded: false } } : prev));
          return;
        }
        setSetupCapture({
          status: 'ready',
          clientSecret: body.clientSecret,
          setupIntentId: body.setupIntentId,
          publishableKey: body.publishableKey || data?.stripe?.publishableKey,
        });
      })
      .catch((e) => {
        if (!cancelled) setSetupCapture({ status: 'mint-error', message: e.message });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupCapture?.status, token]);

  // Already paid / ACH pending → redirect to receipt page (no ?fresh=1 — this is a return visit).
  // Prepaid (covered by account credit) does NOT redirect — it renders its own
  // "covered, nothing due" state below (no payment receipt for credit coverage).
  useEffect(() => {
    if (
      data?.invoice?.status === 'paid' ||
      data?.invoice?.status === 'processing'
    ) {
      navigate(`/receipt/${token}`, { replace: true });
    }
  }, [data, navigate, token]);

  // Create Stripe PaymentIntent once invoice data loads
  useEffect(() => {
    if (
      !data ||
      data.invoice.status === 'paid' ||
      data.invoice.status === 'prepaid' ||
      data.invoice.status === 'processing'
    )
      return;
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
    // Post /setup at most once per (token, saveCard). The partial-credit display
    // sync mutates `data` (a dependency of this effect); without this guard that
    // would re-run the effect and re-POST /setup, churning the PaymentIntent.
    const setupKey = `${token}:${saveCardDefault ? 1 : 0}`;
    if (setupPostedRef.current === setupKey) return;
    setupPostedRef.current = setupKey;
    setPaymentState('setup');
    fetch(`${API_BASE}/pay/${token}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveCard: saveCardDefault }),
    })
      .then(async (r) => {
        const setup = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw serverReportedError(setup.error || 'Failed to initialize payment', {
            status: r.status,
            inProgress: setup.inProgress,
            microdepositPending: setup.microdepositPending,
          });
        }
        return setup;
      })
      .then((setup) => {
        // Account credit fully covered the invoice at setup (no PI minted, null
        // clientSecret) — flip to the existing "covered, nothing due" prepaid
        // state instead of mounting a card form that would hang on "Loading
        // payment form…" with a null secret. A required-save invoice with
        // nothing chargeable on file additionally flags captureNeeded — the
        // mint effect below POSTs /capture-setup (retryable; the same state
        // is re-derived from the GET on any reload, so a transient mint
        // failure can never permanently bypass the required capture).
        if (setup.coveredByCredit || setup.status === 'prepaid') {
          setData((prev) => (prev
            ? { ...prev, invoice: { ...prev.invoice, status: 'prepaid', captureNeeded: !!setup.captureNeeded } }
            : prev));
          setPaymentState('idle');
          return;
        }
        // Setup may have auto-applied a PARTIAL account credit (first seam to
        // apply it on a reused link) — the PI is now initialized at the reduced
        // setup.baseAmount, so sync the displayed amount due + credit line to it.
        // Otherwise the page would keep showing the pre-credit gross from the
        // earlier read-only GET while Stripe charges the reduced amount.
        const setupAmountDue = Number(setup.amountDue ?? setup.baseAmount ?? setup.amount);
        if (Number.isFinite(setupAmountDue)) {
          setData((prev) => {
            if (!prev?.invoice) return prev;
            const total = Number(prev.invoice.total ?? setupAmountDue);
            const creditApplied = setup.creditApplied != null
              ? Math.max(0, Number(setup.creditApplied))
              : Math.max(0, Math.round((total - setupAmountDue) * 100) / 100);
            // CRITICAL: return the SAME object reference when nothing changed. The
            // setup effect depends on `data`, so handing back a new object every
            // time would re-run it and re-POST /setup forever. Only the first
            // partial-credit sync changes the amount; the idempotent re-run no-ops.
            const prevAmountDue = Number(prev.invoice.amountDue ?? prev.invoice.total);
            const prevCredit = Number(prev.invoice.creditApplied || 0);
            if (Math.abs(prevAmountDue - setupAmountDue) < 0.005
              && Math.abs(prevCredit - creditApplied) < 0.005) {
              return prev;
            }
            return { ...prev, invoice: { ...prev.invoice, amountDue: setupAmountDue, creditApplied } };
          });
        }
        setStripeSetup({
          clientSecret: setup.clientSecret,
          paymentIntentId: setup.paymentIntentId,
          baseAmount: setup.baseAmount ?? setup.amount,
          cardSurchargeRate: setup.cardSurchargeRate ?? 0.029,
          publishableKey: setup.publishableKey || data.stripe.publishableKey,
        });
        setPaymentState('ready');
      })
      .catch((err) => {
        // A 409 with inProgress means the server confirmed (via a live PI read)
        // that money is genuinely in flight — most often an ACH bank debit still
        // `processing` (clears over several business days). Showing a red
        // "payment already in progress" error here is what made customers retry
        // repeatedly; show the calm "bank payment processing" state instead. A
        // 409 WITHOUT inProgress is a recoverable conflict (e.g. a card PI stuck
        // in requires_action after an abandoned 3DS) — fall through to show the
        // error so the customer can retry.
        if (err.status === 409 && err.inProgress) {
          // Micro-deposit verification is in flight but NOT done — the same panel
          // renders verification guidance instead of "nothing more to do".
          if (err.microdepositPending) setMicrodepositVerifying(true);
          setBankProcessing(true);
          setPaymentState('idle');
          return;
        }
        // Allow a retry: the guard was set before the POST to stop the
        // partial-credit sync from re-posting an IN-FLIGHT setup, but a failed
        // setup must be retryable (else the customer is stuck until a reload).
        setupPostedRef.current = null;
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
    setSaveCard(saveCardDefault);
  }, [saveCardDefault, token, location.search]);

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
    // Payer-billed invoices never offer save-card (the PI isn't configured for
    // it and the consent UI is hidden), so don't post /consent off a stale
    // ?saveCard=1 parent state — the server would reject it and surface a
    // spurious consent_failed banner for an option the AP user never saw.
    if (saveCard && !data?.payer && paymentIntent.payment_method) {
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

  // Prepaid = covered by account credit. No payment is due and we don't show
  // a payment receipt (the credit may be goodwill, not a cash payment) — just
  // a friendly confirmation that nothing is owed. A required-save invoice
  // with nothing chargeable on file first runs the method-capture step:
  // credit paid THIS invoice, but the recurring plan still needs a method
  // for future visits/renewal (Codex #2507 P1).
  if (data.invoice?.status === 'prepaid') {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            {setupCapture && setupCapture.status !== 'done' ? (
              <>
                <SerifHeading style={{ marginBottom: 12 }}>Covered by credit — one more step</SerifHeading>
                <p style={{ margin: '0 0 16px', fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
                  Invoice {data.invoice.invoiceNumber || data.invoice.invoice_number || ''} has been
                  covered by your account credit — there's no payment today. Your recurring plan
                  does need a payment method on file for future visits, so add one below to finish up.
                </p>
                {setupCapture.status === 'minting' && (
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>Loading secure form…</p>
                )}
                {setupCapture.status === 'mint-error' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{
                      background: 'rgba(200,16,46,0.06)',
                      border: '1px solid var(--danger)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      fontSize: 14,
                      color: 'var(--danger)',
                    }}>
                      {setupCapture.message || 'Could not start the payment method setup.'}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSetupCapture({ status: 'minting' })}
                      style={{
                        padding: '12px 16px', borderRadius: 10, border: 'none',
                        background: COLORS.blueDeeper, color: '#fff',
                        fontFamily: FONTS.body, fontSize: 15, fontWeight: 700, cursor: 'pointer',
                      }}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {setupCapture.status === 'bank-pending' && (
                  <p style={{ margin: 0, fontSize: 15, color: 'var(--text)', lineHeight: 1.55 }}>
                    Your bank needs to be verified first: in the next 1–2 business days your bank
                    statement will show two small deposits from Stripe — confirm those amounts using
                    the link in the email Stripe sent you, and your payment method will be saved and
                    enabled automatically. Nothing else to do here.
                  </p>
                )}
                {setupCapture.status === 'ready' && (
                  <SetupMethodForm
                    publishableKey={setupCapture.publishableKey}
                    clientSecret={setupCapture.clientSecret}
                    setupIntentId={setupCapture.setupIntentId}
                    token={token}
                    onDone={(body) => {
                      // settled:false = the held credit no longer fully
                      // covers (spent elsewhere mid-capture) — the invoice
                      // is still payable, so re-derive real state instead
                      // of showing "covered, nothing due".
                      if (body?.settled === false) {
                        window.location.replace(window.location.pathname);
                        return;
                      }
                      setSetupCapture({ status: 'done' });
                      setData((prev) => (prev?.invoice ? { ...prev, invoice: { ...prev.invoice, captureNeeded: false } } : prev));
                    }}
                    onBankPending={() => setSetupCapture({ status: 'bank-pending' })}
                    onAchBlocked={() => setSetupCapture({ status: 'minting' })}
                  />
                )}
              </>
            ) : (
              <>
                <SerifHeading style={{ marginBottom: 12 }}>You're all set — nothing due</SerifHeading>
                <p style={{ margin: 0, fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
                  Invoice {data.invoice.invoiceNumber || data.invoice.invoice_number || ''} has been
                  covered by your account credit, so there's no payment to make. Thanks for being a
                  Waves customer! Questions? Give us a call — <HelpPhoneLink tone="dark" inline />.
                </p>
              </>
            )}
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  // An ACH bank payment is already in flight for this invoice (server confirmed
  // via a live PaymentIntent read). Show a calm, self-contained confirmation
  // instead of the pay form or a scary "already in progress" error — the debit
  // clears over a few business days and the receipt is emailed when it settles.
  if (bankProcessing) {
    const invoiceLabel = data.invoice?.invoiceNumber || data.invoice?.invoice_number || '';
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            {microdepositVerifying ? (
              <>
                <SerifHeading style={{ marginBottom: 12 }}>Verify your bank to finish paying</SerifHeading>
                <p style={{ margin: 0, fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
                  You started a bank (ACH) payment for invoice {invoiceLabel}. In the next 1–2
                  business days your bank will show two small deposits from Stripe — enter those
                  amounts using the link in the email Stripe sent you to confirm and complete the
                  payment. Until then there’s nothing to re-enter here. Questions? Give us a call
                  — <HelpPhoneLink tone="dark" inline />.
                </p>
              </>
            ) : (
              <>
                <SerifHeading style={{ marginBottom: 12 }}>Your bank payment is processing</SerifHeading>
                <p style={{ margin: 0, fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
                  We’ve got a bank (ACH) payment in progress for invoice {invoiceLabel}. Bank transfers
                  take a few business days to clear — there’s nothing more you need to do, and we’ll
                  email your receipt once it settles. Questions? Give us a call — <HelpPhoneLink tone="dark" inline />.
                </p>
              </>
            )}
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  const { invoice, service, customer, payer } = data;
  const visibleLineItems = (invoice.lineItems || []).filter(item => !isDiscountLineItem(item));
  const depositCreditTotal = depositCreditTotalFromLineItems(invoice.lineItems);
  const invoiceAttachments = invoice.attachments || [];
  const annualPrepay = invoice.annualPrepay || null;
  const isOverdue = invoice.status !== 'paid'
    && isInvoiceDueDateOverdue(invoice.dueDate);
  // Generated invoice titles carry a "— Month YYYY" suffix that doubles
  // the service date in the header — strip it when a service date renders.
  const rawServiceLabel = invoice.title || service.type || 'Service';
  const serviceLabel = service.date
    ? rawServiceLabel.replace(/\s+[—–-]+\s+[A-Z][a-z]+ \d{4}$/, '')
    : rawServiceLabel;
  const dueLabel = invoice.dueDate ? fmtDate(invoice.dueDate) : null;
  const serviceDateLabel = service.date ? fmtDate(service.date) : null;
  const locationLine = cityStateZip(customer);
  const invoiceStatusLabel = isOverdue ? 'Overdue' : dueLabel ? `Due ${dueLabel}` : 'Due now';
  const prepayCalloutText = annualPrepayCalloutText(invoice.annualPrepay);

  return (
    <WavesShell variant="customer" topBar="solid">
      {/* The Print button below calls window.print() — back the
          waves-no-print marker with an actual print rule (ReceiptPage
          defines its own local copy) so the newsletter card + identity
          footer and shell chrome stay out of the invoice printout. */}
      <style>{`
        @media print {
          @page { margin: 0.5in; }
          body { background: #FFFFFF !important; }
          header, footer, .waves-no-print { display: none !important; }
        }
      `}</style>
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

        {/* Invoice PDF is the pre-existing server render; document icon tile
            removed with the other decorative icons (owner 2026-07-09). */}
        <DocumentActionBar
          pdfUrl={`${API_BASE}/pay/${token}/invoice.pdf`}
          pdfFileName="Waves_Invoice.pdf"
          shareTitle={`Waves invoice ${invoice.invoiceNumber || ''}`.trim()}
        />
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

          <div data-glass-clear="" style={{
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
                {fmtCurrency(invoice.amountDue ?? invoice.total)}
              </div>
              <div style={{ marginTop: 8, fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Pay securely online. Credit card surcharge, if any, is shown before payment.
              </div>
            </div>
            {/* Document icon tile removed (owner 2026-07-09 — no decorative icons). */}
          </div>

            {prepayCalloutText && (
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                padding: 16,
                borderRadius: 8,
                marginBottom: 20,
                background: '#EEF6FF',
                border: '1px solid #BFE4F8',
              }}>
                {/* Calendar icon tile removed (owner 2026-07-09 — no decorative icons). */}
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...eyebrow, color: '#065A8C', marginBottom: 5 }}>Annual prepayment</div>
                  <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>
                    {prepayCalloutText}
                  </div>
                  <CoverageVisitsList
                    visits={annualPrepay?.coverageVisits}
                    status={annualPrepay?.status}
                  />
                </div>
              </div>
            )}

            <AnnualPrepayInvoicePanel term={annualPrepay} />

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 16,
              marginBottom: 20,
            }}>
              <DetailBlock label="Billed to">
                {payer ? (
                  <>
                    <div style={{ fontWeight: 800 }}>{payer.name}</div>
                    {payer.address && <div>{payer.address}</div>}
                    {[payer.city, [payer.state, payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') && (
                      <div>{[payer.city, [payer.state, payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</div>
                    )}
                    {payer.poNumber && <div style={{ color: 'var(--text-muted)' }}>PO: {payer.poNumber}</div>}
                  </>
                ) : (
                  <>
                    <div style={{ fontWeight: 800 }}>{fullName(customer)}</div>
                    {customer.address && <div>{customer.address}</div>}
                    {locationLine && <div>{locationLine}</div>}
                  </>
                )}
              </DetailBlock>
              {payer && (
                <DetailBlock label="Service address">
                  <div style={{ fontWeight: 800 }}>{fullName(customer)}</div>
                  {customer.address && <div>{customer.address}</div>}
                  {locationLine && <div>{locationLine}</div>}
                </DetailBlock>
              )}
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
                  <div data-glass-clear="" style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: '0 14px',
                    padding: '10px 12px',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    fontWeight: 850,
                    textTransform: 'uppercase',
                    background: CUSTOMER_SURFACE.page,
                    borderBottom: `1px solid ${CUSTOMER_SURFACE.border}`,
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
                      data-glass="chip" data-glass-pill=""
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

            <div data-glass-clear="" style={{ ...subtlePanel, padding: 16, marginBottom: 24 }}>
              <SummaryRow label="Subtotal" value={fmtCurrency(invoice.subtotal)} />
              {invoice.discountAmount > 0 && (
                <SummaryRow label={invoice.discountLabel || 'Discount'} value={`− ${fmtCurrency(invoice.discountAmount)}`} />
              )}
              {invoice.taxAmount > 0 && customer?.isCommercial && (
                <SummaryRow label={`Tax (${(Number(invoice.taxRate || 0) * 100).toFixed(2)}%)`} value={fmtCurrency(invoice.taxAmount)} />
              )}
              {depositCreditTotal > 0 && (
                <SummaryRow label="Deposit paid at acceptance" value={`− ${fmtCurrency(depositCreditTotal)}`} />
              )}
              {Number(invoice.creditApplied) > 0 && (
                <SummaryRow label="Account credit applied" value={`− ${fmtCurrency(invoice.creditApplied)}`} />
              )}
              <SummaryRow label="Total due" value={fmtCurrency(invoice.amountDue ?? invoice.total)} strong />
            </div>

            {invoice.notes && (
              <div data-glass-clear="" style={{ marginBottom: 24, ...subtlePanel, padding: 16 }}>
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
                  {fmtCurrency(invoice.amountDue ?? invoice.total)}
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
                saveCard={payer ? false : saveCard}
                saveCardLocked={!payer && saveCardRequired}
                onSaveCardChange={setSaveCard}
                thirdPartyBilled={!!payer}
                customerName={payer ? payer.name : [customer.firstName, customer.lastName].filter(Boolean).join(' ')}
                customerEmail={payer ? (payer.email || '') : customer.email}
                onPaymentIntentReplaced={handlePaymentIntentReplaced}
              />
            ) : paymentState === 'error' ? null : (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                Loading payment form…
              </div>
            )}
            </div>

            {/* In-card PDF/Print chips superseded by the DocumentActionBar
                at the top of the page (owner 2026-07-09). */}
          </BrandCard>

        {/* "Questions about this invoice?" help line removed (owner 2026-07-09). */}
        {/* Newsletter signup lives only on the newsletter pages (owner
            2026-07-09, supersedes the 2026-07-08 glass-footer ruling).
            Hidden from the invoice printout via waves-no-print. */}
        <div className="waves-no-print">
          <BrandFooter />
        </div>
      </div>
    </WavesShell>
  );
}
