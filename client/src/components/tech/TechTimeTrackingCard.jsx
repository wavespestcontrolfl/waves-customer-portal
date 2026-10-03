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

// The admin Today page (field workspace) draws the card in the admin look:
// neutral surfaces, monochrome secondary buttons, red only for an error.
const FIELD = {
  card: 'var(--surface-primary, #ffffff)', border: 'var(--border-default, #e7e5e4)', text: 'var(--text-primary, #1c1917)',
  muted: 'var(--text-secondary, #57534e)', green: 'var(--text-primary, #1c1917)', teal: 'var(--text-primary, #1c1917)',
  amber: '#854D0E', red: '#A32D2D', bg: 'var(--surface-hover, #f5f5f4)',
};

function actionStyle(color, disabled, field = false) {
  if (field) {
    return {
      flex: 1,
      minHeight: 44,
      padding: '6px 12px',
      borderRadius: 4,
      border: '0.5px solid var(--border-strong, #d6d3d1)',
      background: 'transparent',
      color: disabled ? 'var(--text-quaternary, #a8a29e)' : FIELD.text,
      fontSize: 11,
      fontWeight: 500,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      cursor: disabled ? 'not-allowed' : 'pointer',
    };
  }
  return {
    flex: 1,
    minHeight: 48,
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${disabled ? D.border : color}`,
    background: disabled ? D.bg : `${color}22`,
    color: disabled ? D.muted : color,
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

function customerLabel(service) {
  return service?.customerName || service?.customer_name || 'next stop';
}

// variant="field": the admin Today page's look; the default keeps the legacy dark card.
export default function TechTimeTrackingCard({ nextStop, variant = 'legacy' }) {  const field = variant === 'field';
  const P = field ? FIELD : D;
  const sectionStyle = field
    ? { background: P.card, border: `0.5px solid ${P.border}`, borderRadius: 6, padding: '12px 14px', marginBottom: 12 }
    : { background: P.card, border: `1px solid ${P.border}`, borderRadius: 12, padding: 14, marginBottom: 16 };
  const titleStyle = field
    ? { color: P.text, fontSize: 14, fontWeight: 500 }
    : { color: P.text, fontSize: 14, fontWeight: 800, fontFamily: "'Montserrat', sans-serif" };

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
      <section style={sectionStyle}>
        <div style={titleStyle}>Time Clock</div>
        <div role="alert" style={{ color: P.red, fontSize: 14, marginTop: 8 }}>
          {feedback?.text || 'Time clock status is unavailable.'}
        </div>
        <button type="button" onClick={load} style={{ ...actionStyle(P.teal, false, field), marginTop: 10, width: '100%' }}>
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
    <section style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div>
          <div style={titleStyle}>Time Clock</div>
          <div style={{ color: clockedIn ? P.green : P.muted, fontSize: 14, marginTop: 2 }}>
            {clockedIn ? (onBreak ? 'Clocked in · on break' : currentJob ? 'Clocked in · job running' : 'Clocked in') : 'Clocked out'}
          </div>
        </div>
        <div style={{ color: P.muted, fontSize: 14, textAlign: 'right' }}>
          {Math.round(Number(status?.todaySummary?.shiftMinutes || 0))} shift min<br />
          {status?.todaySummary?.jobCount || 0} jobs
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {!clockedIn ? (
          <button type="button" disabled={!!busy} onClick={() => act('Clock in', '/clock-in', { location: true })} style={actionStyle(P.green, !!busy, field)}>
            {busy === 'Clock in' ? 'Clocking in…' : 'Clock in'}
          </button>
        ) : (
          <button type="button" disabled={!!busy} onClick={() => act('Clock out', '/clock-out', { location: true })} style={actionStyle(P.red, !!busy, field)}>
            {busy === 'Clock out' ? 'Clocking out…' : 'Clock out'}
          </button>
        )}
        {clockedIn && (onBreak ? (
          <button type="button" disabled={!!busy} onClick={() => act('Break ended', '/end-break')} style={actionStyle(P.green, !!busy, field)}>
            End break
          </button>
        ) : (
          <button type="button" disabled={!!busy || !!currentJob} onClick={() => act('Break started', '/start-break')} style={actionStyle(P.amber, !!busy || !!currentJob, field)}>
            Start break
          </button>
        ))}
      </div>

      {clockedIn && !onBreak && (
        <div style={{ display: 'flex', gap: 8 }}>
          {currentJob ? (
            <button type="button" disabled={!!busy} onClick={() => act('Job ended', '/end-job', { location: true })} style={actionStyle(P.teal, !!busy, field)}>
              End {nextStopIsCurrent ? customerLabel(nextStop) : 'current job'}
            </button>
          ) : (
            <button
              type="button"
              disabled={!!busy || !nextStop?.id || !nextStopIsOnSite}
              onClick={() => act('Job started', `/start-job/${encodeURIComponent(nextStop.id)}`, { location: true })}
              style={actionStyle(P.teal, !!busy || !nextStop?.id || !nextStopIsOnSite, field)}
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
        <div style={{ color: P.amber, fontSize: 14, marginTop: 8 }}>
          A different job timer is running. End it before starting the next stop.
        </div>
      )}
      {feedback && (
        <div role={feedback.isError ? 'alert' : 'status'} style={{ color: feedback.isError ? P.red : P.green, fontSize: 14, marginTop: 8 }}>
          {feedback.text}
        </div>
      )}
    </section>
  );
}
