import { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { formatETDateOnly } from '../../lib/timezone';
import { COLORS as B, FONTS } from '../../theme-brand';
import { WAVES_PHONE_DISPLAY, WAVES_PHONE_TEL } from '../../theme-customer';

// =========================================================================
// CANCELLED STATE (C4) — what a cancelled customer sees in the portal.
//
//   CancelledBanner     top-of-portal strip: cancelled as of {date}; reports
//                       and open balance stay reachable.
//   CancelledPlanPanel  the Plan tab in its cancelled state: no live plan
//                       cards, one "Restart my plan" action.
//
// Restart is customer-initiated only. The server mints a NORMAL estimate at
// today's price (POST /requests/restart-plan) and this panel hands the
// customer to it — review + approval happen on the estimate page through the
// existing accept path. Nothing here promises an old rate back.
// =========================================================================

const fmtDate = (value) => formatETDateOnly(value, { month: 'long', day: 'numeric', year: 'numeric' });
// Give the "ready" state a beat on screen before the hand-off so the
// customer sees where they are going; the explicit link covers a blocked
// navigation.
const HANDOFF_DELAY_MS = 1500;

export function cancelledCopy(cancelledAt) {
  const when = cancelledAt ? fmtDate(cancelledAt) : null;
  return when
    ? `Your plan is cancelled as of ${when}. You can still see your reports and pay any open balance here.`
    : 'Your plan is cancelled. You can still see your reports and pay any open balance here.';
}

export function CancelledBanner({ cancelledAt, onOpenBilling }) {
  return (
    <div role="status" data-glass="card" style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '14px 16px', marginBottom: 12, borderRadius: 12,
      background: B.white, border: '1px solid #E7E2D7',
      color: B.glassNavy, fontFamily: FONTS.body, fontSize: 16, lineHeight: 1.45,
    }}>
      <span style={{ minWidth: 0, flex: '1 1 320px' }}>{cancelledCopy(cancelledAt)}</span>
      {onOpenBilling && (
        <button data-glass-accent="" type="button" onClick={onOpenBilling} style={{
          border: '1px solid #D8D0C0', borderRadius: 10, background: '#fff', color: B.glassNavy,
          fontFamily: FONTS.body, fontSize: 14, fontWeight: 700, padding: '9px 14px', minHeight: 40, cursor: 'pointer',
        }}>
          Go to Billing
        </button>
      )}
    </div>
  );
}

export default function CancelledPlanPanel({ customer, compact, styles, navigate }) {
  const { card, muted, subtle, sectionTitle, primaryButton, secondaryButton } = styles;
  const goTo = navigate || ((url) => window.location.assign(url));
  // idle → busy → ready | unavailable | error
  const [state, setState] = useState('idle');
  const [handoff, setHandoff] = useState(null);
  const [message, setMessage] = useState('');
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const restart = async () => {
    if (state === 'busy') return;
    setState('busy');
    setMessage('');
    try {
      const result = await api.restartPlan();
      if (!result || !result.url) throw new Error('No estimate was returned.');
      setHandoff(result.url);
      setState('ready');
      timerRef.current = setTimeout(() => goTo(result.url), HANDOFF_DELAY_MS);
    } catch (err) {
      // 409 = the server could not build a restart estimate for this account
      // (nothing to restart, or the property cannot be priced online) — the
      // office finishes it by hand. 404 = the lane is dark.
      if (err?.status === 409 || err?.status === 404) {
        setMessage(err?.status === 409 && err?.message ? err.message : 'Online restart is not available for this account yet.');
        setState('unavailable');
        return;
      }
      setMessage(err?.message || 'We could not start that just now. Please try again.');
      setState('error');
    }
  };

  const firstName = customer?.firstName || '';
  const cancelledAt = customer?.cancelledAt || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section data-glass="card" style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={{ ...sectionTitle }}>Plan cancelled</div>
        <h1 style={{
          margin: '12px 0 8px', color: B.glassNavy, fontFamily: FONTS.heading,
          fontSize: compact ? 28 : 34, lineHeight: 1.1, letterSpacing: 0,
        }}>
          {firstName ? `${firstName}'s plan` : 'Your plan'}
        </h1>
        <div style={{ fontSize: 16, color: B.grayDark, lineHeight: 1.55 }}>
          {/* Qualified on purpose (codex GH r5 P2): a partially processed
              cancellation can leave an in-progress visit for manual handling,
              and a straggler completion can still bill — the Visits and
              Billing tabs show those, so this copy must not swear both sets
              are empty. */}
          {cancelledAt
            ? `Your WaveGuard plan ended on ${fmtDate(cancelledAt)}. Recurring visits and plan billing have stopped — anything still open shows on your Visits and Billing tabs.`
            : 'Your WaveGuard plan is cancelled. Recurring visits and plan billing have stopped — anything still open shows on your Visits and Billing tabs.'}
        </div>
        <div style={{ marginTop: 14, fontSize: 16, color: B.grayDark, lineHeight: 1.55 }}>
          Your service reports, visit history, and billing stay available in this portal.
        </div>
      </section>

      <section data-glass="card" style={{ ...card, padding: compact ? 20 : 28 }}>
        <div style={sectionTitle}>Restart my plan</div>
        <h2 style={{ margin: '12px 0 6px', color: B.glassNavy, fontSize: 20, fontWeight: 700 }}>
          Ready to come back?
        </h2>
        <div style={{ fontSize: 16, color: B.grayDark, lineHeight: 1.55 }}>
          We price your services at today&rsquo;s rates for your property and show you the estimate first.
          Nothing restarts until you review and approve it.
        </div>

        {state === 'ready' ? (
          <div role="status" style={{ marginTop: 16, padding: 16, borderRadius: 10, background: subtle, border: '1px solid #E7E2D7' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: B.glassNavy }}>Your estimate is ready.</div>
            <div style={{ marginTop: 4, fontSize: 14, color: muted }}>Opening it now. If it does not open, use the button below.</div>
            <a data-glass-accent="" href={handoff} style={{ ...primaryButton, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', marginTop: 12 }}>
              Review and approve my estimate
            </a>
          </div>
        ) : state === 'unavailable' ? (
          <div role="status" style={{ marginTop: 16, padding: 16, borderRadius: 10, background: subtle, border: '1px solid #E7E2D7' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: B.glassNavy }}>We will price this one by hand.</div>
            <div style={{ marginTop: 4, fontSize: 14, color: muted, lineHeight: 1.5 }}>{message}</div>
            <a data-glass-accent="" href={`tel:${WAVES_PHONE_TEL}`} style={{ ...secondaryButton, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', marginTop: 12 }}>
              Call or text {WAVES_PHONE_DISPLAY}
            </a>
          </div>
        ) : (
          <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <button data-glass-accent="" type="button" onClick={restart} disabled={state === 'busy'} style={{ ...primaryButton, opacity: state === 'busy' ? 0.7 : 1 }}>
              {state === 'busy' ? 'Building your estimate' : 'Restart my plan'}
            </button>
            {state === 'error' && (
              <span role="alert" style={{ fontSize: 14, color: B.red }}>{message}</span>
            )}
          </div>
        )}
        <div style={{ marginTop: 14, fontSize: 14, color: muted, lineHeight: 1.5 }}>
          Questions first? Call or text {WAVES_PHONE_DISPLAY}.
        </div>
      </section>
    </div>
  );
}
