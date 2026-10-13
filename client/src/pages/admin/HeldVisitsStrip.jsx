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
import React from 'react';
import { Button, buttonStyles, cn } from '../../components/ui';
import { formatETDate, formatETTime } from '../../lib/timezone';

// Same deep link the notification triggers and the Follow-through cards use.
export const callHref = (callLogId) => `/admin/communications#tab=calls&call=${encodeURIComponent(callLogId)}`;

// What the call established, by kind. A day-only row is never called a promise.
const KIND_TEXT = {
  confirmed: { lead: 'Promised on a call', tag: 'PROMISED · not booked' },
  day_only: { lead: 'Day discussed on a call', tag: 'NOT CONFIRMED · not booked' },
};
const kindText = (row) => KIND_TEXT[row.kind] || KIND_TEXT.day_only;

function fromCall(row) {
  if (!row.call_at) return kindText(row).lead;
  const day = formatETDate(row.call_at, { weekday: 'long' });
  return `${kindText(row).lead} ${day}, ${formatETTime(row.call_at)}`;
}

// Visits start on the hour: an agreed 2:30 PM cannot be booked as is, and is not prefilled.
const offHour = (row) => Number.isFinite(row.minutes) && row.minutes % 60 !== 0;

export default function HeldVisitsStrip({ heldVisits, onBook }) {
  if (!Array.isArray(heldVisits) || heldVisits.length === 0) return null;
  return (
    <section aria-label="From calls, not on the calendar" className="mb-3 md:mb-4 bg-white border-hairline border-zinc-200 rounded-md">
      <h2 className="px-4 py-3 border-b border-hairline border-zinc-200 text-14 font-medium text-ink-primary">
        From calls, not on the calendar
      </h2>
      <ul className="divide-y divide-zinc-200">
        {heldVisits.map((row) => {
          const place = [row.address?.line1, row.address?.city].filter(Boolean).join(', ');
          return (
            <li key={row.call_log_id} className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 text-14 text-ink-primary">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="u-nums font-medium">{row.time_label || 'Time not set'}</span>
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
                {offHour(row) && (
                  <div className="text-ink-secondary">
                    Visits start on the hour. Agree a whole-hour time with the caller before you book; the form does not take {row.time_label}.
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button density="comfortable" onClick={() => onBook?.(row)}>Book it</Button>
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
