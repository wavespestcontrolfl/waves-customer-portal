// Amber advisory rendered under a date/time picker when the chosen slot
// already has occupants (useSlotConflicts). Same hairline card and dot as
// the AvailabilityStrip verdict it sits beside, with warn-only copy: unlike
// Quick Move, none of these surfaces block saving — the notice says so
// instead of "the schedule will block this move". Renders nothing when there are no conflicts (including
// while the server gate is off).
//
// `shiftWarning` (GATE_TECH_SHIFT_HOURS): the server's line when the technician's shift does not hold
// the picked slot (useSlotConflicts). It is its own card, under the overlap card when both show: it is
// not a double booking, and it does not block saving either.

import { noticeCardStyle, noticeDotStyle } from './AvailabilityStrip';

function fmtTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Same labeling rules as RainOutSheet's conflictLabel: name the customer
// when the server let this caller see it, call out estimate-slot holds,
// fall back to "another appointment".
export function conflictLabel(c) {
  const who = c.customerName || (c.isHold ? 'An estimate-slot hold' : 'Another appointment');
  const what = c.serviceType ? ` (${c.serviceType.toLowerCase()})` : '';
  return `${who}${what}`;
}

const cardStyle = { ...noticeCardStyle, display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 14, color: '#854D0E' };

function ShiftCard({ warning, style }) {
  return (
    <div data-testid="slot-shift-warning" style={{ ...cardStyle, ...style }}>
      <span aria-hidden="true" style={{ ...noticeDotStyle, background: '#854D0E' }} />
      <div>
        <div style={{ fontWeight: 500 }}>{warning}</div>
        <div style={{ color: '#52525B' }}>Shift hours do not block saving.</div>
      </div>
    </div>
  );
}

export default function SlotConflictNotice({ conflicts, shiftWarning, style }) {
  if (!conflicts?.length) return shiftWarning ? <ShiftCard warning={shiftWarning} style={style} /> : null;
  if (shiftWarning) {
    // Both: the overlap card keeps the site's top margin, the shift card its bottom margin.
    return (
      <>
        <SlotConflictNotice conflicts={conflicts} style={{ ...style, marginBottom: 8 }} />
        <ShiftCard warning={shiftWarning} style={{ ...style, marginTop: 0 }} />
      </>
    );
  }
  const first = conflicts[0];
  const span = first.windowStart
    ? ` ${fmtTime(first.windowStart)}${first.windowEnd ? `–${fmtTime(first.windowEnd)}` : ''}`
    : '';
  return (
    <div style={{ ...cardStyle, ...style }}>
      <span aria-hidden="true" style={{ ...noticeDotStyle, background: '#854D0E' }} />
      {first.warning ? <div>{first.warning}</div> : (
        <div>
          <div style={{ fontWeight: 500 }}>
            {`${conflictLabel(first)} is already booked${span} on this date`}
            {conflicts.length > 1 ? `, and ${conflicts.length - 1} more.` : '.'}
          </div>
          <div style={{ color: '#52525B' }}>Saving will double-book this time slot.</div>
        </div>
      )}
    </div>
  );
}
