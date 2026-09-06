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
import SchedulePicker, { pickerDayLabel, pickerRange } from '../booking/SchedulePicker';
import { estimateCard, ESTIMATE_INNER_SHADOW } from './cardStyles';
import {
  glassCopyActive,
  glassRewriteSlotSummary,
  glassSchedQualifier,
  glassSchedTitle,
  GLASS_COPY,
} from '../../lib/estimate-glass-copy';
import { glassScarcityInfo, glassSlotIsStale, glassSlotMeta } from '../../lib/estimate-glass-slots';
import { GlassScarcityBadge, GlassTechChip } from './glass/GlassEstimateExtras';
import { W } from './tokens';
import { GOLD_CTA } from '../../theme-brand';


const API_BASE = import.meta.env.VITE_API_URL || '/api';

// The arrival window promised to the customer is 2 HOURS from the slot start
// (owner directive; matches the window_start + 2h promise the late detector
// enforces). slot.windowEnd is the JOB block that sizes scheduling/overlap —
// never show it as the arrival window.
const ARRIVAL_WINDOW_MINUTES = 120;

function formatSlotDate(date, windowStart) {
  try {
    const d = new Date(date + 'T' + (windowStart || '00:00') + ':00');
    const day = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const [h, m] = String(windowStart || '0:00').split(':').map(Number);
    const startDt = new Date();
    startDt.setHours(h, m, 0, 0);
    const endDt = new Date(startDt.getTime() + ARRIVAL_WINDOW_MINUTES * 60000);
    const fmtT = (dt) => dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return { day, window: `${fmtT(startDt)}–${fmtT(endDt)}` };
  } catch {
    return { day: date, window: String(windowStart || '') };
  }
}

// Estimate slots ({ slotId, date, windowStart, routeOptimal, rainChance, … })
// → the shared picker's availability shape. Each day's slots keep every
// original field, so the stamped slot the picker hands back IS the API
// slot (glassSlotMeta, reserve payloads and the hold fallback all read it
// unchanged); the grid bounds come from the picker's own two-week default.
function toAvailability(slots) {
  const byDate = new Map();
  for (const slot of slots) {
    if (!slot?.date) continue;
    if (!byDate.has(slot.date)) {
      byDate.set(slot.date, { date: slot.date, fullDate: pickerDayLabel(slot.date), nearby: false, rainChance: null, slots: [] });
    }
    const day = byDate.get(slot.date);
    if (slot.routeOptimal) day.nearby = true;
    if (Number.isFinite(slot.rainChance)) day.rainChance = Math.max(day.rainChance ?? 0, slot.rainChance);
    const { window } = formatSlotDate(slot.date, slot.windowStart);
    day.slots.push({ ...slot, nearby: !!slot.routeOptimal, start_time: slot.windowStart, start_label: String(window || '').split('–')[0] || window });
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days, ...pickerRange(days) };
}

export default function SlotPicker({
  token,
  preview = false,
  askToken = null,
  selectedSlotId,
  onSelect,
  onSelectMeta = null,
  selectedSlotFallbackMeta = null,
  licenseNumber = null,
  refreshSignal,
  serviceMode = 'recurring',
  selectedFrequency = null,
  // Bundle combo axes ({ mosquito: 'seasonal9' }): the mosquito tier changes
  // the server's seasonal slot filter/horizon while selectedFrequency stays
  // the pest cadence.
  serviceCadences = null,
  onFirstSlotDate = null,
  cityLabel = null,
}) {
  const [data, setData] = useState(null);
  // Report the first open slot date up (hero {date} token).
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Which day's times the shared picker shows; null = its first open day.
  // Reset whenever the list on screen changes (fetch, search, picked date).
  const [pickedDay, setPickedDay] = useState(null);
  // Custom date/time finder — Waves AI search + 90-day date picker
  const [searchData, setSearchData] = useState(null);
  const [pickedDate, setPickedDate] = useState(null);
  const [pickedData, setPickedData] = useState(null);
  const [pickedLoading, setPickedLoading] = useState(false);
  const [pickedError, setPickedError] = useState(false);
  const [pickedDateFocused, setPickedDateFocused] = useState(false);
  const latestPickedRequestRef = useRef(0);
  const pickedDateInputId = useId();
  // Glass copy pack (PR B) — availability-first phrasing.
  const glass = glassCopyActive();
  // Slot freshness (glass, PR C): re-evaluate the 2-hour booking lead every
  // minute so a page left open grays out windows the server would now
  // reject — matching reserveSlot's guard instead of surfacing a
  // slot_conflict after the customer taps.
  const [freshnessTick, setFreshnessTick] = useState(0);
  useEffect(() => {
    if (!glass) return undefined;
    const id = setInterval(() => setFreshnessTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, [glass]);

  // Report the first open slot's date up to the page (hero {date} token).
  // A loaded response with NO slots reports null so the page drops a stale
  // date instead of keeping an earlier claim (codex P2, PR #2439); before
  // load it stays silent so the page's neutral copy holds.
  useEffect(() => {
    if (!onFirstSlotDate || !data) return;
    // Apply the same staleness filter the pills use — otherwise the hero
    // promises a day whose slots render disabled. freshnessTick keeps the
    // claim honest while the page sits open.
    const slots = [...(data?.primary || []), ...(data?.expander || [])];
    const firstOpen = glass ? slots.find((s) => !glassSlotIsStale(s)) : slots[0];
    onFirstSlotDate(firstOpen?.date || null);
  }, [data, onFirstSlotDate, glass, freshnessTick]);

  const selectSlot = (slot) => {
    onSelect(slot ? slot.slotId : null);
    if (onSelectMeta) onSelectMeta(slot ? glassSlotMeta(slot) : null);
  };

  // Every slot list currently on screen (default + search + picked-date).
  const visibleSlots = [
    ...(data ? [...(data.primary || []), ...(data.expander || [])] : []),
    ...(searchData ? [...(searchData.primary || []), ...(searchData.expander || [])] : []),
    ...(pickedData ? [...(pickedData.primary || []), ...(pickedData.expander || [])] : []),
  ];
  const selectedSlot = selectedSlotId
    ? visibleSlots.find((s) => s.slotId === selectedSlotId) || null
    : null;

  // The selection the customer may be retrying after a review cancel: the
  // page threads back the slot's own metadata because the customer's LIVE
  // reservation hold occupies that slot server-side, so a refetch excludes
  // it from the visible lists even though it's theirs to retry.
  const heldSelection = selectedSlotFallbackMeta && selectedSlotFallbackMeta.slotId === selectedSlotId
    ? selectedSlotFallbackMeta
    : null;

  // A selection is only valid while it's outside the booking lead AND
  // either on screen or covered by the customer's own hold — otherwise
  // clear it (and the CTA labels with it).
  useEffect(() => {
    if (!glass || !selectedSlotId) return;
    // While slots are loading (first mount, or a remount after review-cancel
    // that intentionally preserves selectedSlotId), an empty list means
    // "unknown", not "gone" — clearing here would drop a valid selection and
    // hide the payment choices before the fetch repopulates the list.
    if (loading || !data) return;
    if (selectedSlot) {
      if (glassSlotIsStale(selectedSlot)) selectSlot(null);
      return;
    }
    // Absent from the visible lists: keep it while the customer's own held
    // window is still bookable — reserve/accept revalidate server-side.
    if (!heldSelection || glassSlotIsStale(heldSelection)) selectSlot(null);
    // freshnessTick re-runs the check each minute while the page sits open.
  }, [glass, selectedSlotId, selectedSlot, heldSelection, freshnessTick, loading, data]);

  useEffect(() => {
    if (preview) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPickedDay(null);
    setSearchData(null);
    setPickedDate(null);
    setPickedData(null);
    setPickedError(false);
    setPickedLoading(false);
    latestPickedRequestRef.current += 1;
    const params = new URLSearchParams();
    params.set('serviceMode', serviceMode === 'one_time' ? 'one_time' : 'recurring');
    params.set('windowDays', '14');
    if (serviceMode !== 'one_time' && selectedFrequency) {
      params.set('selectedFrequency', selectedFrequency);
    }
    if (serviceMode !== 'one_time' && serviceCadences) {
      params.set('serviceCadences', JSON.stringify(serviceCadences));
    }
    const query = params.toString();
    fetch(`${API_BASE}/public/estimates/${token}/available-slots${query ? `?${query}` : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('slot fetch failed'))))
      .then((body) => { if (!cancelled) { setData(body); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token, preview, refreshSignal, serviceMode, selectedFrequency, serviceCadences]);

  if (preview) return <section style={{ padding: 20 }} aria-label="Scheduling preview">
    <p style={{ margin: 0, fontSize: 16 }}>Customers choose from current appointment times here. Scheduling and date searches are disabled in staff preview.</p>
  </section>;

  // ── custom date/time finder ──
  const pad2 = (n) => String(n).padStart(2, '0');
  const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const browseMin = toYmd(new Date());
  const browseMax = (() => {
    // Mirror of the server's seasonalMaxHorizonDays (codex r19 P2): a
    // seasonal (Feb–Oct) mosquito selection in the Nov–Jan gap may browse
    // through the season opener + the default window — on Nov 1–2 the next
    // Feb 1 sits past the standard 90 days and the picker would otherwise
    // block dates the API and reservation now accept.
    const seasonalSelected = serviceMode !== 'one_time'
      && ([selectedFrequency, serviceCadences?.mosquito]
        .some((v) => ['seasonal9', 'seasonal', 'seasonal_feb_oct']
          .includes(String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'))));
    let horizonDays = 90;
    if (seasonalSelected) {
      // Walk to the date that gives a full 90-day complement of IN-SEASON
      // days (Feb–Oct), crossing the Nov–Jan gap — mirror of the server's
      // seasonalMaxHorizonDays, so the picker bound matches what the API's
      // browse clamp and the reservation gate accept (an Oct 31 customer
      // must reach February; a wide window may extend into spring).
      const inSeasonMonth = (d) => { const m = d.getMonth(); return m >= 1 && m <= 9; };
      const at = new Date(); at.setHours(12, 0, 0, 0);
      let counted = 0;
      let steps = 0;
      while (steps < 320) {
        if (inSeasonMonth(at)) {
          counted += 1;
          if (counted >= 91) break;
        }
        at.setDate(at.getDate() + 1);
        steps += 1;
      }
      horizonDays = Math.max(90, steps);
    }
    const d = new Date();
    d.setDate(d.getDate() + horizonDays);
    return toYmd(d);
  })();

  const formatPickedDate = (ymd) => {
    try {
      const d = new Date(ymd + 'T12:00:00');
      if (Number.isNaN(d.getTime())) return ymd;
      return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
      return ymd;
    }
  };

  const freqParams = () => {
    const p = new URLSearchParams();
    p.set('serviceMode', serviceMode === 'one_time' ? 'one_time' : 'recurring');
    if (serviceMode !== 'one_time' && selectedFrequency) p.set('selectedFrequency', selectedFrequency);
    if (serviceMode !== 'one_time' && serviceCadences) p.set('serviceCadences', JSON.stringify(serviceCadences));
    return p;
  };

  const runAiSearch = async (query) => {
    const res = await fetch(`${API_BASE}/public/estimates/${token}/find-slots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(askToken ? { 'X-Estimate-Ask-Token': askToken } : {}),
      },
      body: JSON.stringify({ query, serviceMode, selectedFrequency, ...(serviceCadences ? { serviceCadences } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'search failed');
    if (glass) body.summary = glassRewriteSlotSummary(body.summary, query);
    latestPickedRequestRef.current += 1;
    setPickedDate(null);
    setPickedData(null);
    setPickedError(false);
    setPickedLoading(false);
    setPickedDay(null);
    selectSlot(null);
    setSearchData(body);
    return { summary: body.summary };
  };

  const clearFinder = () => {
    latestPickedRequestRef.current += 1;
    setSearchData(null);
    setPickedDate(null);
    setPickedData(null);
    setPickedError(false);
    setPickedDay(null);
    setPickedLoading(false);
    selectSlot(null);
  };

  const onPickDate = async (date) => {
    const requestId = latestPickedRequestRef.current + 1;
    latestPickedRequestRef.current = requestId;
    setSearchData(null);
    setPickedDate(date);
    setPickedData(null);
    setPickedError(false);
    setPickedDay(null);
    selectSlot(null);
    if (!date) {
      setPickedLoading(false);
      return;
    }
    setPickedLoading(true);
    try {
      const p = freqParams();
      p.set('date', date);
      const res = await fetch(`${API_BASE}/public/estimates/${token}/available-slots?${p.toString()}`);
      if (!res.ok) throw new Error('slot fetch failed');
      const body = await res.json();
      if (latestPickedRequestRef.current !== requestId) return;
      setPickedData(body);
    } catch {
      if (latestPickedRequestRef.current !== requestId) return;
      setPickedError(true);
    } finally {
      if (latestPickedRequestRef.current === requestId) {
        setPickedLoading(false);
      }
    }
  };

  // The list on screen: a search or picked-date result replaces the default
  // window (same rule as before — the finder results owned the list).
  const activePayload = searchData || pickedData || null;
  const listSlots = (payload) => (payload ? [...(payload.primary || []), ...(payload.expander || [])] : []);
  const shownSlots = (activePayload ? listSlots(activePayload) : listSlots(data))
    .filter((slot) => !(glass && glassSlotIsStale(slot)));
  const availability = toAvailability(shownSlots);
  // The API lists are engine-ordered (soonest / route-optimal first) — the
  // top three feed the picker's "Our best times" strip.
  const rankedSlots = activePayload ? null : shownSlots.slice(0, 3).map((slot) => ({ slotId: slot.slotId, date: slot.date, start_time: slot.windowStart }));
  const pickerSelected = selectedSlot ? { ...selectedSlot, start_time: selectedSlot.windowStart } : null;

  const callUs = (
    <a href="tel:+19412975749" style={{ color: W.blueDeeper }}>Call (941) 297-5749</a>
  );

  const picker = (
    <SchedulePicker
      frame="inner"
      availability={availability}
      rankedSlots={rankedSlots}
      selectedDate={pickedDay}
      onSelectDay={(date) => { setPickedDay(date); selectSlot(null); }}
      selectedSlot={pickerSelected}
      onSelectSlot={(slot) => selectSlot(slot)}
      intro="Tap a time — each shows the two-hour arrival window from its start."
      slotDetail={(slot) => `Arrival window: ${formatSlotDate(slot.date, slot.windowStart).window}`}
      empty={(
        <div style={{ fontSize: 14, color: W.textBody, marginBottom: 12 }}>
          {activePayload
            ? <>No open times then. {callUs} and we&apos;ll fit you in.</>
            : <>No open slots in the next 14 days — try searching a specific date below, or {callUs} and we&apos;ll fit you in.</>}
        </div>
      )}
    />
  );

  // Waves AI search sits above the picker; the 90-day date input below it
  // reaches past the two-week window (same order as /book).
  const search = (
    <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
      <WavesAIScheduleSearch
        theme={{ accent: W.blueDeeper, accentText: W.white, text: W.blueDeeper, muted: W.textCaption, border: W.borderCool, surface: W.white, inputBg: W.offWhite }}
        showEyebrow={false}
        subtitle={null}
        onSearch={runAiSearch}
      />
      {searchData || pickedDate ? (
        <button
          type="button"
          onClick={clearFinder}
          style={{
            justifySelf: 'start', background: 'transparent', border: 'none',
            color: W.blueDeeper, fontSize: 14, fontWeight: 700, cursor: 'pointer',
            textDecoration: 'underline', textUnderlineOffset: 3,
            padding: '12px 8px', minHeight: 44, // touch audit 2026-07-06
          }}
        >
          Clear search — show the soonest openings
        </button>
      ) : null}
    </div>
  );

  const dateFinder = (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ border: `1px solid ${W.borderCool}`, borderRadius: 10, padding: 16, background: W.white, boxShadow: ESTIMATE_INNER_SHADOW }}>
        <label htmlFor={pickedDateInputId} style={{ display: 'block', fontSize: 14, fontWeight: 700, color: W.blueDeeper, marginBottom: 8 }}>
          Can't find a date? Pick one that works for you.
        </label>
        {/* iOS Safari renders an empty <input type="date"> as a blank box
            (no placeholder, unpredictable height), so the visible layer is
            our own text and the native input sits invisibly on top to keep
            the tap-to-open picker, label wiring, and keyboard access. */}
        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center', gap: 12,
          minHeight: 48, boxSizing: 'border-box', padding: '12px 16px',
          border: `1px solid ${pickedDateFocused ? W.blueDeeper : W.borderCool}`,
          borderRadius: 10, background: W.white,
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={W.blueDeeper} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span style={{
            fontSize: 15,
            fontWeight: pickedDate ? 600 : 400,
            color: pickedDate ? W.navy : W.textCaption,
            lineHeight: 1.35,
          }}>
            {pickedDate ? formatPickedDate(pickedDate) : 'Select a date (mm/dd/yyyy)'}
          </span>
          <input
            id={pickedDateInputId}
            type="date"
            min={browseMin}
            max={browseMax}
            value={pickedDate || ''}
            onChange={(e) => onPickDate(e.target.value)}
            onFocus={() => setPickedDateFocused(true)}
            onBlur={() => setPickedDateFocused(false)}
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              boxSizing: 'border-box', opacity: 0, border: 'none', margin: 0, padding: 0,
              cursor: 'pointer', WebkitAppearance: 'none', appearance: 'none',
            }}
          />
        </div>
        <div style={{ fontSize: 14, color: W.textCaption, marginTop: 8 }}>
          We'll check open windows up to 90 days out.
        </div>
      </div>
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

  // The API lists are engine-ordered; the glass heading claims a soonest
  // opening only from the REAL first slot (owner 2026-07-06: name the actual
  // date + city). Stale slots are skipped or the heading promises a day the
  // customer can't tap.
  const allSlots = listSlots(data);
  const firstYmd = (glass ? allSlots.find((s) => !glassSlotIsStale(s)) : allSlots[0])?.date || null;
  const firstDateLabel = firstYmd
    ? new Date(`${firstYmd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : null;
  const glassHeading = glass
    ? (firstDateLabel
      ? `Lock in your spot — openings as soon as ${firstDateLabel}${cityLabel ? ` in ${cityLabel}` : ''}`
      : glassSchedTitle(glassSchedQualifier(firstYmd)))
    : null;
  const heading = (
    <>
      <div style={{
        fontSize: 14, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
      }}>
        Schedule your visit
      </div>
      {/* Real h2 (semantics audit 2026-07-06) — was a styled div. */}
      <h2 style={{
        fontSize: 24,
        fontWeight: 500,
        color: W.blueDeeper,
        letterSpacing: 0,
        lineHeight: 1.2,
        margin: '0 0 8px',
      }}>
        {glassHeading || 'Search by date or time \u2014 no calling, no hold music, no back-and-forth'}
      </h2>
      <div style={{ fontSize: 14, color: W.textCaption, lineHeight: 1.5, marginBottom: 16 }}>
        {glass
          ? GLASS_COPY.schedExcerpt
          : 'These are the soonest open service windows we can offer. Nearby route days are marked when a tech is already close by.'}
      </div>
    </>
  );

  return (
    <div style={estimateCard()}>
      {heading}
      {glass && selectedSlot && !glassSlotIsStale(selectedSlot) ? (
        <GlassTechChip slotMeta={glassSlotMeta(selectedSlot)} licenseNumber={licenseNumber} />
      ) : glass && heldSelection && !glassSlotIsStale(heldSelection) ? (
        <GlassTechChip slotMeta={heldSelection} licenseNumber={licenseNumber} />
      ) : null}
      {search}
      {glass && !activePayload && !pickedDate && !pickedLoading ? (
        <GlassScarcityBadge info={glassScarcityInfo(allSlots, data?.metadata?.firstDayAvailability)} />
      ) : null}
      {pickedLoading ? <div style={{ fontSize: 14, color: W.textCaption, marginBottom: 12 }}>Loading times…</div> : pickedError ? (
        <div role="alert" style={{ fontSize: 16, color: W.textBody, marginBottom: 12 }}>
          We couldn’t load times for that day. Please try again.
          <button type="button" onClick={() => onPickDate(pickedDate)} style={{ ...GOLD_CTA, display: 'block', width: '100%', marginTop: 12 }}>
            Try again
          </button>
        </div>
      ) : picker}
      {dateFinder}
    </div>
  );
}
