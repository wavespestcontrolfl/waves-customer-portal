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
import { COLORS as B, FONTS } from '../../theme-brand';
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

const PORTAL_BILLING = {
  surface: '#FFFFFF',
  page: '#FAF8F3',
  border: '#E7E2D7',
  borderStrong: '#D8D0C0',
  soft: '#F8FCFE',
  softBorder: '#CFE7F5',
  text: '#1B2C5B',
  body: '#3F4A65',
  muted: '#6B7280',
};

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
    <div style={AUTOPAY_CARD_STYLE}>
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
        <button type="button" onClick={onAction} style={{
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
  const nextChargeAmount = Number(next_charge_amount ?? monthly_rate ?? 0);
  const activeCard = payment_methods.find((p) => p.id === data.autopay_payment_method_id)
    || payment_methods.find((p) => p.is_default)
    || payment_methods[0];

  const themeMap = {
    active: { bg: '#F0FDF4', border: '#BBF7D0', dot: B.green, label: 'Active' },
    paused: { bg: `${B.orange}10`, border: `${B.orange}33`, dot: B.orange, label: 'Paused' },
    disabled: { bg: PORTAL_BILLING.page, border: PORTAL_BILLING.border, dot: PORTAL_BILLING.muted, label: 'Off' },
  };
  const theme = themeMap[state];

  const formatDate = (s) => {
    if (!s) return 'Not scheduled';
    const d = new Date(s);
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
    try {
      const setupData = await api.createSetupIntent('card_or_bank');
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
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: theme.dot, display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 850, color: PORTAL_BILLING.muted, textTransform: 'uppercase', letterSpacing: 0 }}>
              Auto Pay / {theme.label}
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 850, color: PORTAL_BILLING.text, fontFamily: FONTS.heading, lineHeight: 1.25 }}>
            {state === 'active'
              ? `Next charge: $${nextChargeAmount.toFixed(2)} on ${formatDate(next_charge_date)}`
              : state === 'paused'
                ? `Paused until ${formatDate(paused_until)}`
                : 'Auto Pay is off. Charges will not run automatically.'}
          </div>
          {activeCard && state !== 'disabled' && (
            <div style={{ fontSize: 14, color: PORTAL_BILLING.muted, marginTop: 5 }}>
              Charging {activeCard.brand || 'card'} ending in {activeCard.last4}
            </div>
          )}
        </div>
      </div>

      {!modal && errorBanner}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {state === 'active' && (
          <>
            <button type="button" style={btn('secondary')} disabled={saving} onClick={() => setModal('pause')}>Pause</button>
            <button type="button" style={btn('secondary')} disabled={saving} onClick={() => setModal('card')}>Change card</button>
            <button type="button" style={btn('secondary')} disabled={saving} onClick={() => setModal('day')}>Change billing day</button>
            <button type="button" style={btn('secondary')} disabled={saving} onClick={toggleAutopay}>Turn off</button>
          </>
        )}
        {state === 'paused' && (
          <>
            <button type="button" style={btn('primary')} disabled={saving} onClick={submitResume}>Resume now</button>
            <button type="button" style={btn('secondary')} disabled={saving} onClick={toggleAutopay}>Turn off</button>
          </>
        )}
        {state === 'disabled' && (
          <button type="button" style={btn('primary')} disabled={saving} onClick={enableAutopay}>Turn on Auto Pay</button>
        )}
      </div>

      {modal && (
        <Modal title={
          modal === 'pause' ? 'Pause Auto Pay' :
          modal === 'card' ? (state === 'disabled' ? 'Set up Auto Pay' : 'Change Auto Pay card') :
          'Change billing day'
        } onClose={() => { setModal(null); setErr(''); }}>
          {errorBanner}
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
                <button type="button" style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="button" style={btn('primary')} disabled={saving || !pauseUntil} onClick={submitPause}>
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
                payment_methods.map((pm) => (
                  <label key={pm.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: 12,
                    border: `1px solid ${selectedCard === pm.id ? PORTAL_BILLING.softBorder : PORTAL_BILLING.borderStrong}`,
                    background: selectedCard === pm.id ? PORTAL_BILLING.soft : PORTAL_BILLING.surface,
                    borderRadius: 8, cursor: 'pointer',
                  }}>
                    <input type="radio" name="autopay-card" checked={selectedCard === pm.id}
                      onChange={() => setSelectedCard(pm.id)} />
                    <span style={{ fontSize: 14, color: PORTAL_BILLING.body }}>
                      {pm.brand || 'Card'} ending in {pm.last4}
                      {pm.exp_month && pm.exp_year ? ` - exp ${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)}` : ''}
                    </span>
                  </label>
                ))
              )}
              <button type="button" style={{ ...btn('secondary'), alignSelf: 'flex-start' }} disabled={saving} onClick={startAddCard}>
                Add new card
              </button>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                {payment_methods.length > 0 && (
                  <button type="button" style={btn('primary')} disabled={saving || !selectedCard}
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
              {/* Save-card authorization — locked because saving is the
                  whole purpose of this modal. Shown so the consent row
                  reflects the copy the customer saw. */}
              <SaveCardConsent locked onChange={() => {}} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn('secondary')} disabled={saving} onClick={resetAddCard}>Back</button>
                <button type="button" style={btn('primary')} disabled={saving || !stripeReady} onClick={submitNewCard}>
                  {saving ? 'Saving...' : 'Save card'}
                </button>
              </div>
            </div>
          )}

          {modal === 'day' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: 14, color: PORTAL_BILLING.body, fontWeight: 600 }}>Charge day of month (1-28)</label>
              <input type="number" min={1} max={28} value={selectedDay}
                onChange={(e) => setSelectedDay(parseInt(e.target.value) || 1)}
                style={{ padding: 10, fontSize: 14, border: `1px solid ${PORTAL_BILLING.borderStrong}`, borderRadius: 8 }} />
              <div style={{ fontSize: 12, color: PORTAL_BILLING.muted }}>
                Auto Pay runs on this day each month. Max is the 28th so every month is covered.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button type="button" style={btn('primary')} disabled={saving || selectedDay < 1 || selectedDay > 28}
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
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: PORTAL_BILLING.surface, borderRadius: 8, padding: 20, maxWidth: 460, width: '100%',
        display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONTS.body,
        border: `1px solid ${PORTAL_BILLING.border}`,
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 850, color: PORTAL_BILLING.text, fontFamily: FONTS.heading }}>{title}</div>
          <button type="button" aria-label="Close" onClick={onClose} style={{
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
    </div>
  );
}
