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
  white: '#FFFFFF', offWhite: '#F1F5F9', sand: '#FEF7E0', border: '#E2E8F0', warmBorder: '#E7E2D7',
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
  const startTime = String(window || '').split('–')[0] || window;

  return (
    <button
      type="button"
      onClick={() => onSelect(slot.slotId)}
      style={{
        textAlign: 'left', width: '100%',
        background: isSelected ? W.blueDeeper : W.white,
        color: isSelected ? W.white : W.blueDeeper,
        border: `2px solid ${isSelected ? W.blueDeeper : W.border}`,
        borderRadius: 12, padding: '16px 18px',
        cursor: 'pointer', marginBottom: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
        transition: 'border-color 160ms ease, background 160ms ease, color 160ms ease',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, color: isSelected ? 'rgba(255,255,255,.82)' : W.textCaption }}>{day}</div>
      <div style={{ fontSize: 30, fontWeight: 800, color: isSelected ? W.white : W.blueDeeper, lineHeight: 1.15 }}>{startTime}</div>
      <div style={{ fontSize: 15, color: isSelected ? 'rgba(255,255,255,.86)' : W.textCaption }}>
        Arrival window: {window}
      </div>
      {slot.routeOptimal ? (
        <div style={{
          marginTop: 6, fontSize: 12, fontWeight: 700, color: isSelected ? W.white : W.green,
          background: isSelected ? 'rgba(255,255,255,.16)' : W.greenLight, padding: '4px 8px', borderRadius: 999,
          alignSelf: 'flex-start',
        }}>
          Nearby day — {slot.techFirstName || 'tech'} is servicing a property close to you
        </div>
      ) : null}
    </button>
  );
}

const INITIAL_VISIBLE = 3;

export default function SlotPicker({
  token,
  selectedSlotId,
  onSelect,
  refreshSignal,
  serviceMode = 'recurring',
  selectedFrequency = null,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowMore(false);
    const params = new URLSearchParams();
    params.set('serviceMode', serviceMode === 'one_time' ? 'one_time' : 'recurring');
    if (serviceMode !== 'one_time' && selectedFrequency) {
      params.set('selectedFrequency', selectedFrequency);
    }
    const query = params.toString();
    fetch(`${API_BASE}/public/estimates/${token}/available-slots${query ? `?${query}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('slot fetch failed'))))
      .then((body) => { if (!cancelled) { setData(body); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token, refreshSignal, serviceMode, selectedFrequency]);

  if (loading) {
    return (
      <div style={{ background: W.white, borderRadius: 14, padding: 24, border: `1px solid ${W.warmBorder}`, marginBottom: 16, color: W.textCaption, fontSize: 14 }}>
        Loading available times…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ background: W.white, borderRadius: 14, padding: 24, border: `1px solid ${W.warmBorder}`, marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: W.textBody }}>
          Couldn't load times right now. <a href="tel:+19412975749" style={{ color: W.blueDeeper }}>Call (941) 297-5749</a> and we'll get you scheduled.
        </div>
      </div>
    );
  }

  // Merge primary (route-optimal, top 3) + expander (rest) into a single
  // ordered list. Always show the first 3 by default; next 3 hide behind
  // a "See more" toggle. Keeps the card compact and avoids overwhelming
  // the customer on wide windows with lots of availability.
  const primary = data?.primary || [];
  const expander = data?.expander || [];
  const allSlots = [...primary, ...expander];

  if (allSlots.length === 0) {
    return (
      <div style={{ background: W.white, borderRadius: 14, padding: 24, border: `1px solid ${W.warmBorder}`, marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: W.textBody }}>
          No open slots in the next 14 days. <a href="tel:+19412975749" style={{ color: W.blueDeeper }}>Call us</a> and we'll fit you in.
        </div>
      </div>
    );
  }

  const initial = allSlots.slice(0, INITIAL_VISIBLE);
  const more = allSlots.slice(INITIAL_VISIBLE, INITIAL_VISIBLE + 3);

  return (
    <div style={{ background: W.white, borderRadius: 14, padding: 32, border: `1px solid ${W.warmBorder}`, marginBottom: 16 }}>
      <div style={{
        fontSize: 30,
        fontWeight: 800,
        color: W.blueDeeper,
        letterSpacing: 0,
        lineHeight: 1.2,
        marginBottom: 8,
      }}>
        Find a date & time that works for you
      </div>
      <div style={{ fontSize: 16, color: W.textCaption, lineHeight: 1.55, marginBottom: 22 }}>
        These are the windows when we'll already be working in your neighborhood — pick whichever fits.
      </div>
      {initial.map((slot) => (
        <SlotCard key={slot.slotId} slot={slot} isSelected={selectedSlotId === slot.slotId} onSelect={onSelect} />
      ))}

      {more.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            style={{
              marginTop: 8, padding: '10px 16px', background: 'transparent',
              color: W.blueDeeper, border: `1px solid ${W.blueDeeper}`, borderRadius: 12,
              cursor: 'pointer', fontSize: 14, fontWeight: 600, width: '100%',
            }}
          >
            {showMore ? 'Hide extra slots' : `Show ${more.length} more open slot${more.length === 1 ? '' : 's'}`}
          </button>
          {showMore ? (
            <div style={{ marginTop: 14 }}>
              {more.map((slot) => (
                <SlotCard key={slot.slotId} slot={slot} isSelected={selectedSlotId === slot.slotId} onSelect={onSelect} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
