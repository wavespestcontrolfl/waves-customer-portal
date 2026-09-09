// Quiet advisory rendered under a date/time picker (useBestTimes), three
// lines (owner spec 2026-09-07):
//   1. what the hour already picked costs — the drive INTO this stop from
//      the previous anchor (home base for the first stop) and what the
//      insertion adds to that day's route;
//   2. the best hour that day;
//   3. the best date + hour over the next few days.
// Deliberately NOT an alert — neutral zinc, no amber — because unlike
// SlotConflictNotice it suggests rather than warns. Tapping a chip only
// fills the time (onPick) or date + time (onPickDate) fields, never
// submits; without a handler the chip is display-only text (fixed targets
// like the drag-drop confirm). A chip matching the current pick renders
// as a plain statement. Renders nothing when there is nothing to say
// (including while the server gate is off).

import { etDateString } from '../../lib/timezone';

function fmtTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(ymd) {
  if (ymd === etDateString()) return 'Today';
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ymd || '');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// "37 min drive from home base" — absent for arrival-window slots, which
// score the whole route rather than one insertion leg.
function driveInPhrase(slot) {
  const mins = Math.round(Number(slot.driveInMinutes));
  if (slot.driveInMinutes == null || !Number.isFinite(mins)) return null;
  const from = slot.fromHomeBase ? 'home base' : (slot.fromName || 'the previous stop');
  return `${mins} min drive from ${from}`;
}

// null detour = the engine could not price the route (a coordless anchor)
// — say so rather than claiming the stop is free.
export function detourPhrase(slot) {
  if (slot.detourMinutes == null) return 'route cost unknown';
  const detour = Math.round(Number(slot.detourMinutes) || 0);
  return detour > 0 ? `+${detour} min added to route` : 'no added drive';
}

export function bestTimeLabel(slot) {
  const arrival = slot.estimatedArrival ? `arrive ~${fmtTime(slot.estimatedArrival)}` : null;
  const parts = [fmtTime(slot.start), arrival, driveInPhrase(slot), detourPhrase(slot)].filter(Boolean);
  // Present only on unscoped (all-tech) searches: the detour is that
  // technician's, and picking the chip changes the time alone — the name
  // tells the operator whose route made it cheap.
  if (slot.technicianName) parts.push(slot.technicianName);
  return parts.join(' · ');
}

export function bestDateLabel(slot) {
  return `${fmtDate(slot.date)} · ${bestTimeLabel(slot)}`;
}

export function pickedLabel(picked) {
  const time = fmtTime(picked.start);
  if (!picked.fits) return `${time}: doesn't fit that day's route`;
  const parts = [driveInPhrase(picked), detourPhrase(picked)].filter(Boolean);
  if (picked.technicianName) parts.push(picked.technicianName);
  return `${time}: ${parts.join(' · ')}`;
}

const sameStart = (a, b) => !!a && !!b && String(a).slice(0, 5) === String(b).slice(0, 5);

// A chip matching the current pick renders as a plain statement — but only
// when picking it would be a no-op: on surfaces where a pick also adopts
// the slot's tech (create/edit, passed via currentTechnicianId), a matching
// time with a DIFFERENT tech must stay tappable or the operator can't take
// the route the detour was scored for.
function isCurrentPick(slot, { currentStart, currentDate, currentTechnicianId, sameDay }) {
  const techMatches = !slot.technicianId || String(slot.technicianId) === String(currentTechnicianId ?? '');
  return (sameDay || slot.date === currentDate) && sameStart(currentStart, slot.start) && techMatches;
}

// Three-part labels wrap inside a modal-width chip — read them as a line,
// not a centered block.
const chipStyle = {
  padding: '3px 8px', borderRadius: 6, fontSize: 14, textAlign: 'left',
  border: '1px solid #D4D4D8', background: 'transparent', color: '#52525B',
};
const rowStyle = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 };

function HintRow({ lead, slot, label, statement, current, onPick }) {
  if (current) return <div style={rowStyle}><span>{statement}</span></div>;
  return (
    <div style={rowStyle}>
      <span>{lead}</span>
      {onPick
        ? <button type="button" onClick={() => onPick(slot)} style={{ ...chipStyle, cursor: 'pointer' }}>{label}</button>
        : <span style={chipStyle}>{label}</span>}
    </div>
  );
}

export default function BestTimeHint({
  bestTimes, picked, bestInRange, onPick, onPickDate, currentStart, currentDate, currentTechnicianId, style,
}) {
  const bestToday = bestTimes?.[0] || null;
  if (!picked && !bestToday && !bestInRange) return null;
  const pick = typeof onPick === 'function' ? onPick : null;
  const cur = { currentStart, currentDate, currentTechnicianId };
  // A range pick on the picked date only needs the time — surfaces that
  // can't change the date (fixed drop targets) still get a live chip then.
  const rangePick = onPickDate || (bestInRange?.date === currentDate ? pick : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#71717A', ...style }}>
      {picked && <div>{pickedLabel(picked)}</div>}
      {bestToday && (
        <HintRow
          lead="Best that day:"
          slot={bestToday}
          label={bestTimeLabel(bestToday)}
          statement={`${fmtTime(bestToday.start)} is the best hour that day.`}
          current={isCurrentPick(bestToday, { ...cur, sameDay: true })}
          onPick={pick}
        />
      )}
      {bestInRange && (
        <HintRow
          lead="Best in the next 3 days:"
          slot={bestInRange}
          label={bestDateLabel(bestInRange)}
          statement={`${fmtTime(bestInRange.start)} is also the best hour in the next 3 days.`}
          current={isCurrentPick(bestInRange, cur)}
          onPick={rangePick}
        />
      )}
      {(bestTimes || []).some((slot) => slot.arrivalWindows) && (
        <span>Accounts for driving and full service time; arrivals stay within each customer's 2-hour window.</span>
      )}
    </div>
  );
}
