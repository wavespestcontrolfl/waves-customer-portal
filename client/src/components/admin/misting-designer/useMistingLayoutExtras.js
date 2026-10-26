// State for the points that are not on the drawn lines: risers, the pump and no-mist zones.
//
// They are independent of the lines. Drawing, undoing or clearing lines never touches them, and
// Edit nozzles never touches them. "Clear risers, zones and pump" is their own button, with its own
// one-step Undo notice (a separate notice from the lines one, because it restores a different thing).
//
// The in-zone flags are derived from the CURRENT nozzles, risers and zones on every render
// (flagInZones); nothing about a flag is stored.
//
// The risers this hook returns are every riser on the map: the ones along bed lines (derived by the layout state, passed in
// as `bedRisers`, source 'bed') and the ones staff dropped (kept here, source 'manual'). Moving or deleting a bed riser is
// an edit overlay the layout state owns; this hook's riser operations are for manual risers.
import { useMemo, useRef, useState } from 'react';
import {
  DEFAULT_ZONE_KIND,
  NO_EXTRAS,
  addRiser,
  addZone,
  deleteRiser,
  deleteZone,
  extrasCount,
  feetToPx,
  flagInZones,
  hitZoneIndex,
  moveRiser,
  setPump,
  setPumpCheck,
} from '../../../lib/mistingLayoutExtras';
import { scaleExtras } from '../../../lib/mistingLayoutZoom';

const NO_FLAGS = Object.freeze({ nozzleKeys: new Set(), riserKeys: new Set() });
const point = (p) => ({ x: p.x, y: p.y });

// `initial` is the risers, pump and zones of a reopened saved layout, with the key counter to continue from.
export default function useMistingLayoutExtras(mapState, nozzles, bedRisers, initial = null) {
  const [extras, setExtras] = useState(initial ? { risers: initial.risers, pump: initial.pump, zones: initial.zones } : NO_EXTRAS);
  const [zoneKind, setZoneKind] = useState(DEFAULT_ZONE_KIND);
  const [clearedExtras, setClearedExtras] = useState(null); // { count, snapshot }
  const idRef = useRef(initial ? initial.idCounter : 0);
  const nextKey = (prefix) => {
    idRef.current += 1;
    return `${prefix}${idRef.current}`;
  };

  const ready = mapState.status === 'ready';
  const lat = ready ? mapState.center.lat : null;
  const zoom = ready ? mapState.zoom : null;

  // A new edit starts a new state, so an old restore point no longer applies.
  const update = (reduce) => {
    setClearedExtras(null);
    setExtras(reduce);
  };

  // Every riser on the map, for drawing, flags, counts and saving.
  const risers = useMemo(
    () => [...bedRisers, ...extras.risers.map((r) => ({ ...r, source: 'manual' }))],
    [bedRisers, extras.risers],
  );

  const flags = useMemo(() => {
    if (!ready) return NO_FLAGS;
    return {
      nozzleKeys: flagInZones(nozzles, extras.zones, lat, zoom),
      riserKeys: flagInZones(risers, extras.zones, lat, zoom),
    };
  }, [ready, nozzles, extras.zones, risers, lat, zoom]);

  // Zones with their pixel radius for drawing. Derived, not stored.
  const zones = useMemo(
    () => (ready ? extras.zones.map((z) => ({ ...z, radiusPx: feetToPx(z.radiusFt, lat, zoom) })) : []),
    [ready, extras.zones, lat, zoom],
  );

  const addRiserAt = (p) => update((prev) => addRiser(prev, nextKey('R'), point(p)));
  const moveRiserTo = (riser, p) => update((prev) => moveRiser(prev, riser.key, point(p)));
  const deleteRiserOf = (riser) => update((prev) => deleteRiser(prev, riser.key));
  const placePump = (p) => update((prev) => setPump(prev, point(p)));
  // Ticking a box is an edit like any other (it drops an old restore point). Moving or clearing the pump clears the ticks;
  // Undo of "Clear risers, zones and pump" restores the whole pump object, ticks included.
  const checkPump = (key, value) => update((prev) => setPumpCheck(prev, key, value));

  // Zone tool: inside an existing zone deletes it, anywhere else adds one of the picked kind.
  const tapZone = (p) => {
    const idx = ready ? hitZoneIndex(extras.zones, p, lat, zoom) : -1;
    if (idx >= 0) {
      const { key } = extras.zones[idx];
      update((prev) => deleteZone(prev, key));
    } else {
      update((prev) => addZone(prev, nextKey('Z'), zoneKind, point(p)));
    }
  };

  // The photo's zoom changed by `delta`: everything stays on the same ground. Their restore point is at the old scale, so it goes.
  const rescaleExtras = (delta) => {
    setClearedExtras(null);
    setExtras((prev) => scaleExtras(prev, delta));
  };

  const clearExtras = () => {
    const count = extrasCount(extras);
    if (count === 0) return;
    setClearedExtras({ count, snapshot: extras });
    setExtras(NO_EXTRAS);
  };

  const restoreExtras = () => {
    if (!clearedExtras) return;
    setExtras(clearedExtras.snapshot);
    setClearedExtras(null);
  };

  return {
    risers,
    pump: extras.pump,
    zones,
    zoneKind,
    setZoneKind,
    flags,
    hasExtras: extrasCount(extras) > 0,
    clearedExtras,
    dismissClearedExtras: () => setClearedExtras(null),
    addRiserAt,
    moveRiserTo,
    deleteRiserOf,
    placePump,
    checkPump,
    tapZone,
    clearExtras,
    restoreExtras,
    rescaleExtras,
  };
}
