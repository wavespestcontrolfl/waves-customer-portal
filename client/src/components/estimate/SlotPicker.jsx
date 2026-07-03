/**
 * Slot picker — fetches the soonest estimate slots from
 * /api/public/estimates/:token/available-slots. Route-optimal slots are
 * labeled by the API. Customer tap sets
 * selectedSlotId locally; actual /reserve fires from the payment-pref
 * buttons downstream.
 *
 * Route-optimal copy: "Nearby {dayName} — {techFirstName} is servicing
 * a property close to you" — hybrid framing per product decision. No
 * quantification shown to customer in v1; detourMinutes carried on the
 * payload for future A/B testing.
 */
import { useEffect, useId, useRef, useState } from 'react';
import WavesAIScheduleSearch from '../booking/WavesAIScheduleSearch';
import { estimateCard } from './cardStyles';

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
        borderRadius: 12, padding: '14px 16px',
        cursor: 'pointer', marginBottom: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
        transition: 'border-color 160ms ease, background 160ms ease, color 160ms ease',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: isSelected ? 'rgba(255,255,255,.82)' : W.textCaption }}>{day}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: isSelected ? W.white : W.blueDeeper, lineHeight: 1.2 }}>{startTime}</div>
      <div style={{ fontSize: 13, color: isSelected ? 'rgba(255,255,255,.86)' : W.textCaption }}>
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

const INITIAL_VISIBLE = 6;

export default function SlotPicker({
  token,
  askToken = null,
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
  // Custom date/time finder — Waves AI search + 90-day date picker
  const [searchData, setSearchData] = useState(null);
  const [pickedDate, setPickedDate] = useState(null);
  const [pickedData, setPickedData] = useState(null);
  const [pickedLoading, setPickedLoading] = useState(false);
  const latestPickedRequestRef = useRef(0);
  const pickedDateInputId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowMore(false);
    setSearchData(null);
    setPickedDate(null);
    setPickedData(null);
    setPickedLoading(false);
    latestPickedRequestRef.current += 1;
    const params = new URLSearchParams();
    params.set('serviceMode', serviceMode === 'one_time' ? 'one_time' : 'recurring');
    params.set('windowDays', '14');
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

  // ── custom date/time finder ──
  const pad2 = (n) => String(n).padStart(2, '0');
  const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const browseMin = toYmd(new Date());
  const browseMax = (() => { const d = new Date(); d.setDate(d.getDate() + 90); return toYmd(d); })();

  const freqParams = () => {
    const p = new URLSearchParams();
    p.set('serviceMode', serviceMode === 'one_time' ? 'one_time' : 'recurring');
    if (serviceMode !== 'one_time' && selectedFrequency) p.set('selectedFrequency', selectedFrequency);
    return p;
  };

  const runAiSearch = async (query) => {
    const res = await fetch(`${API_BASE}/public/estimates/${token}/find-slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(askToken ? { 'X-Estimate-Ask-Token': askToken } : {}),
      },
      body: JSON.stringify({ query, serviceMode, selectedFrequency }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'search failed');
    setPickedDate(null);
    onSelect(null);
    setSearchData(body);
    return { summary: body.summary };
  };

  const onPickDate = async (date) => {
    const requestId = latestPickedRequestRef.current + 1;
    latestPickedRequestRef.current = requestId;
    setSearchData(null);
    setPickedDate(date);
    setPickedData(null);
    onSelect(null);
    if (!date) {
      setPickedLoading(false);
      return;
    }
    setPickedLoading(true);
    try {
      const p = freqParams();
      p.set('date', date);
      const res = await fetch(`${API_BASE}/public/estimates/${token}/available-slots?${p.toString()}`);
      const body = res.ok ? await res.json() : { primary: [], expander: [] };
      if (latestPickedRequestRef.current !== requestId) return;
      setPickedData(body);
    } catch {
      if (latestPickedRequestRef.current !== requestId) return;
      setPickedData({ primary: [], expander: [] });
    } finally {
      if (latestPickedRequestRef.current === requestId) {
        setPickedLoading(false);
      }
    }
  };

  const SoftRouteBanner = () => (
    <div style={{
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10,
      padding: '10px 12px', fontSize: 14, color: '#9A3412', marginBottom: 10, lineHeight: 1.4,
    }}>
      No route near you that day yet — here&apos;s what&apos;s close.
    </div>
  );

  const renderSlotList = (payload) => {
    const list = [...(payload?.primary || []), ...(payload?.expander || [])];
    if (list.length === 0) {
      return (
        <div style={{ fontSize: 14, color: W.textBody }}>
          No open times then. <a href="tel:+19412975749" style={{ color: W.blueDeeper }}>Call (941) 297-5749</a> and we&apos;ll fit you in.
        </div>
      );
    }
    const nearby = payload?.nearby ?? list.some((s) => s.routeOptimal);
    return (
      <>
        {!nearby ? <SoftRouteBanner /> : null}
        {list.map((slot) => (
          <SlotCard key={slot.slotId} slot={slot} isSelected={selectedSlotId === slot.slotId} onSelect={onSelect} />
        ))}
      </>
    );
  };

  // Waves AI search + 90-day date picker. Lives INSIDE the booking card,
  // directly under the "Find a date & time" heading + explainer and above
  // the slot list — same order as the server-rendered estimate's
  // #date-finder block.
  const finder = (
    <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
      <WavesAIScheduleSearch
        theme={{ accent: W.blueDeeper, accentText: W.white, text: W.blueDeeper, muted: W.textCaption, border: W.border, surface: W.white, inputBg: W.offWhite }}
        onSearch={runAiSearch}
      />
      {searchData ? <div>{renderSlotList(searchData)}</div> : null}
      <div style={{ border: `1px solid ${W.border}`, borderRadius: 12, padding: 14, background: W.offWhite }}>
        <label htmlFor={pickedDateInputId} style={{ display: 'block', fontSize: 13, fontWeight: 700, color: W.blueDeeper, marginBottom: 6 }}>
          Can't find a date? Pick one that works for you.
        </label>
        <input
          id={pickedDateInputId}
          type="date"
          min={browseMin}
          max={browseMax}
          placeholder="mm/dd/yyyy"
          value={pickedDate || ''}
          onChange={(e) => onPickDate(e.target.value)}
          style={{
            width: '100%', border: `1px solid ${W.border}`, borderRadius: 10,
            padding: '12px 14px', fontSize: 15, color: W.navy, background: W.white,
          }}
        />
        <div style={{ fontSize: 12, color: W.textCaption, marginTop: 8 }}>
          We'll check open windows up to 90 days out.
        </div>
      </div>
      {pickedLoading ? <div style={{ fontSize: 14, color: W.textCaption }}>Loading times…</div> : null}
      {pickedData ? <div>{renderSlotList(pickedData)}</div> : null}
    </div>
  );

  if (loading) {
    return (
      <div style={estimateCard({ color: W.textCaption, fontSize: 14 })}>
        Loading available times…
      </div>
    );
  }

  if (error) {
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 14, color: W.textBody }}>
          Couldn't load times right now. <a href="tel:+19412975749" style={{ color: W.blueDeeper }}>Call (941) 297-5749</a> and we'll get you scheduled.
        </div>
      </div>
    );
  }

  // Merge primary + expander into a single ordered list. Show six windows
  // by default so sparse route maps do not make the customer think only
  // one or two dates exist.
  const primary = data?.primary || [];
  const expander = data?.expander || [];
  const allSlots = [...primary, ...expander];

  const heading = (
    <>
      <div style={{
        fontSize: 22,
        fontWeight: 600,
        color: W.blueDeeper,
        letterSpacing: 0,
        lineHeight: 1.2,
        marginBottom: 8,
      }}>
        Find a date & time that works for you
      </div>
      <div style={{ fontSize: 14, color: W.textCaption, lineHeight: 1.55, marginBottom: 16 }}>
        These are the soonest open service windows we can offer. Nearby route days are marked when a tech is already close by.
      </div>
    </>
  );

  if (allSlots.length === 0) {
    return (
      <div style={estimateCard()}>
        {heading}
        {finder}
        <div style={{ fontSize: 14, color: W.textBody }}>
          No open slots in the next 14 days — try searching a specific date above, or <a href="tel:+19412975749" style={{ color: W.blueDeeper }}>call us</a> and we&apos;ll fit you in.
        </div>
      </div>
    );
  }

  const initial = allSlots.slice(0, INITIAL_VISIBLE);
  const more = allSlots.slice(INITIAL_VISIBLE, INITIAL_VISIBLE + 3);

  return (
    <div style={estimateCard()}>
      {heading}
      {finder}
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
