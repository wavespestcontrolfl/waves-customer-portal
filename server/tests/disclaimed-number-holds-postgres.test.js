/**
 * disclaimed_number_holds on real PostgreSQL (codex round 7 P1, PR #4807).
 *
 * Proves the SQL semantics the unit suites only pin by shape:
 *   - the decision-point write (armDisclaimedNumberHold) re-arms a cleared
 *     row and waits on the per-call triage lock /resolve takes;
 *   - a Resolve (verified_same_number) that lands AFTER the decision is
 *     never undone by a later in-pass write (ensureDisclaimedNumberHold),
 *     and the send predicate keeps reading the number as clear;
 *   - a genuine later reprocess re-arms through the decision-point write.
 *
 * Runs only against an explicitly selected synthetic QA database
 * (DISCLAIMED_HOLDS_TEST_DATABASE_URL=postgres:///waves_qa_<hex>), in a
 * throwaway schema dropped afterwards.
 */
jest.mock('../models/db', () => {
  const conn = (...args) => mockPg(...args);
  conn.transaction = (...args) => mockPg.transaction(...args);
  conn.raw = (...args) => mockPg.raw(...args);
  return conn;
});
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260925000200_disclaimed_number_holds');
const { lockTriageCall } = require('../utils/triage-locks');
const Holds = require('../services/disclaimed-number-holds');

const connection = process.env.DISCLAIMED_HOLDS_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `disclaimed_holds_${randomUUID().replaceAll('-', '')}`;
let mockPg;
let admin;
jest.setTimeout(60000);

const PHONE = '+19415551234';
const row = (callLogId) => mockPg('disclaimed_number_holds').where({ phone_e164: PHONE, source_call_log_id: callLogId }).first();

postgres('disclaimed_number_holds on PostgreSQL', () => {
  beforeAll(async () => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Use an explicitly selected synthetic Waves QA database');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 6 } });
    await migration.up(mockPg);
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await admin.destroy();
    }
  });

  test('a Resolve landing between the decision write and a later in-pass write stands; a genuine reprocess re-arms', async () => {
    const callLogId = randomUUID();
    // Decision point: flag raised → row persisted, number blocked.
    await Holds.armDisclaimedNumberHold({ phone: '(941) 555-1234', callLogId });
    expect((await row(callLogId)).cleared_at).toBeNull();
    expect(await Holds.disclaimedNumberBlocksSend({ to: PHONE })).toBe(true);

    // The office resolves the already-filed card mid-pass (single /resolve).
    await mockPg.transaction(async (trx) => {
      await lockTriageCall(trx, callLogId);
      await Holds.clearDisclaimedNumberHoldsForCall({ callLogId, clearedBy: 'tech-1', reason: 'verified_same_number', conn: trx });
    });

    // Later writes in the SAME pass (post-customer-resolution, booking trx,
    // post-commit fallback): ensure-only — the clearance stands.
    const customerId = randomUUID();
    const ensured = await Holds.ensureDisclaimedNumberHold({ phone: PHONE, customerId, callLogId });
    expect(ensured).toEqual({ recorded: true, phoneE164: PHONE, active: false });
    await mockPg.transaction((trx) => Holds.ensureDisclaimedNumberHold({ phone: PHONE, customerId, callLogId, conn: trx }));
    const after = await row(callLogId);
    expect(after.cleared_at).not.toBeNull();
    expect(after.clear_reason).toBe('verified_same_number');
    expect(after.customer_id).toBe(customerId);
    expect(await Holds.disclaimedNumberBlocksSend({ to: PHONE })).toBe(false);

    // A genuine later reprocess raising the flag again re-arms — through the
    // serialized decision-point write only.
    await Holds.armDisclaimedNumberHold({ phone: PHONE, callLogId });
    const rearmed = await row(callLogId);
    expect(rearmed.cleared_at).toBeNull();
    expect(rearmed.clear_reason).toBeNull();
    expect(await Holds.disclaimedNumberBlocksSend({ to: PHONE })).toBe(true);
  });

  test('ensure on an ACTIVE row keeps it active and fills customer_id without erasing it later', async () => {
    const callLogId = randomUUID();
    const customerId = randomUUID();
    await Holds.armDisclaimedNumberHold({ phone: PHONE, callLogId });
    expect(await Holds.ensureDisclaimedNumberHold({ phone: PHONE, customerId, callLogId }))
      .toEqual({ recorded: true, phoneE164: PHONE, active: true });
    await Holds.ensureDisclaimedNumberHold({ phone: PHONE, customerId: null, callLogId });
    const r = await row(callLogId);
    expect(r.cleared_at).toBeNull();
    expect(r.customer_id).toBe(customerId);
  });

  test('the decision-point write waits for a /resolve holding the per-call triage lock', async () => {
    const callLogId = randomUUID();
    let releaseResolve;
    const resolveHolding = new Promise((resolve) => { releaseResolve = resolve; });
    let lockTaken;
    const lockHeld = new Promise((resolve) => { lockTaken = resolve; });
    const resolveTrx = mockPg.transaction(async (trx) => {
      await lockTriageCall(trx, callLogId);
      lockTaken();
      await resolveHolding;
    });
    await lockHeld;
    let armed = false;
    const arm = Holds.armDisclaimedNumberHold({ phone: PHONE, callLogId }).then(() => { armed = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(armed).toBe(false);
    expect(await row(callLogId)).toBeUndefined();
    releaseResolve();
    await resolveTrx;
    await arm;
    expect(armed).toBe(true);
    expect((await row(callLogId)).cleared_at).toBeNull();
  });
});
