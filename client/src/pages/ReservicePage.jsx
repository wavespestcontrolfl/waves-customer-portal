/**
 * Public self-serve re-service page — /reservice/:token.
 *
 * The standing customer link (customers.reservice_token) an active recurring /
 * WaveGuard customer uses to book their FREE between-visit re-service callback
 * (pest and/or lawn) themselves. Shared by text from the office / comms
 * composer and linked from the portal's schedule tab.
 *
 * Token-gated (no login), mirroring ReschedulePage's model: fetch
 * GET /api/public/reservice/:token, render by state, and commit the chosen
 * lane + slot with POST. Slots come from the same route-aware availability
 * engine the reschedule page uses, so "Tech nearby" days are the ones that
 * fit our existing routes around the customer's address.
 *
 * Tie-in with the rescheduler both ways:
 *   - a lane that already has an open callback renders that visit's
 *     /reschedule link instead of double-booking a second free visit;
 *   - the success card hands back the NEW visit's /reschedule link.
 *
 * Styling follows the customer-facing brand idiom used by ReschedulePage
 * (WavesShell customer variant + warm surface palette + inline styles).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { WavesShell } from '../components/brand';
import BrandFooter from '../components/BrandFooter';
import { useGlassSurface } from '../glass/glass-engine';
import WavesAIScheduleSearch from '../components/booking/WavesAIScheduleSearch';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const S = {
  surface: '#FFFFFF',
  page: '#FAF8F3',
  border: '#E7E2D7',
  soft: '#F8FCFE',
  softBorder: '#CFE7F5',
  text: '#04395E',
  body: '#3F4A65',
  muted: CUSTOMER_SURFACE.muted,
};

const PRIMARY_CTA = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  minHeight: 48,
  padding: '0 20px',
  background: COLORS.glassNavy,
  color: COLORS.white,
  border: `1px solid ${COLORS.glassNavy}`,
  borderRadius: 8,
  fontFamily: FONTS.ui,
  fontWeight: 800,
  fontSize: 15,
  cursor: 'pointer',
  textDecoration: 'none',
};

function Page({ children }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 640, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: S.text }}>
        {children}
        <BrandFooter />
      </div>
    </WavesShell>
  );
}

function Card({ children, style, ...rest }) {
  return (
    <div data-glass="card" {...rest} style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 12, padding: 24, marginBottom: 16, ...style }}>
      {children}
    </div>
  );
}

function ContactRow() {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
      <a href={WAVES_SUPPORT_SMS_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Text Waves</a>
      <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Call Waves</a>
    </div>
  );
}

function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

function formatTimeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

// The arrival window promised to the customer is 2 HOURS from the visit's
// start (owner rule — same constant ReschedulePage and the reminders quote).
const ARRIVAL_WINDOW_MINUTES = 120;

function arrivalEndHHMM(start) {
  const [h, m] = String(start || '').split(':').map(Number);
  if (Number.isNaN(h)) return null;
  const total = (h * 60 + (m || 0) + ARRIVAL_WINDOW_MINUTES) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function arrivalWindowLabel(start) {
  const s = formatTimeLabel(start);
  if (!s) return '';
  const e = formatTimeLabel(arrivalEndHHMM(start));
  return e ? `${s}–${e}` : s;
}

function SkeletonCard() {
  return (
    <Card>
      <div style={{ height: 18, width: '55%', background: S.page, borderRadius: 6, marginBottom: 12 }} />
      <div style={{ height: 14, width: '80%', background: S.page, borderRadius: 6, marginBottom: 8 }} />
      <div style={{ height: 14, width: '65%', background: S.page, borderRadius: 6 }} />
    </Card>
  );
}

function NotFoundCard() {
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        We couldn't find that link
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        This link may have expired. Text or call us and we'll get your re-service scheduled.
      </div>
      <ContactRow />
    </Card>
  );
}

function LoadErrorCard({ onRetry }) {
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        We couldn't load your re-service options
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        This looks temporary. Your link is still valid—try again in a moment.
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{ marginTop: 16, border: 0, borderRadius: 8, padding: '11px 16px', background: COLORS.glassNavy, color: '#fff', font: 'inherit', fontWeight: 800, cursor: 'pointer' }}
      >
        Try again
      </button>
    </Card>
  );
}

function NotEligibleCard({ data }) {
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        {data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}let's get you taken care of
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        Free re-service visits come with an active recurring plan, and we don't
        show one on your account right now. Text or call us and we'll figure
        out the fastest way to help.
      </div>
      <ContactRow />
    </Card>
  );
}

// A lane that already has an open callback: show the visit and hand over its
// reschedule link — the tie-in that replaces double-booking.
function AlreadyBookedCard({ lane, standalone }) {
  const booked = lane.alreadyBooked || {};
  return (
    <Card style={standalone ? undefined : { background: S.soft, border: `1px solid ${S.softBorder}` }}>
      <div data-glass="chip" style={{
        display: 'inline-block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        color: COLORS.green, background: '#DCFCE7', padding: '6px 12px', borderRadius: 9999, marginBottom: 10,
      }}>
        Already booked
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.6 }}>
        Your <strong style={{ color: S.text }}>{booked.serviceType || lane.label}</strong> visit is
        set for <strong style={{ color: S.text }}>{formatDateLabel(booked.date)}</strong>
        {booked.windowStart ? <>, arrival window <strong style={{ color: S.text }}>{arrivalWindowLabel(booked.windowStart)}</strong></> : null}.
        {' '}No need to book another — one free re-service at a time keeps your tech focused on fixing it.
      </div>
      {booked.rescheduleUrl ? (
        <a href={booked.rescheduleUrl} data-glass-accent="" style={{ ...PRIMARY_CTA, marginTop: 14 }}>
          Need a different time? Move that visit
        </a>
      ) : null}
    </Card>
  );
}

function SlotButton({ slot, selected, onSelect }) {
  return (
    <button
      type="button"
      {...(selected ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })}
      onClick={() => onSelect(slot)}
      style={{
        textAlign: 'left',
        background: selected ? COLORS.glassNavy : S.surface,
        color: selected ? COLORS.white : S.text,
        border: `2px solid ${selected ? COLORS.glassNavy : S.border}`,
        borderRadius: 10,
        padding: '10px 14px',
        cursor: 'pointer',
        fontFamily: FONT_BODY,
        fontSize: 15,
        fontWeight: 700,
      }}
    >
      {slot.start_label}
    </button>
  );
}

function DayGroup({ day, selectedSlot, onSelect }) {
  // Rain chip (GATE_BOOKING_RAIN_CHIPS): same decoration contract as
  // ReschedulePage — field absent means nothing renders.
  const rain = Number.isFinite(day.rainChance) ? day.rainChance : day.slots?.[0]?.rainChance;
  const showRain = Number.isFinite(rain) && rain >= 40;
  const heavyRain = showRain && rain >= 50;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: FONTS.heading }}>{day.fullDate}</div>
        {day.nearby ? (
          <span data-glass="chip" style={{
            fontSize: 12, fontWeight: 700, color: COLORS.green,
            background: '#DCFCE7', padding: '2px 8px', borderRadius: 999,
          }}>
            Tech nearby
          </span>
        ) : null}
        {showRain ? (
          <span data-glass="chip" style={{
            fontSize: 12, fontWeight: 700,
            color: heavyRain ? '#9A3412' : '#B45309',
            background: heavyRain ? '#FFEDD5' : '#FFF7ED',
            padding: '2px 8px', borderRadius: 999,
          }}>
            {Math.round(rain)}% rain
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
        {day.slots.map((slot) => (
          <SlotButton
            key={`${day.date}|${slot.start_time}`}
            slot={slot}
            selected={selectedSlot && selectedSlot.date === day.date && selectedSlot.start_time === slot.start_time}
            onSelect={(s) => onSelect({ ...s, date: day.date, fullDate: day.fullDate })}
          />
        ))}
      </div>
    </div>
  );
}

function SuccessCard({ result }) {
  return (
    <Card>
      <div data-glass="chip" style={{
        display: 'inline-block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        color: COLORS.green, background: '#DCFCE7', padding: '6px 12px', borderRadius: 9999, marginBottom: 12,
      }}>
        Booked — no charge
      </div>
      <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        You're all set
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.6 }}>
        Your free <strong style={{ color: S.text }}>{result.serviceType || 're-service'}</strong> visit is
        scheduled for <strong style={{ color: S.text }}>{formatDateLabel(result.date)}</strong>, arrival window{' '}
        <strong style={{ color: S.text }}>{arrivalWindowLabel(result.window?.start) || result.startLabel}</strong>.
        {' '}We'll text you a confirmation shortly.
      </div>
      {result.rescheduleUrl ? (
        <a href={result.rescheduleUrl} data-glass-accent="" style={{ ...PRIMARY_CTA, marginTop: 16 }}>
          Need a different time? Reschedule it
        </a>
      ) : null}
    </Card>
  );
}

export default function ReservicePage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedLane, setSelectedLane] = useState(null);
  const [details, setDetails] = useState('');
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);
  const [aiFiltered, setAiFiltered] = useState(false);
  // Keys the search bar so its recap clears with the filter (same trick
  // ReschedulePage uses).
  const [aiSession, setAiSession] = useState(0);

  const loadAbortRef = useRef(null);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setNotFound(false);
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/public/reservice/${token}`, { signal: controller.signal });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error('load failed');
      const body = await res.json();
      if (controller.signal.aborted) return;
      setData(body);
    } catch {
      if (controller.signal.aborted) return;
      setLoadError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  // Keep the lane selection valid whenever eligibility changes: a single
  // bookable lane auto-selects (most customers hold one plan family).
  useEffect(() => {
    const bookable = (data?.lanes || []).filter((l) => !l.alreadyBooked);
    setSelectedLane((prev) => {
      if (bookable.some((l) => l.key === prev)) return prev;
      return bookable.length === 1 ? bookable[0].key : null;
    });
  }, [data]);

  const runAiSearch = async (query) => {
    const res = await fetch(`${API_BASE}/public/reservice/${token}/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'search failed');
    if (body.availability) {
      setData((prev) => (prev ? { ...prev, availability: body.availability } : prev));
      setSelectedSlot(null);
      setSubmitError(null);
      setAiFiltered(true);
    }
    return { summary: body.summary };
  };

  const showAllTimes = async () => {
    setSelectedSlot(null);
    try {
      const res = await fetch(`${API_BASE}/public/reservice/${token}`);
      if (!res.ok) return;
      setData(await res.json());
      setAiFiltered(false);
      setAiSession((n) => n + 1);
    } catch { /* keep the filtered list */ }
  };

  const confirm = async () => {
    if (!selectedSlot || !selectedLane || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/public/reservice/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lane: selectedLane,
          date: selectedSlot.date,
          start_time: selectedSlot.start_time,
          details: details.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setResult(body);
        return;
      }
      if (body.code === 'SLOT_TAKEN') {
        setSelectedSlot(null);
        setAiFiltered(false);
        setAiSession((n) => n + 1);
        if (body.availability) {
          setData((prev) => (prev ? { ...prev, availability: body.availability } : prev));
        } else {
          await load();
        }
        setSubmitError('That time was just taken — here are the latest open times.');
        return;
      }
      if (body.code === 'ALREADY_BOOKED' || body.code === 'NOT_ELIGIBLE') {
        // Plan state changed under us (office booked one, plan lapsed) —
        // reload so the page re-renders the truthful state.
        setSelectedSlot(null);
        await load();
        setSubmitError(body.error || 'Your re-service options just updated — here is the latest.');
        return;
      }
      setSubmitError(body.error || 'Something went wrong. Please try again, or text us and we\'ll help.');
    } catch {
      setSubmitError('Something went wrong. Please try again, or text us and we\'ll help.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Page><SkeletonCard /></Page>;
  if (notFound) return <Page><NotFoundCard /></Page>;
  if (loadError) return <Page><LoadErrorCard onRetry={load} /></Page>;
  if (result) return <Page><SuccessCard result={result} /></Page>;
  if (data?.state === 'not_eligible') return <Page><NotEligibleCard data={data} /></Page>;
  if (data?.state === 'already_booked') {
    return (
      <Page>
        <Card>
          <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
            {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}you're covered
          </div>
          <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
            We already have your free re-service on the calendar.
          </div>
        </Card>
        {(data.lanes || []).filter((l) => l.alreadyBooked).map((lane) => (
          <AlreadyBookedCard key={lane.key} lane={lane} standalone />
        ))}
        <Card data-glass="soft" style={{ background: S.page }}>
          <div style={{ fontSize: 14, color: S.body, lineHeight: 1.55 }}>
            Something new going on? Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will help.
          </div>
          <ContactRow />
        </Card>
      </Page>
    );
  }

  const days = data?.availability?.days || [];
  const lanes = data?.lanes || [];
  const bookableLanes = lanes.filter((l) => !l.alreadyBooked);
  const blockedLanes = lanes.filter((l) => l.alreadyBooked);

  return (
    <Page>
      <Card>
        <div data-glass="chip" style={{
          display: 'inline-block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
          color: COLORS.green, background: '#DCFCE7', padding: '6px 12px', borderRadius: 9999, marginBottom: 12,
        }}>
          Free with your plan
        </div>
        <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 6 }}>
          {data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}pests back between visits?
        </div>
        <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
          Breakthrough activity between regular visits is covered — pick a time
          below and we'll send a tech back out at <strong style={{ color: S.text }}>no charge</strong>.
        </div>

        {bookableLanes.length > 1 ? (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>What needs another look?</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {bookableLanes.map((lane) => {
                const active = selectedLane === lane.key;
                return (
                  <button
                    key={lane.key}
                    type="button"
                    {...(active ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })}
                    onClick={() => setSelectedLane(lane.key)}
                    style={{
                      background: active ? COLORS.glassNavy : S.surface,
                      color: active ? COLORS.white : S.text,
                      border: `2px solid ${active ? COLORS.glassNavy : S.border}`,
                      borderRadius: 999,
                      padding: '9px 16px',
                      cursor: 'pointer',
                      fontFamily: FONT_BODY,
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    {lane.key === 'lawn' ? 'My lawn' : 'Pests inside or out'}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 14 }}>
          <label htmlFor="reservice-details" style={{ display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
            What are you seeing? <span style={{ fontWeight: 500, color: S.muted }}>(optional — helps your tech prep)</span>
          </label>
          <textarea
            id="reservice-details"
            name="reservice_details"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={400}
            rows={2}
            placeholder="e.g. Ants are back along the kitchen window"
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              border: `1px solid ${S.border}`, borderRadius: 8, padding: '10px 12px',
              font: 'inherit', fontSize: 14, color: S.text, background: S.surface,
            }}
          />
        </div>
      </Card>

      {blockedLanes.map((lane) => (
        <AlreadyBookedCard key={lane.key} lane={lane} />
      ))}

      <Card>
        <div style={{ fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 4 }}>
          Open times
        </div>
        <div style={{ fontSize: 14, color: S.muted, marginBottom: 16 }}>
          Tap a time, then confirm. Your technician arrives within a two-hour window of the start time.
        </div>

        <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
          <WavesAIScheduleSearch
            key={aiSession}
            theme={{ accent: COLORS.glassNavy, accentText: COLORS.white, text: S.text, muted: S.muted, border: S.softBorder, surface: S.surface, inputBg: S.soft }}
            onSearch={runAiSearch}
          />
          {aiFiltered ? (
            <button
              type="button"
              onClick={showAllTimes}
              style={{
                justifySelf: 'start', background: 'transparent', border: 'none', padding: 0,
                color: COLORS.glassNavy, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Show all open times
            </button>
          ) : null}
        </div>

        {submitError ? (
          <div style={{
            background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
            padding: '10px 12px', fontSize: 14, color: '#9A3412', marginBottom: 14, lineHeight: 1.45,
          }}>
            {submitError}
          </div>
        ) : null}

        {days.length === 0 ? (
          <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
            {aiFiltered
              ? 'No open times match that search — try another day, or show all open times above.'
              : "We don't have open times to offer online right now. Text or call us and we'll fit you in."}
            {aiFiltered ? null : <ContactRow />}
          </div>
        ) : (
          <>
            {days.map((day) => (
              <DayGroup key={day.date} day={day} selectedSlot={selectedSlot} onSelect={setSelectedSlot} />
            ))}
            <button
              type="button"
              data-glass-accent=""
              onClick={confirm}
              disabled={!selectedSlot || !selectedLane || submitting}
              style={{
                ...PRIMARY_CTA,
                marginTop: 6,
                opacity: !selectedSlot || !selectedLane || submitting ? 0.5 : 1,
                cursor: !selectedSlot || !selectedLane || submitting ? 'default' : 'pointer',
              }}
            >
              {submitting
                ? 'Booking your visit…'
                : !selectedLane
                  ? 'Pick what needs another look above'
                  : selectedSlot
                    ? `Book ${selectedSlot.fullDate}, ${selectedSlot.start_label} — free`
                    : 'Pick a time above'}
            </button>
          </>
        )}
      </Card>

      <Card data-glass="soft" style={{ background: S.page }}>
        <div style={{ fontSize: 14, color: S.body, lineHeight: 1.55 }}>
          Don't see a time that works? Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will fit you in.
        </div>
        <ContactRow />
      </Card>
    </Page>
  );
}
