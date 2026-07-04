// Dispatch-side "Rain out" sheet — the admin equivalent of the tech app's
// RainOutSheet (pages/tech/TechHomePage.jsx). Moves this visit (or the rest
// of the assigned tech's route) off the weather and texts the customer a
// reply-1-confirm / reply-2-switch message. All logic lives in
// server/services/rain-out.js; this calls the admin endpoints:
//   GET  /admin/dispatch/:id/rain-out-options
//   POST /admin/dispatch/:id/rain-out
// Opened from MobileAppointmentDetailSheet's action section.
//
// Styling matches the light/zinc detail sheet it opens over (not the tech
// app's dark palette) — neutral chrome only, per the admin design spec.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TIMEZONE } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Same four weather reasons the tech sheet offers; rain-out.js maps each to
// a customer-facing phrase in the SMS ("we moved you off the heavy rain…").
const RAIN_REASONS = [
  { code: 'weather_rain', label: 'Rain' },
  { code: 'weather_lightning', label: 'Lightning' },
  { code: 'weather_wind', label: 'Wind' },
  { code: 'weather_heat', label: 'Heat' },
];

// Sentinel selection key for the custom-time option (distinct from the preset
// keys, which are `${kind}:${date}:${start}`).
const CUSTOM_KEY = 'custom';

function hhmmToMin(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function minToHHMM(total) {
  const c = Math.max(0, Math.min(23 * 60 + 59, total));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
}

// A custom start snapped to an on-the-hour 1-hour block — matches the server's
// oneHourWindow so what the dispatcher picks is exactly what gets booked.
function hourWindow(startHHMM) {
  const m = hhmmToMin(startHHMM);
  if (m == null) return null;
  const onHour = Math.floor(m / 60) * 60;
  return { start: minToHHMM(onHour), end: minToHHMM(onHour + 60) };
}

function fmtTime(hhmm) {
  const m = hhmmToMin(hhmm);
  if (m == null) return hhmm;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 || 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDateLabel(dateStr, todayStr) {
  if (!dateStr) return '';
  if (dateStr === todayStr) return 'Today';
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TIMEZONE });
}

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

export default function RainOutSheet({ service, onClose, onDone }) {
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('weather_rain');
  const [selectedKey, setSelectedKey] = useState(null);
  const [scope, setScope] = useState('job');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  // Custom on-the-hour time — dispatcher-typed instead of a preset pill.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [customDate, setCustomDate] = useState(todayStr);
  const [customStart, setCustomStart] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dispatch/${service.id}/rain-out-options`, {
          headers: authHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setOptions(data);
          const first = data.sameDay?.[0] || data.days?.[0];
          setSelectedKey(first ? `${first.kind}:${first.date}:${first.window.start}` : null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load options');
      }
    })();
    return () => { cancelled = true; };
  }, [service.id]);

  const allOptions = options ? [...(options.sameDay || []), ...(options.days || [])] : [];
  const keyOf = (opt) => `${opt.kind}:${opt.date}:${opt.window.start}`;
  const isCustom = selectedKey === CUSTOM_KEY;
  const customWindow = isCustom ? hourWindow(customStart) : null;
  // A same-day custom start must be a FUTURE hour. Only the date field carries a
  // min, so without this a dispatcher could pick an already-started hour; on a
  // route move the rebooker then rejects the elapsed anchor while its siblings
  // still shift, stranding the selected visit. Earliest allowed = next top of
  // the hour after now (ET).
  const nowEtMin = hhmmToMin(new Date().toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false }));
  const minTodayStartMin = (Math.floor((nowEtMin ?? 0) / 60) + 1) * 60;
  const minTodayStart = minToHHMM(Math.min(minTodayStartMin, 23 * 60));
  const customElapsed = !!(isCustom && customWindow && customDate === todayStr
    && hhmmToMin(customWindow.start) < minTodayStartMin);
  const customOption = (isCustom && customWindow && customDate && !customElapsed)
    ? {
        kind: 'custom',
        date: customDate,
        window: customWindow,
        display: `${fmtDateLabel(customDate, todayStr)}, ${fmtTime(customWindow.start)}-${fmtTime(customWindow.end)}`,
      }
    : null;
  const selected = isCustom
    ? customOption
    : (allOptions.find((opt) => keyOf(opt) === selectedKey) || null);
  // The SMS offers the best *other-day* option as the reply-2 alternate. Match
  // by date+start rather than the selection key so a custom time that coincides
  // with a day preset isn't offered as an alternate to itself.
  const alt = selected
    ? (options?.days || []).find((opt) => !(opt.date === selected.date && opt.window.start === selected.window.start)) || null
    : null;
  const routeCount = options?.remainingRouteCount || 0;

  // Seed the custom date AND start from whatever preset was highlighted (or the
  // first slot) so switching to Custom lands on a sensible hour on the RIGHT
  // day — seeding only the time would leave a future preset's hour paired with
  // today's date and book the wrong day (or fail as an elapsed same-day window).
  const pickCustom = () => {
    setSelectedKey(CUSTOM_KEY);
    if (!customStart) {
      const seedOpt = allOptions.find((opt) => keyOf(opt) === selectedKey) || allOptions[0] || null;
      const snapped = hourWindow(seedOpt?.window?.start || '15:00');
      setCustomStart(snapped ? snapped.start : '15:00');
      if (seedOpt?.date) setCustomDate(seedOpt.date);
    }
  };

  const handleCommit = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      // Server books THIS stop into exactly this window (what's displayed);
      // a route-wide same-day push shifts the other stops by this stop's
      // window delta to preserve running order.
      const res = await fetch(`${API_BASE}/admin/dispatch/${service.id}/rain-out`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          reasonCode: reason,
          scope,
          target: { date: selected.date, window: selected.window },
          alt: alt ? { date: alt.date, window: alt.window } : null,
          notifyCustomer: notify,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const failedCount = data.failedCount || 0;
      const summary =
        `Moved ${data.movedCount} ${data.movedCount === 1 ? 'stop' : 'stops'} to ${selected.display}` +
        `${notify ? ', customer texted' : ''}`;
      if (failedCount > 0) {
        // Partial success (a stop raced to terminal or slot-conflicted). The
        // server still returns 200 when at least one moved, so keep the sheet
        // open with the warning instead of silently closing; the parent still
        // refreshes the board for the stops that did move.
        setError(`${summary}. ${failedCount} stop${failedCount === 1 ? '' : 's'} could not be moved — review dispatch.`);
        setBusy(false);
      }
      onDone?.({ summary, movedCount: data.movedCount, failedCount });
    } catch (err) {
      setError(err.message || 'Rain out failed');
      setBusy(false);
    }
  };

  const chipStyle = (active) => ({
    padding: '7px 14px', borderRadius: 16, fontSize: 13, fontWeight: 600,
    border: `1px solid ${active ? '#18181B' : '#D4D4D8'}`,
    background: active ? '#18181B' : '#FFFFFF',
    color: active ? '#FFFFFF' : '#18181B', cursor: 'pointer',
  });

  const sectionLabel = { fontSize: 12, fontWeight: 700, color: '#71717A', letterSpacing: '0.04em', marginBottom: 8 };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Weather reschedule"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 110,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        fontFamily: 'Roboto, system-ui, sans-serif', fontWeight: 700,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: '16px 16px 0 0', width: '100%',
          maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', padding: 20,
          border: '1px solid #E4E4E7', borderBottom: 'none',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <div style={{ fontSize: 18, color: '#18181B' }}>⛈️ Weather reschedule</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#71717A', fontSize: 24, cursor: 'pointer', padding: '0 6px' }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: 13, color: '#71717A', marginBottom: 16 }}>
          {service.customerName || 'Customer'}
          {options?.today?.rainChance != null && ` · today ${options.today.rainChance}% rain`}
        </div>

        {error && (
          <div style={{
            marginBottom: 12, fontSize: 13, padding: '8px 10px', borderRadius: 8,
            background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C',
          }}>
            {error}
          </div>
        )}

        {!options && !error && (
          <div style={{ color: '#71717A', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading options…</div>
        )}

        {options && (
          <>
            <div style={sectionLabel}>WEATHER</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
              {RAIN_REASONS.map((r) => (
                <button key={r.code} type="button" onClick={() => setReason(r.code)} style={chipStyle(reason === r.code)}>
                  {r.label}
                </button>
              ))}
            </div>

            <div style={sectionLabel}>MOVE TO</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {allOptions.length === 0 && (
                <div style={{ fontSize: 13, color: '#71717A' }}>No preset slots — pick a custom time below.</div>
              )}
              {allOptions.map((opt) => {
                const key = keyOf(opt);
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    style={{
                      textAlign: 'left', padding: '11px 13px', borderRadius: 10, fontSize: 14, fontWeight: 600,
                      border: `1px solid ${active ? '#18181B' : '#D4D4D8'}`,
                      background: active ? '#F4F4F5' : '#FFFFFF', color: '#18181B',
                      cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}
                  >
                    <span>
                      {opt.kind === 'same_day' ? '⏱️ ' : '📅 '}{opt.display}
                      {opt.kind === 'same_day' && (
                        <span style={{ color: '#71717A', fontWeight: 400 }}> — storm may pass</span>
                      )}
                    </span>
                    {opt.rainChance != null && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: opt.rainChance >= 50 ? '#B45309' : '#15803D' }}>
                        {opt.rainChance}% 🌧
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Custom on-the-hour time — for when none of the presets is the
                  time the dispatcher agreed on with the customer ("let's do
                  3 PM today"). */}
              <button
                type="button"
                onClick={pickCustom}
                style={{
                  textAlign: 'left', padding: '11px 13px', borderRadius: 10, fontSize: 14, fontWeight: 600,
                  border: `1px solid ${isCustom ? '#18181B' : '#D4D4D8'}`,
                  background: isCustom ? '#F4F4F5' : '#FFFFFF', color: '#18181B',
                  cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span>🕒 Custom time</span>
                {customOption && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#18181B' }}>
                    {fmtDateLabel(customDate, todayStr)} · {fmtTime(customOption.window.start)}
                  </span>
                )}
              </button>
            </div>

            {isCustom && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
                <div style={{ flex: 1 }}>
                  <div style={sectionLabel}>DATE</div>
                  <input
                    type="date"
                    value={customDate}
                    min={todayStr}
                    onChange={(e) => setCustomDate(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: 14, fontWeight: 600,
                      border: '1px solid #D4D4D8', background: '#FFFFFF', color: '#18181B', fontFamily: 'inherit',
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={sectionLabel}>START (ON THE HOUR)</div>
                  <input
                    type="time"
                    step="3600"
                    value={customStart}
                    min={customDate === todayStr ? minTodayStart : undefined}
                    onChange={(e) => {
                      // Snap to the hour on input (a manually-typed off-hour value
                      // like 15:59 would otherwise floor to 15:00 only at book
                      // time, leaving the field showing a time that isn't what
                      // gets scheduled). Snapping here keeps shown == booked.
                      const snapped = hourWindow(e.target.value);
                      setCustomStart(snapped ? snapped.start : '');
                    }}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: 14, fontWeight: 600,
                      border: `1px solid ${customElapsed ? '#DC2626' : '#D4D4D8'}`, background: '#FFFFFF', color: '#18181B', fontFamily: 'inherit',
                    }}
                  />
                </div>
              </div>
            )}

            {customElapsed && (
              <div style={{ fontSize: 12, color: '#B91C1C', marginTop: -8, marginBottom: 18 }}>
                That hour has already started today — pick {fmtTime(minTodayStart)} or later.
              </div>
            )}

            {routeCount > 0 && (
              <>
                <div style={sectionLabel}>SCOPE</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
                  <button type="button" onClick={() => setScope('job')} style={chipStyle(scope === 'job')}>
                    This stop
                  </button>
                  <button type="button" onClick={() => setScope('route')} style={chipStyle(scope === 'route')}>
                    This + rest of route ({routeCount})
                  </button>
                </div>
              </>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, cursor: 'pointer', fontSize: 14, color: '#18181B' }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 18, height: 18 }} />
              Text the customer a reply-to-adjust message
            </label>

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1, padding: '13px 20px', borderRadius: 9999, fontSize: 15, fontWeight: 700,
                  border: '1px solid #E4E4E7', background: '#FFFFFF', color: '#18181B', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={!selected || busy}
                style={{
                  flex: 2, padding: '13px 20px', borderRadius: 9999, fontSize: 15, fontWeight: 700,
                  border: '1px solid #18181B', background: '#18181B', color: '#FFFFFF',
                  cursor: !selected || busy ? 'default' : 'pointer', opacity: !selected || busy ? 0.5 : 1,
                }}
              >
                {busy ? 'Moving…' : 'Move appointment'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
