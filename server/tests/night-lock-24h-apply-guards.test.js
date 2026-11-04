// GATE_NIGHT_LOCK_24H (owner 2026-11-03) at the apply-time write path: the
// tapped row's own-schedule and destination checks (checkFlexOwnBounds) and
// the grouped siblings' freeze (checkFlexSiblingBounds) use the 25-hour flex
// freeze and the 24-hour reminder when the run's config carries
// nightLock24h; their refusal text names the hours enforced. Gate off (no
// lock24h argument) is the 73-hour rule, call for call.
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn(),
}));
jest.mock('../services/appointment-reminders', () => ({
  // A realistic composer (mirrors the real module's own logic) so
  // ownScheduleFrozen's hours-until-appointment math is genuine, without
  // pulling in the full appointment-reminders module and its own
  // dependencies into this unit test.
  composeScheduledApptTime: jest.fn((svc) => {
    if (!svc) return null;
    const datePart = String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    if (!datePart || !timePart) return null;
    return require('../utils/datetime-et').parseETDateTime(`${datePart}T${timePart}`);
  }),
}));

const routeTiers = require('../services/auto-dispatch/route-tiers');
const {
  makeMoveGuard, checkFlexOwnBounds, checkFlexSiblingBounds,
} = require('../services/auto-dispatch/apply');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${TODAY}T12:00`), n));

function refuseFactory() {
  return (id, why) => Object.assign(new Error(`refused ${id}: ${why}`), { code: 'TEST_REFUSE', id, why });
}

// `raw` answers fenceFlexSeries' pg_try_advisory_xact_lock — granted
// unless the parent is listed in `busyParents`.
function withSeriesFence(trx, busyParents = []) {
  trx.raw = jest.fn(async (_sql, [, parentId]) => ({ rows: [{ locked: !busyParents.includes(parentId) }] }));
  return trx;
}

// A trx stub for the reads these unit-level guard functions issue once
// loadReminderFreeze is mocked: loadSeriesNeighbors' bulk
// `db('scheduled_services').where(fn).whereNotIn(status)[.forShare().noWait()].select(...)`
// and route-tiers' loadAnchorMap evidence reads (reschedule_log /
// auto_dispatch_audit_logs — `moves` are reschedule_log rows, none by
// default, so every visit anchors on its own date). `trx.locks` records the
// row-lock clauses; `rowLockBusy` makes a NOWAIT read fail the way
// PostgreSQL does when another transaction holds a series row (55P03).
function seriesTrx(rowsByParent, busyParents, moves = [], { rowLockBusy = false } = {}) {
  const locks = [];
  const trx = withSeriesFence(jest.fn((table) => {
    if (table === 'reschedule_log' || table === 'auto_dispatch_audit_logs') {
      const rows = table === 'reschedule_log' ? moves : [];
      const chain = {
        whereIn: () => chain, where: () => chain, orderBy: () => chain, select: async () => rows,
      };
      return chain;
    }
    if (table !== 'scheduled_services') throw new Error(`unexpected table ${table}`);
    let parentIds = [];
    let noWait = false;
    const capture = { whereIn: (col, vals) => { if (col === 'id') parentIds = vals; return capture; }, orWhereIn: () => capture };
    const api = {
      where: (fn) => { fn.call(capture); return api; },
      whereNotIn: () => api,
      forShare: () => { locks.push('forShare'); return api; },
      noWait: () => { locks.push('noWait'); noWait = true; return api; },
      select: async () => {
        if (noWait && rowLockBusy) {
          throw Object.assign(new Error('could not obtain lock on row in relation "scheduled_services"'), { code: '55P03' });
        }
        return parentIds.flatMap((pid) => (rowsByParent[pid] || [])
          .map((r) => ({ recurring_parent_id: r.id === pid ? null : pid, ...r })));
      },
    };
    return api;
  }), busyParents);
  trx.locks = locks;
  return trx;
}

// The unit mover's per-member targets for `rows`, each landing on its own
// current start (the member guard reads a sibling's destination start here).
const targetsOf = (rows) => rows.map((r) => ({ id: r.id, startHHMM: r.window_start }));

beforeEach(() => {
  jest.clearAllMocks();
});

const HOUR = 3600000;
// A row whose arrival is `hours` from now (ET date + HH:MM), recurring child of p1.
function rowAt(hours, over = {}) {
  const t = new Date(Date.now() + hours * HOUR);
  const { hour, minute } = require('../utils/datetime-et').etParts(t);
  return {
    id: 's1', scheduled_date: etDateString(t), window_start: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, is_recurring: true, recurring_parent_id: 'p1', ...over,
  };
}
const startOf = (hours) => rowAt(hours).window_start;
const dateOf = (hours) => rowAt(hours).scheduled_date;

describe('checkFlexOwnBounds with lock24h', () => {
  const BEST = { date: dayOffset(6), technician_id: null };

  test('a row 30 h out clears the freeze (25 h) and is only bounded by its series window; 73-hour rule refuses it', async () => {
    const row = rowAt(30);
    const trx = seriesTrx({ p1: [row] });
    await expect(checkFlexOwnBounds(trx, row, BEST, 'flex', refuseFactory(), undefined, true)).resolves.toBeUndefined();
    await expect(checkFlexOwnBounds(seriesTrx({ p1: [row] }), row, BEST, 'flex', refuseFactory(), undefined, false))
      .rejects.toMatchObject({ code: 'TEST_REFUSE', why: expect.stringContaining('within 73 hours of its own scheduled time') });
    await expect(checkFlexOwnBounds(seriesTrx({ p1: [row] }), row, BEST, 'flex', refuseFactory()))
      .rejects.toMatchObject({ why: expect.stringContaining('73 hours') });
  });

  test('a row 20 h out is refused, and the text names 25 hours', async () => {
    const row = rowAt(20);
    const trx = jest.fn(() => { throw new Error('must not query — frozen before any DB read'); });
    await expect(checkFlexOwnBounds(trx, row, BEST, 'flex', refuseFactory(), undefined, true))
      .rejects.toMatchObject({ code: 'TEST_REFUSE', id: 's1', why: expect.stringContaining('within 25 hours of its own scheduled time') });
  });

  test('the destination must clear 25 h too: a same-day re-time 20 h out is refused, 30 h out is not', async () => {
    const row = rowAt(30);
    const soon = { date: dateOf(20), windowStart: startOf(20) };
    await expect(checkFlexOwnBounds(seriesTrx({ p1: [row] }), row, BEST, 'flex', refuseFactory(), soon, true))
      .rejects.toMatchObject({ why: expect.stringContaining('would start within 25 hours at its destination') });
    const later = { date: dateOf(31), windowStart: startOf(31) };
    await expect(checkFlexOwnBounds(seriesTrx({ p1: [row] }), row, BEST, 'flex', refuseFactory(), later, true)).resolves.toBeUndefined();
  });

  test('makeMoveGuard reads the run\'s config.nightLock24h (not the gate)', async () => {
    const row = rowAt(20);
    process.env.GATE_NIGHT_LOCK_24H = 'true';
    try {
      const guard = (config) => makeMoveGuard({ service: row, best: { date: dayOffset(6) }, config })({ trx: jest.fn(), technicianId: 't1', service: row });
      // Config says off although the env says on: the 73-hour rule applies.
      await expect(guard({ guardMode: 'flex', nightLock24h: false })).rejects.toThrow('within 73 hours');
      await expect(guard({ guardMode: 'flex', nightLock24h: true })).rejects.toThrow('within 25 hours');
    } finally {
      delete process.env.GATE_NIGHT_LOCK_24H;
    }
  });
});

describe('checkFlexSiblingBounds with lock24h', () => {
  const BEST = { date: dayOffset(6) };
  const sib = (hours, over = {}) => rowAt(hours, { id: 's2', ...over });

  test('asks route-tiers for the 25 h band with the lock24h option; gate off asks for 73 h with no option', async () => {
    const rows = [sib(30)];
    const trx = seriesTrx({ p1: rows });
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
    await expect(checkFlexSiblingBounds(trx, rows, rows, BEST, TODAY, refuseFactory(), targetsOf(rows), true)).resolves.toBeUndefined();
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), 25, { lock24h: true });
    await expect(checkFlexSiblingBounds(seriesTrx({ p1: rows }), rows, rows, BEST, TODAY, refuseFactory(), targetsOf(rows)))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('73 hours') });
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(expect.anything(), ['s2'], expect.any(Date), 73);
  });

  test('a sibling inside 25 h of its own schedule, or flagged frozen by the 24-hour reminder, freezes the group', async () => {
    const near = [sib(20)];
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
    await expect(checkFlexSiblingBounds(seriesTrx({ p1: near }), near, near, BEST, TODAY, refuseFactory(), targetsOf(near), true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('within 25 hours of its own scheduled time') });
    const far = [sib(30)];
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set(['s2']) });
    await expect(checkFlexSiblingBounds(seriesTrx({ p1: far }), far, far, BEST, TODAY, refuseFactory(), targetsOf(far), true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('25-hour reminder window') });
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: true, frozen: new Set() });
    await expect(checkFlexSiblingBounds(seriesTrx({ p1: far }), far, far, BEST, TODAY, refuseFactory(), targetsOf(far), true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('unreadable') });
  });

  test('a grouped destination 20 h out is refused', async () => {
    const rows = [sib(30)];
    routeTiers.loadReminderFreeze.mockResolvedValue({ failed: false, frozen: new Set() });
    const targets = [{ id: 's2', startHHMM: startOf(20) }];
    await expect(checkFlexSiblingBounds(seriesTrx({ p1: rows }), rows, rows, { date: dateOf(20) }, TODAY, refuseFactory(), targets, true))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('would start within 25 hours at its destination') });
  });
});
