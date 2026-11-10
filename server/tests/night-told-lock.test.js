// GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"): a night tool never changes a
// time the customer was already told. This suite covers the gate reader, the
// once-per-run config read, route-tiers' loadReminderFreeze with
// { lock24h: true, toldLock: true } (a visit with a known-slot promise freezes,
// by the promise reader in auto-dispatch/told-visits.js, mocked here; a
// reminder_72h_sent flag alone does not), and the promise that
// the 4:20 route re-order, the rebooker and the rain pass never pass the
// option. Orchestrator, apply-time guards and day re-plan have their own
// night-told-lock-*.test.js suites. Synthetic ids only.
jest.mock('../services/auto-dispatch/told-visits', () => ({ loadToldVisitIds: jest.fn(async () => new Set()) }));

const fs = require('fs');
const path = require('path');
const gates = require('../config/feature-gates');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const { loadToldVisitIds } = require('../services/auto-dispatch/told-visits');

const { loadReminderFreeze } = routeTiers;
const HOUR = 3600000;
const NOW = new Date('2026-11-10T09:00:00Z');
const at = (hours) => new Date(NOW.getTime() + hours * HOUR).toISOString();

beforeEach(() => { loadToldVisitIds.mockReset(); loadToldVisitIds.mockResolvedValue(new Set()); });
afterEach(() => {
  delete process.env.GATE_NIGHT_TOLD_LOCK;
  delete process.env.GATE_NIGHT_LOCK_24H;
});

describe('the gate reader', () => {
  test('dark by default; only exactly "true" turns it on, read at call time', () => {
    expect(gates.nightToldLockLive()).toBe(false);
    for (const v of ['', 'false', '1', 'on', 'TRUE', 'yes']) {
      process.env.GATE_NIGHT_TOLD_LOCK = v;
      expect(gates.nightToldLockLive()).toBe(false);
    }
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    expect(gates.nightToldLockLive()).toBe(true);
    delete process.env.GATE_NIGHT_TOLD_LOCK;
    expect(gates.nightToldLockLive()).toBe(false);
  });

  test('the reader is exported on its own line, and the boot log has an entry', () => {
    const src = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(src).toMatch(/^module\.exports\.nightToldLockLive = nightToldLockLive;$/m);
    expect(gates.gates.nightToldLock).toBe(false);
  });
});

describe('config: the gate is read once per run into config.nightToldLock', () => {
  test('off by default, on with the env, overridable, and fixed once built', () => {
    expect(getAutoDispatchConfig().nightToldLock).toBe(false);
    process.env.GATE_NIGHT_TOLD_LOCK = 'true';
    const config = getAutoDispatchConfig();
    expect(config.nightToldLock).toBe(true);
    expect(getAutoDispatchConfig({ nightToldLock: false }).nightToldLock).toBe(false);
    delete process.env.GATE_NIGHT_TOLD_LOCK;
    expect(config.nightToldLock).toBe(true); // no mid-run mixing
    expect(getAutoDispatchConfig({ nightToldLock: true }).nightToldLock).toBe(true);
  });
});

// A db stub that records the selected columns and answers the owner query.
function reminderDb({ rows = [], owners = [] } = {}) {
  const log = { selects: [], ownerSelects: [], ownerWhere: [] };
  let call = 0;
  const db = () => {
    call += 1;
    const isOwner = call > 1;
    const chain = {};
    chain.whereIn = () => chain;
    chain.where = (...args) => { if (isOwner) log.ownerWhere.push(args); return chain; };
    chain.select = async (...cols) => {
      (isOwner ? log.ownerSelects : log.selects).push(cols);
      return isOwner ? owners : rows;
    };
    return chain;
  };
  db.log = log;
  return db;
}

const row = (over = {}) => ({
  scheduled_service_id: 's1', customer_id: 'c1', appointment_time: at(30), reminder_72h_sent: false, reminder_24h_sent: false,
  suppressed_by_sibling: false, windows_preclosed: false, cancelled: false, ...over,
});

describe('loadReminderFreeze with { lock24h: true, toldLock: true }', () => {
  const told = { lock24h: true, toldLock: true };
  const frozenFor = async (over, opts = told, hours) => (await loadReminderFreeze(reminderDb({ rows: [row(over)] }), ['s1'], NOW, hours, opts)).frozen.has('s1');

  test('a visit with a known-slot promise (the promise reader says told) is frozen 30 h out, outside the 24.25 h band', async () => {
    loadToldVisitIds.mockResolvedValue(new Set(['s1']));
    expect(await frozenFor({})).toBe(true);
  });

  test('a reminder_72h_sent flag with no real promise does not freeze (the sender also sets it when the text was skipped)', async () => {
    expect(await frozenFor({ reminder_72h_sent: true })).toBe(false);
    expect(await frozenFor({ reminder_72h_sent: true, windows_preclosed: true })).toBe(false);
  });

  test('an unknown-window promise does not freeze (the reader leaves it out of the told set)', async () => {
    loadToldVisitIds.mockResolvedValue(new Set());
    expect(await frozenFor({})).toBe(false);
  });

  test('a sent 24-hour reminder still freezes; an unsent visit 30 h out is not frozen', async () => {
    expect(await frozenFor({ reminder_24h_sent: true })).toBe(true);
    expect(await frozenFor({})).toBe(false);
  });

  test('inside the band still means frozen, promise or not', async () => {
    expect(await frozenFor({ appointment_time: at(23) })).toBe(true);
    expect(await frozenFor({ appointment_time: at(24.25) })).toBe(true);
    expect(await frozenFor({ appointment_time: at(24.3) })).toBe(false);
  });

  test('the flex band (25 h) works with it too', async () => {
    expect(await frozenFor({ appointment_time: at(24.5) }, told, 25)).toBe(true);
    loadToldVisitIds.mockResolvedValue(new Set(['s1']));
    expect(await frozenFor({ appointment_time: at(30) }, told, 25)).toBe(true);
  });

  test('one bulk promise read for the ids, with the run clock; the reminder select is the same as with lock24h alone', async () => {
    const withTold = reminderDb({ rows: [row(), row({ scheduled_service_id: 's2' })] });
    await loadReminderFreeze(withTold, ['s1', 's2'], NOW, undefined, told);
    expect(loadToldVisitIds).toHaveBeenCalledTimes(1);
    expect(loadToldVisitIds).toHaveBeenCalledWith(withTold, ['s1', 's2'], NOW);
    const without = reminderDb({ rows: [row()] });
    await loadReminderFreeze(without, ['s1'], NOW, undefined, { lock24h: true });
    expect(withTold.log.selects[0]).toEqual(without.log.selects[0]);
    expect(without.log.selects[0]).toEqual(['scheduled_service_id', 'customer_id', 'appointment_time', 'reminder_24h_sent', 'suppressed_by_sibling']);
  });

  test('a told visit with no reminder row at all is frozen (the promise read does not need one)', async () => {
    loadToldVisitIds.mockResolvedValue(new Set(['s1']));
    const res = await loadReminderFreeze(reminderDb({ rows: [] }), ['s1'], NOW, undefined, told);
    expect(res).toEqual({ failed: false, frozen: new Set(['s1']) });
  });

  test('toldLock without lock24h does nothing: no promise read, the 72-hour rule as today', async () => {
    const db = reminderDb({ rows: [row({ reminder_72h_sent: true })] });
    const res = await loadReminderFreeze(db, ['s1'], NOW, undefined, { toldLock: true });
    expect(res.frozen.has('s1')).toBe(true);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
    expect(db.log.selects[0]).toEqual(['scheduled_service_id', 'customer_id', 'appointment_time', 'reminder_72h_sent', 'suppressed_by_sibling']);
  });

  test('sibling placeholder still defers to the slot owner\'s 24-hour reminder (today\'s rule), and its own promise freezes it', async () => {
    const placeholder = row({ scheduled_service_id: 's2', suppressed_by_sibling: true });
    const ownerAt = { customer_id: 'c1', appointment_time: placeholder.appointment_time };
    const rows = [placeholder];
    expect((await loadReminderFreeze(reminderDb({ rows, owners: [ownerAt] }), ['s2'], NOW, undefined, told)).frozen.has('s2')).toBe(true);
    expect((await loadReminderFreeze(reminderDb({ rows, owners: [] }), ['s2'], NOW, undefined, told)).frozen.has('s2')).toBe(false);
    loadToldVisitIds.mockResolvedValue(new Set(['s2']));
    expect((await loadReminderFreeze(reminderDb({ rows, owners: [] }), ['s2'], NOW, undefined, told)).frozen.has('s2')).toBe(true);
  });

  test('a failed reminder read, or a failed promise read, fails closed', async () => {
    const broken = () => { throw new Error('db down'); };
    expect((await loadReminderFreeze(broken, ['s1'], NOW, undefined, told)).failed).toBe(true);
    loadToldVisitIds.mockRejectedValue(new Error('promise read down'));
    const res = await loadReminderFreeze(reminderDb({ rows: [row()] }), ['s1'], NOW, undefined, told);
    expect(res).toEqual({ failed: true, frozen: new Set() });
  });
});

describe('without toldLock nothing changes', () => {
  test('lock24h alone: a sent 72-hour reminder outside the band does not freeze, and no promise is read (today)', async () => {
    loadToldVisitIds.mockResolvedValue(new Set(['s1']));
    const db = reminderDb({ rows: [row({ reminder_72h_sent: true })] });
    expect((await loadReminderFreeze(db, ['s1'], NOW, undefined, { lock24h: true })).frozen.has('s1')).toBe(false);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
  });

  test('no opts: the 72-hour rule, pre-closed placeholder rows included, as today', async () => {
    const frozenFor = async (over) => (await loadReminderFreeze(reminderDb({ rows: [row(over)] }), ['s1'], NOW)).frozen.has('s1');
    expect(await frozenFor({ reminder_72h_sent: true })).toBe(true);
    expect(await frozenFor({ reminder_72h_sent: true, windows_preclosed: true })).toBe(true);
    expect(await frozenFor({ appointment_time: at(80) })).toBe(false);
    expect(loadToldVisitIds).not.toHaveBeenCalled();
  });

  test('only one gate on: the reader of one never moves the other (strict, call time)', () => {
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    expect(gates.nightToldLockLive()).toBe(false);
    expect(getAutoDispatchConfig().nightToldLock).toBe(false);
    expect(getAutoDispatchConfig().nightLock24h).toBe(true);
  });
});

describe('who does NOT pass toldLock', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('route-reorder, rebooker and the rain pass never mention it', () => {
    for (const rel of ['../services/route-reorder.js', '../services/rebooker.js', '../services/auto-dispatch/rain-pass.js']) {
      expect(read(rel)).not.toMatch(/toldLock|TOLD_LOCK|nightToldLock/);
    }
  });

  test('the only places that set the option are the auto-dispatch run and its apply guards', () => {
    const files = ['../services/auto-dispatch/index.js', '../services/auto-dispatch/apply.js'];
    for (const rel of files) expect(read(rel)).toMatch(/toldLock: true/);
  });
});
