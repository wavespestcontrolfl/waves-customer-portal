import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT, MAP_WIDTH, pxToFeet } from '../components/tech/treatmentZoneSpray';
import { placeNozzles } from './mistingLayoutGeometry';
import {
  DEFAULT_ZONE_KIND,
  NO_EXTRAS,
  ZONE_KINDS,
  addRiser,
  addZone,
  clampToMap,
  deleteRiser,
  deleteZone,
  extrasCount,
  feetToPx,
  flagInZones,
  hitZoneIndex,
  insideAnyZone,
  moveRiser,
  pumpChecklistDone,
  pumpChecksOf,
  setPump,
  setPumpCheck,
  zoneKindDef,
} from './mistingLayoutExtras';

const LAT = 26.95;
const ZOOM = 20;
const FT = 1 / pxToFeet(1, LAT, ZOOM); // pixels in one foot
const flag = (points, zones) => flagInZones(points, zones, LAT, ZOOM);

// Seeded generator so a failure reproduces.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('zone kinds', () => {
  it('has the five kinds, pool and water at 15 ft and the rest at 8 ft', () => {
    expect(ZONE_KINDS.map((k) => k.key)).toEqual(['pool', 'water', 'door', 'dining', 'ac']);
    expect(ZONE_KINDS.map((k) => k.label)).toEqual(['Pool', 'Water', 'Door/window', 'Dining/grill', 'AC intake']);
    expect(ZONE_KINDS.map((k) => k.radiusFt)).toEqual([15, 15, 8, 8, 8]);
    expect(zoneKindDef('nope').key).toBe(DEFAULT_ZONE_KIND);
  });

  it('turns a zone radius in feet into map pixels with the shared feet helper', () => {
    const z = addZone(NO_EXTRAS, 'Z1', 'pool', { x: 300, y: 300 }).zones[0];
    expect(z).toMatchObject({ key: 'Z1', kind: 'pool', radiusFt: 15, x: 300, y: 300 });
    expect(pxToFeet(feetToPx(z.radiusFt, LAT, ZOOM), LAT, ZOOM)).toBeCloseTo(15, 9);
  });
});

describe('riser, pump and zone reducers', () => {
  it('adds, moves (newest last) and deletes risers without touching anything else', () => {
    let e = addRiser(NO_EXTRAS, 'R1', { x: 10, y: 10 });
    e = addRiser(e, 'R2', { x: 20, y: 20 });
    e = moveRiser(e, 'R1', { x: 30, y: 30 });
    expect(e.risers.map((r) => r.key)).toEqual(['R2', 'R1']);
    expect(e.risers[1]).toMatchObject({ x: 30, y: 30 });
    expect(moveRiser(e, 'missing', { x: 1, y: 1 })).toBe(e);
    e = deleteRiser(e, 'R2');
    expect(e.risers.map((r) => r.key)).toEqual(['R1']);
    expect(e.pump).toBeNull();
    expect(e.zones).toEqual([]);
  });

  it('keeps points on the map', () => {
    expect(clampToMap({ x: -5, y: MAP_HEIGHT + 9 })).toEqual({ x: 0, y: MAP_HEIGHT });
    expect(addRiser(NO_EXTRAS, 'R1', { x: MAP_WIDTH + 50, y: 3 }).risers[0].x).toBe(MAP_WIDTH);
  });

  it('holds exactly one pump: a second placement moves it', () => {
    const first = setPump(NO_EXTRAS, { x: 100, y: 100 });
    const second = setPump(first, { x: 400, y: 250 });
    expect(second.pump).toEqual({ x: 400, y: 250 });
    expect(Array.isArray(second.pump)).toBe(false);
  });

  it('ticks the pump spot checklist one known key at a time; a new spot clears it', () => {
    const none = { outlet: false, level: false, dry: false, stucco: false };
    expect(pumpChecksOf({ x: 1, y: 1 })).toEqual(none); // an older saved pump has no checks
    expect(pumpChecksOf({ x: 1, y: 1, checks: { outlet: 'true', level: 1 } })).toEqual(none); // only exactly true counts
    expect(setPumpCheck(NO_EXTRAS, 'outlet', true)).toBe(NO_EXTRAS); // no pump, no change
    let e = setPump(NO_EXTRAS, { x: 100, y: 100 });
    expect(setPumpCheck(e, 'shade', true)).toBe(e);
    e = ['outlet', 'level', 'dry'].reduce((acc, key) => setPumpCheck(acc, key, true), e);
    expect(pumpChecklistDone(e.pump)).toBe(false);
    e = setPumpCheck(e, 'stucco', true);
    expect(e.pump).toEqual({ x: 100, y: 100, checks: { outlet: true, level: true, dry: true, stucco: true } });
    expect(pumpChecklistDone(e.pump)).toBe(true);
    expect(pumpChecklistDone(null)).toBe(false);
    expect(setPump(e, { x: 400, y: 250 }).pump).toEqual({ x: 400, y: 250 });
  });

  it('does not mutate its input', () => {
    const before = addRiser(NO_EXTRAS, 'R1', { x: 1, y: 1 });
    const snapshot = JSON.stringify(before);
    addRiser(before, 'R2', { x: 2, y: 2 });
    moveRiser(before, 'R1', { x: 9, y: 9 });
    deleteRiser(before, 'R1');
    setPump(before, { x: 5, y: 5 });
    addZone(before, 'Z1', 'ac', { x: 5, y: 5 });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(Object.isFrozen(NO_EXTRAS)).toBe(true);
  });

  it('property: any sequence of edits keeps one pump slot, unique keys and an exact count', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed);
      let e = NO_EXTRAS;
      let n = 0;
      let lastPump = null;
      for (let step = 0; step < 40; step += 1) {
        const p = { x: rand() * MAP_WIDTH, y: rand() * MAP_HEIGHT };
        const roll = rand();
        n += 1;
        if (roll < 0.25) e = addRiser(e, `R${n}`, p);
        else if (roll < 0.4 && e.risers.length) e = moveRiser(e, e.risers[Math.floor(rand() * e.risers.length)].key, p);
        else if (roll < 0.5 && e.risers.length) e = deleteRiser(e, e.risers[Math.floor(rand() * e.risers.length)].key);
        else if (roll < 0.7) { e = setPump(e, p); lastPump = p; }
        else if (roll < 0.9) e = addZone(e, `Z${n}`, ZONE_KINDS[Math.floor(rand() * ZONE_KINDS.length)].key, p);
        else if (e.zones.length) e = deleteZone(e, e.zones[Math.floor(rand() * e.zones.length)].key);
      }
      expect(new Set(e.risers.map((r) => r.key)).size).toBe(e.risers.length);
      expect(new Set(e.zones.map((z) => z.key)).size).toBe(e.zones.length);
      expect(e.pump).toEqual(lastPump);
      expect(extrasCount(e)).toBe(e.risers.length + e.zones.length + (e.pump ? 1 : 0));
    }
  });

  it('property: re-placing nozzles is a function of the lines only, so it cannot move extras', () => {
    const lines = [{ id: 'a', kind: 'eave', points: [{ x: 100, y: 100 }, { x: 500, y: 100 }] }];
    const e = addZone(addRiser(setPump(NO_EXTRAS, { x: 50, y: 50 }), 'R1', { x: 200, y: 300 }), 'Z1', 'pool', { x: 400, y: 400 });
    const before = JSON.stringify(e);
    placeNozzles(lines, { lat: LAT, zoom: ZOOM });
    placeNozzles([], { lat: LAT, zoom: ZOOM });
    expect(JSON.stringify(e)).toBe(before);
  });
});

describe('zone hit test', () => {
  const zones = [
    { key: 'Z1', kind: 'pool', radiusFt: 15, x: 500, y: 500 },
    { key: 'Z2', kind: 'door', radiusFt: 8, x: 520, y: 500 },
  ];
  it('finds the zone a tap is inside, newest first when zones overlap, and -1 outside', () => {
    expect(hitZoneIndex(zones, { x: 510, y: 500 }, LAT, ZOOM)).toBe(1);
    expect(hitZoneIndex(zones, { x: 500 - 14 * FT, y: 500 }, LAT, ZOOM)).toBe(0);
    expect(hitZoneIndex(zones, { x: 500 + 40 * FT, y: 500 }, LAT, ZOOM)).toBe(-1);
    expect(hitZoneIndex([], { x: 1, y: 1 }, LAT, ZOOM)).toBe(-1);
  });
});

describe('no-mist flags (feet based)', () => {
  const zone = { key: 'Z1', kind: 'pool', radiusFt: 15, x: 600, y: 400 };
  const at = (ft, angle = 0) => ({ key: 'n', x: zone.x + ft * FT * Math.cos(angle), y: zone.y + ft * FT * Math.sin(angle) });

  it('flags a point inside, not one outside, and not one exactly on the boundary', () => {
    expect(flag([at(14.9)], [zone]).has('n')).toBe(true);
    expect(flag([at(0)], [zone]).has('n')).toBe(true);
    expect(flag([at(15)], [zone]).has('n')).toBe(false);
    expect(flag([at(15.1)], [zone]).has('n')).toBe(false);
  });

  it('flags nothing without zones or points', () => {
    expect(flag([at(1)], []).size).toBe(0);
    expect(flag([], [zone]).size).toBe(0);
    expect(flag(undefined, undefined).size).toBe(0);
  });

  it('flags a point inside any one of several zones', () => {
    const far = { key: 'Z2', kind: 'door', radiusFt: 8, x: 900, y: 400 };
    const near = { key: 'p', x: far.x + 5 * FT, y: far.y };
    expect([...flag([at(40), near], [zone, far])]).toEqual(['p']);
    expect(insideAnyZone(near, [zone, far], LAT, ZOOM)).toBe(true);
  });

  it('property: strictly inside is flagged, exactly on the boundary is not, outside is not, at any angle and radius', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = mulberry32(seed);
      const def = ZONE_KINDS[Math.floor(rand() * ZONE_KINDS.length)];
      const z = { key: 'Z', kind: def.key, radiusFt: def.radiusFt, x: 100 + rand() * 1000, y: 100 + rand() * 700 };
      const angle = rand() * Math.PI * 2;
      const point = (ft) => ({ key: 'n', x: z.x + ft * FT * Math.cos(angle), y: z.y + ft * FT * Math.sin(angle) });
      const msg = `seed ${seed} ${def.key}`;
      expect(flag([point(def.radiusFt * 0.999)], [z]).has('n'), msg).toBe(true);
      expect(flag([point(def.radiusFt)], [z]).has('n'), msg).toBe(false);
      expect(flag([point(def.radiusFt * 1.001)], [z]).has('n'), msg).toBe(false);
    }
  });

  it('property: flags are recomputed from the current positions, so a move in or out of a zone flips them', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const rand = mulberry32(seed);
      let e = addZone(NO_EXTRAS, 'Z1', 'water', { x: 640, y: 480 });
      e = addRiser(e, 'R1', { x: 640 + 30 * FT, y: 480 }); // 30 ft out
      expect(flag(e.risers, e.zones).has('R1')).toBe(false);
      const inside = rand() * 14;
      e = moveRiser(e, 'R1', { x: 640 + inside * FT, y: 480 });
      expect(flag(e.risers, e.zones).has('R1')).toBe(true);
      e = moveRiser(e, 'R1', { x: 640 + (16 + rand() * 20) * FT, y: 480 });
      expect(flag(e.risers, e.zones).has('R1')).toBe(false);
      e = moveRiser(e, 'R1', { x: 640, y: 480 });
      e = deleteZone(e, 'Z1'); // deleting the zone clears the flag
      expect(flag(e.risers, e.zones).size).toBe(0);
    }
  });
});
