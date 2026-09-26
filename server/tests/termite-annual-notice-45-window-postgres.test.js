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

// Refuses anything but a LOCAL throwaway test database — every scratch
// helper in this file must go through it.
function localTestDatabaseUrl() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  return url;
}

async function createScratchDb() {
  const url = localTestDatabaseUrl();
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
    notice_45_undelivered_escalated_at timestamptz,
    notice_30_undelivered_escalated_at timestamptz,
    installation_anchored_at timestamptz,
    renewed_from_term_id uuid
  )`);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

// Real-PG scratch schemas + migration runs: slow under machine load.
jest.setTimeout(60000);

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

  // Codex #4921 r4 P1: a rung still undelivered after its OWN deadline
  // (today > term_end - 45 / term_end - 30) is a candidate for one staff
  // bell per rung — not only once term_end arrives.
  test('termiteUndeliveredNoticeEscalationCandidates: a termite term the first day a rung is past its deadline and undelivered; never on the deadline day, once delivered/late, once that rung is bell-stamped, at/after term_end, or for an unanchored original', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const today = '2026-09-26';
    const plus = (n) => _private.addDaysYmd(today, n);
    const term = (label, fields) => ({
      label, customer_id: randomUUID(), term_start: '2025-10-01', status: 'renewal_pending', annual_plan_version: 'v3',
      installation_anchored_at: new Date('2025-10-01T12:00:00Z'), ...fields,
    });
    const rows = [
      term('day45_onDeadline', { term_end: plus(45) }),
      term('day44_45undelivered', { term_end: plus(44) }),
      term('day44_45late', { term_end: plus(44), notice_45_late_sent_at: new Date() }),
      term('day44_45alreadyBelled', { term_end: plus(44), notice_45_undelivered_escalated_at: new Date() }),
      term('day30_onlyRung45', { term_end: plus(30), notice_30_sent_at: null }),
      term('day29_30undelivered', { term_end: plus(29), notice_45_sent_at: new Date() }),
      term('day29_30belled', { term_end: plus(29), notice_45_sent_at: new Date(), notice_30_undelivered_escalated_at: new Date() }),
      term('day29_bothBelled45only', { term_end: plus(29), notice_45_undelivered_escalated_at: new Date() }),
      term('day29_bothDelivered', { term_end: plus(29), notice_45_sent_at: new Date(), notice_30_late_sent_at: new Date() }),
      term('atTermEnd', { term_end: today }),
      term('unanchoredOriginal', { term_end: plus(20), installation_anchored_at: null }),
      term('successor', { term_end: plus(20), installation_anchored_at: null, renewed_from_term_id: randomUUID() }),
      term('nonTermite', { term_end: plus(20), annual_plan_version: null }),
      term('decided', { term_end: plus(20), renewal_decision: 'cancel' }),
    ];
    const ids = {};
    for (const { label, ...fields } of rows) {
      const [row] = await db('annual_prepay_terms').insert(fields).returning('*');
      ids[row.id] = label;
    }

    const candidates = await _private.termiteUndeliveredNoticeEscalationCandidates({ today, conn: db });
    expect(candidates.map((row) => ids[row.id]).sort()).toEqual([
      'day29_30undelivered',
      'day29_bothBelled45only',
      'day30_onlyRung45',
      'day44_45undelivered',
      'successor',
    ].sort());
    const rungsByLabel = Object.fromEntries(candidates.map((row) => [ids[row.id], _private.termiteUndeliveredRungs(row, today)]));
    expect(rungsByLabel).toEqual({
      day29_30undelivered: [30],
      day29_bothBelled45only: [30],
      day30_onlyRung45: [45],
      day44_45undelivered: [45],
      successor: [45, 30],
    });
  });

  // Codex #4921 pre-push P1: the persisted-acceptance probes, against real
  // Postgres jsonb/regex semantics. Only a provider-ACCEPTED termite SMS for
  // THIS customer+term+rung counts (a real Twilio SID, no blocked_code, a
  // sent_at); the email probe reads the exact idempotency key the sender
  // uses, and only an accepted status counts.
  test('priorTermiteSmsAcceptance / findAcceptedTermiteRenewalReminder: earliest accepted send for this term+rung only', async () => {
    const { db } = fixture;
    await db.raw(`CREATE TABLE messaging_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid, channel text, provider text, blocked_code text,
      provider_message_id text, sent_at timestamptz, metadata jsonb
    )`);
    await db.raw(`CREATE TABLE email_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key text UNIQUE, status text, sent_at timestamptz, payload_snapshot jsonb DEFAULT '{}'
    )`);
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { _private } = require('../services/annual-prepay-renewals');
    const AccountMembershipEmail = require('../services/account-membership-email');

    const customerId = randomUUID();
    const termId = randomUUID();
    const sid = (c) => `SM${c.repeat(32)}`;
    const meta = (fields) => ({ original_message_type: 'termite_annual_renewal_notice', annual_prepay_term_id: termId, days_out: 45, ...fields });
    const row = (fields) => ({ customer_id: customerId, channel: 'sms', provider: 'twilio', blocked_code: null, ...fields, metadata: JSON.stringify(fields.metadata || meta({})) });
    const t = (iso) => new Date(iso);
    await db('messaging_audit_log').insert([
      // Not evidence: owner kill switch, uncertain (no SID), blocked, other rung, other term, other type, other customer.
      row({ provider_message_id: 'owner-silence', sent_at: t('2026-09-20T12:00:00Z') }),
      row({ provider_message_id: null, sent_at: t('2026-09-20T12:00:00Z') }),
      row({ provider_message_id: sid('b'), sent_at: t('2026-09-20T12:00:00Z'), blocked_code: 'QUIET_HOURS' }),
      row({ provider_message_id: sid('c'), sent_at: t('2026-09-20T12:00:00Z'), metadata: meta({ days_out: 30 }) }),
      row({ provider_message_id: sid('d'), sent_at: t('2026-09-20T12:00:00Z'), metadata: meta({ annual_prepay_term_id: randomUUID() }) }),
      row({ provider_message_id: sid('e'), sent_at: t('2026-09-20T12:00:00Z'), metadata: meta({ original_message_type: 'annual_prepay_renewal_reminder' }) }),
      { ...row({ provider_message_id: sid('f'), sent_at: t('2026-09-20T12:00:00Z') }), customer_id: randomUUID() },
      // Evidence: two accepted sends — the EARLIEST wins.
      row({ provider_message_id: sid('1'), sent_at: t('2026-09-27T12:00:00Z') }),
      row({ provider_message_id: sid('2'), sent_at: t('2026-09-26T12:00:00Z') }),
    ]);
    const term = { id: termId, customer_id: customerId, term_end: '2026-11-10' };
    await expect(_private.priorTermiteSmsAcceptance(term, 45)).resolves.toEqual({ at: t('2026-09-26T12:00:00Z'), coversRungs: [] });
    await expect(_private.priorTermiteSmsAcceptance(term, 30)).resolves.toEqual({ at: t('2026-09-20T12:00:00Z'), coversRungs: [] });
    await expect(_private.priorTermiteSmsAcceptance({ ...term, id: randomUUID() }, 45)).resolves.toBeNull();

    const key = (daysOut) => `membership.termite_renewal_reminder:${termId}:${daysOut}:2026-11-10`;
    await db('email_messages').insert([
      { idempotency_key: key(45), status: 'delivered', sent_at: t('2026-09-26T13:00:00Z') },
      { idempotency_key: key(30), status: 'failed', sent_at: null },
    ]);
    const lookup = (daysOut) => AccountMembershipEmail.findAcceptedTermiteRenewalReminder({
      customerId, termId, daysOut, renewalDate: '2026-11-10',
    });
    await expect(lookup(45)).resolves.toEqual({ sentAt: t('2026-09-26T13:00:00Z'), coversRungs: [] });
    await expect(lookup(30)).resolves.toBeNull();
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
    const url = localTestDatabaseUrl();
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

  // Codex #4921 r4 P1, end to end on a schema built by the REAL 000101–000108
  // migrations: a 45-day rung whose send keeps failing rings ONE staff bell
  // the first day it is past its deadline (not only at term_end), stamps
  // notice_45_undelivered_escalated_at only on a confirmed insert, retries a
  // failed insert on the next sweep, and never rings twice. The send itself
  // fails here because the customer's contact rows are unavailable — any
  // failure mode (SMS+email down, a propagated lookup error) leaves the rung
  // undelivered the same way.
  test('checkAndSend: an undelivered 45-day rung past its deadline rings one confirmed, deduped staff bell; a failed bell insert retries next sweep', async () => {
    const { db } = fixture;
    for (const file of [...MIGRATION_FILES_101_TO_107, '20260926000108_termite_annual_notice_undelivered_escalated_columns']) {
      await require(`../models/migrations/${file}`).up(db);
    }
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(), classifyDeliveryCertainty: jest.fn() }));
    jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
    jest.doMock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn(), sendTermiteRenewalReminder: jest.fn(), findAcceptedTermiteRenewalReminder: jest.fn(async () => null) }));
    jest.doMock('../services/cancellation-resolution', () => ({ cancelFlowV2Enabled: jest.fn(() => true) }));
    const notifyAdmin = jest.fn();
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

    const [term] = await db('annual_prepay_terms').insert({
      customer_id: randomUUID(), term_start: '2025-11-09', term_end: '2026-11-09', // 44 days after 2026-09-26
      status: 'active', annual_plan_version: 'v3', installation_anchored_at: new Date('2025-11-09T12:00:00Z'),
    }).returning('*');

    // Sweep 1: the send fails and the bell insert fails (notifyAdmin null).
    notifyAdmin.mockResolvedValue(null);
    await expect(AnnualPrepayRenewals.checkAndSend({ today: '2026-09-26' })).resolves.toEqual({ sent: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const undeliveredBells = () => notifyAdmin.mock.calls.filter((c) => c[1] === 'Termite annual renewal notice not delivered');
    expect(undeliveredBells()).toHaveLength(1);
    expect(undeliveredBells()[0][3]).toMatchObject({ bell: true, dedupeKey: `termite-annual-notice:${term.id}:45:undelivered` });
    let row = await db('annual_prepay_terms').where({ id: term.id }).first();
    expect(row.notice_45_undelivered_escalated_at).toBeNull(); // unconfirmed → not stamped
    expect(row.notice_45_sent_at).toBeNull();
    expect(row.notice_45_late_sent_at).toBeNull();

    // Sweep 2: the bell insert is confirmed → stamped.
    notifyAdmin.mockResolvedValue({ id: 'notif-1' });
    await AnnualPrepayRenewals.checkAndSend({ today: '2026-09-26' });
    expect(undeliveredBells()).toHaveLength(2);
    row = await db('annual_prepay_terms').where({ id: term.id }).first();
    expect(row.notice_45_undelivered_escalated_at).toBeInstanceOf(Date);
    expect(row.notice_45_late_escalated_at).toBeNull(); // "not sent" never conflated with "sent late"

    // Sweep 3 (next day): still undelivered, but the 45 bell never rings again;
    // the 30 rung is not past its own deadline yet.
    await AnnualPrepayRenewals.checkAndSend({ today: '2026-09-27' });
    expect(undeliveredBells()).toHaveLength(2);
    row = await db('annual_prepay_terms').where({ id: term.id }).first();
    expect(row.notice_30_undelivered_escalated_at).toBeNull();
  });

  // Codex #4921 pre-push P1 (class fix), real SQL: the combined send's late
  // record for the OTHER rung never lands on top of that rung's on-time
  // witness, and every pass consults persisted acceptance evidence before
  // deciding a witness or ringing "not delivered".
  function mockSendSide() {
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(), classifyDeliveryCertainty: jest.fn() }));
    jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
    jest.doMock('../services/account-membership-email', () => ({
      sendMembershipRenewalReminder: jest.fn(), sendTermiteRenewalReminder: jest.fn(), findAcceptedTermiteRenewalReminder: jest.fn(async () => null),
    }));
    jest.doMock('../services/cancellation-resolution', () => ({ cancelFlowV2Enabled: jest.fn(() => true) }));
    const notifyAdmin = jest.fn().mockResolvedValue({ id: 'n' });
    jest.doMock('../services/notification-service', () => ({ notifyAdmin }));
    return notifyAdmin;
  }
  async function migrateThrough108(db) {
    for (const file of [...MIGRATION_FILES_101_TO_107, '20260926000108_termite_annual_notice_undelivered_escalated_columns']) {
      await require(`../models/migrations/${file}`).up(db);
    }
  }
  const lateBells = (notifyAdmin, daysOut) => notifyAdmin.mock.calls
    .filter((c) => c[1] === 'Termite annual renewal notice went out late' && c[3]?.metadata?.days_out === daysOut);

  test('stampTermNoticeWitness (combined): the other rung is recorded late ONLY when it has no record at all — never on top of its on-time witness', async () => {
    const { db } = fixture;
    await migrateThrough108(db);
    jest.doMock('../models/db', () => db);
    const notifyAdmin = mockSendSide();
    const { _private } = require('../services/annual-prepay-renewals');
    const base = {
      customer_id: randomUUID(), term_start: '2025-11-10', term_end: '2026-11-10', status: 'renewal_pending',
      annual_plan_version: 'v3', installation_anchored_at: new Date('2025-11-10T12:00:00Z'),
    };
    const onTime45 = new Date('2026-09-26T16:00:00Z');
    const [withWitness] = await db('annual_prepay_terms').insert({ ...base, notice_45_sent_at: onTime45, notice_30_claimed_at: new Date() }).returning('*');
    const [withNothing] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID(), notice_30_claimed_at: new Date() }).returning('*');
    const at28 = new Date('2026-10-13T16:00:00Z');

    await _private.stampTermNoticeWitness(withWitness, 30, at28, { alsoRecordMissedRung: 45 });
    await _private.stampTermNoticeWitness(withNothing, 30, at28, { alsoRecordMissedRung: 45 });

    const a = await db('annual_prepay_terms').where({ id: withWitness.id }).first();
    expect(a.notice_45_sent_at).toEqual(onTime45);
    expect(a.notice_45_late_sent_at).toBeNull();
    expect(a.notice_30_late_sent_at).toEqual(at28);
    expect(a.notice_30_claimed_at).toBeNull();
    const b = await db('annual_prepay_terms').where({ id: withNothing.id }).first();
    expect(b.notice_45_late_sent_at).toEqual(at28);
    expect(b.notice_30_late_sent_at).toEqual(at28);
    // One late-45 bell: for the term that genuinely had no 45 record.
    expect(lateBells(notifyAdmin, 45).map((c) => c[3].metadata.annual_prepay_term_id)).toEqual([withNothing.id]);
  });

  // Codex #4921 pre-push P1: a COMBINED 30+45 send's evidence carries
  // covers_rungs, so recovery restores BOTH rungs atomically with no
  // call-site options — and a 45 with its own earlier on-time acceptance is
  // stamped on time instead of late.
  test('combined 30+45 evidence (covers_rungs in the audit metadata): recovering the 45 stamps the 30 AND a late 45 together; a 45 with its own on-time evidence is stamped on time', async () => {
    const { db } = fixture;
    await migrateThrough108(db);
    await db.raw(`CREATE TABLE messaging_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid, channel text, provider text, blocked_code text,
      provider_message_id text, sent_at timestamptz, metadata jsonb
    )`);
    jest.doMock('../models/db', () => db);
    const notifyAdmin = mockSendSide();
    const { _private } = require('../services/annual-prepay-renewals');
    // Dates in the real past (acceptance times in the future are never evidence).
    const base = {
      term_start: '2025-10-01', term_end: '2026-10-01', status: 'active', annual_plan_version: 'v3',
      installation_anchored_at: new Date('2025-10-01T12:00:00Z'),
    };
    const [combinedOnly] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID() }).returning('*');
    const [alsoOwn45] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID() }).returning('*');
    const day28 = new Date('2026-09-03T16:00:00Z'); // 28 days before 2026-10-01
    const day45 = new Date('2026-08-17T16:00:00Z'); // exactly 45 days before (ET)
    const sms = (term, daysOut, sentAt, c, extra = {}) => ({
      customer_id: term.customer_id, channel: 'sms', provider: 'twilio', blocked_code: null,
      provider_message_id: `SM${c.repeat(32)}`, sent_at: sentAt,
      metadata: JSON.stringify({ original_message_type: 'termite_annual_renewal_notice', annual_prepay_term_id: term.id, days_out: daysOut, ...extra }),
    });
    await db('messaging_audit_log').insert([
      sms(combinedOnly, 30, day28, 'a', { covers_rungs: [30, 45] }),
      sms(alsoOwn45, 45, day45, 'b'),
      sms(alsoOwn45, 30, day28, 'c', { covers_rungs: [30, 45] }),
    ]);

    // Entry via the 45 (e.g. the escalation pass) — no options anywhere.
    await expect(_private.recoverTermiteNoticeFromAcceptance(combinedOnly, 45))
      .resolves.toMatchObject({ sent: true, recovered: true, rungs: [30, 45] });
    const a = await db('annual_prepay_terms').where({ id: combinedOnly.id }).first();
    expect(a.notice_30_late_sent_at).toEqual(day28);
    expect(a.notice_45_late_sent_at).toEqual(day28);
    expect(a.notice_45_sent_at).toBeNull();
    expect(a.notice_30_claimed_at).toBeNull();

    // Entry via the 30: the 45's OWN on-time evidence wins over the combined late record.
    await expect(_private.recoverTermiteNoticeFromAcceptance(alsoOwn45, 30))
      .resolves.toMatchObject({ sent: true, recovered: true, rungs: [30, 45] });
    const b = await db('annual_prepay_terms').where({ id: alsoOwn45.id }).first();
    expect(b.notice_45_sent_at).toEqual(day45);
    expect(b.notice_45_late_sent_at).toBeNull();
    expect(b.notice_30_late_sent_at).toEqual(day28);
    expect(lateBells(notifyAdmin, 45).map((c) => c[3].metadata.annual_prepay_term_id)).toEqual([combinedOnly.id]);
  });

  // Codex #4921 r7 P1, real SQL: a combined send claims BOTH rungs in one
  // conditional UPDATE, so two instances can never each hold one of the
  // pair; and a zero-row witness stamp is classified, never silently
  // "recorded".
  test('claimCombinedTermNotice: one UPDATE claims both rungs only when both are free and unrecorded; concurrent claimers get exactly one winner; a held 45 blocks it', async () => {
    const { db } = fixture;
    await migrateThrough108(db);
    jest.doMock('../models/db', () => db);
    mockSendSide();
    const { _private } = require('../services/annual-prepay-renewals');
    const base = {
      term_start: '2025-10-01', term_end: '2026-10-20', status: 'active', annual_plan_version: 'v3',
      installation_anchored_at: new Date('2025-10-01T12:00:00Z'),
    };
    const insert = async (fields) => (await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID(), ...fields }).returning('*'))[0];
    const free = await insert({});
    const held45 = await insert({ notice_45_claimed_at: new Date() });
    const stale45 = await insert({ notice_45_claimed_at: new Date(Date.now() - 60 * 60 * 1000) });
    const late45 = await insert({ notice_45_late_sent_at: new Date() });
    const raced = await insert({});

    const claimedFree = await _private.claimCombinedTermNotice(free);
    expect(claimedFree).toMatchObject({ status: 'renewal_pending' });
    expect(claimedFree.notice_30_claimed_at).toBeInstanceOf(Date);
    expect(claimedFree.notice_45_claimed_at).toEqual(claimedFree.notice_30_claimed_at);

    // Another instance holds the 45 → no row claimed, and the 30 stays unclaimed too.
    await expect(_private.claimCombinedTermNotice(held45)).resolves.toBeNull();
    const h = await db('annual_prepay_terms').where({ id: held45.id }).first();
    expect(h.notice_30_claimed_at).toBeNull();
    expect(h.status).toBe('active');
    // A stale 45 claim is reclaimable; a recorded 45 is never combined.
    await expect(_private.claimCombinedTermNotice(stale45)).resolves.toMatchObject({ id: stale45.id });
    await expect(_private.claimCombinedTermNotice(late45)).resolves.toBeNull();

    // Two concurrent combined claimers: exactly one wins.
    const results = await Promise.all([_private.claimCombinedTermNotice(raced), _private.claimCombinedTermNotice(raced)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // …and a single-rung 45 claimer racing the winner loses too.
    await expect(_private.claimTermNotice(raced, 45)).resolves.toBeNull();
    // …and the reverse: a single-rung 45 claim taken FIRST blocks the combined claim.
    const single45 = await insert({});
    await expect(_private.claimTermNotice(single45, 45)).resolves.toMatchObject({ id: single45.id });
    await expect(_private.claimCombinedTermNotice(single45)).resolves.toBeNull();

    // Release clears BOTH claims and restores the pre-claim status.
    await _private.releaseCombinedTermNoticeClaim(claimedFree, 'active');
    const r = await db('annual_prepay_terms').where({ id: free.id }).first();
    expect(r.notice_30_claimed_at).toBeNull();
    expect(r.notice_45_claimed_at).toBeNull();
    expect(r.status).toBe('active');
  });

  test('stampTermNoticeWitness: a zero-row stamp is classified — same witness already there is benign, a conflicting record is belled and never overwritten', async () => {
    const { db } = fixture;
    await migrateThrough108(db);
    jest.doMock('../models/db', () => db);
    const notifyAdmin = mockSendSide();
    const { _private } = require('../services/annual-prepay-renewals');
    const base = {
      term_start: '2025-10-01', term_end: '2026-11-10', status: 'renewal_pending', annual_plan_version: 'v3',
      installation_anchored_at: new Date('2025-10-01T12:00:00Z'),
    };
    const onTime = new Date('2026-09-26T16:00:00Z'); // exactly 45 days before 2026-11-10 (ET)
    const lateAt = new Date('2026-09-28T16:00:00Z');
    const [sameWitness] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID(), notice_45_sent_at: onTime }).returning('*');
    const [lateFirst] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID(), notice_45_late_sent_at: lateAt }).returning('*');

    await expect(_private.stampTermNoticeWitness(sameWitness, 45, onTime)).resolves.toBe('already_recorded');
    await expect(_private.stampTermNoticeWitness(lateFirst, 45, onTime)).resolves.toBe('conflict');
    const row = await db('annual_prepay_terms').where({ id: lateFirst.id }).first();
    expect(row.notice_45_sent_at).toBeNull(); // never silently overwritten
    expect(row.notice_45_late_sent_at).toEqual(lateAt);
    const conflictBells = notifyAdmin.mock.calls.filter((c) => c[1] === 'Termite annual renewal notice record conflict');
    expect(conflictBells.map((c) => c[3].metadata.annual_prepay_term_id)).toEqual([lateFirst.id]);
    expect(conflictBells[0][3]).toMatchObject({ bell: true, dedupeKey: `termite-annual-notice:${lateFirst.id}:45:witness_conflict` });
  });

  test('checkAndSend: an accepted notice whose witness write failed is recovered from messaging_audit_log — before the send (44 days out) AND before the missed-notice bell (at term_end) — with no text, no email and no bell', async () => {
    const { db } = fixture;
    await migrateThrough108(db);
    await db.raw(`CREATE TABLE messaging_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid, channel text, provider text, blocked_code text,
      provider_message_id text, sent_at timestamptz, metadata jsonb
    )`);
    jest.doMock('../models/db', () => db);
    const notifyAdmin = mockSendSide();
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    const AccountMembershipEmail = require('../services/account-membership-email');

    const base = {
      term_start: '2025-11-09', status: 'active', annual_plan_version: 'v3', installation_anchored_at: new Date('2025-11-09T12:00:00Z'),
    };
    // 44 days out, its 45 accepted on time yesterday (witness write failed).
    const [open44] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID(), term_end: '2026-11-09' }).returning('*');
    // At term_end, both rungs accepted on time earlier (both witness writes failed).
    const [atEnd] = await db('annual_prepay_terms').insert({ ...base, customer_id: randomUUID(), term_end: '2026-09-26', status: 'renewal_pending' }).returning('*');
    const sms = (term, daysOut, sentAt, c) => ({
      customer_id: term.customer_id, channel: 'sms', provider: 'twilio', blocked_code: null,
      provider_message_id: `SM${c.repeat(32)}`, sent_at: sentAt,
      metadata: JSON.stringify({ original_message_type: 'termite_annual_renewal_notice', annual_prepay_term_id: term.id, days_out: daysOut }),
    });
    const accepted45 = new Date('2026-09-25T16:00:00Z');
    await db('messaging_audit_log').insert([
      sms(open44, 45, accepted45, 'a'),
      sms(atEnd, 45, new Date('2026-08-12T16:00:00Z'), 'b'),
      sms(atEnd, 30, new Date('2026-08-27T16:00:00Z'), 'c'),
    ]);

    await AnnualPrepayRenewals.checkAndSend({ today: '2026-09-26' });

    const r1 = await db('annual_prepay_terms').where({ id: open44.id }).first();
    expect(r1.notice_45_sent_at).toEqual(accepted45);
    expect(r1.notice_45_late_sent_at).toBeNull();
    expect(r1.notice_45_undelivered_escalated_at).toBeNull();
    const r2 = await db('annual_prepay_terms').where({ id: atEnd.id }).first();
    expect(r2.notice_45_sent_at).toEqual(new Date('2026-08-12T16:00:00Z'));
    expect(r2.notice_30_sent_at).toEqual(new Date('2026-08-27T16:00:00Z'));
    expect(r2.notice_missed_escalated_at).toBeNull();

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AccountMembershipEmail.sendTermiteRenewalReminder).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
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

  test('a database that ran only through 000106 (pre-000107) — checkAndSend\'s readiness gate skips the ENTIRE termite pass instead of throwing, and the generic 30/15/7 loop still runs WITHOUT excluding termite terms', async () => {
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
    jest.doMock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn(), sendTermiteRenewalReminder: jest.fn(), findAcceptedTermiteRenewalReminder: jest.fn(async () => null) }));
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
    // (live) schema. Codex #4921 r4 P1: with the termite pass skipped, its
    // 30-day query must NOT exclude termite terms — otherwise they would
    // get no 30-day notice from either path.
    expect(sql.some((q) => /notice_30_sent_at/.test(q) && /"term_end" = /.test(q))).toBe(true);
    expect(sql.some((q) => /"annual_plan_version" is null/.test(q))).toBe(false);
    expect(sql.some((q) => /notice_7_sent_at/.test(q))).toBe(true);
    // …and the termite pass was skipped by the readiness gate, never run.
    expect(sql.some((q) => /notice_30_late_escalated_at/.test(q))).toBe(false);
  });
});
