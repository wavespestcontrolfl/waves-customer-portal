// Customer-level overdue reminders — the LIVE wiring (dunning consolidation
// PR 3, plan §4 / §8 / §9.4):
//   * runPending order: kill switch -> promotion (live gate only) -> the
//     per-invoice batch (with the ownership predicate) -> the live engine or
//     the shadow run; gate off with no schedule rows changes nothing.
//   * fireStep takes the customer's dunning key SHARED before its invoice row
//     lock and never claims an owned row; sendNextTouchNow routes an owned
//     customer to the schedule's send-now.
//   * wiring.js: releaseIfDark (reasons, in-flight, failure alert, shadow-only
//     no-op, allowlist), the send-now live gate, the control results the
//     routes return (IN_FLIGHT copy end to end through admin.js).
//   * cross-rail: previsit suppression after a schedule touch; the autopay
//     failure hook leaves the schedule to the engine's daily revisit.
// The real-Postgres proofs (lock order under concurrency, owned rows never
// firing, the kill switch landing members) are in
// customer-dunning-live-wiring-postgres.test.js.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// ── a recording fake of the db module ──────────────────────────────────────
// Every db(table) call returns a chain; awaiting it yields mockDb.results[table]
// (default []); .first() yields mockDb.firsts[table]. Writes and the order of
// table reads / raw statements are recorded on mockDb.log.
const mockDb = { results: {}, firsts: {}, log: [], raw: null, throwOn: {} };
function mockChain(table) {
  const calls = [];
  const settle = (kind) => {
    if (mockDb.throwOn[table]) return Promise.reject(mockDb.throwOn[table]);
    if (kind === 'first') {
      const v = mockDb.firsts[table];
      return Promise.resolve(typeof v === 'function' ? v(calls) : v);
    }
    const v = mockDb.results[table];
    return Promise.resolve(typeof v === 'function' ? v(calls) : (v ?? []));
  };
  const chain = new Proxy(function chainFn() {}, {
    get: (_t, prop) => {
      if (prop === 'then') return (resolve, reject) => settle('all').then(resolve, reject);
      if (prop === 'catch') return (reject) => settle('all').catch(reject);
      if (prop === 'calls') return calls;
      if (prop === 'first') return (...args) => { calls.push(['first', ...args]); return settle('first'); };
      return (...args) => {
        calls.push([prop, ...args]);
        if (['update', 'insert', 'del', 'delete'].includes(prop)) mockDb.log.push({ write: prop, table, args, calls: [...calls] });
        if (prop === 'forUpdate') mockDb.log.push({ lock: table });
        return chain;
      };
    },
  });
  return chain;
}
jest.mock('../models/db', () => {
  const fake = jest.fn((table) => { mockDb.log.push({ table }); mockDb.chains.push([table, mockChain(table)]); return mockDb.chains.at(-1)[1]; });
  fake.fn = { now: () => 'now()' };
  fake.raw = jest.fn((sql, bindings) => { mockDb.log.push({ raw: sql, bindings }); return mockDb.raw ? mockDb.raw(sql, bindings) : Promise.resolve({ rows: [] }); });
  fake.transaction = jest.fn(async (fn) => fn(fake));
  return fake;
});
mockDb.chains = [];

const mockGates = { live: false, shadow: false, prereqs: true, allow: null };
jest.mock('../config/feature-gates', () => ({
  gates: {},
  dunningCustomerScheduleLive: () => mockGates.live && mockGates.prereqs,
  dunningCustomerScheduleShadowLive: () => mockGates.shadow && mockGates.prereqs,
  dunningCustomerSchedulePrereqsLive: () => mockGates.prereqs,
  dunningCustomerScheduleAllowlist: () => mockGates.allow,
}));
const mockNotify = jest.fn(async () => ({ id: 'n1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/customer-dunning/runner', () => ({
  shadowRun: jest.fn(async () => ({})), runCustomerSchedules: jest.fn(async () => ({})), processSchedule: jest.fn(),
  shadowVerdictBeforeRelease: jest.fn(async () => 'send'),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const Followups = require('../services/invoice-followups');
const Schedule = require('../services/customer-dunning/schedule');
const Runner = require('../services/customer-dunning/runner');
const Admin = require('../services/customer-dunning/admin');
const Wiring = require('../services/customer-dunning/wiring');
const { OPEN_STATUSES, lockKey } = require('../services/customer-dunning/constants');

const NOW = new Date('2026-10-07T14:16:00Z'); // Wednesday, inside the send window
const CUST = '0b6f4a52-6a0e-4c8e-9c7e-2f3a9d8e1a01';
const CUST2 = '0b6f4a52-6a0e-4c8e-9c7e-2f3a9d8e1a02';
const IN_FLIGHT_COPY = 'The reminder is sending right now. Try again in a minute.';

const writes = () => mockDb.log.filter((e) => e.write);
const tablesRead = () => mockDb.log.filter((e) => e.table).map((e) => e.table);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  Object.assign(mockGates, { live: false, shadow: false, prereqs: true, allow: null });
  Object.assign(mockDb, { results: {}, firsts: {}, log: [], raw: null, throwOn: {}, chains: [] });
  require('../services/customer-dunning/wiring')._test.resetReadMemory();
});
// Only the spies are restored: the db / gate / runner fakes keep their implementations.
afterEach(() => {
  jest.useRealTimers();
  for (const [obj, name] of SPIED) if (obj[name]?.mockRestore) obj[name].mockRestore();
});
const SPIED = [];
const realSpyOn = jest.spyOn.bind(jest);
jest.spyOn = (obj, name, ...rest) => { SPIED.push([obj, name]); return realSpyOn(obj, name, ...rest); };

// ── runPending order ───────────────────────────────────────────────────────
describe('runPending: kill switch -> promotion -> per-invoice batch -> engine', () => {
  function trace() {
    const order = [];
    jest.spyOn(Wiring, 'releaseIfDark').mockImplementation(async () => { order.push('releaseIfDark'); return { released: 0, inFlight: 0, failed: 0 }; });
    jest.spyOn(Schedule, 'promote').mockImplementation(async () => { order.push('promote'); return { promoted: [] }; });
    Runner.runCustomerSchedules.mockImplementation(async () => { order.push('runCustomerSchedules'); });
    Runner.shadowRun.mockImplementation(async () => { order.push('shadowRun'); });
    mockDb.results['invoice_followup_sequences as s'] = () => { order.push('batch'); return []; };
    return order;
  }

  test('live gate on: release, promote, then the batch, then the live engine (never the shadow run)', async () => {
    mockGates.live = true;
    mockGates.shadow = true;
    const order = trace();
    await expect(Followups.runPending()).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(order).toEqual(['releaseIfDark', 'promote', 'batch', 'runCustomerSchedules']);
    expect(Wiring.releaseIfDark).toHaveBeenCalledWith(NOW);
    expect(Schedule.promote).toHaveBeenCalledWith(NOW);
    // claims count the per-invoice loop's wall time: the engine's clock starts at runPending's start
    expect(Runner.runCustomerSchedules).toHaveBeenCalledWith(NOW, { clockStartedAt: NOW.getTime() });
  });

  test('shadow only: the kill switch still runs first, no promotion, shadowRun after the batch', async () => {
    mockGates.shadow = true;
    const order = trace();
    await Followups.runPending();
    expect(order).toEqual(['releaseIfDark', 'batch', 'shadowRun']);
  });

  test('a prerequisite off turns the live gate off too: no promotion, no live run', async () => {
    mockGates.live = true;
    mockGates.prereqs = false;
    const order = trace();
    await Followups.runPending();
    expect(order).toEqual(['releaseIfDark', 'batch']);
  });

  test('outside the send window nothing customer-dunning runs at all', async () => {
    jest.setSystemTime(new Date('2026-10-05T14:16:00Z')); // Monday
    mockGates.live = true;
    const order = trace();
    await Followups.runPending();
    expect(order).toEqual([]);
  });

  test('a promotion or engine failure is logged and never costs the per-invoice result', async () => {
    mockGates.live = true;
    trace();
    Schedule.promote.mockRejectedValueOnce(new Error('promote blew up'));
    Runner.runCustomerSchedules.mockRejectedValueOnce(new Error('engine blew up'));
    await expect(Followups.runPending()).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('promote blew up'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('engine blew up'));
  });

  test('an unexpected kill-switch throw is logged and the batch still runs', async () => {
    mockGates.live = true;
    const order = trace();
    Wiring.releaseIfDark.mockRejectedValueOnce(new Error('kill switch blew up'));
    await expect(Followups.runPending()).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('kill switch blew up'));
    expect(order).toEqual(['batch', 'runCustomerSchedules']);
  });

  test('the batch carries the ownership predicate: NOT EXISTS an OPEN schedule for the row\'s customer', async () => {
    trace();
    await Followups.runPending();
    const [, batch] = mockDb.chains.find(([t]) => t === 'invoice_followup_sequences as s');
    const predicate = Followups._test.notOwnedByCustomerSchedule;
    expect(batch.calls.some(([m, arg]) => m === 'where' && arg === predicate)).toBe(true);
    const builder = { whereRaw: jest.fn() };
    predicate.call(builder);
    const [sql, bindings] = builder.whereRaw.mock.calls[0];
    expect(sql).toMatch(/^NOT EXISTS \(SELECT 1 FROM customer_dunning_schedules c WHERE c\.customer_id = s\.customer_id AND c\.status IN \(\?, \?, \?, \?\)\)$/);
    expect(bindings).toEqual(['active', 'held', 'paused', 'autopay_hold']);
    expect(bindings).toEqual([...OPEN_STATUSES]);
  });

  test('PIN — live gate off, no schedule rows: one read of the schedule table, no write, no alert, no engine', async () => {
    mockGates.shadow = false;
    mockDb.results.customer_dunning_schedules = [];
    await expect(Followups.runPending()).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(tablesRead().filter((t) => t === 'customer_dunning_schedules')).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(Runner.runCustomerSchedules).not.toHaveBeenCalled();
    expect(Runner.shadowRun).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled(); // no row fired, so no advisory key either
  });
});

// ── fireStep: the shared key, before the invoice lock; owned => no claim ─────
describe('fireStep ownership fence', () => {
  const row = { id: 'seq-1', invoice_id: 'inv-1', customer_id: CUST, step_index: 2, next_touch_at: new Date(NOW.getTime() - 60000) };
  function dueRow() {
    mockDb.firsts.invoices = { id: 'inv-1', customer_id: CUST, status: 'overdue' };
    mockDb.firsts.invoice_followup_sequences = { id: 'seq-1', customer_id: CUST, status: 'active', step_index: 2, next_touch_at: row.next_touch_at };
  }

  test('takes the customer key SHARED first, then the invoice row; an owned customer is never claimed or fired', async () => {
    dueRow();
    mockDb.raw = async (sql) => ({ rows: /customer_dunning_schedules/.test(sql) ? [{ id: 'sched-9' }] : [] });
    const out = await Followups._test.fireStep({ ...row });
    expect(out).toEqual({ ownedBy: 'sched-9' });
    const lockAt = mockDb.log.findIndex((e) => e.raw && /pg_advisory_xact_lock_shared/.test(e.raw));
    const invoiceLockAt = mockDb.log.findIndex((e) => e.lock === 'invoices');
    const ownershipAt = mockDb.log.findIndex((e) => e.raw && /customer_dunning_schedules/.test(e.raw));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(invoiceLockAt);
    expect(invoiceLockAt).toBeLessThan(ownershipAt);
    expect(mockDb.log[lockAt].bindings).toEqual([lockKey(CUST)]);
    expect(mockDb.log[ownershipAt].bindings).toEqual([CUST, ...OPEN_STATUSES]);
    expect(writes()).toEqual([]); // no touch_claimed_at stamp, nothing else
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('is on customer reminder schedule sched-9'));
  });

  test('not owned: the claim is stamped as before', async () => {
    dueRow();
    mockDb.results.invoice_followup_sequences = 0; // the claim UPDATE matches nothing -> treated as in flight, no send
    const out = await Followups._test.fireStep({ ...row });
    expect(out).toBeUndefined();
    const claim = writes().find((w) => w.table === 'invoice_followup_sequences');
    expect(claim.args[0]).toMatchObject({ touch_claimed_at: expect.any(Date) });
  });
});

// ── sendNextTouchNow routing ───────────────────────────────────────────────
describe('sendNextTouchNow (the invoice follow-up send-now)', () => {
  beforeEach(() => {
    mockDb.firsts.invoice_followup_sequences = { id: 'seq-1', invoice_id: 'inv-1', customer_id: CUST, status: 'active', step_index: 2 };
    mockDb.firsts.invoices = { id: 'inv-1', customer_id: CUST, status: 'overdue' };
  });

  test('an owned customer: the schedule\'s send-now, and the member row is left exactly as it is', async () => {
    mockDb.raw = async (sql) => ({ rows: /customer_dunning_schedules/.test(sql) ? [{ id: 'sched-1' }] : [] });
    const routed = { routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' };
    const spy = jest.spyOn(Wiring, 'sendNowForSchedule').mockResolvedValue(routed);
    await expect(Followups.sendNextTouchNow('inv-1', { operatorInitiated: true })).resolves.toEqual(routed);
    expect(spy).toHaveBeenCalledWith('sched-1', CUST);
    expect(writes()).toEqual([]);
    // the ownership read ran under the shared key
    const raws = mockDb.log.filter((e) => e.raw).map((e) => e.raw);
    expect(raws[0]).toMatch(/pg_advisory_xact_lock_shared/);
    expect(raws[1]).toMatch(/customer_dunning_schedules/);
  });

  test('not owned: re-armed under the shared key, then the per-invoice touch (undefined result, as before)', async () => {
    const spy = jest.spyOn(Wiring, 'sendNowForSchedule');
    mockDb.firsts['invoice_followup_sequences as s'] = undefined; // nothing to fire in this fake
    await expect(Followups.sendNextTouchNow('inv-1', { operatorInitiated: true })).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    const rearm = writes().find((w) => w.table === 'invoice_followup_sequences');
    expect(rearm.args[0]).toMatchObject({ status: 'active', next_touch_at: expect.any(Date) });
    const lockAt = mockDb.log.findIndex((e) => e.raw && /pg_advisory_xact_lock_shared/.test(e.raw));
    expect(lockAt).toBeLessThan(mockDb.log.indexOf(rearm));
  });

  test('promoted between the re-arm and the fire: fireStep refuses under the key and the click goes to the schedule', async () => {
    let ownershipReads = 0;
    mockDb.raw = async (sql) => {
      if (!/customer_dunning_schedules/.test(sql)) return { rows: [] };
      ownershipReads += 1;
      return { rows: ownershipReads === 1 ? [] : [{ id: 'sched-2' }] };
    };
    const due = new Date(NOW.getTime() - 1000);
    mockDb.firsts['invoice_followup_sequences as s'] = { id: 'seq-1', invoice_id: 'inv-1', customer_id: CUST, step_index: 2, next_touch_at: due };
    // fireStep's locked re-read sees the re-armed row
    mockDb.firsts.invoice_followup_sequences = { id: 'seq-1', invoice_id: 'inv-1', customer_id: CUST, status: 'active', step_index: 2, next_touch_at: due };
    const routed = { routedTo: 'customer_schedule', scheduleId: 'sched-2', outcome: 'held' };
    const spy = jest.spyOn(Wiring, 'sendNowForSchedule').mockResolvedValue(routed);
    await expect(Followups.sendNextTouchNow('inv-1', { operatorInitiated: true })).resolves.toEqual(routed);
    expect(spy).toHaveBeenCalledWith('sched-2', CUST);
    // only the re-arm wrote; no claim was stamped
    expect(writes().filter((w) => w.args[0]?.touch_claimed_at)).toEqual([]);
  });
});

// ── the kill switch ────────────────────────────────────────────────────────
describe('releaseIfDark (kill switch, §9.4)', () => {
  const open = (id, customer_id, over = {}) => ({ id, customer_id, status: 'active', step_index: 3, episode: 1, ...over });

  test('gate on with no allowlist: reads nothing, releases nothing', async () => {
    mockGates.live = true;
    const release = jest.spyOn(Schedule, 'release');
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 0, inFlight: 0, failed: 0 });
    expect(db).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test('shadow-only state with no schedule rows is a no-op (one read, no write, no alert, no log line)', async () => {
    mockGates.shadow = true;
    const release = jest.spyOn(Schedule, 'release');
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 0, inFlight: 0, failed: 0 });
    expect(tablesRead()).toEqual(['customer_dunning_schedules']);
    const [, read] = mockDb.chains[0];
    expect(read.calls).toContainEqual(['whereIn', 'status', OPEN_STATUSES]);
    expect(release).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(Runner.shadowVerdictBeforeRelease).not.toHaveBeenCalled(); // no rows: the shadow output is unchanged
  });

  test('C1: under the shadow gate (live off) each dark schedule gets its shadow verdict BEFORE it is released', async () => {
    mockGates.shadow = true;
    mockDb.results.customer_dunning_schedules = [open('s1', CUST), open('s2', CUST2, { status: 'paused' })];
    const order = [];
    Runner.shadowVerdictBeforeRelease.mockImplementation(async (schedule) => { order.push(`verdict:${schedule.id}`); return 'send'; });
    jest.spyOn(Schedule, 'release').mockImplementation(async (schedule) => { order.push(`release:${schedule.id}`); return { closed: true, landed: [] }; });
    await expect(Wiring.releaseIfDark(NOW)).resolves.toMatchObject({ released: 2 });
    expect(order).toEqual(['verdict:s1', 'release:s1', 'verdict:s2', 'release:s2']);
    expect(Runner.shadowVerdictBeforeRelease.mock.calls.map(([s, now]) => [s.id, now])).toEqual([['s1', NOW], ['s2', NOW]]);
    // shadow off, or the live gate on (its allowlist releasing the others): no shadow verdict is logged
    Runner.shadowVerdictBeforeRelease.mockClear();
    mockGates.shadow = false;
    await Wiring.releaseIfDark(NOW);
    mockGates.shadow = true;
    mockGates.live = true;
    mockGates.allow = new Set([CUST]);
    await Wiring.releaseIfDark(NOW);
    expect(Runner.shadowVerdictBeforeRelease).not.toHaveBeenCalled();
  });

  test('gate off: every open schedule is released as released_gate_off; a prerequisite off names released_prereq_off', async () => {
    mockDb.results.customer_dunning_schedules = [open('s1', CUST), open('s2', CUST2, { status: 'paused' })];
    const release = jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: true, landed: [] });
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 2, inFlight: 0, failed: 0 });
    expect(release.mock.calls.map((c) => [c[0].id, c[1], c[2]])).toEqual([['s1', 'released_gate_off', NOW], ['s2', 'released_gate_off', NOW]]);
    release.mockClear();
    mockGates.prereqs = false;
    mockGates.live = true; // the gate itself says on, but the ladder / pay-page balance gate is off
    await Wiring.releaseIfDark(NOW);
    expect(release.mock.calls.map((c) => c[1])).toEqual(['released_prereq_off', 'released_prereq_off']);
  });

  test('live with an allowlist: only schedules of customers outside it are released (released_gate_off)', async () => {
    mockGates.live = true;
    mockGates.allow = new Set([CUST]);
    mockDb.results.customer_dunning_schedules = [open('s1', CUST), open('s2', CUST2)];
    const release = jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: true, landed: [] });
    await expect(Wiring.releaseIfDark(NOW)).resolves.toMatchObject({ released: 1 });
    expect(release.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([['s2', 'released_gate_off']]);
    // a configured allowlist with no valid id reaches nobody: everyone is released
    mockGates.allow = new Set();
    release.mockClear();
    await Wiring.releaseIfDark(NOW);
    expect(release.mock.calls.map((c) => c[0].id)).toEqual(['s1', 's2']);
  });

  test('a send in flight is left for the next run (no alert); one failure is alerted and never stops the rest', async () => {
    mockDb.results.customer_dunning_schedules = [open('s1', CUST), open('s2', CUST2), open('s3', CUST)];
    mockDb.firsts.customers = { first_name: 'Robin', last_name: 'Testcase' };
    jest.spyOn(Schedule, 'release')
      .mockResolvedValueOnce({ closed: false, landed: [], reason: 'in_flight' })
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ closed: true, landed: [] });
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 1, inFlight: 1, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not release schedule s2 (released_gate_off): connection reset'));
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockNotify.mock.calls[0];
    expect(category).toBe('alert');
    expect(headline).toMatch(/^Billing — restart overdue reminders for Robin Testcase$/);
    expect(why).toMatch(/could not hand their invoices back/);
    expect(opts).toMatchObject({
      dedupeKey: 'customer-dunning-release-failed:s2',
      metadata: expect.objectContaining({ area: 'Billing', severity: 'needs-you', who: 'person', subject: { type: 'customer', id: CUST2 } }),
    });
  });

  test('F5: the open-schedule read failing with the gate dark and no schedule seen is LOGGED only (zero alerts while off)', async () => {
    mockGates.shadow = true;
    mockDb.throwOn.customer_dunning_schedules = new Error('relation is busy');
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 0, inFlight: 0, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not read open schedules: relation is busy'));
    expect(mockNotify).not.toHaveBeenCalled();
    // an earlier read that found NO schedule changes nothing
    mockDb.throwOn = {};
    await Wiring.releaseIfDark(NOW);
    mockDb.throwOn.customer_dunning_schedules = new Error('relation is busy');
    await Wiring.releaseIfDark(NOW);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('F5: the read failing is alerted once a day when the engine is reachable: the live gate on (with an allowlist), or schedules seen before', async () => {
    mockGates.live = true;
    mockGates.allow = new Set([CUST]);
    mockDb.throwOn.customer_dunning_schedules = new Error('relation is busy');
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 0, inFlight: 0, failed: 1 });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][3]).toMatchObject({
      dedupeKey: 'customer-dunning-release-failed:read:2026-10-07',
      metadata: expect.objectContaining({ severity: 'needs-you', who: 'person', subject: { type: 'check', id: 'customer-dunning-kill-switch' } }),
    });
    // gate dark (a rollback), but the last read in this process found open schedules: alerted too
    mockNotify.mockClear();
    Object.assign(mockGates, { live: false, allow: null });
    mockDb.throwOn = {};
    mockDb.results.customer_dunning_schedules = [open('s1', CUST)];
    jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: false, landed: [], reason: 'in_flight' });
    await Wiring.releaseIfDark(NOW);
    mockDb.throwOn.customer_dunning_schedules = new Error('relation is busy');
    await Wiring.releaseIfDark(NOW);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  test('F1: a release refused because the current step\'s delivery could not be read is a failure the office hears of', async () => {
    mockDb.results.customer_dunning_schedules = [open('s1', CUST)];
    mockDb.firsts.customers = { first_name: 'Robin', last_name: 'Testcase' };
    jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: false, landed: [], reason: 'evidence_unreadable' });
    await expect(Wiring.releaseIfDark(NOW)).resolves.toEqual({ released: 0, inFlight: 0, failed: 1 });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][3]).toMatchObject({ dedupeKey: 'customer-dunning-release-failed:s1' });
  });
});

// ── send-now gate + the HTTP results the routes return ─────────────────────
describe('send-now and staff controls', () => {
  const openRow = { id: 'sched-1', customer_id: CUST, status: 'active', step_index: 3, episode: 1 };

  test('send-now never sends for a dark schedule; live (and allowlisted) it is the CURRENT step via admin.sendNow', async () => {
    const sendNow = jest.spyOn(Admin, 'sendNow').mockResolvedValue({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' });
    const dark = await Wiring.sendNowForSchedule('sched-1', CUST, { now: NOW });
    expect(dark).toMatchObject({ routedTo: 'customer_schedule', scheduleId: 'sched-1', ok: false, reason: 'schedule_not_live' });
    expect(sendNow).not.toHaveBeenCalled();
    mockGates.live = true;
    mockGates.allow = new Set([CUST2]);
    expect(await Wiring.sendNowForSchedule('sched-1', CUST, { now: NOW })).toMatchObject({ reason: 'schedule_not_live' });
    mockGates.allow = null;
    expect(await Wiring.sendNowForSchedule('sched-1', CUST, { now: NOW })).toMatchObject({ outcome: 'advanced' });
    expect(sendNow).toHaveBeenCalledWith('sched-1', { now: NOW });
  });

  test('404: a non-uuid id (no query) and a customer with no open schedule', async () => {
    const openFor = jest.spyOn(Schedule, 'openScheduleFor').mockResolvedValue(undefined);
    expect(await Wiring.controlCustomerSchedule('not-a-uuid', 'pause')).toMatchObject({ status: 404, body: { code: 'NO_OPEN_SCHEDULE' } });
    expect(openFor).not.toHaveBeenCalled();
    expect(await Wiring.controlCustomerSchedule(CUST, 'pause')).toMatchObject({ status: 404, body: { code: 'NO_OPEN_SCHEDULE' } });
    expect(openFor).toHaveBeenCalledWith(CUST);
  });

  test('IN_FLIGHT end to end: the exact office copy comes from admin.js through the 409 body (pause, release, send-now)', async () => {
    jest.spyOn(Schedule, 'openScheduleFor').mockResolvedValue(openRow);
    const fresh = new Date(NOW.getTime() - 60 * 1000);
    // pause: the guarded UPDATE matched nothing, the row carries a fresh claim
    mockDb.results.customer_dunning_schedules = 0;
    mockDb.firsts.customer_dunning_schedules = { ...openRow, touch_claimed_at: fresh };
    const paused = await Wiring.controlCustomerSchedule(CUST, 'pause', { now: NOW });
    expect(paused).toEqual({ status: 409, body: { error: IN_FLIGHT_COPY, code: 'IN_FLIGHT', scheduleId: 'sched-1' } });
    // release: the shared close refused on a foreign fresh claim
    jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: false, landed: [], reason: 'in_flight' });
    const released = await Wiring.controlCustomerSchedule(CUST, 'release', { now: NOW });
    expect(released).toEqual({ status: 409, body: { error: IN_FLIGHT_COPY, code: 'IN_FLIGHT', scheduleId: 'sched-1' } });
    // send-now (live): the claim refused and the schedule's claim is fresh
    mockGates.live = true;
    Runner.processSchedule.mockResolvedValue({ outcome: 'skipped', reason: 'not_claimable' });
    const sent = await Wiring.controlCustomerSchedule(CUST, 'send-now', { now: NOW });
    expect(sent).toEqual({ status: 409, body: { error: IN_FLIGHT_COPY, code: 'IN_FLIGHT', scheduleId: 'sched-1' } });
  });

  test('send-now on a dark schedule is a 409 that says so; a claim lost or refused is a 409 "changed"', async () => {
    jest.spyOn(Schedule, 'openScheduleFor').mockResolvedValue(openRow);
    expect(await Wiring.controlCustomerSchedule(CUST, 'send-now', { now: NOW })).toMatchObject({
      status: 409, body: { code: 'SCHEDULE_NOT_LIVE', error: expect.stringMatching(/Combined reminders are off for this customer/) },
    });
    mockGates.live = true;
    jest.spyOn(Admin, 'sendNow').mockResolvedValue({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'stale' });
    expect(await Wiring.controlCustomerSchedule(CUST, 'send-now', { now: NOW })).toMatchObject({ status: 409, body: { code: 'SCHEDULE_CHANGED' } });
  });

  test('200 with what happened: pause / resume / release / a send that went out', async () => {
    jest.spyOn(Schedule, 'openScheduleFor').mockResolvedValue(openRow);
    mockDb.results.customer_dunning_schedules = 1;
    expect(await Wiring.controlCustomerSchedule(CUST, 'pause', { adminId: 'admin-7', reason: 'customer called', now: NOW }))
      .toEqual({ status: 200, body: { scheduleId: 'sched-1', ok: true } });
    const pausePatch = writes().find((w) => w.table === 'customer_dunning_schedules').args[0];
    expect(pausePatch).toMatchObject({ status: 'paused', paused_reason: 'customer called', paused_by_admin_id: 'admin-7' });
    expect(await Wiring.controlCustomerSchedule(CUST, 'resume', { now: NOW })).toMatchObject({ status: 200, body: { ok: true } });
    mockDb.results.customer_dunning_schedules = 0;
    expect(await Wiring.controlCustomerSchedule(CUST, 'resume', { now: NOW })).toMatchObject({ status: 409, body: { code: 'SCHEDULE_CHANGED' } });
    mockDb.firsts.customer_dunning_schedules = openRow;
    jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: true, landed: [{}, {}] });
    expect(await Wiring.controlCustomerSchedule(CUST, 'release', { now: NOW })).toEqual({ status: 200, body: { scheduleId: 'sched-1', ok: true, released: 2 } });
    expect(Schedule.release.mock.calls[0][1]).toBe('released_admin');
    mockGates.live = true;
    for (const sent of ['advanced', 'completed', 'told']) {
      jest.spyOn(Admin, 'sendNow').mockResolvedValue({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: sent });
      expect(await Wiring.controlCustomerSchedule(CUST, 'send-now', { now: NOW })).toMatchObject({ status: 200, body: { outcome: sent } });
    }
  });

  test('F4: a send-now that sent nothing is a 409 NOT_SENT with a plain-English reason, never a 200', () => {
    const notSent = (out) => Wiring.httpResult({ routedTo: 'customer_schedule', scheduleId: 'sched-1', ...out });
    const cases = [
      [{ outcome: 'held', reason: 'collection_hold' }, 'Not sent: reminders are on hold (a collections hold is active).'],
      [{ outcome: 'held', reason: 'COLLECTIONS_POLICY' }, 'Not sent: reminders are on hold (the collections contact rules do not allow a reminder now).'],
      [{ outcome: 'held', reason: 'SOME_PROVIDER_CODE' }, 'Not sent: reminders are on hold (a delivery problem).'],
      [{ outcome: 'paused', reason: 'no_reachable_channel' }, 'Not sent: reminders were paused (there is no way to reach them).'],
      [{ outcome: 'autopay_hold' }, 'Not sent: the customer is on autopay, so reminders are on hold.'],
      [{ outcome: 'closed', reason: 'balance_cleared' }, 'Not sent: the reminder schedule closed (their balance is paid).'],
      [{ outcome: 'skipped', reason: 'schedule_paused' }, 'Not sent: this customer\'s combined reminders are paused.'],
    ];
    for (const [out, copy] of cases) {
      const res = notSent(out);
      expect(res).toEqual({ status: 409, body: { error: copy, code: 'NOT_SENT', outcome: out.outcome, scheduleId: 'sched-1' } });
      expect(copy).not.toMatch(/[a-z]+_[a-z_]+|[A-Z]{3,}_/); // no reason code reaches the office
    }
    // a claim that truly lost the race is still "changed"; an unreadable release says so
    expect(notSent({ outcome: 'stale' })).toMatchObject({ status: 409, body: { code: 'SCHEDULE_CHANGED' } });
    expect(notSent({ outcome: 'skipped', reason: 'not_claimable' })).toMatchObject({ status: 409, body: { code: 'SCHEDULE_CHANGED' } });
    expect(notSent({ ok: false, reason: 'evidence_unreadable', message: 'm' })).toEqual({ status: 409, body: { error: 'm', code: 'EVIDENCE_UNREADABLE', scheduleId: 'sched-1' } });
  });

  test('F4: send-now on an office-PAUSED schedule says it is paused (not "changed"); the claim refusal is read back once', async () => {
    jest.spyOn(Schedule, 'openScheduleFor').mockResolvedValue({ ...openRow, status: 'paused' });
    mockGates.live = true;
    Runner.processSchedule.mockResolvedValue({ outcome: 'skipped', reason: 'not_claimable' });
    mockDb.firsts.customer_dunning_schedules = { ...openRow, status: 'paused', touch_claimed_at: null };
    mockDb.results['invoice_followup_sequences as s'] = [];
    expect(await Wiring.controlCustomerSchedule(CUST, 'send-now', { now: NOW })).toEqual({
      status: 409,
      body: { error: 'Not sent: this customer\'s combined reminders are paused.', code: 'NOT_SENT', outcome: 'skipped', scheduleId: 'sched-1' },
    });
    // an unclaimable ACTIVE schedule (it closed / changed under the click) is still "changed"
    mockDb.firsts.customer_dunning_schedules = { ...openRow, touch_claimed_at: null };
    expect(await Wiring.controlCustomerSchedule(CUST, 'send-now', { now: NOW })).toMatchObject({ status: 409, body: { code: 'SCHEDULE_CHANGED' } });
  });

  test('F1: an admin release whose delivery evidence cannot be read is a 409 that says so (nothing handed back)', async () => {
    jest.spyOn(Schedule, 'openScheduleFor').mockResolvedValue(openRow);
    mockDb.firsts.customer_dunning_schedules = openRow;
    jest.spyOn(Schedule, 'release').mockResolvedValue({ closed: false, landed: [], reason: 'evidence_unreadable' });
    expect(await Wiring.controlCustomerSchedule(CUST, 'release', { now: NOW })).toEqual({
      status: 409,
      body: { error: 'Could not check whether the current reminder already went out. Try again in a minute.', code: 'EVIDENCE_UNREADABLE', scheduleId: 'sched-1' },
    });
  });
});

// ── cross-rail (§8) ────────────────────────────────────────────────────────
describe('cross-rail', () => {
  const Previsit = require('../services/previsit-balance-reminder');
  const fresh = Previsit._test.freshOverdueRecurringInvoices;
  const overdueInvoice = { id: 'inv-1', status: 'overdue', total: '120.00', amount_paid: 0, credit_applied: 0, followup_last_touch_at: null, last_reminder_at: null };

  test('previsit: a customer schedule touched within RECENT_TOUCH_HOURS (72h) suppresses every invoice', async () => {
    mockDb.results.invoices = [overdueInvoice];
    mockDb.results.activity_log = [];
    mockDb.firsts.customer_dunning_schedules = { id: 'sched-1' };
    await expect(fresh(CUST, NOW, db)).resolves.toEqual([]);
    const [, read] = mockDb.chains.find(([t]) => t === 'customer_dunning_schedules');
    expect(read.calls).toContainEqual(['where', { customer_id: CUST }]);
    const cutoff = read.calls.find(([m, col]) => m === 'where' && col === 'last_touch_at')[3];
    expect(NOW.getTime() - cutoff.getTime()).toBe(72 * 3600 * 1000);
    // only a touch the schedule itself made counts (promotion's seeded copy predates the row; PG suite proves it)
    expect(read.calls).toContainEqual(['whereRaw', 'last_touch_at > created_at']);
  });

  test('previsit: no recent schedule touch (or no schedule) leaves the list as it was; nothing fresh reads no schedule', async () => {
    mockDb.results.invoices = [overdueInvoice];
    mockDb.firsts.customer_dunning_schedules = undefined;
    await expect(fresh(CUST, NOW, db)).resolves.toEqual([overdueInvoice]);
    mockDb.log = [];
    mockDb.results.invoices = [];
    await expect(fresh(CUST, NOW, db)).resolves.toEqual([]);
    expect(tablesRead()).not.toContain('customer_dunning_schedules');
  });

  test('autopay failure: member rows are counted / released as before; the schedule is never written (the engine revisits it daily)', async () => {
    mockDb.results.invoice_followup_sequences = [
      { id: 'seq-1', invoice_id: 'inv-1', autopay_failures_observed: 0 },
      { id: 'seq-2', invoice_id: 'inv-2', autopay_failures_observed: 2 },
    ];
    await Followups.handleAutopayFailure(CUST);
    expect(tablesRead()).not.toContain('customer_dunning_schedules');
    expect(writes().every((w) => w.table === 'invoice_followup_sequences')).toBe(true);
    expect(writes().some((w) => w.args[0]?.autopay_failures_observed === 1)).toBe(true);
  });
});
