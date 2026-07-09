/**
 * Public self-serve reschedule page — /reschedule/:token.
 *
 * Linked from the appointment confirmation / 72h / 24h reminder texts and
 * reminder emails. Token-gated (no login), mirroring TrackPage's model:
 * fetch GET /api/public/reschedule/:token, render by state, and commit the
 * chosen slot with POST. Single visit only — a recurring plan's other
 * visits never move from here (the page says so when the visit is part of
 * a recurring plan).
 *
 * Styling follows the customer-facing brand idiom used by TrackPage
 * (WavesShell customer variant + warm surface palette + inline styles).
 * The page mounts the glass scene (now the unconditional theme) and its
 * native data-glass markup restyles the cards — the inline styles below
 * remain the base non-glass rendering.
 */
import { useCallback, useEffect, useState } from 'react';
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
  text: '#1B2C5B',
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
  background: COLORS.blueDeeper,
  color: COLORS.white,
  border: `1px solid ${COLORS.blueDeeper}`,
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
      <a href={WAVES_SUPPORT_SMS_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Text us</a>
      <a
        href={WAVES_SUPPORT_PHONE_TEL}
        data-glass="chip"
        style={{ ...PRIMARY_CTA, flex: 1, background: S.surface, color: COLORS.blueDeeper, border: `1px solid ${COLORS.blueDeeper}` }}
      >
        Call {WAVES_SUPPORT_PHONE_DISPLAY}
      </a>
    </div>
  );
}

// current.date is 'YYYY-MM-DD'; windows are 'HH:MM'. Format in place so the
// customer sees the appointment exactly as scheduled (ET wall-clock values).
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
// window start (owner directive; matches the estimate SlotPicker and the
// window_start + 2h promise the late detector enforces). The API's
// windowStart/windowEnd echo the job-duration block that sizes scheduling —
// never show windowEnd as the arrival window.
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
        We couldn't find that appointment
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        This link may have expired. Text or call us and we'll get you scheduled.
      </div>
      <ContactRow />
    </Card>
  );
}

const INELIGIBLE_COPY = {
  completed: 'This visit is already complete, so there is nothing to reschedule.',
  cancelled: 'This appointment was cancelled. Text or call us and we\'ll get you back on the calendar.',
  in_progress: 'Your technician is already on the way for this visit, so it can\'t be moved online.',
  past: 'This visit\'s scheduled time has passed, so it can\'t be moved online.',
  not_available: 'This appointment can\'t be rescheduled online.',
};

function IneligibleCard({ data }) {
  const reasonCopy = INELIGIBLE_COPY[data?.reason] || INELIGIBLE_COPY.not_available;
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        {data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}we can't move this one online
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        {reasonCopy} Need a hand? Text or call and our team will help.
      </div>
      <ContactRow />
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
        background: selected ? COLORS.blueDeeper : S.surface,
        color: selected ? COLORS.white : S.text,
        border: `2px solid ${selected ? COLORS.blueDeeper : S.border}`,
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

function SuccessCard({ result, service }) {
  return (
    <Card>
      <div data-glass="chip" style={{
        display: 'inline-block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        color: COLORS.green, background: '#DCFCE7', padding: '6px 12px', borderRadius: 9999, marginBottom: 12,
      }}>
        Rescheduled
      </div>
      <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        You're all set
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.6 }}>
        Your {service?.type || 'service'} visit is now scheduled for{' '}
        <strong style={{ color: S.text }}>{formatDateLabel(result.newDate)}</strong>, arrival window{' '}
        <strong style={{ color: S.text }}>{arrivalWindowLabel(result.window?.start) || result.startLabel}</strong>.
        We'll text you a confirmation shortly.
      </div>
    </Card>
  );
}

export default function ReschedulePage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);
  // True while the day list shows an AI search's results instead of the full
  // window — gates the "Show all open times" reset.
  const [aiFiltered, setAiFiltered] = useState(false);
  // Bumped on a successful reset; keys the search bar so its internal
  // query/summary recap clears with the filter — a stale "Two openings
  // Tuesday afternoon" line must not sit above the unfiltered day list.
  const [aiSession, setAiSession] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const res = await fetch(`${API_BASE}/public/reschedule/${token}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error('load failed');
      setData(await res.json());
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Waves AI date/time search — replaces the day list with the matching
  // window's slots (same availability shape the GET returns) and hands the
  // summary line back to the bar. Throwing lets the bar show its own
  // call-us fallback line.
  const runAiSearch = async (query) => {
    const res = await fetch(`${API_BASE}/public/reschedule/${token}/find-slots`, {
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

  // Back to the full window after a search — quiet refetch (no skeleton
  // flash) so the list is fresh. aiFiltered only clears once the full-window
  // response is applied: on failure the filtered list is still what's on
  // screen, so the reset link must survive for another try.
  const showAllTimes = async () => {
    setSelectedSlot(null);
    try {
      const res = await fetch(`${API_BASE}/public/reschedule/${token}`);
      if (!res.ok) return;
      setData(await res.json());
      setAiFiltered(false);
      setAiSession((n) => n + 1); // remount the bar → clears its recap/query
    } catch { /* keep the filtered list + reset link */ }
  };

  const confirm = async () => {
    if (!selectedSlot || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/public/reschedule/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: selectedSlot.date,
          start_time: selectedSlot.start_time,
          end_time: selectedSlot.end_time,
          technician_id: selectedSlot.technician_id || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setResult(body);
        return;
      }
      if (body.code === 'SLOT_TAKEN') {
        setSelectedSlot(null);
        setAiFiltered(false); // refreshed availability spans the full window
        setAiSession((n) => n + 1); // remount the bar — its recap is stale too
        if (body.availability) {
          setData((prev) => (prev ? { ...prev, availability: body.availability } : prev));
        } else {
          await load();
        }
        setSubmitError('That time was just taken — here are the latest open times.');
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
  if (result) return <Page><SuccessCard result={result} service={data?.service} /></Page>;
  if (data?.state !== 'reschedulable') return <Page><IneligibleCard data={data} /></Page>;

  const days = data?.availability?.days || [];
  const current = data?.current || {};

  return (
    <Page>
      <Card>
        <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 6 }}>
          {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}pick a new time
        </div>
        <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
          Your <strong style={{ color: S.text }}>{data.service?.type || 'service'}</strong> visit is currently
          scheduled for <strong style={{ color: S.text }}>{formatDateLabel(current.date)}</strong>
          {current.windowStart ? <>, arrival window <strong style={{ color: S.text }}>{arrivalWindowLabel(current.windowStart)}</strong></> : null}.
        </div>
        {data.isRecurring ? (
          <div data-glass="soft" style={{
            marginTop: 12, background: S.soft, border: `1px solid ${S.softBorder}`,
            borderRadius: 8, padding: '10px 12px', fontSize: 14, color: S.body, lineHeight: 1.5,
          }}>
            Only this visit will move — the rest of your regular service schedule stays the same.
          </div>
        ) : null}
      </Card>

      <Card>
        <div style={{ fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 4 }}>
          Open times
        </div>
        <div style={{ fontSize: 14, color: S.muted, marginBottom: 16 }}>
          Tap a time, then confirm. Your technician arrives within the window shown.
        </div>

        <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
          <WavesAIScheduleSearch
            key={aiSession}
            theme={{ accent: COLORS.blueDeeper, accentText: COLORS.white, text: S.text, muted: S.muted, border: S.softBorder, surface: S.surface, inputBg: S.soft }}
            onSearch={runAiSearch}
          />
          {aiFiltered ? (
            <button
              type="button"
              onClick={showAllTimes}
              style={{
                justifySelf: 'start', background: 'transparent', border: 'none', padding: 0,
                color: COLORS.blueDeeper, fontSize: 14, fontWeight: 700, cursor: 'pointer',
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
              : "We don't have open times to offer online right now. Text or call us and we'll find a time that works."}
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
              disabled={!selectedSlot || submitting}
              style={{
                ...PRIMARY_CTA,
                marginTop: 6,
                opacity: !selectedSlot || submitting ? 0.5 : 1,
                cursor: !selectedSlot || submitting ? 'default' : 'pointer',
              }}
            >
              {submitting
                ? 'Moving your visit…'
                : selectedSlot
                  ? `Move to ${selectedSlot.fullDate}, ${selectedSlot.start_label}`
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
