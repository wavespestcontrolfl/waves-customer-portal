/**
 * GeofenceArrivalPrompt
 *
 * Polls /api/tech/notifications every 10s and renders:
 *   - an arrival reminder card for `geofence_arrival_reminder` (tech confirms / dismisses)
 *   - an auto-started info card for `geofence_timer_started`
 *   - a stop toast (with Undo) for `geofence_timer_stopped`
 *   - a visit card for `visit_assigned` / `visit_unassigned` /
 *     `visit_rescheduled` / `visit_cancelled` (tech-visit-notifications.js) —
 *     no auto-dismiss: it waits until the tech taps "Got it"
 *
 * Mount once inside TechLayout / TechHomePage — it renders a fixed-position
 * container so the parent layout doesn't need to reserve space.
 *
 * Audit focus:
 * - Polling cleanup: confirm the 10s interval is cleared on unmount and
 *   doesn't leak across navigations / fast remounts.
 * - Network failure: a request that fails should not halt subsequent
 *   polls; verify the error path swallows quietly and resumes.
 * - Notification dedupe: if the same notification id arrives twice
 *   (server retry, late ack), do we render two cards?
 * - Auto-dismiss timers (REMINDER_AUTODISMISS_MS, STOP_TOAST_MS): if
 *   the user confirms / dismisses manually before the timer fires,
 *   confirm we clear the pending timeout to avoid a late-firing
 *   dismiss racing with a fresh notification.
 * - Backgrounded tab behavior: when the tech's phone backgrounds the
 *   tab, polls pause. On resume, do we catch up correctly? Skipped
 *   notifications during the gap should still render once.
 * - Bouncie-mileage tie-in (if any): some installs have geofence
 *   timer events also drive mileage. Confirm a stop here doesn't
 *   double-write the mileage record.
 */
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';
const POLL_MS = 10_000;
const REMINDER_AUTODISMISS_MS = 5 * 60 * 1000;
const STOP_TOAST_MS = 15_000;
const MAX_STORM_CARDS = 2;
// Visit cards never auto-dismiss, so a bulk assign or day swap could stack
// dozens over the actionable geofence prompts: same cap + summary line as
// storms, newest first, and prompts always render above them.
const MAX_VISIT_CARDS = 2;

// Visit cards are the tech's record of a schedule change; they never
// auto-dismiss (the 5-min reminder timer would mark them read unseen).
const VISIT_TYPES = new Set(['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']);
const VISIT_ACCENT = {
  visit_assigned: '#0ea5e9',
  visit_rescheduled: '#f59e0b',
  visit_unassigned: '#94a3b8',
  visit_cancelled: '#ef4444',
};
const VISIT_ICON = {
  visit_assigned: '🗓',
  visit_rescheduled: '⏱',
  visit_unassigned: '↪',
  visit_cancelled: '✕',
};

const COLORS = {
  bg: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  muted: '#94a3b8',
  teal: '#0ea5e9',
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
};

async function apiPost(path, body) {
  const token = getAdminAuthToken();
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : Promise.reject(await res.text());
}

async function apiGet(path) {
  const token = getAdminAuthToken();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  // A failed poll is skipped, not treated as an empty feed: the visit-card
  // reconcile below would otherwise clear every persistent card on a 5xx.
  return res.ok ? res.json() : Promise.reject(new Error(`${res.status}`));
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });
}

export default function GeofenceArrivalPrompt({ onStormReview }) {
  const [active, setActive] = useState([]);
  const seenIds = useRef(new Set());

  const poll = useCallback(async () => {
    try {
      const { notifications = [] } = await apiGet('/api/tech/notifications');
      const fresh = notifications.filter((n) => !seenIds.current.has(n.id));
      fresh.forEach((n) => seenIds.current.add(n.id));
      // Visit cards never auto-dismiss, so the server feed is their only
      // source of truth: one the feed no longer lists (tapped "Got it" on
      // the tech's other device, or pushed out of the feed window by a
      // burst) leaves this screen too — and is forgotten, so it can come
      // back if the feed lists it again. Timed cards stay client-owned.
      const listed = new Set(notifications.map((n) => n.id));
      setActive((prev) => {
        const gone = prev.filter((n) => VISIT_TYPES.has(n.type) && !listed.has(n.id));
        gone.forEach((n) => seenIds.current.delete(n.id));
        if (gone.length === 0 && fresh.length === 0) return prev;
        return [...prev.filter((n) => !gone.includes(n)), ...fresh];
      });
    } catch {
      // network hiccups are fine; next poll will retry
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Storm cards are capped so a burst of alerts can never bury the home
  // screen: one card per stop (newest wins when the sweep re-alerts), at
  // most MAX_STORM_CARDS on screen, the rest summarized in one line.
  const { cards, hiddenStormCount, hiddenVisitCount } = useMemo(() => {
    const stormByJob = new Map();
    const otherCards = [];
    const visitCards = [];
    for (const n of active) {
      if (VISIT_TYPES.has(n.type)) { visitCards.push(n); continue; }
      if (n.type !== 'storm_watch_alert') { otherCards.push(n); continue; }
      const jobKey = n.payload?.job_id || n.id;
      const prev = stormByJob.get(jobKey);
      if (!prev || new Date(n.created_at || 0) > new Date(prev.created_at || 0)) {
        stormByJob.set(jobKey, n);
      }
    }
    const stormAlerts = [...stormByJob.values()].sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
    );
    const shownStorms = stormAlerts.slice(0, MAX_STORM_CARDS);
    const visitsNewestFirst = [...visitCards].sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
    );
    const shownVisits = visitsNewestFirst.slice(0, MAX_VISIT_CARDS);
    // Order: actionable prompts, then storm warnings (both on a timer that
    // marks them read), then the persistent visit cards — nothing that can
    // expire unseen ever sits below something that waits for a tap.
    return {
      cards: [...otherCards, ...shownStorms, ...shownVisits],
      hiddenStormCount: stormAlerts.length - shownStorms.length,
      hiddenVisitCount: visitsNewestFirst.length - shownVisits.length,
    };
  }, [active]);

  // Superseded same-stop storm alerts are duplicates of information the tech
  // IS seeing (the newest card for that stop) — mark them read immediately so
  // clearing the visible card doesn't promote each stale duplicate in turn.
  // Alerts for OTHER stops held back by the cap stay untouched/unread.
  useEffect(() => {
    const newestByJob = new Map();
    for (const n of active) {
      if (n.type !== 'storm_watch_alert') continue;
      const jobKey = n.payload?.job_id || n.id;
      const prev = newestByJob.get(jobKey);
      if (!prev || new Date(n.created_at || 0) > new Date(prev.created_at || 0)) {
        newestByJob.set(jobKey, n);
      }
    }
    for (const n of active) {
      if (n.type !== 'storm_watch_alert') continue;
      const jobKey = n.payload?.job_id || n.id;
      if (newestByJob.get(jobKey)?.id !== n.id) removeCard(n.id, { silent: true });
    }
  }, [active]);

  // Auto-dismiss timers — RENDERED cards only. Storm alerts for other stops
  // held back by the cap must stay unread so they actually surface later;
  // marking them read here would hide them from every future unreadOnly poll
  // without the tech ever seeing them.
  useEffect(() => {
    const timers = cards.filter((n) => !VISIT_TYPES.has(n.type)).map((n) => {
      const ms = n.type === 'geofence_timer_stopped' ? STOP_TOAST_MS : REMINDER_AUTODISMISS_MS;
      return setTimeout(() => removeCard(n.id, { silent: true }), ms);
    });
    return () => timers.forEach(clearTimeout);

  }, [cards]);

  function removeCard(id, { silent } = {}) {
    setActive((prev) => prev.filter((n) => n.id !== id));
    if (!silent) {
      apiPost(`/api/tech/notifications/${id}/dismiss`).catch(() => {});
    } else {
      apiPost(`/api/tech/notifications/${id}/read`).catch(() => {});
    }
  }

  // "Got it" on a visit card: optimistic, but a dismiss the network lost
  // must not hide the card for the rest of the session — the server still
  // lists it, so forgetting the id lets the next poll bring it back.
  function dismissVisitCard(id) {
    setActive((prev) => prev.filter((n) => n.id !== id));
    apiPost(`/api/tech/notifications/${id}/dismiss`).catch(() => { seenIds.current.delete(id); });
  }

  async function handleStart(n, pick) {
    const pos = await getPosition();
    const body = pick
      ? { ...pos, customer_id: pick.customer_id, job_id: pick.job_id }
      : pos;
    try {
      await apiPost(`/api/tech/notifications/${n.id}/confirm-start`, body);
      removeCard(n.id, { silent: true });
    } catch (err) {
      alert('Could not start timer: ' + String(err).slice(0, 140));
    }
  }

  async function handleUndo(n) {
    try {
      await apiPost(`/api/tech/notifications/${n.id}/undo-stop`);
      removeCard(n.id, { silent: true });
    } catch (err) {
      alert('Undo failed: ' + String(err).slice(0, 140));
    }
  }

  if (active.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', top: 12, left: 12, right: 12, zIndex: 10_000,
      display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none',
      // The stack scrolls inside the viewport instead of running past it:
      // a phone-height screen must still reach every card.
      maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
    }}>
      {cards.map((n) => (
        <div key={n.id} style={{ pointerEvents: 'auto' }}>
          {n.type === 'geofence_arrival_reminder' && (
            <ReminderCard n={n} onStart={() => handleStart(n)} onDismiss={() => removeCard(n.id)} />
          )}
          {n.type === 'geofence_arrival_select' && (
            <SelectorCard n={n} onPick={(pick) => handleStart(n, pick)} onDismiss={() => removeCard(n.id)} />
          )}
          {n.type === 'geofence_timer_started' && (
            <InfoCard n={n} onDismiss={() => removeCard(n.id, { silent: true })} />
          )}
          {n.type === 'geofence_timer_stopped' && (
            <StopToast n={n} onUndo={() => handleUndo(n)} onDismiss={() => removeCard(n.id, { silent: true })} />
          )}
          {VISIT_TYPES.has(n.type) && (
            <VisitCard n={n} onDismiss={() => dismissVisitCard(n.id)} />
          )}
          {n.type === 'storm_watch_alert' && (
            <StormCard
              n={n}
              onReview={() => {
                onStormReview?.(n.payload || {});
                removeCard(n.id, { silent: true });
              }}
              onDismiss={() => removeCard(n.id)}
            />
          )}
        </div>
      ))}
      {hiddenVisitCount > 0 && (
        <div style={{ ...cardStyle(COLORS.muted), pointerEvents: 'auto', padding: 10 }} data-testid="visit-notice-more">
          <div style={{ fontSize: 13, color: COLORS.muted }}>
            🗓 {hiddenVisitCount} more schedule change{hiddenVisitCount === 1 ? '' : 's'} — they'll surface as you clear these.
          </div>
        </div>
      )}
      {hiddenStormCount > 0 && (
        <div style={{ ...cardStyle(COLORS.amber), pointerEvents: 'auto', padding: 10 }}>
          <div style={{ fontSize: 13, color: COLORS.muted }}>
            ⛈️ {hiddenStormCount} more storm watch{hiddenStormCount === 1 ? '' : 'es'} — they'll surface as you clear these.
          </div>
        </div>
      )}
    </div>
  );
}

// Storm-watch nudge: weather crossing the threshold for an upcoming
// stop. Review opens the Quick Move sheet pre-loaded for that job (via
// onStormReview from TechHomePage); the tech still makes the call.
function StormCard({ n, onReview, onDismiss }) {
  const p = n.payload || {};
  return (
    <div style={cardStyle(COLORS.amber)}>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>⛈️ Storm watch</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.text, marginBottom: 12 }}>
        {n.message || `Storms approaching an upcoming stop${p.city ? ` in ${p.city}` : ''}.`}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onReview} style={btnPrimary}>Review options</button>
        <button onClick={onDismiss} style={btnSecondary}>Working through it</button>
      </div>
    </div>
  );
}

function ReminderCard({ n, onStart, onDismiss }) {
  const p = n.payload || {};
  return (
    <div style={cardStyle(p.unscheduled ? COLORS.amber : COLORS.teal)}>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        {p.unscheduled ? '⚠️ Unscheduled visit' : '📍 Arrived'}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.text, marginBottom: 4 }}>
        {p.customer_name || 'Customer'}
      </div>
      {p.service_type && (
        <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 12 }}>{p.service_type}</div>
      )}
      {p.unscheduled && (
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>
          No job scheduled for today. Starting a timer logs this as an unscheduled visit.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onStart} style={btnPrimary}>Start Timer</button>
        <button onClick={onDismiss} style={btnSecondary}>Not here yet</button>
      </div>
    </div>
  );
}

function SelectorCard({ n, onPick, onDismiss }) {
  const p = n.payload || {};
  const candidates = p.candidates || [];
  return (
    <div style={cardStyle(COLORS.teal)}>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>📍 Near multiple customers</div>
      <div style={{ fontSize: 13, color: COLORS.text, marginBottom: 12 }}>
        Pick the one you're at:
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {candidates.map((c, i) => (
          <button key={i} onClick={() => onPick(c)} style={{
            textAlign: 'left', padding: 12, borderRadius: 8,
            border: `1px solid ${COLORS.border}`, background: 'transparent',
            color: COLORS.text, cursor: 'pointer', fontSize: 13,
          }}>
            <div style={{ fontWeight: 600 }}>{c.customer_name}</div>
            {c.address && <div style={{ color: COLORS.muted, fontSize: 12 }}>{c.address}</div>}
            {c.service_type && <div style={{ color: COLORS.teal, fontSize: 11, marginTop: 2 }}>{c.service_type}</div>}
          </button>
        ))}
      </div>
      <button onClick={onDismiss} style={btnSecondary}>Not here yet</button>
    </div>
  );
}

// A schedule change on the tech's own route (tech-visit-notifications.js).
// Headline + who + the details the server composed; "Got it" dismisses.
function VisitCard({ n, onDismiss }) {
  const p = n.payload || {};
  const lines = [];
  if (n.type === 'visit_rescheduled') {
    if (p.service_type) lines.push(p.service_type);
    if (p.previous_when) lines.push({ text: `Was ${p.previous_when}`, struck: true });
    if (p.when) lines.push(`Now ${p.when}`);
  } else {
    lines.push([p.service_type, p.when].filter(Boolean).join(' · '));
    if (n.type === 'visit_assigned' && p.address) lines.push(p.address);
    // `ended`: the visit finished (cancelled / completed …) before this card landed — name that, not a holder.
    if (n.type === 'visit_unassigned') lines.push(p.ended ? `Now ${p.ended}` : (p.now_with ? `Now with ${p.now_with}` : 'Now unassigned'));
  }
  if (p.actor) {
    const verb = { visit_assigned: 'Assigned', visit_unassigned: 'Reassigned', visit_rescheduled: 'Moved', visit_cancelled: 'Cancelled' }[n.type];
    lines.push(`${verb} ${p.actor}`);
  }
  return (
    <div style={cardStyle(VISIT_ACCENT[n.type] || COLORS.teal)} data-testid="visit-notice">
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        {VISIT_ICON[n.type]} {p.headline || 'Schedule change'}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.text, marginBottom: 4 }}>
        {p.customer_name || 'Customer'}
      </div>
      <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 12, lineHeight: 1.4 }}>
        {lines.filter(Boolean).map((line, i) => (
          typeof line === 'string'
            ? <div key={i}>{line}</div>
            : <div key={i} style={{ textDecoration: 'line-through', color: '#64748b' }}>{line.text}</div>
        ))}
      </div>
      <button onClick={onDismiss} style={{ ...btnSecondary, width: '100%' }}>Got it</button>
    </div>
  );
}

function InfoCard({ n, onDismiss }) {
  return (
    <div style={cardStyle(COLORS.green)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>✅ Timer auto-started</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.text }}>{n.message}</div>
        </div>
        <button onClick={onDismiss} style={closeX}>✕</button>
      </div>
    </div>
  );
}

function StopToast({ n, onUndo, onDismiss }) {
  return (
    <div style={cardStyle(COLORS.amber)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, color: COLORS.text }}>⏱️ {n.message}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onUndo} style={btnSecondary}>Undo</button>
          <button onClick={onDismiss} style={closeX}>✕</button>
        </div>
      </div>
    </div>
  );
}

function cardStyle(accent) {
  return {
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderLeft: `4px solid ${accent}`,
    borderRadius: 10,
    padding: 14,
    boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
    fontFamily: "'DM Sans', sans-serif",
  };
}

const btnPrimary = {
  flex: 1, padding: '10px 12px', borderRadius: 8, border: 'none',
  background: COLORS.teal, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer',
};

const btnSecondary = {
  padding: '10px 12px', borderRadius: 8, border: `1px solid ${COLORS.border}`,
  background: 'transparent', color: COLORS.text, fontWeight: 500, fontSize: 14, cursor: 'pointer',
};

const closeX = {
  background: 'transparent', border: 'none', color: COLORS.muted,
  fontSize: 16, cursor: 'pointer', padding: '4px 8px',
};
