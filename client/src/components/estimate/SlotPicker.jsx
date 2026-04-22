/**
 * Slot picker — fetches primary (3 route-optimal) + expander (10 more)
 * from /api/public/estimates/:token/available-slots. Customer tap sets
 * selectedSlotId locally; actual /reserve fires from the payment-pref
 * buttons downstream.
 *
 * Route-optimal copy: "Nearby {dayName} — {techFirstName} is servicing
 * a property close to you" — hybrid framing per product decision. No
 * quantification shown to customer in v1; detourMinutes carried on the
 * payload for future A/B testing.
 */
import { useEffect, useState } from 'react';

const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  green: '#16A34A', greenLight: '#DCFCE7',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', offWhite: '#F1F5F9', sand: '#FEF7E0', border: '#CBD5E1',
};

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function formatSlotDate(date, windowStart, windowEnd) {
  try {
    const d = new Date(date + 'T' + (windowStart || '00:00') + ':00');
    const day = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const fmtT = (t) => {
      if (!t) return '';
      const [h, m] = String(t).split(':').map(Number);
      const dt = new Date();
      dt.setHours(h, m, 0, 0);
      return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };
    return { day, window: `${fmtT(windowStart)}–${fmtT(windowEnd)}` };
  } catch {
    return { day: date, window: `${windowStart}–${windowEnd}` };
  }
}

function SlotCard({ slot, isSelected, onSelect }) {
  const { day, window } = formatSlotDate(slot.date, slot.windowStart, slot.windowEnd);
  const techLine = slot.techFirstName ? `with ${slot.techFirstName}` : 'tech TBD';

  return (
    <button
      type="button"
      onClick={() => onSelect(slot.slotId)}
      style={{
        textAlign: 'left', width: '100%',
        background: isSelected ? W.sand : W.white,
        border: `2px solid ${isSelected ? W.blueBright : W.border}`,
        borderRadius: 14, padding: 16,
        cursor: 'pointer', marginBottom: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: W.navy }}>{day}</div>
      <div style={{ fontSize: 14, color: W.textBody }}>{window} · {techLine}</div>
      {slot.routeOptimal ? (
        <div style={{
          marginTop: 6, fontSize: 12, fontWeight: 600, color: W.green,
          background: W.greenLight, padding: '4px 8px', borderRadius: 999,
          alignSelf: 'flex-start',
        }}>
          Nearby day — {slot.techFirstName || 'tech'} is servicing a property close to you
        </div>
      ) : null}
    </button>
  );
}

export default function SlotPicker({ token, selectedSlotId, onSelect, refreshSignal }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showExpander, setShowExpander] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/public/estimates/${token}/available-slots`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('slot fetch failed'))))
      .then((body) => { if (!cancelled) { setData(body); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token, refreshSignal]);

  if (loading) {
    return (
      <div style={{ background: W.white, borderRadius: 16, padding: 24, border: `1px solid ${W.border}`, marginBottom: 16, color: W.textCaption, fontSize: 14 }}>
        Loading available times…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: W.white, borderRadius: 16, padding: 24, border: `1px solid ${W.border}`, marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: W.textBody }}>
          Couldn't load times right now. <a href="tel:+19413187612" style={{ color: W.blue }}>Call (941) 318-7612</a> and we'll get you scheduled.
        </div>
      </div>
    );
  }

  const primary = data?.primary || [];
  const expander = data?.expander || [];

  if (primary.length === 0 && expander.length === 0) {
    return (
      <div style={{ background: W.white, borderRadius: 16, padding: 24, border: `1px solid ${W.border}`, marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: W.textBody }}>
          No open slots in the next 14 days. <a href="tel:+19413187612" style={{ color: W.blue }}>Call us</a> and we'll fit you in.
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: W.white, borderRadius: 16, padding: 24, border: `1px solid ${W.border}`, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
        Pick a time
      </div>
      {primary.map((slot) => (
        <SlotCard key={slot.slotId} slot={slot} isSelected={selectedSlotId === slot.slotId} onSelect={onSelect} />
      ))}

      {expander.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setShowExpander((v) => !v)}
            style={{
              marginTop: 8, padding: '10px 16px', background: 'transparent',
              color: W.blue, border: `1px solid ${W.border}`, borderRadius: 12,
              cursor: 'pointer', fontSize: 14, fontWeight: 600, width: '100%',
            }}
          >
            {showExpander ? 'Show fewer times' : `See ${expander.length} more times`}
          </button>
          {showExpander ? (
            <div style={{ marginTop: 14 }}>
              {expander.map((slot) => (
                <SlotCard key={slot.slotId} slot={slot} isSelected={selectedSlotId === slot.slotId} onSelect={onSelect} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
