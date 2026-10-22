// client/src/pages/admin/HeldVisitsStrip.jsx
//
// "From calls, not on the calendar" strip for the admin Dispatch day view
// (GATE_CALL_HELD_VISIT, owner 2026-10-12). Display only. Two kinds of row:
//   confirmed - staff and the caller agreed this day and time on a recorded
//               call, and nothing on the calendar carries it ("Promised").
//   day_only  - this day was asked for or offered on a call with no agreed
//               time. It is NOT a confirmed visit; the row says "Day discussed"
//               and staff decide whether to book it. "Book it" hands the row to the page, which opens the existing
// New appointment modal. Renders nothing for an empty list.
//   move_day_only - staff and an existing customer agreed to MOVE a visit to this day with no
//               time (owner 2026-10-19). NOT CONFIRMED; the row says which day it moves from.
//               It books nothing: the button opens the visit to move, and the office moves it.
import React from 'react';
import { Button, buttonStyles, cn } from '../../components/ui';
import { formatETDate, formatETDateOnly, formatETTime } from '../../lib/timezone';

// Same deep link the notification triggers and the Follow-through cards use.
export const callHref = (callLogId) => `/admin/communications#tab=calls&call=${encodeURIComponent(callLogId)}`;

// What the call established, by kind. A day-only row is never called a promise.
const KIND_TEXT = {
  confirmed: { lead: 'Promised on a call', tag: 'PROMISED · not booked' },
  day_only: { lead: 'Day discussed on a call', tag: 'NOT CONFIRMED · not booked' },
  move_day_only: { lead: 'Move discussed on a call', tag: 'NOT CONFIRMED · not moved' },
};
export const kindText = (row) => KIND_TEXT[row.kind] || KIND_TEXT.day_only;

// The time column: the agreed time, else "Time not set" with the part of the day asked for.
export const heldWhen = (row) => row.time_label || (row.daypart ? `Time not set · asked for the ${row.daypart}` : 'Time not set');

// "Fri Nov 6" for the old day of a move.
const fromDayLabel = (row) => formatETDateOnly(row.from_date_et, { weekday: 'short', month: 'short', day: 'numeric' });

// The existing visit a day-only move would move: the Schedule on its day, opened on that visit
// (the same ?appointment= deep link the Auto-Dispatch audit uses). No new write.
export const moveVisitHref = (row) => `/admin/dispatch?tab=schedule&date=${encodeURIComponent(row.from_date_et)}${row.from_visit_id ? `&appointment=${encodeURIComponent(row.from_visit_id)}` : ''}`;

// The move link's words: "the visit" only when the server named exactly one; with several
// movable visits on the old day the link opens that day's schedule (Codex #6345 r3).
export const moveLinkLabel = (row) => {
  if (!row.from_date_et) return 'Open the schedule';
  return row.from_visit_id ? `Open the ${fromDayLabel(row)} visit` : `Open ${fromDayLabel(row)} on the schedule`;
};

export function fromCall(row) {
  if (!row.call_at) return kindText(row).lead;
  const day = formatETDate(row.call_at, { weekday: 'long' });
  if (row.kind === 'move_day_only' && row.from_date_et) {
    return `${kindText(row).lead} \u2014 from ${fromDayLabel(row)}, time not set (call ${day}, ${formatETTime(row.call_at)})`;
  }
  return `${kindText(row).lead} ${day}, ${formatETTime(row.call_at)}`;
}

// Visits start on the hour: an agreed 2:30 PM cannot be booked as is, and is not prefilled.
const offHour = (row) => Number.isFinite(row.minutes) && row.minutes % 60 !== 0;

// What "Book it" opens the New appointment form on, from the row alone:
//  - the time only when it is a whole hour (visits start on the hour; 2:00 for an agreed
//    2:30 would book earlier than agreed). Otherwise the form must make the person pick one.
//  - internal notes: the call marker (the booked visit then carries the call, so the row and
//    the booking-miss bell clear under any customer), and what the call said that the form
//    cannot hold: an off-hour agreed time, the part of the day asked for, the stated address.
// The form opens on the customer's usual property, as for any booking: the stated address is
// on the row and in the notes, and the person checks it (owner 2026-10-13, known limit).
export function heldVisitFormDefaults(row) {
  const onTheHour = Number.isFinite(row.minutes) && row.minutes % 60 === 0;
  const address = row.address || {};
  const stated = [address.line1, address.line2, address.city, address.zip].filter(Boolean).join(', ');
  const said = [
    !onTheHour && row.time_label && `Time agreed on the call: ${row.time_label}. Visits start on the hour: agree a whole-hour time with the caller.`,
    row.daypart && `The caller asked for the ${row.daypart}.`,
    stated && `Address stated on the call: ${stated}.`,
  ];
  return {
    date: row.date_et,
    windowStart: onTheHour ? `${String(row.minutes / 60).padStart(2, '0')}:00` : undefined,
    internalNotes: [`Booked from a phone call. Call ID: ${row.call_log_id}.`, ...said].filter(Boolean).join(' '),
    requireTimeChoice: !onTheHour,
  };
}

export default function HeldVisitsStrip({ heldVisits, onBook }) {
  if (!Array.isArray(heldVisits) || heldVisits.length === 0) return null;
  return (
    <section aria-label="From calls, not on the calendar" className="mb-3 md:mb-4 bg-white border-hairline border-zinc-200 rounded-md">
      <h2 className="px-4 py-3 border-b border-hairline border-zinc-200 text-14 font-medium text-ink-primary">
        From calls, not on the calendar
      </h2>
      <ul className="divide-y divide-zinc-200">
        {heldVisits.map((row) => {
          const place = [row.address?.line1, row.address?.line2, row.address?.city].filter(Boolean).join(', ');
          return (
            <li key={row.call_log_id} className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 text-14 text-ink-primary">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="u-nums font-medium">{heldWhen(row)}</span>
                  <span className="font-medium">{row.caller_name}</span>
                  <span className="inline-flex items-center border border-dashed border-zinc-400 rounded-xs px-2 text-14 text-ink-secondary">
                    {kindText(row).tag}
                  </span>
                </div>
                {(place || row.service) && (
                  <div className="text-ink-secondary">{[place, row.service].filter(Boolean).join(' · ')}</div>
                )}
                <div className="text-ink-secondary">
                  {fromCall(row)}
                  {row.phone ? <> · <span className="u-nums">{row.phone}</span></> : null}
                </div>
                {row.notes && <div className="text-ink-secondary">From the call: {row.notes}</div>}
                {offHour(row) && (
                  <div className="text-ink-secondary">
                    Visits start on the hour. Agree a whole-hour time with the caller; the form does not take {row.time_label} and opens with no time selected.
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {row.kind === 'move_day_only' ? (
                  <a
                    href={moveVisitHref(row)}
                    className={cn(buttonStyles({ variant: 'primary', density: 'comfortable' }), 'no-underline')}
                  >
                    {moveLinkLabel(row)}
                  </a>
                ) : (
                  <Button density="comfortable" onClick={() => onBook?.(row)}>Book it</Button>
                )}
                <a
                  href={callHref(row.call_log_id)}
                  className={cn(buttonStyles({ variant: 'secondary', density: 'comfortable' }), 'no-underline')}
                >
                  Open call
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
