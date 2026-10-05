/** Estimate sent after a Waves Assessment ⇒ the assessment is closed, driven through the CANONICAL completion against a migrated database. */
process.env.GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT = 'true';
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
// Race injection: a test may run a hook right before the completion claim
// (after the sweep's own reads, before the record transaction's locks).
const mockRace = { beforeClaim: null };
jest.mock('../services/completion-attempts', () => {
  const actual = jest.requireActual('../services/completion-attempts');
  return {
    ...actual,
    claimCompletionAttempt: async (...args) => {
      if (mockRace.beforeClaim) { const hook = mockRace.beforeClaim; mockRace.beforeClaim = null; await hook(); }
      return actual.claimCompletionAttempt(...args);
    },
  };
});
// The review ask is spied, never mocked away: a regression that reaches it shows up as a call.
jest.mock('../services/review-request', () => {
  const actual = jest.requireActual('../services/review-request');
  return { ...actual, enrollPostService: jest.fn(actual.enrollPostService) };
});

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const ReviewService = require('../services/review-request');
const { ACTIVE_WRITE_GENERATION } = require('../constants/staff-time');
const {
  assessmentEstimateCloseRefusal,
  closeAssessmentsWithSentEstimates,
  AUDIT_CLOSED,
  AUDIT_REFUSED,
} = require('../services/assessment-estimate-closeout');

const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg; // the per-test transaction while a test runs; the pool between tests
jest.setTimeout(90000);

describe('assessmentEstimateCloseRefusal — "sent after the assessment", from durable stamps', () => {
  const today = '2040-03-04';
  const at = (iso) => new Date(iso);
  const rule = (visit, sentAt) => assessmentEstimateCloseRefusal({ scheduled_date: '2040-03-03', ...visit }, sentAt, { today });

  test('a visit the technician reached closes when the estimate was sent after the arrival', () => {
    const visit = { status: 'on_site', arrived_at: at('2040-03-03T18:00:00Z'), en_route_at: at('2040-03-03T17:40:00Z') };
    expect(rule(visit, at('2040-03-03T18:09:00Z'))).toBeNull();
    expect(rule(visit, at('2040-03-04T15:00:00Z'))).toBeNull();
    // Sent while the technician was still driving there, or before: a quote ahead of the walkthrough.
    expect(rule(visit, at('2040-03-03T17:50:00Z'))).toBe('estimate_before_visit');
    expect(rule(visit, at('2040-03-02T15:00:00Z'))).toBe('estimate_before_visit');
  });

  test('en_route counts — GPS often misses the arrival — measured from the moment the technician set out', () => {
    const visit = { status: 'en_route', arrived_at: null, en_route_at: at('2040-03-03T20:40:00Z') };
    expect(rule(visit, at('2040-03-03T21:01:00Z'))).toBeNull();
    expect(rule(visit, at('2040-03-03T20:30:00Z'))).toBe('estimate_before_visit');
  });

  test('a started visit with no start stamp falls back to the day', () => {
    const visit = { status: 'on_site', arrived_at: null, en_route_at: null };
    expect(rule(visit, at('2040-03-03T15:00:00Z'))).toBeNull();
    expect(rule(visit, at('2040-03-02T15:00:00Z'))).toBe('estimate_before_visit');
  });

  test('a visit nobody is known to have gone to closes only on an estimate sent on a LATER ET day', () => {
    for (const status of ['pending', 'confirmed', null]) {
      expect(rule({ status }, at('2040-03-04T15:00:00Z'))).toBeNull();
      expect(rule({ status }, at('2040-03-03T22:00:00Z'))).toBe('estimate_not_after_visit_day');
      expect(rule({ status }, at('2040-03-02T15:00:00Z'))).toBe('estimate_not_after_visit_day');
      // 11:30 PM ET on the visit day is 03:30Z the next day: still the visit day.
      expect(rule({ status }, at('2040-03-04T03:30:00Z'))).toBe('estimate_not_after_visit_day');
    }
  });

  test('a future visit, a terminal status and a missing send never close', () => {
    expect(assessmentEstimateCloseRefusal({ status: 'on_site', scheduled_date: '2040-03-05' }, at('2040-03-04T15:00:00Z'), { today })).toBe('visit_in_future');
    expect(assessmentEstimateCloseRefusal({ status: 'confirmed', scheduled_date: null }, at('2040-03-04T15:00:00Z'), { today })).toBe('visit_in_future');
    for (const status of ['completed', 'cancelled', 'no_show', 'skipped', 'rescheduled']) {
      expect(rule({ status }, at('2040-03-04T15:00:00Z'))).toBe(`visit_${status}`);
    }
    expect(rule({ status: 'on_site' }, null)).toBe('estimate_not_sent');
    expect(rule({ status: 'on_site' }, 'not-a-date')).toBe('estimate_not_sent');
  });
});

describe('source contracts', () => {
  const fs = require('fs');
  const path = require('path');
  test('the sweep runs every ten minutes under its own lock, and is called from exactly one place', () => {
    const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(scheduler).toMatch(/cron\.schedule\('4-59\/10 \* \* \* \*', async \(\) => \{\s*try \{\s*await runExclusive\('assessment-estimate-closeout', async \(\) => \{\s*const sweep = await require\('\.\/assessment-estimate-closeout'\)\.closeAssessmentsWithSentEstimates\(\);/);
    expect(scheduler.match(/closeAssessmentsWithSentEstimates\(/g)).toHaveLength(1);
  });
  test('the gate is strict and read at call time', () => {
    const gates = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(gates).toMatch(/function estimateSentClosesAssessmentLive\(\) \{\s*return process\.env\.GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT === 'true';\s*\}/);
  });
});

postgres('estimate sent ⇒ assessment closed (PostgreSQL, canonical completion)', () => {
  const TODAY = etDateString();
  const YESTERDAY = etDateString(addETDays(new Date(), -1));
  const minutesAgo = (n) => new Date(Date.now() - n * 60000);
  let assessmentCatalogId;

  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    mockPg = database;
    assessmentCatalogId = (await database('services').where({ service_key: 'lawn_inspection' }).first('id')).id;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRace.beforeClaim = null;
    process.env.GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT = 'true';
    mockPg = await database.transaction();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  async function customer() {
    const id = randomUUID();
    await mockPg('customers').insert({ id, first_name: 'Fixture', last_name: 'Assessment', phone: '+12025550123', email: `${id}@example.invalid`, property_type: 'residential' });
    return id;
  }
  async function technician() {
    const id = randomUUID();
    await mockPg('technicians').insert({ id, name: 'Fixture Technician', role: 'technician', active: true });
    return id;
  }
  async function visit(customerId, { status = 'on_site', day = TODAY, serviceType = 'Waves Assessment', serviceId = assessmentCatalogId, ...rest } = {}) {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, customer_id: customerId, technician_id: await technician(), service_id: serviceId, service_type: serviceType,
      scheduled_date: day, window_start: '09:00', window_end: '10:00', status,
      ...(status === 'on_site' ? { en_route_at: minutesAgo(50), arrived_at: minutesAgo(40), check_in_time: minutesAgo(40) } : {}),
      ...(status === 'en_route' ? { en_route_at: minutesAgo(50) } : {}),
      ...rest,
    });
    return id;
  }
  async function estimate(customerId, { status = 'sent', sentAt = minutesAgo(10) } = {}) {
    const id = randomUUID();
    await mockPg('estimates').insert({
      id, customer_id: customerId, status, sent_at: sentAt, token: randomUUID().replace(/-/g, ''),
      customer_name: 'Fixture Assessment', estimate_data: JSON.stringify({}),
    });
    return id;
  }
  const row = (id) => mockPg('scheduled_services').where({ id }).first();
  const audits = (id, action) => mockPg('audit_log').where({ resource_id: id, action });
  async function expectQuiet(customerId, visitId) {
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
    expect(await mockPg('invoices').where({ customer_id: customerId })).toHaveLength(0);
    const records = await mockPg('service_records').where({ scheduled_service_id: visitId });
    expect(records).toHaveLength(1);
    expect(records[0].report_view_token).toBeNull();
  }

  test('an estimate sent after the technician arrived closes the assessment — no text, report, review ask, charge or invoice', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId);
    const estimateId = await estimate(customerId);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(visitId)).status).toBe('completed');
    await expectQuiet(customerId, visitId);
    expect(await audits(visitId, AUDIT_CLOSED)).toEqual([expect.objectContaining({ actor_type: 'system', metadata: expect.objectContaining({ estimateId }) })]);
    // The next tick finds nothing to do.
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
  });

  test('en_route with no arrival (GPS missed it) closes too; a past-day visit closes with its time on site unknown', async () => {
    const customerId = await customer();
    const enRoute = await visit(customerId, { status: 'en_route' });
    await estimate(customerId, { status: 'accepted' });
    const other = await customer();
    const stale = await visit(other, { status: 'on_site', day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    await estimate(other, { sentAt: minutesAgo(60 * 24) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 2, closed: 2 });
    expect((await row(enRoute)).status).toBe('completed');
    const closedStale = await row(stale);
    expect(closedStale.status).toBe('completed');
    // The backfill posture never books a day-old arrival-to-now span as labor.
    expect(closedStale.service_time_minutes).toBeNull();
    expect(closedStale.actual_duration_minutes).toBeNull();
    await expectQuiet(other, stale);
  });

  test('an estimate sent BEFORE the visit, a draft, and another customer\'s estimate close nothing', async () => {
    // Sent before the technician set out.
    const early = await customer();
    const earlyVisit = await visit(early);
    await estimate(early, { sentAt: minutesAgo(120) });
    // Only a draft.
    const drafted = await customer();
    const draftVisit = await visit(drafted);
    await estimate(drafted, { status: 'draft', sentAt: null });
    // No estimate of its own.
    const none = await customer();
    const noneVisit = await visit(none);
    await estimate(await customer());
    // Unstarted, estimate the same day: a quote ahead of the walkthrough.
    const ahead = await customer();
    const aheadVisit = await visit(ahead, { status: 'confirmed' });
    await estimate(ahead);
    const out = await closeAssessmentsWithSentEstimates({ conn: mockPg });
    expect(out.closed).toBe(0);
    for (const id of [earlyVisit, draftVisit, noneVisit, aheadVisit]) {
      expect((await row(id)).status).not.toBe('completed');
      expect(await mockPg('service_records').where({ scheduled_service_id: id })).toHaveLength(0);
      // The rule's own "not yet" writes no audit row.
      expect(await audits(id, AUDIT_REFUSED)).toHaveLength(0);
    }
  });

  test('an unstarted assessment closes once the estimate was sent on a later day', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId, { status: 'confirmed', day: YESTERDAY });
    await estimate(customerId, { sentAt: minutesAgo(5) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(visitId)).status).toBe('completed');
    await expectQuiet(customerId, visitId);
  });

  test('only a Waves Assessment closes: the same customer\'s pest visit, and a future assessment, stay open', async () => {
    const customerId = await customer();
    const pestCatalog = randomUUID();
    await mockPg('services').insert({ id: pestCatalog, name: 'Fixture Quarterly Pest Control Service', service_key: `fixture_${pestCatalog.slice(0, 8)}`, category: 'pest_control', is_active: true });
    const pest = await visit(customerId, { serviceType: 'Fixture Quarterly Pest Control Service', serviceId: pestCatalog });
    const future = await visit(customerId, { status: 'confirmed', day: etDateString(addETDays(new Date(), 3)) });
    const assessment = await visit(customerId);
    await estimate(customerId);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(assessment)).status).toBe('completed');
    expect((await row(pest)).status).toBe('on_site');
    expect((await row(future)).status).toBe('confirmed');
  });

  test('a running job timer leaves the assessment with its technician; the refusal rests, then the visit closes after the timer stops', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId);
    const visitRow = await row(visitId);
    await estimate(customerId);
    await mockPg('time_entries').insert({ id: randomUUID(), technician_id: visitRow.technician_id, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: minutesAgo(120) });
    const timerId = randomUUID();
    await mockPg('time_entries').insert({ id: timerId, technician_id: visitRow.technician_id, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: minutesAgo(40), job_id: visitId });
    const before = await mockPg('time_entries').where({ id: timerId }).first();
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    expect((await row(visitId)).status).toBe('on_site');
    expect(await audits(visitId, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'visit_timer_running' }) })]);
    // Read-only on payroll.
    expect(await mockPg('time_entries').where({ id: timerId }).first()).toEqual(before);
    // Resting: the next tick does not pick it, ask, or audit again.
    await mockPg('time_entries').where({ id: timerId }).update({ status: 'completed', clock_out: new Date(), duration_minutes: 40 });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    expect(await audits(visitId, AUDIT_REFUSED)).toHaveLength(1);
    // Six hours on, the timer long stopped: it closes.
    const later = new Date(Date.now() + 7 * 3600000);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg, now: later, today: TODAY })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(visitId)).status).toBe('completed');
  });

  test('a page of refused or not-yet visits never starves an eligible one behind it', async () => {
    // 26 older assessments the sweep cannot act on: resting after a refusal,
    // or with an estimate sent before the visit. More than one page (limit 25).
    for (let i = 0; i < 13; i += 1) {
      const c = await customer();
      const resting = await visit(c, { day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
      await estimate(c, { sentAt: minutesAgo(60 * 24) });
      await mockPg('audit_log').insert({ actor_type: 'system', action: AUDIT_REFUSED, resource_type: 'scheduled_services', resource_id: resting, metadata: JSON.stringify({ code: 'grouped_visit' }) });
      const early = await customer();
      await visit(early, { day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
      await estimate(early, { sentAt: minutesAgo(60 * 30) });
    }
    const customerId = await customer();
    const visitId = await visit(customerId);
    await estimate(customerId);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(visitId)).status).toBe('completed');
  });

  test('a job timer that starts after the sweep read the visit is seen under the completion\'s row lock — the visit stays open', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId);
    const visitRow = await row(visitId);
    await estimate(customerId);
    mockRace.beforeClaim = async () => {
      await mockPg('time_entries').insert({ id: randomUUID(), technician_id: visitRow.technician_id, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: minutesAgo(120) });
      await mockPg('time_entries').insert({ id: randomUUID(), technician_id: visitRow.technician_id, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(), job_id: visitId });
    };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    expect((await row(visitId)).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: visitId })).toHaveLength(0);
    expect(await audits(visitId, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'visit_timer_running', status: 409 }) })]);
  });

  test('an arrival recorded after the estimate was sent (the technician was still on the way at the read) refuses under the lock', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId, { status: 'en_route' });
    await estimate(customerId);
    // GPS marks the arrival now — after the estimate's send — between the sweep's read and the lock.
    mockRace.beforeClaim = async () => {
      await mockPg('scheduled_services').where({ id: visitId }).update({ status: 'on_site', arrived_at: new Date(), check_in_time: new Date() });
    };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    expect((await row(visitId)).status).toBe('on_site');
    expect(await audits(visitId, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'estimate_before_visit' }) })]);
  });

  test('the completion\'s lockedVisitGuard hook refuses before anything is written, and is ignored unless it is a function', async () => {
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const customerId = await customer();
    const visitId = await visit(customerId);
    const request = (lockedVisitGuard) => completeScheduledService({
      serviceId: visitId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', sendCompletionSms: false, requestReview: false },
      actor: { techRole: 'admin', technicianId: null, technician: null },
      lockedVisitGuard,
    });
    const seen = [];
    expect(await request(async (trx, locked) => { seen.push(locked.id); return 'not_now'; })).toMatchObject({ status: 409, body: { code: 'locked_visit_guard_refused', reason: 'not_now' } });
    expect(seen).toEqual([visitId]);
    expect((await row(visitId)).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: visitId })).toHaveLength(0);
    // Not a function (a request body can never smuggle one in): ignored.
    expect(await request('refuse')).toMatchObject({ status: 200, body: { success: true } });
  });

  test('gate off: nothing is read and nothing closes', async () => {
    process.env.GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT = 'false';
    const customerId = await customer();
    const visitId = await visit(customerId);
    await estimate(customerId);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    expect((await row(visitId)).status).toBe('on_site');
  });

  test('an estimate sent more than 14 days ago, and an assessment more than 30 days old, are outside the sweep', async () => {
    const oldSend = await customer();
    const oldSendVisit = await visit(oldSend, { day: etDateString(addETDays(new Date(), -20)), en_route_at: minutesAgo(60 * 24 * 20 + 20), arrived_at: minutesAgo(60 * 24 * 20), check_in_time: minutesAgo(60 * 24 * 20) });
    await estimate(oldSend, { sentAt: minutesAgo(60 * 24 * 15) });
    const oldVisit = await customer();
    const oldVisitId = await visit(oldVisit, { day: etDateString(addETDays(new Date(), -40)), en_route_at: minutesAgo(60 * 24 * 40 + 20), arrived_at: minutesAgo(60 * 24 * 40), check_in_time: minutesAgo(60 * 24 * 40) });
    await estimate(oldVisit);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    expect((await row(oldSendVisit)).status).toBe('on_site');
    expect((await row(oldVisitId)).status).toBe('on_site');
  });
});
