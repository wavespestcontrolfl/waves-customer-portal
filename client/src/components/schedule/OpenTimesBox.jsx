// The open-times box (owner 2026-10-25, layout A; GATE_OPEN_TIMES_BOX): the
// staff time picker on New Appointment, Edit appointment, Reschedule, the
// drag-and-drop confirm and Quick Move. Owner rulings 2026-10-24/25:
//   1. Only open times: no verdict sentence and no "doesn't fit" anywhere.
//   2. One list: 15 dates of the next four weeks, each row the date, the
//      technician under it, the hour and what it adds to the day's driving
//      ("adds N min", the owner's words). Over 30 min added shows in amber.
//   3. Best / Soonest at the top, centered. Best = least added drive, the
//      sooner date on a tie; Soonest = the next open dates in order.
//   4. Morning / Afternoon / Evening, for a customer home only part of the day.
//   5. The Date field searches: a new date shows that day's open times, with
//      "All dates" to go back. Tapping a row fills the fields.
//   6. Tech pick: every technician's route is ranked and the best per date
//      listed; "Tech" narrows to one person (shown once there are two).
// Warn-only like the strip it replaces: a tap only fills the fields (onPick),
// never saves. No onPick = display only (the drag-and-drop confirm).

import { useEffect, useRef, useState } from 'react';
import { fmtDay, fmtHour } from './AvailabilityStrip';

const LIST_SIZE = 15;
// A day nobody could check: a far day whose lookup failed ('unchecked'), or
// a route the engine cannot verify ('unverified': a route under way, a stop
// with no map location). Neither is a day with no open times.
const NOT_CHECKED = new Set(['unchecked', 'unverified']);
const FAR_MINUTES = 30;
// Start hours in each part of the day (owner mock 2026-10-24).
const BANDS = [
  ['any', 'Any time', null],
  ['morning', 'Morning', [8, 11]],
  ['afternoon', 'Afternoon', [12, 15]],
  ['evening', 'Evening', [16, 19]],
];

const finite = (v) => (Number.isFinite(v) ? v : Infinity);
const sameStart = (a, b) => !!a && !!b && String(a).slice(0, 5) === String(b).slice(0, 5);
// The rain tier (0 sorts first) only orders an outdoor booking's hours; none = drive order.
const tier = (hour) => (Number.isFinite(hour.rainTier) ? hour.rainTier : 0);
const byBestHour = (a, b) => tier(a) - tier(b) || finite(a.detourMinutes) - finite(b.detourMinutes) || a.start.localeCompare(b.start);
const byBestDate = (a, b) => tier(a) - tier(b) || finite(a.detourMinutes) - finite(b.detourMinutes) || a.date.localeCompare(b.date);
const bySoonestHour = (a, b) => a.start.localeCompare(b.start) || finite(a.detourMinutes) - finite(b.detourMinutes);

// What the hour adds to the day's driving. "~" marks the straight-line
// model; a number Google priced on real roads carries none.
const isEstimate = (hour) => hour.detourMinutes != null && hour.driveSource !== 'google';
export function addsPhrase(hour) {
  if (hour.detourMinutes == null) return 'drive unknown';
  return `adds ${isEstimate(hour) ? '~' : ''}${Math.max(0, Math.round(hour.detourMinutes))} min`;
}

function inBand(hour, band) {
  const range = BANDS.find(([key]) => key === band)?.[2];
  if (!range) return true;
  const h = parseInt(String(hour.start).slice(0, 2), 10);
  return h >= range[0] && h <= range[1];
}

// Every technician the answer covers, in the order they first appear.
function techsOf(days) {
  const seen = new Map();
  for (const day of days) {
    for (const hour of day.hours) {
      if (hour.technicianId && !seen.has(hour.technicianId)) seen.set(hour.technicianId, hour.technicianName || 'Technician');
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** The rows on screen: { rows, empty } for the all-dates list or one day. */
export function openTimesRows(days, { mode, band, techId, focusDate }) {
  const options = (day) => (day.closed ? [] : day.hours.filter((hour) => (!techId || String(hour.technicianId) === String(techId)) && inBand(hour, band)));
  if (focusDate) {
    const day = days.find((d) => d.date === focusDate);
    if (NOT_CHECKED.has(day?.status)) return { rows: [], empty: 'Could not check this day' };
    const rows = day ? [...options(day)].sort(mode === 'soonest' ? bySoonestHour : byBestHour) : [];
    return { rows, empty: 'No open times this day' };
  }
  // A last-resort day (a Sunday under the day rules) is listed only when no
  // other day has an open time, as the strip did.
  const bestOf = (list) => list.map((day) => [...options(day)].sort(byBestHour)[0]).filter(Boolean);
  let picks = bestOf(days.filter((day) => !day.closed && !day.last_resort));
  if (!picks.length) picks = bestOf(days.filter((day) => !day.closed && day.last_resort));
  picks.sort(mode === 'soonest' ? (a, b) => a.date.localeCompare(b.date) : byBestDate);
  return { rows: picks.slice(0, LIST_SIZE), empty: 'No open times' };
}

const card = { borderRadius: 6, padding: 12, background: '#FAFAFA', border: '0.5px solid #D4D4D8', display: 'flex', flexDirection: 'column', gap: 10 };
const segWrap = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', width: 'min(240px, 100%)', margin: '0 auto', gap: 4,
  background: '#F4F4F5', borderRadius: 10, padding: 4,
};
const segBtn = (on) => ({
  minHeight: 40, border: 0, borderRadius: 7, fontFamily: 'inherit', fontSize: 15, fontWeight: 500, cursor: 'pointer',
  background: on ? '#FFFFFF' : 'transparent', color: on ? '#18181B' : '#52525B', boxShadow: on ? '0 1px 2px rgba(0,0,0,0.12)' : 'none',
});
const chipBtn = (on) => ({
  minHeight: 40, padding: '5px 12px', borderRadius: 999, fontFamily: 'inherit', fontSize: 14, cursor: 'pointer',
  border: `0.5px solid ${on ? '#18181B' : '#D4D4D8'}`, background: on ? '#18181B' : '#FFFFFF', color: on ? '#FFFFFF' : '#52525B',
});
const listStyle = { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 404, overflowY: 'auto', paddingRight: 2 };
const rowStyle = ({ withDate, far, current, takeable }) => ({
  display: 'grid', gridTemplateColumns: withDate ? '1fr auto 112px' : '1fr 112px', alignItems: 'center', gap: 10,
  minHeight: 58, padding: '0 14px', borderRadius: 10, textAlign: 'left', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
  border: `0.5px solid ${current ? '#18181B' : '#D4D4D8'}`,
  background: current ? '#18181B' : (far ? '#FFFBEB' : '#FFFFFF'),
  color: current ? '#FFFFFF' : '#18181B', cursor: takeable ? 'pointer' : 'default',
});
const subInk = (current) => ({ display: 'block', fontSize: 14, fontWeight: 400, color: current ? '#FFFFFF' : '#52525B' });

export default function OpenTimesBox({
  availability, currentDate, currentStart, currentTechnicianId, onPick, techPick = false, style,
}) {
  const [mode, setMode] = useState('best');
  const [band, setBand] = useState('any');
  const [techId, setTechId] = useState('');
  const [focusDate, setFocusDate] = useState(null);
  // A new date in the form (typed, or filled by a row) shows that day.
  const shownDate = useRef(currentDate);
  useEffect(() => {
    if (currentDate && currentDate !== shownDate.current) setFocusDate(currentDate);
    shownDate.current = currentDate;
  }, [currentDate]);

  if (availability.openTimes?.pending) {
    return (
      <div data-testid="open-times-box" role="status" style={{ ...card, color: '#52525B', fontSize: 14, ...style }}>
        Finding open times…
      </div>
    );
  }
  const days = availability.days || [];
  const techs = techsOf(days);
  const showTech = techPick && techs.length > 1;
  // The picked technician applies only while the answer still lists them: a
  // refreshed list (new services, address or length) may not.
  const activeTech = showTech && techs.some((tech) => String(tech.id) === String(techId)) ? techId : '';
  const { rows, empty } = openTimesRows(days, { mode, band, techId: activeTech, focusDate });
  // Mid re-check the rows were found for the previous inputs: show them, take
  // none. A day the held answer does not cover yet (a far date being looked
  // up) is still being found, not a day with no open times.
  const pick = availability.stale ? undefined : onPick;
  const emptyText = availability.stale && focusDate && !days.some((d) => d.date === focusDate) ? 'Finding open times…' : empty;
  // A row is "current" only when taking it would change nothing: an hour on
  // another technician's route (or any route, for an unassigned visit) stays
  // tappable, as the strip's chips do.
  const isCurrent = (hour) => hour.date === currentDate && sameStart(hour.start, currentStart)
    && (!hour.technicianId || String(hour.technicianId) === String(currentTechnicianId ?? ''));
  const take = (hour) => {
    if (!pick) return;
    setFocusDate(hour.date);
    pick({ ...hour, pickTech: techPick });
  };

  return (
    <div data-testid="open-times-box" style={{ ...card, fontSize: 14, opacity: availability.stale ? 0.6 : 1, ...style }}>
      <div role="group" aria-label="Order" style={segWrap}>
        <button type="button" aria-pressed={mode === 'best'} style={segBtn(mode === 'best')} onClick={() => setMode('best')}>Best</button>
        <button type="button" aria-pressed={mode === 'soonest'} style={segBtn(mode === 'soonest')} onClick={() => setMode('soonest')}>Soonest</button>
      </div>
      <div role="group" aria-label="Part of the day" style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
        {BANDS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={band === key} style={chipBtn(band === key)} onClick={() => setBand(key)}>{label}</button>
        ))}
      </div>
      {showTech && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#52525B' }}>
          Tech
          <select
            aria-label="Tech"
            value={activeTech}
            onChange={(e) => setTechId(e.target.value)}
            style={{ flex: 1, minHeight: 40, fontFamily: 'inherit', fontSize: 14, color: '#18181B', border: '0.5px solid #D4D4D8', borderRadius: 6, background: '#FFFFFF', padding: '0 8px' }}
          >
            <option value="">Any tech</option>
            {techs.map((tech) => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </select>
        </label>
      )}
      {focusDate && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 15 }}>{fmtDay(focusDate)}</b>
          <button type="button" style={chipBtn(false)} onClick={() => setFocusDate(null)}>All dates</button>
        </div>
      )}
      <div role="list" aria-label={focusDate ? `Open times ${fmtDay(focusDate)}` : 'Open dates'} style={listStyle}>
        {rows.length ? rows.map((hour) => {
          const current = isCurrent(hour);
          const far = Number(hour.detourMinutes) > FAR_MINUTES;
          const takeable = !!pick && !current;
          return (
            <div role="listitem" key={`${hour.date}-${hour.start}-${hour.technicianId || ''}`}>
              <button
                type="button"
                data-testid="open-time-row"
                data-far={far || undefined}
                aria-pressed={current}
                disabled={!takeable}
                onClick={() => take(hour)}
                style={{ ...rowStyle({ withDate: !focusDate, far, current, takeable }), width: '100%' }}
              >
                <span style={{ fontSize: 16, fontWeight: 600 }}>
                  {focusDate ? fmtHour(hour.start) : fmtDay(hour.date)}
                  {hour.technicianName ? <span style={subInk(current)}>{hour.technicianName}</span> : null}
                </span>
                {!focusDate && <span style={{ fontSize: 17, fontWeight: 600 }}>{fmtHour(hour.start)}</span>}
                <span style={{ textAlign: 'right', fontSize: 15, fontWeight: far ? 500 : 400, color: current ? '#FFFFFF' : (far ? '#B45309' : '#52525B') }}>
                  {addsPhrase(hour)}
                </span>
              </button>
            </div>
          );
        }) : (
          <div role="listitem" style={{ minHeight: 48, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 10, background: '#F4F4F5', color: '#52525B' }}>
            {emptyText}
          </div>
        )}
      </div>
      {rows.some(isEstimate) ? <div style={{ color: '#52525B' }}>~ = straight-line estimate, not a road time.</div> : null}
    </div>
  );
}
