// Amber advisory rendered under a date/time picker when the chosen slot
// already has occupants (useSlotConflicts). Mirrors RainOutSheet's overlap
// disclaimer styling, with warn-only copy: unlike Quick Move, none of these
// surfaces block saving — the notice says so instead of "the schedule will
// block this move". Renders nothing when there are no conflicts (including
// while the server gate is off).

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

export default function SlotConflictNotice({ conflicts, style }) {
  if (!conflicts?.length) return null;
  const first = conflicts[0];
  const span = first.windowStart
    ? ` ${fmtTime(first.windowStart)}${first.windowEnd ? `–${fmtTime(first.windowEnd)}` : ''}`
    : '';
  return (
    <div style={{
      fontSize: 13, padding: '8px 10px', borderRadius: 8,
      background: '#FFFBEB', border: '1px solid #FDE68A', color: '#B45309',
      ...style,
    }}>
      <div>
        {`⚠️ ${conflictLabel(first)} is already booked${span} on this date`}
        {conflicts.length > 1 ? `, and ${conflicts.length - 1} more.` : '.'}
      </div>
      <div style={{ marginTop: 2 }}>Saving will double-book this time slot.</div>
    </div>
  );
}
