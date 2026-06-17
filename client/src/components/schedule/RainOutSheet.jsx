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

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Same four weather reasons the tech sheet offers; rain-out.js maps each to
// a customer-facing phrase in the SMS ("we moved you off the heavy rain…").
const RAIN_REASONS = [
  { code: 'weather_rain', label: 'Rain' },
  { code: 'weather_lightning', label: 'Lightning' },
  { code: 'weather_wind', label: 'Wind' },
  { code: 'weather_heat', label: 'Heat' },
];

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
  const selected = allOptions.find((opt) => keyOf(opt) === selectedKey) || null;
  // The SMS offers the best *other-day* option as the reply-2 alternate.
  const alt = selected ? (options?.days || []).find((opt) => keyOf(opt) !== selectedKey) || null : null;
  const routeCount = options?.remainingRouteCount || 0;

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
      const failures = data.failedCount ? `, ${data.failedCount} failed — check dispatch` : '';
      onDone?.(
        `Moved ${data.movedCount} ${data.movedCount === 1 ? 'stop' : 'stops'} to ${selected.display}` +
        `${notify ? ', customer texted' : ''}${failures}`,
      );
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
                <div style={{ fontSize: 13, color: '#71717A' }}>No slots available — reschedule manually.</div>
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
            </div>

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
