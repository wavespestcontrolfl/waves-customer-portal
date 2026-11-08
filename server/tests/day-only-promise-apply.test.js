// GATE_DAY_ONLY_PROMISE part A, auto-dispatch apply side: loadReminderFreeze opts.anyPromise (honored only with
// toldLock + lock24h), the apply-time grouped-sibling guards, the moving visit's own transaction check, and the
// promise that route-reorder, the rebooker and the rain pass never pass anyPromise. Synthetic ids only.
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn(),
}));
jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn(), loadPromiseLevels: jest.fn() }));

const fs = require('fs');
const path = require('path');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const toldVisits = require('../services/auto-dispatch/told-visits');
const { checkFlexSiblingBounds, checkTiersSiblingBounds, assertNotToldOnMove } = require('../services/auto-dispatch/apply');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');
const gates = require('../config/feature-gates');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${TODAY}T12:00`), n));
const refuse = (id, why) => Object.assign(new Error(`refused ${id}: ${why}`), { code: 'TEST_REFUSE', id, why });
const sib = { id: 's2', scheduled_date: dayOffset(2), window_start: '09:00:00', is_recurring: true, recurring_parent_id: 'p1' };
const FROZEN = { failed: false, frozen: new Set(['s2']) };
const realFreeze = jest.requireActual('../services/auto-dispatch/route-tiers').loadReminderFreeze;

afterEach(() => { delete process.env.GATE_DAY_ONLY_PROMISE; });
beforeEach(() => { jest.clearAllMocks(); });

describe('config', () => {
  test('dayOnlyPromise is read once per run: off by default, on with the env, overridable, fixed once built', () => {
    expect(getAutoDispatchConfig().dayOnlyPromise).toBe(false);
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    const config = getAutoDispatchConfig();
    expect(config.dayOnlyPromise).toBe(true);
    expect(getAutoDispatchConfig({ dayOnlyPromise: false }).dayOnlyPromise).toBe(false);
    delete process.env.GATE_DAY_ONLY_PROMISE;
    expect(config.dayOnlyPromise).toBe(true); // no mid-run mixing
  });

  test('the gate reader is strict and exported', () => {
    for (const v of ['', 'false', '1', 'TRUE']) {
      process.env.GATE_DAY_ONLY_PROMISE = v;
      expect(gates.dayOnlyPromiseLive()).toBe(false);
    }
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    expect(gates.dayOnlyPromiseLive()).toBe(true);
  });
});

describe('checkTiersSiblingBounds / checkFlexSiblingBounds', () => {
  test('tiers: day-only on passes anyPromise; off passes PR 1\'s options', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true, true, true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('already told its time') });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true, toldLock: true, anyPromise: true });
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true, true, false)).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true, toldLock: true });
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true, true)).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true, toldLock: true });
  });

  test('tiers: day-only without the told-lock passes no anyPromise', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkTiersSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, true, false, true)).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), undefined, { lock24h: true });
  });

  test('flex: 25 h band with anyPromise when day-only is on', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValue(FROZEN);
    const trx = jest.fn();
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [], true, true, true)).rejects.toMatchObject({ id: 's2' });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 25, { lock24h: true, toldLock: true, anyPromise: true });
    await expect(checkFlexSiblingBounds(trx, [sib], [sib], { date: dayOffset(6) }, TODAY, refuse, [], true, true, false)).rejects.toBeTruthy();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 25, { lock24h: true, toldLock: true });
  });
});

describe('assertNotToldOnMove (the moving visit, on its own transaction)', () => {
  const all = { nightLock24h: true, nightToldLock: true, dayOnlyPromise: true };
  const pr1 = { nightLock24h: true, nightToldLock: true };
  const row = { id: 'v1' };

  test('day-only on: reads with anyPromise, and a day-only or unknown promise refuses the move', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set(['v1']));
    const trx = jest.fn();
    await expect(assertNotToldOnMove(trx, row, all, refuse)).rejects.toMatchObject({ id: 'v1', why: 'has a time the customer was already told (frozen)' });
    expect(toldVisits.loadToldVisitIds).toHaveBeenCalledWith(trx, ['v1'], expect.any(Date), { anyPromise: true });
  });

  test('day-only on: no promise at all lets the move go on; a failed read throws (fail closed)', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set());
    await expect(assertNotToldOnMove(jest.fn(), row, all, refuse)).resolves.toBeUndefined();
    toldVisits.loadToldVisitIds.mockRejectedValue(new Error('read failed'));
    await expect(assertNotToldOnMove(jest.fn(), row, all, refuse)).rejects.toThrow('read failed');
  });

  test('day-only off: PR 1\'s exact call (no options object)', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set());
    const trx = jest.fn();
    await assertNotToldOnMove(trx, row, pr1, refuse);
    expect(toldVisits.loadToldVisitIds).toHaveBeenCalledWith(trx, ['v1'], expect.any(Date));
    expect(toldVisits.loadToldVisitIds.mock.calls[0]).toHaveLength(3);
  });

  test('day-only on without the told-lock or the 24-hour lock: nothing is read', async () => {
    await assertNotToldOnMove(jest.fn(), row, { nightLock24h: true, nightToldLock: false, dayOnlyPromise: true }, refuse);
    await assertNotToldOnMove(jest.fn(), row, { nightLock24h: false, nightToldLock: true, dayOnlyPromise: true }, refuse);
    expect(toldVisits.loadToldVisitIds).not.toHaveBeenCalled();
  });
});

describe('loadReminderFreeze opts.anyPromise', () => {
  const NOW = new Date('2026-11-10T09:00:00Z');
  const rowFor = () => ({ scheduled_service_id: 's1', customer_id: 'c1', appointment_time: new Date(NOW.getTime() + 30 * 3600000).toISOString(),
    reminder_24h_sent: false, suppressed_by_sibling: false });
  const dbWith = (rows) => () => { const c = {}; c.whereIn = () => c; c.where = () => c; c.select = async () => rows; return c; };

  test('toldLock + anyPromise: loadToldVisitIds gets { anyPromise: true }', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set(['s1']));
    const db = dbWith([rowFor()]);
    const res = await realFreeze(db, ['s1'], NOW, undefined, { lock24h: true, toldLock: true, anyPromise: true });
    expect(res.frozen.has('s1')).toBe(true);
    expect(toldVisits.loadToldVisitIds).toHaveBeenCalledWith(db, ['s1'], NOW, { anyPromise: true });
  });

  test('toldLock without anyPromise: PR 1\'s exact call', async () => {
    toldVisits.loadToldVisitIds.mockResolvedValue(new Set());
    const db = dbWith([rowFor()]);
    await realFreeze(db, ['s1'], NOW, undefined, { lock24h: true, toldLock: true });
    expect(toldVisits.loadToldVisitIds.mock.calls[0]).toEqual([db, ['s1'], NOW]);
  });

  test('anyPromise is honored only when toldLock is: alone, or without lock24h, nothing is read', async () => {
    await realFreeze(dbWith([rowFor()]), ['s1'], NOW, undefined, { lock24h: true, anyPromise: true });
    await realFreeze(dbWith([rowFor()]), ['s1'], NOW, undefined, { anyPromise: true, toldLock: true });
    await realFreeze(dbWith([rowFor()]), ['s1'], NOW, undefined, { anyPromise: true });
    expect(toldVisits.loadToldVisitIds).not.toHaveBeenCalled();
  });

  test('a failed promise read with anyPromise fails closed', async () => {
    toldVisits.loadToldVisitIds.mockRejectedValue(new Error('promise read down'));
    const res = await realFreeze(dbWith([rowFor()]), ['s1'], NOW, undefined, { lock24h: true, toldLock: true, anyPromise: true });
    expect(res).toEqual({ failed: true, frozen: new Set() });
  });
});

describe('who does NOT pass anyPromise', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('route-reorder, rebooker, the rain pass and the day re-plan loader never mention it', () => {
    for (const rel of ['../services/route-reorder.js', '../services/rebooker.js', '../services/auto-dispatch/rain-pass.js']) {
      expect(read(rel)).not.toMatch(/anyPromise|dayOnlyPromise|DAY_ONLY_PROMISE/);
    }
    expect(read('../services/day-replan/index.js')).not.toMatch(/anyPromise/);
  });

  test('the only places that set the option are the auto-dispatch run and its apply guards', () => {
    for (const rel of ['../services/auto-dispatch/index.js', '../services/auto-dispatch/apply.js']) expect(read(rel)).toMatch(/anyPromise: true/);
  });
});
