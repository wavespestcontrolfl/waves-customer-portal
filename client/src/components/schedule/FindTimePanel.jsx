// Dispatch "Find a time" panel (GATE_DISPATCH_FIND_TIME_PANEL, owner
// 2026-10-21, option C): the office is on the phone with a NEW caller, so
// there is no customer record yet. Type the service address, pick a length,
// and the best hours for that address show at once: the best 4 on the picked
// date and the best 4 in the next 7 days (the same chips and numbers as the
// New Appointment time box; useBestTimes with summary + bestRows on an
// address alone). Tap a chip, then Book: New Appointment opens with that
// day and hour and the address already in its New customer block.
// This panel writes nothing — no customer, no visit — and it never ranks near
// the caller's own other visits (a new caller has none).
//
// The length is a plain select, not the Service Library search: the engine
// only needs minutes, and the catalog typeahead is heavy for a phone call.
// `enabled` is the gate; off renders nothing at all.

import { useEffect, useMemo, useState } from 'react';
import AddressAutocomplete from '../AddressAutocomplete';
import {
  Button, Field, Select, Input, Sheet, SheetHeader, SheetBody, UiSurface, inputStyles, useUiDensity,
} from '../ui';
import { etDateString } from '../../lib/timezone';
import { useBestTimes } from './useBestTimes';
import { BestRow, fmtDay, fmtHour } from './AvailabilityStrip';

const LENGTHS = [30, 45, 60, 90, 120, 180];
const DEFAULT_LENGTH = 60;

// The one line shown in place of the results.
function statusNote({ target, checking, gated, best }) {
  if (!target) return { text: 'Pick the address from the list to see the best times.' };
  if (checking && !best) return { text: 'Checking routes…' };
  if (checking || best) return null;
  if (gated) return { testId: 'find-time-off', text: 'Best times are off.' };
  return { text: 'No times came back. Check the address and try again.' };
}

const hourKey = (hour) => (hour ? `${hour.date}|${String(hour.start).slice(0, 5)}|${hour.technicianId || ''}` : '');

export default function FindTimePanel({ enabled = false, onBook }) {
  const [open, setOpen] = useState(false);
  if (!enabled) return null;
  // UiSurface sets the 14px / 44px touch density for the button and, through
  // the portal, for the Sheet and every control in it.
  return (
    <UiSurface density="comfortable" className="inline-block">
      <Button variant="secondary" data-testid="find-time-open" onClick={() => setOpen(true)}>
        Find a time
      </Button>
      {open && <FindTimeDrawer onClose={() => setOpen(false)} onBook={onBook} />}
    </UiSurface>
  );
}

function FindTimeDrawer({ onClose, onBook }) {
  const density = useUiDensity();
  const today = etDateString();
  const [addressText, setAddressText] = useState('');
  // The address the search stands on: set only when a suggestion is picked
  // (or the field blurs and Google geocodes it), never from half-typed text.
  const [target, setTarget] = useState(null);
  const [date, setDate] = useState(today);
  const [length, setLength] = useState(DEFAULT_LENGTH);
  const [selected, setSelected] = useState(null);

  const { availability, checking, gated } = useBestTimes({
    date,
    durationMinutes: length,
    enabled: !!target,
    addressOnly: true,
    address: target?.formatted,
    lat: target?.lat ?? undefined,
    lng: target?.lng ?? undefined,
    summary: true,
    bestRows: true,
  });
  const best = availability?.best || null;
  // Mid re-check the rows are the previous answer's (another date or length):
  // show them dimmed, but take no pick and no Book until the new answer lands.
  const stale = !!availability?.stale;
  const note = statusNote({ target, checking, gated, best });

  // A new place, date or length is a new question: the old pick no longer applies.
  useEffect(() => { setSelected(null); }, [target, date, length]);

  const shown = useMemo(() => [...(best?.day || []), ...(best?.week || [])], [best]);
  const selectedHour = shown.find((hour) => hourKey(hour) === selected) || null;

  const book = () => {
    if (!selectedHour || !target || stale) return;
    // Day and hour only (Codex #6411 r1): the panel knows no service, so it
    // must not pin the chip's technician (who may not perform it) or its
    // length (the catalog sets the saved one). New Appointment's own time
    // box re-checks this hour for the real service and compares technicians.
    onBook?.({
      date: selectedHour.date,
      windowStart: String(selectedHour.start).slice(0, 5),
      quickAddAddress: { address: target.line1, city: target.city, state: target.state, zip: target.zip },
    });
    // The drawer's answer is about to go stale (this hour may be booked next).
    onClose();
  };

  const pick = (hour) => setSelected(hourKey(hour));
  const isCurrent = (hour) => hourKey(hour) === selected;

  return (
    // The Sheet owns the portal, the backdrop, Escape, the focus trap, the page
    // scroll lock and the top and bottom safe-area padding (full height on a phone).
    <Sheet open onClose={onClose} width="sm" ariaLabel="Find a time">
      <SheetHeader>
        <h2 className="text-18 font-medium text-ink-primary">Find a time</h2>
        <Button variant="ghost" aria-label="Close" onClick={onClose}>Close</Button>
      </SheetHeader>
      <SheetBody className="space-y-4">
        <Field label="Service address" id="find-time-address">
          <AddressAutocomplete
            value={addressText}
            onChange={(val) => { setAddressText(val); setTarget(null); }}
            onSelect={(parts) => {
              // Keep an apartment / unit (line2) on the street line: New customer's
              // quick-add has one address line, and a lost unit is a wrong address.
              const line1 = [parts.line1 || parts.formatted || '', parts.line2].filter(Boolean).join(' ');
              setAddressText(line1);
              setTarget({
                formatted: parts.formatted || [line1, parts.city, parts.state, parts.zip].filter(Boolean).join(', '),
                line1,
                city: parts.city || '',
                state: parts.state || 'FL',
                zip: parts.zip || '',
                lat: parts.lat ?? null,
                lng: parts.lng ?? null,
              });
            }}
            appearance="admin"
            className={inputStyles({ density })}
            placeholder="Start typing the address"
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Visit length (for the search)" id="find-time-length">
            <Select value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {LENGTHS.map((m) => <option key={m} value={m}>{m} min</option>)}
            </Select>
          </Field>
          <Field label="Day" id="find-time-date">
            <Input
              type="date"
              min={today}
              value={date}
              onChange={(e) => { if (e.target.value >= today) setDate(e.target.value); }}
            />
          </Field>
        </div>

        {note && <div data-testid={note.testId} className="text-ui-body text-ink-secondary">{note.text}</div>}
        {best && (
          <div data-testid="find-time-results" className={stale ? 'opacity-60' : undefined}>
            <BestRow
              title={`Best on ${fmtDay(availability?.pickedDate || date)}`}
              hours={best.day}
              withDay={false}
              empty="No open hours that day."
              isCurrent={isCurrent}
              onPick={stale ? undefined : pick}
              stopNames={availability?.chipStopNames === true}
            />
            {best.weekCovered !== false && (
              <BestRow
                title="Best in the next 7 days"
                hours={best.week}
                withDay
                empty="Nothing fits in the next 7 days."
                isCurrent={isCurrent}
                onPick={stale ? undefined : pick}
                stopNames={availability?.chipStopNames === true}
              />
            )}
            <div className="mt-4 space-y-2">
              <Button
                className="w-full"
                data-testid="find-time-book"
                disabled={!selectedHour || stale}
                onClick={book}
              >
                {selectedHour ? `Book ${fmtDay(selectedHour.date)} · ${fmtHour(selectedHour.start)}` : 'Tap a time to book it'}
              </Button>
              <div className="text-ui-caption text-ink-secondary">
                Opens New Appointment with this day, hour and address. Pick the service there: its time box checks the hour and the technician. Nothing is saved until you save there.
              </div>
            </div>
          </div>
        )}
      </SheetBody>
    </Sheet>
  );
}
