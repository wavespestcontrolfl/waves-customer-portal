import { useState } from 'react';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * "None of these times work?" under the time picker (GATE_ESTIMATE_APPROVE_PREFERRED_TIME).
 *
 * The time picker stays the first choice. This is the quiet second path: the customer gives the days (Mon to Sat) and
 * the part of the day that suit them, plus an optional note, and taps one button. It is a REQUEST, not an approval: nothing
 * is accepted, booked, billed or charged, and the page says so in plain words. The office calls or texts to set the first
 * visit and finish the approval. `pending` ({ days, window }) is this tab's own state right after sending: nothing is stored, so a
 * reopened link shows the picker and this link again.
 */

export const REQUEST_DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
];

export const REQUEST_WINDOWS = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'either', label: 'Either works' },
];

export const REQUEST_NOTE_MAX = 300;

// "Mon, Wed, mornings" for the saved summary.
export function firstVisitRequestSummary(value) {
  if (!value || !Array.isArray(value.days) || !value.days.length) return '';
  const dayText = value.days.length === REQUEST_DAYS.length
    ? 'any day Mon to Sat'
    : REQUEST_DAYS.filter((d) => value.days.includes(d.key)).map((d) => d.label).join(', ');
  const part = { morning: 'mornings', afternoon: 'afternoons', either: 'mornings or afternoons' }[value.window] || '';
  return part ? `${dayText}, ${part}` : dayText;
}

const linkButton = {
  background: 'none', border: 'none', padding: '12px 4px', minHeight: 44, cursor: 'pointer',
  color: W.blue, fontSize: 16, fontWeight: 600, textDecoration: 'underline', textAlign: 'left', fontFamily: 'inherit',
};
const primaryButton = {
  minHeight: 48, padding: '12px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
  background: W.blue, color: '#FFFFFF', fontSize: 16, fontWeight: 700, fontFamily: 'inherit',
};
const secondaryButton = {
  minHeight: 48, padding: '12px 20px', borderRadius: 10, cursor: 'pointer',
  background: '#FFFFFF', color: W.blue, border: `1px solid ${W.blue}`, fontSize: 16, fontWeight: 600, fontFamily: 'inherit',
};
const bodyText = { fontSize: 16, lineHeight: 1.5, color: W.textBody, margin: 0 };

function chipStyle(on) {
  return {
    minHeight: 44, minWidth: 64, padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
    border: `1px solid ${on ? W.blue : '#C9C3B3'}`,
    background: on ? W.blue : '#FFFFFF',
    color: on ? '#FFFFFF' : W.navy,
    fontSize: 16, fontWeight: 600, fontFamily: 'inherit',
  };
}

const ERROR_COPY = {
  REQUEST_UNAVAILABLE: 'This estimate was just updated. Please reload the page.',
  PREFERRED_TIME_INVALID: 'Please pick at least one day that works for you, and whether mornings or afternoons are better.',
};

export default function FirstVisitRequest({ token, pending = null, disabled = false, onSent = null }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState([]);
  const [windowKey, setWindowKey] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const ready = days.length > 0 && !!windowKey && !sending;
  const toggleDay = (key) => setDays((cur) => (cur.includes(key) ? cur.filter((d) => d !== key) : [...cur, key]));

  const send = async () => {
    if (!ready) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/first-visit-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, window: windowKey, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(ERROR_COPY[body.code] || 'We could not send that just now. Please try again, or call or text us.');
        return;
      }
      setOpen(false);
      if (onSent) onSent({ days: body.days || days, window: body.window || windowKey });
    } catch {
      setError('We could not send that just now. Please try again, or call or text us.');
    } finally {
      setSending(false);
    }
  };

  if (pending) {
    return (
      <div style={estimateCard({ marginTop: 12, marginBottom: 0 })} data-testid="first-visit-request-pending">
        <p style={{ ...bodyText, color: W.navy, fontWeight: 700 }}>We have your request.</p>
        <p style={{ ...bodyText, marginTop: 6 }}>
          Your days: {firstVisitRequestSummary(pending)}. Our office will call or text you to set your first visit and finish your approval.
          You can also pick a time above whenever you like.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ marginTop: 8 }} data-testid="first-visit-request-offer">
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} style={linkButton}>
          None of these times work? Tell us when suits you.
        </button>
      </div>
    );
  }

  return (
    <div style={estimateCard({ marginTop: 12, marginBottom: 0 })} data-testid="first-visit-request-form">
      <p style={{ ...bodyText, color: W.navy, fontWeight: 700, fontSize: 18 }}>Tell us when suits you, and we will set up your first visit with you.</p>
      <p style={{ ...bodyText, marginTop: 6 }}>This is a request. Nothing is booked or charged until our office confirms with you.</p>
      <fieldset style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
        <legend style={{ fontSize: 16, fontWeight: 600, color: W.navy, padding: 0, marginBottom: 8 }}>Which days work best?</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {REQUEST_DAYS.map((d) => (
            <button key={d.key} type="button" aria-pressed={days.includes(d.key)} onClick={() => toggleDay(d.key)} style={chipStyle(days.includes(d.key))}>{d.label}</button>
          ))}
        </div>
      </fieldset>
      <fieldset style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
        <legend style={{ fontSize: 16, fontWeight: 600, color: W.navy, padding: 0, marginBottom: 8 }}>Morning or afternoon?</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {REQUEST_WINDOWS.map((w) => (
            <button key={w.key} type="button" aria-pressed={windowKey === w.key} onClick={() => setWindowKey(w.key)} style={chipStyle(windowKey === w.key)}>{w.label}</button>
          ))}
        </div>
      </fieldset>
      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: W.navy, marginBottom: 6 }}>Anything we should know? (optional)</span>
        <textarea
          value={note}
          maxLength={REQUEST_NOTE_MAX}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 10, border: '1px solid #C9C3B3', fontSize: 16, fontFamily: 'inherit', color: W.navy }}
        />
      </label>
      {error ? <p role="alert" style={{ ...bodyText, color: '#C8312F', marginTop: 12 }}>{error}</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
        <button type="button" disabled={!ready || disabled} onClick={send} style={ready && !disabled ? primaryButton : { ...primaryButton, opacity: 0.5, cursor: 'default' }}>
          {sending ? 'Sending…' : 'Send my request'}
        </button>
        <button type="button" disabled={sending} onClick={() => setOpen(false)} style={secondaryButton}>Back to times</button>
      </div>
    </div>
  );
}
