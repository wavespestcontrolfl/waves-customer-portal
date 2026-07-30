/**
 * Public "secure your appointment" page — /secure/:token.
 *
 * Linked from the appointment-card-request funnel's one SMS (card-on-file
 * spec §3 Phase 5.2): bookings that didn't ride the estimate accept
 * (office-created, AI-booked, /book) save their card on file here. Nothing
 * is charged on this page — a SetupIntent saves the card, consent is the
 * authorization artifact, and charges happen at service completion through
 * the existing per-application path.
 *
 * Token-gated (no login), mirroring ReschedulePage's model: fetch
 * GET /api/public/secure-card/:token, render by state, confirm the Stripe
 * SetupIntent (InlineAutoPayCapture — wallets first, consent checkbox
 * gated), then POST /complete where the server live-verifies the intent
 * against Stripe before saving anything. A 3DS redirect returns here with
 * ?setup_intent=...&redirect_status=succeeded — completed on mount.
 *
 * Styling follows the customer-facing brand idiom used by ReschedulePage
 * (WavesShell customer variant + warm surface palette + inline styles).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { WavesShell } from '../components/brand';
import BrandFooter from '../components/BrandFooter';
import { useGlassSurface } from '../glass/glass-engine';
import InlineAutoPayCapture from '../components/estimate/InlineAutoPayCapture';
import SecurePlanChoice from '../components/estimate/SecurePlanChoice';
import { fmtMoney } from '../lib/money';
import { loadStripeSdk } from '../lib/stripeLoader';
import {
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const S = {
  surface: '#FFFFFF',
  page: '#FAF8F3',
  border: '#E7E2D7',
  text: '#04395E',
  body: '#3F4A65',
  muted: CUSTOMER_SURFACE.muted,
};

const PRIMARY_CTA = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  minHeight: 48,
  padding: '0 20px',
  background: COLORS.glassNavy,
  color: COLORS.white,
  border: `1px solid ${COLORS.glassNavy}`,
  borderRadius: 8,
  fontFamily: FONTS.ui,
  fontWeight: 800,
  fontSize: 15,
  cursor: 'pointer',
  textDecoration: 'none',
};

function Shell({ children }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 640, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: S.text }}>
        {children}
        <BrandFooter />
      </div>
    </WavesShell>
  );
}

function Card({ children, style, ...rest }) {
  return (
    <div data-glass="card" {...rest} style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 12, padding: 24, marginBottom: 16, ...style }}>
      {children}
    </div>
  );
}

function ContactRow() {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
      <a href={WAVES_SUPPORT_SMS_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Text Waves</a>
      <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Call Waves</a>
    </div>
  );
}

function VisitSummary({ data }) {
  const parts = [data.serviceType, data.dateDisplay, data.windowDisplay].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div data-glass="soft" style={{ background: '#F8FCFE', border: '1px solid #CFE7F5', borderRadius: 8, padding: '12px 14px', marginTop: 12, fontSize: 15, color: S.text, fontWeight: 600 }}>
      {parts.join(' · ')}
    </div>
  );
}

export default function SecureAppointmentPage() {
  const { token } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  useGlassSurface(true, 'full');

  const [state, setState] = useState('loading'); // loading | notfound | closed | unavailable | ready | secured | prepay_selected
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [captureState, setCaptureState] = useState({ ready: false, agreed: false, loadFailed: false });
  const captureRef = useRef(null);
  // Plan-choice lane (payload carries planContext only while the gate is
  // on). selectedPlan mirrors the server's recorded choice; per-application
  // must be picked before the card form appears on plan-bearing pages.
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [planBusy, setPlanBusy] = useState(false);

  // Re-pull the page payload (plan availability can change under us — the
  // office edits the visit, a term appears). Server truth wins.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/public/secure-card/${token}`);
      if (res.status === 404) { setState('notfound'); return; }
      if (!res.ok) throw new Error('load_failed');
      const payload = await res.json();
      setData(payload);
      setSelectedPlan(payload.planContext?.selected || null);
      setState(payload.state === 'ready' ? 'ready' : payload.state);
    } catch {
      setState('unavailable');
    }
  }, [token]);

  const complete = useCallback(async (setupIntentId) => {
    const res = await fetch(`${API_BASE}/public/secure-card/${token}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupIntentId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || 'complete_failed');
      err.code = body.code || null;
      throw err;
    }
    return res.json();
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 3DS redirect return: Stripe appends ?setup_intent=... — finish the
        // capture first so the page-data fetch below renders "secured".
        const redirectIntent = searchParams.get('setup_intent');
        if (redirectIntent && searchParams.get('redirect_status') === 'succeeded') {
          // Errors (including completion_in_progress when the webhook beat
          // us to the claim) fall through to the page-data fetch below —
          // the GET renders completing/completed rows as secured, so the
          // redirect race can never re-show the card form mid-save.
          try { await complete(redirectIntent); } catch { /* fall through to page state */ }
          if (!cancelled) {
            const cleaned = new URLSearchParams(searchParams);
            ['setup_intent', 'setup_intent_client_secret', 'redirect_status'].forEach((k) => cleaned.delete(k));
            setSearchParams(cleaned, { replace: true });
          }
        }
        const res = await fetch(`${API_BASE}/public/secure-card/${token}`);
        if (cancelled) return;
        if (res.status === 404) { setState('notfound'); return; }
        if (!res.ok) throw new Error('load_failed');
        const payload = await res.json();
        if (cancelled) return;
        setData(payload);
        setSelectedPlan(payload.planContext?.selected || null);
        setState(payload.state === 'ready' ? 'ready' : payload.state);
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();
    return () => { cancelled = true; };
    // Deliberately keyed on token alone: the redirect-return branch reads
    // searchParams once on mount; re-running on param cleanup would refetch.
  }, [token]);

  const handleSave = useCallback(async () => {
    if (busy || !captureRef.current?.isReady()) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await captureRef.current.confirmSetup();
      if (!confirmed.ok) {
        setError(confirmed.error || 'That card could not be saved. Try again.');
        return;
      }
      await complete(confirmed.setupIntentId);
      setState('secured');
    } catch (err) {
      // The visit was cancelled / became payer-billed since the page
      // loaded — nothing to save; show the "nothing needed" state.
      if (err?.code === 'no_longer_needed') {
        setState('closed');
        return;
      }
      // The Stripe webhook (or another tab) won the completion claim and
      // is saving this card right now — the SetupIntent already succeeded,
      // so the durable webhook path finishes it. Not a failure.
      if (err?.code === 'completion_in_progress') {
        setState('secured');
        return;
      }
      // The server requires a recorded plan selection before the capture
      // may complete (another tab may have changed it) — re-pull so the
      // plan choice renders with current truth.
      if (err?.code === 'plan_required') {
        await refresh();
        setError('Please choose how you’d like to pay, then save your card.');
        return;
      }
      setError('We could not finish saving your card. Please try again, or text us and we’ll help.');
    } finally {
      setBusy(false);
    }
  }, [busy, complete, refresh]);

  const selectPlan = useCallback(async (plan) => {
    if (planBusy) return;
    setPlanBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/public/secure-card/${token}/select-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (plan === 'prepay_annual' && body.payUrl) {
          // Payment happens on the invoice pay page — hand the customer off.
          window.location.assign(body.payUrl);
          return;
        }
        if (state === 'prepay_selected') {
          // Switching back to per-application retired the prepay invoice
          // server-side — re-pull so the page renders the ready plan view
          // with the selection recorded.
          await refresh();
          return;
        }
        setSelectedPlan(plan);
        return;
      }
      if (body.code === 'no_longer_needed') { setState('closed'); return; }
      if (body.code === 'already_secured') { setState('secured'); return; }
      // plan_unavailable / conflicts: the server state moved — re-render truth.
      const wasSwitch = state === 'prepay_selected';
      await refresh();
      if (wasSwitch) {
        setError('That change couldn’t be completed — if you just paid your annual invoice you’re all set; otherwise please try again in a moment.');
      }
    } catch {
      setError('We could not save your choice. Please try again, or text us and we’ll help.');
    } finally {
      setPlanBusy(false);
    }
  }, [planBusy, token, refresh, state]);

  const greeting = data?.firstName ? `${data.firstName}, you` : 'You';

  if (state === 'loading') {
    return (
      <Shell>
        <Card><div style={{ fontSize: 15, color: S.body }}>Loading your appointment&hellip;</div></Card>
      </Shell>
    );
  }

  if (state === 'notfound') {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, margin: 0, color: S.text }}>We couldn&rsquo;t find that link</h1>
          <p style={{ fontSize: 15, color: S.body, lineHeight: 1.55, marginTop: 10 }}>
            The link may have been mistyped. Text or call us and we&rsquo;ll sort it out.
          </p>
          <ContactRow />
        </Card>
      </Shell>
    );
  }

  if (state === 'closed') {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, margin: 0, color: S.text }}>Nothing needed here</h1>
          <p style={{ fontSize: 15, color: S.body, lineHeight: 1.55, marginTop: 10 }}>
            This appointment doesn&rsquo;t need a card on file anymore. If anything
            changed, text or call us — we&rsquo;re happy to help.
          </p>
          <ContactRow />
        </Card>
      </Shell>
    );
  }

  if (state === 'secured') {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, margin: 0, color: S.text }}>
            {data?.firstName ? `You're all set, ${data.firstName}!` : 'You’re all set!'}
          </h1>
          <p style={{ fontSize: 15, color: S.body, lineHeight: 1.55, marginTop: 10 }}>
            Your card is on file and your appointment is secured. Nothing was
            charged today — your card is only charged after your service is
            completed.
          </p>
          {data ? <VisitSummary data={data} /> : null}
          <ContactRow />
        </Card>
      </Shell>
    );
  }

  if (state === 'prepay_selected') {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, margin: 0, color: S.text }}>
            {data?.firstName ? `${data.firstName}, you chose the annual plan` : 'You chose the annual plan'}
          </h1>
          <p style={{ fontSize: 15, color: S.body, lineHeight: 1.55, marginTop: 10 }}>
            Your annual prepay invoice is ready. Pay it once and every visit
            this year is covered — no charges after your visits.
          </p>
          {data ? <VisitSummary data={data} /> : null}
          <a href={data?.payUrl} data-glass-accent="" style={{ ...PRIMARY_CTA, marginTop: 16 }}>
            Pay your annual invoice
          </a>
          {/* The card form is deliberately NOT rendered here: switching to
              per-visit must first succeed server-side (it voids the pending
              annual invoice and cancels its term). On success selectPlan
              re-pulls the payload and the page renders the ready plan view
              with the capture form; on refusal the error shows instead —
              never a card save recorded against a live annual selection. */}
          <button
            type="button"
            onClick={() => selectPlan('per_application')}
            disabled={planBusy}
            style={{
              ...PRIMARY_CTA,
              marginTop: 10,
              background: '#FFFFFF',
              color: S.text,
              border: `1px solid ${S.border}`,
              fontWeight: 700,
              opacity: planBusy ? 0.55 : 1,
            }}
          >
            {planBusy ? 'Switching…' : 'Save a card and pay per visit instead'}
          </button>
          {error ? (
            <div role="alert" style={{ color: '#C8312F', fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
          ) : null}
          <ContactRow />
        </Card>
      </Shell>
    );
  }

  if (state !== 'ready' || !data?.clientSecret) {
    return (
      <Shell>
        <Card>
          <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, margin: 0, color: S.text }}>We hit a snag</h1>
          <p style={{ fontSize: 15, color: S.body, lineHeight: 1.55, marginTop: 10 }}>
            The secure card form isn&rsquo;t available right now. Text or call us
            and we&rsquo;ll take care of it.
          </p>
          <ContactRow />
        </Card>
      </Shell>
    );
  }

  // Plan-choice lane: planContext rides the payload only while the gate is
  // on AND the booked series priced soundly — its absence renders the
  // original card-only page unchanged.
  const planContext = data?.planContext || null;
  const planRecurring = planContext?.mode === 'recurring';
  const planOneTime = planContext?.mode === 'one_time';
  // Recurring plan pages hold the card form back until a plan is picked;
  // everything else (one-time, gate off) shows it immediately as today.
  const showCapture = !planRecurring || selectedPlan === 'per_application';

  return (
    <Shell>
      <Card>
        <h1 style={{ fontFamily: FONTS.heading, fontSize: 22, margin: 0, color: S.text }}>
          {planRecurring
            ? (data?.firstName ? `${data.firstName}, choose how you’d like to pay` : 'Choose how you’d like to pay')
            : <>{greeting}&rsquo;re one step from all set</>}
        </h1>
        <p style={{ fontSize: 15, color: S.body, lineHeight: 1.55, marginTop: 10 }}>
          {planRecurring
            ? 'Your appointment is booked. Pick a plan below, add a card, and you’re all set.'
            : 'Add a card on file to secure your visit. Nothing is charged today — your card is only charged after your service is completed.'}
        </p>
        <VisitSummary data={data} />
        {planOneTime ? (
          <div
            data-glass="soft"
            style={{
              background: '#F8FCFE',
              border: '1px solid #CFE7F5',
              borderRadius: 10,
              padding: '14px 16px',
              marginTop: 12,
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 14.5, fontWeight: 700, color: S.text }}>Your service total</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: S.text }}>{fmtMoney(planContext.perVisit)}</span>
          </div>
        ) : null}
        {planRecurring ? (
          <SecurePlanChoice
            planContext={planContext}
            selected={selectedPlan}
            onSelect={selectPlan}
            disabled={planBusy || busy}
          />
        ) : null}
        {showCapture ? (
          <>
            <InlineAutoPayCapture
              ref={captureRef}
              intent={{ clientSecret: data.clientSecret, publishableKey: data.publishableKey }}
              loadStripeSdk={loadStripeSdk}
              busy={busy}
              onStateChange={setCaptureState}
            />
            {error ? (
              <div role="alert" style={{ color: '#C8312F', fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
            ) : null}
            <button
              type="button"
              data-glass-accent=""
              onClick={handleSave}
              disabled={busy || !(captureState.ready && captureState.agreed)}
              style={{
                ...PRIMARY_CTA,
                marginTop: 16,
                opacity: busy || !(captureState.ready && captureState.agreed) ? 0.55 : 1,
                cursor: busy || !(captureState.ready && captureState.agreed) ? 'default' : 'pointer',
              }}
            >
              {busy ? 'Saving…' : (planRecurring ? 'Save card & confirm my plan' : 'Save card & secure my visit')}
            </button>
            {(planRecurring || planOneTime) ? (
              <p style={{ textAlign: 'center', fontSize: 12.5, color: S.muted, marginTop: 10, marginBottom: 0 }}>
                Nothing is charged today.
              </p>
            ) : null}
            {captureState.loadFailed ? (
              <p style={{ fontSize: 14, color: S.body, lineHeight: 1.5, marginTop: 12 }}>
                Having trouble with the card form? Text or call us and we&rsquo;ll
                send a fresh link.
              </p>
            ) : null}
          </>
        ) : (
          error ? (
            <div role="alert" style={{ color: '#C8312F', fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
          ) : null
        )}
      </Card>
    </Shell>
  );
}
