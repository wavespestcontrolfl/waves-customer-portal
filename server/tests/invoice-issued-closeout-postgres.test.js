// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The completion itself is mocked — this covers WHICH visit closes (linked
// invoices only), the gate, resume, and the quiet posture handed to the
// canonical completion.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
const mockCompleteScheduledService = jest.fn(async () => ({ status: 200, body: { success: true } }));
jest.mock('../services/complete-scheduled-service', () => ({ completeScheduledService: (...a) => mockCompleteScheduledService(...a) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));
// Outage injection for the two pre-completion probes: a test may replace
// the packet-ownership assert or the profile resolver for one call.
const mockProbe = { packetAssert: null, profile: null, profileCalls: [] };
jest.mock('../services/scheduled-invoice-mint', () => {
  const actual = jest.requireActual('../services/scheduled-invoice-mint');
  return { ...actual, assertScheduledInvoiceNotPacketOwned: (...a) => (mockProbe.packetAssert ? mockProbe.packetAssert(...a) : actual.assertScheduledInvoiceNotPacketOwned(...a)) };
});
jest.mock('../services/service-completion-profiles', () => {
  const actual = jest.requireActual('../services/service-completion-profiles');
  return {
    ...actual,
    resolveCompletionProfileForScheduledService: (svc, knex, opts) => {
      mockProbe.profileCalls.push(opts);
      return mockProbe.profile ? mockProbe.profile(svc, knex, opts) : actual.resolveCompletionProfileForScheduledService(svc, knex, opts);
    },
  };
});
// The gate table is built at module load from process.env; the test flips
// the gate through a mock instead of racing the require.
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: (gate) => gate === 'invoiceIssuedClosesVisit' && mockGate.on }));
const { randomUUID } = require('node:crypto');
const { resolveVisitForIssuedInvoice, closeOutVisitForIssuedInvoice, retrySettledStatementCloseouts } = require('../services/invoice-issued-closeout');
const { recordAuditEvent } = require('../services/audit-log');

const { backfillCompletionPlan, backfillCompletionEndInstant } = jest.requireActual('../services/complete-scheduled-service');

describe('backfillCompletionPlan same-day switch', () => {
  test('the panel rule stays past-only; the internal issued-invoice trigger admits today, never the future', () => {
    const base = { backfill: true, role: 'admin', today: '2040-03-04' };
    expect(backfillCompletionPlan({ ...base, scheduledDate: '2040-03-04' }).error.code).toBe('backfill_not_past');
    expect(backfillCompletionPlan({ ...base, scheduledDate: '2040-03-04', allowSameDay: true })).toEqual({ active: true, serviceDate: '2040-03-04' });
    expect(backfillCompletionPlan({ ...base, scheduledDate: '2040-03-05', allowSameDay: true }).error.code).toBe('backfill_not_past');
    expect(backfillCompletionPlan({ ...base, scheduledDate: '2040-03-03', allowSameDay: true })).toEqual({ active: true, serviceDate: '2040-03-03' });
  });

  test('a same-day backfill ends at the closeout itself; earlier days keep ET noon; no anchor keeps the noon contract', () => {
    const now = new Date('2040-03-04T15:20:00Z'); // 10:20 ET on 2040-03-04 (EST)
    expect(backfillCompletionEndInstant('2040-03-04', null, {}, { now }).getTime()).toBe(now.getTime());
    expect(backfillCompletionEndInstant('2040-03-03', null, {}, { now }).toISOString()).toBe('2040-03-03T17:00:00.000Z');
    expect(backfillCompletionEndInstant('2040-03-04', null, {}).toISOString()).toBe('2040-03-04T17:00:00.000Z');
  });
});

postgres('invoice issued ⇒ visit completed (migrated PostgreSQL)', () => {
  let database;
  let trx;
  let customerId;
  const TODAY = '2040-03-04';
  // A SEND never closes a visit scheduled TODAY (invoice-issued-closeout
  // `visit_scheduled_today`, Codex P1 r7 #4131) — the office picker links a
  // pre-completion invoice to today's open visit and texts it before the
  // tech arrives. So the fixtures default to YESTERDAY, the ordinary shape
  // for a send-triggered closeout; the same-day rule has its own assertions
  // in the resolver test below, which date their visit to TODAY explicitly.
  const YESTERDAY = '2040-03-03';

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    mockGate.on = true;
    mockProbe.packetAssert = null;
    mockProbe.profile = null;
    mockProbe.profileCalls = [];
    mockCompleteScheduledService.mockClear();
    recordAuditEvent.mockClear();
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
  });
  afterEach(async () => { await trx.rollback(); require('../models/db').connection = database; });
  afterAll(async () => { await database.destroy(); });

  async function visit({ status = 'confirmed', date = YESTERDAY, serviceType = 'Quarterly Pest Control Service', ...rest } = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({ id, customer_id: customerId, scheduled_date: date, service_type: serviceType, status, ...rest });
    return trx('scheduled_services').where({ id }).first();
  }
  async function invoice({ status = 'sent', date = YESTERDAY, serviceType = 'Quarterly Pest Control Service', ...rest } = {}) {
    const id = randomUUID();
    await trx('invoices').insert({
      id, customer_id: customerId, invoice_number: `TST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total: 117, subtotal: 117, service_date: date, service_type: serviceType,
      line_items: JSON.stringify([{ description: serviceType, amount: 117, quantity: 1, unit_price: 117 }]),
      ...rest,
    });
    return trx('invoices').where({ id }).first();
  }

  test('a linked open visit on or before today resolves; closed, future and cancelled visits do not', async () => {
    const open = await visit({ date: TODAY });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: open.id, date: TODAY }), { today: TODAY })).svc.id).toBe(open.id);
    const past = await visit({ date: '2040-02-20', status: 'pending' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: past.id, date: '2040-02-20' }), { today: TODAY })).svc.id).toBe(past.id);
    // A SEND leaves a visit scheduled for TODAY open (Codex P1 r7 #4131): the
    // office picker sends pre-completion invoices for today's visits before
    // the tech arrives. A payment still closes it; a past day closes on a send.
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: open.id, date: TODAY }), { today: TODAY, trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_scheduled_today' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: open.id, date: TODAY }), { today: TODAY, trigger: 'paid' })).svc.id).toBe(open.id);
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: past.id, date: '2040-02-20' }), { today: TODAY, trigger: 'sent' })).svc.id).toBe(past.id);
    // YESTERDAY is the fixture default precisely because it closes on a send.
    const yesterday = await visit();
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: yesterday.id }), { today: TODAY, trigger: 'sent' })).svc.id).toBe(yesterday.id);
    // In-progress visits stay with their technician (GitHub r9 P1): a running
    // job timer and a completion of their own — the office closeout leaves them.
    const onSite = await visit({ date: '2040-02-21', status: 'on_site' });
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: onSite.id, date: '2040-02-21' }), { today: TODAY })).toMatchObject({ svc: null, reason: 'visit_on_site' });
    const enRoute = await visit({ date: '2040-02-22', status: 'en_route' });
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: enRoute.id, date: '2040-02-22' }), { today: TODAY })).toMatchObject({ svc: null, reason: 'visit_en_route' });
    const future = await visit({ date: '2040-03-05' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: future.id, date: '2040-03-05' }), { today: TODAY })).reason).toBe('visit_in_future');
    const done = await visit({ status: 'completed', date: '2040-02-01' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: done.id, date: '2040-02-01' }), { today: TODAY })).reason).toBe('visit_completed');
    // A legacy NULL-status row is live (the picker links to it) — it closes out too (Codex P2 r8).
    const legacy = await visit({ status: null, date: '2040-02-25' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: legacy.id, date: '2040-02-25' }), { today: TODAY, trigger: 'paid' })).svc.id).toBe(legacy.id);
    const dead = await visit({ status: 'cancelled', date: '2040-02-02' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: dead.id, date: '2040-02-02' }), { today: TODAY })).reason).toBe('visit_cancelled');
  });

  test('a linked open visit closes with the quiet posture handed to the canonical completion', async () => {
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', actorTechnicianId: null, conn: trx, today: TODAY });
    expect(out).toMatchObject({ closed: true, visitId: open.id, resumed: false });
    expect(mockCompleteScheduledService).toHaveBeenCalledTimes(1);
    const call = mockCompleteScheduledService.mock.calls[0][0];
    expect(call.serviceId).toBe(open.id);
    expect(call.body).toMatchObject({ visitOutcome: 'completed', backfill: true, sendCompletionSms: false, requestReview: false, invoiceAlreadySent: true });
    expect(call.issuedInvoiceCloseout).toEqual({ invoiceId: inv.id, trigger: 'sent' });
    expect(call.actor).toEqual({ techRole: 'admin', technicianId: null, technician: null });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completed_on_invoice_issued', resource_id: open.id, actor_type: 'system', actor_id: null }));
  });

  test('the operator behind the send is the completion actor; an automated trigger acts as the system, never as the visit technician', async () => {
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Fixture Technician', role: 'technician', active: true });
    const automated = await visit({ technician_id: techId });
    await closeOutVisitForIssuedInvoice({ invoiceId: (await invoice({ scheduled_service_id: automated.id })).id, trigger: 'paid', conn: trx, today: TODAY });
    expect(mockCompleteScheduledService.mock.calls[0][0].actor).toEqual({ techRole: 'admin', technicianId: null, technician: null });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: automated.id, actor_type: 'system', actor_id: null }));
    mockCompleteScheduledService.mockClear();
    recordAuditEvent.mockClear();
    const byOperator = await visit({ technician_id: techId, date: '2040-03-01' });
    await closeOutVisitForIssuedInvoice({ invoiceId: (await invoice({ scheduled_service_id: byOperator.id, date: '2040-03-01' })).id, trigger: 'sent', actorTechnicianId: 'admin-1', conn: trx, today: TODAY });
    expect(mockCompleteScheduledService.mock.calls[0][0].actor.technicianId).toBe('admin-1');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: byOperator.id, actor_type: 'admin', actor_id: 'admin-1' }));
  });

  test('a technician-triggered closeout is audited as technician, never folded into admin — but keeps admin authorization posture (GitHub r7 P2 #4127)', async () => {
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Fixture Tech', role: 'technician', active: true });
    const svc = await visit();
    const inv = await invoice({ scheduled_service_id: svc.id });
    await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', actorTechnicianId: techId, actorRole: 'technician', conn: trx, today: TODAY });
    // Audit identity is the TRUE role — the /api/admin/schedule/:id/prepaid
    // route admits technicians (admin-schedule.js requireTechOrAdmin) and
    // now threads req.techRole through; a technician-triggered closeout
    // must not read as an administrator's action.
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: svc.id, actor_type: 'technician', actor_id: techId }));
    // Authorization posture is UNCHANGED — the quiet backfill completion
    // still runs with techRole 'admin' regardless of who triggered it (the
    // completion's admin-only gates must keep passing).
    expect(mockCompleteScheduledService.mock.calls[0][0].actor).toEqual({ techRole: 'admin', technicianId: techId, technician: null });
    mockCompleteScheduledService.mockClear();
    recordAuditEvent.mockClear();
    // A caller that omits actorRole (every admin-only route: reconcile,
    // send-receipt, the SMS/email delivery legs) keeps the prior default —
    // a non-null actor is still audited as 'admin'.
    const svc2 = await visit({ date: '2040-03-02' });
    const inv2 = await invoice({ scheduled_service_id: svc2.id, date: '2040-03-02' });
    await closeOutVisitForIssuedInvoice({ invoiceId: inv2.id, trigger: 'paid', actorTechnicianId: techId, conn: trx, today: TODAY });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: svc2.id, actor_type: 'admin', actor_id: techId }));
  });

  test('a linked invoice voided before the closeout reads it is audited as refused (invoice_void) against its visit (GitHub r7 P2)', async () => {
    const svc = await visit();
    const inv = await invoice({ scheduled_service_id: svc.id });
    await trx('invoices').where({ id: inv.id }).update({ status: 'void' });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', actorTechnicianId: 'admin-1', conn: trx, today: TODAY });
    expect(out).toMatchObject({ closed: false, reason: 'invoice_void', visitId: svc.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: svc.id, action: 'visit.completion_on_invoice_issued_refused', metadata: expect.objectContaining({ code: 'invoice_void' }) }));
  });

  test('a record-only linked invoice voided before the closeout reads it is still audited (invoice_void) against its visit; a statement closeout reaches record-only children (GitHub r12 P2)', async () => {
    const day = '2020-01-06';
    const open = await visit({ status: 'on_site', date: day });
    const recordId = randomUUID();
    await trx('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: open.id, service_date: day, service_type: open.service_type });
    const inv = await invoice({ service_record_id: recordId, status: 'void', date: day });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'invoice_void', visitId: open.id });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: open.id, metadata: expect.objectContaining({ code: 'invoice_void' }) }));
    recordAuditEvent.mockClear();
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const [statementId] = await trx('payer_statements').insert({
      payer_id: payerId, period_start: '2020-01-01', period_end: '2020-01-31', status: 'paid', terms_snapshot: 'net30', token: randomUUID().replace(/-/g, ''), paid_at: new Date(),
    }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const recordOnly = await visit({ status: 'on_site', date: day });
    const recordOnlyRecord = randomUUID();
    await trx('service_records').insert({ id: recordOnlyRecord, customer_id: customerId, scheduled_service_id: recordOnly.id, service_date: day, service_type: recordOnly.service_type });
    await invoice({ status: 'paid', date: day, payer_statement_id: statementId, service_record_id: recordOnlyRecord });
    const { closeOutVisitsForStatement } = require('../services/invoice-issued-closeout');
    expect(await closeOutVisitsForStatement(statementId, { trigger: 'paid', conn: trx })).toEqual({ attempted: 1, closed: 0, failed: [] });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: recordOnly.id, metadata: expect.objectContaining({ code: 'record_linked_only', trigger: 'paid' }) }));
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });
  test('a linked visit left open is audited as refused with the reason; an invoice with no visit link is logged only', async () => {
    const future = await visit({ date: '2040-03-05' });
    const inv = await invoice({ scheduled_service_id: future.id, date: '2040-03-05' });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_in_future', visitId: future.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', resource_type: 'scheduled_services', resource_id: future.id,
      metadata: expect.objectContaining({ invoiceId: inv.id, trigger: 'sent', code: 'visit_in_future' }),
    }));
    recordAuditEvent.mockClear();
    const done = await visit({ status: 'completed', date: '2040-02-01' });
    await closeOutVisitForIssuedInvoice({ invoiceId: (await invoice({ scheduled_service_id: done.id, date: '2040-02-01' })).id, trigger: 'paid', conn: trx, today: TODAY });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: done.id, metadata: expect.objectContaining({ code: 'visit_completed' }) }));
    recordAuditEvent.mockClear();
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: (await invoice()).id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'not_linked', visitId: null });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('an invoice linked only through a service record is left alone — that visit already completed once', async () => {
    const open = await visit({ status: 'on_site' });
    const recordId = randomUUID();
    await trx('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: open.id, service_date: TODAY, service_type: open.service_type });
    const inv = await invoice({ service_record_id: recordId });
    // …but the visit IS linked, so the refusal is audited against it (GitHub r11 P2).
    expect(await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY })).toMatchObject({ svc: null, reason: 'record_linked_only', visit: expect.objectContaining({ id: open.id }) });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'record_linked_only', visitId: open.id });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused', resource_id: open.id, metadata: expect.objectContaining({ code: 'record_linked_only' }) }));
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });

  test('an UNLINKED office invoice is never paired by inference — the visit stays open', async () => {
    await visit();
    const inv = await invoice();
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'not_linked' });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect((await trx('invoices').where({ id: inv.id }).first()).scheduled_service_id).toBeNull();
  });

  test('a grouped stop is left to its visit closeout', async () => {
    const visitId = randomUUID();
    await trx('service_visits').insert({ id: visitId, customer_id: customerId, scheduled_date: TODAY, stop_base_key: `stop-${visitId.slice(0, 8)}`, created_by: 'test' });
    const a = await visit({ visit_id: visitId });
    await visit({ visit_id: visitId, serviceType: 'Mosquito Barrier Treatment' });
    const inv = await invoice({ scheduled_service_id: a.id });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY });
    expect(out.closed).toBe(false);
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });

  test('a completed visit whose OWN issued-invoice closeout was parked resumable is resumed; anyone else\'s completion is not', async () => {
    const done = await visit({ status: 'completed' });
    const inv = await invoice({ scheduled_service_id: done.id });
    // No attempt at all → the visit is simply done.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_completed' });
    // A panel's parked attempt under another key → not ours, leave it.
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: done.id, idempotency_key: randomUUID(), status: 'side_effects_pending', request_hash: 'x' });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_completed' });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // Our own parked attempt → hand it back to the canonical completion to resume.
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: done.id, idempotency_key: `invoice-issued:${inv.id}`, status: 'side_effects_pending', request_hash: 'x' });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: true, resumed: true, visitId: done.id });
    expect(mockCompleteScheduledService).toHaveBeenCalledTimes(1);
    expect(mockCompleteScheduledService.mock.calls[0][0].idempotencyKey).toBe(`invoice-issued:${inv.id}`);
  });

  test('gate off: nothing runs', async () => {
    mockGate.on = false;
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toEqual({ closed: false, reason: 'gate_off' });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });

  test('a project-backed visit is excluded with its own audited reason — it completes only through the project close (GitHub r5 P2)', async () => {
    const catalogId = randomUUID();
    const key = `fixture_${catalogId.slice(0, 8)}`;
    await trx('services').insert({ id: catalogId, name: 'Fixture Rodent Exclusion Project', service_key: key, category: 'rodent', is_active: true });
    await trx('service_completion_profiles').insert({ service_key: key, completion_mode: 'project_required', project_type: 'rodent_exclusion', creates_service_record: true });
    const projectVisit = await visit({ service_id: catalogId, serviceType: 'Fixture Rodent Exclusion Project' });
    const inv = await invoice({ scheduled_service_id: projectVisit.id, serviceType: 'Fixture Rodent Exclusion Project' });
    expect(await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY })).toMatchObject({ svc: null, reason: 'project_backed', visit: expect.objectContaining({ id: projectVisit.id }) });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', actorTechnicianId: 'admin-1', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'project_backed', visitId: projectVisit.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', resource_id: projectVisit.id, actor_type: 'admin', actor_id: 'admin-1',
      metadata: expect.objectContaining({ invoiceId: inv.id, trigger: 'sent', code: 'project_backed' }),
    }));
    expect((await trx('scheduled_services').where({ id: projectVisit.id }).first()).status).toBe('confirmed');
  });

  test('a completion that THROWS after the visit resolved is audited as a failed outcome for that visit, never silently (GitHub r5 P2)', async () => {
    mockCompleteScheduledService.mockRejectedValueOnce(new Error('post-commit side effect exploded'));
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', actorTechnicianId: 'admin-1', conn: trx, today: TODAY }))
      .toMatchObject({ closed: false, reason: 'error', error: 'post-commit side effect exploded', visitId: open.id });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', resource_type: 'scheduled_services', resource_id: open.id, actor_type: 'admin', actor_id: 'admin-1',
      metadata: expect.objectContaining({ invoiceId: inv.id, trigger: 'paid', resumed: false, code: 'error', error: 'post-commit side effect exploded' }),
    }));
    // The resume of our own parked attempt throwing is the same failed outcome, flagged resumed.
    recordAuditEvent.mockClear();
    const done = await visit({ status: 'completed', date: '2040-03-01' });
    const resumedInv = await invoice({ scheduled_service_id: done.id, date: '2040-03-01' });
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: done.id, idempotency_key: `invoice-issued:${resumedInv.id}`, status: 'side_effects_pending', request_hash: 'x' });
    mockCompleteScheduledService.mockRejectedValueOnce(new Error('resume exploded'));
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: resumedInv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'error', visitId: done.id });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: done.id, metadata: expect.objectContaining({ code: 'error', resumed: true, error: 'resume exploded' }) }));
    // An invoice with no visit link that throws has nothing to audit against.
    recordAuditEvent.mockClear();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('only the ownership verdict is packet_owned — a failed read inside the packet check is an audited error, never a refusal (GitHub r6 P2)', async () => {
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    mockProbe.packetAssert = async () => { throw Object.assign(new Error('billed by its saved visit closeout'), { status: 409, code: 'VISIT_PACKET_OWNS_BILLING' }); };
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'packet_owned', visitId: open.id });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: open.id, metadata: expect.objectContaining({ code: 'packet_owned' }) }));
    recordAuditEvent.mockClear();
    mockProbe.packetAssert = async () => { throw new Error('connection reset'); };
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'error', error: 'connection reset', visitId: open.id });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: open.id, metadata: expect.objectContaining({ code: 'error', error: 'connection reset' }) }));
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });

  test('the project exclusion resolves the profile STRICT — an unverifiable profile is an audited error, never the synthesized generic lane (GitHub r6 P2)', async () => {
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: true, visitId: open.id });
    expect(mockProbe.profileCalls).toEqual([{ strict: true }]);
    mockCompleteScheduledService.mockClear();
    recordAuditEvent.mockClear();
    mockProbe.profile = async () => { throw new Error('relation probe failed'); };
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'sent', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'error', error: 'relation probe failed', visitId: open.id });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused', resource_id: open.id, metadata: expect.objectContaining({ code: 'error' }) }));
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });

  test('settled-statement retry: a child whose paid-trigger closeout never ran or failed is retried; a real refusal, a closed visit and an old settlement are left alone (GitHub r10 P2)', async () => {
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const statement = async (paidAt) => {
      const [id] = await trx('payer_statements').insert({
        payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status: 'paid', terms_snapshot: 'net30',
        token: randomUUID().replace(/-/g, ''), paid_at: paidAt,
      }).returning('id').then((r) => r.map((x) => x.id ?? x));
      return id;
    };
    const recent = await statement(new Date());
    const stale = await statement(new Date(Date.now() - 30 * 86400000));
    const auditRow = (visitId, invoiceId, action, code) => trx('audit_log').insert({
      actor_type: 'system', action, resource_type: 'scheduled_services', resource_id: visitId,
      metadata: JSON.stringify({ invoiceId, trigger: 'paid', code }),
    });
    // 1. never ran (no audit row) → retried
    const v1 = await visit(); await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v1.id });
    // 2. failed with an outage → retried
    const v2 = await visit(); const i2 = await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v2.id });
    await auditRow(v2.id, i2.id, 'visit.completion_on_invoice_issued_refused', 'error');
    // 3. refused for a real reason → left alone
    const v3 = await visit(); const i3 = await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v3.id });
    await auditRow(v3.id, i3.id, 'visit.completion_on_invoice_issued_refused', 'grouped_visit');
    // 4. an older error superseded by a completion → left alone (the visit is closed anyway)
    const v4 = await visit({ status: 'completed' }); const i4 = await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v4.id });
    await auditRow(v4.id, i4.id, 'visit.completion_on_invoice_issued_refused', 'error');
    // 5. future visit → not a candidate
    const v5 = await visit({ date: '2040-03-05' }); await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v5.id });
    // 6. settled outside the window → not a candidate
    const v6 = await visit(); await invoice({ status: 'paid', payer_statement_id: stale, scheduled_service_id: v6.id });
    // 7. completed, but THIS closeout's own attempt is still parked (post-commit failure) → resumed (pre-push P1 r10),
    //    even though the last paid audit is a NON-error refusal: settlement ran while the delivery closeout was
    //    still running, audited visit_completed, and the worker then died (pre-push P1 r10 ×2).
    const v7 = await visit({ status: 'completed' }); const i7 = await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v7.id });
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: v7.id, idempotency_key: `invoice-issued:${i7.id}`, status: 'side_effects_pending', request_hash: 'x' });
    await auditRow(v7.id, i7.id, 'visit.completion_on_invoice_issued_refused', 'visit_completed');
    // 8. completed with a parked attempt that is a PANEL's, not ours → not a candidate
    const v8 = await visit({ status: 'completed' }); await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v8.id });
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: v8.id, idempotency_key: randomUUID(), status: 'side_effects_pending', request_hash: 'x' });

    const out = await retrySettledStatementCloseouts({ conn: trx, today: TODAY });
    expect(out).toEqual({ candidates: 4, retried: 3, closed: 3 });
    const retriedIds = mockCompleteScheduledService.mock.calls.map(([args]) => args.serviceId).sort();
    expect(retriedIds).toEqual([v1.id, v2.id, v7.id].sort());
    expect(mockCompleteScheduledService.mock.calls.find(([args]) => args.serviceId === v7.id)[0].idempotencyKey).toBe(`invoice-issued:${i7.id}`);
    // A retry is nobody's action: the system is the actor.
    for (const [args] of mockCompleteScheduledService.mock.calls) expect(args.actor).toEqual({ techRole: 'admin', technicianId: null, technician: null });
    mockGate.on = false;
    expect(await retrySettledStatementCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 0, retried: 0, closed: 0 });
  });
  test('a statement closeout reports the children that failed, so the caller can log what the sweep will retry', async () => {
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const [statementId] = await trx('payer_statements').insert({
      payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status: 'paid', terms_snapshot: 'net30', token: randomUUID().replace(/-/g, ''), paid_at: new Date(),
    }).returning('id').then((r) => r.map((x) => x.id ?? x));
    // The statement helper resolves against the real today: past-dated visits.
    const day = '2020-01-06';
    const ok = await visit({ date: day }); await invoice({ status: 'paid', date: day, payer_statement_id: statementId, scheduled_service_id: ok.id });
    const bad = await visit({ date: day }); const badInvoice = await invoice({ status: 'paid', date: day, payer_statement_id: statementId, scheduled_service_id: bad.id });
    mockCompleteScheduledService.mockImplementation(async ({ serviceId }) => {
      if (serviceId === bad.id) throw new Error('connection reset');
      return { status: 200, body: { success: true } };
    });
    const { closeOutVisitsForStatement } = require('../services/invoice-issued-closeout');
    const out = await closeOutVisitsForStatement(statementId, { trigger: 'paid', actorTechnicianId: 'tech-1', actorRole: 'technician', conn: trx });
    expect(out).toEqual({ attempted: 2, closed: 1, failed: [badInvoice.id] });
    // The operator's role reaches the child audit rows.
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ actor_type: 'technician', actor_id: 'tech-1', action: 'visit.completed_on_invoice_issued', resource_id: ok.id }));
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ actor_type: 'technician', action: 'visit.completion_on_invoice_issued_refused', resource_id: bad.id, metadata: expect.objectContaining({ code: 'error' }) }));
    mockCompleteScheduledService.mockImplementation(async () => ({ status: 200, body: { success: true } }));
  });
  test('a refused completion is reported, audited as refused, and never thrown', async () => {
    mockCompleteScheduledService.mockResolvedValueOnce({ status: 409, body: { code: 'already_completed' } });
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'already_completed' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused' }));
  });
});
