// Availability strip under an admin date/time picker (useBestTimes with
// summary:true) — the replacement for the three stacked advisories (route
// warning, "doesn't fit", one "best in the next 3 days" chip). Owner
// rulings 2026-10-02:
//   1. One verdict on the hour in the fields, with the remedy in the same
//      box: the hours offered under the sentence ARE the appointments on
//      offer. Tap one, the fields fill, Save books it.
//   2. When the pick fits, the other hours that fit that day are offered
//      too, so the customer can be given a choice.
//   3. Every hour chip carries what it adds to the day's driving
//      ("+11 min drive"); no "on route" / "tight" labels.
//   4. Day pills run around the PICKED date, not today.
// Warn-only like the hint it replaces: picking a chip only fills fields
// (onPick), never submits, and no consumer disables a save on this data.
// Renders nothing without an availability answer (gate off, search failed)
// — the consumer falls back to BestTimeHint.

import { useEffect, useState } from 'react';
import { etDateString } from '../../lib/timezone';

const OFFER_COUNT = 3;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseYmd(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtHour(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${m[2] === '00' ? h12 : `${h12}:${m[2]}`} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function fmtDay(ymd) {
  const d = parseYmd(ymd);
  return d ? `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}` : String(ymd || '');
}

// What the hour adds to the day's driving. null = the engine could not
// price the route (a coordless stop) — say nothing rather than "free".
export function drivePhrase(detourMinutes) {
  if (detourMinutes == null) return null;
  const mins = Math.round(Number(detourMinutes) || 0);
  return mins > 0 ? `+${mins} min drive` : 'no added drive';
}

const sameStart = (a, b) => !!a && !!b && String(a).slice(0, 5) === String(b).slice(0, 5);
// Least added drive first; an unpriced hour sorts after the priced ones.
const byDrive = (a, b) => (a.detourMinutes ?? Infinity) - (b.detourMinutes ?? Infinity) || a.start.localeCompare(b.start);

// The hours to offer when the picked day has none: the nearest days with
// room, later days before earlier ones at the same distance (a reschedule
// usually moves forward), cheapest hours first within a day.
function closestHours(days, pickedDate, count) {
  const picked = parseYmd(pickedDate);
  const distance = (day) => Math.abs(parseYmd(day.date) - picked);
  return days
    // A closed day (blackout, weekly day off, Sunday) is never the suggestion.
    .filter((day) => day.date !== pickedDate && day.hours.length && !day.closed)
    .sort((a, b) => distance(a) - distance(b) || b.date.localeCompare(a.date))
    .flatMap((day) => [...day.hours].sort(byDrive))
    .slice(0, count);
}

/**
 * The strip's one verdict: { tone, text, lead, offers, withDay }.
 * tone: 'ok' (fits or nothing to say), 'miss' (a VERIFIED miss — the only
 * tone a consumer may relabel its save button on), 'warn' (could not check,
 * or already booked). Exported for tests and for consumers' save labels.
 */
export function availabilityVerdict(availability, current) {
  if (!availability) return null;
  // A re-check is in flight: the previous answer is for another pick. Hold
  // the strip (and the route warning it replaces) rather than flash the old
  // advisories back for the length of one request.
  if (availability.stale) return { tone: 'ok', text: 'Checking…', detail: null, lead: null, offers: [], withDay: false };
  const verdict = verdictFor(availability, current);
  const dayRow = availability.days.find((day) => day.date === current.currentDate);
  if (!dayRow?.closed) return verdict;
  const note = `${fmtDay(current.currentDate)} is a closed day.`;
  return { ...verdict, detail: verdict.detail ? `${verdict.detail} ${note}` : note };
}

function verdictFor(availability, { currentDate, currentStart }) {
  const { days, picked } = availability;
  const dayRow = days.find((day) => day.date === currentDate) || { date: currentDate, status: 'full', hours: [] };
  const day = fmtDay(currentDate);
  const time = fmtHour(currentStart);
  const sameDay = [...dayRow.hours].sort(byDrive);
  const others = sameDay.filter((hour) => !sameStart(hour.start, currentStart));
  const nearby = () => closestHours(days, currentDate, OFFER_COUNT);
  const offerDayOrNearby = (lead = 'Open that day:') => (others.length
    ? { lead, offers: others.slice(0, OFFER_COUNT), withDay: false }
    : { lead: 'Closest:', offers: nearby(), withDay: true });
  // The verdict belongs to the hour it was scored for; a stale one (the
  // operator just changed the time) says nothing until the next answer.
  const verdict = picked && sameStart(picked.start, currentStart) ? picked : null;

  if (verdict?.fits === true) {
    const drive = drivePhrase(verdict.detourMinutes);
    return {
      tone: 'ok', text: `${day} · ${time} fits.`, detail: drive ? `${drive.replace(/^no/, 'No')}.` : null,
      lead: 'Also open that day:', offers: others.slice(0, OFFER_COUNT), withDay: false,
    };
  }
  if (verdict?.fits === false) {
    if (verdict.reason === 'day_overcommitted') {
      return {
        tone: 'miss', text: `${day} is already over-booked`, detail: 'before this visit is added. Nothing fits that day.',
        lead: 'Closest:', offers: nearby(), withDay: true,
      };
    }
    if (verdict.reason === 'return_time') {
      const earlier = others.filter((hour) => hour.start < String(currentStart).slice(0, 5)).sort((a, b) => a.start.localeCompare(b.start));
      return {
        tone: 'miss', text: `${time} ${day} runs the route past the end of the workday.`, detail: null,
        ...(earlier.length ? { lead: 'Earlier that day:', offers: earlier.slice(-OFFER_COUNT), withDay: false } : offerDayOrNearby()),
      };
    }
    if (verdict.reason === 'occupied') {
      return { tone: 'warn', text: `${time} ${day} is already booked.`, detail: null, ...offerDayOrNearby() };
    }
    return {
      tone: 'miss', text: `${time} ${day} doesn't fit.`,
      detail: verdict.reason === 'arrival_window' ? "Another stop's arrival window would be missed." : null,
      ...offerDayOrNearby(),
    };
  }
  if (verdict?.reason === 'route_unverified' || (!verdict && dayRow.status === 'unverified')) {
    const today = currentDate === etDateString();
    return {
      tone: 'warn',
      text: today ? "Can't check today's route while it is being driven." : `Can't check the route on ${day}.`,
      detail: 'Pick any time; dispatch sets the order.',
      lead: 'Checked nearby:', offers: nearby(), withDay: true,
    };
  }
  if (verdict?.reason === 'no_technician') {
    return { tone: 'warn', text: 'Pick a technician to check this hour.', detail: null, ...offerDayOrNearby() };
  }
  if (verdict?.reason === 'not_checkable') {
    return {
      tone: 'warn', text: `${time} can't be checked.`, detail: 'Appointments start on the hour, inside working hours.',
      ...offerDayOrNearby(),
    };
  }
  // No verdict for this hour (unassigned visit, or the answer is for an
  // earlier pick): just say what the day has.
  if (sameDay.length) return { tone: 'ok', text: `Open ${day}:`, detail: null, lead: null, offers: sameDay.slice(0, OFFER_COUNT), withDay: false };
  if (dayRow.status === 'off') {
    return { tone: 'warn', text: `The technician is off ${day}.`, detail: null, lead: 'Closest:', offers: nearby(), withDay: true };
  }
  return {
    tone: dayRow.status === 'overcommitted' ? 'miss' : 'ok',
    text: dayRow.status === 'overcommitted' ? `${day} is already over-booked.` : `Nothing fits ${day}.`,
    detail: null, lead: 'Closest:', offers: nearby(), withDay: true,
  };
}

/** True when the strip itself states the route problem, so a consumer can
 *  drop the slot-check's route warning instead of saying it twice. */
export function stripCoversRouteWarning(availability, current) {
  // Mid re-check the strip is about to answer: keep the warning it replaces
  // off screen for the length of the request.
  if (availability?.stale) return true;
  const verdict = availabilityVerdict(availability, current);
  return !!verdict && verdict.tone !== 'ok';
}

const TONES = {
  ok: { background: '#F4F4F5', color: '#18181B' },
  miss: { background: '#FCEBEB', color: '#C8312F' },
  warn: { background: '#FEF3C7', color: '#854D0E' },
};
const chipStyle = {
  display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
  minHeight: 44, padding: '5px 12px', borderRadius: 4, border: '0.5px solid #D4D4D8', background: '#fff',
  color: '#18181B', fontSize: 14, fontWeight: 500, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
};
const chipCurrent = { background: '#18181B', color: '#fff', border: '0.5px solid #18181B', cursor: 'default' };
const subStyle = { fontSize: 14, fontWeight: 400, color: '#52525B' };
const pillStyle = {
  // minWidth, not width: "unchecked" at 14px is wider than a date pill.
  flex: '0 0 auto', minWidth: 56, minHeight: 54, padding: '6px 8px', whiteSpace: 'nowrap', borderRadius: 6, border: '0.5px solid #D4D4D8',
  background: '#fff', color: '#18181B', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
};

function pillCount(day) {
  if (day.closed) return 'closed';
  if (day.hours.length) return `${day.hours.length} open`;
  if (day.status === 'off') return 'off';
  return day.status === 'unverified' ? 'unchecked' : 'full';
}
// Red is for a day with no room; "closed", "off" and "unchecked" are facts
// about the calendar, not a refusal.
const pillIsFull = (day) => !day.closed && !day.hours.length && day.status !== 'unverified' && day.status !== 'off';
function emptyDayLine(day) {
  if (day.status === 'unverified') return 'route not checked.';
  if (day.status === 'off') return 'the technician is off.';
  return 'no hour fits.';
}

function HourChip({ hour, withDay, current, onPick }) {
  const drive = drivePhrase(hour.detourMinutes);
  const sub = [drive, hour.technicianName].filter(Boolean).join(' · ');
  const label = `${withDay ? `${fmtDay(hour.date)} · ` : ''}${fmtHour(hour.start)}`;
  return (
    <button
      type="button"
      data-testid="availability-hour"
      disabled={current || !onPick}
      aria-pressed={current}
      onClick={() => onPick && onPick(hour)}
      style={{ ...chipStyle, ...(current ? chipCurrent : null) }}
    >
      <span>{label}</span>
      {sub ? <span style={{ ...subStyle, ...(current ? { color: '#fff', opacity: 0.8 } : null) }}>{sub}</span> : null}
    </button>
  );
}

export default function AvailabilityStrip({ availability, currentDate, currentStart, currentTechnicianId, onPick, style }) {
  const [viewDate, setViewDate] = useState(currentDate);
  // A new pick (typed, or filled by a chip) brings the browse row back to it.
  useEffect(() => { setViewDate(currentDate); }, [currentDate]);
  const verdict = availabilityVerdict(availability, { currentDate, currentStart });
  if (!verdict) return null;
  const tone = TONES[verdict.tone];
  const viewed = availability.days.find((day) => day.date === viewDate) || null;
  // Same rule as BestTimeHint's isCurrentPick: the hour is only "current"
  // when taking it would change nothing. An hour scored for a technician the
  // visit does not have (an unassigned visit adopts it on pick) stays tappable.
  const techMatches = (hour) => !hour.technicianId || String(hour.technicianId) === String(currentTechnicianId ?? '');
  const isCurrent = (hour) => hour.date === currentDate && sameStart(hour.start, currentStart) && techMatches(hour);
  const today = etDateString();

  return (
    <div data-testid="availability-strip" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14, ...style }}>
      <div role="status" data-tone={verdict.tone} style={{ borderRadius: 6, padding: '10px 12px', lineHeight: 1.5, ...tone }}>
        <div>
          <strong style={{ fontWeight: 600 }}>{verdict.text}</strong>
          {verdict.detail ? ` ${verdict.detail}` : null}
        </div>
        {verdict.offers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6, color: '#52525B' }}>
            {verdict.lead ? <span>{verdict.lead}</span> : null}
            {verdict.offers.map((hour) => (
              <HourChip key={`${hour.date}-${hour.start}`} hour={hour} withDay={verdict.withDay} current={isCurrent(hour)} onPick={onPick} />
            ))}
          </div>
        )}
      </div>
      <div role="listbox" aria-label="Days near the picked date" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
        {availability.days.map((day) => {
          const d = parseYmd(day.date);
          const selected = day.date === viewDate;
          return (
            <button
              type="button"
              key={day.date}
              role="option"
              aria-selected={selected}
              data-testid="availability-day"
              onClick={() => setViewDate(day.date)}
              style={{
                ...pillStyle,
                ...(day.date === currentDate ? { border: '1px solid #18181B' } : null),
                ...(selected ? { background: '#18181B', color: '#fff', border: '1px solid #18181B' } : null),
              }}
            >
              <span style={{ fontSize: 14, opacity: selected ? 0.8 : 1, color: selected ? '#fff' : '#52525B' }}>
                {day.date === today ? 'Today' : (d ? DOW[d.getUTCDay()] : '')}
              </span>
              <span style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{d ? d.getUTCDate() : ''}</span>
              <span style={{ fontSize: 14, color: selected ? '#fff' : (pillIsFull(day) ? '#C8312F' : '#52525B') }}>
                {pillCount(day)}
              </span>
            </button>
          );
        })}
      </div>
      {viewed && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <span style={{ width: '100%', color: '#52525B' }}>
            {viewed.hours.length
              ? `${fmtDay(viewed.date)}${viewed.closed ? ' (closed day)' : ''}`
              : `${fmtDay(viewed.date)}: ${viewed.closed ? 'closed day, ' : ''}${emptyDayLine(viewed)}`}
          </span>
          {viewed.hours.map((hour) => (
            <HourChip key={`${hour.date}-${hour.start}`} hour={hour} withDay={false} current={isCurrent(hour)} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}
