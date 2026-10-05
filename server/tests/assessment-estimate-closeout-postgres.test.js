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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => null) }));
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
// The canonical completion runs for real; the spy only records what the sweep asked of it.
jest.mock('../services/complete-scheduled-service', () => {
  const actual = jest.requireActual('../services/complete-scheduled-service');
  return { ...actual, completeScheduledService: jest.fn(actual.completeScheduledService) };
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
const Completion = require('../services/complete-scheduled-service');
const { triggerNotification } = require('../services/notification-triggers');
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

  test('an assessment that carries a price or a prepayment is left to a person', () => {
    const visit = { status: 'on_site', arrived_at: at('2040-03-03T18:00:00Z') };
    const sent = at('2040-03-03T18:09:00Z');
    expect(rule(visit, sent)).toBeNull();
    expect(rule({ ...visit, estimated_price: '0.00' }, sent)).toBeNull();
    expect(rule({ ...visit, estimated_price: '75.00' }, sent)).toBe('assessment_has_charge');
    expect(rule({ ...visit, prepaid_amount: '20.00' }, sent)).toBe('assessment_has_charge');
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
  test('the close always asks for the backfill posture — one constant request per visit, time on site unknown', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/assessment-estimate-closeout.js'), 'utf8');
    expect(source).toMatch(/const idempotencyKeyFor = \(visitId\) => `\$\{KEY_PREFIX\}\$\{visitId\}:backfill`;/);
    expect(source).toMatch(/requestReview: false,[\s\S]{0,400}?backfill: true,\s*\n\s*\},/);
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toMatch(/allowSameDay: !!completionInput\.issuedInvoiceCloseout \|\| completionInput\.systemQuietCloseout === true \}\);/);
  });

  test('a system quiet closeout takes the scheduled-invoice mint lock before the customer and visit row locks', () => {
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const persistAt = completion.indexOf('const persistRecord = async (trx) => {');
    const mintAt = completion.indexOf("if (systemQuietCloseout) {\n            await require('../services/scheduled-invoice-mint').acquireScheduledInvoiceMintLock(trx, svc.id);", persistAt);
    const visitLockAt = completion.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();", persistAt);
    const customerLockAt = completion.indexOf('.forShare()', persistAt);
    expect(mintAt).toBeGreaterThan(persistAt);
    expect(customerLockAt).toBeGreaterThan(mintAt);
    expect(visitLockAt).toBeGreaterThan(mintAt);
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
  // Midnight-safe fixtures (pre-push audit): the default visit is dated to the
  // ET day of its own start stamp (50 minutes ago), never to "today", so a run
  // just after midnight ET builds the same shape — a visit, then an estimate
  // sent after it. Only its posture differs then (yesterday's visit closes in
  // the backfill posture), which no assertion below depends on.
  const startDay = () => etDateString(minutesAgo(50));
  async function visit(customerId, { status = 'on_site', day = startDay(), serviceType = 'Waves Assessment', serviceId = assessmentCatalogId, ...rest } = {}) {
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
  // A REAL handoff by default: admin-estimates stamps deliveryState on every
  // delivery that reached the customer. `delivered: false` models a
  // suppressed send (sent_at stamped, nothing delivered).
  // A committed completion's record, for a parked attempt fixture.
  async function recordFor(visitId) {
    const v = await mockPg('scheduled_services').where({ id: visitId }).first();
    const id = randomUUID();
    await mockPg('service_records').insert({ id, customer_id: v.customer_id, scheduled_service_id: visitId, service_date: v.scheduled_date, service_type: v.service_type });
    return id;
  }
  async function estimate(customerId, { status = 'sent', sentAt = minutesAgo(10), linkedVisitId = null, delivered = true, acceptedAt = null } = {}) {
    const id = randomUUID();
    await mockPg('estimates').insert({
      id, customer_id: customerId, status, sent_at: sentAt, token: randomUUID().replace(/-/g, ''),
      customer_name: 'Fixture Assessment', accepted_at: acceptedAt,
      estimate_data: JSON.stringify({
        ...(linkedVisitId ? { scheduled_service_id: linkedVisitId } : {}),
        ...(delivered && sentAt ? { deliveryState: { firstDeliveredAt: new Date(sentAt).toISOString(), lastDeliveredAt: new Date(sentAt).toISOString(), deliveredAt: [new Date(sentAt).toISOString()] } } : {}),
      }),
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
    const closedRow = await row(visitId);
    expect(closedRow.status).toBe('completed');
    // Nobody timed it: no on-site labor is booked from the arrival to the sweep (Codex r3 P1).
    expect(closedRow.service_time_minutes).toBeNull();
    expect(closedRow.actual_duration_minutes).toBeNull();
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
    await estimate(ahead, { sentAt: minutesAgo(50) });
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
    await estimate(customerId, { sentAt: new Date() });
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
    // The second argument is the locked row, the third the row the completion loaded.
    let loadedId = null;
    await request(async (trx, locked, loaded) => { loadedId = loaded.id; return 'not_now'; });
    expect(loadedId).toBe(visitId);
    expect((await row(visitId)).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: visitId })).toHaveLength(0);
    // Not a function (a request body can never smuggle one in): ignored.
    expect(await request('refuse')).toMatchObject({ status: 200, body: { success: true } });
  });

  test('refused on the visit day, retried after midnight under the same key with the same request — never a changed payload', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId);
    const visitRow = await row(visitId);
    await estimate(customerId);
    // The visit-day attempt reaches the completion and is refused under the lock (a timer started).
    const timerId = randomUUID();
    mockRace.beforeClaim = async () => {
      await mockPg('time_entries').insert({ id: randomUUID(), technician_id: visitRow.technician_id, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: minutesAgo(120) });
      await mockPg('time_entries').insert({ id: timerId, technician_id: visitRow.technician_id, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(), job_id: visitId });
    };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    const firstKeys = await mockPg('service_completion_attempts').where({ service_id: visitId }).pluck('idempotency_key');
    expect(firstKeys).toEqual([`assessment-estimate:${visitId}:backfill`]);
    // Next day: the timer stopped and the visit day has passed → backfill
    // posture. The completion reads the real clock, so the day passing is
    // modeled by moving the fixture one day back (visit, stamps and send),
    // and the six-hour rest by a sweep clock seven hours on.
    await mockPg('time_entries').where({ id: timerId }).update({ status: 'completed', clock_out: new Date(), duration_minutes: 1 });
    await mockPg('scheduled_services').where({ id: visitId }).update({ scheduled_date: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    await mockPg('estimates').where({ customer_id: customerId }).update({ sent_at: minutesAgo(60 * 24) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg, now: new Date(Date.now() + 7 * 3600000), today: TODAY })).toEqual({ candidates: 1, closed: 1 });
    const closed = await row(visitId);
    expect(closed.status).toBe('completed');
    expect(closed.service_time_minutes).toBeNull();
    expect(new Set(await mockPg('service_completion_attempts').where({ service_id: visitId }).pluck('idempotency_key')))
      .toEqual(new Set([`assessment-estimate:${visitId}:backfill`]));
  });

  test('a completion this closeout committed and left parked is resumed from its own posture — with no fresh estimate needed, no locked guard, and behind the open visits', async () => {
    // Committed as completed, post-commit work owed; the estimate has since gone back to draft.
    const parkedCustomer = await customer();
    const parked = await visit(parkedCustomer, { status: 'completed', day: YESTERDAY });
    await estimate(parkedCustomer, { status: 'draft', sentAt: null });
    await mockPg('service_completion_attempts').insert({ id: randomUUID(), service_id: parked, idempotency_key: `assessment-estimate:${parked}:backfill`, status: 'side_effects_pending', request_hash: 'x', service_record_id: await recordFor(parked) });
    // Someone else's parked completion on a completed assessment is not this sweep's.
    const foreign = await visit(await customer(), { status: 'completed', day: YESTERDAY });
    await mockPg('service_completion_attempts').insert({ id: randomUUID(), service_id: foreign, idempotency_key: randomUUID(), status: 'side_effects_pending', request_hash: 'x', service_record_id: await recordFor(foreign) });
    // An open, eligible assessment on a later day: it is asked first.
    const openCustomer = await customer();
    const open = await visit(openCustomer);
    await estimate(openCustomer);

    const out = await closeAssessmentsWithSentEstimates({ conn: mockPg });
    expect(out.candidates).toBe(2);
    const calls = Completion.completeScheduledService.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.serviceId)).toEqual([open, parked]);
    const resume = calls[1];
    expect(resume.idempotencyKey).toBe(`assessment-estimate:${parked}:backfill`);
    expect(resume.body).toMatchObject({ backfill: true, idempotencyKey: `assessment-estimate:${parked}:backfill` });
    expect(resume.lockedVisitGuard).toBeNull();
    expect(typeof calls[0].lockedVisitGuard).toBe('function');
    expect((await row(open)).status).toBe('completed');
  });

  test('a refused attempt followed by a date correction or a customer merge retries cleanly — the request carries no visit identity, so its hash never changes', async () => {
    const customerId = await customer();
    const twoDaysAgo = etDateString(addETDays(new Date(), -2));
    const visitId = await visit(customerId, { day: twoDaysAgo, en_route_at: minutesAgo(60 * 50), arrived_at: minutesAgo(60 * 49), check_in_time: minutesAgo(60 * 49) });
    const visitRow = await row(visitId);
    await estimate(customerId, { sentAt: minutesAgo(60 * 20) });
    const timerId = randomUUID();
    mockRace.beforeClaim = async () => {
      await mockPg('time_entries').insert({ id: randomUUID(), technician_id: visitRow.technician_id, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: minutesAgo(120) });
      await mockPg('time_entries').insert({ id: timerId, technician_id: visitRow.technician_id, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(), job_id: visitId });
    };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    // The office corrects the visit's day (still past → same posture, same key) AND the customer is merged into another row; the timer has stopped.
    await mockPg('time_entries').where({ id: timerId }).update({ status: 'completed', clock_out: new Date(), duration_minutes: 1 });
    const winner = await customer();
    await mockPg('estimates').where({ customer_id: customerId }).update({ customer_id: winner });
    await mockPg('scheduled_services').where({ id: visitId }).update({ customer_id: winner, scheduled_date: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg, now: new Date(Date.now() + 7 * 3600000), today: TODAY })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(visitId)).status).toBe('completed');
    expect(new Set(await mockPg('service_completion_attempts').where({ service_id: visitId }).pluck('idempotency_key'))).toEqual(new Set([`assessment-estimate:${visitId}:backfill`]));
    const sent = Completion.completeScheduledService.mock.calls.map(([input]) => input.body);
    for (const body of sent) expect(body).not.toHaveProperty('expectedVisit');
    expect(sent[0]).toEqual(sent[1]);
  });

  test('the locked guard decides identity on the locked row: a visit reclassified, or moved across midnight, after the sweep read it is refused', async () => {
    const pestCatalog = randomUUID();
    await mockPg('services').insert({ id: pestCatalog, name: 'Fixture Quarterly Pest Control Service', service_key: `fixture_${pestCatalog.slice(0, 8)}`, category: 'pest_control', is_active: true });
    const reclassified = await customer();
    const reclassifiedVisit = await visit(reclassified);
    await estimate(reclassified);
    mockRace.beforeClaim = async () => {
      await mockPg('scheduled_services').where({ id: reclassifiedVisit }).update({ service_type: 'Fixture Quarterly Pest Control Service', service_id: pestCatalog });
    };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    expect((await row(reclassifiedVisit)).status).toBe('on_site');
    expect(await audits(reclassifiedVisit, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'visit_changed' }) })]);

    const moved = await customer();
    const movedVisit = await visit(moved, { day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    await estimate(moved, { sentAt: minutesAgo(60 * 24) });
    mockRace.beforeClaim = async () => {
      await mockPg('scheduled_services').where({ id: movedVisit }).update({ scheduled_date: TODAY });
    };
    await closeAssessmentsWithSentEstimates({ conn: mockPg });
    expect((await row(movedVisit)).status).toBe('on_site');
    expect(await audits(movedVisit, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'visit_changed' }) })]);

    // Past day → another past day (the posture does not change): the record
    // would carry the old service day, so it is refused too…
    const corrected = await customer();
    const twoDaysAgo = etDateString(addETDays(new Date(), -2));
    const correctedVisit = await visit(corrected, { day: twoDaysAgo, en_route_at: minutesAgo(60 * 50), arrived_at: minutesAgo(60 * 49), check_in_time: minutesAgo(60 * 49) });
    await estimate(corrected, { sentAt: minutesAgo(60 * 20) });
    mockRace.beforeClaim = async () => {
      await mockPg('scheduled_services').where({ id: correctedVisit }).update({ scheduled_date: YESTERDAY });
    };
    await closeAssessmentsWithSentEstimates({ conn: mockPg });
    expect((await row(correctedVisit)).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: correctedVisit })).toHaveLength(0);
    // …and so is a customer reassignment, even though the new customer has a sent estimate of their own.
    const from = await customer();
    const to = await customer();
    const reassigned = await visit(from);
    await estimate(from);
    await estimate(to);
    mockRace.beforeClaim = async () => {
      await mockPg('scheduled_services').where({ id: reassigned }).update({ customer_id: to });
    };
    await closeAssessmentsWithSentEstimates({ conn: mockPg });
    expect((await row(reassigned)).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: reassigned })).toHaveLength(0);
    for (const id of [correctedVisit, reassigned]) {
      expect(await audits(id, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'visit_changed' }) })]);
    }
  });

  test('ONE estimate closes ONE assessment: the newest one on or before the estimate — an older one still open behind it stays open, whether the newer is open or already completed', async () => {
    const twoDaysAgo = etDateString(addETDays(new Date(), -2));
    // An abandoned, never-started assessment, then the one that produced the estimate.
    const customerId = await customer();
    const abandoned = await visit(customerId, { status: 'confirmed', day: twoDaysAgo });
    const real = await visit(customerId);
    await estimate(customerId);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(real)).status).toBe('completed');
    expect((await row(abandoned)).status).toBe('confirmed');
    // The newer one is completed now: the older one still does not close on that estimate, and is not even a candidate.
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    expect(await mockPg('service_records').where({ scheduled_service_id: abandoned })).toHaveLength(0);
    expect(await audits(abandoned, AUDIT_REFUSED)).toHaveLength(0);
    // A CANCELLED newer assessment never happened: the older one is the match.
    const other = await customer();
    const older = await visit(other, { day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    await visit(other, { status: 'cancelled' });
    await estimate(other, { sentAt: minutesAgo(60 * 24) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(older)).status).toBe('completed');
  });

  test('two assessments, two estimates: each estimate closes its own assessment — the later estimate never hides the earlier one from its assessment', async () => {
    const threeDaysAgo = etDateString(addETDays(new Date(), -3));
    const customerId = await customer();
    // A on day -3 with E1 sent the same day after the arrival; B yesterday with E2 sent after it.
    const a = await visit(customerId, { day: threeDaysAgo, en_route_at: minutesAgo(60 * 74), arrived_at: minutesAgo(60 * 73), check_in_time: minutesAgo(60 * 73) });
    await estimate(customerId, { sentAt: minutesAgo(60 * 72) });
    const b = await visit(customerId, { day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    await estimate(customerId, { sentAt: minutesAgo(60 * 24) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 2, closed: 2 });
    expect((await row(a)).status).toBe('completed');
    expect((await row(b)).status).toBe('completed');
  });

  test('the estimate\'s explicit booking link decides: an estimate linked to assessment A closes A, never a later B', async () => {
    const customerId = await customer();
    const a = await visit(customerId, { day: YESTERDAY, en_route_at: minutesAgo(60 * 26), arrived_at: minutesAgo(60 * 25), check_in_time: minutesAgo(60 * 25) });
    const b = await visit(customerId);
    // A's pre-drafted estimate is sent today, after B was booked and reached.
    await estimate(customerId, { sentAt: minutesAgo(5), linkedVisitId: a });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(a)).status).toBe('completed');
    expect((await row(b)).status).toBe('on_site');
    expect(await mockPg('service_records').where({ scheduled_service_id: b })).toHaveLength(0);
  });

  test('a failure does not rest the visit: the next tick retries it; a refusal about the visit still rests', async () => {
    const failed = await customer();
    const failedVisit = await visit(failed);
    await estimate(failed);
    await mockPg('audit_log').insert({ actor_type: 'system', action: AUDIT_REFUSED, resource_type: 'scheduled_services', resource_id: failedVisit, metadata: JSON.stringify({ code: 'error' }) });
    const outage = await customer();
    const outageVisit = await visit(outage);
    await estimate(outage);
    await mockPg('audit_log').insert({ actor_type: 'system', action: AUDIT_REFUSED, resource_type: 'scheduled_services', resource_id: outageVisit, metadata: JSON.stringify({ code: 'completion_profile_lookup_failed', status: 503 }) });
    const refused = await customer();
    const refusedVisit = await visit(refused);
    await estimate(refused);
    await mockPg('audit_log').insert({ actor_type: 'system', action: AUDIT_REFUSED, resource_type: 'scheduled_services', resource_id: refusedVisit, metadata: JSON.stringify({ code: 'grouped_visit', status: 409 }) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 2, closed: 2 });
    expect((await row(failedVisit)).status).toBe('completed');
    expect((await row(outageVisit)).status).toBe('completed');
    expect((await row(refusedVisit)).status).toBe('on_site');
  });

  test('"sent" means a real handoff: a suppressed send (sent_at, nothing delivered) closes nothing; an estimate accepted during its first send, with no sent_at, closes', async () => {
    const suppressed = await customer();
    const suppressedVisit = await visit(suppressed);
    await estimate(suppressed, { delivered: false });
    const accepted = await customer();
    const acceptedVisit = await visit(accepted);
    await estimate(accepted, { status: 'accepted', sentAt: null, delivered: false, acceptedAt: minutesAgo(5) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(suppressedVisit)).status).toBe('on_site');
    expect((await row(acceptedVisit)).status).toBe('completed');
  });

  test('a linked invoice with a NULL status is a live invoice: the assessment is left to a person', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId);
    await estimate(customerId);
    await mockPg('invoices').insert({ id: randomUUID(), customer_id: customerId, scheduled_service_id: visitId, invoice_number: `TST-${randomUUID().slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: null, total: 50, subtotal: 50, service_date: startDay(), service_type: 'Waves Assessment', line_items: JSON.stringify([]) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    expect((await row(visitId)).status).toBe('on_site');
  });

  test('a parked completion still resumes after the completed visit was reclassified and fell outside the window', async () => {
    const customerId = await customer();
    const parked = await visit(customerId, { status: 'completed', day: etDateString(addETDays(new Date(), -40)), serviceType: 'Fixture Reclassified Service', serviceId: null });
    await mockPg('service_completion_attempts').insert({ id: randomUUID(), service_id: parked, idempotency_key: `assessment-estimate:${parked}:backfill`, status: 'side_effects_pending', request_hash: 'x', service_record_id: await recordFor(parked) });
    await closeAssessmentsWithSentEstimates({ conn: mockPg });
    const calls = Completion.completeScheduledService.mock.calls.map(([input]) => input);
    expect(calls.map((input) => input.serviceId)).toEqual([parked]);
    expect(calls[0].idempotencyKey).toBe(`assessment-estimate:${parked}:backfill`);
    expect(calls[0].lockedVisitGuard).toBeNull();
  });

  test('only a COMMITTED attempt is resumed: a pre-commit pending attempt on a visit someone else completed is not finished through this lane', async () => {
    const customerId = await customer();
    const done = await visit(customerId, { status: 'completed', day: YESTERDAY });
    await mockPg('service_completion_attempts').insert({ id: randomUUID(), service_id: done, idempotency_key: `assessment-estimate:${done}:backfill`, status: 'pending', request_hash: 'x' });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    expect(Completion.completeScheduledService).not.toHaveBeenCalled();
  });

  test('a structured primary_line_price counts as a charge when estimated_price is unset; an explicit 0 stays free', async () => {
    const lined = await customer();
    const linedVisit = await visit(lined, { primary_line_price: 49 });
    await estimate(lined);
    const zero = await customer();
    const zeroVisit = await visit(zero, { estimated_price: 0, primary_line_price: 49 });
    await estimate(zero);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(linedVisit)).status).toBe('on_site');
    expect((await row(zeroVisit)).status).toBe('completed');
    expect(assessmentEstimateCloseRefusal({ status: 'on_site', scheduled_date: YESTERDAY, primary_line_price: '49.00' }, new Date(), { today: TODAY })).toBe('assessment_has_charge');
  });

  test('an unresolved street-level address hold leaves the assessment open — completing it would confirm the address with nobody approving it', async () => {
    const customerId = await customer();
    const visitId = await visit(customerId, { status: 'confirmed', day: YESTERDAY, customer_confirmed: false });
    await estimate(customerId, { sentAt: new Date() });
    await mockPg('triage_items').insert({ category: 'booking', reason_code: 'outbound_booking_review',
      payload: JSON.stringify({ street_level_address: 'true', scheduled_service_id: visitId }) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 0 });
    expect((await row(visitId)).status).toBe('confirmed');
    expect(await audits(visitId, AUDIT_REFUSED)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ code: 'street_level_hold' }) })]);
  });

  test('money is a person\'s: a priced assessment, a prepaid one and one with a linked invoice are never candidates', async () => {
    const priced = await customer();
    const pricedVisit = await visit(priced, { estimated_price: 75 });
    await estimate(priced);
    const prepaid = await customer();
    const prepaidVisit = await visit(prepaid, { prepaid_amount: 20 });
    await estimate(prepaid);
    const invoiced = await customer();
    const invoicedVisit = await visit(invoiced);
    await estimate(invoiced);
    await mockPg('invoices').insert({ id: randomUUID(), customer_id: invoiced, scheduled_service_id: invoicedVisit, invoice_number: `TST-${randomUUID().slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'draft', total: 50, subtotal: 50, service_date: startDay(), service_type: 'Waves Assessment', line_items: JSON.stringify([]) });
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 0, closed: 0 });
    for (const id of [pricedVisit, prepaidVisit, invoicedVisit]) expect((await row(id)).status).toBe('on_site');
    expect(Completion.completeScheduledService).not.toHaveBeenCalled();
  });

  test('the close bills nothing and is nobody\'s work: no invoice or charge for an Auto Pay per-application customer whose visit is flagged to invoice, no "<tech> completed" activity line, no job_complete notification', async () => {
    const customerId = await customer();
    await mockPg('customers').where({ id: customerId }).update({ billing_mode: 'per_application', autopay_enabled: true, monthly_rate: 45, waveguard_tier: 'Gold' });
    const visitId = await visit(customerId, { create_invoice_on_complete: true });
    await estimate(customerId);
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(visitId)).status).toBe('completed');
    await expectQuiet(customerId, visitId);
    expect(await mockPg('payments').where({ customer_id: customerId })).toHaveLength(0);
    expect(await mockPg('activity_log').where({ customer_id: customerId, action: 'service_completed' })).toHaveLength(0);
    expect(triggerNotification.mock.calls.filter(([type]) => type === 'job_complete')).toHaveLength(0);
    expect(Completion.completeScheduledService.mock.calls[0][0].systemQuietCloseout).toBe(true);
    // No inspection credit offer on an automatic close (owner ruling 2026-10-04).
    expect(Completion.completeScheduledService.mock.calls[0][0].body.offerInspectionCredit).toBe(false);
    expect(await mockPg('inspection_credit_offers').where({ customer_id: customerId })).toHaveLength(0);
  });

  test('a status that moves between two eligible states after the completion loaded the visit (confirmed → pending, en_route → on_site with an earlier arrival) still closes — the locked status is the transition source', async () => {
    const unstarted = await customer();
    const unstartedVisit = await visit(unstarted, { status: 'confirmed', day: YESTERDAY });
    await estimate(unstarted, { sentAt: new Date() });
    mockRace.beforeClaim = async () => { await mockPg('scheduled_services').where({ id: unstartedVisit }).update({ status: 'pending' }); };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(unstartedVisit)).status).toBe('completed');

    const started = await customer();
    const startedVisit = await visit(started, { status: 'en_route' });
    await estimate(started);
    // A delayed GPS update: arrived 40 minutes ago, before the estimate went out 10 minutes ago.
    mockRace.beforeClaim = async () => { await mockPg('scheduled_services').where({ id: startedVisit }).update({ status: 'on_site', arrived_at: minutesAgo(40), check_in_time: minutesAgo(40) }); };
    expect(await closeAssessmentsWithSentEstimates({ conn: mockPg })).toEqual({ candidates: 1, closed: 1 });
    expect((await row(startedVisit)).status).toBe('completed');
    expect(await audits(startedVisit, AUDIT_REFUSED)).toHaveLength(0);
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
