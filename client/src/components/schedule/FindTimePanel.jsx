// Dispatch "Find a time" panel (GATE_DISPATCH_FIND_TIME_PANEL, owner
// 2026-10-21, option C): the office is on the phone with a NEW caller, so
// there is no customer record yet. Type the service address, pick a length,
// and the best hours for that address show at once: the best 4 on the picked
// date and the best 4 in the next 7 days (the same chips and numbers as the
// New Appointment time box; useBestTimes with summary + bestRows on an
// address alone). Tap a chip, then Book: New Appointment opens with that
// day, hour and technician and the address already in its New customer block.
// This panel writes nothing — no customer, no visit — and it never ranks near
// the caller's own other visits (a new caller has none).
//
// The length is a plain select, not the Service Library search: the engine
// only needs minutes, and the catalog typeahead is heavy for a phone call.
// `enabled` is the gate; off renders nothing at all.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import AddressAutocomplete from '../AddressAutocomplete';
import useModalFocus from '../../hooks/useModalFocus';
import { etDateString } from '../../lib/timezone';
import { useBestTimes } from './useBestTimes';
import { BestRow, fmtDay, fmtHour } from './AvailabilityStrip';

const LENGTHS = [30, 45, 60, 90, 120, 180];
const DEFAULT_LENGTH = 60;

const labelStyle = { display: 'block', marginBottom: 4, fontSize: 12, color: '#52525B' };
const fieldStyle = {
  width: '100%', minHeight: 44, padding: '8px 10px', borderRadius: 4, border: '0.5px solid #D4D4D8',
  background: '#fff', color: '#18181B', fontSize: 16, fontFamily: 'inherit', boxSizing: 'border-box',
};
const noteStyle = { marginTop: 12, color: '#52525B', fontSize: 14, lineHeight: 1.5 };
const primaryButton = {
  width: '100%', minHeight: 44, borderRadius: 6, border: 'none', background: '#18181B', color: '#fff',
  fontSize: 14, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
};

// The one line shown in place of the results.
function statusNote({ target, checking, gated, best }) {
  if (!target) return { text: 'Pick the address from the list to see the best times.' };
  if (checking && !best) return { text: 'Checking routes…' };
  if (checking || best) return null;
  if (gated) return { testId: 'find-time-off', text: 'Best times are off.' };
  return { text: 'No times came back. Check the address and try again.' };
}

const hourKey = (hour) => (hour ? `${hour.date}|${String(hour.start).slice(0, 5)}|${hour.technicianId || ''}` : '');

export default function FindTimePanel({ enabled = false, onBook }) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  return (
    <>
      <button
        type="button"
        data-testid="find-time-open"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center u-label px-3 h-11 md:h-8 rounded-sm border-hairline border-zinc-300 bg-white text-ink-secondary u-focus-ring hover:bg-zinc-50"
      >
        Find a time
      </button>
      {open && <FindTimeDrawer onClose={() => setOpen(false)} onBook={onBook} />}
    </>
  );
}

function FindTimeDrawer({ onClose, onBook }) {
  const dialogRef = useModalFocus(true, onClose);
  const today = etDateString();
  const [addressText, setAddressText] = useState('');
  // The address the search stands on: set only when a suggestion is picked
  // (or the field blurs and Google geocodes it), never from half-typed text.
  const [target, setTarget] = useState(null);
  const [date, setDate] = useState(today);
  const [length, setLength] = useState(DEFAULT_LENGTH);
  const [selected, setSelected] = useState(null);

  // The page behind stays put while the panel is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const { availability, checking, gated } = useBestTimes({
    date,
    durationMinutes: length,
    enabled: !!target,
    addressOnly: true,
    address: target?.formatted,
    lat: target?.lat ?? undefined,
    lng: target?.lng ?? undefined,
    summary: true,
    bestRows: true,
  });
  const best = availability?.best || null;
  // Mid re-check the rows are the previous answer's (another date or length):
  // show them dimmed, but take no pick and no Book until the new answer lands.
  const stale = !!availability?.stale;
  const note = statusNote({ target, checking, gated, best });

  // A new place, date or length is a new question: the old pick no longer applies.
  useEffect(() => { setSelected(null); }, [target, date, length]);

  const shown = useMemo(() => [...(best?.day || []), ...(best?.week || [])], [best]);
  const selectedHour = shown.find((hour) => hourKey(hour) === selected) || null;

  const book = () => {
    if (!selectedHour || !target || stale) return;
    onBook?.({
      date: selectedHour.date,
      windowStart: String(selectedHour.start).slice(0, 5),
      techId: selectedHour.technicianId || undefined,
      durationMinutes: length,
      quickAddAddress: { address: target.line1, city: target.city, state: target.state, zip: target.zip },
    });
  };

  const pick = (hour) => setSelected(hourKey(hour));
  const isCurrent = (hour) => hourKey(hour) === selected;

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'flex-end' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Find a time"
        style={{
          width: 440, maxWidth: '100%', height: '100dvh', overflowY: 'auto', boxSizing: 'border-box',
          background: '#fff', padding: 16, fontSize: 14, color: '#18181B', lineHeight: 1.5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Find a time</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ minWidth: 44, minHeight: 44, border: 'none', background: 'none', fontSize: 14, cursor: 'pointer', color: '#52525B' }}
          >
            Close
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle} htmlFor="find-time-address">Service address</label>
          <AddressAutocomplete
            id="find-time-address"
            value={addressText}
            onChange={(val) => { setAddressText(val); setTarget(null); }}
            onSelect={(parts) => {
              // Keep an apartment / unit (line2) on the street line: New customer's
              // quick-add has one address line, and a lost unit is a wrong address.
              const line1 = [parts.line1 || parts.formatted || '', parts.line2].filter(Boolean).join(' ');
              setAddressText(line1);
              setTarget({
                formatted: parts.formatted || [line1, parts.city, parts.state, parts.zip].filter(Boolean).join(', '),
                line1,
                city: parts.city || '',
                state: parts.state || 'FL',
                zip: parts.zip || '',
                lat: parts.lat ?? null,
                lng: parts.lng ?? null,
              });
            }}
            appearance="admin"
            style={fieldStyle}
            placeholder="Start typing the address"
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="find-time-length">Visit length</label>
            <select id="find-time-length" value={length} onChange={(e) => setLength(Number(e.target.value))} style={fieldStyle}>
              {LENGTHS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle} htmlFor="find-time-date">Day</label>
            <input
              id="find-time-date"
              type="date"
              min={today}
              value={date}
              onChange={(e) => { if (e.target.value >= today) setDate(e.target.value); }}
              style={fieldStyle}
            />
          </div>
        </div>

        {note && <div data-testid={note.testId} style={noteStyle}>{note.text}</div>}
        {best && (
          <div data-testid="find-time-results" style={{ opacity: stale ? 0.6 : 1 }}>
            <BestRow
              title={`Best on ${fmtDay(availability?.pickedDate || date)}`}
              hours={best.day}
              withDay={false}
              empty="No open hours that day."
              isCurrent={isCurrent}
              onPick={stale ? undefined : pick}
            />
            {best.weekCovered !== false && (
              <BestRow
                title="Best in the next 7 days"
                hours={best.week}
                withDay
                empty="Nothing fits in the next 7 days."
                isCurrent={isCurrent}
                onPick={stale ? undefined : pick}
              />
            )}
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                data-testid="find-time-book"
                disabled={!selectedHour || stale}
                onClick={book}
                style={{ ...primaryButton, opacity: selectedHour && !stale ? 1 : 0.4, cursor: selectedHour && !stale ? 'pointer' : 'default' }}
              >
                {selectedHour ? `Book ${fmtDay(selectedHour.date)} · ${fmtHour(selectedHour.start)}` : 'Tap a time to book it'}
              </button>
              <div style={{ ...noteStyle, marginTop: 8, fontSize: 12 }}>
                Opens New Appointment with this address in New customer. Nothing is saved until you save there.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
