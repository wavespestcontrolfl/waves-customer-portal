import { useCallback, useRef, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { etDateString, formatETDateOnly, formatETTime } from '../../lib/timezone';

const API = import.meta.env.VITE_API_URL || '';

async function request(path) {
  const response = await fetch(`${API}/api/tech/timetracking${path}`, {
    headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Hours unavailable (${response.status})`);
  return data;
}

// Same look as the Time Clock card above it on Today.
const P = {
  card: 'var(--surface-primary, #ffffff)', border: 'var(--border-default, #e7e5e4)', text: 'var(--text-primary, #1c1917)',
  muted: 'var(--text-secondary, #57534e)', red: '#A32D2D',
};
const SECTION_STYLE = { background: P.card, border: `0.5px solid ${P.border}`, borderRadius: 6, padding: '12px 14px', marginBottom: 12 };

function actionStyle(disabled) {
  return {
    flex: 1,
    minHeight: 44,
    padding: '6px 12px',
    borderRadius: 4,
    border: '0.5px solid var(--border-strong, #d6d3d1)',
    background: 'transparent',
    color: disabled ? 'var(--text-quaternary, #a8a29e)' : P.text,
    fontSize: 14,
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

// ---------------------------------------------------------------------------
// My hours (owner 2026-11-04, D5 A): the technician's own week, this week and
// past weeks, read from GET /api/tech/timetracking/my-hours. Daily hours, the
// week's totals and the entries. No pay, rates or revenue come from the route.
// The card reads nothing until it is opened.
// ---------------------------------------------------------------------------
function hoursLabel(minutes) {
  const total = Math.round(Number(minutes) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const ENTRY_LABEL = { shift: 'Shift', job: 'Job', break: 'Break', drive: 'Drive', admin_time: 'Admin time' };

function weekLabel(weekStart, weekEnd) {
  const opts = { month: 'short', day: 'numeric' };
  return `${formatETDateOnly(weekStart, opts)} to ${formatETDateOnly(weekEnd, opts)}`;
}

function entryLine(entry) {
  const start = formatETTime(entry.clockIn);
  const end = entry.clockOut ? formatETTime(entry.clockOut) : 'now';
  const label = ENTRY_LABEL[entry.type] || 'Entry';
  const detail = entry.serviceType && entry.type === 'job' ? ` · ${entry.serviceType}` : '';
  const minutes = entry.minutes == null ? '' : ` · ${hoursLabel(entry.minutes)}`;
  const edited = entry.edited ? ' · edited by the office' : '';
  return `${label}${detail}: ${start} to ${end}${minutes}${edited}`;
}

export default function TechMyHoursCard() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);

  const load = useCallback(async (weekStart) => {
    const mine = latest.current + 1;
    latest.current = mine;
    setLoading(true);
    setError('');
    try {
      const next = await request(`/my-hours${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ''}`);
      if (latest.current === mine) setData(next);
    } catch (err) {
      if (latest.current === mine) setError(err.message);
    } finally {
      if (latest.current === mine) setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data) load();
  };

  const entriesByDay = {};
  for (const entry of data?.entries || []) {
    const day = etDateString(new Date(entry.clockIn));
    (entriesByDay[day] = entriesByDay[day] || []).push(entry);
  }

  return (
    <section style={SECTION_STYLE} aria-label="My hours">
      <button type="button" onClick={toggle} aria-expanded={open} style={{ ...actionStyle(false), width: '100%' }}>
        {open ? 'Hide my hours' : 'My hours'}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {error && <div role="alert" style={{ color: P.red, fontSize: 14, marginBottom: 8 }}>{error}</div>}
          {loading && !data && <div role="status" style={{ color: P.muted, fontSize: 14 }}>Loading hours…</div>}
          {data && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <button type="button" disabled={loading} onClick={() => load(data.prevWeekStart)} style={{ ...actionStyle(loading), flex: '0 0 auto' }}>Earlier week</button>
                <div style={{ flex: 1, textAlign: 'center', color: P.text, fontSize: 14, fontWeight: 500 }}>{weekLabel(data.weekStart, data.weekEnd)}</div>
                <button type="button" disabled={loading || !data.nextWeekStart} onClick={() => load(data.nextWeekStart)} style={{ ...actionStyle(loading || !data.nextWeekStart), flex: '0 0 auto' }}>Later week</button>
              </div>
              <div style={{ color: P.text, fontSize: 14, marginBottom: 4 }}>
                Week total: {hoursLabel(data.totals.shiftMinutes)} on shift · {data.totals.jobCount} jobs
              </div>
              <div style={{ color: P.muted, fontSize: 14, marginBottom: 8 }}>
                Jobs {hoursLabel(data.totals.jobMinutes)} · Drive {hoursLabel(data.totals.driveMinutes)} · Breaks {hoursLabel(data.totals.breakMinutes)}
                {data.totals.unpaidMealMinutes > 0 ? ` · Unpaid lunch ${hoursLabel(data.totals.unpaidMealMinutes)}` : ''}
                {data.week ? ` · Regular ${hoursLabel(data.week.regularMinutes)} · Overtime ${hoursLabel(data.week.overtimeMinutes)}` : ''}
              </div>
              {data.days.length === 0 && <div style={{ color: P.muted, fontSize: 14 }}>No hours recorded this week.</div>}
              {data.days.map((day) => (
                <details key={day.date} style={{ borderTop: `0.5px solid ${P.border}`, padding: '8px 0' }}>
                  <summary style={{ cursor: 'pointer', color: P.text, fontSize: 14 }}>
                    {formatETDateOnly(day.date, { weekday: 'short', month: 'short', day: 'numeric' })}: {hoursLabel(day.shiftMinutes)} · {day.jobCount} jobs
                    {day.firstClockIn ? ` · ${formatETTime(day.firstClockIn)}${day.lastClockOut ? ` to ${formatETTime(day.lastClockOut)}` : ''}` : ''}
                  </summary>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: P.muted, fontSize: 14 }}>
                    {(entriesByDay[day.date] || []).map((entry) => <li key={entry.id}>{entryLine(entry)}</li>)}
                    {!(entriesByDay[day.date] || []).length && <li>No entries.</li>}
                  </ul>
                </details>
              ))}
              {data.entriesTruncated && <div style={{ color: P.muted, fontSize: 14, marginTop: 8 }}>Only the first entries of this week are listed.</div>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
