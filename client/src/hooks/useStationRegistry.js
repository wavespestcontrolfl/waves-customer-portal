// The property's station registry for one visit (GET /admin/dispatch/:id/property-map),
// as the Fast Complete sheet needs it (GATE_STATION_FAST_COMPLETE): the program's
// active stations, each with its number and whether it has a pin on the map (a
// drift-hidden pin has none: the full form leaves it out of the counts and the
// checks, and so does the sheet).
import { useEffect, useRef, useState } from 'react';

const NOT_LOADED = Object.freeze({ state: 'loading', stations: [] });
const FAILED = Object.freeze({ state: 'failed', stations: [] });

export function registryOf(res, program) {
  // An unavailable map, or a station query that failed, is not "no stations":
  // the full form fails closed on both, and so does the sheet.
  if (!res?.available || res.stationsLoaded === false) return FAILED;
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

// What stops the sheet judging the stations, in the sheet's words (each names the
// Full form where only it can help); '' when the registry is usable.
export function registryHold(registry) {
  const unpinned = registry.stations.filter((station) => !station.pinned);
  const holds = [
    [registry.state === 'loading', 'Loading the stations…'],
    [registry.state === 'failed', 'Couldn’t load this property’s stations. Use the Full form.'],
    [!registry.stations.length, 'No stations are on record for this property. Use the Full form.'],
    [unpinned.length, `${unpinned.length === 1 ? `Station ${unpinned[0]?.number} has` : `${unpinned.length} stations have`} no pin on the map. Use the Full form.`],
  ];
  return (holds.find(([stops]) => stops) || [])[1] || '';
}

export default function useStationRegistry({ serviceId, request, program, active }) {
  const [registry, setRegistry] = useState(NOT_LOADED);
  const [attempt, setAttempt] = useState(0);
  // Read through a ref by calls that land after a render.
  const registryRef = useRef(registry);
  registryRef.current = registry;

  useEffect(() => {
    if (!active || !serviceId) return undefined;
    let cancelled = false;
    setRegistry(NOT_LOADED);
    // The sheet's own base path, as its other reads build theirs.
    const base = `/admin/dispatch/${serviceId}`;
    request(`${base}/property-map`)
      .then((res) => { if (!cancelled) setRegistry(registryOf(res, program)); })
      .catch(() => { if (!cancelled) setRegistry(FAILED); });
    return () => { cancelled = true; };
  }, [active, serviceId, program, request, attempt]);

  return { registry, registryRef, reload: () => setAttempt((n) => n + 1) };
}
