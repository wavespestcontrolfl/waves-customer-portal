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
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../ui';
import { Chip } from './FastCompleteParts';
import {
  EMPTY_STATION_MARKS, flagStationMark, mergeHeardStationExceptions, rodentConsumptionHold, stationAutoCounts, stationCheckEntry,
  stationSheetProgram, stationStatusLabel, tapStationMark,
} from '../../lib/station-checks';

const NOT_LOADED = Object.freeze({ state: 'loading', stations: [] });

// The registry as the sheet needs it: the program's active stations, each with
// its number and whether it has a pin on the map (a drift-hidden pin has none:
// the full form leaves it out of the counts and the checks, and so does this).
function registryOf(res, program) {
  // An unavailable map, or a station query that failed, is not "no stations":
  // the full form fails closed on both, and so does the sheet.
  if (!res?.available || res.stationsLoaded === false) return { state: 'failed', stations: [] };
  const stations = (Array.isArray(res.stations) ? res.stations : [])
    .filter((station) => (station.program || 'termite') === program)
    .map((station) => ({
      id: String(station.id),
      number: station.number,
      pinned: !!(station.geometryImage && station.geometryImage.type === 'circle'),
    }))
    .sort((a, b) => Number(a.number) - Number(b.number));
  return { state: 'ready', stations };
}

// The sheet's station state for one visit. `enabled` is the schedule's routing
// (service.stationsFlow); off, the hook is inert and every part answers as
// absent. Reads go through refs so a note's read that lands after the tech
// tapped judges the marks and the registry as they are now.
export function useStationChecks({ service, request, enabled = false, note = '' }) {
  const program = enabled ? stationSheetProgram(service?.typedType) : null;
  const active = enabled && program != null;
  const [registry, setRegistry] = useState(NOT_LOADED);
  const [marks, setMarks] = useState(EMPTY_STATION_MARKS);
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const [attempt, setAttempt] = useState(0);
  const serviceId = service?.id;
  // THE RULE: "all stations OK" is asserted (to the report writer, or to the
  // record as a check for every station) only when the note's station read is
  // KNOWN to have succeeded for the CURRENT note text, or the tech marked the
  // stations by hand and confirmed it. The read has a state per note version:
  // none (not read yet; a changed note is none again), reading, ok, failed.
  // Every assertion below (entries, currentChecks, assertable) goes through it.
  const [read, setRead] = useState({ note: null, status: 'none' });
  const readRef = useRef(read);
  readRef.current = read;
  // The ref moves with the state: the report write reads it in the same breath
  // that the read settles.
  const commitRead = (next) => {
    readRef.current = next;
    setRead(next);
  };
  const [byHand, setByHand] = useState(false);
  const byHandRef = useRef(byHand);
  byHandRef.current = byHand;
  const noteNow = String(note || '').trim();
  const noteRef = useRef(noteNow);
  noteRef.current = noteNow;
  const readStatusNow = () => (readRef.current.note === noteRef.current ? readRef.current.status : 'none');
  const assertableNow = () => byHandRef.current || readStatusNow() === 'ok';
  const readStatus = byHand ? 'hand' : (read.note === noteNow ? read.status : 'none');

  useEffect(() => {
    if (!active || !serviceId) return undefined;
    let cancelled = false;
    setRegistry(NOT_LOADED);
    // The sheet's own base path, as its other reads build theirs.
    const base = `/admin/dispatch/${serviceId}`;
    request(`${base}/property-map`)
      .then((res) => { if (!cancelled) setRegistry(registryOf(res, program)); })
      .catch(() => { if (!cancelled) setRegistry({ state: 'failed', stations: [] }); });
    return () => { cancelled = true; };
  }, [active, serviceId, program, request, attempt]);

  const pinnedOf = (reg) => reg.stations.filter((station) => station.pinned);
  const commit = useCallback((next) => {
    marksRef.current = next;
    setMarks(next);
  }, []);
  // The marks a note's read would leave, without landing them.
  const heardMarks = useCallback((exceptions) => mergeHeardStationExceptions(
    marksRef.current, exceptions, pinnedOf(registryRef.current).map((station) => station.id),
  ), []);
  const countsFor = useCallback((nextMarks) => (
    registryRef.current.state === 'ready'
      ? stationAutoCounts({ program, activeKeys: pinnedOf(registryRef.current).map((station) => station.id), statuses: nextMarks.statuses })
      : null
  ), [program]);

  const pinned = pinnedOf(registry);
  const unpinned = registry.stations.filter((station) => !station.pinned);
  let hold = '';
  if (active) {
    if (registry.state === 'loading') hold = 'Loading the stations…';
    else if (registry.state === 'failed') hold = 'Couldn’t load this property’s stations. Use the Full form.';
    else if (!registry.stations.length) hold = 'No stations are on record for this property. Use the Full form.';
    else if (unpinned.length) {
      hold = `${unpinned.length === 1 ? `Station ${unpinned[0].number} has` : `${unpinned.length} stations have`} no pin on the map. Use the Full form.`;
    }
  }

  // What holds Complete (and a report written from it) until the stations are
  // known: the note's read, or the tech's hand check.
  const readHolds = {
    reading: 'Reading your note for the stations…',
    failed: 'Couldn’t read the stations from your note. Try again, or mark them by hand and tap “Stations checked by hand”.',
    none: 'Your note hasn’t been read for the stations yet. Write the report again.',
  };
  const readHold = active && registry.state === 'ready' && !hold ? (readHolds[readStatus] || '') : '';

  return {
    active,
    program,
    state: registry.state,
    readStatus,
    byHand,
    assertable: assertableNow,
    readHold,
    // How the report write reads the stations: null unless the note is to be read
    // (stations ready, and not checked by hand). The write marks the read
    // starting and settling for the note it read.
    stationRead: active && registry.state === 'ready' && !hold && !byHand
      ? {
        roster: pinned.map((station) => ({ id: station.id, number: station.number })),
        begin: (readNote) => commitRead({ note: String(readNote || '').trim(), status: 'reading' }),
        settle: (ok, readNote) => {
          const forNote = String(readNote || '').trim();
          const prev = readRef.current;
          // A failed refresh never downgrades a note already read.
          if (!ok && prev.note === forNote && prev.status === 'ok') return;
          commitRead({ note: forNote, status: ok ? 'ok' : 'failed' });
        },
      }
      : null,
    confirmByHand: () => { byHandRef.current = true; setByHand(true); },
    readFromNote: () => { byHandRef.current = false; setByHand(false); },
    stations: registry.stations,
    pinned,
    marks,
    // The stations the sheet shows, for the note's read: the server loads the
    // registry itself and names only these.
    roster: active && registry.state === 'ready' && !hold ? pinned.map((station) => ({ id: station.id, number: station.number })) : null,
    counts: active ? countsFor(marks) : null,
    countsFor: active ? countsFor : () => null,
    // `termiteStations` as the full form sends it: an entry per pinned station,
    // and none while the stations are not known (never built from defaults).
    entries: () => (active && assertableNow() && registryRef.current.state === 'ready' && !hold
      ? pinnedOf(registryRef.current).map((station) => stationCheckEntry(station.id, marksRef.current.statuses))
      : []),
    hold,
    // The tech's per-station statuses for the report writer, an exception each
    // by station number (an empty list: every station is OK); null while the
    // stations are not known. Authoritative over what the note says.
    currentChecks: () => (active && assertableNow() && registryRef.current.state === 'ready' && !hold
      ? pinnedOf(registryRef.current)
        .filter((station) => marksRef.current.statuses[station.id])
        .map((station) => ({ number: station.number, status: marksRef.current.statuses[station.id] }))
      : null),
    // The rodent program: a consumption mark beside "None" contradicts itself.
    conflictFor: (values) => (active ? rodentConsumptionHold({ program, statuses: marks.statuses, values }) : null),
    heardMarks,
    applyHeard: (exceptions) => {
      const next = heardMarks(exceptions);
      if (next !== marksRef.current) commit(next);
      return next;
    },
    tap: (id) => commit(tapStationMark(marksRef.current, id)),
    flag: (id) => commit(flagStationMark(marksRef.current, id)),
    retry: () => setAttempt((n) => n + 1),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "N stations, all OK", a chip for each exception (tap to change it), and
// "Flag a station" for one the note did not name.
export function FastCompleteStations({ checks, locked = false }) {
  const titleId = useId();
  const [picking, setPicking] = useState(false);
  if (!checks?.active) return null;
  const { program, state, pinned, marks } = checks;
  const flagged = pinned.filter((station) => marks.statuses[station.id]);
  const unflagged = pinned.filter((station) => !marks.statuses[station.id]);
  const label = (station) => `Station ${station.number}: ${stationStatusLabel(marks.statuses[station.id], program)}`;
  const { readStatus, byHand } = checks;
  const known = byHand || readStatus === 'ok';
  const count = plural(pinned.length, 'station');
  let summary = null;
  if (state === 'loading') summary = 'Loading the stations…';
  else if (checks.hold) summary = checks.hold;
  else if (!known) {
    // Not known: "all OK" is never said before the note was read.
    summary = {
      none: `${count}. Not read from your note yet.`,
      reading: `${count}. Reading your note…`,
      failed: `${count}. Couldn’t read them from your note.`,
    }[readStatus];
  } else if (byHand) summary = `${count}, checked by hand${flagged.length ? `, ${flagged.length} flagged, the rest OK` : ', all OK'}`;
  else if (!flagged.length) summary = `${count}, all OK`;
  else summary = `${count}, ${flagged.length} flagged, the rest OK`;
  return (
    <section className="tech-visit-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="tech-visit-section-title">Bait stations</h3>
      <p className={(checks.hold && state !== 'loading') || readStatus === 'failed' ? 'tech-visit-muted tech-visit-status--warn' : 'tech-lane-value'} role="status">{summary}</p>
      {state === 'failed' && (
        <Button type="button" variant="ghost" className="tech-visit-action" disabled={locked} onClick={checks.retry}>Load the stations again</Button>
      )}
      {state === 'ready' && !checks.hold && (
        <>
          {flagged.length > 0 && (
            <div className="tech-visit-tile-grid" role="group" aria-label="Flagged stations">
              {flagged.map((station) => (
                <Chip key={station.id} label={label(station)} pressed disabled={locked} onClick={() => checks.tap(station.id)} />
              ))}
            </div>
          )}
          {flagged.map((station) => (marks.quotes[station.id]
            ? <p key={station.id} className="tech-visit-muted">{`Station ${station.number}: “${marks.quotes[station.id]}”`}</p>
            : null))}
          {flagged.length > 0 && (
            <p className="tech-visit-muted">
              {`Tap a chip to change it: ${stationStatusLabel('activity', program)}, Serviced, No access, then back to OK.`}
            </p>
          )}
          {readStatus === 'failed' && (
            <p className="tech-visit-muted">Tap Try again below to read your note again. Or mark each station that needs it, then confirm.</p>
          )}
          {!byHand && readStatus !== 'reading' && (readStatus === 'failed' || readStatus === 'none') && (
            <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked} onClick={checks.confirmByHand}>
              Stations checked by hand
            </Button>
          )}
          {byHand && (
            <Button type="button" variant="ghost" className="tech-visit-action" disabled={locked} onClick={checks.readFromNote}>Read the stations from my note instead</Button>
          )}
          {unflagged.length > 0 && (
            <Button type="button" variant="ghost" className="tech-visit-action" aria-expanded={picking} disabled={locked} onClick={() => setPicking(!picking)}>
              Flag a station
            </Button>
          )}
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
      )}
    </section>
  );
}
