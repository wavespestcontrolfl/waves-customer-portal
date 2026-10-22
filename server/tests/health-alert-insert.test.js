// Codex #6431 r4: every direct customer_health_alerts writer (billing-cron,
// stripe, stripe-webhook, autopay-sca-parked) goes through insertHealthAlert,
// which reads the customer FOR SHARE first. It waits for an in-flight merge,
// then files the alert on the live customer: as given, on the merge winner, or
// not at all for a customer deleted without a merge.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const { insertHealthAlert, MAX_MERGE_HOPS } = require('../services/health-alert-insert');

// live: set of live customer ids. missing: ids with no customers row. Any
// other id is a retired (soft-deleted) row. merges: loser id -> winner id.
function makeTrx({ live, merges = {}, missing = new Set() }) {
  const calls = { customers: [], journal: [], inserts: [] };
  const trx = (table) => {
    const c = { table, filters: {} };
    for (const m of ['whereNull', 'forShare', 'orderBy']) c[m] = jest.fn(() => c);
    c.where = jest.fn((f) => { Object.assign(c.filters, f); return c; });
    c.first = jest.fn(async () => {
      if (table === 'customers') {
        if (missing.has(c.filters.id)) return undefined;
        return { id: c.filters.id, deleted_at: live.has(c.filters.id) ? null : '2026-10-22T08:00:00Z' };
      }
      if (table === 'customer_merge_journal') {
        const winner = merges[c.filters.loser_customer_id];
        return winner ? { winner_customer_id: winner } : undefined;
      }
      return undefined;
    });
    c.insert = jest.fn((row) => { calls.inserts.push(row); return c; });
    c.returning = jest.fn(async () => [{ id: 'alert-new', ...calls.inserts[calls.inserts.length - 1] }]);
    if (table === 'customers') calls.customers.push(c);
    if (table === 'customer_merge_journal') calls.journal.push(c);
    return c;
  };
  return { trx, calls };
}

const ROW = { customer_id: 'loser', alert_type: 'payment_failure', severity: 'high', title: 't', description: 'd' };

beforeEach(() => {
  db.transaction = undefined;
});

test('a live customer gets the alert as given, after a FOR SHARE read of its row', async () => {
  const { trx, calls } = makeTrx({ live: new Set(['loser']) });
  const row = await insertHealthAlert(ROW, { trx });
  expect(row.customer_id).toBe('loser');
  expect(calls.customers[0].forShare).toHaveBeenCalled();
  expect(calls.customers[0].whereNull).not.toHaveBeenCalled();
  expect(calls.journal).toHaveLength(0);
});

test('a merged-away customer: the alert is filed on the live merge winner', async () => {
  const { trx, calls } = makeTrx({ live: new Set(['winner']), merges: { loser: 'winner' } });
  const row = await insertHealthAlert(ROW, { trx });
  expect(row.customer_id).toBe('winner');
  expect(calls.inserts).toEqual([{ ...ROW, customer_id: 'winner' }]);
  expect(calls.journal[0].whereNull).toHaveBeenCalledWith('undone_at');
  // The winner row is locked too, so a second merge in flight is waited on.
  expect(calls.customers.map((c) => c.filters.id)).toEqual(['loser', 'winner']);
  expect(calls.customers[1].forShare).toHaveBeenCalled();
});

test('a retired row is locked by id, so the read waits on a merge undo in flight', async () => {
  // A deleted_at filter in the WHERE would skip the retired row without
  // waiting for its lock; an undo committing meanwhile would be missed.
  const { trx, calls } = makeTrx({ live: new Set(['winner']), merges: { loser: 'winner' } });
  await insertHealthAlert(ROW, { trx });
  for (const c of calls.customers) {
    expect(c.forShare).toHaveBeenCalled();
    expect(c.whereNull).not.toHaveBeenCalled();
  }
});

test('a customer id with no row gets no alert', async () => {
  const { trx, calls } = makeTrx({ live: new Set(), missing: new Set(['loser']) });
  expect(await insertHealthAlert(ROW, { trx })).toBeNull();
  expect(calls.journal).toHaveLength(0);
  expect(calls.inserts).toHaveLength(0);
});

test('a chain of merges is followed to the live end', async () => {
  const { trx } = makeTrx({ live: new Set(['c']), merges: { loser: 'b', b: 'c' } });
  const row = await insertHealthAlert(ROW, { trx });
  expect(row.customer_id).toBe('c');
});

test('a customer deleted without a merge gets no alert', async () => {
  const { trx, calls } = makeTrx({ live: new Set() });
  expect(await insertHealthAlert(ROW, { trx })).toBeNull();
  expect(calls.inserts).toHaveLength(0);
});

test('a merge loop stops after MAX_MERGE_HOPS and inserts nothing', async () => {
  const { trx, calls } = makeTrx({ live: new Set(), merges: { loser: 'x', x: 'loser' } });
  expect(await insertHealthAlert(ROW, { trx })).toBeNull();
  expect(calls.customers.length).toBe(MAX_MERGE_HOPS + 1);
  expect(calls.inserts).toHaveLength(0);
});

test('a row with no customer_id inserts as given, with no fence read', async () => {
  const { trx, calls } = makeTrx({ live: new Set() });
  const row = await insertHealthAlert({ ...ROW, customer_id: null }, { trx });
  expect(row.customer_id).toBeNull();
  expect(calls.customers).toHaveLength(0);
});

test('without a trx it runs in its own transaction', async () => {
  const { trx, calls } = makeTrx({ live: new Set(['loser']) });
  db.transaction = jest.fn(async (fn) => fn(trx));
  await insertHealthAlert(ROW);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  expect(calls.inserts).toHaveLength(1);
});

test('no server file inserts into customer_health_alerts directly, outside the fenced writers', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const allowed = new Set(['services/health-alert-insert.js', 'services/health-alerts.js']);
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (!['node_modules', 'tests', 'models'].includes(ent.name)) walk(full);
      } else if (ent.name.endsWith('.js') && !allowed.has(rel)) {
        if (/customer_health_alerts['"]\)\s*\.insert\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
