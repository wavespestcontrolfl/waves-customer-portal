// client/src/components/tech/FastCompleteStations.jsx
//
// Bait station checks on the one-screen Fast Complete sheet
// (GATE_STATION_FAST_COMPLETE, owner 2026-10-08). With the station map on, the
// full form records a check for every station: each defaults to OK and the
// tech taps only the exceptions. The sheet does the same without the map:
//  - it loads the property's station registry (GET /admin/dispatch/:id/property-map)
//    and shows "N stations, all OK";
//  - the tech's note names exceptions by station number ("station 4 had
//    activity, I replaced the bait in 7"); the server reads them from the note
//    (typed-facts, services/visit-station-facts.js), verified in code, and each
//    shows here as a chip with the words it came from;
//  - a tap on a chip cycles ok, activity, serviced, no access (the rodent
//    program reads "Consumption"); "Flag a station" marks one the note did
//    not name. A fact the tech says out loud comes from talk-to-text, never a
//    new mandatory tap (owner ruling the same day).
// The completion posts `termiteStations` as the full form does (an entry per
// pinned station, `touched` on exceptions) and the typed station counts from
// the one shared rule (lib/station-checks.js stationAutoCounts).
// Adding, moving or retiring a station stays on the full form, and so does a
// visit this section cannot judge: a registry that failed to load, no station
// on record, or a station with no pin (hold: "Use the Full form").
// Scope: termite_bait_station and rodent_bait_station only; a rodent trap
// check (rodent_trapping) keeps the full form, its setup and serviced rules
// differ.
import React, { useId, useState } from 'react';
import { Button } from '../ui';
import { Chip } from './FastCompleteParts';
import useStationRegistry, { registryHold } from '../../hooks/useStationRegistry';
import useStationReadState from '../../hooks/useStationReadState';
import useStationMarks from '../../hooks/useStationMarks';
import { READ_FAILED_MESSAGES, READ_VIEW, stationSummary } from '../../lib/station-read-state';
import {
  rodentConsumptionHold, stationCheckEntry, stationSheetProgram, stationStatusLabel,
} from '../../lib/station-checks';

// How a report write reads the stations when it is not to (a visit with no
// stations, or the stations checked by hand): nothing to ask, nothing to settle.
export const NO_STATION_READ = Object.freeze({ body: () => ({}), begin: () => {}, check: () => '' });

// The state machine's event for how a read ended.
const settlement = (ok, detail, note) => {
  if (ok) return { type: 'readSucceeded', note };
  return detail === 'roster_changed' ? { type: 'rosterChanged', note } : { type: 'readFailed', note, detail };
};

// What a visit with no stations allows: nothing held.
export const NO_STATION_GATE = Object.freeze({ generate: '', complete: '' });

// The station state for one visit, composed from the registry (the property's
// stations), the note's read (a state machine) and the tech's marks. `enabled` is
// the schedule's routing (service.stationsFlow); off, every part answers as absent.
export function useStationChecks({ service, request, enabled = false, note = '' }) {
  const program = enabled ? stationSheetProgram(service?.typedType) : null;
  const active = enabled && program != null;
  const { registry, registryRef, reload } = useStationRegistry({ serviceId: service?.id, request, program, active });
  const read = useStationReadState(note);
  const marks = useStationMarks({ program, registry, registryRef });

  const hold = active ? registryHold(registry) : '';
  const ready = active && registry.state === 'ready' && !hold;
  const pinned = registry.stations.filter((station) => station.pinned);
  const view = READ_VIEW[read.status];
  // The stations are KNOWN: the note's read succeeded for this note, or the tech
  // checked them by hand. Everything asserted goes through this.
  const known = () => ready && READ_VIEW[read.statusNow()].known;
  const statuses = () => marks.marksRef.current.statuses;
  const roster = pinned.map((station) => ({ id: station.id, number: station.number }));

  const stationRead = ready && read.status !== 'hand' ? {
    roster,
    body: () => ({ stations: roster }),
    begin: (readNote) => read.send({ type: 'readStarted', note: readNote }),
    // Settles the read for the note it read; '' when it succeeded, else why not.
    // An 'unresolved' read still brings the exceptions that did verify, marked on
    // the chips for the tech to confirm or change.
    check: (facts, readNote) => {
      const { stationRead: verdict, stationReadDetail: detail } = facts;
      read.send(settlement(verdict === 'read', detail, readNote));
      if (detail === 'roster_changed') reload();
      if (detail === 'unresolved' && facts.stationExceptions) marks.applyHeard(facts.stationExceptions);
      return verdict === 'read' ? '' : (READ_FAILED_MESSAGES[detail] || READ_FAILED_MESSAGES.default);
    },
  } : NO_STATION_READ;

  return {
    active,
    program,
    state: registry.state,
    hold,
    pinned,
    marks: marks.marks,
    readStatus: read.status,
    byHand: read.status === 'hand',
    // The card shows before a report exists when the read failed or was done by hand.
    cardOpen: active && view.opensCard,
    // What may happen now: Generate waits on the registry; Complete on the stations
    // being known, then on a consumption mark beside "None".
    gate: {
      generate: hold,
      complete: (ready && view.hold) || '',
      conflict: (values) => (active ? rodentConsumptionHold({ program, statuses: marks.marks.statuses, values }) : null) || '',
    },
    stationRead,
    counts: active ? marks.countsFor(marks.marks) : null,
    countsFor: active ? marks.countsFor : () => null,
    heardMarks: marks.heardMarks,
    applyHeard: marks.applyHeard,
    // `termiteStations` as the full form sends it: an entry per pinned station, and
    // none while the stations are not known (never built from defaults).
    entries: () => (known() ? pinned.map((station) => stationCheckEntry(station.id, statuses())) : []),
    // The tech's per-station statuses for the report writer, an exception each by
    // station number (an empty list: every station is OK); null while the stations
    // are not known. Authoritative over what the note says.
    currentChecks: () => (known()
      ? pinned.filter((station) => statuses()[station.id]).map((station) => ({ number: station.number, status: statuses()[station.id] }))
      : null),
    tap: marks.tap,
    flag: marks.flag,
    confirmByHand: () => read.send({ type: 'handConfirmed' }),
    readFromNote: () => read.send({ type: 'handCleared' }),
    reloadRegistry: reload,
  };
}

// The chips for what is flagged, the words each came from, and how to change one.
function FlaggedStations({ checks, flagged, locked }) {
  const { program, marks } = checks;
  return (
    <>
      <div className="tech-visit-tile-grid" role="group" aria-label="Flagged stations">
        {flagged.map((station) => (
          <Chip
            key={station.id}
            label={`Station ${station.number}: ${stationStatusLabel(marks.statuses[station.id], program)}`}
            pressed
            disabled={locked}
            onClick={() => checks.tap(station.id)}
          />
        ))}
      </div>
      {flagged.filter((station) => marks.quotes[station.id]).map((station) => (
        <p key={station.id} className="tech-visit-muted">{`Station ${station.number}: “${marks.quotes[station.id]}”`}</p>
      ))}
      <p className="tech-visit-muted">
        {`Tap a chip to change it: ${stationStatusLabel('activity', program)}, Serviced, No access, then back to OK.`}
      </p>
    </>
  );
}

// "Flag a station" for one the note did not name.
function FlagPicker({ checks, unflagged, locked }) {
  const [picking, setPicking] = useState(false);
  if (!unflagged.length) return null;
  return (
    <>
      <Button type="button" variant="ghost" className="tech-visit-action" aria-expanded={picking} disabled={locked} onClick={() => setPicking(!picking)}>
        Flag a station
      </Button>
      {picking && (
        <div className="tech-visit-tile-grid" role="group" aria-label="Flag a station">
          {unflagged.map((station) => (
            <Chip
              key={station.id}
              label={`Station ${station.number}`}
              pressed={false}
              disabled={locked}
              onClick={() => { checks.flag(station.id); setPicking(false); }}
            />
          ))}
        </div>
      )}
    </>
  );
}

// What the read's status offers, from READ_VIEW: the hand check and its undo.
function ReadActions({ checks, view, locked }) {
  return (
    <>
      {view.retryHint && (
        <p className="tech-visit-muted">Tap Try again below to read your note again. Or mark each station that needs it, then confirm.</p>
      )}
      {view.handButton && (
        <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked} onClick={checks.confirmByHand}>
          Stations checked by hand
        </Button>
      )}
      {view.undoButton && (
        <Button type="button" variant="ghost" className="tech-visit-action" disabled={locked} onClick={checks.readFromNote}>Read the stations from my note instead</Button>
      )}
    </>
  );
}

// The stations card: "N stations, all OK" (said only when the stations are
// known), a chip for each exception (tap to change it), and "Flag a station".
// Rendered by the report step whenever present; `shown` is whether the report is
// on screen (the card also shows before a report when its read failed).
export function StationCard({ checks, locked = false, shown = true }) {
  const titleId = useId();
  if (!checks?.active || !(shown || checks.cardOpen)) return null;
  const { marks, pinned } = checks;
  const flagged = pinned.filter((station) => marks.statuses[station.id]);
  const unflagged = pinned.filter((station) => !marks.statuses[station.id]);
  const view = READ_VIEW[checks.readStatus];
  const usable = checks.state === 'ready' && !checks.hold;
  const summary = stationSummary({
    registryState: checks.state, hold: checks.hold, readStatus: checks.readStatus, count: pinned.length, flagged: flagged.length,
  });
  const warn = (checks.hold && checks.state !== 'loading') || view.warn;
  return (
    <section className="tech-visit-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="tech-visit-section-title">Bait stations</h3>
      <p className={warn ? 'tech-visit-muted tech-visit-status--warn' : 'tech-lane-value'} role="status">{summary}</p>
      {checks.state === 'failed' && (
        <Button type="button" variant="ghost" className="tech-visit-action" disabled={locked} onClick={checks.reloadRegistry}>Load the stations again</Button>
      )}
      {usable && flagged.length > 0 && <FlaggedStations checks={checks} flagged={flagged} locked={locked} />}
      {usable && <ReadActions checks={checks} view={view} locked={locked} />}
      {usable && <FlagPicker checks={checks} unflagged={unflagged} locked={locked} />}
    </section>
  );
}
