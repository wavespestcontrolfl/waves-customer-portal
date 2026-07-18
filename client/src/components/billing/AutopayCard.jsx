// client/src/components/billing/AutopayCard.jsx
//
// Customer-facing autopay control card. Surfaces autopay state
// (enabled / disabled / paused), saved card on file, billing day,
// and a pause-until date picker. Lets the customer toggle autopay,
// pause/resume, change saved card, or set a different monthly
// billing day. Used inside the customer portal billing tab.
//
// Endpoints:
//   GET  /api/customer/autopay              (state)
//   PUT  /api/customer/autopay              (enable/disable/pause/billing-day)
//
// Server orchestrators (Codex follows via api.put):
//   server/routes/customer-autopay.js       (rate-limited 6 ops/min
//                                             per customer)
//   server/services/billing-cron.js         (the cron that respects
//                                             whatever this card sets)
//
// Customer-facing styling (CLAUDE.md): warm tone — no admin monochrome.
//
// Audit focus:
// - Optimistic toggle vs server confirm: the autopay switch should
//   roll back on PUT failure (auth expired, rate-limit hit, network
//   drop). Otherwise the customer sees autopay "on" while the server
//   has it off — they get billed nothing next month and don't know
//   why.
// - Pause-until date picker: dates must be ET-anchored
//   (etDateString / addETDays). A UTC date here means a customer in
//   FL who picks "pause through Friday" might resume on Thursday
//   night ET if the cron uses UTC midnight.
// - Billing-day change: changing from day 5 to day 25 mid-month —
//   confirm we don't fire BOTH days. The cron should track the LAST
//   billed cycle, not just "is today the billing day".
// - Card-on-file change: must invalidate the prior card's autopay
//   intent. A leftover intent on an old card = silent failed retries
//   the customer doesn't see.
// - SaveCardConsent linkage: confirm autopay enable cannot succeed
//   without a recorded consent row in payment_method_consents (legal
//   requirement for stored-card auto-billing).
// - Customer can only modify their own autopay: GET/PUT must filter
//   by the authenticated session's customer_id, not accept a
//   customer_id in the body.
// - Rate limit (6 ops/min) — confirm the limit returns a clean error
//   the UI can surface ("too many changes, try again in a minute"),
//   not a generic 429 that looks like a network failure.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import api from '../../utils/api';
import { etDateString, addETDays } from '../../lib/timezone';
import { getStripe } from '../../lib/stripeLoader';
import {
  buildSetupIntentReturnUrl,
  clearReturnedSetupIntent,
  getReturnedSetupIntent,
  redirectToSetupIntentAction,
  setupIntentIncompleteMessage,
} from '../../lib/stripeSetupActions';
import SaveCardConsent from './SaveCardConsent';
import Icon from '../Icon';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';

// Bank rows arrive under BOTH aliases — the server guards handle 'ach'
// and 'us_bank_account' equally (Codex #2706 r6), and the portal UI must
// too or alias rows lose the pending/failed affordances.
const isBankMethod = (t) => t === 'ach' || t === 'us_bank_account';

// Local alias kept for the many call sites below; values come from the
// shared customer palette (this used to be a hand-copied hex block).
const PORTAL_BILLING = CUSTOMER_SURFACE;

const AUTOPAY_CARD_STYLE = {
  background: PORTAL_BILLING.surface,
  border: `1px solid ${PORTAL_BILLING.border}`,
  borderRadius: 8,
  boxShadow: 'none',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  fontFamily: FONTS.body,
};

function AutopayStateCard({ icon = 'card', tone = 'brand', title, message, actionLabel, onAction }) {
  const iconTone = tone === 'danger'
    ? { background: `${B.red}10`, color: B.red }
    : { background: PORTAL_BILLING.soft, color: PORTAL_BILLING.text };
  return (
    <div data-glass="card" style={AUTOPAY_CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{
          width: 38,
          height: 38,
          borderRadius: 8,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          ...iconTone,
        }}>
          <Icon name={icon} size={18} strokeWidth={2} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 850, color: PORTAL_BILLING.muted, textTransform: 'uppercase', letterSpacing: 0 }}>
            Auto Pay
          </div>
          <div style={{ marginTop: 4, fontSize: 17, fontWeight: 850, color: PORTAL_BILLING.text, fontFamily: FONTS.heading, lineHeight: 1.3 }}>
            {title}
          </div>
          {message && (
            <div style={{ marginTop: 4, fontSize: 14, color: PORTAL_BILLING.muted, lineHeight: 1.45 }}>
              {message}
            </div>
          )}
        </div>
      </div>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} data-glass="chip" style={{
          alignSelf: 'flex-start',
          minHeight: 36,
          padding: '9px 13px',
          borderRadius: 8,
          border: `1px solid ${PORTAL_BILLING.borderStrong}`,
          background: PORTAL_BILLING.surface,
          color: PORTAL_BILLING.text,
          fontSize: 14,
          fontWeight: 850,
          fontFamily: FONTS.heading,
          cursor: 'pointer',
        }}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * AutopayCard — customer-facing autopay transparency + controls.
 *
 * 3 visual states: active (green), paused (amber), disabled (neutral).
 * Controls: toggle on/off, pause until date, change card, change billing day.
 */
export default function AutopayCard({ onStateChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null); // 'pause' | 'card' | 'day' | null
  const [pauseUntil, setPauseUntil] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [selectedCard, setSelectedCard] = useState('');
  const [selectedDay, setSelectedDay] = useState(1);
  const [addingCard, setAddingCard] = useState(false);
  const [stripeReady, setStripeReady] = useState(false);
  // Portal ACH (gated server-side): the Payment Element tab drives the
  // consent copy (card vs ACH authorization — not interchangeable), the
  // setup-intent response decides whether the bank tab exists at all, and
  // bankPending renders the micro-deposit notice after a deferred save.
  const [addMethodType, setAddMethodType] = useState('card');
  const [achOffered, setAchOffered] = useState(false);
  const [bankPending, setBankPending] = useState(false);
  const [bankVerifyUrl, setBankVerifyUrl] = useState('');
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const paymentElementRef = useRef(null);
  const mountRef = useRef(null);
  const processedReturnRef = useRef(false);

  const load = () =>
    api.getAutopay()
      .then((d) => {
        setData(d);
        setSelectedCard(d.autopay_payment_method_id || '');
        setSelectedDay(d.billing_day || 1);
        onStateChange?.(d);
      })
      .catch((e) => {
        setErr(e.message || 'Failed to load autopay');
        onStateChange?.({ state: 'unknown', loadError: true });
      })
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (modal !== 'card' && addingCard) resetAddCard();
  }, [modal]);

  useEffect(() => {
    if (processedReturnRef.current) return;
    const returned = getReturnedSetupIntent('autopay_add_card');
    if (!returned) return;

    processedReturnRef.current = true;
    setSaving(true);
    setErr('');
    api.saveStripeCard(null, returned.setupIntentId)
      .then(async (saved) => {
        const newId = saved?.card?.id;
        if (newId) {
          await api.updateAutopay({
            autopay_payment_method_id: newId,
            autopay_enabled: true,
          });
        }
        clearReturnedSetupIntent();
        await load();
        setModal(null);
      })
      .catch((e) => {
        setErr(e.message || 'Failed to finish bank account setup');
      })
      .finally(() => setSaving(false));
  }, []);

  const retryLoad = () => {
    setLoading(true);
    setErr('');
    load();
  };

  if (loading) {
    return (
      <AutopayStateCard
        icon="card"
        title="Loading Auto Pay"
        message="Checking saved payment method and billing schedule."
      />
    );
  }
  if (!data) {
    return (
      <AutopayStateCard
        icon="warning"
        tone="danger"
        title="Could not load Auto Pay"
        message={err || 'Try again to view and manage automatic billing.'}
        actionLabel="Try Again"
        onAction={retryLoad}
      />
    );
  }

  const rawState = data.state;
  const state = ['active', 'paused', 'disabled'].includes(rawState) ? rawState : 'disabled';
  const { next_charge_date, next_charge_amount, monthly_rate, payment_methods = [], paused_until } = data;
  // Per-application customers pay per completed visit — there is no monthly
  // charge to project, so never fall back to monthly_rate for them (the
  // server also sends next_charge_amount/date as null).
  const perApplicationBilling = data.billing_mode === 'per_application';
  // Annual prepay is term-covered — no monthly charge runs either; the saved
  // method is used at renewal.
  const annualPrepayBilling = data.billing_mode === 'annual_prepay';
  // Explicit per-visit lanes invoice each completed service (saved method
  // collects per invoice) — the monthly cron skips them too, so the monthly
  // projection copy is wrong for them as well (Codex r6).
  const perVisitBilling = data.billing_mode === 'per_visit' || data.billing_mode === 'one_time';
  const nonMonthlyBilling = perApplicationBilling || annualPrepayBilling || perVisitBilling;
  const nextChargeAmount = Number(next_charge_amount ?? (nonMonthlyBilling ? 0 : monthly_rate) ?? 0);
  // NULL monthly_rate = unpriced (manual quote pending), never a real $0.00
  // charge — the server sends next_charge_amount/date as null and the cron
  // will not charge, so promising "Next charge: $0.00" would be false.
  const monthlyUnpriced = !nonMonthlyBilling && !(nextChargeAmount > 0);
  // Surcharge disclosure lives here now that the healthy-state banner above is
  // hidden — this card is the only place an active autopay customer sees the
  // base + credit-card-surcharge breakdown before the charge runs.
  const nextChargeBase = Number(data.next_charge_base_amount ?? 0);
  const nextChargeSurcharge = Number(data.next_charge_surcharge_amount ?? 0);
  const activeCard = payment_methods.find((p) => p.id === data.autopay_payment_method_id)
    || payment_methods.find((p) => p.is_default)
    || payment_methods[0];

  // Status dot is a live indicator (owner directive 2026-07-06): blinking
  // green = charges are running automatically, solid red = they are not.
  const themeMap = {
    active: { bg: '#F0FDF4', border: '#BBF7D0', dot: B.green, label: 'Active' },
    paused: { bg: `${B.orange}10`, border: `${B.orange}33`, dot: B.red, label: 'Paused' },
    disabled: { bg: PORTAL_BILLING.page, border: PORTAL_BILLING.border, dot: B.red, label: 'Off' },
  };
  const theme = themeMap[state];

  // next_charge_date / paused_until are DATE columns ('YYYY-MM-DD' or
  // UTC-midnight ISO) — parse at noon so the label doesn't render a day
  // early for viewers behind UTC (same trap PortalPage.parseDate guards).
  const formatDate = (s) => {
    if (!s) return 'Not scheduled';
    const dateKey = typeof s === 'string' ? s.split('T')[0] : etDateString(new Date(s));
    const d = new Date(`${dateKey}T12:00:00`);
    if (Number.isNaN(d.getTime())) return 'Not scheduled';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const runUpdate = async (patch) => {
    setSaving(true); setErr('');
    try {
      await api.updateAutopay(patch);
      await load();
      setModal(null);
    } catch (e) {
      setErr(e.message || 'Update failed');
    }
    setSaving(false);
  };

  const toggleAutopay = () => runUpdate({ autopay_enabled: !data.autopay_enabled });

  const enableAutopay = () => {
    const methodId = selectedCard || activeCard?.id;
    if (!methodId) {
      setErr('Add a payment method before enabling Auto Pay.');
      setModal('card');
      return;
    }
    runUpdate({ autopay_enabled: true, autopay_payment_method_id: methodId });
  };

  const submitPause = async () => {
    if (!pauseUntil) { setErr('Pick a date'); return; }
    setSaving(true); setErr('');
    try {
      await api.pauseAutopay(pauseUntil, pauseReason || null);
      await load();
      setModal(null); setPauseUntil(''); setPauseReason('');
    } catch (e) { setErr(e.message || 'Pause failed'); }
    setSaving(false);
  };

  const submitResume = async () => {
    setSaving(true); setErr('');
    try { await api.resumeAutopay(); await load(); } catch (e) { setErr(e.message || 'Resume failed'); }
    setSaving(false);
  };

  const resetAddCard = () => {
    paymentElementRef.current = null;
    elementsRef.current = null;
    stripeRef.current = null;
    setAddingCard(false);
    setStripeReady(false);
  };

  const startAddCard = async () => {
    setErr('');
    setAddingCard(true);
    setStripeReady(false);
    setAddMethodType('card');
    setBankPending(false);
    try {
      // card_or_bank is a REQUEST — the server downgrades to card-only
      // while GATE_PORTAL_ACH_AUTOPAY is off; the echoed paymentMethodTypes
      // decides the bank affordances.
      const setupData = await api.createSetupIntent('card_or_bank');
      setAchOffered((setupData.paymentMethodTypes || []).includes('us_bank_account'));
      const stripe = await getStripe(setupData.publishableKey);
      stripeRef.current = stripe;
      const elements = stripe.elements({ clientSecret: setupData.clientSecret, appearance: { theme: 'stripe' } });
      elementsRef.current = elements;
      setTimeout(() => {
        if (mountRef.current) {
          const pe = elements.create('payment', {
            layout: { type: 'tabs' },
            paymentMethodOrder: ['apple_pay', 'google_pay', 'card', 'us_bank_account'],
          });
          pe.mount(mountRef.current);
          paymentElementRef.current = pe;
          pe.on('ready', () => setStripeReady(true));
          // Consent copy follows the selected tab — the box the customer
          // sees must be the text that gets snapshotted.
          pe.on('change', (event) => setAddMethodType(event?.value?.type || 'card'));
        }
      }, 100);
    } catch (e) {
      setErr(e.message || 'Failed to initialize payment form');
      setAddingCard(false);
    }
  };

  const submitNewCard = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setSaving(true); setErr('');
    try {
      const { error, setupIntent } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        confirmParams: { return_url: buildSetupIntentReturnUrl('autopay_add_card') },
        redirect: 'if_required',
      });
      if (error) { setErr(error.message); setSaving(false); return; }
      // Micro-deposit fallback (portal ACH): handled BEFORE the generic
      // redirect (Codex #2706 r1) — redirectToSetupIntentAction follows
      // hosted_verification_url, which would navigate away without ever
      // persisting the pending row or the ACH consent. The server saves
      // the bank account as PENDING (consent recorded, enrollment deferred
      // to the verification webhook) — it can't be put in charge of Auto
      // Pay yet, so no auto-select; the notice carries the hosted
      // verification link instead of the redirect.
      const awaitingMicrodeposits = setupIntent?.status === 'requires_action'
        && setupIntent?.next_action?.type === 'verify_with_microdeposits';
      if (awaitingMicrodeposits && setupIntent.payment_method) {
        await api.saveStripeCard(setupIntent.payment_method, setupIntent.id);
        setBankVerifyUrl(setupIntent?.next_action?.verify_with_microdeposits?.hosted_verification_url || '');
        resetAddCard();
        setModal(null);
        setBankPending(true);
        await load();
        setSaving(false);
        return;
      }
      if (redirectToSetupIntentAction(setupIntent)) return;
      if (!setupIntent || setupIntent.status !== 'succeeded') {
        setErr(setupIntentIncompleteMessage('enabling Auto Pay'));
        setSaving(false);
        return;
      }
      if (setupIntent && setupIntent.payment_method) {
        const saved = await api.saveStripeCard(setupIntent.payment_method, setupIntent.id);
        const newId = saved?.card?.id;
        resetAddCard();
        await load();
        if (newId) {
          setSelectedCard(newId);
          await api.updateAutopay({
            autopay_payment_method_id: newId,
            ...(state === 'disabled' ? { autopay_enabled: true } : {}),
          });
          await load();
          setModal(null);
        }
      }
    } catch (e) { setErr(e.message || 'Failed to save card'); }
    setSaving(false);
  };

  const card = AUTOPAY_CARD_STYLE;

  // Glass tags for the two button kinds — inert while no glass theme is
  // mounted on <html>, so gate-off rendering is untouched.
  const btnGlass = (kind = 'primary') =>
    kind === 'primary' ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' };

  const btn = (kind = 'primary') => ({
    padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 800,
    cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
    fontFamily: FONTS.heading,
    border: kind === 'primary' ? 'none' : `1px solid ${PORTAL_BILLING.borderStrong}`,
    background: kind === 'primary' ? PORTAL_BILLING.text : PORTAL_BILLING.surface,
    color: kind === 'primary' ? '#fff' : PORTAL_BILLING.text,
    minHeight: 36,
  });

  const errorBanner = err ? (
    <div style={{ color: B.red, fontSize: 14, padding: 10, background: `${B.red}10`, border: `1px solid ${B.red}33`, borderRadius: 8 }}>
      {err}
    </div>
  ) : null;

  return (
    <div data-glass="card" style={card}>
      <style>{`@keyframes autopayDotPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.25); } }`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: theme.dot, display: 'inline-block', animation: state === 'active' ? 'autopayDotPulse 2s ease-in-out infinite' : 'none' }} />
            <span style={{ fontSize: 12, fontWeight: 850, color: PORTAL_BILLING.text, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Auto Pay / {theme.label}
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 850, color: PORTAL_BILLING.text, fontFamily: FONTS.heading, lineHeight: 1.25 }}>
            {state === 'active'
              ? (perApplicationBilling
                ? 'Auto Pay is on — your saved payment method is charged after each application.'
                : annualPrepayBilling
                  ? 'Auto Pay is on — your plan is prepaid; your saved method is used at renewal.'
                  : perVisitBilling
                    ? 'Auto Pay is on — your saved payment method is charged after each completed service.'
                    : monthlyUnpriced
                    ? 'Auto Pay is on — your monthly rate is being finalized, so no charge is scheduled yet.'
                    // No date → drop the "on <date>" clause instead of
                    // rendering "on Not scheduled" (eyeball 07-12 finding 4).
                    : formatDate(next_charge_date) === 'Not scheduled'
                      ? `Next charge: $${nextChargeAmount.toFixed(2)}`
                      : `Next charge: $${nextChargeAmount.toFixed(2)} on ${formatDate(next_charge_date)}`)
              : state === 'paused'
                ? `Paused until ${formatDate(paused_until)}`
                : 'Auto Pay is off. Charges will not run automatically.'}
          </div>
          {state === 'active' && nextChargeSurcharge > 0 && (
            <div style={{ fontSize: 14, color: PORTAL_BILLING.muted, marginTop: 5 }}>
              ${nextChargeBase.toFixed(2)} + ${nextChargeSurcharge.toFixed(2)} credit card surcharge
            </div>
          )}
          {activeCard && state !== 'disabled' && (
            <div style={{ fontSize: 14, color: PORTAL_BILLING.muted, marginTop: 5 }}>
              Charging {isBankMethod(activeCard.method_type) ? 'bank account' : (activeCard.brand || 'card')} ending in {activeCard.last4}
            </div>
          )}
        </div>
      </div>

      {!modal && errorBanner}

      {!modal && bankPending && (
        <div style={{ padding: 10, background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, fontSize: 14, color: PORTAL_BILLING.body, marginBottom: 10 }}>
          Bank account saved. Stripe will send two small deposits in 1–2 business days — once you confirm them, the account is verified and Auto Pay can use it.
          {bankVerifyUrl && (
            <>
              {' '}
              <a href={bankVerifyUrl} target="_blank" rel="noopener noreferrer" style={{ color: PORTAL_BILLING.body, fontWeight: 850 }}>
                Confirm the deposits here
              </a>
              {' '}once they arrive.
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {state === 'active' && (
          <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving} onClick={() => setModal('manage')}>
            Manage Auto Pay
          </button>
        )}
        {state === 'paused' && (
          <>
            <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving} onClick={submitResume}>Resume now</button>
            <button type="button" {...btnGlass('secondary')} style={btn('secondary')} disabled={saving} onClick={toggleAutopay}>Turn off</button>
          </>
        )}
        {state === 'disabled' && (
          <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving} onClick={enableAutopay}>Turn on Auto Pay</button>
        )}
      </div>

      {modal && (
        <Modal title={
          modal === 'manage' ? 'Manage Auto Pay' :
          modal === 'pause' ? 'Pause Auto Pay' :
          modal === 'card' ? (state === 'disabled' ? 'Set up Auto Pay' : 'Change Auto Pay method') :
          'Change billing day'
        } onClose={() => { setModal(null); setErr(''); }}>
          {errorBanner}
          {modal === 'manage' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button type="button" {...btnGlass('secondary')} style={{ ...btn('secondary'), width: '100%' }} disabled={saving} onClick={() => setModal('pause')}>Pause payments</button>
              <button type="button" {...btnGlass('secondary')} style={{ ...btn('secondary'), width: '100%' }} disabled={saving} onClick={() => setModal('card')}>Change payment method</button>
              <button type="button" {...btnGlass('secondary')} style={{ ...btn('secondary'), width: '100%' }} disabled={saving} onClick={() => setModal('day')}>Change billing day</button>
              <button type="button" {...btnGlass('secondary')} style={{ ...btn('secondary'), width: '100%' }} disabled={saving} onClick={toggleAutopay}>Turn off Auto Pay</button>
            </div>
          )}
          {modal === 'pause' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: 14, color: PORTAL_BILLING.body, fontWeight: 600 }}>Pause until</label>
              <input type="date" value={pauseUntil} onChange={(e) => setPauseUntil(e.target.value)}
                min={etDateString(addETDays(new Date(), 1))}
                style={{ padding: 10, fontSize: 14, border: `1px solid ${PORTAL_BILLING.borderStrong}`, borderRadius: 8 }} />
              <label style={{ fontSize: 14, color: PORTAL_BILLING.body, fontWeight: 600 }}>Reason (optional)</label>
              <textarea value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} rows={2}
                placeholder="e.g. Out of town for the month"
                style={{ padding: 10, fontSize: 14, border: `1px solid ${PORTAL_BILLING.borderStrong}`, borderRadius: 8, fontFamily: FONTS.body }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" {...btnGlass('secondary')} style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving || !pauseUntil} onClick={submitPause}>
                  {saving ? 'Saving...' : 'Pause'}
                </button>
              </div>
            </div>
          )}

          {modal === 'card' && !addingCard && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {payment_methods.length === 0 ? (
                <div style={{ fontSize: 14, color: PORTAL_BILLING.muted }}>
                  No cards on file yet. Add a payment method before Auto Pay can run.
                </div>
              ) : (
                payment_methods.map((pm) => {
                  // A micro-deposit bank account can't be put in charge of
                  // Auto Pay until verification clears (the server refuses
                  // it too) — shown, but not selectable. Same for a failed
                  // verification.
                  const pendingBank = isBankMethod(pm.method_type) && ['pending_verification', 'verification_failed'].includes(pm.ach_status);
                  return (
                    <label key={pm.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: 12,
                      border: `1px solid ${selectedCard === pm.id ? PORTAL_BILLING.softBorder : PORTAL_BILLING.borderStrong}`,
                      background: selectedCard === pm.id ? PORTAL_BILLING.soft : PORTAL_BILLING.surface,
                      borderRadius: 8, cursor: pendingBank ? 'not-allowed' : 'pointer',
                      opacity: pendingBank ? 0.6 : 1,
                    }}>
                      <input type="radio" name="autopay-card" checked={selectedCard === pm.id}
                        disabled={pendingBank}
                        onChange={() => setSelectedCard(pm.id)} />
                      <span style={{ fontSize: 14, color: PORTAL_BILLING.body }}>
                        {isBankMethod(pm.method_type)
                          ? `${pm.bank_name || 'Bank account'} ending in ${pm.last4}${pm.ach_status === 'verification_failed' ? ' - verification failed' : (pendingBank ? ' - verification pending' : '')}`
                          : `${pm.brand || 'Card'} ending in ${pm.last4}${pm.exp_month && pm.exp_year ? ` - exp ${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)}` : ''}`}
                      </span>
                    </label>
                  );
                })
              )}
              <button type="button" {...btnGlass('secondary')} style={{ ...btn('secondary'), alignSelf: 'flex-start' }} disabled={saving} onClick={startAddCard}>
                Add new card
              </button>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" {...btnGlass('secondary')} style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                {payment_methods.length > 0 && (
                  <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving || !selectedCard}
                    onClick={() => runUpdate({
                      autopay_payment_method_id: selectedCard,
                      ...(state === 'disabled' ? { autopay_enabled: true } : {}),
                    })}>
                    {saving ? 'Saving...' : 'Use this card'}
                  </button>
                )}
              </div>
            </div>
          )}

          {modal === 'card' && addingCard && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div ref={mountRef} style={{ minHeight: 180 }} />
              {!stripeReady && <div style={{ fontSize: 14, color: PORTAL_BILLING.muted }}>Loading payment form...</div>}
              {achOffered && (
                <div style={{ fontSize: 14, color: PORTAL_BILLING.muted }}>
                  Bank payments have no card surcharge.
                </div>
              )}
              {/* Save-method authorization — locked because saving is the
                  whole purpose of this modal. Shown so the consent row
                  reflects the copy the customer saw; the copy follows the
                  Payment Element tab (card vs ACH authorization). */}
              <SaveCardConsent locked onChange={() => {}} methodType={addMethodType} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" {...btnGlass('secondary')} style={btn('secondary')} disabled={saving} onClick={resetAddCard}>Back</button>
                <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving || !stripeReady} onClick={submitNewCard}>
                  {saving ? 'Saving...' : (addMethodType === 'us_bank_account' ? 'Save bank account' : 'Save card')}
                </button>
              </div>
            </div>
          )}

          {modal === 'day' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: 14, color: PORTAL_BILLING.body, fontWeight: 600 }}>Charge day of month (1-28)</label>
              <input type="number" inputMode="numeric" min={1} max={28} value={selectedDay}
                onChange={(e) => setSelectedDay(parseInt(e.target.value) || 1)}
                style={{ padding: 10, fontSize: 14, border: `1px solid ${PORTAL_BILLING.borderStrong}`, borderRadius: 8 }} />
              <div style={{ fontSize: 12, color: PORTAL_BILLING.muted }}>
                Auto Pay runs on this day each month. Max is the 28th so every month is covered.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" {...btnGlass('secondary')} style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="button" {...btnGlass('primary')} style={btn('primary')} disabled={saving || selectedDay < 1 || selectedDay > 28}
                  onClick={() => runUpdate({ billing_day: selectedDay })}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  // Mounted only while open, so lock unconditionally — the page behind the
  // scrim shouldn't scroll on iOS while the dialog is up.
  useLockBodyScroll(true);
  // Portaled to <body>: under glass the host card carries backdrop-filter
  // (and a hover transform), which turns it into the containing block for
  // position:fixed children — the scrim would cover only the card.
  return createPortal(
    <div data-glass-scrim="" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div data-glass="modal" onClick={(e) => e.stopPropagation()} style={{
        background: PORTAL_BILLING.surface, borderRadius: 8, padding: 20, maxWidth: 460, width: '100%',
        display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONTS.body,
        border: `1px solid ${PORTAL_BILLING.border}`,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 850, color: PORTAL_BILLING.text, fontFamily: FONTS.heading }}>{title}</div>
          <button type="button" aria-label="Close" onClick={onClose} data-glass="chip" style={{
            background: PORTAL_BILLING.surface,
            border: `1px solid ${PORTAL_BILLING.borderStrong}`,
            borderRadius: 8,
            cursor: 'pointer',
            color: PORTAL_BILLING.muted,
            width: 36,
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Icon name="close" size={20} strokeWidth={2} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
