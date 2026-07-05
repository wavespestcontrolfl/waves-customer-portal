// Property-zone sync for satellite coverage (PR 1: write path).
//
// The two load-bearing behaviors:
//  1. PROD GUARD — a customer with no zone rows and no incoming shapes gets
//     NO writes: their reports keep the builder's defaultZones schematic.
//  2. FULL-CHIP UPSERT — the moment shapes arrive (or rows already exist),
//     EVERY chipped spatial area gets a row; report-data prefers real rows
//     over defaultZones, so an unrowed chip would vanish from coverage.

const {
  upsertZonesForCompletion,
  validateZoneShapesBody,
  sanitizeZoneShape,
} = require('../services/property-zones');

// Minimal knex-shaped fake for the exact chains the service uses, recording
// every insert/update so assertions can inspect writes.
function makeFakeTrx(existingZones = []) {
  const writes = { inserts: [], updates: [] };
  let nextId = 1;
  const trx = (table) => {
    if (table !== 'property_zones') throw new Error(`unexpected table ${table}`);
    let filtered = [...existingZones];
    const builder = {
      where(criteria) {
        if (criteria.customer_id) {
          filtered = filtered.filter((z) => z.customer_id === criteria.customer_id
            && (criteria.is_active === undefined || z.is_active !== false));
        }
        if (criteria.id) builder._targetId = criteria.id;
        return builder;
      },
      orderBy: () => builder,
      insert(row) {
        const created = { id: `zone-${nextId += 1}`, is_active: true, ...row };
        writes.inserts.push(created);
        existingZones.push(created);
        return { returning: () => Promise.resolve([created]) };
      },
      update(patch) {
        writes.updates.push({ id: builder._targetId, patch });
        return Promise.resolve(1);
      },
      then: (resolve) => Promise.resolve(filtered).then(resolve),
    };
    return builder;
  };
  trx.fn = { now: () => 'NOW()' };
  return { trx, writes };
}

const CUSTOMER = 'customer-1';

test('no existing rows + no shapes → zero writes (prod defaultZones guard)', async () => {
  const { trx, writes } = makeFakeTrx([]);
  const summary = await upsertZonesForCompletion(trx, {
    customerId: CUSTOMER,
    serviceLine: 'pest',
    areaLabels: ['Perimeter', 'Yard', 'No issues found'],
    zoneShapes: [],
  });
  expect(writes.inserts).toHaveLength(0);
  expect(writes.updates).toHaveLength(0);
  expect(summary).toMatchObject({ created: 0, updated: 0, shapesApplied: 0 });
});

test('first shapes submission rows EVERY chip, applies shapes, filters status chips', async () => {
  const { trx, writes } = makeFakeTrx([]);
  const summary = await upsertZonesForCompletion(trx, {
    customerId: CUSTOMER,
    serviceLine: 'pest',
    areaLabels: ['Perimeter', 'Entry points', 'Yard', 'No issues found', 'Follow-up recommended'],
    zoneShapes: [
      { areaLabel: 'Perimeter', shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.15, ref: { lat: 27.36, lng: -82.38, zoom: 20 } } },
    ],
  });

  // all three spatial chips get rows — the status chips do not ('Follow-up
  // recommended' normalizes to 'follow up recommended'; the filter must match
  // in normalized space, not on the raw hyphenated label)
  expect(writes.inserts.map((z) => z.label)).toEqual(['Perimeter', 'Entry points', 'Yard']);
  expect(writes.inserts.map((z) => z.letter)).toEqual(['A', 'B', 'C']);
  expect(writes.inserts.every((z) => JSON.parse(z.geometry).w > 1)).toBe(true); // pixel-space schematic
  expect(writes.inserts[0].category).toBe('perimeter');
  expect(writes.inserts[1].category).toBe('entry_points');
  expect(writes.inserts[0].service_lines).toEqual(['pest']);

  // the shape landed on the Perimeter row as normalized geometry_image
  expect(writes.updates).toHaveLength(1);
  const stored = JSON.parse(writes.updates[0].patch.geometry_image);
  expect(stored).toMatchObject({ type: 'rect', x: 0.1, y: 0.1, w: 0.8, h: 0.15 });
  expect(stored.ref).toMatchObject({ lat: 27.36, lng: -82.38, zoom: 20, width: 640, height: 340 });
  expect(summary).toMatchObject({ created: 3, shapesApplied: 1 });
});

test('existing rows: chips stay synced, letters skip used, lines append, shapes update in place', async () => {
  const { trx, writes } = makeFakeTrx([
    { id: 'z-a', customer_id: CUSTOMER, letter: 'A', label: 'Perimeter', service_lines: ['pest'], is_active: true },
    { id: 'z-b', customer_id: CUSTOMER, letter: 'B', label: 'Yard', service_lines: ['pest'], is_active: true },
  ]);
  const summary = await upsertZonesForCompletion(trx, {
    customerId: CUSTOMER,
    serviceLine: 'lawn',
    areaLabels: ['Yard', 'Front yard'],
    zoneShapes: [
      { areaLabel: 'Yard', shape: { type: 'circle', cx: 0.5, cy: 0.6, r: 0.08 } },
    ],
  });

  // Yard existed → service line appended, no duplicate row; Front yard is new → letter C
  const created = writes.inserts;
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ label: 'Front yard', letter: 'C', category: 'lawn', service_lines: ['lawn'] });

  const lineUpdate = writes.updates.find((u) => u.patch.service_lines);
  expect(lineUpdate).toMatchObject({ id: 'z-b', patch: { service_lines: ['pest', 'lawn'] } });

  const shapeUpdate = writes.updates.find((u) => u.patch.geometry_image);
  expect(shapeUpdate.id).toBe('z-b');
  expect(JSON.parse(shapeUpdate.patch.geometry_image)).toEqual({ type: 'circle', cx: 0.5, cy: 0.6, r: 0.08 });
  expect(summary).toMatchObject({ created: 1, shapesApplied: 1 });
});

test('malformed and pixel-space shapes are rejected, never guessed at', () => {
  expect(sanitizeZoneShape({ type: 'rect', x: 64, y: 42, w: 512, h: 46 })).toBeNull(); // pixel coords
  expect(sanitizeZoneShape({ type: 'rect', x: 0.2, y: 0.2, w: 0, h: 0.1 })).toBeNull(); // zero size
  expect(sanitizeZoneShape({ type: 'circle', cx: 0.5, cy: 0.5, r: -0.1 })).toBeNull();
  expect(sanitizeZoneShape({ type: 'polygon', points: [[0, 0]] })).toBeNull(); // unsupported type
  expect(sanitizeZoneShape(null)).toBeNull(); // null must not throw
  expect(sanitizeZoneShape('rect')).toBeNull();
  expect(sanitizeZoneShape({ type: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.1 }))
    .toEqual({ type: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.1 });
});

test('validateZoneShapesBody rejects the malformed payloads a stale client could send', () => {
  expect(validateZoneShapesBody(null)).toBeNull();
  expect(validateZoneShapesBody([])).toBeNull();
  expect(validateZoneShapesBody('nope')).toMatch(/array/);
  expect(validateZoneShapesBody([{ shape: {} }])).toMatch(/areaLabel/);
  // shape: null must produce the 400 validation message, not a 500 throw
  expect(validateZoneShapesBody([{ areaLabel: 'Yard', shape: null }])).toMatch(/malformed shape/);
  // a malformed / pixel-space shape must 400 at the route, not silently drop
  expect(validateZoneShapesBody([{ areaLabel: 'Yard', shape: { type: 'rect', x: 64, y: 42, w: 512, h: 46 } }])).toMatch(/malformed shape/);
  expect(validateZoneShapesBody([{ areaLabel: 'Yard', shape: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.05 } }])).toBeNull();
  expect(validateZoneShapesBody(new Array(31).fill({ areaLabel: 'Yard', shape: {} }))).toMatch(/at most/);
});

test('clear tombstone nulls the stored mark on an existing row', async () => {
  const { trx, writes } = makeFakeTrx([
    { id: 'z-a', customer_id: CUSTOMER, letter: 'A', label: 'Perimeter', service_lines: ['pest'], is_active: true, geometry_image: '{"type":"rect","x":0.1,"y":0.1,"w":0.4,"h":0.2}' },
    { id: 'z-b', customer_id: CUSTOMER, letter: 'B', label: 'Yard', service_lines: ['pest'], is_active: true },
  ]);
  const summary = await upsertZonesForCompletion(trx, {
    customerId: CUSTOMER,
    serviceLine: 'pest',
    areaLabels: ['Perimeter', 'Yard'],
    zoneShapes: [{ areaLabel: 'Perimeter', clear: true }],
  });
  expect(writes.inserts).toHaveLength(0);
  const clearUpdate = writes.updates.find((u) => 'geometry_image' in u.patch);
  expect(clearUpdate).toMatchObject({ id: 'z-a', patch: { geometry_image: null } });
  expect(summary).toMatchObject({ cleared: 1, shapesApplied: 0, created: 0 });
});

test('clear-only payload on a no-row property stays inside the prod guard (zero writes)', async () => {
  const { trx, writes } = makeFakeTrx([]);
  const summary = await upsertZonesForCompletion(trx, {
    customerId: CUSTOMER,
    serviceLine: 'pest',
    areaLabels: ['Perimeter'],
    zoneShapes: [{ areaLabel: 'Perimeter', clear: true }],
  });
  // clears never create rows and never count as shapes — the property keeps
  // the report builder's schematic defaultZones path untouched
  expect(writes.inserts).toHaveLength(0);
  expect(writes.updates).toHaveLength(0);
  expect(summary).toMatchObject({ created: 0, cleared: 0, shapesApplied: 0 });
});

test('validateZoneShapesBody accepts clear tombstones but rejects clear+shape', () => {
  expect(validateZoneShapesBody([{ areaLabel: 'Perimeter', clear: true }])).toBeNull();
  expect(validateZoneShapesBody([{ areaLabel: 'Perimeter', clear: true, shape: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.05 } }])).toMatch(/one or the other/);
});
