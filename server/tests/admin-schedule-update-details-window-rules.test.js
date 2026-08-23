/**
 * update-details — shared admin window rules on the EFFECTIVE pair, plus the
 * rung-1 wiring of the series writers (source-pattern guards for the trx
 * internals the unit harness can't reach).
 *
 * An END-only edit used to persist unchecked (end before the stored start,
 * or past the day end). Now either supplied endpoint validates the pair
 * (supplied-or-stored start, supplied-or-stored end) → 422
 * INVALID_APPOINTMENT_WINDOW before the transaction opens.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

const STORED = { id: 'svc-1', scheduled_date: '2099-01-15', window_start: '10:00:00', window_end: '11:00:00' };

function chain(row) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'select', 'orderBy']) c[m] = jest.fn().mockReturnThis();
  c.first = jest.fn().mockResolvedValue(row);
  c.columnInfo = jest.fn().mockResolvedValue({});
  c.update = jest.fn().mockResolvedValue(1);
  return c;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn();
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation(() => chain(STORED));
  db.transaction = jest.fn(async () => { throw new Error('transaction must not open on a refused window'); });
});

async function put(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('END-only edit before the stored start → 422, no transaction', async () => {
  const { status, body } = await put({ windowEnd: '09:00' });
  expect(status).toBe(422);
  expect(body.code).toBe('INVALID_APPOINTMENT_WINDOW');
  expect(body.error).toMatch(/after its start/);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('END-only edit past the day end → 422', async () => {
  const { status, body } = await put({ windowEnd: '21:00' });
  expect(status).toBe(422);
  expect(body.error).toMatch(/end by 20:00/);
});

test('END-only edit on a windowless row → 422 (a start is required)', async () => {
  db.mockImplementation(() => chain({ ...STORED, window_start: null, window_end: null }));
  const { status, body } = await put({ windowEnd: '11:00' });
  expect(status).toBe(422);
  expect(body.error).toMatch(/without a start/);
});

test('START-only pre-8am / half-hour edits → 422', async () => {
  expect((await put({ windowStart: '07:00' })).body.error).toMatch(/before 08:00/);
  expect((await put({ windowStart: '09:30' })).body.error).toMatch(/on the hour/);
});

describe('rung-1 wiring (source-pattern guards)', () => {
  test('POST / locks the FULL planned date set (anchor + children + boosters) before the comms lock; the spawn loops consume the pre-trx plan', () => {
    const post = src.slice(src.indexOf("router.post('/', requireAdmin"), src.indexOf("router.post('/bulk-action'"));
    const lockIdx = post.indexOf('await acquireOccupancyLocks(trx, [dateOnly(scheduledDate), ...plannedChildDates, ...plannedBoosterDates])');
    const commsIdx = post.indexOf('await lockCustomerComms(trx, customerId)');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(commsIdx);
    expect(post).toMatch(/for \(const nextDateStr of plannedChildDates\)/);
    expect(post).toMatch(/for \(const boosterDate of plannedBoosterDates\)/);
    expect(post.slice(post.indexOf('await db.transaction'))).not.toMatch(/nextRecurringDate\(/);
  });

  test('the update-details move probe excludes every cadence-rewrite participant, not just the parent', () => {
    const ud = src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));
    const probe = ud.slice(ud.indexOf('const adminMoveClash = await findConflictingVisits({'), ud.indexOf('if (adminMoveClash.length)'));
    expect(probe).toMatch(/excludeServiceIds: await adminMoveProbeExcludeIds\(trx, \{/);
    expect(probe).toMatch(/parentBefore: recurringParentBefore/);
    // The rewrite's own per-row probes already exclude the whole participant set.
    expect(ud).toMatch(/const rewriteProbeExcludeIds = \[parent\.id, \.\.\.pendingRewriteIds\]/);
  });
});

describe('adminMoveProbeExcludeIds — batch-move exclusion for the admin move probe', () => {
  const { adminMoveProbeExcludeIds } = adminScheduleRouter._test;
  // Weekly parent with two pending children a week apart.
  const PARENT = {
    id: 'parent-1', is_recurring: true, recurring_parent_id: null, recurring_pattern: 'weekly',
    scheduled_date: '2099-01-05', skip_weekends: false, weekend_shift: null,
  };
  function fakeTrx(rows) {
    const q = {
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(rows),
    };
    const trx = jest.fn(() => q);
    trx.q = q;
    return trx;
  }

  test("weekly parent moved onto its own child's slot: the parent AND every pending child/booster are excluded", async () => {
    const trx = fakeTrx([{ id: 'child-jan12' }, { id: 'child-jan19' }, { id: 'booster-1' }]);
    const ids = await adminMoveProbeExcludeIds(trx, {
      id: 'parent-1', parentBefore: PARENT, updates: { scheduled_date: '2099-01-12' },
    });
    expect(ids).toEqual(['parent-1', 'child-jan12', 'child-jan19', 'booster-1']);
    expect(trx.q.where).toHaveBeenCalledWith({ recurring_parent_id: 'parent-1' });
    expect(trx.q.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed']);
  });

  test('an unrelated visit is never excluded: only rows under this parent are read, so a clash with it still 409s', async () => {
    const trx = fakeTrx([{ id: 'child-jan12' }]);
    const ids = await adminMoveProbeExcludeIds(trx, {
      id: 'parent-1', parentBefore: PARENT, updates: { scheduled_date: '2099-01-12' },
    });
    expect(ids).not.toContain('unrelated-visit');
    expect(ids).toEqual(['parent-1', 'child-jan12']);
  });

  test('no cadence change (notes-only save) → children keep their slots, so only the row itself is excluded', async () => {
    const trx = fakeTrx([{ id: 'child-jan12' }]);
    const ids = await adminMoveProbeExcludeIds(trx, { id: 'parent-1', parentBefore: PARENT, updates: { notes: 'x' } });
    expect(ids).toEqual(['parent-1']);
    expect(trx).not.toHaveBeenCalled();
  });

  test('a child row / non-recurring row / no before-row → only itself', async () => {
    const trx = fakeTrx([]);
    expect(await adminMoveProbeExcludeIds(trx, { id: 'c1', parentBefore: { ...PARENT, id: 'c1', recurring_parent_id: 'parent-1' }, updates: { scheduled_date: '2099-02-01' } })).toEqual(['c1']);
    expect(await adminMoveProbeExcludeIds(trx, { id: 'x', parentBefore: null, updates: { scheduled_date: '2099-02-01' } })).toEqual(['x']);
    expect(trx).not.toHaveBeenCalled();
  });
});

describe('date-only moves + the scheduling-field CAS', () => {
  test('a DATE-ONLY move of a legacy 07:00 row → 422 before the transaction', async () => {
    db.mockImplementation(() => chain({ ...STORED, window_start: '07:00:00', window_end: '08:00:00' }));
    const { status, body } = await put({ scheduledDate: '2099-02-01' });
    expect(status).toBe(422);
    expect(body.error).toMatch(/before 08:00/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a DATE-ONLY move of a windowless row (both null) passes validation and opens the transaction', async () => {
    db.mockImplementation(() => chain({ ...STORED, window_start: null, window_end: null }));
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('reached trx'), { status: 418 }); });
    const { status } = await put({ scheduledDate: '2099-02-01' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(status).toBe(418);
  });

  test('the locked row is CAS-compared with the unlocked pre-read (date/start/end) before the write — drift is 409 VISIT_CHANGED_RETRY', () => {
    const ud = src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));
    const casIdx = ud.indexOf('if (preReadWindowRow && (');
    const writeIdx = ud.indexOf("await trx('scheduled_services').where({ id: req.params.id }).update(updates);");
    expect(casIdx).toBeGreaterThan(ud.indexOf('const occRow = preTupleRow'));
    expect(casIdx).toBeLessThan(writeIdx);
    const cas = ud.slice(casIdx, ud.indexOf("code: 'VISIT_CHANGED_RETRY'", casIdx));
    for (const col of ['scheduled_date', 'window_start', 'window_end']) {
      expect(cas).toContain(`occRow.${col}`);
      expect(cas).toContain(`preReadWindowRow.${col}`);
    }
  });
});
