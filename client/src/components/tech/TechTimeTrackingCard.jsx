import { useCallback, useEffect, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';

const API = import.meta.env.VITE_API_URL || '';
const D = {
  card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#22c55e',
  amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', bg: '#0f1923',
};

async function currentPosition() {
  if (!navigator.geolocation) return {};
  // Hard deadline beyond the geolocation option timeout: when the permission
  // prompt is left undecided the browser fires NEITHER callback, which left
  // `busy` stuck and every time-clock button disabled until a page refresh.
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      resolve(value);
    };
    const deadline = window.setTimeout(() => done({}), 7000);
    navigator.geolocation.getCurrentPosition(
      (pos) => done({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => done({}),
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 120000 },
    );
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${API}/api/tech/timetracking${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getAdminAuthToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Time tracking failed (${response.status})`);
  return data;
}

function actionStyle(color, disabled) {
  return {
    flex: 1,
    minHeight: 42,
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${disabled ? D.border : color}`,
    background: disabled ? D.bg : `${color}22`,
    color: disabled ? D.muted : color,
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function customerLabel(service) {
  return service?.customerName || service?.customer_name || 'next stop';
}

export default function TechTimeTrackingCard({ nextStop }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState(null);

  const load = useCallback(async () => {
    try {
      setStatus(await request('/status'));
      setFeedback((value) => value?.isError ? null : value);
    } catch (error) {
      setFeedback({ text: error.message, isError: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (key, path, { location = false } = {}) => {
    if (busy) return;
    setBusy(key);
    setFeedback(null);
    try {
      const body = location ? await currentPosition() : {};
      await request(path, { method: 'POST', body: JSON.stringify(body) });
      setFeedback({ text: `${key} recorded`, isError: false });
      await load();
    } catch (error) {
      setFeedback({ text: error.message, isError: true });
    } finally {
      setBusy('');
    }
  };

  if (loading) return null;
  if (!status) {
    return (
      <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
        <div style={{ color: D.text, fontSize: 14, fontWeight: 800, fontFamily: "'Montserrat', sans-serif" }}>Time Clock</div>
        <div role="alert" style={{ color: D.red, fontSize: 12, marginTop: 8 }}>
          {feedback?.text || 'Time clock status is unavailable.'}
        </div>
        <button type="button" onClick={load} style={{ ...actionStyle(D.teal, false), marginTop: 10, width: '100%' }}>
          Retry
        </button>
      </section>
    );
  }
  const clockedIn = status?.clockedIn === true;
  const currentJob = status?.currentJob || null;
  const onBreak = status?.onBreak === true;
  const nextStopIsOnSite = nextStop?.status === 'on_site';
  const nextStopIsCurrent = currentJob && nextStop
    && String(currentJob.jobId) === String(nextStop.id);

  return (
    <section style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ color: D.text, fontSize: 14, fontWeight: 800, fontFamily: "'Montserrat', sans-serif" }}>Time Clock</div>
          <div style={{ color: clockedIn ? D.green : D.muted, fontSize: 12, marginTop: 2 }}>
            {clockedIn ? (onBreak ? 'Clocked in · on break' : currentJob ? 'Clocked in · job running' : 'Clocked in') : 'Clocked out'}
          </div>
        </div>
        <div style={{ color: D.muted, fontSize: 11, textAlign: 'right' }}>
          {Math.round(Number(status?.todaySummary?.shiftMinutes || 0))} shift min<br />
          {status?.todaySummary?.jobCount || 0} jobs
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {!clockedIn ? (
          <button type="button" disabled={!!busy} onClick={() => act('Clock in', '/clock-in', { location: true })} style={actionStyle(D.green, !!busy)}>
            {busy === 'Clock in' ? 'Clocking in…' : 'Clock in'}
          </button>
        ) : (
          <button type="button" disabled={!!busy} onClick={() => act('Clock out', '/clock-out', { location: true })} style={actionStyle(D.red, !!busy)}>
            {busy === 'Clock out' ? 'Clocking out…' : 'Clock out'}
          </button>
        )}
        {clockedIn && (onBreak ? (
          <button type="button" disabled={!!busy} onClick={() => act('Break ended', '/end-break')} style={actionStyle(D.green, !!busy)}>
            End break
          </button>
        ) : (
          <button type="button" disabled={!!busy || !!currentJob} onClick={() => act('Break started', '/start-break')} style={actionStyle(D.amber, !!busy || !!currentJob)}>
            Start break
          </button>
        ))}
      </div>

      {clockedIn && !onBreak && (
        <div style={{ display: 'flex', gap: 8 }}>
          {currentJob ? (
            <button type="button" disabled={!!busy} onClick={() => act('Job ended', '/end-job', { location: true })} style={actionStyle(D.teal, !!busy)}>
              End {nextStopIsCurrent ? customerLabel(nextStop) : 'current job'}
            </button>
          ) : (
            <button
              type="button"
              disabled={!!busy || !nextStop?.id || !nextStopIsOnSite}
              onClick={() => act('Job started', `/start-job/${encodeURIComponent(nextStop.id)}`, { location: true })}
              style={actionStyle(D.teal, !!busy || !nextStop?.id || !nextStopIsOnSite)}
            >
              {!nextStop?.id
                ? 'No open job to start'
                : nextStopIsOnSite
                  ? `Start job · ${customerLabel(nextStop)}`
                  : 'Mark on site before starting timer'}
            </button>
          )}
        </div>
      )}

      {currentJob && !nextStopIsCurrent && (
        <div style={{ color: D.amber, fontSize: 11, marginTop: 8 }}>
          A different job timer is running. End it before starting the next stop.
        </div>
      )}
      {feedback && (
        <div role={feedback.isError ? 'alert' : 'status'} style={{ color: feedback.isError ? D.red : D.green, fontSize: 12, marginTop: 8 }}>
          {feedback.text}
        </div>
      )}
    </section>
  );
}
