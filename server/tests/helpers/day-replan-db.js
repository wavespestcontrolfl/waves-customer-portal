/**
 * An in-memory stand-in for the tables the day re-plan reads and writes, shaped like a knex handle: enough of
 * where / whereNot / whereIn / whereNotIn / first / update / insert to run the runner and the apply writer
 * against real predicates (a wrong column or value misses the row). Synthetic ids only.
 */
const HQ = { lat: 27.4330885, lng: -82.4056801 };

function row(id, lngOffset, hour, extra = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id,
    technician_id: 'tech-1',
    customer_id: `cust-${id}`,
    visit_id: null,
    status: 'confirmed',
    scheduled_date: '2026-11-04',
    window_start: `${pad(hour)}:00:00`,
    window_end: `${pad(hour + 1)}:00:00`,
    time_window: null,
    estimated_duration_minutes: 60,
    service_type: 'Quarterly Pest Control Service',
    is_recurring: true,
    is_callback: false,
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    customer_confirmed: false,
    reservation_expires_at: null,
    route_order: null,
    created_at: '2026-10-01T12:00:00.000Z',
    updated_at: '2026-10-02T12:00:00.000Z',
    service_address_line1: `${id} Test Ln`,
    service_address_line2: null,
    service_address_city: 'Parrish',
    service_address_zip: '34219',
    service_address_state: 'FL',
    customer_address_line1: `${id} Test Ln`,
    customer_city: 'Parrish',
    customer_zip: '34219',
    property_id: null,
    recurring_dispatch_due_date: null,
    lat: HQ.lat,
    lng: HQ.lng + lngOffset,
    // The stored location the move's CAS pins (the loader aliases the raw columns).
    raw_lat: HQ.lat,
    raw_lng: HQ.lng + lngOffset,
    ...extra,
  };
}

// East of the office: far, near, far, near on hours 8, 9, 10, 11 (a zigzag day the planner shortens).
const zigzagRows = (extra = {}) => [
  row('a', 0.30, 8, extra.a), row('b', 0.02, 9, extra.b), row('c', 0.31, 10, extra.c), row('d', 0.03, 11, extra.d),
];

function makeDb({ rows = [], reminders = [], blocks = [] } = {}) {
  const db = { rows, reminders, blocks, plans: [], inserts: [], updates: [], reads: { stops: 0 } };
  const eq = (a, b) => (a == null && b == null) || String(a) === String(b);
  const colOf = (c) => String(c).replace(/^[a-z_]+\./, '');
  const copy = (r) => ({ ...r });

  const conn = (table) => {
    const preds = [];
    const source = () => ({ scheduled_services: db.rows, appointment_reminders: db.reminders, tech_schedule_blocks: db.blocks, day_replan_plans: db.plans }[table] || []);
    const match = () => source().filter((r) => preds.every((p) => p(r)));
    const chain = new Proxy({}, {
      get(_t, prop) {
        switch (prop) {
          case 'then':
            return (resolve, reject) => {
              if (table === 'scheduled_services') db.reads.stops += 1;
              return Promise.resolve(match().map(copy)).then(resolve, reject);
            };
          case 'where':
            return (a, b) => {
              if (typeof a === 'function') return chain;
              if (a && typeof a === 'object') Object.entries(a).forEach(([k, v]) => preds.push((r) => eq(r[colOf(k)], v)));
              else preds.push((r) => eq(r[colOf(a)], b));
              return chain;
            };
          case 'whereNot':
            return (a, b) => {
              if (a && typeof a === 'object') Object.entries(a).forEach(([k, v]) => preds.push((r) => !eq(r[colOf(k)], v)));
              else preds.push((r) => !eq(r[colOf(a)], b));
              return chain;
            };
          case 'whereIn':
            return (col, list) => { preds.push((r) => list.map(String).includes(String(r[colOf(col)]))); return chain; };
          case 'whereNotNull':
            return (col) => { preds.push((r) => r[colOf(col)] != null); return chain; };
          case 'whereNull':
            return (col) => { preds.push((r) => r[colOf(col)] == null); return chain; };
          case 'whereNotIn':
            return (col, list) => { preds.push((r) => !list.map(String).includes(String(r[colOf(col)]))); return chain; };
          case 'first':
            return async () => { const m = match(); return m.length ? copy(m[0]) : undefined; };
          case 'insert':
            return async (rowToInsert) => { db.inserts.push({ table, row: rowToInsert }); if (table === 'day_replan_plans') db.plans.push({ ...rowToInsert }); return []; };
          case 'update':
            return async (patch) => {
              const m = match();
              db.updates.push({ table, patch, count: m.length });
              // Plain values only (a raw expression is not modelled): the rows follow the write, as the real table would.
              m.forEach((r) => Object.keys(patch).forEach((k) => { if (typeof patch[k] !== 'object' || patch[k] === null) r[k] = patch[k]; }));
              return m.length;
            };
          default:
            return () => chain;
        }
      },
    });
    return chain;
  };
  conn.raw = (sql) => ({ sql });
  conn.fn = { now: () => 'NOW()' };
  // A real transaction undoes its writes when it throws: the rows come back as they were.
  conn.transaction = async (fn) => {
    const snap = { rows: db.rows.map(copy), inserts: db.inserts.length, updates: db.updates.length };
    try {
      return await fn(conn);
    } catch (err) {
      db.rows.splice(0, db.rows.length, ...snap.rows);
      db.inserts.length = snap.inserts;
      db.updates.length = snap.updates;
      throw err;
    }
  };
  return { conn, db };
}

const toMin = (v) => { const [hh, mm] = String(v).slice(0, 5).split(':').map(Number); return hh * 60 + mm; };

/** The app's occupancy predicate (occupancy.js findConflictingVisits) over the in-memory schedule, tech-blind. */
function fakeFindConflicts(db) {
  const minutes = (v) => toMin(v);
  return jest.fn(async ({ date, windowStart, windowEnd, excludeServiceIds = [], excludeStatuses = [] }) => {
    const start = minutes(windowStart);
    const end = minutes(windowEnd);
    return db.rows.filter((o) => String(o.scheduled_date).slice(0, 10) === date && !excludeServiceIds.map(String).includes(String(o.id))
      && !excludeStatuses.includes(o.status) && !o.reservation_expires_at && o.window_start
      && minutes(o.window_start) < end
      && (o.window_end ? minutes(o.window_end) : minutes(o.window_start) + (Number(o.estimated_duration_minutes) || 60)) > start);
  });
}

/**
 * The apply writer's collaborators over the in-memory schedule: the real pure helpers of the runner, fakes for the
 * fence, the day reads, the occupancy predicate and the after-commit effects. `mocks` are the jest.fn()s to assert on.
 */
function makeApplyDeps(db, { now, blocks = [], over = {} } = {}) {
  const { _internals } = require('../../services/day-replan');
  const excludedStatuses = ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show'];
  const mocks = {
    syncMovedReminders: jest.fn(async () => {}),
    afterMoveEffects: jest.fn(async () => {}),
    repairMoved: jest.fn(async () => {}),
    acquireOccupancyLock: jest.fn(async () => {}),
    lockTechDays: jest.fn(async () => {}),
    lockDayRows: jest.fn(async () => []),
    trackTokenExpiry: jest.fn(() => 'expiry'),
    isBlackoutDate: jest.fn(async () => false),
    findConflicts: fakeFindConflicts(db),
    loadBlocks: jest.fn(async () => blocks),
  };
  const liveRows = (dateStr) => db.rows.filter((r) => String(r.scheduled_date).slice(0, 10) === dateStr && !excludedStatuses.includes(r.status) && !r.reservation_expires_at);
  const deps = {
    fixedReason: _internals.fixedReason,
    rowHours: _internals.rowHours,
    versionHash: _internals.versionHash,
    excludedStatuses,
    occupancyExcludeStatuses: ['cancelled', 'skipped', 'no_show', 'rescheduled', 'completed'],
    locationFields: ['property_id', 'lat', 'lng'],
    loadDayRows: jest.fn(async (_conn, dateStr) => liveRows(dateStr).map((r) => ({ ...r }))),
    now: () => now,
    ...mocks,
    ...over,
  };
  return { deps, mocks };
}

module.exports = { HQ, row, zigzagRows, makeDb, fakeFindConflicts, makeApplyDeps, toMin };
