import { useCallback, useEffect, useRef, useState } from 'react';
import SchedulePicker from '../booking/SchedulePicker';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../../constants/business';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// "Tuesday, November 3 at 9 AM" for a booked first visit ({ date, windowStart }).
export function firstVisitLabel(visit) {
  if (!visit?.date) return null;
  const day = new Date(`${visit.date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const match = /^(\d{1,2}):(\d{2})/.exec(String(visit.windowStart || ''));
  if (!match) return day;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const hour = ((h + 11) % 12) + 1;
  return `${day} at ${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

const heading = { fontSize: 26, lineHeight: 1.25, fontWeight: 600, color: W.navy, margin: '0 0 8px' };
const body = { fontSize: 16, lineHeight: 1.5, color: W.textBody, margin: 0 };

/**
 * "Pick your first visit" after a commercial agreement is signed
 * (GATE_COMMERCIAL_FIRST_VISIT). Rendered only when /data's
 * cta.commercialFirstVisit.state is 'pick'. It loads the open times from
 * POST /estimates/:token/first-visit/availability, shows them in the shared
 * SchedulePicker (the same picker every booking surface uses), and books
 * with POST /estimates/:token/first-visit. The server books the visit,
 * marks the proposal won and texts the booking confirmation.
 */
// `onBooked(visit)` runs once the visit is booked (the page reloads its data: the proposal is now accepted).
export default function CommercialFirstVisitPicker({ token, durationMinutes = null, onBooked = null }) {
  const [availability, setAvailability] = useState(null);
  const [loadState, setLoadState] = useState('loading'); // loading | ready | error
  const [callUs, setCallUs] = useState('');
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [booked, setBooked] = useState(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const res = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/first-visit/availability`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === 'already_booked') {
        setBooked(data.visit || {});
        return;
      }
      if (res.status === 409 && data.code === 'call_us' && data.error) {
        setCallUs(data.error);
        setLoadState('ready');
        return;
      }
      if (!res.ok) throw new Error('load_failed');
      setAvailability({ days: data.days || [], slots: data.slots || [] });
      setSelectedDate(null);
      setSelectedSlot(null);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const book = async () => {
    if (!selectedSlot || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/first-visit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: selectedSlot.date || selectedDate,
          time: String(selectedSlot.start_time || '').slice(0, 5),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if ((res.ok && data.booked) || (res.status === 409 && data.code === 'already_booked')) {
        setBooked(data.visit || {});
        if (onBooked) onBooked(data.visit || null);
        return;
      }
      if (res.status === 409 && data.code === 'slot_taken') {
        await load();
        setSubmitError('That time was just taken. Please pick another.');
        return;
      }
      setSubmitError(data.error || `We couldn’t book that time. Please try again, or call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
    } catch {
      setSubmitError(`We couldn’t book that time. Please try again, or call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  const callLink = (
    <a href={WAVES_SUPPORT_PHONE_TEL} style={{ color: W.blueDeeper, fontWeight: 600 }}>{WAVES_SUPPORT_PHONE_DISPLAY}</a>
  );

  if (booked) {
    const label = firstVisitLabel(booked);
    return (
      <div data-glass="card" data-testid="commercial-first-visit-booked" style={estimateCard()}>
        <h2 style={heading}>Your first visit is booked</h2>
        <p style={body}>
          {label ? <>{label}. </> : null}
          We’ll text you a confirmation. Questions? Call us at {callLink}.
        </p>
      </div>
    );
  }

  const minutes = Number(durationMinutes) > 0 ? Math.round(Number(durationMinutes)) : null;
  return (
    <div data-glass="card" data-testid="commercial-first-visit-picker" style={estimateCard()}>
      <h2 style={heading}>Pick your first visit</h2>
      <p style={{ ...body, margin: '0 0 16px' }}>
        Your agreement is signed. Choose a day and time for your first service
        {minutes ? <>. Each visit takes about {minutes} minutes.</> : '.'}
      </p>
      {loadState === 'loading' ? <p style={body}>Finding open times…</p> : null}
      {loadState === 'error' ? (
        <p role="alert" style={body}>
          We couldn’t load open times. <button type="button" onClick={load} style={{ background: 'none', border: 'none', padding: 0, color: W.blueDeeper, fontWeight: 600, fontSize: 16, cursor: 'pointer' }}>Try again</button>, or call us at {callLink}.
        </p>
      ) : null}
      {loadState === 'ready' && callUs ? <p style={body}>{callUs}</p> : null}
      {loadState === 'ready' && !callUs && availability ? (
        <SchedulePicker
          frame="inner"
          availability={availability}
          rankedSlots={availability.slots?.length ? availability.slots : null}
          selectedDate={selectedDate}
          onSelectDay={(date) => {
            setSelectedDate(date);
            setSelectedSlot(null);
            setSubmitError(null);
          }}
          selectedSlot={selectedSlot}
          onSelectSlot={(slot) => {
            setSelectedSlot(slot);
            setSubmitError(null);
          }}
          submitError={submitError}
          intro="Tap a time, then book it. Your technician arrives within a two-hour window of the start time."
          pickedAction
          pickedExtra={() => (
            <button
              type="button"
              data-glass-accent=""
              data-glass-size="primary"
              className="wpk-action-btn"
              onClick={book}
              disabled={submitting}
            >
              {submitting ? 'Booking…' : 'Book this time'}
            </button>
          )}
          empty={(
            <p style={body}>
              We don’t have an open time in the next two weeks. Call us at {callLink} and we’ll book your first visit with you.
            </p>
          )}
        />
      ) : null}
    </div>
  );
}
