// server/scripts/dunning-customer-schedule-release.js — the kill switch by
// hand (dunning consolidation §9.4). Dry run by default (a READ ONLY
// transaction, no release); --execute releases each open schedule through
// the engine's own Schedule.release ('released_admin'); ids only in output.
const fs = require('fs');
const path = require('path');

const mockDestroy = jest.fn(async () => {});
jest.mock('../models/db', () => {
  const fake = jest.fn();
  fake.destroy = (...a) => mockDestroy(...a);
  return fake;
});
const mockSchedule = {
  TABLE: 'customer_dunning_schedules',
  inReadOnlyTransaction: jest.fn(async (database, fn) => fn(database)),
  activeMemberRows: jest.fn(),
  landingFrom: jest.fn(),
  release: jest.fn(),
};
jest.mock('../services/customer-dunning/schedule', () => mockSchedule);
jest.mock('../services/invoice-followups', () => ({
  followupSteps: () => ['d3_friendly', 'd10_reminder', 'd17_reminder', 'd30_final', 'd60_reminder', 'd90_final_notice'].map((id) => ({ id })),
}));

const script = require('../scripts/dunning-customer-schedule-release');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dunning-customer-schedule-release.js'), 'utf8');
const CODE = SOURCE.replace(/^\s*\/\/.*$/gm, '');
const CUST = '0b6f4a52-6a0e-4c8e-9c7e-2f3a9d8e1a01';
const NOW = new Date('2026-10-07T14:16:00Z');
const schedule = (id, over = {}) => ({ id, customer_id: CUST, status: 'active', step_index: 3, next_touch_at: NOW, touch_claimed_at: null, ...over });

function fakeDatabase(rows) {
  const calls = [];
  const q = {};
  for (const m of ['whereIn', 'orderBy', 'where']) q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
  q.select = jest.fn(async () => rows);
  const database = jest.fn(() => q);
  database.calls = calls;
  return database;
}

let logs;
beforeEach(() => {
  jest.clearAllMocks();
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));
  jest.spyOn(console, 'warn').mockImplementation((line) => logs.push(String(line)));
  jest.spyOn(console, 'error').mockImplementation((line) => logs.push(String(line)));
});
afterEach(() => {
  console.log.mockRestore(); console.warn.mockRestore(); console.error.mockRestore();
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.DATABASE_URL;
  process.exitCode = undefined;
});

describe('static', () => {
  test('says it MUTATES, dry run by default, and never prints a name or contact detail', () => {
    expect(SOURCE.split('\n')[1]).toMatch(/MUTATES \(dry-run default; pass --execute to write\)/);
    expect(CODE).toMatch(/if \(!execute\) return;/);
    expect(CODE).not.toMatch(/first_name|last_name|\bphone\b|\bemail\b/);
    // the only write path is the engine's own release; no hand-written update
    expect(CODE).not.toMatch(/\.update\(|\.insert\(|\.del\(/);
    expect(CODE).toMatch(/Schedule\.release\(schedule, 'released_admin', now\)/);
  });
});

describe('parseArgs', () => {
  test('dry run by default; --execute; --customer must be a uuid (lower-cased)', () => {
    expect(script.parseArgs(['node', 's'])).toEqual({ customerId: null, execute: false });
    expect(script.parseArgs(['node', 's', '--execute'])).toEqual({ customerId: null, execute: true });
    expect(script.parseArgs(['node', 's', '--customer', CUST.toUpperCase(), '--execute'])).toEqual({ customerId: CUST, execute: true });
    expect(script.parseArgs(['node', 's', '--customer', 'nope'])).toEqual({ error: '--customer needs a customer id (uuid)' });
    expect(script.parseArgs(['node', 's', '--customer'])).toHaveProperty('error');
  });
});

describe('planRelease / executeRelease', () => {
  test('plans every OPEN schedule (or one customer\'s) with where each active member would land', async () => {
    const database = fakeDatabase([schedule('s1')]);
    mockSchedule.activeMemberRows.mockResolvedValue([{ id: 'q1', invoice_id: 'i1', step_index: 2 }, { id: 'q2', invoice_id: 'i2', step_index: 5 }]);
    mockSchedule.landingFrom.mockReturnValueOnce({ stepIndex: 3, nextAt: NOW }).mockReturnValueOnce(null);
    const plans = await script.planRelease(database, { customerId: CUST, now: NOW, Schedule: mockSchedule });
    expect(database).toHaveBeenCalledWith('customer_dunning_schedules');
    expect(database.calls).toContainEqual(['whereIn', 'status', ['active', 'held', 'paused', 'autopay_hold']]);
    expect(database.calls).toContainEqual(['where', { customer_id: CUST }]);
    expect(mockSchedule.activeMemberRows).toHaveBeenCalledWith(CUST, { database });
    // no step repeated: landing starts at max(member step, schedule step)
    expect(mockSchedule.landingFrom.mock.calls.map((c) => c[1])).toEqual([3, 5]);
    expect(plans[0].landings).toEqual([
      { invoice_id: 'i1', seq_id: 'q1', landing: { stepIndex: 3, nextAt: NOW } },
      { invoice_id: 'i2', seq_id: 'q2', landing: null },
    ]);
    script.printPlan(plans[0], (i) => ['a', 'b', 'c', 'd30_final', 'e', 'f'][i]);
    expect(logs.join('\n')).toMatch(/schedule s1 {2}customer [0-9a-f-]{36} {2}active {2}step d30_final/);
    expect(logs.join('\n')).toMatch(/member invoice i2 {2}seq q2 {2}-> PAUSED/);
  });

  test('releases through Schedule.release as released_admin; tallies in-flight / already closed / failures without stopping', async () => {
    mockSchedule.release
      .mockResolvedValueOnce({ closed: true, landed: [{}, {}] })
      .mockResolvedValueOnce({ closed: false, landed: [], reason: 'in_flight' })
      .mockResolvedValueOnce({ closed: false, landed: [] })
      .mockRejectedValueOnce(new Error('deadlock detected'));
    const tally = await script.executeRelease(['s1', 's2', 's3', 's4'].map((id) => ({ schedule: schedule(id) })), { now: NOW, Schedule: mockSchedule });
    expect(tally).toEqual({ released: 1, inFlight: 1, alreadyClosed: 1, failed: 1 });
    expect(mockSchedule.release.mock.calls.map((c) => [c[0].id, c[1], c[2]])).toEqual(
      ['s1', 's2', 's3', 's4'].map((id) => [id, 'released_admin', NOW]),
    );
  });
});

describe('main', () => {
  const run = async (args) => {
    const argv = process.argv;
    process.argv = ['node', 'dunning-customer-schedule-release.js', ...args];
    try { await script.main(); } finally { process.argv = argv; }
  };

  test('dry run: reads in the READ ONLY transaction, releases nothing, closes the pool', async () => {
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const db = require('../models/db');
    db.mockImplementation(() => fakeDatabase([schedule('s1')])());
    mockSchedule.activeMemberRows.mockResolvedValue([]);
    await run([]);
    expect(mockSchedule.inReadOnlyTransaction).toHaveBeenCalledTimes(1);
    expect(mockSchedule.release).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/DRY RUN \(read-only\) — 1 open schedule/);
    expect(mockDestroy).toHaveBeenCalled();
  });

  test('--execute refuses without GATE_DUNNING_LADDER_90 (before touching the database)', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw Object.assign(new Error('exit'), { code }); });
    await expect(run(['--execute'])).rejects.toMatchObject({ code: 1 });
    expect(logs.join('\n')).toMatch(/REFUSING --execute/);
    expect(mockSchedule.inReadOnlyTransaction).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  test('--execute releases and exits 1 while a schedule is still in flight', async () => {
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const db = require('../models/db');
    db.mockImplementation(() => fakeDatabase([schedule('s1'), schedule('s2')])());
    mockSchedule.activeMemberRows.mockResolvedValue([]);
    mockSchedule.release.mockResolvedValueOnce({ closed: true, landed: [] }).mockResolvedValueOnce({ closed: false, landed: [], reason: 'in_flight' });
    await run(['--execute']);
    expect(mockSchedule.release).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).toMatch(/released 1, in flight 1, already closed 0, failed 0/);
    expect(process.exitCode).toBe(1);
  });
});
