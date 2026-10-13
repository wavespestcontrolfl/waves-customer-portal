// client/src/pages/admin/HeldVisitsStrip.jsx
//
// "Promised on a call, not booked" strip for the admin Dispatch day view
// (GATE_CALL_HELD_VISIT, owner 2026-10-12). Display only: each row is a visit
// staff agreed with a caller on a recorded call that nothing on the calendar
// carries yet. "Book it" hands the row to the page, which opens the existing
// New appointment modal. Renders nothing for an empty list.
import React from 'react';
import { Button, buttonStyles, cn } from '../../components/ui';
import { formatETDate, formatETTime } from '../../lib/timezone';

// Same deep link the notification triggers and the Follow-through cards use.
export const callHref = (callLogId) => `/admin/communications#tab=calls&call=${encodeURIComponent(callLogId)}`;

function promisedOn(callAt) {
  if (!callAt) return '';
  const day = formatETDate(callAt, { weekday: 'long' });
  return `Promised on a call ${day}, ${formatETTime(callAt)}`;
}

export default function HeldVisitsStrip({ heldVisits, onBook }) {
  if (!Array.isArray(heldVisits) || heldVisits.length === 0) return null;
  return (
    <section aria-label="Promised on a call, not booked" className="mb-3 md:mb-4 bg-white border-hairline border-zinc-200 rounded-md">
      <h2 className="px-4 py-3 border-b border-hairline border-zinc-200 text-14 font-medium text-ink-primary">
        Promised on a call, not booked
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
                    HELD · not booked
                  </span>
                </div>
                {(place || row.service) && (
                  <div className="text-ink-secondary">{[place, row.service].filter(Boolean).join(' · ')}</div>
                )}
                <div className="text-ink-secondary">
                  {promisedOn(row.call_at)}
                  {row.phone ? <> · <span className="u-nums">{row.phone}</span></> : null}
                </div>
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
