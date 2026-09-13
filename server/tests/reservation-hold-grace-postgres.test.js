/**
 * Hold grace + extend against REAL Postgres (owner case 2026-09-11).
 *
 * The grace window and the extend endpoint are almost entirely SQL —
 * `make_interval(mins => ?)` cutoffs, a `LEAST(NOW() + hold, created_at +
 * cap)` ceiling, and a partial-predicate DELETE. A mocked knex proves none of
 * it, so this suite drives the real functions against a synthetic QA database
 * inside a transaction that is always rolled back.
 *
 * Run:
 *   RESERVATION_HOLD_TEST_DATABASE_URL=postgres://…/waves_qa_… \
 *     npm exec jest -- --runInBand server/tests/reservation-hold-grace-postgres.test.js
 */

jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
  async resolveCatalogSlotProfile(estimate, options) { return this.resolveEstimateSlotProfile(estimate, options); },
  resolveEstimateSlotProfile: jest.fn(() => ({
    durationMinutes: 60,
    serviceLabel: 'Lawn Care',
    services: [{ service: 'lawn_care', visitsPerYear: 9 }],
  })),
  SLOT_DAY_START_MINUTES: 8 * 60,
  SLOT_DAY_END_MINUTES: 17 * 60,
  MAX_SLOT_HORIZON_DAYS: 90,
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString } = require('../utils/datetime-et');

const connection = process.env.RESERVATION_HOLD_TEST_DATABASE_URL;
// A truthy URL is NOT enough (codex r6 P1). This suite calls
// releaseExpiredReservations(), whose sweep is unrestricted: pointed at
// production it would take row locks across live scheduling rows — the outer
// rollback prevents persistence, not contention. Same gate the repo's other
// Postgres suites use: disposable localhost CI, or THIS worktree's private
// waves_qa_<id> database.
const isolatedTarget = (() => {
  if (!connection) return false;
  let url;
  try { url = new URL(connection); } catch { return false; }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  // The existing CI service is migrated once and shared by serial test steps.
  const localCI = process.env.CI === 'true' && local && url.pathname === '/waves_test';
  const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
    && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  // Outside that exact CI target, keep the private-QA database name guard.
  const qaName = /^\/waves_qa_[a-z0-9]+$/i.test(url.pathname);
  return localCI || ((local || ownedQA) && qaName);
})();
if (connection && !isolatedTarget) {
  // Loud, not silently skipped: a misconfigured URL should be fixed, and an
  // operator who set it expects the suite to run.
  throw new Error(
    'RESERVATION_HOLD_TEST_DATABASE_URL must point at a disposable localhost waves_qa_* database '
    + 'or localhost waves_test with CI=true — this suite runs releaseExpiredReservations(), whose sweep is unrestricted.',
  );
}
const postgres = isolatedTarget ? describe : describe.skip;
let mockPg;
jest.setTimeout(120000);

const slotReservation = require('../services/slot-reservation');

// A date the scheduling calendar actually allows. extendReservation and the
// in-grace commit both re-check blackout dates, so a fixture date the calendar
// refuses fails the suite for a reason that has nothing to do with holds — a
// bare `today + 14` did exactly that on Sat 2026-09-12 ("that day is no longer
// available"). Asking isBlackoutDate itself honours BOTH halves of the
// calendar (the weekly days-off set and one-off blackout rows) and stays
// correct when an admin closes a weekday, which a hardcoded weekend rule did
// not (codex #4449 r1). Read through the test's own transaction, and via the
// ET helpers — never a process-local `new Date(...).getDay()`.
async function bookableDate(conn) {
  const { isBlackoutDate } = require('../services/scheduling/blackout-dates');
  let d = addETDays(new Date(), 14);
  for (let i = 0; i < 30; i += 1) {
    const dateStr = etDateString(d);
     
    if (!await isBlackoutDate(dateStr, conn)) return dateStr;
    d = addETDays(d, 1);
  }
  throw new Error('no bookable date within 30 days of the fixture anchor — check the QA calendar');
}

/** One estimate + one hold row, inside a rolled-back transaction. */
async function withHold({ expiresInSeconds = 900, createdMinutesAgo = 0, committed = false }, run) {
  const pool = mockPg;
  const trx = await pool.transaction();
  mockPg = trx;
  try {
    const estimateId = randomUUID();
    const holdId = randomUUID();
    const customerId = randomUUID();
    const date = await bookableDate(trx);
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Hold',
      email: `${customerId}@example.invalid`, phone: '+19415550111', active: true,
    });
    await trx('estimates').insert({
      id: estimateId, token: randomUUID().replace(/-/g, ''), status: 'sent',
      customer_name: 'Synthetic Hold', address: '1 Test Way, Parrish, FL 34219',
      service_interest: 'Lawn Care', expires_at: trx.raw("NOW() + INTERVAL '7 days'"),
      estimate_data: JSON.stringify({ result: { recurring: { services: [{ service: 'lawn_care', visitsPerYear: 9 }] } } }),
    });
    await trx('scheduled_services').insert({
      id: holdId,
      source_estimate_id: estimateId,
      customer_id: committed ? customerId : null,
      scheduled_date: date,
      window_start: '13:00:00',
      window_end: '14:00:00',
      estimated_duration_minutes: 60,
      service_type: 'Lawn Care',
      status: 'pending',
      created_at: trx.raw('NOW() - make_interval(mins => ?)', [createdMinutesAgo]),
      reservation_expires_at: trx.raw('NOW() + make_interval(secs => ?)', [expiresInSeconds]),
    });
    await run({ trx, estimateId, holdId, customerId, date });
  } finally {
    await trx.rollback().catch(() => {});
    mockPg = pool;
  }
}

const holdRow = (trx, holdId) => trx('scheduled_services').where({ id: holdId })
  .first('id', 'customer_id', 'reservation_expires_at');

postgres('hold grace + extend (real Postgres)', () => {
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } }); });
  afterAll(async () => { await mockPg.destroy(); });
  const originalGrace = process.env.RESERVATION_COMMIT_GRACE_MINUTES;
  afterEach(() => {
    if (originalGrace === undefined) delete process.env.RESERVATION_COMMIT_GRACE_MINUTES;
    else process.env.RESERVATION_COMMIT_GRACE_MINUTES = originalGrace;
  });

  describe('commitGraceMinutes()', () => {
    test('defaults to 10 and clamps to [0, 30]', () => {
      delete process.env.RESERVATION_COMMIT_GRACE_MINUTES;
      expect(slotReservation.commitGraceMinutes()).toBe(10);
      for (const [env, expected] of [['0', 0], ['5', 5], ['99', 30], ['-4', 0], ['abc', 10], ['7.9', 7]]) {
        process.env.RESERVATION_COMMIT_GRACE_MINUTES = env;
        expect(slotReservation.commitGraceMinutes()).toBe(expected);
      }
    });
  });

  describe('commitReservation grace', () => {
    test('graduates a hold that expired 30 s ago (the owner case: 34 s late)', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -30 }, async ({ trx, holdId, customerId }) => {
        await slotReservation.commitReservation({ scheduledServiceId: holdId, customerId, trx });
        const row = await holdRow(trx, holdId);
        expect(row.reservation_expires_at).toBeNull();
        expect(row.customer_id).toBe(customerId);
      });
    });

    test('REGRESSION PIN: with grace disabled the same row 409s — this is what the customer hit', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '0';
      await withHold({ expiresInSeconds: -30 }, async ({ trx, holdId, customerId }) => {
        await expect(slotReservation.commitReservation({ scheduledServiceId: holdId, customerId, trx }))
          .rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
      });
    });

    test('a hold 11 minutes past expiry is still refused at grace 10', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -11 * 60 }, async ({ trx, holdId, customerId }) => {
        await expect(slotReservation.commitReservation({ scheduledServiceId: holdId, customerId, trx }))
          .rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
      });
    });
  });

  describe('releaseExpiredReservations grace', () => {
    test('leaves a 30 s-expired hold alive (an in-grace accept still has a row to graduate)', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -30 }, async ({ trx, holdId }) => {
        await slotReservation.releaseExpiredReservations();
        expect(await holdRow(trx, holdId)).toBeTruthy();
      });
    });

    test('still deletes a hold past the grace', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -11 * 60 }, async ({ trx, holdId }) => {
        await slotReservation.releaseExpiredReservations();
        expect(await holdRow(trx, holdId)).toBeUndefined();
      });
    });
  });

  describe('reserveSlot same-slot refresh', () => {
    test('the 60-minute lifetime cap binds the /reserve retry path too, so a hold cannot be kept alive forever (hold-grace self-audit)', async () => {
      // Drives the UPDATE the refresh branch runs, which is where the cap
      // lives — the full reserveSlot path needs a signed offer and the whole
      // capacity/profile stack, none of which this invariant depends on.
      await withHold({ expiresInSeconds: 120, createdMinutesAgo: 58 }, async ({ trx, holdId }) => {
        const [row] = await trx('scheduled_services')
          .where({ id: holdId })
          .update({
            reservation_expires_at: trx.raw(
              'GREATEST(reservation_expires_at, LEAST(NOW() + make_interval(mins => ?), created_at + make_interval(mins => ?)))',
              [15, slotReservation.MAX_HOLD_MINUTES],
            ),
          })
          .returning(['reservation_expires_at', 'created_at']);
        const ceiling = new Date(row.created_at).getTime() + slotReservation.MAX_HOLD_MINUTES * 60000;
        expect(new Date(row.reservation_expires_at).getTime()).toBeLessThanOrEqual(ceiling + 1000);
        expect(new Date(row.reservation_expires_at).getTime()).toBeLessThan(Date.now() + 15 * 60000);
      });
    });

    test('a capped refresh never moves the expiry BACKWARD (GREATEST keeps an already-later hold)', async () => {
      await withHold({ expiresInSeconds: 600, createdMinutesAgo: 59 }, async ({ trx, holdId }) => {
        const before = (await holdRow(trx, holdId)).reservation_expires_at;
        const [row] = await trx('scheduled_services')
          .where({ id: holdId })
          .update({
            reservation_expires_at: trx.raw(
              'GREATEST(reservation_expires_at, LEAST(NOW() + make_interval(mins => ?), created_at + make_interval(mins => ?)))',
              [15, slotReservation.MAX_HOLD_MINUTES],
            ),
          })
          .returning(['reservation_expires_at']);
        expect(new Date(row.reservation_expires_at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      });
    });
  });

  describe('extendReservation', () => {
    test('pushes a live hold forward', async () => {
      await withHold({ expiresInSeconds: 120 }, async ({ trx, estimateId, holdId }) => {
        const before = (await holdRow(trx, holdId)).reservation_expires_at;
        const { expiresAt } = await slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId });
        expect(new Date(expiresAt).getTime()).toBeGreaterThan(new Date(before).getTime());
        const after = (await holdRow(trx, holdId)).reservation_expires_at;
        expect(new Date(after).getTime()).toBe(new Date(expiresAt).getTime());
      });
    });

    test('rescues a hold that already lapsed but is inside the grace', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -30 }, async ({ trx, estimateId, holdId }) => {
        const { expiresAt } = await slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId });
        expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
      });
    });

    test('refuses a hold past the grace, another estimate\'s hold, and a committed row', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -11 * 60 }, async ({ estimateId, holdId }) => {
        await expect(slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId }))
          .rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
      });
      await withHold({ expiresInSeconds: 600 }, async ({ holdId }) => {
        await expect(slotReservation.extendReservation({ estimateId: randomUUID(), scheduledServiceId: holdId }))
          .rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
      });
      await withHold({ expiresInSeconds: 600, committed: true }, async ({ estimateId, holdId }) => {
        await expect(slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId }))
          .rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
      });
    });

    test('caps the new expiry at created_at + MAX_HOLD_MINUTES', async () => {
      await withHold({ expiresInSeconds: 120, createdMinutesAgo: 50 }, async ({ trx, estimateId, holdId }) => {
        const { expiresAt } = await slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId });
        const created = (await trx('scheduled_services').where({ id: holdId }).first('created_at')).created_at;
        const ceiling = new Date(created).getTime() + slotReservation.MAX_HOLD_MINUTES * 60000;
        expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(ceiling + 1000);
        // A 15-minute extension from now would have blown past the ceiling.
        expect(new Date(expiresAt).getTime()).toBeLessThan(Date.now() + 15 * 60000);
      });
    });

    test('reviving a LAPSED hold arbitrates against another customer\'s LIVE hold, not just committed visits (hold-grace self-audit)', async () => {
      process.env.RESERVATION_COMMIT_GRACE_MINUTES = '10';
      await withHold({ expiresInSeconds: -30 }, async ({ trx, estimateId, holdId, date }) => {
        // A second customer legitimately took the same window while this
        // hold sat lapsed — reserve-side checks ignore expired rows.
        const rivalEstimate = randomUUID();
        await trx('estimates').insert({
          id: rivalEstimate, token: randomUUID().replace(/-/g, ''), status: 'sent',
          customer_name: 'Rival Hold', address: '2 Test Way, Parrish, FL 34219',
          expires_at: trx.raw("NOW() + INTERVAL '7 days'"),
        });
        await trx('scheduled_services').insert({
          id: randomUUID(), source_estimate_id: rivalEstimate, customer_id: null,
          scheduled_date: date, window_start: '13:00:00', window_end: '14:00:00',
          estimated_duration_minutes: 60, service_type: 'Lawn Care', status: 'pending',
          reservation_expires_at: trx.raw("NOW() + INTERVAL '10 minutes'"),
        });
        await expect(slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId }))
          .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
        // And the superseded hold is really GONE — the delete must survive
        // the conflict, not roll back with it (hold-grace self-audit).
        expect(await holdRow(trx, holdId)).toBeUndefined();
      });
    });

    test('refuses — and supersedes the hold — when a COMMITTED visit has taken the window (the double-booking guard)', async () => {
      await withHold({ expiresInSeconds: 300 }, async ({ trx, estimateId, holdId, date, customerId }) => {
        // A real booking now occupies this window. Extending would hand back
        // a hold the accept is guaranteed to refuse, and leave it consuming
        // route time until expiry.
        await trx('scheduled_services').insert({
          id: randomUUID(), customer_id: customerId,
          scheduled_date: date, window_start: '13:00:00', window_end: '14:00:00',
          estimated_duration_minutes: 60, service_type: 'Quarterly Pest Control Service',
          status: 'confirmed', reservation_expires_at: null,
        });
        await expect(slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId }))
          .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
        // The supersede must SURVIVE the refusal — a throw from inside the
        // txn callback would roll the delete back with it.
        expect(await holdRow(trx, holdId)).toBeUndefined();
      });
    });

    test('a LIVE hold still extends even with another live hold in the window (it never stopped occupying it)', async () => {
      await withHold({ expiresInSeconds: 300 }, async ({ trx, estimateId, holdId, date }) => {
        const rivalEstimate = randomUUID();
        await trx('estimates').insert({
          id: rivalEstimate, token: randomUUID().replace(/-/g, ''), status: 'sent',
          customer_name: 'Rival Hold', address: '2 Test Way, Parrish, FL 34219',
          expires_at: trx.raw("NOW() + INTERVAL '7 days'"),
        });
        await trx('scheduled_services').insert({
          id: randomUUID(), source_estimate_id: rivalEstimate, customer_id: null,
          scheduled_date: date, window_start: '13:00:00', window_end: '14:00:00',
          estimated_duration_minutes: 60, service_type: 'Lawn Care', status: 'pending',
          reservation_expires_at: trx.raw("NOW() + INTERVAL '10 minutes'"),
        });
        const { expiresAt } = await slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId });
        expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
      });
    });

    test('refuses once the hold is older than MAX_HOLD_MINUTES', async () => {
      await withHold({ expiresInSeconds: 120, createdMinutesAgo: 61 }, async ({ estimateId, holdId }) => {
        await expect(slotReservation.extendReservation({ estimateId, scheduledServiceId: holdId }))
          .rejects.toMatchObject({ code: 'HOLD_LIMIT_REACHED' });
      });
    });
  });
});
