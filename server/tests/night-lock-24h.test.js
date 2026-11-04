// GATE_NIGHT_LOCK_24H (owner 2026-11-03): the night passes lock a visit at 24
// hours, not 72/73. This suite covers the pieces that decide it: the gate
// reader, the once-per-run config read, route-tiers' reminder freeze (clock
// band + sent flag), the flex-tier freeze (25 h) and its invariants, and the
// promise that rebooker's staff series moves keep the 72-hour freeze with the
// gate on. The orchestrator, apply-time guards and route-reorder have their
// own night-lock-24h-*.test.js suites. Synthetic ids only.
jest.mock('../services/appointment-reminders', () => ({
  // The real module's composer, without its dependencies.
  composeScheduledApptTime: jest.fn((svc) => {
    if (!svc) return null;
    const datePart = String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    if (!datePart || !timePart) return null;
    return require('../utils/datetime-et').parseETDateTime(`${datePart}T${timePart}`);
  }),
}));

const fs = require('fs');
const path = require('path');
const gates = require('../config/feature-gates');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');
const routeTiers = require('../services/auto-dispatch/route-tiers');
const flexTier = require('../services/auto-dispatch/flex-tier');

const { loadReminderFreeze } = routeTiers;
const HOUR = 3600000;
const NOW = new Date('2026-11-10T09:00:00Z');
const at = (hours) => new Date(NOW.getTime() + hours * HOUR).toISOString();

afterEach(() => { delete process.env.GATE_NIGHT_LOCK_24H; });

describe('the gate reader', () => {
  test('dark by default; only exactly "true" turns it on, read at call time', () => {
    expect(gates.nightLock24hLive()).toBe(false);
    for (const v of ['', 'false', '1', 'on', 'TRUE', 'yes']) {
      process.env.GATE_NIGHT_LOCK_24H = v;
      expect(gates.nightLock24hLive()).toBe(false);
    }
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    expect(gates.nightLock24hLive()).toBe(true);
    delete process.env.GATE_NIGHT_LOCK_24H;
    expect(gates.nightLock24hLive()).toBe(false);
  });

  test('is exported on its own line and listed in the gate status map', () => {
    const src = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(src).toMatch(/^module\.exports\.nightLock24hLive = nightLock24hLive;$/m);
    expect(gates.gates.nightLock24h).toBe(false);
  });
});

describe('config: the gate is read once per run into config.nightLock24h', () => {
  test('off by default, on with the gate, and an override wins', () => {
    expect(getAutoDispatchConfig().nightLock24h).toBe(false);
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    expect(getAutoDispatchConfig().nightLock24h).toBe(true);
    expect(getAutoDispatchConfig({ nightLock24h: false }).nightLock24h).toBe(false);
    delete process.env.GATE_NIGHT_LOCK_24H;
    expect(getAutoDispatchConfig({ nightLock24h: true }).nightLock24h).toBe(true);
  });

  test('a flip after the config is built does not change that config (no mid-run mixing)', () => {
    const config = getAutoDispatchConfig();
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    expect(config.nightLock24h).toBe(false);
  });
});

describe('constants and helpers', () => {
  test('the 09-25 rule is untouched; the 11-03 rule is 24 h clock, 24.25 h band, 25 h flex', () => {
    expect(routeTiers.FREEZE_HOURS).toBe(72);
    expect(routeTiers.REMINDER_SENDABLE_HOURS).toBe(72.25);
    expect(flexTier.FLEX_TIER_FREEZE_HOURS).toBe(73);
    expect(routeTiers.FREEZE_HOURS_24H).toBe(24);
    expect(routeTiers.REMINDER_SENDABLE_HOURS_24H).toBe(24.25);
    expect(flexTier.FLEX_TIER_FREEZE_HOURS_24H).toBe(25);
    expect(routeTiers.freezeHoursFor(false)).toBe(72);
    expect(routeTiers.freezeHoursFor()).toBe(72);
    expect(routeTiers.freezeHoursFor(true)).toBe(24);
    expect(routeTiers.sendableHoursFor(true)).toBe(24.25);
    expect(routeTiers.sendableHoursFor(false)).toBe(72.25);
    expect(flexTier.flexFreezeHoursFor(true)).toBe(25);
    expect(flexTier.flexFreezeHoursFor(false)).toBe(73);
  });

  test('the flex freeze keeps covering the reminder-claimable band in both modes', () => {
    expect(flexTier.FLEX_TIER_FREEZE_HOURS).toBeGreaterThanOrEqual(routeTiers.REMINDER_SENDABLE_HOURS);
    expect(flexTier.FLEX_TIER_FREEZE_HOURS_24H).toBeGreaterThanOrEqual(routeTiers.REMINDER_SENDABLE_HOURS_24H);
    // The same 1-hour margin 73 has over 72.
    expect(flexTier.FLEX_TIER_FREEZE_HOURS_24H - routeTiers.FREEZE_HOURS_24H)
      .toBe(flexTier.FLEX_TIER_FREEZE_HOURS - routeTiers.FREEZE_HOURS);
  });

  test('the 24.25 h band matches the 24-hour reminder leg the sender uses', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/appointment-reminders.js'), 'utf8');
    expect(src).toMatch(/!r\.reminder_24h_sent && hoursUntil > 0 && hoursUntil <= 24\.25/);
    expect(src).toMatch(/72\.25/);
  });
});

// A db stub that records the selected columns and answers the owner query.
function reminderDb({ rows = [], owners = [] } = {}) {
  const log = { selects: [], ownerWhere: [] };
  let call = 0;
  const db = () => {
    call += 1;
    const isOwner = call > 1;
    const chain = {};
    chain.whereIn = () => chain;
    chain.where = (...args) => { if (isOwner) log.ownerWhere.push(args); return chain; };
    chain.select = async (...cols) => { if (!isOwner) log.selects.push(cols); return isOwner ? owners : rows; };
    return chain;
  };
  db.log = log;
  return db;
}

const row = (over = {}) => ({
  scheduled_service_id: 's1', customer_id: 'c1', appointment_time: at(30), reminder_72h_sent: false, reminder_24h_sent: false, suppressed_by_sibling: false, ...over,
});

describe('loadReminderFreeze with { lock24h: true } (the night passes)', () => {
  const lock = { lock24h: true };

  test('a visit 30 h out with its 72-hour reminder sent is NOT frozen', async () => {
    const res = await loadReminderFreeze(reminderDb({ rows: [row({ reminder_72h_sent: true })] }), ['s1'], NOW, undefined, lock);
    expect(res.failed).toBe(false);
    expect(res.frozen.has('s1')).toBe(false);
  });

  test('a visit 23 h out is frozen (inside the 24-hour reminder band), sent flag or not', async () => {
    const res = await loadReminderFreeze(reminderDb({ rows: [row({ appointment_time: at(23) })] }), ['s1'], NOW, undefined, lock);
    expect(res.frozen.has('s1')).toBe(true);
  });

  test('a visit 30 h out with reminder_24h_sent is frozen', async () => {
    const res = await loadReminderFreeze(reminderDb({ rows: [row({ reminder_24h_sent: true })] }), ['s1'], NOW, undefined, lock);
    expect(res.frozen.has('s1')).toBe(true);
  });

  test('band boundary is inclusive at 24.25 h, matching the sender\'s <=', async () => {
    const frozenAt = async (h) => (await loadReminderFreeze(reminderDb({ rows: [row({ appointment_time: at(h) })] }), ['s1'], NOW, undefined, lock)).frozen.has('s1');
    expect(await frozenAt(24.25)).toBe(true);
    expect(await frozenAt(24.2501)).toBe(false);
    expect(await frozenAt(30)).toBe(false);
  });

  test('the sent flag is read from reminder_24h_sent, not reminder_72h_sent', async () => {
    const db = reminderDb({ rows: [row()] });
    await loadReminderFreeze(db, ['s1'], NOW, undefined, lock);
    expect(db.log.selects[0]).toContain('reminder_24h_sent');
    expect(db.log.selects[0]).not.toContain('reminder_72h_sent');
  });

  test('a sibling placeholder follows its owner row\'s 24-hour send, not the 72-hour one', async () => {
    const placeholder = row({ scheduled_service_id: 's2', suppressed_by_sibling: true });
    const sent = reminderDb({ rows: [placeholder], owners: [{ customer_id: 'c1', appointment_time: placeholder.appointment_time }] });
    expect((await loadReminderFreeze(sent, ['s2'], NOW, undefined, lock)).frozen.has('s2')).toBe(true);
    expect(sent.log.ownerWhere).toContainEqual(['reminder_24h_sent', true]);
    const unsent = reminderDb({ rows: [placeholder], owners: [] });
    expect((await loadReminderFreeze(unsent, ['s2'], NOW, undefined, lock)).frozen.has('s2')).toBe(false);
  });

  test('an explicit band (the flex tier\'s 25 h) is honored with the option', async () => {
    const frozenAt = async (h) => (await loadReminderFreeze(reminderDb({ rows: [row({ appointment_time: at(h) })] }), ['s1'], NOW, flexTier.FLEX_TIER_FREEZE_HOURS_24H, lock)).frozen.has('s1');
    expect(await frozenAt(25)).toBe(true);
    expect(await frozenAt(25.01)).toBe(false);
  });

  test('fail closed: unparseable time freezes; an unreadable db reports failed', async () => {
    expect((await loadReminderFreeze(reminderDb({ rows: [row({ appointment_time: 'garbage' })] }), ['s1'], NOW, undefined, lock)).frozen.has('s1')).toBe(true);
    const broken = () => { throw new Error('db down'); };
    expect((await loadReminderFreeze(broken, ['s1'], NOW, undefined, lock)).failed).toBe(true);
  });
});

describe('loadReminderFreeze without the option keeps the 72-hour rule (rebooker\'s staff series moves)', () => {
  test('30 h out with its 72-hour reminder sent stays frozen; 80 h out unsent stays free; 72.25 h band', async () => {
    const frozenFor = async (over) => (await loadReminderFreeze(reminderDb({ rows: [row(over)] }), ['s1'], NOW)).frozen.has('s1');
    expect(await frozenFor({ reminder_72h_sent: true })).toBe(true);
    expect(await frozenFor({ appointment_time: at(72.25) })).toBe(true);
    expect(await frozenFor({ appointment_time: at(72.26) })).toBe(false);
    // Only the 24-hour reminder sent: that never locked a staff move before.
    expect(await frozenFor({ appointment_time: at(80), reminder_24h_sent: true })).toBe(false);
  });

  test('the gate being ON does not change the default: the reader is not consulted by loadReminderFreeze', async () => {
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    const frozenFor = async (over) => (await loadReminderFreeze(reminderDb({ rows: [row(over)] }), ['s1'], NOW)).frozen.has('s1');
    expect(await frozenFor({ reminder_72h_sent: true })).toBe(true);
    expect(await frozenFor({ appointment_time: at(60) })).toBe(true);
    const db = reminderDb({ rows: [row()] });
    await loadReminderFreeze(db, ['s1'], NOW);
    expect(db.log.selects[0]).toContain('reminder_72h_sent');
  });

  test('rebooker.js\'s two series-move callers pass neither the option nor the gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/rebooker.js'), 'utf8');
    const calls = src.split('\n').filter((line) => line.includes('loadReminderFreeze('));
    expect(calls).toHaveLength(2);
    for (const line of calls) expect(line).not.toMatch(/lock24h|nightLock24h|undefined,/);
    expect(src).not.toMatch(/nightLock24h|NIGHT_LOCK_24H|lock24h/);
  });
});

describe('flex-tier freeze (own schedule and destination)', () => {
  // 2026-11-10 09:00Z = 04:00 ET; a visit at 2026-11-11 05:00 ET is 25 h out.
  const visit = (date, start) => ({ id: 's1', scheduled_date: date, window_start: start });
  const conn = { raw: jest.fn() };

  test('own schedule: 25 h boundary is inclusive with the option; 73 h without it', async () => {
    // 25 h out exactly, then one minute later.
    expect(await flexTier.ownScheduleFrozen(conn, visit('2026-11-11', '05:00'), NOW, true)).toBe(true);
    expect(await flexTier.ownScheduleFrozen(conn, visit('2026-11-11', '05:01'), NOW, true)).toBe(false);
    // 30 h out: free under the 24-hour lock, frozen under the 09-25 rule.
    expect(await flexTier.ownScheduleFrozen(conn, visit('2026-11-11', '10:00'), NOW, true)).toBe(false);
    expect(await flexTier.ownScheduleFrozen(conn, visit('2026-11-11', '10:00'), NOW)).toBe(true);
    expect(await flexTier.ownScheduleFrozen(conn, visit('2026-11-11', '10:00'), NOW, false)).toBe(true);
    // 23 h out is frozen either way.
    expect(await flexTier.ownScheduleFrozen(conn, visit('2026-11-11', '03:00'), NOW, true)).toBe(true);
  });

  test('destination: same rule, 25 h with the option', () => {
    const svc = visit('2026-11-11', '10:00');
    expect(flexTier.destinationFrozen(svc, '2026-11-11', '05:00', NOW, true)).toBe(true);
    expect(flexTier.destinationFrozen(svc, '2026-11-11', '05:01', NOW, true)).toBe(false);
    expect(flexTier.destinationFrozen(svc, '2026-11-11', '10:00', NOW)).toBe(true);
    expect(flexTier.destinationFrozen(svc, '2026-11-13', '08:00', NOW, true)).toBe(false);
    expect(flexTier.destinationFrozen({ id: 's1' }, '2026-11-20', null, NOW, true)).toBe(true); // fail closed
  });

  test('candidate admission follows ctx.nightLock24h (the run\'s one read)', () => {
    const svc = { id: 's1', scheduled_date: '2026-11-14', window_start: '09:00' };
    const tierWindow = { dateFrom: '2026-11-10', dateTo: '2026-11-19' };
    const slot = { date: '2026-11-11', start_time: '10:00' }; // 30 h out
    const ctxFor = (nightLock24h) => ({ tierMeta: { mode: 'flex' }, nowDate: NOW, tierWindow, ...(nightLock24h === undefined ? {} : { nightLock24h }) });
    const admitOf = (ctx) => {
      const drops = { flex_frozen: 0, flex_floor: 0 };
      const kept = flexTier.flexCandidateRules(svc, ctx).admit([slot], drops);
      return { kept: kept.length, drops };
    };
    // Legal destination window ignored here: dayMove bounds are absent, so
    // only the freeze decides.
    expect(admitOf(ctxFor(true)).kept).toBe(1);
    expect(admitOf(ctxFor(false))).toMatchObject({ kept: 0, drops: { flex_frozen: 1 } });
    expect(admitOf(ctxFor(undefined))).toMatchObject({ kept: 0, drops: { flex_frozen: 1 } });
    // The slot-generation floor moves with the freeze: the ET date and first
    // minute past it. NOW + 25 h = 2026-11-11 05:00 ET (05:01 = minute 301);
    // NOW + 73 h = 2026-11-13 05:00 ET, the unchanged 09-25 rule.
    expect(flexTier.flexCandidateRules(svc, ctxFor(true)).findTimeArgs).toEqual({ startFloorByDate: { '2026-11-11': 301 } });
    expect(flexTier.flexCandidateRules(svc, ctxFor(false)).findTimeArgs).toEqual({ startFloorByDate: { '2026-11-13': 301 } });
    // Outside the flex tier nothing changes.
    expect(flexTier.flexCandidateRules(svc, { nowDate: NOW, nightLock24h: true }).findTimeArgs).toEqual({});
  });
});
