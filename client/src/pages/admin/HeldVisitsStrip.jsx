// client/src/pages/admin/HeldVisitsStrip.jsx
//
// "From calls, not on the calendar" strip for the admin Dispatch day view
// (GATE_CALL_HELD_VISIT, owner 2026-10-12). It writes nothing itself: Book it and
// Dismiss hand the row to the page. Kinds of row:
//   confirmed - staff and the caller agreed this day and time on a recorded
//               call, and nothing on the calendar carries it ("Promised").
//   day_only  - this day was asked for or offered on a call with no agreed
//               time. It is NOT a confirmed visit; the row says "Day discussed"
//               and staff decide whether to book it. "Book it" hands the row to the page, which opens the existing
// New appointment modal. Renders nothing for an empty list.
//   move_day_only - staff and an existing customer agreed to MOVE a visit to this day with no
//               time (owner 2026-10-19). NOT CONFIRMED; the row says which day it moves from.
//               It books nothing: the button opens the visit to move, and the office moves it.
// Every row also offers (owner 2026-11-01): Call (the staff-phone bridge rings your phone
// first), Text (the text box with the caller's number filled in; nothing sends until Send),
// Dismiss (asks once; the page tells the server the office will not book it), and a link to
// the call's recording and transcript.
import React, { useEffect, useRef, useState } from 'react';
import { Button, buttonStyles, cn } from '../../components/ui';
import { callViaBridge } from '../../components/admin/CallBridgeLink';
import { formatETDate, formatETDateOnly, formatETTime } from '../../lib/timezone';

// Same deep link the notification triggers and the Follow-through cards use.
export const callHref = (callLogId) => `/admin/communications#tab=calls&call=${encodeURIComponent(callLogId)}`;

// The Communications text box with this number filled in (the Portal inbox's deep link).
export const textHref = (phone) => `/admin/communications?phone=${encodeURIComponent(phone)}&action=sms#tab=sms`;

// What Dismiss asks before it acts. A confirmed row names the promise the caller holds.
const DISMISS_QUESTION = {
  confirmed: 'Not booking it? The caller expects this visit.',
  day_only: 'Not booking it?',
  move_day_only: 'Not moving it?',
};
export const dismissQuestion = (row) => DISMISS_QUESTION[row.kind] || DISMISS_QUESTION.day_only;

// What the call established, by kind. A day-only row is never called a promise.
const KIND_TEXT = {
  confirmed: { lead: 'Promised on a call', tag: 'PROMISED · not booked' },
  day_only: { lead: 'Day discussed on a call', tag: 'NOT CONFIRMED · not booked' },
  move_day_only: { lead: 'Move discussed on a call', tag: 'NOT CONFIRMED · not moved' },
};
export const kindText = (row) => KIND_TEXT[row.kind] || KIND_TEXT.day_only;

// The time column: the agreed time, else "Time not set" with the part of the day asked for.
export const heldWhen = (row) => row.time_label || (row.daypart ? `Time not set · asked for the ${row.daypart}` : 'Time not set');

// GATE_CALL_PREPAY_CHOICE: the plan the caller chose on the call (the server adds billing_choice to the row only with the gate on).
const BILLING_CHOICE_TEXT = { annual_prepay: 'Caller chose annual prepay', per_application: 'Caller chose to pay per application' };
export const billingChoiceText = (row) => BILLING_CHOICE_TEXT[row.billing_choice] || null;

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
    // The caller chose annual prepay: the form preselects it once the customer's linked estimate is prepay-eligible. The server
    // still enforces eligibility and pricing on save.
    ...(row.billing_choice === 'annual_prepay' ? { annualPrepay: true } : {}),
  };
}

// One row's buttons. Book it reads "Opening…" while the page loads the customer, so a slow
// lookup never looks like a dead button. Dismiss asks once, then waits for the server; a
// failure stays on the row.
function RowActions({ row, opening, onBookRow, onDismiss }) {
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dismiss = async () => {
    setSaving(true);
    setError('');
    try {
      await onDismiss(row);
    } catch (err) {
      if (mounted.current) setError(err?.message || 'Could not dismiss. Try again.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const secondaryLink = cn(buttonStyles({ variant: 'secondary', density: 'comfortable' }), 'no-underline');
  return (
    <div className="flex shrink-0 flex-col gap-2 md:items-end">
      <div className="flex flex-wrap items-center gap-2">
        {row.kind === 'move_day_only' ? (
          <a
            href={moveVisitHref(row)}
            className={cn(buttonStyles({ variant: 'primary', density: 'comfortable' }), 'no-underline')}
          >
            {moveLinkLabel(row)}
          </a>
        ) : (
          <Button density="comfortable" disabled={opening === row.call_log_id} onClick={() => onBookRow(row)}>
            {opening === row.call_log_id ? 'Opening…' : 'Book it'}
          </Button>
        )}
        {row.phone && (
          <>
            <Button variant="secondary" density="comfortable" onClick={() => callViaBridge(row.phone, row.caller_name, undefined, row.customer_id)}>
              Call
            </Button>
            <a href={textHref(row.phone)} className={secondaryLink}>Text</a>
          </>
        )}
        {onDismiss && !asking && (
          <Button variant="ghost" density="comfortable" onClick={() => { setAsking(true); setError(''); }}>Dismiss</Button>
        )}
      </div>
      {asking && (
        <div role="group" aria-label={`Dismiss ${row.caller_name}`} className="flex flex-wrap items-center gap-2 text-14 text-ink-secondary">
          <span>{dismissQuestion(row)}</span>
          <Button variant="secondary" density="comfortable" loading={saving} onClick={dismiss}>
            {saving ? 'Dismissing…' : 'Yes, dismiss'}
          </Button>
          <Button variant="ghost" density="comfortable" disabled={saving} onClick={() => setAsking(false)}>Keep</Button>
        </div>
      )}
      {error && <div role="alert" className="text-14 text-alert-fg">{error}</div>}
      <a href={callHref(row.call_log_id)} className="text-14 text-ink-secondary underline">Recording &amp; transcript</a>
    </div>
  );
}

export default function HeldVisitsStrip({ heldVisits, onBook, onDismiss }) {
  // The row whose Book it is loading its customer. A newer press on another row takes over
  // (the page opens the form only for the newest press), so only the newest press clears it.
  const [opening, setOpening] = useState(null);
  const latestPress = useRef(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!Array.isArray(heldVisits) || heldVisits.length === 0) return null;
  const book = async (row) => {
    const press = {};
    latestPress.current = press;
    setOpening(row.call_log_id);
    try {
      await onBook?.(row);
    } finally {
      if (mounted.current && latestPress.current === press) setOpening(null);
    }
  };
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
                {billingChoiceText(row) && <div className="text-ink-secondary">{billingChoiceText(row)}</div>}
                {offHour(row) && (
                  <div className="text-ink-secondary">
                    Visits start on the hour. Agree a whole-hour time with the caller; the form does not take {row.time_label} and opens with no time selected.
                  </div>
                )}
              </div>
              <RowActions row={row} opening={opening} onBookRow={book} onDismiss={onDismiss} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
