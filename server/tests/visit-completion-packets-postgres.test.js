/** Canonical completion writes against a migrated, private nonproduction database. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn((err) => err?.code === 'STRIPE_AMBIGUOUS_OUTCOME') }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 1 })) }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => {}) }));
jest.mock('../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => {}) }));

jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/review-request', () => ({ enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { saveVisitCompletionPacket, runVisitCompletionPacketEffects, runVisitCompletionPacketMemberEffects, resumePendingVisitCompletions } = require('../services/visit-completion-packets');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');
const { stopBaseKey, dateOnly } = require('../services/visit-groups');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { acquireScheduledInvoiceMintLock, mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');
const { createVisitCompletionInvoice } = require('../services/visit-completion-invoice');
const { collectVisitCompletionInvoice, assertVisitCompletionCharge } = require('../services/visit-completion-payment');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const originalPestRecap = process.env.PEST_RECAP;
const postgres = connection ? describe : describe.skip;
let mockPg;
let fixture;
const originalSummaryKey = process.env.DATA_HYGIENE_VAULT_KEY;
const originalCloseoutGate = process.env.GATE_VISIT_CLOSEOUT;
jest.setTimeout(90000);

function submission(overrides = {}) {
  return {
    visitId: fixture.visitId, idempotencyKey: fixture.key,
    actor: { techRole: 'technician', technicianId: fixture.techId },
    items: fixture.serviceIds.map((serviceId) => ({ serviceId, body: {
      customerRecap: 'The scheduled service was completed.', visitOutcome: 'completed',
      products: [], areasTreated: [], sendCompletionSms: true, requestReview: true,
    } })),
    ...overrides,
  };
}

postgres('visit completion packet records on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a verified, task-private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockPg.schema.hasTable('visit_completion_packets'))) throw new Error('Run the repository migrations first');
  });
  afterAll(async () => {
    if (originalSummaryKey === undefined) delete process.env.DATA_HYGIENE_VAULT_KEY;
    else process.env.DATA_HYGIENE_VAULT_KEY = originalSummaryKey;
    if (originalCloseoutGate === undefined) delete process.env.GATE_VISIT_CLOSEOUT;
    else process.env.GATE_VISIT_CLOSEOUT = originalCloseoutGate;
    if (mockPg) await mockPg.destroy();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    jest.clearAllMocks();
    chargeInvoiceWithSavedCard.mockReset();
    require('../services/stripe').savedCardChargeSuppressesAlternateCollection.mockImplementation((err) => err?.code === 'STRIPE_AMBIGUOUS_OUTCOME');
    sendCustomerMessage.mockImplementation(async (input) => {
      const allowed = await input.preDispatchCheck();
      return allowed.ok ? { sent: true, providerMessageId: 'fixture-sms' } : { blocked: true };
    });
    require('../services/email-template-library').sendTemplate.mockImplementation(async (input) => {
      const allowed = await input.onQueued({ id: randomUUID() });
      return allowed ? { sent: true } : { aborted: true };
    });

    require('../services/notification-triggers').triggerNotification.mockReset().mockResolvedValue({ suppressed: true });
    fixture = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), productId: randomUUID(),
      visitId: randomUUID(), serviceIds: [randomUUID(), randomUUID()].sort(), key: randomUUID(), estimateIds: [] };
    const date = etDateString();
    await mockPg('customers').insert({ id: fixture.customerId, first_name: 'Fixture', phone: '+12025550123',
      email: `${fixture.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false,
      billing_mode: 'per_application' });
    await mockPg('technicians').insert({ id: fixture.techId, name: 'Fixture Technician', role: 'technician', active: true });
    await mockPg('services').insert({ id: fixture.catalogId, name: 'Fixture General Pest Control',
      service_key: `fixture_${fixture.catalogId}`, is_active: true });
    await mockPg('products_catalog').insert({ id: fixture.productId, name: 'Fixture Test Material',
      category: 'other', active: true, inventory_on_hand: 10, inventory_unit: 'oz' });
    await mockPg('service_visits').insert({ id: fixture.visitId, customer_id: fixture.customerId,
      technician_id: fixture.techId, scheduled_date: date, window_start: '09:00', window_end: '11:00',
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: date }), created_by: 'test' });
    await mockPg('scheduled_services').insert(fixture.serviceIds.map((id, index) => ({
      id, customer_id: fixture.customerId, technician_id: fixture.techId, service_id: fixture.catalogId,
      visit_id: fixture.visitId, service_type: 'Fixture General Pest Control', scheduled_date: date,
      window_start: `${9 + index}:00`, window_end: `${10 + index}:00`, status: 'on_site',
      estimated_price: 120, estimated_duration_minutes: 60,
    })));
  });
  afterEach(async () => {
    if (!fixture) return;
    jest.restoreAllMocks();
    if (fixture.httpServer) await new Promise((resolve) => fixture.httpServer.close(resolve));
    if (originalPestRecap === undefined) delete process.env.PEST_RECAP;
    else process.env.PEST_RECAP = originalPestRecap;
    // Only the synthetic fixture's rows; the private database's seeded catalog
    // and migration data remain intact for later billing/UI verification.
    await mockPg('invoices').where({ customer_id: fixture.customerId }).del();
    if (fixture.emailMessageId) await mockPg('email_messages').where({ id: fixture.emailMessageId }).del();
    if (fixture.estimateIds.length) {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: null });
      await mockPg('estimate_deposits').whereIn('estimate_id', fixture.estimateIds).del();
      await mockPg('estimates').whereIn('id', fixture.estimateIds).del();
    }
    await mockPg('activity_log').where({ customer_id: fixture.customerId }).del();
    await mockPg('notifications').whereIn(mockPg.raw("metadata->'payload'->>'serviceId'"), fixture.serviceIds).del();
    await mockPg('product_limits').where({ product_id: fixture.productId }).del();
    await mockPg('customers').where({ id: fixture.customerId }).del();
    if (fixture.formTemplateId) await mockPg('job_form_templates').where({ id: fixture.formTemplateId }).del();
    if (fixture.discountId) await mockPg('discounts').where({ id: fixture.discountId }).del();
    if (fixture.payerId) await mockPg('payers').where({ id: fixture.payerId }).del();
    await mockPg('technicians').where({ id: fixture.techId }).del();
    await mockPg('services').where({ id: fixture.catalogId }).del();
    await mockPg('product_inventory_movements').where({ product_id: fixture.productId }).del();
    await mockPg('products_catalog').where({ id: fixture.productId }).del();
  });

  test('two canonical records commit together and their effects remain pending', async () => {
    const result = await saveVisitCompletionPacket(submission());
    expect(result).toMatchObject({ status: 202, body: { state: 'records_saved', replayed: false } });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((row) => row.status === 'completed')).toBe(true);
    expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds))
      .toEqual(expect.arrayContaining(result.body.items.map((item) => expect.objectContaining({
        service_id: item.serviceId, service_record_id: item.serviceRecordId, status: 'side_effects_pending',
      }))));
    expect(await mockPg('job_status_history').whereIn('job_id', fixture.serviceIds)).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId }).first()).toMatchObject({
      service_type: 'Combined service visit', tech_notes: null, products_applied: [], service_photos: [],
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each([false, true])('staff routes preserve combined closeout after the gate closes (created with full behavior: %s)', async (fullBehavior) => {
    if (fullBehavior) {
      const methodId = randomUUID();
      await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
        processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
        is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
      await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ visit_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).del();
      await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
      const visit = await require('../services/visit-groups').createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' });
      expect(visit.behavior_version).toBe(2);
      fixture.visitId = visit.id;
      chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId, selectedMethod, options) => {
        expect(selectedMethod).toBe(methodId);
        await mockPg.transaction(async (trx) => {
          const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
          await trx('customers').where({ id: fixture.customerId }).forUpdate().first();
          await require('../services/visit-completion-payment').assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
          await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', stripe_payment_intent_id: 'pi_fixture_visit' });
        });
      });
      process.env.GATE_VISIT_CLOSEOUT = 'false';
      expect(await require('../services/visit-groups').ensureLegacyCompletable(fixture.serviceIds[0]))
        .toMatchObject({ ok: false, reason: 'visit_closeout_required' });
      expect(await completeScheduledService({ serviceId: fixture.serviceIds[0], idempotencyKey: randomUUID(),
        actor: submission().actor, body: submission().items[0].body }))
        .toMatchObject({ status: 409, body: { code: 'visit_grouped' } });
      expect(await require('../services/visit-groups').dissolveForLegacyCompletion(fixture.visitId)).toBe(false);
      expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
    }
    const app = require('express')();
    app.use(require('express').json());
    app.use('/api/admin/visit-closeouts', require('../routes/admin-visit-closeouts'));
    app.use('/api/admin/schedule', require('../routes/admin-schedule'));
    app.use('/api/admin/dispatch', require('../routes/admin-dispatch'));
    app.use('/api/visit-summary', require('../routes/visit-summary-public'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    fixture.httpServer = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const request = async (path, { method = 'GET', auth = {}, body } = {}) => {
      const response = await fetch(`http://127.0.0.1:${fixture.httpServer.address().port}${path}`, {
        method, headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': fixture.key },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
    };
    await mockPg('technicians').where({ id: fixture.techId }).update({ employment_status: 'active', auth_token_version: 1, must_change_password: false });
    const token = require('jsonwebtoken').sign({ technicianId: fixture.techId, type: 'access', tokenVersion: 1 }, require('../config').jwt.secret);
    const path = `/api/admin/visit-closeouts/${fixture.visitId}`;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(path)).status).toBe(401);
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ technician_id: null });
    expect((await request(path, { method: 'POST', auth, body: { ...submission(), actor: { techRole: 'admin' } } })).status).toBe(403);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ technician_id: fixture.techId });
    if (fullBehavior) {
      expect((await request(`/api/admin/dispatch/${fixture.serviceIds[0]}/completion-status`, { auth })).status).toBe(409);
      delete process.env.DATA_HYGIENE_VAULT_KEY;
      expect((await request(path, { method: 'POST', auth, body: { items: submission().items } })).status).toBe(503);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
      process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    }
    const date = dateOnly((await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first()).scheduled_date);
    const week = await request(`/api/admin/schedule/week?start=${date}`, { auth });
    expect(week.status).toBe(200);
    expect(week.body.days.flatMap((day) => day.services)).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: true, visitCloseoutPacket: null })
    ))));
    const day = await request(`/api/admin/schedule?date=${date}`, { auth });
    expect(day.status).toBe(200);
    expect(day.body.services).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: true })
    ))));
    const result = await request(path, { method: 'POST', auth, body: { items: submission().items } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ state: 'done', payment: { state: fullBehavior ? 'paid' : 'payment_needed' } });
    expect(result.headers['cache-control']).toContain('no-store');
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    const savedWeek = await request(`/api/admin/schedule/week?start=${date}`, { auth });
    expect(savedWeek.status).toBe(200);
    expect(savedWeek.body.days.flatMap((day) => day.services)).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: fullBehavior,
        visitCloseoutPacket: { id: result.body.packetId, status: 'done' } })
    ))));
    const detail = await request(path, { auth });
    expect(detail.body).toMatchObject({ packet: { status: 'done' }, invoice: { total: 240, status: fullBehavior ? 'paid' : 'scheduled' } });
    expect((await request(`${path}/resume`, { method: 'POST', auth, body: { items: [], actor: { techRole: 'admin' } } })).status).toBe(200);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(require('../services/email-template-library').sendTemplate).toHaveBeenCalledTimes(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(fullBehavior ? 1 : 0);
    const summaryPath = result.body.summaryUrl.replace('/visit/', '/api/visit-summary/');
    const summary = await request(summaryPath);
    expect(summary.status).toBe(200);
    expect(summary.body.services).toHaveLength(2);
    expect(summary.headers['referrer-policy']).toBe('no-referrer');
    expect(summary.headers['x-robots-tag']).toContain('noindex');
    expect(summary.headers['cache-control']).toContain('no-store');
    expect((await request(`${path}/revoke-summary`, { method: 'POST', auth, body: {} })).status).toBe(403);
    await mockPg('technicians').where({ id: fixture.techId }).update({ role: 'admin' });
    expect((await request(path, { auth })).body.canRevokeSummary).toBe(true);
    expect((await request(`${path}/revoke-summary`, { method: 'POST', auth, body: {} })).body).toEqual({ revoked: true });
    const revoked = await request(summaryPath);
    const malformed = await request('/api/visit-summary/not-a-token');
    expect(revoked.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(revoked.body).toEqual(malformed.body);
    const claimToken = randomUUID();
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' })
      .update({ status: 'claimed', claim_token: claimToken, claimed_at: mockPg.fn.now() });
    expect(await require('../services/visit-groups').beginVisitNotificationDispatch(fixture.visitId, 'completion_sms', claimToken)).toBe(false);
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).update({ status: 'sent' });
    const resumed = await request(`${path}/resume`, { method: 'POST', auth, body: {} });
    expect(resumed.status).toBe(200);
    expect(resumed.body.summaryUrl).toBeNull();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(require('../services/email-template-library').sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('new closeouts require the creation gate and summary key before any record commits', async () => {
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    expect(await saveVisitCompletionPacket(submission()))
      .toMatchObject({ status: 404, body: { code: 'visit_closeout_disabled' } });
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    expect(await saveVisitCompletionPacket(submission()))
      .toMatchObject({ status: 503, body: { code: 'visit_closeout_unavailable' } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('Auto Pay grouping becomes eligible only with the full closeout gate and summary key', async () => {
    const { createOrJoinVisit } = require('../services/visit-groups');
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ visit_id: null });
    await mockPg('service_visits').where({ id: fixture.visitId }).del();
    await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    await expect(createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' })).rejects.toThrow('autopay_enrolled');
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    await expect(createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' })).rejects.toThrow('autopay_enrolled');
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    expect(await createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' })).toMatchObject({ behavior_version: 2 });
  });

  test('member recovery keeps forms, reports and operational records without collecting or delivering', async () => {
    fixture.formTemplateId = randomUUID();
    await mockPg('job_form_templates').insert({ id: fixture.formTemplateId,
      service_type: 'Fixture General Pest Control', name: 'Fixture completion checklist',
      sections: JSON.stringify([{ fields: [{ id: 'checked', required: true }] }]), is_active: true });
    const input = submission();
    for (const item of input.items) item.body.formResponses = { checked: true };
    const saved = await saveVisitCompletionPacket(input);
    expect(await mockPg('job_form_submissions').where({ customer_id: fixture.customerId })).toHaveLength(2);
    await Promise.all([runVisitCompletionPacketMemberEffects(saved.body.packetId), runVisitCompletionPacketMemberEffects(saved.body.packetId)]);
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 202, body: { state: 'member_effects_ready' },
    });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((record) => /^[a-f0-9]{32}$/.test(record.report_view_token))).toBe(true);
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect((await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds))
      .every((attempt) => attempt.status === 'succeeded')).toBe(true);
    // Simulate losing the response after the canonical attempt succeeded.
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[1] }).update({ status: 'processing' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('job_form_submissions').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(require('../services/customer-card').ensureCardForCompletion).not.toHaveBeenCalled();
    expect(require('../services/referral-engine').creditReferralOnFirstService).not.toHaveBeenCalled();
  });

  test.each([true, false])('a visible report-token failure remains resumable with SMS requested=%s and no phone', async (sendSms) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ phone: '' });
    const input = submission();
    for (const item of input.items) item.body.sendCompletionSms = sendSms;
    const saved = await saveVisitCompletionPacket(input);
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValueOnce(new Error('Synthetic token outage'));
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 202, body: { state: 'service_effects_pending', code: 'service_report_token_mint_failed' },
    });
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[0] }).first()).toMatchObject({ status: 'processing' });
    expect(await mockPg('service_completion_attempts').where({ service_id: fixture.serviceIds[0] }).first())
      .toMatchObject({ status: 'side_effects_pending' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((record) => /^[a-f0-9]{32}$/.test(record.report_view_token))).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an internal-only report does not block completion on token mint failure', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('service_records').where({ customer_id: fixture.customerId }).update({
      structured_notes: mockPg.raw("structured_notes || ?::jsonb", [JSON.stringify({ typedReportDelivery: 'internal_only' })]),
    });
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValue(new Error('Synthetic token outage'));
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a newly rejected immutable photo caption creates one office exception and leaves the retry queue', async () => {
    const input = submission();
    input.items[0].body.completionPhotos = [{ caption: 'Fixture observation' }];
    const saved = await saveVisitCompletionPacket(input);
    const indicators = require('../services/service-report/activity-indicators');
    const screen = indicators.findBannedCustomerCopy;
    jest.spyOn(indicators, 'findBannedCustomerCopy').mockImplementation((value) =>
      value === 'Fixture observation' ? ['synthetic_caption_rule'] : screen(value));
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 200, body: { state: 'office_required', code: 'photo_caption_banned_copy' },
    });
    expect(await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).toMatchObject({ status: 'failed' });
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[0] }).first()).toMatchObject({ status: 'failed' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('office_required');
    await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).update({ updated_at: new Date(Date.now() - 120000) });
    const attemptCount = (await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId })
      .orderBy('scheduled_service_id')).map((item) => item.attempt_count);
    await resumePendingVisitCompletions();
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId })
      .orderBy('scheduled_service_id')).map((item) => item.attempt_count)).toEqual(attemptCount);
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review', job_id: fixture.serviceIds[0] })).toHaveLength(1);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('an interrupted first effects claim still writes its operational activity', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[0] }).update({ attempt_count: 2 });
    await mockPg('service_completion_attempts').where({ service_id: fixture.serviceIds[0] }).update({
      status: 'side_effects_running', updated_at: new Date(Date.now() - 2 * require('../services/completion-attempts').STALE_SIDE_EFFECTS_MS),
    });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect(require('../services/notification-triggers').triggerNotification).toHaveBeenCalledWith('job_complete',
      expect.objectContaining({ serviceId: fixture.serviceIds[0], customerId: fixture.customerId }),
      expect.objectContaining({ dedupeKey: expect.any(String) }));
  });

  test('a database failure reloading a claimed saved record remains resumable', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const recordId = saved.body.items.find((item) => item.serviceId === fixture.serviceIds[0]).serviceRecordId;
    const execute = mockPg.client._query;
    let interrupted = false;
    jest.spyOn(mockPg.client, '_query').mockImplementation(function failRecordReload(connection, query) {
      if (!interrupted && query.sql.startsWith('select * from "service_records" where "id" =')
          && query.bindings.includes(recordId)) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic record reload outage'));
      }
      return execute.call(this, connection, query);
    });
    await expect(runVisitCompletionPacketMemberEffects(saved.body.packetId)).rejects.toThrow('Synthetic record reload outage');
    expect(interrupted).toBe(true);
    expect(await mockPg('service_completion_attempts').where({ service_id: fixture.serviceIds[0] }).first())
      .toMatchObject({ status: 'side_effects_pending' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
  });

  test('member recovery does not enqueue individually approvable pest recap sends', async () => {
    process.env.PEST_RECAP = 'true';
    const enqueue = jest.spyOn(require('../services/service-report/recap-pipeline'), 'enqueueRecap').mockResolvedValue({ queued: true });
    const saved = await saveVisitCompletionPacket(submission());
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect((await mockPg('service_records').where({ customer_id: fixture.customerId })).every((record) => record.service_line === 'pest')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('backfilled packet recovery stays quiet when report tokens are unavailable', async () => {
    const date = etDateString(new Date(Date.now() - 86400000));
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ scheduled_date: date,
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: date }) });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ scheduled_date: date });
    const input = submission({ actor: { techRole: 'admin', technicianId: fixture.techId } });
    for (const item of input.items) item.body.backfill = true;
    const saved = await saveVisitCompletionPacket(input);
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValue(new Error('Synthetic token outage'));
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(require('../services/customer-card').ensureCardForCompletion).not.toHaveBeenCalled();
    expect(require('../services/referral-engine').creditReferralOnFirstService).not.toHaveBeenCalled();
  });

  test.each([true, false])('interruption after an admin notification does not duplicate activity or push (bell=%s)', async (bell) => {
    await mockPg('notification_preferences').insert({ admin_user_id: fixture.techId, trigger_key: 'job_complete',
      bell_enabled: bell, push_enabled: true, sound_enabled: false });
    jest.spyOn(require('../services/notification-bell-policy'), 'isBellPolicyEnabled').mockReturnValue(false);
    require('../services/notification-triggers').triggerNotification.mockImplementation(
      jest.requireActual('../services/notification-triggers').triggerNotification);
    const saved = await saveVisitCompletionPacket(submission());
    jest.spyOn(require('../services/completion-attempts'), 'markCompletionAttemptSucceeded')
      .mockRejectedValueOnce(new Error('Synthetic interruption after notification'));
    await expect(runVisitCompletionPacketMemberEffects(saved.body.packetId)).rejects.toThrow('Synthetic interruption');
    expect(require('../services/push-notifications').sendToAdminUsers).toHaveBeenCalledTimes(1);
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(require('../services/push-notifications').sendToAdminUsers).toHaveBeenCalledTimes(2);
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect(await mockPg('notifications').whereIn(mockPg.raw("metadata->'payload'->>'serviceId'"), fixture.serviceIds))
      .toHaveLength(bell ? 2 : 0);
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.notification_push_started_at)).toBe(true);
  });

  test('inspection-credit receipts and recovery recognize a non-anchor billed member', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoice = await mockPg('invoices').where({ customer_id: fixture.customerId }).first();
    const member = fixture.serviceIds.find((id) => id !== invoice.scheduled_service_id);
    const offerId = randomUUID();
    const recordedAt = new Date(Date.now() - 11 * 60 * 1000);
    await mockPg('inspection_credit_offers').insert({ id: offerId, customer_id: fixture.customerId,
      source_scheduled_service_id: member,
      source_service_record_id: saved.body.items.find((item) => item.serviceId === member).serviceRecordId,
      amount: 75, status: 'offered', expires_at: new Date(Date.now() + 7 * 86400000),
      created_at: recordedAt, updated_at: recordedAt });
    const invoiceEmail = require('../services/invoice-email');
    const inspection = require('../services/inspection-credit');
    expect(await invoiceEmail.inspectionCreditMemoForInvoice(invoice)).toContain('$75.00 service credit');
    const notify = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue({ id: randomUUID() });
    let observe;
    try {
      await new Promise((resolve) => {
        observe = (_rows, query) => {
          if (query.sql.includes('"status" not in') && query.sql.includes('from "invoices"')
              && query.bindings.includes(member)) resolve();
        };
        mockPg.on('query-response', observe);
        inspection.queueCreditReceiptResend({ scheduledServiceId: member, offerId, attempt: 1 });
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(notify).not.toHaveBeenCalled();
    } finally { mockPg.removeListener('query-response', observe); }
    await mockPg('invoices').where({ id: invoice.id }).update({ status: 'paid', paid_at: new Date() });
    let deliver;
    const receipt = new Promise((resolve) => { deliver = resolve; });
    const sendReceipt = jest.spyOn(invoiceEmail, 'sendReceiptEmail').mockImplementation(async (...args) => {
      deliver(args);
      return { ok: true };
    });
    inspection.queueCreditReceiptResend({ scheduledServiceId: member, offerId, attempt: 1 });
    expect(await receipt).toEqual([invoice.id, { idempotencyKey: `inspection-credit-offer-${offerId}` }]);
    fixture.emailMessageId = randomUUID();
    await mockPg('email_messages').insert({ id: fixture.emailMessageId,
      recipient_email_snapshot: `${fixture.customerId}@example.invalid`, recipient_id: fixture.customerId,
      status: 'sent', trigger_event_id: `invoice_receipt:${invoice.id}`, sent_at: new Date() });
    sendReceipt.mockClear();
    const sweepReads = [];
    const onResult = (rows, query) => {
      if (query.sql.includes('"o"."source_scheduled_service_id" as "visit_id"')) sweepReads.push(rows);
    };
    mockPg.on('query-response', onResult);
    try {
      expect(await inspection.sweepInspectionCreditRedemptions()).not.toHaveProperty('error');
      expect(sweepReads).toHaveLength(2);
      expect(sweepReads.flat()).toEqual([]);
      expect(sendReceipt).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally { mockPg.removeListener('query-response', onResult); }
  });

  test('MOA alerts are persisted once when report-token recovery reruns the member', async () => {
    await mockPg('products_catalog').where({ id: fixture.productId }).update({ moa_group: 'fixture_moa' });
    await mockPg('product_limits').insert({ product_id: fixture.productId, limit_type: 'moa_rotation_max',
      limit_value: 0, severity: 'warning' });
    const input = submission();
    for (const item of input.items) item.body.products = [{ productId: fixture.productId, totalAmount: 1, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft' }];
    const saved = await saveVisitCompletionPacket(input);
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValueOnce(new Error('Synthetic token outage'));
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('service_effects_pending');
    expect(await mockPg('dispatch_alerts').where({ type: 'moa_violation', job_id: fixture.serviceIds[0] })).toHaveLength(1);
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('dispatch_alerts').where({ type: 'moa_violation' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(8);
  });

  test.each(['per_application', 'monthly_membership', 'annual_prepay'])('%s recap-only records need no invoice or billing hold', async (billingMode) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: billingMode });
    const input = submission();
    for (const item of input.items) item.body.oneTimeRecapOnly = true;
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.body.billing).toMatchObject({ state: 'no_charge', invoiceId: null });
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect((await saveVisitCompletionPacket(input)).body.billing).toMatchObject({ state: 'no_charge' });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'no_charge' });
  });

  test.each([
    ['deposit', false], ['deposit', true], ['discount', false], ['discount', true],
  ])('%s covering the whole invoice settles without collection (Auto Pay %s)', async (coverage, autopay) => {
    if (autopay) {
      const methodId = randomUUID();
      await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
        processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
        is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
      await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    }
    if (coverage === 'deposit') {
      const estimateId = randomUUID();
      fixture.estimateIds.push(estimateId);
      await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted' });
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: estimateId });
      await mockPg('estimate_deposits').insert({ estimate_id: estimateId, customer_id: fixture.customerId,
        amount: 240, status: 'received', stripe_payment_intent_id: `pi_fixture_${randomUUID()}` });
    } else {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({
        primary_line_price: 120, discount_type: 'fixed_amount', discount_amount: 120,
        discount_dollars: 120, discount_name: 'Synthetic full discount',
      });
    }
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', total: 0 });
    const invoiceId = saved.body.billing.invoiceId;
    // Billing starts only after the member-effect stage has finished each
    // record. This prerequisite exercises that persisted boundary directly.
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const attempts = await Promise.all([
      collectVisitCompletionInvoice(saved.body.packetId), collectVisitCompletionInvoice(saved.body.packetId),
    ]);
    expect(attempts.some((result) => result.state === 'prepaid')).toBe(true);
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'prepaid', invoiceId });
    const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
    expect(invoice).toMatchObject({ status: 'prepaid', prepaid_prev_status: 'draft', stripe_payment_intent_id: null, scheduled_send_at: null });
    expect(Number(invoice.credit_applied)).toBe(0);
    expect(invoice.paid_at).not.toBeNull();
    expect(await mockPg('payments').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('customer_credit_ledger').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(1);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: 'sent' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    if (coverage === 'deposit') {
      expect(Number((await mockPg('estimate_deposits').where({ estimate_id: fixture.estimateIds[0] }).first()).credited_amount)).toBe(240);
      await InvoiceService.voidInvoice(invoiceId);
      expect(Number((await mockPg('estimate_deposits').where({ estimate_id: fixture.estimateIds[0] }).first()).credited_amount)).toBe(0);
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required' });
    }
  });

  test.each([[0, 240, 'payment_needed'], [240, 0, 'prepaid']])(
    'the locked balance overrides a stale snapshot (%s to %s)', async (before, after, expectedState) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('invoices').where({ id: invoiceId }).update({ total: before });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const editor = await mockPg.transaction();
    await editor('invoices').where({ id: invoiceId }).forUpdate().first();
    let observed;
    const waiting = new Promise((resolve) => { observed = resolve; });
    const onQuery = (query) => {
      if (/select.*"invoices".*for update/i.test(query.sql)) observed();
    };
    mockPg.on('query', onQuery);
    const collection = collectVisitCompletionInvoice(saved.body.packetId);
    try {
      await Promise.race([waiting, collection.then(() => { throw new Error('Collection finished before acquiring the invoice lock'); })]);
      await editor('invoices').where({ id: invoiceId }).update({ total: after });
      await editor.commit();
      expect(await collection).toMatchObject({ state: expectedState });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect((await mockPg('invoices').where({ id: invoiceId }).first()).status).toBe(after === 0 ? 'prepaid' : 'draft');
    } finally {
      mockPg.off('query', onQuery);
      if (!editor.isCompleted()) await editor.rollback();
      await collection;
    }
  });

  test('zero settlement waits for a reminder handoff, then completes its sequence atomically', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0 });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const [sequence] = await mockPg('invoice_followup_sequences').insert({
      invoice_id: invoiceId, customer_id: fixture.customerId, status: 'active',
      touch_claimed_at: new Date(), next_touch_at: new Date(),
    }).returning('*');
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).status).toBe('draft');
    expect((await mockPg('invoice_followup_sequences').where({ id: sequence.id }).first()).status).toBe('active');
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(0);
    await mockPg('invoice_followup_sequences').where({ id: sequence.id }).update({ touch_claimed_at: new Date(Date.now() - 11 * 60 * 1000) });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'prepaid' });
    expect(await mockPg('invoice_followup_sequences').where({ id: sequence.id }).first())
      .toMatchObject({ status: 'completed', touch_claimed_at: null, next_touch_at: null });
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('positive shared-invoice collection remains singular and replays its paid state', async () => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId, selectedMethod, options) => {
      expect(selectedMethod).toBe(methodId);
      expect(options).toMatchObject({ requireAutopayForCustomerId: fixture.customerId, refuseWhenDunningStopped: true });
      await mockPg.transaction(async (trx) => {
        const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first();
        await assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
        await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', stripe_payment_intent_id: 'pi_fixture_visit' });
      });
    });
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await Promise.all([collectVisitCompletionInvoice(saved.body.packetId), collectVisitCompletionInvoice(saved.body.packetId)]);
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'paid' });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds).update({ status: 'succeeded' });
    const status = await require('../services/closeout-status').getCloseoutStatus(fixture.serviceIds[1], { knex: mockPg });
    expect(status.facts.invoice).toMatchObject({ state: 'done', invoiceId: saved.body.billing.invoiceId, status: 'paid' });
    await mockPg('invoices').where({ id: saved.body.billing.invoiceId }).update({ status: 'refunded' });
    expect((await require('../services/closeout-status').getCloseoutStatus(fixture.serviceIds[1], { knex: mockPg })).facts.invoice)
      .toMatchObject({ reason: 'parked_manual_refunded_invoice', refundedInvoiceId: saved.body.billing.invoiceId });
  });

  test.each(['charging', 'charge_review', 'released'])('a %s card hold is rechecked at collection', async (status) => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const estimateId = randomUUID();
    fixture.estimateIds.push(estimateId);
    await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted' });
    await mockPg('estimate_card_holds').insert({ estimate_id: estimateId, customer_id: fixture.customerId,
      scheduled_service_id: fixture.serviceIds[1], status });
    const guarded = mockPg.transaction(async (trx) => {
      const invoice = await trx('invoices').where({ id: saved.body.billing.invoiceId }).forUpdate().first();
      await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      await assertVisitCompletionCharge(trx, invoice, saved.body.packetId);
    });
    if (status === 'released') await expect(guarded).resolves.toBeUndefined();
    else await expect(guarded).rejects.toMatchObject({ code: 'VISIT_PAYMENT_REVIEW_REQUIRED', reason: 'competing_card_consent' });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each([true, false])('a lost decline finalizer uses durable submission evidence (%s)', async (submitted) => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const provider = jest.fn();
    chargeInvoiceWithSavedCard.mockImplementation(async (id, selectedMethod, options) => {
      await mockPg.transaction(async (trx) => {
        const invoice = await trx('invoices').where({ id }).forUpdate().first();
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
      });
      provider();
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: id, payment_method_id: selectedMethod,
        stripe_payment_method_id: 'pm_fixture_visit', idempotency_key: randomUUID(), status: 'failed',
        submitted_at: submitted ? new Date() : null, resolved_at: new Date() });
      throw Object.assign(new Error('Synthetic collection refusal'), { wavesCardDecline: true });
    });
    const groups = require('../services/visit-groups');
    const finalizer = jest.spyOn(groups, 'finalizeVisitNotification').mockRejectedValueOnce(new Error('Synthetic finalizer outage'));
    try {
      await expect(collectVisitCompletionInvoice(saved.body.packetId)).rejects.toThrow('Synthetic finalizer outage');
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' })
        .update({ claimed_at: new Date(Date.now() - 11 * 60 * 1000) });
      expect(await collectVisitCompletionInvoice(saved.body.packetId))
        .toMatchObject({ state: submitted ? 'office_required' : 'payment_failed', invoiceId });
      expect(provider).toHaveBeenCalledTimes(submitted ? 1 : 2);
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: submitted });
      expect(await collectVisitCompletionInvoice(saved.body.packetId))
        .toMatchObject({ state: submitted ? 'office_required' : 'payment_failed' });
      expect(provider).toHaveBeenCalledTimes(submitted ? 1 : 2);
    } finally {
      finalizer.mockRestore();
    }
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a zero balance with an existing payment session stays for office reconciliation', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0, stripe_payment_intent_id: 'pi_fixture_existing' });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required', invoiceId });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required', invoiceId });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).status).toBe('draft');
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(0);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each([false, true])('reviewed packet prices use one connection and preserve estimate lock order (stale=%p)', async (stale) => {
    const pricing = require('../services/completion-pricing');
    const estimateIds = [randomUUID(), randomUUID()];
    const input = submission();
    for (const [index, item] of input.items.entries()) {
      await mockPg('estimates').insert({ id: estimateIds[index], customer_id: fixture.customerId,
        status: 'accepted', address: '100 Synthetic Test Lane, Bradenton, FL 34201', estimate_data: {} });
      await mockPg('scheduled_services').where({ id: item.serviceId }).update({ source_estimate_id: estimateIds[index],
        service_address_line1: '100 Synthetic Test Lane', service_address_city: 'Bradenton', service_address_zip: '34201' });
      const plan = await pricing.loadCompletionPricing(item.serviceId, { database: mockPg, role: 'technician' });
      expect(plan.source.estimate.id).toBe(estimateIds[index]);
      item.body.pricingReview = { witness: plan.view.witness, applyDiscounts: false };
    }
    if (stale) input.items[1].body.pricingReview.witness = '0'.repeat(64);
    const { gates } = require('../config/feature-gates');
    const priorPricingGate = gates.completionServicePricing;
    gates.completionServicePricing = true;
    const shared = mockPg;
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 2000 });
    const queries = [];
    mockPg.on('query', (query) => queries.push(query));
    try {
      if (stale) {
        await expect(saveVisitCompletionPacket(input)).rejects.toMatchObject({ code: 'completion_pricing_changed' });
        expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
        expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      } else {
        expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { state: 'records_saved' } });
        const customerLock = queries.findIndex((query) => query.sql.includes('from "customers"') && query.sql.includes('for no key update'));
        const earlyEstimates = queries.slice(0, customerLock).filter((query) => query.sql.includes('from "estimates"') && query.sql.includes('for share'));
        expect(earlyEstimates.map((query) => query.bindings[0])).toEqual([...estimateIds].sort());
        expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { replayed: true } });
        expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      }
    } finally {
      gates.completionServicePricing = priorPricingGate;
      await mockPg.destroy();
      mockPg = shared;
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: null });
      await mockPg('estimates').whereIn('id', estimateIds).del();
    }
  });

  test('a rejected second form rolls back the first record, status and claim', async () => {
    const input = submission();
    const photoKey = `fixture/${fixture.serviceIds[0]}/before.png`;
    await mockPg('scheduled_service_photo_staging').insert({
      scheduled_service_id: fixture.serviceIds[0], technician_id: fixture.techId,
      photo_type: 'before', s3_key: photoKey, image_sha256: '0'.repeat(64),
    });
    input.items[1].body.clientPestRating = 99;
    const result = await saveVisitCompletionPacket(input);
    expect(result).toMatchObject({ status: 400, body: { code: 'client_pest_rating_invalid', serviceId: fixture.serviceIds[1] } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await mockPg('job_status_history').whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).status).toBe('open');
    expect((await mockPg('scheduled_services').whereIn('id', fixture.serviceIds)).every((row) => row.status === 'on_site')).toBe(true);
    expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(1);
    expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(0);
    expect((await saveVisitCompletionPacket(submission())).status).toBe(202);
    expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(0);
    expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(1);
  });

  test('concurrent double taps converge on one packet and one record per service', async () => {
    const results = await Promise.all([saveVisitCompletionPacket(submission()), saveVisitCompletionPacket(submission())]);
    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(new Set(results.map((result) => result.body.packetId)).size).toBe(1);
    expect(results.filter((result) => result.body.replayed)).toHaveLength(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    const invoices = await mockPg('invoices').where({ customer_id: fixture.customerId });
    expect(invoices).toHaveLength(1);
    expect(new Set(results.map((result) => result.body.billing.invoiceId))).toEqual(new Set([invoices[0].id]));
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: results[0].body.packetId }).pluck('invoice_id'))
      .toEqual([invoices[0].id, invoices[0].id]);
  });

  test('a retry cannot change saved outcomes or use a new key', async () => {
    const first = await saveVisitCompletionPacket(submission());
    expect(first.status).toBe(202);
    const changed = submission();
    changed.items[1].body.visitOutcome = 'incomplete';
    expect(await saveVisitCompletionPacket(changed)).toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
    expect(await saveVisitCompletionPacket(submission({ idempotencyKey: randomUUID() })))
      .toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
  });

  test('an individual endpoint cannot claim a saved member for billing and delivery', async () => {
    expect((await saveVisitCompletionPacket(submission())).status).toBe(202);
    const input = submission();
    const result = await completeScheduledService({ serviceId: fixture.serviceIds[0], body: input.items[0].body,
      actor: input.actor, idempotencyKey: randomUUID() });
    expect(result).toMatchObject({ status: 409, body: { code: 'visit_grouped' } });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an incomplete member keeps its own outcome beside a completed service', async () => {
    const input = submission();
    for (const item of input.items) item.body.products = [{
      productId: fixture.productId, totalAmount: 2, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft',
    }];
    input.items[1].body.visitOutcome = 'incomplete';
    input.items[1].body.incompleteReason = 'Postponed at customer request';
    expect((await saveVisitCompletionPacket(input)).status).toBe(202);
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
    expect(records.map((record) => record.status)).toEqual(['completed', 'incomplete']);
    expect(records[1].structured_notes).toMatchObject({ visitOutcome: 'incomplete' });
    const invoice = await mockPg('invoices').where({ customer_id: fixture.customerId }).first();
    expect(Number(invoice.total)).toBe(120);
    expect(invoice.line_items.filter((line) => line.amount > 0)).toHaveLength(1);
    expect(await mockPg('service_products').whereIn('service_record_id', records.map((record) => record.id))).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(6);
    expect(await mockPg('product_inventory_movements').where({ product_id: fixture.productId })).toHaveLength(2);
    expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(6);
  });

  test('a late product validator rolls back earlier inventory deductions too', async () => {
    const input = submission();
    input.items[0].body.products = [{ productId: fixture.productId, totalAmount: 2, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft' }];
    input.items[1].body.products = [{ productId: fixture.productId, totalAmount: 2, amountUnit: 'invalid_fixture_unit' }];
    await expect(saveVisitCompletionPacket(input)).rejects.toMatchObject({ isOperational: true, statusCode: 400 });
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(10);
    expect(await mockPg('product_inventory_movements').where({ product_id: fixture.productId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('a missing form or another technician cannot freeze the visit', async () => {
    expect(await saveVisitCompletionPacket(submission({ actor: { techRole: 'technician', technicianId: randomUUID() } })))
      .toMatchObject({ status: 403 });
    const input = submission();
    input.items[1].serviceId = randomUUID();
    expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('one invoice preserves each stored service discount and its member identity', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ estimated_price: 90, primary_line_price: 100 });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ estimated_price: 150, primary_line_price: 175 });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'invoice_ready', total: 240 });
    const invoice = await mockPg('invoices').where({ id: result.body.billing.invoiceId }).first();
    expect(Number(invoice.subtotal)).toBe(275);
    expect(Number(invoice.discount_amount)).toBe(35);
    expect(Number(invoice.tax_amount)).toBe(0);
    expect(invoice.line_items.filter((line) => line.amount > 0).map((line) => line.client_id))
      .toEqual(fixture.serviceIds.map((id) => `scheduled_${id}_primary`));
    expect(invoice.visit_completion_packet_id).toBe(result.body.packetId);
    expect(dateOnly(invoice.due_date)).toBe(etDateString());
    expect((await createVisitCompletionInvoice(result.body.packetId)).invoiceId).toBe(invoice.id);
  });

  test.each([0, 102])('a reviewed application discount reaches the shared invoice with a %s fixed adjustment', async (adjustment) => {
    const estimateId = randomUUID();
    fixture.estimateIds.push(estimateId);
    const key = `fixture_${fixture.catalogId}`;
    await mockPg('customers').where({ id: fixture.customerId }).update({ per_application_fee: 120 });
    await mockPg('services').where({ id: fixture.catalogId }).update({ frequency: 'quarterly', billing_type: 'recurring', visits_per_year: 4 });
    await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted',
      address: '100 Synthetic Test Lane, Bradenton, FL 34201', estimate_data: { result: { recurring: { services: [{
        service: 'pest_control', serviceKey: key, name: 'Fixture General Pest Control', perTreatment: 120,
        priceAfterDiscount: 102, visitsPerYear: 4, frequency: 'quarterly', discount: { effectiveDiscount: 0.15 },
      }] } } } });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: estimateId,
      service_address_line1: '100 Synthetic Test Lane', service_address_city: 'Bradenton', service_address_zip: '34201' });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({
      is_recurring: true, recurring_pattern: 'quarterly', primary_line_price: 120, estimated_price: 120 - adjustment,
    });
    if (adjustment) {
      fixture.discountId = randomUUID();
      await mockPg('discounts').insert({ id: fixture.discountId, discount_key: `fixture_${fixture.discountId}`,
        name: 'Synthetic fixed adjustment', discount_type: 'fixed_amount', amount: adjustment, is_stackable: true });
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ discount_id: fixture.discountId,
        discount_name: 'Synthetic fixed adjustment', discount_type: 'fixed_amount', discount_amount: adjustment, discount_dollars: adjustment });
    }
    const { gates } = require('../config/feature-gates');
    const prior = [gates.completionServicePricing, gates.editApptPriceServiceScope];
    gates.completionServicePricing = true;
    gates.editApptPriceServiceScope = true;
    try {
      const plan = await require('../services/completion-pricing').loadCompletionPricing(fixture.serviceIds[0], { database: mockPg, role: 'admin' });
      expect(plan.view).toMatchObject({ canApply: true, proposedAmount: 102 - adjustment });
      const input = submission({ actor: { techRole: 'admin', technicianId: fixture.techId } });
      input.items[0].body.pricingReview = { witness: plan.view.witness, applyDiscounts: true };
      const result = await saveVisitCompletionPacket(input);
      expect(result.body.billing).toMatchObject({ state: 'invoice_ready', total: 222 - adjustment });
      const record = await mockPg('service_records').where({ scheduled_service_id: fixture.serviceIds[0] }).first();
      expect(record.structured_notes.completionPricing.amountCents).toBe((102 - adjustment) * 100);
      expect((await saveVisitCompletionPacket(input)).body.billing.invoiceId).toBe(result.body.billing.invoiceId);
      expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    } finally {
      [gates.completionServicePricing, gates.editApptPriceServiceScope] = prior;
    }
  });

  test.each(['per_application', 'per_visit', 'one_time'])('an unflagged callback stays free in the %s lane', async (billingMode) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: billingMode });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ is_callback: true });
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', total: 120 });
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).whereNotNull('invoice_id'))
      .toEqual([expect.objectContaining({ scheduled_service_id: fixture.serviceIds[0] })]);
  });

  test('the explicit invoice-on-complete callback override keeps its canonical charge', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({
      is_callback: true, create_invoice_on_complete: true,
    });
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', total: 240 });
  });

  test.each([
    ['draft', 'completed'], ['void', 'completed'], ['refunded', 'completed'],
    ['paid', 'inspection_only'], ['paid', 'customer_declined'],
  ])('billing recovery recognizes the %s shared invoice for a %s member', async (status, outcome) => {
    const input = submission();
    input.items[1].body.visitOutcome = outcome;
    const saved = await saveVisitCompletionPacket(input);
    await mockPg('invoices').where({ id: saved.body.billing.invoiceId }).update({ status });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ completed_at: mockPg.fn.now() });
    const router = require('../routes/admin-billing-recovery');
    const handler = router.stack.find((layer) => layer.route?.path === '/leaks').route.stack.at(-1).handle;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler({ query: { days: 1 } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(fixture.customerId);
    // Positive control: without the packet's secondary-member link, this
    // exact completed work really would enter the existing recovery queue.
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[1] }).update({ service_record_id: null });
    res.json.mockClear();
    await handler({ query: { days: 1 } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].needs_review)
      .toEqual(expect.arrayContaining([expect.objectContaining({ scheduled_service_id: fixture.serviceIds[1] })]));
  });
  test.each(['pest', 'lawn'])('concurrent submissions need only their transaction connection for %s helpers', async (lane) => {
    if (lane === 'lawn') {
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ service_type: 'WaveGuard Lawn Care' });
    }
    await mockPg('customers').where({ id: fixture.customerId }).update({
      property_type: 'commercial', autopay_enabled: true,
    });
    const normalPool = mockPg;
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 30000 });
    const flags = require('../services/feature-flags').isUserFeatureEnabled;
    const context = require('../services/recap-visit-context').buildRecapVisitContext;
    flags.mockImplementation(jest.requireActual('../services/feature-flags').isUserFeatureEnabled);
    context.mockImplementation(jest.requireActual('../services/recap-visit-context').buildRecapVisitContext);
    const recap = jest.spyOn(require('../services/completion-recap'), 'generateRecap')
      .mockResolvedValue({ recap: 'The service record is ready.', source: 'fixture' });
    try {
      const input = submission();
      for (const item of input.items) delete item.body.customerRecap;
      const results = await Promise.allSettled([saveVisitCompletionPacket(input), saveVisitCompletionPacket(input)]);
      expect(results).toEqual([
        expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ status: 202 }) }),
        expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ status: 202 }) }),
      ]);
      expect(new Set(results.map((result) => result.value.body.packetId)).size).toBe(1);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      expect(context).toHaveBeenCalled();
    } finally {
      recap.mockRestore();
      flags.mockImplementation(async () => false);
      context.mockImplementation(async () => '');
      await mockPg.destroy();
      mockPg = normalPool;
    }
  });

  test('commercial tax and an estimate deposit settle once on the same invoice', async () => {
    const estimateId = randomUUID();
    fixture.estimateIds.push(estimateId);
    await mockPg('customers').where({ id: fixture.customerId }).update({ property_type: 'business', zip: '34209' });
    await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted' });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: estimateId });
    await mockPg('estimate_deposits').insert({ estimate_id: estimateId, customer_id: fixture.customerId,
      amount: 70, status: 'received', stripe_payment_intent_id: `pi_fixture_${randomUUID()}` });
    const result = await saveVisitCompletionPacket(submission());
    const invoice = await mockPg('invoices').where({ id: result.body.billing.invoiceId }).first();
    expect(Number(invoice.subtotal)).toBe(240);
    const tax = await require('../services/tax-calculator').calculateTax(fixture.customerId, 'Fixture General Pest Control', 240);
    expect(Number(invoice.tax_amount)).toBe(tax.amount);
    expect(Number(invoice.total)).toBe(Math.round((240 + tax.amount - 70) * 100) / 100);
    const deposit = await mockPg('estimate_deposits').where({ estimate_id: estimateId }).first();
    expect(Number(deposit.credited_amount)).toBe(70);
    expect(deposit.credited_invoice_id).toBe(invoice.id);
    expect(invoice.line_items.find((line) => line.category === 'deposit_credit')).toMatchObject({ amount: -70, estimate_id: estimateId });
    expect((await saveVisitCompletionPacket(submission())).body.billing.invoiceId).toBe(invoice.id);
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: estimateId }).first()).credited_amount)).toBe(70);
  });

  test('individual scheduled, record-linked and recovery mints refuse packet-owned members', async () => {
    const result = await saveVisitCompletionPacket(submission());
    for (const item of result.body.items) {
      const common = { customerId: fixture.customerId, lineItems: [{ description: 'Fixture service', quantity: 1, unit_price: 120 }] };
      await expect(InvoiceService.create({ ...common, scheduledServiceId: item.serviceId }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
      await expect(InvoiceService.create({ ...common, serviceRecordId: item.serviceRecordId }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
      const svc = await mockPg('scheduled_services').where({ id: item.serviceId }).first();
      await expect(mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams: () => ({ ...common, scheduledServiceId: svc.id }) }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
      await expect(InvoiceService.createFromService(item.serviceRecordId, { amount: 120, useScheduledReplay: true }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
    }
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each(['paid', 'refunded', 'draft', 'void'])('a member with a %s invoice parks billing without creating another invoice', async (status) => {
    const prior = await InvoiceService.create({ customerId: fixture.customerId, scheduledServiceId: fixture.serviceIds[0],
      lineItems: [{ description: 'Fixture service', quantity: 1, unit_price: 120 }] });
    await mockPg('invoices').where({ id: prior.id }).update({ status });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(true);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each(['annual_prepay', 'monthly_membership'])('the %s lane keeps its existing financial contract', async (billingMode) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: billingMode });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'covered_billing_lane' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('a missing member price cannot inherit a whole-plan per-application fee', async () => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: 'per_application', per_application_fee: 240 });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ estimated_price: null });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'member_price_missing' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('no performed applications means no invoice, including on replay', async () => {
    const input = submission();
    for (const item of input.items) item.body.visitOutcome = 'inspection_only';
    expect((await saveVisitCompletionPacket(input)).body.billing).toEqual({ state: 'no_charge', invoiceId: null });
    expect((await saveVisitCompletionPacket(input)).body.billing).toEqual({ state: 'no_charge', invoiceId: null });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('a granted retention offer consumes one charge for its family across the group', async () => {
    await mockPg('services').where({ id: fixture.catalogId }).update({ engine_keys: JSON.stringify(['pest_control']) });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ is_recurring: true });
    const [offer] = await mockPg('retention_offers').insert({ customer_id: fixture.customerId,
      family_key: 'pest_control', percent_off: 15, max_charges: 2, cap_amount: 75, status: 'granted' }).returning('*');
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'invoice_ready', total: 204 });
    const saved = await mockPg('retention_offers').where({ id: offer.id }).first();
    expect(saved.charges_applied).toBe(1);
    expect(Number(saved.amount_applied)).toBe(36);
    expect(saved.applied_invoice_ids).toEqual([result.body.billing.invoiceId]);
    await saveVisitCompletionPacket(submission());
    expect((await mockPg('retention_offers').where({ id: offer.id }).first()).charges_applied).toBe(1);
  });

  test('a failure after invoice insertion rolls back the invoice and every service record', async () => {
    const create = InvoiceService.create;
    const fault = jest.spyOn(InvoiceService, 'create').mockImplementation(async (...args) => {
      await create.apply(InvoiceService, args);
      throw new Error('Injected failure after durable invoice insert');
    });
    try {
      await expect(saveVisitCompletionPacket(submission())).rejects.toThrow('Injected failure');
    } finally { fault.mockRestore(); }
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).status).toBe('open');
    expect((await saveVisitCompletionPacket(submission())).body.billing.state).toBe('invoice_ready');
  });

  test('reversing the shared invoice parks replay and cannot mint a replacement', async () => {
    const result = await saveVisitCompletionPacket(submission());
    await mockPg('invoices').where({ id: result.body.billing.invoiceId }).update({ status: 'refunded' });
    expect((await saveVisitCompletionPacket(submission())).body.billing).toMatchObject({
      state: 'office_required', reason: 'shared_invoice_reversed', invoiceId: result.body.billing.invoiceId,
    });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
  });

  test('a per-job payer and a prepaid member keep homeowner billing held', async () => {
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Bill-To', ap_email: 'fixture@example.invalid' }).returning('id');
    fixture.payerId = payer.id;
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ payer_id: payer.id });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'payer_billed_member' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('a partial prepaid stamp cannot be charged again through the group', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ prepaid_amount: 70, prepaid_method: 'cash' });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'prepaid_member' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('a concurrent legacy mint that wins the shared lock is seen before group billing', async () => {
    const trx = await mockPg.transaction();
    let closeout;
    try {
      await acquireScheduledInvoiceMintLock(trx, fixture.serviceIds[0]);
      closeout = saveVisitCompletionPacket(submission());
      // The invoice writer owns the same lock the closeout is waiting for.
      await InvoiceService.create({ database: trx, customerId: fixture.customerId,
        scheduledServiceId: fixture.serviceIds[0], lineItems: [{ description: 'Fixture service', quantity: 1, unit_price: 120 }] });
      await trx.commit();
    } catch (error) { await trx.rollback(); throw error; }
    const result = await closeout;
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
  });

  test('the database refuses a second invoice for the same packet', async () => {
    const result = await saveVisitCompletionPacket(submission());
    await expect(mockPg.transaction((trx) => InvoiceService.create({
      database: trx, customerId: fixture.customerId, scheduledServiceId: fixture.serviceIds[0],
      lineItems: [{ description: 'Fixture duplicate', quantity: 1, unit_price: 120 }],
    }, { packetId: result.body.packetId }))).rejects.toMatchObject({ code: '23505', constraint: 'invoices_visit_packet_owner_unique' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
  });
  test('a second lawn member sees the first member’s uncommitted nitrogen and inventory use', async () => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ waveguard_tier: 'Bronze' });
    await mockPg('services').where({ id: fixture.catalogId }).update({ name: 'Fixture Lawn Care' });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'WaveGuard Lawn Care' });
    await mockPg('customer_turf_profiles').insert({ customer_id: fixture.customerId,
      grass_type: 'st_augustine', lawn_sqft: 1000, annual_n_budget_target: 0.15, active: true });
    await mockPg('products_catalog').where({ id: fixture.productId }).update({
      analysis_n: 10, category: 'fertilizer', inventory_unit: 'lb', inventory_on_hand: 1.5,
    });
    const input = submission();
    for (const item of input.items) item.body.products = [{ productId: fixture.productId,
      totalAmount: 1, amountUnit: 'lb', applicationMethod: 'broadcast', areaValue: 1000, areaUnit: 'sqft' }];
    const result = await saveVisitCompletionPacket(input);
    expect(result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
    expect(records[1].structured_notes.waveguardNLimitApproval).toMatchObject({
      advisory: true, annualN: { used: 0.1 },
      blocks: expect.arrayContaining([expect.objectContaining({ code: 'actual_annual_n_budget_exceeded' })]),
    });
    expect(await mockPg('property_nutrient_ledger').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(-0.5);
    expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
    expect(await mockPg('property_nutrient_ledger').where({ customer_id: fixture.customerId })).toHaveLength(2);
  });

  test('joining under the closeout gate cannot rewrite an existing legacy visit contract', async () => {
    await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
    await expect(require('../services/visit-groups').createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' }))
      .rejects.toThrow('closeout behavior differs');
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ behavior_version: 1, status: 'open' });
    expect(await mockPg('scheduled_services').where({ visit_id: fixture.visitId })).toHaveLength(2);
  });

  test('a transient email dispatch-claim failure retries the same email instead of suppressing it', async () => {
    const groups = require('../services/visit-groups');
    const begin = groups.beginVisitNotificationDispatch;
    let fail = true;
    const dispatch = jest.spyOn(groups, 'beginVisitNotificationDispatch').mockImplementation(async (...args) => {
      if (args[1] === 'completion_email' && fail) { fail = false; throw new Error('Synthetic database interruption'); }
      return begin(...args);
    });
    try {
      const saved = await saveVisitCompletionPacket(submission());
      expect(await runVisitCompletionPacketEffects(saved.body.packetId)).toMatchObject({ status: 202, body: { state: 'effects_pending' } });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
        .toMatchObject({ status: 'failed' });
      expect(await runVisitCompletionPacketEffects(saved.body.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const email = require('../services/email-template-library').sendTemplate;
      expect(email).toHaveBeenCalledTimes(2);
      expect(email.mock.calls[1][0].idempotencyKey).toBe(email.mock.calls[0][0].idempotencyKey);
    } finally { dispatch.mockRestore(); }
  });
});
