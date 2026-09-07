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

function detourPhrase(slot) {
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

export default function BestTimeHint({
  bestTimes, picked, bestInRange, onPick, onPickDate, currentStart, currentDate, currentTechnicianId, style,
}) {
  const bestToday = bestTimes?.[0] || null;
  if (!picked && !bestToday && !bestInRange) return null;
  // A current-time chip goes inert only when picking it would be a
  // no-op — on surfaces where a pick also adopts the slot's tech
  // (create/edit, passed via currentTechnicianId), a matching time
  // with a DIFFERENT tech must stay tappable or the operator can't
  // take the route the detour was scored for.
  const techMatches = (slot) => !slot.technicianId
    || String(slot.technicianId) === String(currentTechnicianId ?? '');
  const chipStyle = {
    padding: '3px 8px', borderRadius: 6, fontSize: 14,
    border: '1px solid #D4D4D8', background: 'transparent', color: '#52525B',
  };
  const chip = (slot, label, handler) => (handler
    ? <button type="button" onClick={() => handler(slot)} style={{ ...chipStyle, cursor: 'pointer' }}>{label}</button>
    : <span style={chipStyle}>{label}</span>);
  const row = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 };

  const todayIsCurrent = bestToday && sameStart(currentStart, bestToday.start) && techMatches(bestToday);
  const rangeIsCurrent = bestInRange && bestInRange.date === currentDate
    && sameStart(currentStart, bestInRange.start) && techMatches(bestInRange);
  // A range pick on the picked date only needs the time — surfaces that
  // can't change the date (fixed drop targets) still get a live chip then.
  const rangeHandler = onPickDate
    || (bestInRange && bestInRange.date === currentDate && typeof onPick === 'function' ? onPick : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#71717A', ...style }}>
      {picked && <div>{pickedLabel(picked)}</div>}
      {bestToday && (
        <div style={row}>
          {todayIsCurrent
            ? <span>{fmtTime(bestToday.start)} is the best hour that day.</span>
            : <><span>Best that day:</span>{chip(bestToday, bestTimeLabel(bestToday), typeof onPick === 'function' ? onPick : null)}</>}
        </div>
      )}
      {bestInRange && (
        <div style={row}>
          {rangeIsCurrent
            ? <span>{fmtTime(bestInRange.start)} is also the best hour in the next 3 days.</span>
            : <><span>Best in the next 3 days:</span>{chip(bestInRange, bestDateLabel(bestInRange), rangeHandler)}</>}
        </div>
      )}
      {(bestTimes || []).some((slot) => slot.arrivalWindows) && (
        <span>Accounts for driving and full service time; arrivals stay within each customer's 2-hour window.</span>
      )}
    </div>
  );
}
