// The tech's marks on the stations (what the note named, what they tapped) and
// the typed counts they give (lib/station-checks.js), for one visit.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_STATION_MARKS, flagStationMark, mergeHeardStationExceptions, stationAutoCounts, tapStationMark,
} from '../lib/station-checks';

const pinnedIds = (registry) => registry.stations.filter((station) => station.pinned).map((station) => station.id);

export default function useStationMarks({ program, registry, registryRef }) {
  const [marks, setMarks] = useState(EMPTY_STATION_MARKS);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const commit = useCallback((next) => {
    marksRef.current = next;
    setMarks(next);
  }, []);

  // A station that left the registry takes its mark with it.
  const idsKey = pinnedIds(registry).join(',');
  useEffect(() => {
    if (registry.state !== 'ready') return;
    const live = new Set(idsKey.split(','));
    const gone = Object.keys(marksRef.current.statuses).filter((id) => !live.has(id));
    if (!gone.length) return;
    const drop = (map) => Object.fromEntries(Object.entries(map).filter(([id]) => live.has(id)));
    const current = marksRef.current;
    commit({ statuses: drop(current.statuses), quotes: drop(current.quotes), picked: drop(current.picked) });
  }, [idsKey, registry.state, commit]);

  // The marks a note's read would leave, without landing them.
  const heardMarks = useCallback(
    (exceptions) => mergeHeardStationExceptions(marksRef.current, exceptions, pinnedIds(registryRef.current)),
    [registryRef],
  );
  const countsFor = useCallback((next) => (
    registryRef.current.state === 'ready'
      ? stationAutoCounts({ program, activeKeys: pinnedIds(registryRef.current), statuses: next.statuses })
      : null
  ), [program, registryRef]);

  return {
    marks,
    marksRef,
    heardMarks,
    countsFor,
    applyHeard: (exceptions) => {
      const next = heardMarks(exceptions);
      if (next !== marksRef.current) commit(next);
      return next;
    },
    tap: (id) => commit(tapStationMark(marksRef.current, id)),
    flag: (id) => commit(flagStationMark(marksRef.current, id)),
  };
}
