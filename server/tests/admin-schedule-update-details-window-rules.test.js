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

describe('window intake by explicit presence (clear both or 422)', () => {
  const { windowIntakeFromBody } = adminScheduleRouter._test;

  test('{ windowStart: null } alone → 422, no transaction, nothing written', async () => {
    const { status, body } = await put({ windowStart: null });
    expect(status).toBe(422);
    expect(body.code).toBe('INVALID_APPOINTMENT_WINDOW');
    expect(body.error).toMatch(/both the start and end/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('{ windowStart: null, windowEnd: null } (or both "") clears BOTH bounds', () => {
    expect(windowIntakeFromBody({ windowStart: null, windowEnd: null })).toEqual({ clearBoth: true });
    expect(windowIntakeFromBody({ windowStart: '', windowEnd: '' })).toEqual({ clearBoth: true });
    expect(windowIntakeFromBody({ windowStart: null, windowEnd: '' })).toEqual({ clearBoth: true });
  });

  test('a partial clear in either direction throws 422; absent fields are "no opinion"; supplied values pass through', () => {
    for (const bad of [{ windowStart: null }, { windowEnd: '' }, { windowStart: null, windowEnd: '10:00' }, { windowStart: '09:00', windowEnd: null }]) {
      let caught;
      try { windowIntakeFromBody(bad); } catch (err) { caught = err; }
      expect(caught?.status).toBe(422);
      expect(caught?.code).toBe('INVALID_APPOINTMENT_WINDOW');
    }
    expect(windowIntakeFromBody({ notes: 'x' })).toEqual({ clearBoth: false, windowStart: undefined, windowEnd: undefined });
    expect(windowIntakeFromBody({ windowStart: '09:00' })).toEqual({ clearBoth: false, windowStart: '09:00', windowEnd: undefined });
    expect(windowIntakeFromBody({ windowStart: '09:00', windowEnd: '10:00' })).toEqual({ clearBoth: false, windowStart: '09:00', windowEnd: '10:00' });
  });

  test('the route only ever writes the intake result (never `windowStart || null`)', () => {
    const ud = src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));
    expect(ud).not.toMatch(/updates\.window_start = windowStart \|\| null/);
    expect(ud).toMatch(/const windowIntake = windowIntakeFromBody\(req\.body\)/);
    expect(ud).toMatch(/if \(windowIntake\.clearBoth\) \{\s*updates\.window_start = null;\s*updates\.window_end = null;/);
  });
});

describe('start-only edit derives its end from the stored span, else estimated_duration_minutes', () => {
  const { windowDurationMinutes } = require('../utils/datetime-et');

  test('windowDurationMinutes: valid span wins; no span → estimated duration; nothing → 60', () => {
    expect(windowDurationMinutes('09:00:00', '11:00:00', 30)).toBe(120);
    expect(windowDurationMinutes('10:00', null, 120)).toBe(120);
    expect(windowDurationMinutes('10:00', '09:00', 90)).toBe(90);
    expect(windowDurationMinutes(null, null, 'abc')).toBe(60);
    expect(windowDurationMinutes(null, null, 0)).toBe(60);
  });

  test('the pre-read selects estimated_duration_minutes and passes it as the fallback', () => {
    const ud = src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));
    expect(ud).toMatch(/\.first\('scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes'\)/);
    expect(ud).toMatch(/windowDurationMinutes\(currentRow\.window_start, currentRow\.window_end, currentRow\.estimated_duration_minutes\)/);
  });

  test('start-only on an end-less 120-minute row validates as a 2-hour block (19:00 → 21:00 is refused; 10:00 passes)', async () => {
    db.mockImplementation(() => chain({ ...STORED, window_end: null, estimated_duration_minutes: 120 }));
    let r = await put({ windowStart: '19:00' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/end by 20:00/);
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('reached trx'), { status: 418 }); });
    r = await put({ windowStart: '10:00' });
    expect(r.status).toBe(418);
  });
});

describe('effective duration on end-less rows + submitted duration + CAS', () => {
  const ud = () => src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));

  test('POST /: an end without a start is asymmetric → 422 before any booking work', async () => {
    const res = await fetch(`${baseUrl}/api/admin/schedule`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: 'cust-1', scheduledDate: '2099-02-01', serviceType: 'Pest Control', windowEnd: '10:00' }),
    });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.code).toBe('INVALID_APPOINTMENT_WINDOW');
    expect(db.transaction).not.toHaveBeenCalled();
    const post = src.slice(src.indexOf("router.post('/', requireAdmin"), src.indexOf("router.post('/bulk-action'"));
    expect(post).toMatch(/const createWindowIntake = windowIntakeFromBody\(req\.body\)/);
  });

  test('update-details DATE-ONLY move of a 19:00 end-less 120-min row → 422 (19:00-21:00 past the day end)', async () => {
    db.mockImplementation(() => chain({ ...STORED, window_start: '19:00:00', window_end: null, estimated_duration_minutes: 120 }));
    const { status, body } = await put({ scheduledDate: '2099-02-01' });
    expect(status).toBe(422);
    expect(body.error).toMatch(/end by 20:00/);
    // Same row with a 60-min duration fits and reaches the transaction.
    db.mockImplementation(() => chain({ ...STORED, window_start: '19:00:00', window_end: null, estimated_duration_minutes: 60 }));
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('reached trx'), { status: 418 }); });
    expect((await put({ scheduledDate: '2099-02-01' })).status).toBe(418);
  });

  test('start-only: the SUBMITTED estimatedDuration wins over the stored one (stored 60 fits at 19:00; submitted 120 does not)', async () => {
    db.mockImplementation(() => chain({ ...STORED, window_start: '09:00:00', window_end: null, estimated_duration_minutes: 60 }));
    const { status, body } = await put({ windowStart: '19:00', estimatedDuration: 120 });
    expect(status).toBe(422);
    expect(body.error).toMatch(/end by 20:00/);
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('reached trx'), { status: 418 }); });
    expect((await put({ windowStart: '19:00' })).status).toBe(418);
    expect(ud()).toMatch(/durationMinutes: submittedDuration\s*\|\| windowDurationMinutes\(currentRow/);
  });

  test('the scheduling-field CAS includes estimated_duration_minutes', () => {
    const cas = ud().slice(ud().indexOf('if (preReadWindowRow && ('), ud().indexOf("code: 'VISIT_CHANGED_RETRY'", ud().indexOf('if (preReadWindowRow && (')));
    expect(cas).toContain('occRow.estimated_duration_minutes');
    expect(cas).toContain('preReadWindowRow.estimated_duration_minutes');
  });
});
