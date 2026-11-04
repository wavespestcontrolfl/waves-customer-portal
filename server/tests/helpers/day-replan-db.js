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
    customer_address_line1: `${id} Test Ln`,
    customer_city: 'Parrish',
    customer_zip: '34219',
    property_id: null,
    recurring_dispatch_due_date: null,
    lat: HQ.lat,
    lng: HQ.lng + lngOffset,
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
          case 'whereNotIn':
            return (col, list) => { preds.push((r) => !list.map(String).includes(String(r[colOf(col)]))); return chain; };
          case 'first':
            return async () => { const m = match(); return m.length ? copy(m[0]) : undefined; };
          case 'insert':
            return async (rowToInsert) => { db.inserts.push({ table, row: rowToInsert }); if (table === 'day_replan_plans') db.plans.push({ ...rowToInsert }); return []; };
          case 'update':
            return async (patch) => { const m = match(); db.updates.push({ table, patch, count: m.length }); return m.length; };
          default:
            return () => chain;
        }
      },
    });
    return chain;
  };
  conn.raw = (sql) => ({ sql });
  conn.fn = { now: () => 'NOW()' };
  return { conn, db };
}

const toMin = (v) => { const [hh, mm] = String(v).slice(0, 5).split(':').map(Number); return hh * 60 + mm; };

/** A rebooker over the in-memory schedule: runs beforeMove, the CAS and the occupancy check like the real one. */
function fakeRebooker(db, conn, { failWhen = () => false, textWhen = () => false, techBlind = true } = {}) {
  const calls = [];
  const reschedule = jest.fn(async (id, date, win, reason, by, options) => {
    calls.push({ id, date, win, reason, by, options });
    if (failWhen(id, win, calls.length)) throw Object.assign(new Error('That time is no longer available'), { code: 'SLOT_TAKEN', statusCode: 409 });
    if (options.beforeMove) await options.beforeMove(conn);
    const r = db.rows.find((x) => x.id === id);
    for (const [key, value] of Object.entries(options.expect)) {
      if (String(r[key] ?? null) !== String(value ?? null)) throw Object.assign(new Error('The visit changed'), { code: 'CAS_MISS', statusCode: 409 });
    }
    const start = toMin(win.start);
    const end = toMin(win.end);
    const clash = db.rows.find((o) => o.id !== id && o.scheduled_date === date && o.window_start
      && (techBlind || o.technician_id == null || o.technician_id === r.technician_id)
      && toMin(o.window_start) < end && toMin(o.window_end) > start && !['cancelled', 'completed'].includes(o.status));
    if (clash) throw Object.assign(new Error('That time is taken'), { code: 'SLOT_TAKEN', statusCode: 409 });
    r.window_start = `${win.start}:00`;
    r.window_end = `${win.end}:00`;
    r.updated_at = new Date();
    return { landedStatus: r.status, smsSent: textWhen(id, win) };
  });
  return { reschedule, calls };
}


module.exports = { HQ, row, zigzagRows, makeDb, fakeRebooker, toMin };
