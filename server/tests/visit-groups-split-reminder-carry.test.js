/**
 * splitChild carries the visit's already-decided reminder tiers onto the
 * detached row (GH codex #3699 r8 P2): a split landing between the owner's
 * ledger finalize and its member-row close — or after a worker crash —
 * would otherwise leave the detached row armed, and armed-without-a-visit
 * means the per-row path texts the same tier again. Scripted fake db.
 */
jest.mock('../models/db', () => {
  const calls = [];
  function makeChain(table, script, log) {
    const chain = {
      _ops: [],
      where() { chain._ops.push(['where', ...arguments]); return chain; },
      whereIn() { chain._ops.push(['whereIn', ...arguments]); return chain; },
      whereNot() { chain._ops.push(['whereNot', ...arguments]); return chain; },
      whereNotIn() { chain._ops.push(['whereNotIn', ...arguments]); return chain; },
      whereNull() { chain._ops.push(['whereNull', ...arguments]); return chain; },
      whereNotNull() { chain._ops.push(['whereNotNull', ...arguments]); return chain; },
      whereRaw() { chain._ops.push(['whereRaw', ...arguments]); return chain; },
      leftJoin() { chain._ops.push(['leftJoin', ...arguments]); return chain; },
      join() { chain._ops.push(['join', ...arguments]); return chain; },
      forUpdate() { chain._ops.push(['forUpdate']); return chain; },
      orderBy() { chain._ops.push(['orderBy', ...arguments]); return chain; },
      limit() { chain._ops.push(['limit', ...arguments]); return chain; },
      count() { chain._ops.push(['count', ...arguments]); return chain; },
      first(...cols) { log.push({ table, op: 'first', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].first ? script[table].first(chain._ops, cols) : null); },
      select(...cols) { log.push({ table, op: 'select', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].select ? script[table].select(chain._ops) : []); },
      pluck() { log.push({ table, op: 'pluck', ops: chain._ops }); return Promise.resolve([]); },
      update(values) { log.push({ table, op: 'update', ops: chain._ops, values }); return Promise.resolve(1); },
      insert(values) { log.push({ table, op: 'insert', ops: chain._ops, values }); return Promise.resolve([{}]); },
      del() { log.push({ table, op: 'del', ops: chain._ops }); return Promise.resolve(1); },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return chain;
  }
  const db = jest.fn((table) => makeChain(table, db.__script, calls));
  db.__calls = calls; db.__script = {};
  db.fn = { now: () => 'now()' };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => makeChain(table, db.__script, calls));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = { now: () => 'now()' };
    trx.isTransaction = true;
    return fn(trx);
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { splitChild } = require('../services/visit-groups');

const VISIT = { id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30', scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1' };
const CHILD = { id: 'a', visit_id: 'v1', status: 'confirmed', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00' };

const isLiveClaimQuery = (ops) => ops.some((o) => o[0] === 'where' && o[1] === 'status' && o[2] === 'claimed');
function script({ decided, liveClaim = false }) {
  db.__calls.length = 0;
  db.__script = {
    service_visits: { first: () => VISIT },
    scheduled_services: {
      // The remaining-member count keeps the visit alive (2 left).
      first: (ops) => (ops.some((o) => o[0] === 'count') ? { n: 2 } : CHILD),
      select: () => [],
    },
    visit_effects: {
      select: () => decided,
      // visitActivity's live-claim probe vs its any-effect probe.
      first: (ops) => (isLiveClaimQuery(ops) ? (liveClaim ? { id: 'eff-claimed' } : null) : null),
    },
  };
}
const reminderUpdates = () => db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update');

describe('splitChild carries decided reminder tiers onto the detached row', () => {
  test('a visit whose 24h tier is already sent closes the detached row\'s 24h flag in the split transaction; 72h (undecided) stays armed', async () => {
    script({ decided: [{ effect_type: 'reminder_24h' }] });

    const res = await splitChild({ visitId: 'v1', scheduledServiceId: 'a', createdBy: 'office' });

    expect(res).toEqual({ detached: 'a', visitId: 'v1' });
    // Ledger read for the row's OWN occurrence date, decided outcomes only.
    const ledger = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'select');
    expect(ledger.ops).toEqual(expect.arrayContaining([
      ['where', { visit_id: 'v1' }],
      ['whereIn', 'dedupe_key', ['v1:reminder_72h:2026-08-30', 'v1:reminder_24h:2026-08-30']],
      ['whereIn', 'status', ['sent', 'suppressed']],
    ]));
    const updates = reminderUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].ops).toEqual([['where', { scheduled_service_id: 'a', cancelled: false, reminder_24h_sent: false }]]);
    expect(updates[0].values).toEqual({ reminder_24h_sent: true, reminder_24h_sent_at: 'now()' });
  });

  test('a reminder tier claimed inside its lease refuses the split (owner mid-send / delivered but not yet closed everywhere)', async () => {
    script({ decided: [], liveClaim: true });

    await expect(splitChild({ visitId: 'v1', scheduledServiceId: 'a', createdBy: 'office' }))
      .rejects.toMatchObject({ code: 'VISIT_SPLIT_REFUSED', message: 'split refused: reminder_in_flight' });
    // Nothing detached, nothing closed.
    expect(db.__calls.filter((c) => c.op === 'update')).toHaveLength(0);
    // Lease-bounded probe: claimed_at must be inside the lease window.
    const probe = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'first' && isLiveClaimQuery(c.ops));
    expect(probe.ops).toEqual(expect.arrayContaining([
      ['whereIn', 'effect_type', ['reminder_72h', 'reminder_24h']],
      ['where', 'claimed_at', '>', expect.any(Date)],
    ]));
  });

  test('no decided tier: the detached row keeps every flag armed (over-notify, never silence)', async () => {
    script({ decided: [] });

    await splitChild({ visitId: 'v1', scheduledServiceId: 'a', createdBy: 'office' });

    expect(reminderUpdates()).toHaveLength(0);
  });
});
