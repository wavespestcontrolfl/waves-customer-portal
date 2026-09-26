/**
 * Real PostgreSQL: slice 3b ("abandoned signature") — the two new
 * reconcileTermiteAnnualActivations passes that close out a termite
 * annual-plan estimate whose customer never signs:
 *   - remindExpiredSignatureLinks: a one-time staff nudge per lapsed signing
 *     link, re-firing after a resend later lapses again.
 *   - expireAbandonedSignatures: the hard 45-day close — flips the estimate
 *     terminal, retires every unsigned agreement (share link burned), and
 *     rings one bell. A concurrent signature always wins.
 *
 * Driven through reconcileTermiteAnnualActivations against a scratch schema
 * built by the real 20260925000001..000007 + 20260925030001 migrations, so
 * the jsonb estimate-id join, the share_token_expires_at comparisons, the
 * parkedAt-or-accepted_at fallback, and the row locks all run as real SQL.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to a local throwaway
 * database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-signature-expiry-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

jest.setTimeout(30000);

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const ABANDON_DAYS = 45;
const MIGRATIONS = [
  '20260925000001_termite_annual_sign_before_pay',
  '20260925000002_termite_annual_deferred_invoice_snapshot',
  '20260925000003_termite_annual_invoice_delivery_attempt',
  '20260925000004_termite_annual_activation_attempt',
  '20260925000005_termite_annual_signature_charge',
  '20260925000006_termite_annual_install_anchor',
  '20260925000007_termite_annual_anchor_attempt',
  '20260925030001_termite_annual_countersignature_columns',
];

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_sig_expiry_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 6 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // accepted_at is the parkedAt fallback (parkedAtForEstimate) — real column,
  // not part of the slice-3a migrations (predates them).
  await db.raw(`CREATE TABLE estimates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    property_id uuid,
    accepted_at timestamptz
  )`);
  await db.raw('CREATE TABLE customer_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL)');
  await db.raw(`CREATE TABLE invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    status text,
    sent_at timestamptz,
    sms_sent_at timestamptz,
    email_sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw('CREATE TABLE customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz)');
  await db.raw('CREATE TABLE technicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  // share_token_hash/expires_at + cancelled_at/reason + created_at/updated_at:
  // real customer_contracts columns this slice reads/writes, not part of the
  // slice-3a migrations (predate them — 20260511000002_contract_signing_workflow).
  await db.raw(`CREATE TABLE customer_contracts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    document_template_key text,
    status text,
    share_token_hash text,
    share_token_expires_at timestamptz,
    signed_at timestamptz,
    signed_name text,
    cancelled_at timestamptz,
    cancelled_reason text,
    document_variables_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw(`CREATE TABLE customer_contract_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id uuid NOT NULL REFERENCES customer_contracts(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL,
    event_type varchar(60) NOT NULL,
    actor_type varchar(30) NOT NULL DEFAULT 'system',
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.raw('CREATE TABLE payment_method_consents (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  await db.raw(`CREATE TABLE scheduled_services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid,
    source_estimate_id uuid,
    annual_prepay_term_id uuid,
    property_id uuid,
    status text,
    service_type text,
    scheduled_date date
  )`);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    source_estimate_id uuid,
    prepay_invoice_id uuid,
    plan_label text,
    term_start date NOT NULL,
    term_end date NOT NULL,
    status text NOT NULL,
    renewal_decision text,
    renewed_from_term_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const name of MIGRATIONS) {
    await require(`../models/migrations/${name}`).up(db);
  }
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termite annual signature expiry (slice 3b) — real Postgres', () => {
  let fixture;

  beforeEach(async () => {
    fixture = await createScratchDb();
  });

  afterEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    if (fixture) await fixture.destroy();
  });

  function load({ notifyAdminImpl } = {}) {
    const { db } = fixture;
    const notifyAdmin = jest.fn(notifyAdminImpl || (async () => ({ id: randomUUID(), deduped: false })));
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ createTermForAnnualPrepay: jest.fn(), refreshTermSnapshot: jest.fn() }));
    const { reconcileTermiteAnnualActivations, ANNUAL_SIGNATURE_ABANDON_DAYS } = require('../services/termite-annual-activation');
    return {
      sweep: (opts = {}) => reconcileTermiteAnnualActivations({ conn: db, ...opts }),
      notifyAdmin,
      db,
      ANNUAL_SIGNATURE_ABANDON_DAYS,
    };
  }

  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function makeParkedEstimate(db, {
    customerId = null, acceptedAt = daysAgo(1), parkedAt = acceptedAt, parkedAtRaw, archived = false,
  } = {}) {
    // A real customers row: the nudge only reaches customers the Requests
    // page can show (non-archived).
    const resolvedCustomerId = customerId
      || (await db('customers').insert({ deleted_at: archived ? new Date() : null }).returning('id'))[0].id;
    const [estimate] = await db('estimates').insert({
      customer_id: resolvedCustomerId,
      accepted_at: acceptedAt,
      annual_plan_activation_status: 'awaiting_signature',
      annual_plan_deferred_invoice: JSON.stringify({
        version: 1,
        parkedAt: parkedAtRaw !== undefined ? parkedAtRaw : parkedAt.toISOString(),
        frozenFinancials: { total: 449 },
      }),
    }).returning('*');
    return { estimateId: estimate.id, customerId: resolvedCustomerId };
  }

  async function makeAgreement(db, {
    estimateId, customerId, status = 'sent', shareTokenExpiresAt = daysAgo(31), createdAt = new Date(),
  }) {
    // Default: the signing link lapsed long ago (the 14-day link of an
    // offer parked 45+ days). A LIVE link defers the close-out — tests for
    // that pass a future expiry, or `null` (a hash with no window is live).
    const [contract] = await db('customer_contracts').insert({
      customer_id: customerId,
      document_template_key: ANNUAL_TEMPLATE_KEY,
      status,
      share_token_hash: status === 'signed' ? null : 'a-token-hash',
      share_token_expires_at: shareTokenExpiresAt,
      document_variables_snapshot: JSON.stringify({ estimate: { id: estimateId } }),
      created_at: createdAt,
    }).returning('*');
    return contract;
  }

  const reminderDedupeKeys = (notifyAdmin) => notifyAdmin.mock.calls
    .filter(([, title]) => /signing link expired/i.test(title))
    .map(([, , , opts]) => opts?.dedupeKey);
  const closedBellCalls = (notifyAdmin) => notifyAdmin.mock.calls.filter(([, title]) => /offer closed/i.test(title));

  // ---- nudge --------------------------------------------------------
  describe('remindExpiredSignatureLinks', () => {
    test('rings one bell for a parked estimate whose signing link lapsed, and never again on a re-sweep', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(1) });

      const first = await sweep();
      expect(first).toMatchObject({ signatureNudgeScanned: 1, signatureNudged: 1 });
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(1);
      const firstKey = reminderDedupeKeys(notifyAdmin)[0];

      expect(firstKey).toContain(new Date(daysAgo(1)).toISOString().slice(0, 10));
      // customerId rides in metadata so NotificationService can silence
      // internal-test customers' bells.
      const nudgeCall = notifyAdmin.mock.calls.find(([, title]) => /signing link expired/i.test(title));
      expect(nudgeCall[3].metadata).toMatchObject({ customerId });

      notifyAdmin.mockClear();
      const second = await sweep();
      // Same contract, same lapse: the recorded nudge event excludes it
      // before LIMIT, so it is not even a candidate any more.
      expect(second.signatureNudgeScanned).toBe(0);
      expect(reminderDedupeKeys(notifyAdmin)).toEqual([]);
      const nudgeEvents = await db('customer_contract_events').where({ event_type: 'signature_link_expired_nudged' });
      expect(nudgeEvents).toHaveLength(1);
    });

    test('a SUPPRESSED nudge (internal-test customer) is still marked, so it never crowds real lapses out of the batch', async () => {
      const { sweep, notifyAdmin, db } = load({ notifyAdminImpl: async () => ({ id: null, suppressed: true }) });
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(1) });

      const first = await sweep();
      expect(first).toMatchObject({ signatureNudgeScanned: 1, signatureNudged: 0 });
      notifyAdmin.mockClear();
      const second = await sweep();
      expect(second.signatureNudgeScanned).toBe(0);
      expect(reminderDedupeKeys(notifyAdmin)).toEqual([]);
    });

    test('never nudges an offer already past its 45-day window — it closes in this same run (Codex #4922 r3)', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1) });
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(1) });

      const counts = await sweep();
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(0);
      expect(counts.signatureExpired).toBe(1);
    });

    test('never nudges while the signing link is still valid', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(-1) }); // future

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(0);
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(0);
    });

    test('a staff resend that mints a NEW expiry gets its own dedupe key once IT later lapses', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db);
      const contract = await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(5) });

      await sweep();
      const firstKey = reminderDedupeKeys(notifyAdmin)[0];
      expect(firstKey).toContain(String(contract.id));

      // Staff resends AFTER that nudge (the nudge event predates the new
      // link), and the new link has since lapsed too: a fresh lapse.
      notifyAdmin.mockClear();
      await db('customer_contract_events').where({ contract_id: contract.id }).update({ created_at: daysAgo(4) });
      await db('customer_contracts').where({ id: contract.id }).update({ share_token_expires_at: daysAgo(1) });
      await sweep();
      const secondKey = reminderDedupeKeys(notifyAdmin)[0];
      expect(secondKey).toContain(String(contract.id));
      expect(secondKey).not.toBe(firstKey);
    });

    test('never nudges for a superseded (older) agreement once a newer one exists for the same estimate', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, {
        estimateId, customerId, shareTokenExpiresAt: daysAgo(10), createdAt: daysAgo(12),
      });
      await makeAgreement(db, {
        estimateId, customerId, shareTokenExpiresAt: daysAgo(1), createdAt: daysAgo(2),
      });

      const counts = await sweep();
      // Only the newer agreement's own lapse is nudge-worthy.
      expect(counts.signatureNudgeScanned).toBe(1);
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(1);
    });

    test('never nudges a signed or cancelled agreement', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, {
        estimateId, customerId, status: 'signed', shareTokenExpiresAt: daysAgo(1),
      });
      const { estimateId: est2, customerId: cust2 } = await makeParkedEstimate(db);
      await makeAgreement(db, {
        estimateId: est2, customerId: cust2, status: 'cancelled', shareTokenExpiresAt: daysAgo(1),
      });

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(0);
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(0);
    });
  });

  // ---- hard expiry ----------------------------------------------------
  describe('expireAbandonedSignatures', () => {
    test('not yet 45 days parked: stays awaiting_signature, nothing retired, no bell', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(44) });
      const contract = await makeAgreement(db, { estimateId, customerId });

      const counts = await sweep();
      expect(counts).toMatchObject({ signatureExpireScanned: 0, signatureExpired: 0 });
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
      expect((await db('customer_contracts').where({ id: contract.id }).first()).status).toBe('sent');
      expect(closedBellCalls(notifyAdmin)).toHaveLength(0);
    });

    test('a staff-reissued link that is still live defers the close-out until it lapses (Codex #4922 r2 P0)', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1) });
      const contract = await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) });

      const counts = await sweep();
      // Not even a candidate while the link is live — it can't crowd the batch.
      expect(counts).toMatchObject({ signatureExpireScanned: 0, signatureExpired: 0 });
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
      const still = await db('customer_contracts').where({ id: contract.id }).first();
      expect(still.status).toBe('sent');
      expect(still.share_token_hash).toBe('a-token-hash');
      expect(closedBellCalls(notifyAdmin)).toHaveLength(0);

      // The link lapses → the next sweep closes the offer.
      await db('customer_contracts').where({ id: contract.id }).update({ share_token_expires_at: daysAgo(1) });
      expect((await sweep()).signatureExpired).toBe(1);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('signature_expired');
    });

    test('a hash with NO expiry is a live link (served indefinitely) and also defers the close-out', async () => {
      const { sweep, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1) });
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: null });

      expect((await sweep()).signatureExpired).toBe(0);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
    });

    test('the locked re-check also refuses a live link (a resend that lands between scan and lock)', async () => {
      const { db } = load();
      const { expireAbandonedSignature } = require('../services/termite-annual-activation')._private;
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1) });
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) });

      await expect(expireAbandonedSignature({ estimateId, conn: db })).resolves.toEqual({ skipped: 'live_signing_link' });
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
    });

    test('exactly past the 45-day park: flips terminal, retires the unsigned agreement (share link burned), records an event, bells once', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1) });
      const contract = await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(30) });

      const counts = await sweep();
      expect(counts).toMatchObject({ signatureExpireScanned: 1, signatureExpired: 1 });
      const estimate = await db('estimates').where({ id: estimateId }).first();
      expect(estimate.annual_plan_activation_status).toBe('signature_expired');

      const retired = await db('customer_contracts').where({ id: contract.id }).first();
      expect(retired.status).toBe('cancelled');
      expect(retired.share_token_hash).toBeNull();
      expect(retired.share_token_expires_at).toBeNull();
      expect(retired.cancelled_reason).toMatch(/45 days/);

      const events = await db('customer_contract_events').where({ contract_id: contract.id, event_type: 'cancelled' });
      expect(events).toHaveLength(1);
      expect(events[0].metadata.reason).toBe('annual_plan_signature_expired');

      expect(closedBellCalls(notifyAdmin)).toHaveLength(1);
      expect(closedBellCalls(notifyAdmin)[0][3]).toMatchObject({ dedupeKey: `termite-annual-signature-expiry:${estimateId}`, metadata: { customerId } });

      // Idempotent: a second sweep finds nothing left to expire (guarded by
      // the status no longer being 'awaiting_signature').
      notifyAdmin.mockClear();
      const again = await sweep();
      expect(again.signatureExpireScanned).toBe(0);
      expect(closedBellCalls(notifyAdmin)).toHaveLength(0);
    });

    test('a SIGNED contract is never retired, and never expires the estimate — the customer wins', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 5) });
      const signed = await makeAgreement(db, { estimateId, customerId, status: 'signed' });

      const counts = await sweep();
      expect(counts.signatureExpired).toBe(0);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
      expect((await db('customer_contracts').where({ id: signed.id }).first()).status).toBe('signed');
      expect(closedBellCalls(notifyAdmin)).toHaveLength(0);
    });

    test('a concurrent signature that already activated the estimate is a clean no-op — no retire, no bell', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 5) });
      // The activation transaction won the race and already flipped the
      // estimate to 'activated' (and would have signed the contract) before
      // this sweep's candidate scan even ran.
      await db('estimates').where({ id: estimateId }).update({ annual_plan_activation_status: 'activated' });
      const signed = await makeAgreement(db, { estimateId, customerId, status: 'signed' });

      const counts = await sweep();
      expect(counts.signatureExpireScanned).toBe(0);
      expect(counts.signatureExpired).toBe(0);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('activated');
      expect((await db('customer_contracts').where({ id: signed.id }).first()).status).toBe('signed');
      expect(closedBellCalls(notifyAdmin)).toHaveLength(0);
    });

    test('falls back to accepted_at when the deferred-invoice snapshot has no parkedAt', async () => {
      const { sweep, db } = load();
      const [estimate] = await db('estimates').insert({
        customer_id: randomUUID(),
        accepted_at: daysAgo(ABANDON_DAYS + 1),
        annual_plan_activation_status: 'awaiting_signature',
        annual_plan_deferred_invoice: JSON.stringify({ version: 1, frozenFinancials: { total: 449 } }), // no parkedAt
      }).returning('*');

      const counts = await sweep();
      expect(counts.signatureExpired).toBe(1);
      expect((await db('estimates').where({ id: estimate.id }).first()).annual_plan_activation_status).toBe('signature_expired');
    });

    test('retires MULTIPLE open agreements for the same estimate (e.g. a superseded draft beside the live one)', async () => {
      const { sweep, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1) });
      const older = await makeAgreement(db, {
        estimateId, customerId, status: 'expired', shareTokenExpiresAt: daysAgo(40), createdAt: daysAgo(44),
      });
      const newer = await makeAgreement(db, {
        estimateId, customerId, status: 'sent', shareTokenExpiresAt: daysAgo(20), createdAt: daysAgo(30),
      });

      await sweep();

      for (const id of [older.id, newer.id]) {
        const row = await db('customer_contracts').where({ id }).first();
        expect(row.status).toBe('cancelled');
        expect(row.share_token_hash).toBeNull();
      }
    });
  });

  // ---- primary review hardening ----------------------------------------
  describe('hardening', () => {
    test('an archived customer\'s lapsed link is never nudged (the Requests page hides it)', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { archived: true });
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(1) });

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(0);
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(0);
    });

    test('a malformed parkedAt falls back to accepted_at instead of failing the whole scan', async () => {
      const { sweep, db } = load();
      const garbage = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 3), parkedAtRaw: 'yesterday' });
      await makeAgreement(db, { estimateId: garbage.estimateId, customerId: garbage.customerId });
      const fresh = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 1), parkedAtRaw: '2026-13-45 nonsense' });
      await makeAgreement(db, { estimateId: fresh.estimateId, customerId: fresh.customerId });

      const counts = await sweep();
      expect(counts.signatureExpireScanError).toBeUndefined();
      expect(counts.signatureExpired).toBe(2);
    });

    test('an estimate locked by an in-flight activation is skipped (never waited on), then closes on a later sweep', async () => {
      const { sweep, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 2) });
      await makeAgreement(db, { estimateId, customerId });

      // Hold the estimate row lock the way activation does, on another connection.
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let locked;
      const lockTaken = new Promise((resolve) => { locked = resolve; });
      const holder = db.transaction(async (trx) => {
        await trx('estimates').where({ id: estimateId }).forUpdate().first('id');
        locked();
        await held;
      });
      await lockTaken;

      const during = await sweep();
      expect(during.signatureExpired).toBe(0);
      expect(during.signatureExpireFailed).toBe(0);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');

      release();
      await holder;
      const after = await sweep();
      expect(after.signatureExpired).toBe(1);
    });

    test('a close-out that failed before rotates behind never-attempted rows', async () => {
      const { sweep, db } = load();
      const older = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 9) });
      await makeAgreement(db, { estimateId: older.estimateId, customerId: older.customerId });
      const newer = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 2) });
      await makeAgreement(db, { estimateId: newer.estimateId, customerId: newer.customerId });
      // The older row's last automated attempt failed (stamped by the pass).
      await db('estimates').where({ id: older.estimateId }).update({ annual_plan_activation_attempted_at: daysAgo(1) });

      const counts = await sweep({ limit: 1 });
      expect(counts.signatureExpired).toBe(1);
      expect((await db('estimates').where({ id: newer.estimateId }).first()).annual_plan_activation_status).toBe('signature_expired');
      expect((await db('estimates').where({ id: older.estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
    });
  });

  // ---- verification sweep 2026-09-26: edge cases not yet proven ----------
  describe('additional edge cases', () => {
    test('nudges a contract the document-lifecycle cron already flipped to literal status "expired"', async () => {
      // expireDocumentRequests (the 6:10am document-lifecycle cron, runs
      // before this sweep) flips a lapsed contract's own `status` column to
      // literal 'expired' — the nudge query only excludes signed/cancelled/
      // voided, so this status must still be nudge-worthy.
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, {
        estimateId, customerId, status: 'expired', shareTokenExpiresAt: daysAgo(1),
      });

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(1);
      expect(reminderDedupeKeys(notifyAdmin)).toHaveLength(1);
    });

    test('a deduped notifyAdmin result is scanned but never counted as nudged', async () => {
      const { sweep, db } = load({ notifyAdminImpl: async () => ({ id: randomUUID(), deduped: true }) });
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(1) });

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(1);
      expect(counts.signatureNudged).toBe(0);
    });

    test('a suppressed notifyAdmin result is scanned but never counted as nudged', async () => {
      const { sweep, db } = load({ notifyAdminImpl: async () => ({ suppressed: true }) });
      const { estimateId, customerId } = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(1) });

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(1);
      expect(counts.signatureNudged).toBe(0);
    });

    test('one candidate\'s notifyAdmin throwing does not stop the rest of the nudge batch', async () => {
      const failEstimateId = { current: null };
      const notifyAdminImpl = jest.fn(async (type, title, body, opts) => {
        if (opts?.metadata?.estimateId === failEstimateId.current) throw new Error('notifyAdmin boom');
        return { id: randomUUID(), deduped: false };
      });
      const { sweep, db } = load({ notifyAdminImpl });
      const bad = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId: bad.estimateId, customerId: bad.customerId, shareTokenExpiresAt: daysAgo(1) });
      failEstimateId.current = bad.estimateId;
      const good = await makeParkedEstimate(db);
      await makeAgreement(db, { estimateId: good.estimateId, customerId: good.customerId, shareTokenExpiresAt: daysAgo(2) });

      const counts = await sweep();
      expect(counts.signatureNudgeScanned).toBe(2);
      expect(counts.signatureNudged).toBe(1);
    });

    test('a parkedAt with a non-Z timezone offset is still parsed and expires on schedule', async () => {
      const { sweep, db } = load();
      const target = daysAgo(ABANDON_DAYS + 1);
      // Same instant as `target`, rendered with an explicit -04:00 offset
      // rather than Z (isoParkedAt's regex must accept both forms).
      const localWallClock = new Date(target.getTime() - 4 * 60 * 60 * 1000);
      const offsetIso = `${localWallClock.toISOString().replace('Z', '')}-04:00`;
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(1), parkedAtRaw: offsetIso });
      await makeAgreement(db, { estimateId, customerId });

      const counts = await sweep();
      expect(counts.signatureExpired).toBe(1);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('signature_expired');
    });

    test('a parkedAt in the future is never treated as abandoned, even with an old accepted_at fallback value on the row', async () => {
      const { sweep, db } = load();
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      // accepted_at is 100 days old — if the code ever fell back to it
      // despite parkedAt being present, this would wrongly expire.
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(100), parkedAtRaw: future.toISOString() });
      await makeAgreement(db, { estimateId, customerId });

      const counts = await sweep();
      expect(counts.signatureExpireScanned).toBe(0);
      expect(counts.signatureExpired).toBe(0);
      expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');
    });

    test('a contract with no customer_id falls back to the estimate customer_id for the retirement event', async () => {
      // customer_contracts.customer_id is NOT NULL in the real schema
      // (20260511000002_contract_signing_workflow) — this scratch schema
      // relaxes it to nullable, so this proves the `row.customer_id ||
      // estimate.customer_id` fallback itself is correct if that ever
      // changed, without asserting the (currently unreachable) prod case.
      const { sweep, db } = load();
      const [customer] = await db('customers').insert({}).returning('*');
      const [estimate] = await db('estimates').insert({
        customer_id: customer.id,
        accepted_at: daysAgo(ABANDON_DAYS + 1),
        annual_plan_activation_status: 'awaiting_signature',
        annual_plan_deferred_invoice: JSON.stringify({ version: 1, parkedAt: daysAgo(ABANDON_DAYS + 1).toISOString() }),
      }).returning('*');
      const [contract] = await db('customer_contracts').insert({
        customer_id: null,
        document_template_key: ANNUAL_TEMPLATE_KEY,
        status: 'sent',
        share_token_hash: 'a-token-hash',
        share_token_expires_at: daysAgo(31), // lapsed — a live link would defer the close-out
        document_variables_snapshot: JSON.stringify({ estimate: { id: estimate.id } }),
      }).returning('*');

      const counts = await sweep();
      expect(counts.signatureExpired).toBe(1);
      const events = await db('customer_contract_events').where({ contract_id: contract.id });
      expect(events).toHaveLength(1);
      expect(events[0].customer_id).toBe(customer.id);
    });

    test('DOCUMENTED (unreachable in prod): a contract AND estimate both missing customer_id fail the close-out closed, never half-committed', async () => {
      // Real schema guarantees customer_contracts.customer_id NOT NULL, so
      // this is not reachable in production — but it proves the code fails
      // CLOSED (rolls the whole transaction back — the estimate stays
      // 'awaiting_signature', nothing cancelled) rather than crashing the
      // sweep or leaving a half-retired agreement, if that invariant were
      // ever violated by a future migration or data-repair script.
      const { sweep, db } = load();
      const [estimate] = await db('estimates').insert({
        customer_id: null,
        accepted_at: daysAgo(ABANDON_DAYS + 1),
        annual_plan_activation_status: 'awaiting_signature',
        annual_plan_deferred_invoice: JSON.stringify({ version: 1, parkedAt: daysAgo(ABANDON_DAYS + 1).toISOString() }),
      }).returning('*');
      const [contract] = await db('customer_contracts').insert({
        customer_id: null,
        document_template_key: ANNUAL_TEMPLATE_KEY,
        status: 'sent',
        share_token_hash: 'a-token-hash',
        share_token_expires_at: daysAgo(31), // lapsed — a live link would defer the close-out
        document_variables_snapshot: JSON.stringify({ estimate: { id: estimate.id } }),
      }).returning('*');

      const counts = await sweep();
      expect(counts.signatureExpireFailed).toBe(1);
      expect((await db('estimates').where({ id: estimate.id }).first()).annual_plan_activation_status).toBe('awaiting_signature');
      expect((await db('customer_contracts').where({ id: contract.id }).first()).status).toBe('sent');
      expect(await db('customer_contract_events').where({ contract_id: contract.id }).whereNot({ event_type: 'signature_link_expired_nudged' })).toHaveLength(0);
    });
  });

  describe('close-out bell is atomic with the state change', () => {
    test('the closed-offer bell is written on the close-out transaction', async () => {
      const { sweep, notifyAdmin, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 2) });
      await makeAgreement(db, { estimateId, customerId });

      expect((await sweep()).signatureExpired).toBe(1);
      const [, , , opts] = closedBellCalls(notifyAdmin)[0];
      expect(typeof opts.trx).toBe('function');
      expect(opts).toMatchObject({ bell: true, dedupeKey: `termite-annual-signature-expiry:${estimateId}` });
    });

    test('a bell that fails to persist rolls the close-out back — still parked, agreement untouched, retried later', async () => {
      const { sweep, db } = load({
        notifyAdminImpl: async (category, title) => {
          if (/offer closed/i.test(title)) throw new Error('admin notification insert failed');
          return { id: randomUUID(), deduped: false };
        },
      });
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 2) });
      const contract = await makeAgreement(db, { estimateId, customerId });

      const counts = await sweep();
      expect(counts).toMatchObject({ signatureExpired: 0, signatureExpireFailed: 1 });
      const estimate = await db('estimates').where({ id: estimateId }).first();
      expect(estimate.annual_plan_activation_status).toBe('awaiting_signature');
      expect(estimate.annual_plan_activation_attempted_at).toBeInstanceOf(Date);
      const stillOpen = await db('customer_contracts').where({ id: contract.id }).first();
      expect(stillOpen.status).toBe('sent');
      expect(stillOpen.share_token_hash).toBe('a-token-hash');
      expect(await db('customer_contract_events').where({ contract_id: contract.id }).whereNot({ event_type: 'signature_link_expired_nudged' })).toHaveLength(0);
    });
  });

  describe('parkedAt validation never throws a sweep', () => {
    test('the ISO pattern only accepts strings PostgreSQL casts to timestamptz', async () => {
      const { db } = load();
      const { _private: { CASTABLE_ISO_INSTANT } } = require('../services/termite-annual-activation');
      const cases = [
        ['2026-09-26T13:45:07.123Z', true],
        ['2026-09-26T09:45:07-04:00', true],
        ['2026-09-26T09:45:07.123456+0530', true],
        ['2026-01-31T00:00:00Z', true],
        ['2026-02-28T23:59:59Z', true],
        ['2026-13-01T00:00:00Z', false],
        ['2026-02-30T00:00:00Z', false],
        ['2026-04-31T00:00:00Z', false],
        ['2026-02-29T00:00:00Z', false],
        ['2026-09-26T24:00:00Z', false],
        ['2026-09-26T12:60:00Z', false],
        ['2026-09-26T12:00:00+15:00', false],
        ['0000-01-01T00:00:00Z', false],
        ['2026-09-26', false],
        ['yesterday', false],
        ['', false],
      ];
      for (const [value, expected] of cases) {
        const { rows: [{ matches }] } = await db.raw('SELECT ? ~ ? AS matches', [value, CASTABLE_ISO_INSTANT]);
        expect([value, matches]).toEqual([value, expected]);
        // Everything the pattern accepts must cast without throwing.
        if (matches) await expect(db.raw('SELECT ?::timestamptz AS t', [value])).resolves.toBeTruthy();
      }
    });

    test('an ISO-SHAPED impossible parkedAt ("2026-13-01T00:00:00Z") falls back to accepted_at instead of failing the scan', async () => {
      const { sweep, db } = load();
      const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 2), parkedAtRaw: '2026-13-01T00:00:00Z' });
      await makeAgreement(db, { estimateId, customerId });
      const counts = await sweep();
      expect(counts.signatureExpireScanError).toBeUndefined();
      expect(counts.signatureExpired).toBe(1);
    });
  });

  test('a backlog larger than the limit reaches every lapsed link: already-nudged ones leave the batch', async () => {
    const { sweep, notifyAdmin, db } = load();
    const contracts = [];
    for (const lapsedDaysAgo of [3, 2, 1]) {
      const { estimateId, customerId } = await makeParkedEstimate(db);
      contracts.push(await makeAgreement(db, { estimateId, customerId, shareTokenExpiresAt: daysAgo(lapsedDaysAgo) }));
    }
    await sweep({ limit: 1 });
    await sweep({ limit: 1 });
    await sweep({ limit: 1 });
    const nudgedContracts = reminderDedupeKeys(notifyAdmin).map((key) => key.split(':')[1]);
    expect(new Set(nudgedContracts)).toEqual(new Set(contracts.map((c) => String(c.id))));
  });

  test('the close-out waits on agreement issuance\'s per-customer lock, so a reissue in flight finishes first', async () => {
    const { sweep, db } = load();
    const { estimateId, customerId } = await makeParkedEstimate(db, { acceptedAt: daysAgo(ABANDON_DAYS + 2) });
    await makeAgreement(db, { estimateId, customerId });

    // Hold the lock maybeCreateTermiteProgramAgreement takes while it drafts.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let locked;
    const lockTaken = new Promise((resolve) => { locked = resolve; });
    const issuance = db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`termite-agreement:${customerId}`]);
      locked();
      await held;
    });
    await lockTaken;

    let settled = false;
    const sweeping = sweep().then((counts) => { settled = true; return counts; });
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    expect(settled).toBe(false);
    expect((await db('estimates').where({ id: estimateId }).first()).annual_plan_activation_status).toBe('awaiting_signature');

    release();
    await issuance;
    const counts = await sweeping;
    expect(counts.signatureExpired).toBe(1);
  });
});
