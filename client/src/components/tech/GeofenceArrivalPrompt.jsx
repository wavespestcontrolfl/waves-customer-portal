/**
 * GeofenceArrivalPrompt
 *
 * Polls /api/tech/notifications every 10s and renders:
 *   - an arrival reminder card for `geofence_arrival_reminder` (tech confirms / dismisses)
 *   - an auto-started info card for `geofence_timer_started`
 *   - a stop toast (with Undo) for `geofence_timer_stopped`
 *
 * Mount once inside TechLayout / TechHomePage — it renders a fixed-position
 * container so the parent layout doesn't need to reserve space.
 */
import { useEffect, useState, useRef, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL || '';
const POLL_MS = 10_000;
const REMINDER_AUTODISMISS_MS = 5 * 60 * 1000;
const STOP_TOAST_MS = 15_000;

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
  const token = localStorage.getItem('waves_admin_token') || localStorage.getItem('adminToken');
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : Promise.reject(await res.text());
}

async function apiGet(path) {
  const token = localStorage.getItem('waves_admin_token') || localStorage.getItem('adminToken');
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : { notifications: [] };
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

export default function GeofenceArrivalPrompt() {
  const [active, setActive] = useState([]);
  const seenIds = useRef(new Set());

  const poll = useCallback(async () => {
    try {
      const { notifications = [] } = await apiGet('/api/tech/notifications');
      const fresh = notifications.filter((n) => !seenIds.current.has(n.id));
      if (fresh.length === 0) return;
      fresh.forEach((n) => seenIds.current.add(n.id));
      setActive((prev) => [...prev, ...fresh]);
    } catch {
      // network hiccups are fine; next poll will retry
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Auto-dismiss timers per card
  useEffect(() => {
    const timers = active.map((n) => {
      const ms = n.type === 'geofence_timer_stopped' ? STOP_TOAST_MS : REMINDER_AUTODISMISS_MS;
      return setTimeout(() => removeCard(n.id, { silent: true }), ms);
    });
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line
  }, [active.length]);

  function removeCard(id, { silent } = {}) {
    setActive((prev) => prev.filter((n) => n.id !== id));
    if (!silent) {
      apiPost(`/api/tech/notifications/${id}/dismiss`).catch(() => {});
    } else {
      apiPost(`/api/tech/notifications/${id}/read`).catch(() => {});
    }
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
    }}>
      {active.map((n) => (
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
        </div>
      ))}
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
