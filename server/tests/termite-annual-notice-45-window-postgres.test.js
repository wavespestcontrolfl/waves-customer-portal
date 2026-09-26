/**
 * Real PostgreSQL: the termite annual-plan notice-obligation candidate
 * query (annual-prepay-renewals termiteNoticeObligationCandidates) covers
 * BOTH the 45-day and 30-day rungs in ONE pass (Codex #4921 r3 structural
 * fix). A rung is a candidate every day from when it opens until term_end
 * itself — not a bounded catch-up window and not an exact day — so a
 * missed cron day or a failed send is retried tomorrow, never dropped.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-notice-45-window-postgres.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_notice45_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`CREATE TABLE annual_prepay_terms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    term_start date NOT NULL,
    term_end date NOT NULL,
    status text NOT NULL,
    renewal_decision text,
    annual_plan_version text,
    notice_45_sent_at timestamptz,
    notice_45_claimed_at timestamptz,
    notice_45_late_sent_at timestamptz,
    notice_45_late_escalated_at timestamptz,
    notice_30_sent_at timestamptz,
    notice_30_claimed_at timestamptz,
    notice_30_late_sent_at timestamptz,
    notice_30_late_escalated_at timestamptz,
    notice_missed_escalated_at timestamptz,
    installation_anchored_at timestamptz,
    renewed_from_term_id uuid
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

describeOrSkip('termite annual-plan notice obligations — unified 45/30 candidate query (real Postgres)', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => {
    jest.resetModules();
    if (fixture) await fixture.destroy();
  });

  test('selects every unsent-rung termite term from the day its 45-day rung opens through term_end; never a non-termite, decided, cancelled, fully-sent, or freshly-claimed term, and never a term already at/past its own term_end', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const today = '2026-09-26';
    const plus = (n) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const term = (label, fields) => ({
      label, customer_id: randomUUID(), term_start: '2025-10-01', status: 'active', annual_plan_version: 'v3', ...fields,
    });
    const rows = [
      // Both rungs still open (45-day window, not yet in 30-day window).
      term('day46_neither_due', { term_end: plus(46) }),
      term('day45_45due', { term_end: plus(45) }),
      term('day40_45due', { term_end: plus(40) }),
      term('day31_45due', { term_end: plus(31) }),
      // Both rungs due at once (inside the 30-day window, 45 still unsent).
      term('day30_bothdue', { term_end: plus(30) }),
      term('day20_bothdue', { term_end: plus(20) }),
      term('day1_bothdue', { term_end: plus(1) }),
      // At/past term_end — the sending pass excludes it (missed-escalation
      // sweep owns this case instead).
      term('day0_excluded', { term_end: today }),
      term('pastDue_excluded', { term_end: plus(-5) }),
      // 45 already sent on time, only 30 due.
      term('only30due', { term_end: plus(25), notice_45_sent_at: new Date() }),
      // Non-termite, decided, cancelled — never candidates.
      term('nonTermite', { term_end: plus(20), annual_plan_version: null }),
      term('decided', { term_end: plus(20), renewal_decision: 'cancel' }),
      term('cancelled', { term_end: plus(20), status: 'cancelled' }),
      // Both rungs fully accounted for — never a candidate.
      term('bothSent', { term_end: plus(20), notice_45_sent_at: new Date(), notice_30_sent_at: new Date() }),
      term('bothLate', { term_end: plus(20), notice_45_late_sent_at: new Date(), notice_30_late_sent_at: new Date() }),
      // Freshly claimed 45 (within TTL) with 30 not yet due — not a
      // candidate; a stale 45 claim (past TTL) still is.
      term('freshClaim45', { term_end: plus(40), notice_45_claimed_at: new Date() }),
      term('staleClaim45', { term_end: plus(40), notice_45_claimed_at: new Date(Date.now() - 60 * 60 * 1000) }),
      term('renewalPending', { term_end: plus(35), status: 'renewal_pending' }),
    ];
    const ids = {};
    for (const { label, ...fields } of rows) {
      const [row] = await db('annual_prepay_terms').insert(fields).returning('id');
      ids[row.id] = label;
    }

    const candidates = await _private.termiteNoticeObligationCandidates({ today, conn: db });
    expect(candidates.map((row) => ids[row.id]).sort()).toEqual([
      'day1_bothdue',
      'day20_bothdue',
      'day30_bothdue',
      'day31_45due',
      'day40_45due',
      'day45_45due',
      'only30due',
      'renewalPending',
      'staleClaim45',
    ].sort());
  });

  test('termiteRungDue: true from the day a rung opens through term_end, false once sent/late, false past term_end', () => {
    const { _private } = require('../services/annual-prepay-renewals');
    const term = (fields) => ({ term_end: '2026-11-10', annual_plan_version: 'v3', ...fields });
    // 45-day rung: opens at today <= term_end-45.
    expect(_private.termiteRungDue(term({}), 45, '2026-09-26')).toBe(true); // 45 days out
    expect(_private.termiteRungDue(term({}), 45, '2026-09-20')).toBe(false); // 51 days out — not open yet
    expect(_private.termiteRungDue(term({}), 45, '2026-09-27')).toBe(true); // 44 days out (late window, still due)
    expect(_private.termiteRungDue(term({ notice_45_sent_at: new Date() }), 45, '2026-10-01')).toBe(false);
    expect(_private.termiteRungDue(term({ notice_45_late_sent_at: new Date() }), 45, '2026-10-01')).toBe(false);
    // 30-day rung.
    expect(_private.termiteRungDue(term({}), 30, '2026-10-11')).toBe(true); // 30 days out
    expect(_private.termiteRungDue(term({}), 30, '2026-10-05')).toBe(false); // 36 days out, not yet open
    expect(_private.termiteRungDue(term({ notice_30_sent_at: new Date() }), 30, '2026-11-01')).toBe(false);
  });

  // Codex #4921 r3: the durable-escalation retry point for EITHER late
  // rung, and only a term missing its OWN escalation for the rung that
  // actually went late.
  test('termiteLateNoticeEscalationCandidates: every term with a late-sent 45 or 30 rung missing ITS OWN escalation stamp, and only those', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const term = (label, fields) => ({
      label, customer_id: randomUUID(), term_start: '2025-10-01', term_end: '2026-11-15', status: 'active', annual_plan_version: 'v3', ...fields,
    });
    const rows = [
      term('late45Unescalated', { notice_45_late_sent_at: new Date() }),
      term('late45Escalated', { notice_45_late_sent_at: new Date(), notice_45_late_escalated_at: new Date() }),
      term('late30Unescalated', { notice_30_late_sent_at: new Date() }),
      term('late30Escalated', { notice_30_late_sent_at: new Date(), notice_30_late_escalated_at: new Date() }),
      term('bothLateBothUnescalated', { notice_45_late_sent_at: new Date(), notice_30_late_sent_at: new Date() }),
      term('onTimeSent', { notice_45_sent_at: new Date(), notice_30_sent_at: new Date() }),
      term('nonTermite', { notice_45_late_sent_at: new Date(), annual_plan_version: null }),
      term('neverSent', {}),
    ];
    const ids = {};
    for (const { label, ...fields } of rows) {
      const [row] = await db('annual_prepay_terms').insert(fields).returning('id');
      ids[row.id] = label;
    }

    const candidates = await _private.termiteLateNoticeEscalationCandidates({ conn: db });
    expect(candidates.map((row) => ids[row.id]).sort()).toEqual([
      'bothLateBothUnescalated',
      'late30Unescalated',
      'late45Unescalated',
    ].sort());
  });

  // Codex #4921 r3 finding #2, generalized: a term that reaches its OWN
  // term_end with a rung never delivered at all (neither on-time nor late)
  // is a candidate for the durable "notice obligation missed" escalation —
  // the safety net for a rung whose daily retry never landed in time.
  test('termiteMissedNoticeEscalationCandidates: only a past/at-term_end termite term with a rung never delivered and not yet escalated', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const today = '2026-09-26';
    const term = (label, fields) => ({
      label, customer_id: randomUUID(), term_start: '2025-09-26', status: 'renewal_pending', annual_plan_version: 'v3',
      installation_anchored_at: new Date('2025-09-26T12:00:00Z'), ...fields,
    });
    const rows = [
      // Original term still awaiting installation: provisional term_end only.
      term('pastDue_unanchoredOriginal', { term_end: '2026-09-01', installation_anchored_at: null }),
      // A renewal successor is anchored by construction.
      term('pastDue_successorNoAnchor', { term_end: '2026-09-01', installation_anchored_at: null, renewed_from_term_id: randomUUID() }),
      term('pastDue_missing45', { term_end: '2026-09-20', notice_30_sent_at: new Date() }),
      term('pastDue_missing30', { term_end: '2026-09-25', notice_45_sent_at: new Date() }),
      term('pastDue_missingBoth', { term_end: '2026-09-01' }),
      term('atTermEnd_missing30', { term_end: today, notice_45_late_sent_at: new Date() }),
      term('pastDue_fullyAccounted', { term_end: '2026-09-20', notice_45_sent_at: new Date(), notice_30_late_sent_at: new Date() }),
      term('pastDue_alreadyEscalated', { term_end: '2026-09-20', notice_missed_escalated_at: new Date() }),
      term('futureTerm_notYetDue', { term_end: '2026-10-30' }),
      term('nonTermite', { term_end: '2026-09-20', annual_plan_version: null }),
      term('decided', { term_end: '2026-09-20', renewal_decision: 'cancel' }),
    ];
    const ids = {};
    for (const { label, ...fields } of rows) {
      const [row] = await db('annual_prepay_terms').insert(fields).returning('id');
      ids[row.id] = label;
    }

    const candidates = await _private.termiteMissedNoticeEscalationCandidates({ today, conn: db });
    expect(candidates.map((row) => ids[row.id]).sort()).toEqual([
      'atTermEnd_missing30',
      'pastDue_missing30',
      'pastDue_missing45',
      'pastDue_missingBoth',
      'pastDue_successorNoAnchor',
    ].sort());
  });

  test('witness column: on time (>= threshold days out) stamps the rung\'s own sent_at; a late send stamps the rung\'s own late column', () => {
    jest.doMock('../models/db', () => fixture.db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const t = { term_end: '2026-11-10', annual_plan_version: 'v3' };
    expect(_private.noticeWitnessColumn(45, t, '2026-09-26')).toBe('notice_45_sent_at'); // 45 days
    expect(_private.noticeWitnessColumn(45, t, '2026-09-20')).toBe('notice_45_sent_at'); // 51 days
    expect(_private.noticeWitnessColumn(45, t, '2026-09-27')).toBe('notice_45_late_sent_at'); // 44 days
    expect(_private.noticeWitnessColumn(45, t, '2026-10-10')).toBe('notice_45_late_sent_at'); // 31 days
    expect(_private.noticeWitnessColumn(30, t, '2026-10-11')).toBe('notice_30_sent_at'); // 30 days
    expect(_private.noticeWitnessColumn(30, t, '2026-10-12')).toBe('notice_30_late_sent_at'); // 29 days
    // A non-termite term never reaches the late branch for 30 (no such term
    // is ever sent through this daysOut, but the helper itself must stay safe).
    expect(_private.noticeWitnessColumn(30, { term_end: '2026-11-10' }, '2026-10-12')).toBe('notice_30_sent_at');
  });
});

// Pre-push audit P1 on the r3 structural fix: termiteLateNoticeEscalationCandidates
// (and the readiness gate in checkAndSend) must be verified against a schema
// built by ACTUALLY RUNNING migrations 000101–000107, not a hand-made
// CREATE TABLE — a hand-made table can silently define a column no real
// migration adds (exactly how 000106 shipped without notice_30_late_escalated_at,
// which 000107 now adds). This describe block starts from a minimal
// PRE-000101 baseline (the columns 20260514000001_annual_prepay_terms.js +
// 20260924030001_termite_annual_plan_stamps.js already established before
// this ladder began — reproduced directly rather than run, since the base
// migration's customers/estimates/invoices/scheduled_services FKs are
// orthogonal to this bug and already covered elsewhere) and then requires +
// runs the REAL 000101–000107 migration files' up() in order.
describeOrSkip('termite annual-plan notice obligations — against a schema built by running migrations 000101–000107 (real Postgres)', () => {
  let fixture;

  async function createPre101Db() {
    const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
    const schema = `termite_notice_migrated_${randomUUID().replace(/-/g, '')}`;
    const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    // The pre-000101 baseline: 20260514000001 (base table + notice_30/15/7
    // sent/claimed) + 20260924030001 (annual_plan_version, notice_45_sent_at).
    await db.raw(`CREATE TABLE annual_prepay_terms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL,
      term_start date NOT NULL,
      term_end date NOT NULL,
      status text NOT NULL DEFAULT 'payment_pending',
      renewal_decision text,
      annual_plan_version text,
      notice_45_sent_at timestamptz,
      notice_30_sent_at timestamptz,
      notice_30_claimed_at timestamptz,
      notice_15_sent_at timestamptz,
      notice_15_claimed_at timestamptz,
      notice_7_sent_at timestamptz,
      notice_7_claimed_at timestamptz,
      -- pre-101 columns from earlier termite migrations (20260924030001 stamps,
      -- 20260925000006 install anchor) the candidate queries read
      renewed_from_term_id uuid,
      installation_anchored_at timestamptz,
      prepay_invoice_id uuid,
      last_scheduled_service_date date,
      updated_at timestamptz
    )`);
    // activatePaidPendingTerms (checkAndSend's first step) joins invoices.
    await db.raw(`CREATE TABLE invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text,
      paid_at timestamptz
    )`);
    return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
  }

  beforeEach(async () => { jest.resetModules(); fixture = await createPre101Db(); });
  afterEach(async () => { jest.resetModules(); if (fixture) await fixture.destroy(); });

  const MIGRATION_FILES_101_TO_107 = [
    '20260926000101_termite_annual_notice_45_claim_column',
    '20260926000102_termite_annual_renewal_notice_sms_template',
    '20260926000103_termite_annual_renewal_reminder_email_template',
    '20260926000104_termite_annual_notice_45_late_column',
    '20260926000105_termite_annual_notice_45_late_escalated_column',
    '20260926000106_termite_annual_notice_30_late_and_missed_columns',
    '20260926000107_termite_annual_notice_30_late_escalated_column',
  ];

  test('running 000101 through 000107 in order adds every column the termite pass and its readiness gate query, with no hand-made shortcuts', async () => {
    const { db } = fixture;
    for (const file of MIGRATION_FILES_101_TO_107) {
      await require(`../models/migrations/${file}`).up(db);
    }
    const cols = await db('annual_prepay_terms').columnInfo();
    for (const col of ['notice_45_claimed_at', 'notice_45_late_sent_at', 'notice_45_late_escalated_at',
      'notice_30_late_sent_at', 'notice_missed_escalated_at', 'notice_30_late_escalated_at']) {
      expect(cols[col]).toBeTruthy();
    }
  });

  test('termiteLateNoticeEscalationCandidates and termiteMissedNoticeEscalationCandidates run without a "column does not exist" error against the fully-migrated schema, and select the right rows', async () => {
    const { db } = fixture;
    for (const file of [
      '20260926000101_termite_annual_notice_45_claim_column',
      '20260926000104_termite_annual_notice_45_late_column',
      '20260926000105_termite_annual_notice_45_late_escalated_column',
      '20260926000106_termite_annual_notice_30_late_and_missed_columns',
      '20260926000107_termite_annual_notice_30_late_escalated_column',
    ]) {
      await require(`../models/migrations/${file}`).up(db);
    }

    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');

    const term = (label, fields) => ({
      label, customer_id: randomUUID(), term_start: '2025-10-01', term_end: '2026-11-15', status: 'active', annual_plan_version: 'v3', ...fields,
    });
    const rows = [
      term('late30Unescalated', { notice_30_late_sent_at: new Date() }),
      term('late30Escalated', { notice_30_late_sent_at: new Date(), notice_30_late_escalated_at: new Date() }),
      term('late45Unescalated', { notice_45_late_sent_at: new Date() }),
    ];
    const ids = {};
    for (const { label, ...fields } of rows) {
      const [row] = await db('annual_prepay_terms').insert(fields).returning('id');
      ids[row.id] = label;
    }

    // Before 000107 this threw "column notice_30_late_escalated_at does not
    // exist" (uncaught in checkAndSend, taking the generic loop down with
    // it) — proven here by simply not throwing, plus correct selection.
    const lateCandidates = await _private.termiteLateNoticeEscalationCandidates({ conn: db });
    expect(lateCandidates.map((row) => ids[row.id]).sort()).toEqual(['late30Unescalated', 'late45Unescalated'].sort());

    const missedCandidates = await _private.termiteMissedNoticeEscalationCandidates({ today: '2026-09-26', conn: db });
    expect(missedCandidates).toEqual([]); // term_end is in the future for every row above
  });

  test('a database that ran only through 000106 (pre-000107) — checkAndSend\'s readiness gate skips the ENTIRE termite pass instead of throwing, and the generic 30/15/7 loop still runs', async () => {
    const { db } = fixture;
    for (const file of [
      '20260926000101_termite_annual_notice_45_claim_column',
      '20260926000104_termite_annual_notice_45_late_column',
      '20260926000105_termite_annual_notice_45_late_escalated_column',
      '20260926000106_termite_annual_notice_30_late_and_missed_columns',
      // Deliberately NOT running 000107 — the exact mid-rollout gap the
      // pre-push audit found.
    ]) {
      await require(`../models/migrations/${file}`).up(db);
    }

    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(), classifyDeliveryCertainty: jest.fn() }));
    jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
    jest.doMock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn(), sendTermiteRenewalReminder: jest.fn() }));
    jest.doMock('../services/cancellation-resolution', () => ({ cancelFlowV2Enabled: jest.fn(() => true) }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

    // A termite term whose 45-day rung is due — if the readiness gate were
    // wrong (only checking the main candidate query's columns, as before
    // this fix), checkAndSend would throw inside the termite pass and never
    // reach the generic loop below at all.
    await db('annual_prepay_terms').insert({
      customer_id: randomUUID(), term_start: '2025-10-01', term_end: '2026-11-10',
      status: 'active', annual_plan_version: 'v3',
    });

    const sql = [];
    db.on('query', (q) => sql.push(q.sql));
    await expect(AnnualPrepayRenewals.checkAndSend({ today: '2026-09-26' })).resolves.toEqual({ sent: 0 });
    // Not a false green: the generic 30/15/7 loop really queried this
    // (live) schema — the 30-day rung's query carries the termite exclusion.
    expect(sql.some((q) => /notice_30_sent_at/.test(q) && /"annual_plan_version" is null/.test(q))).toBe(true);
    expect(sql.some((q) => /notice_7_sent_at/.test(q))).toBe(true);
    // …and the termite pass was skipped by the readiness gate, never run.
    expect(sql.some((q) => /notice_30_late_escalated_at/.test(q))).toBe(false);
  });
});
