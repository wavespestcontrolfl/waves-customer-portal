// Termite bait station map (station-map-v1).
//
// Load-bearing behaviors:
//  1. VALIDATION — malformed pins 400 at the route, never silently drop in
//     the post-commit fail-soft sync (a silent skip would lose the tech's
//     pins behind a successful completion).
//  2. NUMBERING — station numbers allocate above the max across ALL rows,
//     retired included, in payload order; "station 7" never changes meaning.
//  3. OWNERSHIP — a client-supplied station id outside the customer is
//     skipped, never written.
//  4. REPORT GATING — the customer report context renders only for
//     termite-bait-typed visits with mapped stations on an available
//     satellite basemap, and the env kill switch wins over everything.

const {
  STATION_STATUSES,
  MAX_ACTIVE_STATIONS,
  sanitizeStationShape,
  validateStationEntriesBody,
  profileAllowsStationSync,
  stationProgramForProfile,
  stationCapWouldOverflow,
  upsertStationsForCustomer,
  syncStationsForCompletion,
  loadStationsForPropertyMap,
  buildStationMapReportContext,
} = require('../services/termite-stations');

// Minimal knex-shaped fake for the exact chains the service uses
// (where/orderBy/insert.returning/insert.onConflict.merge/update, plus a
// passthrough transaction), recording writes for assertions.
function makeFakeDb({ stations = [], checks = [] } = {}) {
  // seeds default to the termite program — the service's program-scoped
  // where({ program }) must still see legacy-shaped seed rows
  const state = {
    stations: stations.map((row) => ({ program: 'termite', ...row })),
    checks: [...checks],
    rawCalls: [],
  };
  let nextId = 0;
  const rowsFor = (table) => {
    if (table === 'termite_stations') return state.stations;
    if (table === 'termite_station_checks') return state.checks;
    throw new Error(`unexpected table ${table}`);
  };
  const db = (table) => {
    const rows = rowsFor(table);
    let criteria = null;
    const matches = (row) => !criteria
      || Object.entries(criteria).every(([key, value]) => row[key] === value);
    const builder = {
      where(next) {
        criteria = { ...(criteria || {}), ...next };
        return builder;
      },
      orderBy: () => builder,
      select: () => builder,
      insert(row) {
        const created = { id: `${table}-${nextId += 1}`, is_active: true, ...row };
        rows.push(created);
        return {
          returning: () => Promise.resolve([created]),
          onConflict: (cols) => ({
            merge: (patch) => {
              const match = rows.find((r) => r !== created
                && cols.every((col) => String(r[col]) === String(created[col])));
              if (match) {
                rows.splice(rows.indexOf(created), 1);
                Object.assign(match, patch);
              }
              return Promise.resolve(1);
            },
          }),
        };
      },
      update(patch) {
        const targets = rows.filter(matches);
        targets.forEach((row) => Object.assign(row, patch));
        return Promise.resolve(targets.length);
      },
      then: (resolve, reject) => Promise.resolve(rows.filter(matches)).then(resolve, reject),
      catch: (onRejected) => Promise.resolve(rows.filter(matches)).catch(onRejected),
    };
    return builder;
  };
  db.fn = { now: () => 'NOW()' };
  db.raw = async (sql, bindings) => { state.rawCalls.push({ sql, bindings }); };
  db.transaction = async (fn) => fn(db);
  return { db, state };
}

const CUSTOMER = 'customer-1';
const REF = { lat: 27.36, lng: -82.38, zoom: 20, width: 640, height: 340 };
const pin = (cx, cy, extra = {}) => ({ type: 'circle', cx, cy, r: 0.035, ref: REF, ...extra });

// ── validation ────────────────────────────────────────────────────────────────

test('sanitizeStationShape accepts circles and rejects rects', () => {
  expect(sanitizeStationShape(pin(0.5, 0.5))).toMatchObject({ type: 'circle', cx: 0.5, cy: 0.5 });
  expect(sanitizeStationShape({ type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBeNull();
  expect(sanitizeStationShape({ type: 'circle', cx: 1.5, cy: 0.5, r: 0.035 })).toBeNull();
});

test('validateStationEntriesBody accepts the three entry intents', () => {
  expect(validateStationEntriesBody(null)).toBeNull();
  expect(validateStationEntriesBody([
    { shape: pin(0.2, 0.4), status: 'ok' },
    { id: 'st-1', shape: pin(0.5, 0.5), status: 'activity' },
    { id: 'st-2', status: 'serviced' },
    { id: 'st-3', retire: true },
  ])).toBeNull();
});

test('validateStationEntriesBody rejects malformed payloads with 400-material messages', () => {
  expect(validateStationEntriesBody('nope')).toMatch(/array/);
  expect(validateStationEntriesBody([{}])).toMatch(/shape .*or an id/);
  expect(validateStationEntriesBody([{ shape: { type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }])).toMatch(/circle/);
  expect(validateStationEntriesBody([{ id: 'st-1', status: 'wet' }])).toMatch(/status must be one of/);
  expect(validateStationEntriesBody([{ id: 'st-1', retire: true, status: 'ok' }])).toMatch(/retire entry cannot/);
  expect(validateStationEntriesBody([{ retire: true }])).toMatch(/needs the station id/);
  expect(validateStationEntriesBody([
    { id: 'st-1', status: 'ok' },
    { id: 'st-1', status: 'activity' },
  ])).toMatch(/more than one entry/);
  const tooMany = Array.from({ length: 241 }, () => ({ shape: pin(0.5, 0.5) }));
  expect(validateStationEntriesBody(tooMany)).toMatch(/at most 240/);
});

test('entry cap covers the worst legal payload: a half-relayout of a capped property', () => {
  // 39 surviving statuses + 41 retires + 41 creates (121 entries) is a
  // legal cap-neutral replacement save and must validate.
  const relayout = [
    ...Array.from({ length: 39 }, (_, i) => ({ id: `st-keep-${i}`, status: 'ok' })),
    ...Array.from({ length: 41 }, (_, i) => ({ id: `st-old-${i}`, retire: true })),
    ...Array.from({ length: 41 }, (_, i) => ({ shape: pin(0.01 + i * 0.02, 0.9), status: 'ok' })),
  ];
  expect(validateStationEntriesBody(relayout)).toBeNull();
});

test('cap netting: only VALID retires free slots, replay creates net to zero, replacements count', async () => {
  const atCap = Array.from({ length: MAX_ACTIVE_STATIONS }, (_, i) => ({
    id: `st-${i}`, customer_id: CUSTOMER, station_number: i + 1, is_active: true, geometry_image: pin(0.01 + (i % 40) * 0.02, i < 40 ? 0.2 : 0.8),
  }));
  const { db } = makeFakeDb({ stations: atCap });

  // a fresh 81st pin at a new spot overflows
  expect(await stationCapWouldOverflow(db, CUSTOMER, [
    { shape: pin(0.5, 0.55), status: 'ok' },
  ])).toBe(true);
  // a bogus/foreign retire must NOT free the slot (the sync will skip it)
  expect(await stationCapWouldOverflow(db, CUSTOMER, [
    { id: 'st-ghost', retire: true },
    { shape: pin(0.5, 0.55), status: 'ok' },
  ])).toBe(true);
  // a VALID retire + create (replacement at a new spot) is cap-neutral
  expect(await stationCapWouldOverflow(db, CUSTOMER, [
    { id: 'st-0', retire: true },
    { shape: pin(0.5, 0.55), status: 'ok' },
  ])).toBe(false);
  // a resumed body: the create sits at an ACTIVE station's exact position
  // (the first pass already inserted it) → nets to zero, retry passes
  expect(await stationCapWouldOverflow(db, CUSTOMER, [
    { shape: pin(0.01, 0.2), status: 'ok' },
  ])).toBe(false);
  // same-hole replacement: the retired station's position does NOT shield
  // the create — it genuinely inserts, so retire+create at that spot plus
  // a second new pin overflows
  expect(await stationCapWouldOverflow(db, CUSTOMER, [
    { id: 'st-0', retire: true },
    { shape: pin(0.01, 0.2), status: 'ok' },
    { shape: pin(0.5, 0.55), status: 'ok' },
  ])).toBe(true);
});

test('office mode (allowStatus: false) rejects statuses', () => {
  expect(validateStationEntriesBody([{ id: 'st-1', status: 'ok' }], { allowStatus: false }))
    .toMatch(/only applies during a completion/);
  expect(validateStationEntriesBody([{ id: 'st-1', shape: pin(0.5, 0.5) }], { allowStatus: false }))
    .toBeNull();
});

// ── registry upsert ───────────────────────────────────────────────────────────

test('creates allocate numbers above the max across ALL rows (retired included), in payload order', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1) },
      // retired station 10 — its number must never be reused
      { id: 'st-10', customer_id: CUSTOMER, station_number: 10, is_active: false, geometry_image: pin(0.9, 0.9) },
    ],
  });
  const summary = await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [
      { shape: pin(0.3, 0.3) },
      { shape: pin(0.6, 0.6) },
    ],
  });
  expect(summary.created).toBe(2);
  const created = state.stations.filter((row) => ![1, 10].includes(row.station_number));
  expect(created.map((row) => row.station_number).sort((a, b) => a - b)).toEqual([11, 12]);
  expect(summary.stationIdByIndex.get(0)).toBeTruthy();
  expect(summary.stationIdByIndex.get(1)).toBeTruthy();
});

test('moves update geometry, retires deactivate, foreign/retired ids are skipped', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1) },
      { id: 'st-2', customer_id: CUSTOMER, station_number: 2, is_active: true, geometry_image: pin(0.2, 0.2) },
      { id: 'st-x', customer_id: 'other-customer', station_number: 1, is_active: true, geometry_image: pin(0.5, 0.5) },
    ],
  });
  const summary = await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [
      { id: 'st-1', shape: pin(0.4, 0.4) },
      { id: 'st-2', retire: true },
      { id: 'st-x', shape: pin(0.7, 0.7) }, // other customer's station
      { id: 'st-ghost', status: 'ok' },     // unknown id
    ],
  });
  expect(summary.moved).toBe(1);
  expect(summary.retired).toBe(1);
  expect(summary.skipped).toEqual(expect.arrayContaining(['station:st-x', 'station:st-ghost']));
  const moved = state.stations.find((row) => row.id === 'st-1');
  expect(JSON.parse(moved.geometry_image)).toMatchObject({ cx: 0.4, cy: 0.4 });
  const retired = state.stations.find((row) => row.id === 'st-2');
  expect(retired.is_active).toBe(false);
  const foreign = state.stations.find((row) => row.id === 'st-x');
  expect(foreign.geometry_image).toMatchObject({ cx: 0.5 }); // untouched
});

test('geometry writes (creates AND moves) take the per-customer advisory lock; status-only payloads do not', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1) },
    ],
  });
  await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [{ id: 'st-1', status: 'ok' }, { id: 'st-1x', retire: true }],
  });
  expect(state.rawCalls).toHaveLength(0);
  await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [{ shape: pin(0.6, 0.6) }],
  });
  expect(state.rawCalls).toHaveLength(1);
  expect(state.rawCalls[0].sql).toMatch(/pg_advisory_xact_lock/);
  expect(state.rawCalls[0].bindings).toEqual([`termite_stations:${CUSTOMER}:termite`]);
  // a move-only save relies on the occupancy snapshot — it must serialize too
  await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [{ id: 'st-1', shape: pin(0.4, 0.4) }],
  });
  expect(state.rawCalls).toHaveLength(2);
});

// ── completion sync (registry + checks) ──────────────────────────────────────

test('syncStationsForCompletion writes check rows for existing AND newly-created stations', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1) },
    ],
  });
  const summary = await syncStationsForCompletion(db, {
    customerId: CUSTOMER,
    serviceRecordId: 'record-1',
    entries: [
      { id: 'st-1', status: 'activity' },
      { shape: pin(0.6, 0.6), status: 'ok' },
      { id: 'st-1x', retire: true }, // unknown — skipped, no check
    ],
  });
  expect(summary.created).toBe(1);
  expect(summary.checksApplied).toBe(2);
  expect(state.checks).toHaveLength(2);
  const existingCheck = state.checks.find((row) => row.station_id === 'st-1');
  expect(existingCheck).toMatchObject({ service_record_id: 'record-1', status: 'activity' });
});

test('a resumed completion replaying an id-less create dedupes to the existing station', async () => {
  const { db, state } = makeFakeDb({ stations: [] });
  const body = {
    customerId: CUSTOMER,
    serviceRecordId: 'record-1',
    entries: [{ shape: pin(0.6, 0.6), status: 'ok' }],
  };
  const first = await syncStationsForCompletion(db, body);
  expect(first.created).toBe(1);
  const replay = await syncStationsForCompletion(db, body);
  expect(replay.created).toBe(0);
  expect(replay.deduped).toBe(1);
  expect(replay.checksApplied).toBe(1);
  // one physical station, one check row — the replayed check landed on the
  // originally-created station
  expect(state.stations).toHaveLength(1);
  expect(state.checks).toHaveLength(1);
  expect(state.checks[0].station_id).toBe(state.stations[0].id);
});

test('retire + new pin in the same hole is a REPLACEMENT (new row), and replaying that payload dedupes to the replacement', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.5, 0.5) },
    ],
  });
  const body = {
    customerId: CUSTOMER,
    serviceRecordId: 'record-1',
    entries: [
      { id: 'st-1', retire: true },
      { shape: pin(0.5, 0.5), status: 'ok' }, // same hole, fresh station
    ],
  };
  const first = await syncStationsForCompletion(db, body);
  expect(first.retired).toBe(1);
  expect(first.created).toBe(1);
  expect(first.deduped).toBe(0);
  const replacement = state.stations.find((row) => row.id !== 'st-1');
  expect(replacement.station_number).toBe(2);
  expect(state.checks).toHaveLength(1);
  expect(state.checks[0].station_id).toBe(replacement.id);
  // resume-replay of the same body: retire skips (already inactive), the
  // create dedupes to the replacement — no third station, check unchanged
  const replay = await syncStationsForCompletion(db, body);
  expect(replay.created).toBe(0);
  expect(replay.deduped).toBe(1);
  expect(state.stations).toHaveLength(2);
  expect(state.checks).toHaveLength(1);
  expect(state.checks[0].station_id).toBe(replacement.id);
});

test('retire intents apply FIRST: a move into a hole vacated by a LATER retire entry lands', async () => {
  // Client emits entries in station-number order, so the move (station 2)
  // precedes the retire (station 5) in the payload — the occupancy check
  // must not see the doomed occupant.
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-2', customer_id: CUSTOMER, station_number: 2, is_active: true, geometry_image: pin(0.2, 0.2) },
      { id: 'st-5', customer_id: CUSTOMER, station_number: 5, is_active: true, geometry_image: pin(0.5, 0.5) },
    ],
  });
  const summary = await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [
      { id: 'st-2', shape: pin(0.5, 0.5) }, // move into st-5's hole
      { id: 'st-5', retire: true },
    ],
  });
  expect(summary.retired).toBe(1);
  expect(summary.moved).toBe(1);
  expect(summary.skipped).toHaveLength(0);
  const moved = state.stations.find((row) => row.id === 'st-2');
  expect(JSON.parse(moved.geometry_image)).toMatchObject({ cx: 0.5, cy: 0.5 });
  expect(state.stations.find((row) => row.id === 'st-5').is_active).toBe(false);
});

test('two id-less creates at one position in a single payload are rejected, not silently collapsed', () => {
  expect(validateStationEntriesBody([
    { shape: pin(0.5, 0.5), status: 'ok' },
    { shape: pin(0.5, 0.5), status: 'ok' },
  ])).toMatch(/share the same position/);
  // distinct positions stay valid
  expect(validateStationEntriesBody([
    { shape: pin(0.5, 0.5), status: 'ok' },
    { shape: pin(0.52, 0.5), status: 'ok' },
  ])).toBeNull();
});

test('moving a station vacates its old spot for a genuinely new pin in the same payload', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.5, 0.5) },
    ],
  });
  const summary = await upsertStationsForCustomer(db, {
    customerId: CUSTOMER,
    entries: [
      { id: 'st-1', shape: pin(0.7, 0.7) }, // move away
      { shape: pin(0.5, 0.5) },             // new station where st-1 used to be
    ],
  });
  expect(summary.moved).toBe(1);
  expect(summary.created).toBe(1);
  expect(summary.deduped).toBe(0);
  expect(state.stations).toHaveLength(2);
});

test('stationProgramForProfile: termite and rodent typed flows resolve their program, others none', () => {
  expect(stationProgramForProfile({ findingsType: 'termite_bait_station' })).toBe('termite');
  expect(stationProgramForProfile({ findingsType: 'rodent_bait_station' })).toBe('rodent');
  expect(stationProgramForProfile({
    findingsType: null,
    companions: [{ type: 'termite_bait_station', delivery: 'auto_send' }],
  })).toBe('termite');
  expect(stationProgramForProfile({
    findingsType: null,
    companions: [{ type: 'rodent_bait_station', delivery: 'auto_send' }],
  })).toBe('rodent');
  expect(stationProgramForProfile({ findingsType: 'pest_inspection' })).toBeNull();
  expect(stationProgramForProfile(null)).toBeNull();
  expect(profileAllowsStationSync({ findingsType: 'rodent_bait_station' })).toBe(true);
  expect(profileAllowsStationSync({ findingsType: null, companions: [] })).toBe(false);
});

test('programs are isolated: numbering, cap, and writes are per (customer, program)', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-t1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1) },
      { id: 'st-t2', customer_id: CUSTOMER, station_number: 2, is_active: true, geometry_image: pin(0.2, 0.2) },
      { id: 'st-r1', customer_id: CUSTOMER, station_number: 1, is_active: true, program: 'rodent', geometry_image: pin(0.8, 0.8) },
    ],
  });
  // a rodent create numbers from the RODENT max (2), not the termite max (3)
  const summary = await syncStationsForCompletion(db, {
    customerId: CUSTOMER,
    serviceRecordId: 'record-r1',
    entries: [
      { id: 'st-r1', status: 'ok' },
      { shape: pin(0.6, 0.6), status: 'activity' },
    ],
    program: 'rodent',
  });
  expect(summary.created).toBe(1);
  expect(summary.checksApplied).toBe(2);
  const rodentRows = state.stations.filter((row) => row.program === 'rodent');
  expect(rodentRows.map((row) => row.station_number).sort((a, b) => a - b)).toEqual([1, 2]);
  // a rodent entry can never touch a termite station id
  const crossProgram = await syncStationsForCompletion(db, {
    customerId: CUSTOMER,
    serviceRecordId: 'record-r2',
    entries: [{ id: 'st-t1', retire: true }],
    program: 'rodent',
  });
  expect(crossProgram.retired).toBe(0);
  expect(crossProgram.skipped).toContain('retire:st-t1');
  expect(state.stations.find((row) => row.id === 'st-t1').is_active).toBe(true);
});

test('the report map picks the program from the visit type and never co-renders the other program', () => {
  const rows = [
    stationRow('st-t1', 1, pin(0.2, 0.3), { program: 'termite' }),
    stationRow('st-r1', 1, pin(0.7, 0.6), { program: 'rodent' }),
  ];
  const rodentContext = buildStationMapReportContext({
    stationRows: rows,
    checkRows: [{ station_id: 'st-r1', status: 'activity' }],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['rodent_bait_station'],
    serviceDate: '2026-07-13',
  });
  expect(rodentContext.available).toBe(true);
  expect(rodentContext.program).toBe('rodent');
  expect(rodentContext.stations).toHaveLength(1);
  expect(rodentContext.stations[0].id).toBe('st-r1');
  const termiteContext = buildStationMapReportContext({
    stationRows: rows,
    checkRows: [{ station_id: 'st-t1', status: 'ok' }],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
    serviceDate: '2026-07-13',
  });
  expect(termiteContext.program).toBe('termite');
  expect(termiteContext.stations.map((s) => s.id)).toEqual(['st-t1']);
  // a rodent-typed visit with only termite rows has no map
  expect(buildStationMapReportContext({
    stationRows: [stationRow('st-t1', 1, pin(0.2, 0.3), { program: 'termite' })],
    checkRows: [],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['rodent_bait_station'],
  })).toMatchObject({ available: false, reason: 'no_stations' });
});

test('check rows upsert on replay (same station + record) instead of duplicating', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1) },
    ],
  });
  await syncStationsForCompletion(db, {
    customerId: CUSTOMER,
    serviceRecordId: 'record-1',
    entries: [{ id: 'st-1', status: 'ok' }],
  });
  await syncStationsForCompletion(db, {
    customerId: CUSTOMER,
    serviceRecordId: 'record-1',
    entries: [{ id: 'st-1', status: 'serviced' }],
  });
  expect(state.checks).toHaveLength(1);
  expect(state.checks[0].status).toBe('serviced');
});

// ── capture payload ───────────────────────────────────────────────────────────

test('loadStationsForPropertyMap returns active pins + a never-reused number base', async () => {
  const { db } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.1, 0.1), label: 'NE corner' },
      { id: 'st-9', customer_id: CUSTOMER, station_number: 9, is_active: false, geometry_image: pin(0.9, 0.9) },
    ],
  });
  const slice = await loadStationsForPropertyMap(db, CUSTOMER, { center: { lat: REF.lat, lng: REF.lng }, zoom: 20 });
  expect(slice.nextStationNumber).toBe(10);
  expect(slice.stations).toHaveLength(1);
  expect(slice.stations[0]).toMatchObject({ id: 'st-1', number: 1, label: 'NE corner', staleMark: false });
});

// ── report context ────────────────────────────────────────────────────────────

const SATELLITE = {
  available: true,
  attributionText: 'Map data (c) Google',
  live: { url: 'https://maps.example/live.png', width: 640, height: 340 },
};
const IMAGE_CONTEXT = { center: { lat: REF.lat, lng: REF.lng }, zoom: 20, width: 640, height: 340 };
const stationRow = (id, number, shape, extra = {}) => ({
  id, station_number: number, geometry_image: shape, label: null, ...extra,
});

test('report context renders pins with per-visit statuses and a numeric summary', () => {
  const context = buildStationMapReportContext({
    stationRows: [
      stationRow('st-1', 1, pin(0.2, 0.3)),
      stationRow('st-2', 2, pin(0.5, 0.5)),
      stationRow('st-3', 3, pin(0.8, 0.6)),
    ],
    checkRows: [
      { station_id: 'st-1', status: 'ok' },
      { station_id: 'st-2', status: 'activity' },
      { station_id: 'st-3', status: 'inaccessible' },
    ],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
  });
  expect(context.available).toBe(true);
  expect(context.stations).toHaveLength(3);
  expect(context.stations.find((s) => s.id === 'st-2')).toMatchObject({ number: 2, status: 'activity' });
  expect(context.summary).toEqual({ total: 3, checked: 2, activity: 1, serviced: 0, inaccessible: 1 });
  expect(context.image.url).toBe(SATELLITE.live.url);
});

test('report context gates: wrong visit type, no stations, satellite down, env kill switch', () => {
  const rows = [stationRow('st-1', 1, pin(0.2, 0.3))];
  expect(buildStationMapReportContext({
    stationRows: rows, satelliteMap: SATELLITE, imageContext: IMAGE_CONTEXT, typedTypes: ['pest_inspection'],
  })).toMatchObject({ available: false, reason: 'not_station_visit' });
  expect(buildStationMapReportContext({
    stationRows: [], satelliteMap: SATELLITE, imageContext: IMAGE_CONTEXT, typedTypes: ['termite_bait_station'],
  })).toMatchObject({ available: false, reason: 'no_stations' });
  expect(buildStationMapReportContext({
    stationRows: rows,
    satelliteMap: { available: false, fallbackReason: 'provider_unavailable' },
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
  })).toMatchObject({ available: false, reason: 'provider_unavailable' });

  const prior = process.env.SERVICE_REPORT_STATION_MAP_ENABLED;
  process.env.SERVICE_REPORT_STATION_MAP_ENABLED = 'false';
  try {
    expect(buildStationMapReportContext({
      stationRows: rows, satelliteMap: SATELLITE, imageContext: IMAGE_CONTEXT, typedTypes: ['termite_bait_station'],
    })).toMatchObject({ available: false, reason: 'disabled' });
  } finally {
    if (prior === undefined) delete process.env.SERVICE_REPORT_STATION_MAP_ENABLED;
    else process.env.SERVICE_REPORT_STATION_MAP_ENABLED = prior;
  }
});

test('a companion termite_bait_station type also renders (combined pest+termite visits)', () => {
  const context = buildStationMapReportContext({
    stationRows: [stationRow('st-1', 1, pin(0.2, 0.3))],
    checkRows: [],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['service_report', 'termite_bait_station'],
  });
  expect(context.available).toBe(true);
  // no check this visit → status null → "on file" pin, still counted in total
  expect(context.stations[0].status).toBeNull();
  expect(context.summary).toMatchObject({ total: 1, checked: 0 });
});

test('historical reports stay pinned to THE VISIT: checked stations render even after retirement, later additions stay off', () => {
  const context = buildStationMapReportContext({
    stationRows: [
      // checked on this visit, retired afterwards — must still render here
      stationRow('st-1', 1, pin(0.2, 0.3), { is_active: false, retired_at: '2026-08-01T15:00:00Z' }),
      stationRow('st-2', 2, pin(0.5, 0.5), { is_active: true }),
      // added to the registry AFTER this visit, never checked — must not
      // appear on this report as "on file"
      stationRow('st-9', 9, pin(0.8, 0.8), { is_active: true, created_at: '2026-09-01T15:00:00Z' }),
    ],
    checkRows: [
      { station_id: 'st-1', status: 'serviced' },
      { station_id: 'st-2', status: 'ok' },
    ],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
    serviceDate: '2026-07-13',
  });
  expect(context.available).toBe(true);
  expect(context.stations.map((s) => s.number).sort((a, b) => a - b)).toEqual([1, 2]);
  expect(context.summary.total).toBe(2);
});

test('no-check fallback windows stations to the visit day (ET): later creations and earlier retirements excluded', () => {
  const context = buildStationMapReportContext({
    stationRows: [
      stationRow('st-1', 1, pin(0.2, 0.3), { is_active: true, created_at: '2026-06-01T12:00:00Z' }),
      // retired a month BEFORE this visit — off the map
      stationRow('st-2', 2, pin(0.4, 0.4), { is_active: false, created_at: '2026-06-01T12:00:00Z', retired_at: '2026-06-10T12:00:00Z' }),
      // retired AFTER this visit — existed on visit day, stays on the map
      stationRow('st-3', 3, pin(0.6, 0.5), { is_active: false, created_at: '2026-06-01T12:00:00Z', retired_at: '2026-08-01T12:00:00Z' }),
      // created after the visit day — off the map
      stationRow('st-4', 4, pin(0.8, 0.6), { is_active: true, created_at: '2026-09-01T12:00:00Z' }),
    ],
    checkRows: [],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
    serviceDate: '2026-07-13',
  });
  expect(context.available).toBe(true);
  expect(context.stations.map((s) => s.number).sort((a, b) => a - b)).toEqual([1, 3]);
});

test('a retire-all visit does not resurrect same-day-retired pins via the no-check fallback', () => {
  // retire-all completions write NO check rows (retires carry no status),
  // so the builder lands in the day-window fallback — the pins this visit
  // just removed must not render as "on file" while the counts read zero
  const context = buildStationMapReportContext({
    stationRows: [
      stationRow('st-1', 1, pin(0.2, 0.3), { is_active: false, created_at: '2026-06-01T12:00:00Z', retired_at: '2026-07-13T18:30:00Z' }),
      stationRow('st-2', 2, pin(0.5, 0.5), { is_active: false, created_at: '2026-06-01T12:00:00Z', retired_at: '2026-07-13T18:30:00Z' }),
    ],
    checkRows: [],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
    serviceDate: '2026-07-13',
  });
  expect(context).toMatchObject({ available: false, reason: 'no_stations' });
});

test('a move onto another active station\'s exact spot is skipped, not stacked', async () => {
  const { db, state } = makeFakeDb({
    stations: [
      { id: 'st-1', customer_id: CUSTOMER, station_number: 1, is_active: true, geometry_image: pin(0.2, 0.2) },
      { id: 'st-2', customer_id: CUSTOMER, station_number: 2, is_active: true, geometry_image: pin(0.5, 0.5) },
    ],
  });
  const summary = await syncStationsForCompletion(db, {
    customerId: CUSTOMER,
    serviceRecordId: 'record-1',
    entries: [
      { id: 'st-1', shape: pin(0.5, 0.5), status: 'ok' }, // st-2's exact hole
    ],
  });
  expect(summary.moved).toBe(0);
  expect(summary.skipped).toContain('station:st-1:position-occupied');
  const st1 = state.stations.find((row) => row.id === 'st-1');
  expect(st1.geometry_image).toMatchObject({ cx: 0.2, cy: 0.2 }); // unmoved
  // the visit's status still lands — the check is real even if the move
  // could not be
  expect(summary.checksApplied).toBe(1);
  expect(state.checks[0].station_id).toBe('st-1');
});

test('drift: a re-geocoded property far from the pin ref drops the mark; all dropped → marks_stale', () => {
  const context = buildStationMapReportContext({
    stationRows: [stationRow('st-1', 1, pin(0.5, 0.5))],
    checkRows: [],
    satelliteMap: SATELLITE,
    // render center ~1km away — far beyond the quarter-frame drift budget
    imageContext: { center: { lat: REF.lat + 0.01, lng: REF.lng }, zoom: 20, width: 640, height: 340 },
    typedTypes: ['termite_bait_station'],
  });
  expect(context).toMatchObject({ available: false, reason: 'marks_stale' });
});

test('drift is all-or-nothing: ONE dropped visit pin fails the whole map closed (no partial summaries)', () => {
  // st-1 was drawn against a ref far from today's render center (drops);
  // st-2 was drawn against the current center (survives). A partial map
  // would render "1 of 1 inspected" against a visit that checked 2 — the
  // card must fail closed instead, like the zones satellite overlay.
  const context = buildStationMapReportContext({
    stationRows: [
      stationRow('st-1', 1, pin(0.5, 0.5, { ref: { ...REF, lat: REF.lat + 0.01 } })),
      stationRow('st-2', 2, pin(0.3, 0.3)),
    ],
    checkRows: [
      { station_id: 'st-1', status: 'ok' },
      { station_id: 'st-2', status: 'ok' },
    ],
    satelliteMap: SATELLITE,
    imageContext: IMAGE_CONTEXT,
    typedTypes: ['termite_bait_station'],
    serviceDate: '2026-07-13',
  });
  expect(context).toMatchObject({ available: false, reason: 'marks_stale' });
});

test('status vocabulary stays in lockstep with the DB CHECK', () => {
  expect(STATION_STATUSES).toEqual(['ok', 'activity', 'serviced', 'inaccessible']);
});
