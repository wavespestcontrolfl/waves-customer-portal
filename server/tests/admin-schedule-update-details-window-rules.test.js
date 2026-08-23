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
  test('POST / locks the FULL planned date set (anchor + children + boosters) before the comms lock', () => {
    const post = src.slice(src.indexOf("router.post('/', requireAdmin"), src.indexOf("router.post('/bulk-action'"));
    const lockIdx = post.indexOf('acquireAdminSlotLocks({ trx, dates: [...seriesDates] })');
    const commsIdx = post.indexOf('await lockCustomerComms(trx, customerId)');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(commsIdx);
    // The spawn loops consume the pre-trx plan — no in-trx re-derivation.
    expect(post).toMatch(/for \(const nextDateStr of plannedChildDates\)/);
    expect(post).toMatch(/for \(const boosterDate of plannedBoosterDates\)/);
    expect(post.slice(post.indexOf('await db.transaction'))).not.toMatch(/nextRecurringDate\(/);
  });

  test('update-details pre-locks the re-seed date plan first and probes each spawned child under it', () => {
    const ud = src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));
    const trxIdx = ud.indexOf('await db.transaction(async (trx) => {');
    const lockIdx = ud.indexOf('acquireAdminSlotLocks({ trx, dates: lockedSpawnDates })');
    const commsIdx = ud.indexOf('await lockCustomerComms(trx, commsPeek.customer_id)');
    expect(lockIdx).toBeGreaterThan(trxIdx);
    expect(lockIdx).toBeLessThan(commsIdx);
    expect(ud).toMatch(/SERIES_ANCHOR_MOVED_RETRY/);
    const probeIdx = ud.indexOf("assertNoSlotOverlap({ trx, date: nextDateStr, windowStart: childStart");
    const insertIdx = ud.indexOf("trx('scheduled_services').insert(childData)");
    expect(probeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(insertIdx);
  });
});

test('recurringChildDateCandidates reproduces the inline derivation the spawn loops used', () => {
  const { recurringChildDateCandidates } = adminScheduleRouter._test;
  const weekly = recurringChildDateCandidates({
    baseDateStr: '2099-01-05', recurringPattern: 'weekly', rOpts: {}, skipWeekends: false, shiftDir: 'forward', maxAttempts: 4,
  });
  expect(weekly).toEqual(['2099-01-12', '2099-01-19', '2099-01-26']);
});

describe('rung-1 follow-ups (source-pattern guards)', () => {
  const ud = src.slice(src.indexOf("router.put('/:id/update-details'"), src.indexOf("router.put('/:id/assign'"));

  test('the locked row is compared with the unlocked pre-read before the write; drift fails closed (VISIT_CHANGED_RETRY)', () => {
    const driftIdx = ud.indexOf("code: 'VISIT_CHANGED_RETRY'");
    const writeIdx = ud.indexOf("await trx('scheduled_services').where({ id: req.params.id }).update(updates);");
    expect(driftIdx).toBeGreaterThan(-1);
    expect(driftIdx).toBeLessThan(writeIdx);
    const check = ud.slice(ud.indexOf('const lockedRow = preTupleRow'), driftIdx);
    expect(check).toMatch(/forUpdate\(\)/);
    for (const col of ['scheduled_date', 'window_start', 'window_end']) expect(check).toContain(`lockedRow.${col}`);
  });

  test('cadence-rewrite destinations are planned into the rung-1 lock set and every re-dated child/booster is fenced before its CAS update', () => {
    expect(ud).toMatch(/const mayRewriteSeries = isRecurring && spawnRecurringChildren === false/);
    expect(ud).toMatch(/\(willSpawnChildren \|\| mayRewriteSeries\) && currentRow/);
    // Booster destinations cover both derivations the rewrite chooses from.
    expect(ud).toMatch(/computeBoosterDates\(probeDate, normalizeBoosterMonths\(currentRow\.booster_months\), 12\)/);
    const rewrite = ud.slice(ud.indexOf('shouldRewritePendingRecurringRows(recurringParentBefore, parent)'));
    const childFence = rewrite.indexOf('await fenceRewriteDestination(child, nextDateStr)');
    const childCas = rewrite.indexOf('const childUpdated = await');
    const boosterFence = rewrite.indexOf('await fenceRewriteDestination(booster, nextDateStr)');
    const boosterCas = rewrite.indexOf('const boosterUpdated = await');
    expect(childFence).toBeGreaterThan(-1);
    expect(childFence).toBeLessThan(childCas);
    expect(boosterFence).toBeGreaterThan(childCas);
    expect(boosterFence).toBeLessThan(boosterCas);
    const fence = rewrite.slice(rewrite.indexOf('const fenceRewriteDestination'), rewrite.indexOf('const pendingRewriteIds'));
    expect(fence).toMatch(/SERIES_ANCHOR_MOVED_RETRY/);
    expect(fence).toMatch(/assertNoSlotOverlap\(\{ trx, date: nextDateStr/);
  });
});
