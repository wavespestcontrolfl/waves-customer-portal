import { useState } from 'react';
import { estimateCard } from './cardStyles';
import { W } from './tokens';

/**
 * "None of these times work?" under the time picker (GATE_ESTIMATE_APPROVE_PREFERRED_TIME).
 *
 * The time picker stays the first choice. This is the quiet second path: the customer approves a
 * standard recurring plan without a time slot, tells us the days (Mon to Sat) and the part of the
 * day that suit them, and the office books the first visit and contacts them to confirm. It only
 * collects the preference; the page's own payment step and Auto Pay card step run as they do for a
 * picked time, and the accept sends `preferredTime` instead of a slot.
 *
 * Controlled by the page: `value` is null or { days, window, note }; `onApply(value)` saves a
 * preference and `onClear()` drops it (the customer goes back to the time picker).
 */

export const PREFERRED_DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
];

export const PREFERRED_WINDOWS = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'either', label: 'Either works' },
];

export const PREFERRED_NOTE_MAX = 300;

// "Mon, Wed, Fri mornings" for the review step and the saved summary.
export function preferredTimeSummary(value) {
  if (!value || !Array.isArray(value.days) || !value.days.length) return '';
  const dayText = value.days.length === PREFERRED_DAYS.length
    ? 'any day Mon to Sat'
    : PREFERRED_DAYS.filter((d) => value.days.includes(d.key)).map((d) => d.label).join(', ');
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

function PreferredTimeForm({ initial, onApply, onCancel }) {
  const [days, setDays] = useState(initial?.days || []);
  const [windowKey, setWindowKey] = useState(initial?.window || '');
  const [note, setNote] = useState(initial?.note || '');
  const ready = days.length > 0 && !!windowKey;
  const toggleDay = (key) => setDays((cur) => (cur.includes(key) ? cur.filter((d) => d !== key) : [...cur, key]));
  return (
    <div style={estimateCard({ marginTop: 12, marginBottom: 0 })} data-testid="preferred-time-form">
      <p style={{ ...bodyText, color: W.navy, fontWeight: 700, fontSize: 18 }}>Approve now, and we will set up your first visit with you.</p>
      <fieldset style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
        <legend style={{ fontSize: 16, fontWeight: 600, color: W.navy, padding: 0, marginBottom: 8 }}>Which days work best?</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {PREFERRED_DAYS.map((d) => (
            <button
              key={d.key}
              type="button"
              aria-pressed={days.includes(d.key)}
              onClick={() => toggleDay(d.key)}
              style={chipStyle(days.includes(d.key))}
            >{d.label}</button>
          ))}
        </div>
      </fieldset>
      <fieldset style={{ border: 'none', padding: 0, margin: '16px 0 0' }}>
        <legend style={{ fontSize: 16, fontWeight: 600, color: W.navy, padding: 0, marginBottom: 8 }}>Morning or afternoon?</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {PREFERRED_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              aria-pressed={windowKey === w.key}
              onClick={() => setWindowKey(w.key)}
              style={chipStyle(windowKey === w.key)}
            >{w.label}</button>
          ))}
        </div>
      </fieldset>
      <label style={{ display: 'block', marginTop: 16 }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: W.navy, marginBottom: 6 }}>Anything we should know? (optional)</span>
        <textarea
          value={note}
          maxLength={PREFERRED_NOTE_MAX}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 10, border: '1px solid #C9C3B3', fontSize: 16, fontFamily: 'inherit', color: W.navy }}
        />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 16 }}>
        <button
          type="button"
          disabled={!ready}
          onClick={() => onApply({ days, window: windowKey, ...(note.trim() ? { note: note.trim() } : {}) })}
          style={ready ? primaryButton : { ...primaryButton, opacity: 0.5, cursor: 'default' }}
        >Use these days</button>
        <button type="button" onClick={onCancel} style={secondaryButton}>Back to times</button>
      </div>
    </div>
  );
}

export default function PreferredTimeApproval({ value = null, onApply, onClear, disabled = false }) {
  const [open, setOpen] = useState(false);

  if (value) {
    if (open) {
      return <PreferredTimeForm initial={value} onApply={(v) => { setOpen(false); onApply(v); }} onCancel={() => setOpen(false)} />;
    }
    return (
      <div style={estimateCard({ marginTop: 12, marginBottom: 0 })} data-testid="preferred-time-summary">
        <p style={{ ...bodyText, color: W.navy, fontWeight: 700 }}>You are approving without a set time.</p>
        <p style={{ ...bodyText, marginTop: 6 }}>
          Your days: {preferredTimeSummary(value)}. After you approve, our office will contact you to confirm your first visit.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <button type="button" disabled={disabled} onClick={() => setOpen(true)} style={linkButton}>Change days</button>
          <button type="button" disabled={disabled} onClick={onClear} style={linkButton}>Pick a time instead</button>
        </div>
      </div>
    );
  }

  if (open) {
    return <PreferredTimeForm initial={null} onApply={(v) => { setOpen(false); onApply(v); }} onCancel={() => setOpen(false)} />;
  }
  return (
    <div style={{ marginTop: 8 }} data-testid="preferred-time-offer">
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} style={linkButton}>
        None of these times work? Approve now and tell us when suits you.
      </button>
    </div>
  );
}
