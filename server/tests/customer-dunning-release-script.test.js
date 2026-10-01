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
  currentStepDelivery: jest.fn(async () => null),
  memberLanding: jest.fn(),
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
    expect(script.parseArgs(['node', 's', '--customer', 'nope']).error).toMatch(/^--customer needs a customer id \(uuid\)\nusage: /);
    expect(script.parseArgs(['node', 's', '--customer'])).toHaveProperty('error');
  });

  // Codex local review P2: `--customer=<id> --execute` parsed as { customerId: null, execute: true } and
  // released EVERY open schedule. The = form is supported, and anything unrecognized is a usage error.
  test('--customer=<id> names one customer, exactly like --customer <id>', () => {
    expect(script.parseArgs(['node', 's', `--customer=${CUST.toUpperCase()}`, '--execute'])).toEqual({ customerId: CUST, execute: true });
    expect(script.parseArgs(['node', 's', '--execute', `--customer=${CUST}`])).toEqual({ customerId: CUST, execute: true });
    expect(script.parseArgs(['node', 's', '--customer=']).error).toMatch(/needs a customer id/);
    expect(script.parseArgs(['node', 's', '--customer=nope', '--execute']).error).toMatch(/needs a customer id/);
  });

  test.each([
    [['--customr', CUST, '--execute']],
    [['--customer_id=' + CUST, '--execute']],
    [['--execute', '--all']],
    [['-x']],
    [[CUST, '--execute']],
    [['--customer', CUST, '--customer', CUST]],
    [[`--customer=${CUST}`, '--customer', CUST, '--execute']],
    [['--execute', '--execute']],
  ])('anything unrecognized or repeated is a usage error, never "every schedule": %j', (args) => {
    const out = script.parseArgs(['node', 's', ...args]);
    expect(out).toEqual({ error: expect.stringMatching(/\nusage: dunning-customer-schedule-release\.js/) });
    expect(out).not.toHaveProperty('execute');
  });
});

describe('planRelease / executeRelease', () => {
  test('plans every OPEN schedule (or one customer\'s) with where each active member would land (the engine\'s own memberLanding)', async () => {
    const database = fakeDatabase([schedule('s1')]);
    const rows = [
      { id: 'q1', invoice_id: 'i1', step_index: 2 }, { id: 'q2', invoice_id: 'i2', step_index: 5 },
      { id: 'q3', invoice_id: 'i3', step_index: 3 }, { id: 'q4', invoice_id: 'i4', step_index: 1 },
    ];
    mockSchedule.activeMemberRows.mockResolvedValue(rows);
    const delivery = { final: false, named: new Set(['i1']) };
    mockSchedule.currentStepDelivery.mockResolvedValueOnce(delivery);
    mockSchedule.memberLanding
      .mockReturnValueOnce({ kind: 'land', stepIndex: 4, nextAt: NOW })
      .mockReturnValueOnce({ kind: 'pause_for_person', reason: 'released_past_final_step' })
      .mockReturnValueOnce({ kind: 'paused', stepIndex: 3, pausedReason: 'customer called', pausedBy: null })
      .mockReturnValueOnce({ kind: 'complete' });
    const plans = await script.planRelease(database, { customerId: CUST, now: NOW, Schedule: mockSchedule });
    expect(database).toHaveBeenCalledWith('customer_dunning_schedules');
    expect(database.calls).toContainEqual(['whereIn', 'status', ['active', 'held', 'paused', 'autopay_hold']]);
    expect(database.calls).toContainEqual(['where', { customer_id: CUST }]);
    expect(mockSchedule.activeMemberRows).toHaveBeenCalledWith(CUST, { database });
    // the same plan the release writes: each row, the schedule as read, the current step's delivery evidence
    expect(mockSchedule.currentStepDelivery).toHaveBeenCalledWith(schedule('s1'));
    expect(mockSchedule.memberLanding.mock.calls).toEqual(rows.map((row) => [row, schedule('s1'), delivery, NOW]));
    expect(plans[0].landings.map((l) => l.landing.kind)).toEqual(['land', 'pause_for_person', 'paused', 'complete']);
    script.printPlan(plans[0], (i) => ['a', 'b', 'c', 'd30_final', 'e', 'f'][i]);
    const out = logs.join('\n');
    expect(out).toMatch(/schedule s1 {2}customer [0-9a-f-]{36} {2}active {2}step d30_final/);
    expect(out).toMatch(/member invoice i1 {2}seq q1 {2}-> step e {2}next 2026-10-07T14:16:00\.000Z/);
    expect(out).toMatch(/member invoice i2 {2}seq q2 {2}-> PAUSED \(past its final step/);
    expect(out).toMatch(/member invoice i3 {2}seq q3 {2}-> PAUSED at step d30_final \(the schedule is paused: customer called\)/);
    expect(out).toMatch(/member invoice i4 {2}seq q4 {2}-> COMPLETED/);
  });

  test('a schedule whose delivery evidence cannot be read is listed as not releasable, with no landings', async () => {
    const database = fakeDatabase([schedule('s1')]);
    mockSchedule.currentStepDelivery.mockRejectedValueOnce(new Error('ledger unreadable'));
    const plans = await script.planRelease(database, { now: NOW, Schedule: mockSchedule });
    expect(plans[0]).toMatchObject({ landings: [], evidenceError: 'ledger unreadable' });
    expect(mockSchedule.memberLanding).not.toHaveBeenCalled();
    script.printPlan(plans[0], () => null);
    expect(logs.join('\n')).toMatch(/NOT RELEASABLE NOW/);
  });

  test('the dry run flags a schedule whose current step has an unconfirmed outcome', async () => {
    const database = fakeDatabase([schedule('s1')]);
    mockSchedule.currentStepDelivery.mockResolvedValueOnce({ delivered: false, unconfirmed: true, final: false, named: new Set() });
    mockSchedule.activeMemberRows.mockResolvedValue([{ id: 'q1', invoice_id: 'i1', step_index: 2 }]);
    mockSchedule.memberLanding.mockReturnValueOnce({ kind: 'land', stepIndex: 3, nextAt: NOW });
    const plans = await script.planRelease(database, { now: NOW, Schedule: mockSchedule });
    script.printPlan(plans[0], (i) => `step${i}`);
    expect(logs.join('\n')).toMatch(/NOT RELEASABLE NOW: a reminder for the current step may already have gone out \(outcome unconfirmed\)/);
  });

  test('releases through Schedule.release as released_admin; tallies in-flight / already closed / failures without stopping', async () => {
    mockSchedule.release
      .mockResolvedValueOnce({ closed: true, landed: [{}, {}] })
      .mockResolvedValueOnce({ closed: false, landed: [], reason: 'in_flight' })
      .mockResolvedValueOnce({ closed: false, landed: [] })
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ closed: false, landed: [], reason: 'evidence_unreadable' })
      .mockResolvedValueOnce({ closed: false, landed: [], reason: 'outcome_unconfirmed' });
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const tally = await script.executeRelease(ids.map((id) => ({ schedule: schedule(id) })), { now: NOW, Schedule: mockSchedule });
    expect(tally).toEqual({ released: 1, inFlight: 1, alreadyClosed: 1, failed: 3 });
    expect(mockSchedule.release.mock.calls.map((c) => [c[0].id, c[1], c[2]])).toEqual(ids.map((id) => [id, 'released_admin', NOW]));
    expect(logs.join('\n')).toMatch(/NOT released schedule s6: a reminder for its current step may already have gone out \(outcome unconfirmed\)/);
    expect(logs.join('\n')).toMatch(/NOT released schedule s5: its current step's delivery could not be read/);
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

  test('an unrecognized argument exits 1 with the usage BEFORE touching the database or releasing anything', async () => {
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const db = require('../models/db');
    const exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw Object.assign(new Error('exit'), { code }); });
    await expect(run([`--customer-id=${CUST}`, '--execute'])).rejects.toMatchObject({ code: 1 });
    expect(logs.join('\n')).toMatch(/unrecognized argument: --customer-id=/);
    expect(logs.join('\n')).toMatch(/usage: /);
    expect(db).not.toHaveBeenCalled();
    expect(mockSchedule.inReadOnlyTransaction).not.toHaveBeenCalled();
    expect(mockSchedule.release).not.toHaveBeenCalled();
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
