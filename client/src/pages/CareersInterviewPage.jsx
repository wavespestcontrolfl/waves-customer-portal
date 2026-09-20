/**
 * <CareersInterviewPage> — /careers/interview/:token
 *
 * Public, token-gated self-scheduling page. An applicant moved to the
 * "interview" stage gets this link by text + email (recruiting-comms PR 1)
 * and uses it to pick a phone or in-person interview time, or to withdraw
 * their application. The same link re-opens after booking so the applicant
 * can change the time.
 *
 * Modeled on RatePage.jsx: WavesShell wraps this page at the route (App.jsx),
 * not here. Terminal states go through PublicStateCard / PublicLoadError so
 * this page carries no hand-rolled not-found/error card of its own.
 *
 * Dates/times are never re-derived client-side — every label shown comes
 * from the API's own `label` (and `date` for grouping), already formatted
 * ET wall-clock server-side (server/utils/datetime-et.js). This page never
 * calls toISOString() to build a displayed date or time.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import {
  CustomerColumn,
  BrandCard,
  BrandButton,
  PublicStateCard,
  HelpPhoneLink,
} from '../components/brand';
import PublicLoadError from '../components/PublicLoadError';
import { useGlassSurface } from '../glass/glass-engine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const TEXT = COLORS.glassNavy;
const MUTED = COLORS.textCaption;

const EYEBROW = {
  fontFamily: FONTS.ui,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: MUTED,
  marginBottom: 6,
};

const H1_STYLE = {
  margin: '0 0 6px',
  fontFamily: FONTS.heading,
  fontSize: 24,
  fontWeight: 700,
  color: TEXT,
  lineHeight: 1.2,
};

const BODY_STYLE = {
  margin: 0,
  fontFamily: FONTS.body,
  fontSize: 16,
  lineHeight: 1.55,
  color: 'var(--text-subtle, #475569)',
};

const DAY_HEADER_STYLE = {
  fontFamily: FONTS.ui,
  fontSize: 14,
  fontWeight: 700,
  color: TEXT,
  margin: '0 0 8px',
};

function modeCardStyle(selected) {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    minHeight: 44,
    padding: '14px 16px',
    border: `1px solid ${selected ? 'var(--brand, #04395E)' : 'var(--border-strong, #C7D7E2)'}`,
    borderRadius: 'var(--radius-md, 10px)',
    background: selected ? 'var(--brand-soft, #E3F5FD)' : 'var(--surface, #FFFFFF)',
    cursor: 'pointer',
    boxSizing: 'border-box',
  };
}

function slotButtonStyle(selected) {
  return {
    minHeight: 44,
    minWidth: 44,
    padding: '0 14px',
    border: `1px solid ${selected ? 'var(--brand, #04395E)' : 'var(--border-strong, #C7D7E2)'}`,
    borderRadius: 'var(--radius-md, 10px)',
    background: selected ? 'var(--brand, #04395E)' : 'var(--surface, #FFFFFF)',
    color: selected ? '#FFFFFF' : TEXT,
    fontFamily: FONTS.ui,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  };
}

const ERROR_BANNER_STYLE = {
  marginTop: 14,
  padding: '10px 12px',
  border: '1px solid #FECACA',
  background: '#FEF2F2',
  color: '#991B1B',
  borderRadius: 'var(--radius-md, 10px)',
  fontSize: 14,
  lineHeight: 1.5,
};

const LOW_EMPHASIS_LINK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '0 4px',
  border: 'none',
  background: 'transparent',
  color: MUTED,
  fontFamily: FONTS.ui,
  fontSize: 14,
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
};

const MODE_LABELS = {
  phone: 'Phone call',
  in_person: 'In person',
};

// slot.label from the API looks like "Tue Sep 22, 4:30 PM" — split it once
// for the day-group header and the per-slot button text. Never recomputed
// from slot.start with Date/toISOString.
function splitSlotLabel(label) {
  const parts = String(label || '').split(', ');
  return { dayLabel: parts[0] || label || '', timeLabel: parts[1] || label || '' };
}

function groupSlotsByDay(slots) {
  const order = [];
  const byDate = new Map();
  for (const slot of slots || []) {
    const key = slot.date || slot.start;
    if (!byDate.has(key)) {
      byDate.set(key, []);
      order.push(key);
    }
    byDate.get(key).push(slot);
  }
  return order.map((key) => {
    const daySlots = byDate.get(key);
    const { dayLabel } = splitSlotLabel(daySlots[0]?.label);
    return {
      date: key,
      dayLabel,
      slots: daySlots.map((slot) => ({ ...slot, timeLabel: splitSlotLabel(slot.label).timeLabel })),
    };
  });
}

function modeLine(mode, inPersonAddress) {
  if (mode === 'in_person') return `See you at ${inPersonAddress}`;
  return "We'll call you at this number";
}

// Full-page "still loading" card. Stateless — no reason for the applicant
// data or callbacks to reach this far.
function InterviewLoadingState() {
  return (
    <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
      <BrandCard padding={28}>
        <div style={{ padding: '40px 20px', textAlign: 'center', color: MUTED, fontSize: 16 }}>
          Loading…
        </div>
      </BrandCard>
    </CustomerColumn>
  );
}

// Full-page terminal states: a dead link, a load that failed and can be
// retried, or a completed withdrawal. Each ends the applicant's session on
// this page, so they share one component rather than three near-duplicate
// early returns in the page body.
function InterviewTerminalState({ kind, onRetry }) {
  if (kind === 'notfound') {
    return (
      <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
        <PublicStateCard state="not-found" title="This interview link is no longer active" contact="none">
          It may have already been used, or your application has moved on. Give us a call and we can
          help — <HelpPhoneLink tone="dark" inline />.
        </PublicStateCard>
      </CustomerColumn>
    );
  }
  if (kind === 'withdrawn') {
    return (
      <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
        <PublicStateCard state="withdrawn" title="Thanks for letting us know" contact="none">
          We&rsquo;ve closed out your application. If you change your mind, reach out any time —{' '}
          <HelpPhoneLink tone="dark" inline />.
        </PublicStateCard>
      </CustomerColumn>
    );
  }
  return (
    <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
      <PublicLoadError resource="interview link" onRetry={onRetry} />
    </CustomerColumn>
  );
}

// Booking flow: pick a mode + time and confirm, or review/change an existing
// booking. Owns its own in-progress state (changingTime/mode/selectedSlot/
// booking/bookError) — none of it is needed outside this panel, so it lives
// here instead of being threaded down from the page.
function InterviewBookingPanel({ token, data, onDataChange, onInactiveLink }) {
  const [changingTime, setChangingTime] = useState(false);
  const [mode, setMode] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState('');

  const groups = useMemo(() => groupSlotsByDay(data?.slots), [data?.slots]);

  // Quiet re-fetch after a slot turns out to be taken — refreshes the slot
  // list without dropping the applicant into the full-page loading state.
  const refreshSlots = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}`);
      if (!res.ok) return;
      const body = await res.json();
      onDataChange(body);
    } catch {
      // best-effort; the inline error already told them to pick again
    }
  }, [token, onDataChange]);

  const startChangeTime = () => {
    setChangingTime(true);
    setMode(data?.booked?.mode || null);
    setSelectedSlot(null);
    setBookError('');
  };

  const confirmBooking = async () => {
    if (!mode || !selectedSlot || booking) return;
    setBooking(true);
    setBookError('');
    try {
      const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, start: selectedSlot.start }),
      });
      const body = await res.json().catch(() => ({}));
      // 409 = the link itself is dead (token/status mismatch under the row
      // lock). 404 = the application left the Interview stage entirely
      // (withdrawn, advanced, etc. — route.param already 404s a malformed
      // token before any handler runs, so a 404 here is always the same
      // "not this stage any more" case). Both are the same inactive-link
      // terminal state to the applicant (Codex P2); any other non-OK status
      // is an ordinary slot conflict, handled below.
      if (res.status === 409 || res.status === 404) {
        onInactiveLink();
        return;
      }
      if (!res.ok) {
        // The chosen slot is gone (someone else took it, or the window
        // rolled) — clear it BEFORE refreshing so the vanished time never
        // renders as still-picked with Confirm enabled (local audit P2).
        setSelectedSlot(null);
        setBookError(body.error || 'That time is no longer available. Pick another time below.');
        refreshSlots();
        return;
      }
      onDataChange(body);
      setChangingTime(false);
      setSelectedSlot(null);
    } catch {
      setBookError('Could not book that time. Check your connection and try again.');
    } finally {
      setBooking(false);
    }
  };

  const showBooked = Boolean(data.booked) && !changingTime;

  if (showBooked) {
    return (
      <BrandCard padding={24}>
        <div style={EYEBROW}>You&rsquo;re booked</div>
        <p style={BODY_STYLE}>
          {modeLine(data.booked.mode, data.in_person_address)} on <strong>{data.booked.label}</strong>.
        </p>
        {data.booked.mode === 'in_person' && (
          <p style={{ ...BODY_STYLE, marginTop: 6 }}>{data.in_person_address}</p>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <BrandButton variant="secondary" onClick={startChangeTime}>
            Change time
          </BrandButton>
        </div>
      </BrandCard>
    );
  }

  return (
    <BrandCard padding={24}>
      <p style={BODY_STYLE}>Pick whichever works best for you. You can always come back to this link to change it.</p>

      {changingTime && data.booked && (
        <button
          type="button"
          style={{ ...LOW_EMPHASIS_LINK_STYLE, marginTop: 6, padding: '0' }}
          onClick={() => {
            setChangingTime(false);
            setBookError('');
          }}
        >
          Back to my booked time
        </button>
      )}

      <fieldset style={{ border: 'none', padding: 0, margin: '18px 0 0' }}>
        <legend style={EYEBROW}>How would you like to interview?</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {(data.mode_options || []).map((opt) => (
            <label key={opt} style={modeCardStyle(mode === opt)}>
              <input
                type="radio"
                name="interview-mode"
                value={opt}
                checked={mode === opt}
                onChange={() => {
                  setMode(opt);
                  setBookError('');
                }}
                style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--brand, #04395E)' }}
              />
              <span style={{ fontFamily: FONTS.ui, fontSize: 14, color: TEXT, lineHeight: 1.4 }}>
                {opt === 'in_person'
                  ? `In person — ${data.in_person_address}`
                  : MODE_LABELS[opt] || opt}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div style={{ marginTop: 20 }}>
        <div style={EYEBROW}>Pick a time</div>
        {groups.length === 0 ? (
          <p style={BODY_STYLE}>
            No times are open right now. Give us a call and we&rsquo;ll find a time together —{' '}
            <HelpPhoneLink tone="dark" inline />.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.date} style={{ marginBottom: 16 }}>
              <div style={DAY_HEADER_STYLE}>{group.dayLabel}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} role="group" aria-label={`Times for ${group.dayLabel}`}>
                {group.slots.map((slot) => (
                  <button
                    key={slot.start}
                    type="button"
                    aria-pressed={selectedSlot?.start === slot.start}
                    style={slotButtonStyle(selectedSlot?.start === slot.start)}
                    onClick={() => {
                      setSelectedSlot(slot);
                      setBookError('');
                    }}
                  >
                    {slot.timeLabel}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {selectedSlot && mode && (
        <div
          style={{
            marginTop: 4,
            padding: '10px 12px',
            background: 'var(--brand-soft, #E3F5FD)',
            border: '1px solid var(--border-strong, #C7D7E2)',
            borderRadius: 'var(--radius-md, 10px)',
            fontSize: 14,
            color: TEXT,
          }}
        >
          You picked {mode === 'phone' ? 'a phone call' : 'an in-person visit'} on {selectedSlot.label}.
        </div>
      )}

      {bookError && <div style={ERROR_BANNER_STYLE} role="alert">{bookError}</div>}

      <BrandButton
        fullWidth
        disabled={!mode || !selectedSlot || booking}
        onClick={confirmBooking}
        style={{ marginTop: 16 }}
      >
        {booking ? 'Booking…' : 'Confirm interview time'}
      </BrandButton>
    </BrandCard>
  );
}

// Withdrawal control: a low-emphasis link that expands into a confirm step.
// Owns its own confirming/submitting state and the withdraw POST — the page
// only needs to know when it succeeds (to show the terminal state) or hits
// an inactive link (409/404, same as the booking panel's handling).
function WithdrawalControl({ token, onWithdrawn, onInactiveLink }) {
  const [withdrawStep, setWithdrawStep] = useState('idle'); // idle | confirming | submitting
  const [withdrawError, setWithdrawError] = useState('');

  const confirmWithdraw = async () => {
    setWithdrawStep('submitting');
    setWithdrawError('');
    try {
      const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}/withdraw`, {
        method: 'POST',
      });
      if (res.status === 404) {
        onInactiveLink();
        return;
      }
      if (!res.ok) throw new Error('failed');
      onWithdrawn();
    } catch {
      setWithdrawError('Could not process that. Check your connection and try again.');
      setWithdrawStep('confirming');
    }
  };

  return (
    <div style={{ marginTop: 20, paddingTop: 4 }}>
      {withdrawStep === 'idle' ? (
        <button type="button" style={LOW_EMPHASIS_LINK_STYLE} onClick={() => setWithdrawStep('confirming')}>
          I&rsquo;m no longer interested
        </button>
      ) : (
        <div role="alert">
          <p style={BODY_STYLE}>Are you sure? This will withdraw your application.</p>
          {withdrawError && <div style={ERROR_BANNER_STYLE}>{withdrawError}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <BrandButton
              variant="secondary"
              disabled={withdrawStep === 'submitting'}
              onClick={() => setWithdrawStep('idle')}
            >
              Cancel
            </BrandButton>
            <BrandButton disabled={withdrawStep === 'submitting'} onClick={confirmWithdraw}>
              {withdrawStep === 'submitting' ? 'Submitting…' : 'Yes, withdraw'}
            </BrandButton>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CareersInterviewPage() {
  const { token } = useParams();
  useGlassSurface(true);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // null | 'notfound' | 'temporary'
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [withdrawn, setWithdrawn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}`)
      .then((res) => {
        if (res.status === 404) {
          const err = new Error('notfound');
          err.notFound = true;
          throw err;
        }
        if (!res.ok) throw new Error('temporary');
        return res.json();
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.notFound ? 'notfound' : 'temporary');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, loadAttempt]);

  if (loading) {
    return <InterviewLoadingState />;
  }

  if (error === 'notfound') {
    return <InterviewTerminalState kind="notfound" />;
  }

  if (error === 'temporary' || !data) {
    return <InterviewTerminalState kind="temporary" onRetry={() => setLoadAttempt((a) => a + 1)} />;
  }

  if (withdrawn) {
    return <InterviewTerminalState kind="withdrawn" />;
  }

  const goInactive = () => {
    setData(null);
    setError('notfound');
  };

  return (
    <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
      <div style={EYEBROW}>Interview scheduling</div>
      <h1 style={{ ...H1_STYLE, fontSize: 26 }}>Hi {data.first_name || 'there'}</h1>

      <InterviewBookingPanel
        token={token}
        data={data}
        onDataChange={setData}
        onInactiveLink={goInactive}
      />

      {/* Withdrawing is offered in BOTH booking states: an applicant who was
          invited but is not interested should be able to say so without
          first booking a time (local audit P1). */}
      <WithdrawalControl
        token={token}
        onWithdrawn={() => setWithdrawn(true)}
        onInactiveLink={goInactive}
      />
    </CustomerColumn>
  );
}
