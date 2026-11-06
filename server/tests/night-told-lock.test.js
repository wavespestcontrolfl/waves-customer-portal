// GATE_NIGHT_TOLD_LOCK (owner 2026-11-05, "D1 a"): a night tool never changes a
// time the customer was already told. This suite covers the gate reader, the
// once-per-run config read, route-tiers' loadReminderFreeze with
// { lock24h: true, toldLock: true } (a really sent 72-hour reminder freezes a
// visit; a windows_preclosed or cancelled row does not), and the promise that
// the 4:20 route re-order, the rebooker and the rain pass never pass the
// option. Orchestrator, apply-time guards and day re-plan have their own
// night-told-lock-*.test.js suites. Synthetic ids only.
const fs = require('fs');
const path = require('path');
const gates = require('../config/feature-gates');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');
const routeTiers = require('../services/auto-dispatch/route-tiers');

const { loadReminderFreeze } = routeTiers;
const HOUR = 3600000;
const NOW = new Date('2026-11-10T09:00:00Z');
const at = (hours) => new Date(NOW.getTime() + hours * HOUR).toISOString();

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

  test('a sent 72-hour reminder freezes a visit 30 h out (outside the 24.25 h band)', async () => {
    expect(await frozenFor({ reminder_72h_sent: true })).toBe(true);
  });

  test('a sent 24-hour reminder still freezes; an unsent visit 30 h out is not frozen', async () => {
    expect(await frozenFor({ reminder_24h_sent: true })).toBe(true);
    expect(await frozenFor({})).toBe(false);
  });

  test('a windows_preclosed or cancelled row is not a sent 72-hour reminder', async () => {
    expect(await frozenFor({ reminder_72h_sent: true, windows_preclosed: true })).toBe(false);
    expect(await frozenFor({ reminder_72h_sent: true, cancelled: true })).toBe(false);
  });

  test('inside the band still means frozen, flag or not', async () => {
    expect(await frozenFor({ appointment_time: at(23) })).toBe(true);
    expect(await frozenFor({ appointment_time: at(24.25) })).toBe(true);
    expect(await frozenFor({ appointment_time: at(24.3) })).toBe(false);
  });

  test('the flex band (25 h) works with it too', async () => {
    expect(await frozenFor({ appointment_time: at(24.5) }, told, 25)).toBe(true);
    expect(await frozenFor({ appointment_time: at(30), reminder_72h_sent: true }, told, 25)).toBe(true);
  });

  test('selects the columns it needs, and only then', async () => {
    const withTold = reminderDb({ rows: [row()] });
    await loadReminderFreeze(withTold, ['s1'], NOW, undefined, told);
    expect(withTold.log.selects[0]).toEqual(expect.arrayContaining(['reminder_24h_sent', 'reminder_72h_sent', 'windows_preclosed', 'cancelled']));
    const without = reminderDb({ rows: [row()] });
    await loadReminderFreeze(without, ['s1'], NOW, undefined, { lock24h: true });
    expect(without.log.selects[0]).toEqual(['scheduled_service_id', 'customer_id', 'appointment_time', 'reminder_24h_sent', 'suppressed_by_sibling']);
  });

  test('toldLock without lock24h does nothing (the 72-hour rule already reads that flag)', async () => {
    const db = reminderDb({ rows: [row({ reminder_72h_sent: true, windows_preclosed: true })] });
    const res = await loadReminderFreeze(db, ['s1'], NOW, undefined, { toldLock: true });
    expect(res.frozen.has('s1')).toBe(true); // today's 72-hour rule: the flag alone, as before
    expect(db.log.selects[0]).toEqual(['scheduled_service_id', 'customer_id', 'appointment_time', 'reminder_72h_sent', 'suppressed_by_sibling']);
  });

  test('sibling placeholder defers to the slot owner: owner sent 72 h freezes it, an unsent or pre-closed owner does not', async () => {
    const placeholder = row({ scheduled_service_id: 's2', suppressed_by_sibling: true });
    const ownerAt = { customer_id: 'c1', appointment_time: placeholder.appointment_time };
    const freezes = async (owner) => (await loadReminderFreeze(reminderDb({ rows: [placeholder], owners: [{ ...ownerAt, reminder_24h_sent: false, reminder_72h_sent: false, windows_preclosed: false, cancelled: false, ...owner }] }), ['s2'], NOW, undefined, told)).frozen.has('s2');
    expect(await freezes({ reminder_72h_sent: true })).toBe(true);
    expect(await freezes({ reminder_24h_sent: true })).toBe(true);
    expect(await freezes({})).toBe(false);
    expect(await freezes({ reminder_72h_sent: true, windows_preclosed: true })).toBe(false);
    expect(await freezes({ reminder_72h_sent: true, cancelled: true })).toBe(false);
    // The placeholder's own flags never mean a send.
    const own = row({ scheduled_service_id: 's2', suppressed_by_sibling: true, reminder_72h_sent: true });
    expect((await loadReminderFreeze(reminderDb({ rows: [own], owners: [] }), ['s2'], NOW, undefined, told)).frozen.has('s2')).toBe(false);
  });

  test('a failed read fails closed', async () => {
    const broken = () => { throw new Error('db down'); };
    expect((await loadReminderFreeze(broken, ['s1'], NOW, undefined, told)).failed).toBe(true);
  });
});

describe('without toldLock nothing changes', () => {
  test('lock24h alone: a sent 72-hour reminder outside the band does not freeze (today)', async () => {
    const db = reminderDb({ rows: [row({ reminder_72h_sent: true })] });
    expect((await loadReminderFreeze(db, ['s1'], NOW, undefined, { lock24h: true })).frozen.has('s1')).toBe(false);
  });

  test('no opts: the 72-hour rule, pre-closed placeholder rows included, as today', async () => {
    const frozenFor = async (over) => (await loadReminderFreeze(reminderDb({ rows: [row(over)] }), ['s1'], NOW)).frozen.has('s1');
    expect(await frozenFor({ reminder_72h_sent: true })).toBe(true);
    expect(await frozenFor({ reminder_72h_sent: true, windows_preclosed: true })).toBe(true);
    expect(await frozenFor({ appointment_time: at(80) })).toBe(false);
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
