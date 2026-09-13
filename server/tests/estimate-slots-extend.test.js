/**
 * POST /:token/reserve/:scheduledServiceId/extend — the "extend my hold"
 * endpoint (2026-09-11 incident). Mocks slotReservation.extendReservation
 * and asserts one response shape per branch — same infra as
 * estimate-slots-public-gates.test.js (real router, ephemeral port, fetch;
 * no supertest in this repo).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  getAvailableSlots: jest.fn(),
  findEstimateSlots: jest.fn(),
  MAX_SLOT_HORIZON_DAYS: 90,
}));
jest.mock('../services/slot-reservation', () => ({
  reserveSlot: jest.fn(),
  releaseReservation: jest.fn(),
  extendReservation: jest.fn(),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  commercialLowConfidenceRange: jest.fn(() => ({ hasLowConfidence: false })),
}));
jest.mock('../services/estimate-deposits', () => ({
  createDepositIntentForEstimate: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  createCardHoldSetupIntentForEstimate: jest.fn(),
  resolveCardHoldPolicy: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  // Faithful replica of estimate-public.js isEstimateCustomerViewable — see
  // estimate-slots-public-gates.test.js for why the real module isn't
  // required here.
  isEstimateCustomerViewable: (estimate = {}, now = new Date()) => {
    if (!estimate || estimate.archived_at) return false;
    if (['accepted', 'declined'].includes(estimate.status)) return true;
    if (['draft', 'scheduled'].includes(estimate.status)) return false;
    if (['expired', 'send_failed'].includes(estimate.status)) return false;
    if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
    return true;
  },
  isEstimateAcceptActive: jest.fn(() => true),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  isRodentGuaranteeOnlyEstimate: jest.fn(() => false),
  estimateTrenchingReviewRequired: jest.fn(() => false),
  verifyEstimateAskToken: jest.fn(() => true),
  handleEstimateAsk: jest.fn((req, res) => res.json({})),
}));

const express = require('express');
const db = require('../models/db');
const slotReservation = require('../services/slot-reservation');

const TOKEN = 'test-token-abc123';
const VIEWABLE_ESTIMATE = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };

let server;
let base;
let currentEstimate;

beforeAll((done) => {
  db.mockImplementation((table) => {
    if (table !== 'estimates') throw new Error(`unexpected table ${table}`);
    return {
      where: jest.fn().mockReturnThis(),
      first: jest.fn(() => Promise.resolve(currentEstimate)),
    };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/public/estimates', require('../routes/estimate-slots-public'));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}/api/public/estimates`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  currentEstimate = VIEWABLE_ESTIMATE;
  slotReservation.extendReservation.mockReset();
});

// A real uuid: the route gates the id against scheduled_services.id's uuid
// column before any query (hold-grace self-audit), so a placeholder string would now be
// the generic 404 rather than reaching the service.
const HOLD_ID = '11111111-2222-4333-8444-555555555555';

function extend(scheduledServiceId = HOLD_ID) {
  return fetch(`${base}/${TOKEN}/reserve/${scheduledServiceId}/extend`, { method: 'POST' });
}

describe('POST /:token/reserve/:scheduledServiceId/extend', () => {
  test('malformed token 404s before any estimate lookup', async () => {
    const res = await fetch(`${base}/invalid!token/reserve/${HOLD_ID}/extend`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(slotReservation.extendReservation).not.toHaveBeenCalled();
  });

  test('unknown token 404s', async () => {
    currentEstimate = null;
    const res = await extend();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(slotReservation.extendReservation).not.toHaveBeenCalled();
  });

  test('a non-viewable estimate (e.g. archived) 404s without calling the service', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: '2026-07-01T00:00:00Z' };
    const res = await extend();
    expect(res.status).toBe(404);
    expect(slotReservation.extendReservation).not.toHaveBeenCalled();
  });

  test('200 extends and returns an ISO expiresAt', async () => {
    slotReservation.extendReservation.mockResolvedValue({
      scheduledServiceId: HOLD_ID,
      expiresAt: new Date('2027-05-20T13:30:00.000Z'),
    });
    const res = await extend();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      scheduledServiceId: HOLD_ID,
      expiresAt: '2027-05-20T13:30:00.000Z',
    });
    expect(slotReservation.extendReservation).toHaveBeenCalledWith({
      estimateId: 'est-1',
      scheduledServiceId: HOLD_ID,
      // The locked no-booking recheck the service runs on its own read
      // (codex r6 P1) — the route owns the predicate and the bodies.
      revalidateEstimate: expect.any(Function),
    });
  });

  test('a string expiresAt passes through unchanged', async () => {
    slotReservation.extendReservation.mockResolvedValue({
      scheduledServiceId: HOLD_ID,
      expiresAt: '2027-05-20T13:30:00.000Z',
    });
    const res = await extend();
    expect(res.status).toBe(200);
    expect((await res.json()).expiresAt).toBe('2027-05-20T13:30:00.000Z');
  });

  test('RESERVATION_NOT_FOUND 404s', async () => {
    slotReservation.extendReservation.mockRejectedValue(Object.assign(new Error('reservation not found'), { code: 'RESERVATION_NOT_FOUND' }));
    const res = await extend();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('ESTIMATE_NOT_FOUND and ESTIMATE_EXPIRED also 404 (race between the route load and the locked re-check)', async () => {
    for (const code of ['ESTIMATE_NOT_FOUND', 'ESTIMATE_EXPIRED']) {
      slotReservation.extendReservation.mockRejectedValue(Object.assign(new Error(code), { code }));
      const res = await extend();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  test('ESTIMATE_TERMINAL 409s', async () => {
    slotReservation.extendReservation.mockRejectedValue(Object.assign(new Error('terminal'), { code: 'ESTIMATE_TERMINAL' }));
    const res = await extend();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Estimate is no longer active' });
  });

  test('HOLD_LIMIT_REACHED 409s with the current expiresAt', async () => {
    slotReservation.extendReservation.mockRejectedValue(Object.assign(new Error('limit'), {
      code: 'HOLD_LIMIT_REACHED',
      expiresAt: new Date('2027-05-20T13:15:00.000Z'),
    }));
    const res = await extend();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Your time-slot hold has reached its limit — pick a time again',
      code: 'HOLD_LIMIT_REACHED',
      expiresAt: '2027-05-20T13:15:00.000Z',
    });
  });

  // The blackout recheck's verdict is DEFINITIVE (codex r10 P1). Unmapped it
  // fell through to the catch-all 500, which the client treats as "no
  // verdict" — so it kept an unusable hold instead of opening recovery.
  test('RESERVATION_EXPIRED 409s with the coded hold-expiry body, never a 500', async () => {
    slotReservation.extendReservation.mockRejectedValue(Object.assign(new Error('that day is no longer available'), {
      code: 'RESERVATION_EXPIRED',
    }));
    const res = await extend();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Your time-slot hold expired — pick a time again to finish signing up',
      code: 'RESERVATION_EXPIRED',
    });
  });

  test('SLOT_UNAVAILABLE 409s with the slotId', async () => {
    slotReservation.extendReservation.mockRejectedValue(Object.assign(new Error('taken'), {
      code: 'SLOT_UNAVAILABLE',
      slotId: '2027-05-20_09-00_tech-1',
    }));
    const res = await extend();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'slot no longer available',
      code: 'SLOT_UNAVAILABLE',
      slotId: '2027-05-20_09-00_tech-1',
    });
  });

  test('an unrecognized service error 500s with retry:true', async () => {
    slotReservation.extendReservation.mockRejectedValue(new Error('boom'));
    const res = await extend();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'unable to extend hold', retry: true });
  });

  test('a malformed hold id is the SAME generic 404, never a 500 from the uuid column (hold-grace self-audit)', async () => {
    const res = await extend('not-a-uuid');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(slotReservation.extendReservation).not.toHaveBeenCalled();
  });

  test('carries the same no-store/no-referrer privacy headers as the other slot endpoints', async () => {
    slotReservation.extendReservation.mockResolvedValue({ scheduledServiceId: HOLD_ID, expiresAt: '2027-05-20T13:30:00.000Z' });
    const res = await extend();
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

// Lock order is part of the contract, not a detail (codex r3 P1):
// reserveSlot locks the estimate and THEN selects its live holds FOR UPDATE,
// so extendReservation must take the same two locks in the same order. The
// reverse order deadlocked a cross-date re-pick against an in-flight extend —
// different rung-1 date locks, each txn holding one row and waiting for the
// other — which Postgres resolves by aborting one side as a 500.
describe('extendReservation lock order matches reserveSlot', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function extendReservation'), src.indexOf('module.exports'));

  test('the occupancy lock comes first, then the estimate, then the hold row', () => {
    const iOccupancy = fn.indexOf('acquireOccupancyLock(trx, scheduledDate)');
    const iEstimate = fn.indexOf("const estimate = await trx('estimates')");
    const iRow = fn.indexOf("const row = await trx('scheduled_services')");
    expect(iOccupancy).toBeGreaterThan(-1);
    expect(iEstimate).toBeGreaterThan(iOccupancy);
    expect(iRow).toBeGreaterThan(iEstimate);
  });

  test('both row locks are still FOR UPDATE', () => {
    const between = fn.slice(fn.indexOf("const estimate = await trx('estimates')"));
    expect((between.match(/\.forUpdate\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

// The locked recheck must apply the FULL viewability predicate (codex r3 P0).
// A row that flips sent -> draft / scheduled / send_failed while the txn waits
// on its locks passes the terminal-status list and the off-surface check, yet
// isEstimateCustomerViewable refuses it — so the extend would keep a hold
// alive for a quote the renderer no longer serves.
describe('extendReservation rechecks full viewability under the lock', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function extendReservation'), src.indexOf('module.exports'));

  test('isEstimateCustomerViewable gates the locked estimate, answering the generic not-found', () => {
    expect(fn).toContain("require('../routes/estimate-public')");
    expect(fn).toContain('!isEstimateCustomerViewable(estimate)');
    const at = fn.indexOf('!isEstimateCustomerViewable(estimate)');
    expect(fn.slice(at, at + 260)).toContain("err.code = 'ESTIMATE_NOT_FOUND'");
  });

  test('the predicate is the route module\'s, not a re-listed status array', () => {
    // A local copy would drift from the renderer the moment a status is
    // added — that drift is exactly what this P0 was.
    const viewability = fn.slice(fn.indexOf('isEstimateCustomerViewable'));
    expect(viewability).not.toMatch(/\['draft', 'scheduled'\]/);
  });
});

// Round-4 contract pins.
describe('extendReservation: revival and the capped no-op', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function extendReservation'), src.indexOf('module.exports'));

  test('a lapsed hold is not revived while the estimate owns another live hold (codex r4 P2)', () => {
    // The window-scoped probe cannot see a NON-overlapping rival the
    // customer created in another tab, so one estimate would hold two live
    // slots — which reserveSlot explicitly supersedes.
    expect(fn).toContain('const rivalLiveHold = await trx(\'scheduled_services\')');
    const at = fn.indexOf('const rivalLiveHold');
    const block = fn.slice(at, at + 520);
    expect(block).toContain(".whereNot({ id: row.id })");
    expect(block).toContain("andWhereRaw('reservation_expires_at > NOW()')");
    expect(block).toContain("err.code = 'RESERVATION_NOT_FOUND'");
    // Only a LAPSED revival needs it — a live hold never stopped occupying
    // its window.
    expect(fn.slice(0, at)).toContain('if (alreadyLapsed) {');
  });

  test('the capped no-op returns only AFTER the occupancy probe (codex r4 P2)', () => {
    const iProbe = fn.indexOf('const clash = rowUnderCapacity');
    const iNoop = fn.indexOf('// Idempotent: the requested extension would not move the expiry');
    expect(iProbe).toBeGreaterThan(-1);
    expect(iNoop).toBeGreaterThan(iProbe);
    // …and still before the write, so a capped hold never writes.
    expect(fn.indexOf("update({ reservation_expires_at: newExpiry })")).toBeGreaterThan(iNoop);
  });
});

// Capacity semantics come from the PERSISTED policy, not the gate alone
// (codex r4 P1) — the same rule commitReservation applies. After a gate
// rollback, a version-2 hold's window is governed by its arrival allocation,
// so the legacy global overlap probe could delete a hold an allocation
// permits.
describe('extendReservation honors the persisted reservation policy', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function extendReservation'), src.indexOf('module.exports'));

  test('both the lapsed guard and the probe key off the row, not just the gate', () => {
    expect(fn).toContain("const heldCapacity = require('./combined-visit-capacity').capacityFromReservation(row);");
    expect(fn).toContain('const rowUnderCapacity = row.reservation_policy_version === 2');
    expect(fn).toContain("|| (capacityEnabled() && heldCapacity?.version !== 1);");
    expect(fn).toContain('if (alreadyLapsed && rowUnderCapacity) {');
    expect(fn).toContain('const clash = rowUnderCapacity ? [] : await findConflictingVisits({');
    // No bare gate read decides conflict semantics any more.
    expect(fn).not.toMatch(/capacityEnabled\(\) \? \[\] :/);
    // And the predicate is byte-identical to commitReservation's, so a
    // legacy version-1 combined hold takes the same path in both (codex r13).
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
    const commit = src2.slice(src2.indexOf('async function commitReservation'), src2.indexOf('async function releaseReservation'));
    expect(commit).toContain('row.reservation_policy_version === 2 || (capacityEnabled() && heldCapacity?.version !== 1)');
  });
});

// The extend route mirrors /reserve's specialized no-booking guards (codex
// r5 P1). An estimate reshaped into a commercial-manual, guarantee-only or
// trenching-review contract while its hold was live is one /reserve refuses;
// extending it would let a stale hold hold capacity for up to an hour and
// keep being offered as an existing_appointment that accept precedence could
// graduate into a visit the contract says must not exist.
describe('extend route mirrors the /reserve no-booking guards', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-slots-public.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/:token/reserve/:scheduledServiceId/extend'"));
  const guardBlock = route.slice(0, route.indexOf('slotReservation.extendReservation'));

  test.each([
    ['isCommercialAutoEstimate(row)', 'commercialManualScheduling: true'],
    ['isRodentGuaranteeOnlyEstimate(row, parseEstimateData(row))', 'invoiceOnlyAcceptance: true'],
    ['estimateTrenchingReviewRequired(parseEstimateData(row))', 'TRENCHING_REVIEW_409'],
  ])('%s is refused before the service call', (guard, body) => {
    expect(guardBlock).toContain(guard);
    expect(guardBlock).toContain(body);
  });

  test('the guards run after the token/uuid gates and before any extend', () => {
    expect(guardBlock.indexOf('HOLD_ID_RE.test')).toBeLessThan(guardBlock.indexOf('const noBookingRefusal ='));
  });

  // ONE predicate, used twice (codex r6 P1): the pre-txn read can go stale
  // while the txn waits on its locks, and these shapes live in estimate_data,
  // which the locked viewability check does not re-derive.
  test('the same predicate is handed to the service for the locked recheck', () => {
    expect(guardBlock).toContain('const preTxnRefusal = noBookingRefusal(estimate);');
    expect(route).toContain('revalidateEstimate: noBookingRefusal,');
    // Only one copy of each refusal body — the locked verdict reuses it.
    expect((route.match(/commercialManualScheduling: true/g) || [])).toHaveLength(1);
    expect(route).toContain("if (svcErr.code === 'ESTIMATE_NO_BOOKING' && svcErr.response) {");
  });
});

// A stale in-grace commit must lose to the customer's newer reservation
// (codex r5 P2) — the same rule extendReservation applies. The window-scoped
// probes cannot see a non-overlapping rival on another date.
describe('commitReservation refuses a lapsed graduation behind a newer hold', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const commit = src.slice(src.indexOf('async function commitReservation'), src.indexOf('async function releaseReservation'));

  test('only a LAPSED graduation runs the rival check, and it answers RESERVATION_EXPIRED', () => {
    expect(commit).toContain('if (row._lapsed && row.source_estimate_id) {');
    const at = commit.indexOf('const rivalLiveHold');
    expect(at).toBeGreaterThan(-1);
    const block = commit.slice(at, at + 520);
    expect(block).toContain('.whereNot({ id: scheduledServiceId })');
    expect(block).toContain("andWhereRaw('reservation_expires_at > NOW()')");
    expect(commit.slice(at, at + 800)).toContain("err.code = 'RESERVATION_EXPIRED'");
  });
});

// The service ENFORCES the caller's verdict under the lock; it does not own
// the predicate (codex r6 P1) — that would put route-shaped policy and
// response bodies inside slot-reservation.
describe('extendReservation enforces the injected no-booking verdict under the lock', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function extendReservation'), src.indexOf('module.exports'));

  test('the hook runs on the LOCKED estimate row and throws ESTIMATE_NO_BOOKING', () => {
    expect(fn).toContain('revalidateEstimate = null');
    expect(fn).toContain('const refusal = await revalidateEstimate(estimate);');
    expect(fn).toContain("err.code = 'ESTIMATE_NO_BOOKING';");
    // After the FOR UPDATE read of the estimate, not before it.
    expect(fn.indexOf("const estimate = await trx('estimates')")).toBeLessThan(fn.indexOf('const refusal = await revalidateEstimate(estimate);'));
  });

  test('no route policy leaks into the service', () => {
    expect(fn).not.toContain('commercialManualScheduling');
    expect(fn).not.toContain('TRENCHING_REVIEW_409');
  });
});

// An estimate's OWN live hold must not remove its own window from the offer
// (codex r8 P1). Without the exclusion, a customer who reserved and reloaded
// saw that window as taken — the legacy page could report no times at all and
// leave a still-live reservation unconfirmable.
describe('availability excludes the estimate\'s own hold', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-slot-availability.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function filterCollidingSlots'), src.indexOf('async function filterCollidingSlots') + 3000);

  test('the collision query skips this estimate\'s uncommitted hold only', () => {
    expect(fn).toContain('ownEstimateId = null');
    expect(fn).toContain("own.where('scheduled_services.source_estimate_id', ownEstimateId)");
    // Conditionally chained, not .modify() — this module's unit doubles
    // implement a bare builder sequence.
    expect(fn).toContain('if (ownEstimateId) {');
    expect(fn).not.toContain('.modify((q) => {');
    // Narrow: a COMMITTED visit of the same estimate still blocks, and only a
    // caller-supplied id is excluded.
    const at = fn.indexOf('own.where(');
    expect(fn.slice(at, at + 260)).toContain(".whereNull('scheduled_services.customer_id')");
    expect(fn.slice(at, at + 260)).toContain(".whereNotNull('scheduled_services.reservation_expires_at')");
  });

  test('every production call site passes the estimate id', () => {
    const calls = src.match(/filterCollidingSlots\([^)]*ownEstimateId: estimateId \}/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// The suppression gate belongs in the locked recheck too (codex r8 P2).
describe('the locked recheck includes the suppression gate', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-slots-public.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/:token/reserve/:scheduledServiceId/extend'"));
  const pred = route.slice(route.indexOf('const noBookingRefusal'), route.indexOf('const preTxnRefusal'));

  test('a Bermuda-suppression reshape is refused with the same body', () => {
    expect(pred).toContain('estimateDataCarriesBermudaSuppression(row.estimate_data)');
    expect(pred).toContain("gateEnvValue('GATE_BERMUDA_SUPPRESSION')");
    expect(pred).toContain("code: 'BERMUDA_SUPPRESSION_GATED',");
  });
});

// Extending must run the SAME definitive validity checks the commit runs
// (codex r10 P2): occupancy alone left an unusable hold alive for up to an
// hour while telling the customer their time was kept, when the confirm was
// guaranteed to refuse it.
describe('extendReservation revalidates technician and blackout', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'slot-reservation.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function extendReservation'), src.indexOf('module.exports'));

  test('the held technician must still be assignable, with the commit error code', () => {
    expect(fn).toContain("await assertAssignableTechnician(row.technician_id, { conn: trx });");
    const at = fn.indexOf('assertAssignableTechnician');
    expect(fn.slice(at, at + 420)).toContain("err.code = 'SLOT_UNAVAILABLE';");
  });

  test('a blacked-out day refuses with the commit error code', () => {
    expect(fn).toContain("const { isBlackoutDate } = require('./scheduling/blackout-dates');");
    // Read through the held transaction (codex r11 P2).
    expect(fn).toContain('isBlackoutDate(row.scheduled_date, trx)');
    const at = fn.indexOf('isBlackoutDate(row.scheduled_date, trx)');
    expect(fn.slice(at, at + 260)).toContain("err.code = 'RESERVATION_EXPIRED';");
  });

  test('both run BEFORE the occupancy probe and the write', () => {
    expect(fn.indexOf('assertAssignableTechnician')).toBeLessThan(fn.indexOf('const clash = rowUnderCapacity'));
    expect(fn.indexOf('isBlackoutDate')).toBeLessThan(fn.indexOf('const clash = rowUnderCapacity'));
  });
});

// The blackout lookup runs through readOptional's savepoint (codex r12 P2).
// Threading a caller's transaction in made its documented fail-open
// behaviour dangerous: a failed query aborts that transaction, so returning
// false left the next statement to fail 25P02 — a failed accept/extend.
describe('isBlackoutDate is savepoint-isolated when given a transaction', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduling', 'blackout-dates.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function isBlackoutDate'), src.indexOf('// Closure-state advisory lock'));

  test('the optional read goes through readOptional, not the bare conn', () => {
    expect(fn).toContain("readOptional(conn, (dbh) => dbh('schedule_blackout_dates')");
    expect(fn).not.toMatch(/await conn\('schedule_blackout_dates'\)/);
    // Still fails open, and the weekly lookup shares the connection.
    expect(fn).toContain('return false;');
    expect(fn).toContain('getWeeklyDaysOff(conn)');
  });

  test('the default keeps every pre-existing caller on the pool connection', () => {
    expect(src).toContain('async function isBlackoutDate(dateVal, conn = db) {');
  });
});

// Capacity generation must exclude the requesting estimate's own hold too
// (codex r16 P1). The non-capacity collision query already did; under
// GATE_SCHEDULING_CAPACITY the route simulation returned before reaching it,
// so a tight route could omit the customer's still-valid held window — and
// the SSR page no longer adopts that hold, leaving nothing confirmable.
describe('capacity slot generation excludes the own hold', () => {
  const fs = require('fs');
  const path = require('path');
  const availability = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-slot-availability.js'), 'utf8');
  const findTime = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduling', 'find-time.js'), 'utf8');

  test('both findAvailableSlots call sites pass excludeEstimateId', () => {
    const calls = availability.match(/excludeEstimateId: estimateId,/g) || [];
    expect(calls).toHaveLength(2);
  });

  test('findCapacitySlots threads it into the route context', () => {
    const fn = findTime.slice(findTime.indexOf('async function findCapacitySlots'), findTime.indexOf('async function findCapacitySlots') + 3000);
    expect(fn).toContain('excludeEstimateId: opts.excludeEstimateId,');
    expect(fn.indexOf('excludeEstimateId: opts.excludeEstimateId,'))
      .toBeGreaterThan(fn.indexOf('loadArrivalRouteContext({'));
  });
});

// Legacy (non-capacity) route generation must also skip the requesting
// estimate's own holds (codex r17 P1). The collision filter already did, but
// generation treated them as occupied anchors, so a held 08:00/12:00 window —
// neither is a PREFERRED_WINDOWS slot — dropped out of both pools, and the V1
// page (which no longer adopts that hold) had no way to confirm it.
describe('legacy route generation excludes the own hold', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduling', 'find-time.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function findAvailableSlots'), src.indexOf('async function findCapacitySlots') > src.indexOf('async function findAvailableSlots')
    ? src.indexOf('async function findCapacitySlots')
    : src.length);

  test('own uncommitted holds join the exclude set before any filtering', () => {
    expect(fn).toContain('if (opts.excludeEstimateId) {');
    expect(fn).toContain("where({ source_estimate_id: opts.excludeEstimateId })");
    expect(fn).toContain('for (const row of ownHolds) excludeSet.add(String(row.id));');
    // Narrow: only UNCOMMITTED rows of that estimate.
    const at = fn.indexOf('const ownHolds');
    expect(fn.slice(at, at + 320)).toContain(".whereNull('customer_id')");
    expect(fn.slice(at, at + 320)).toContain(".whereNotNull('reservation_expires_at')");
    // One set, so dayStops and every other consumer honour it.
    expect(fn.indexOf('for (const row of ownHolds)')).toBeLessThan(fn.indexOf('const dayStops = services'));
  });
});
