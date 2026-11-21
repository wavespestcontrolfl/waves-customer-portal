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
// GATE_REPORT_AFTER_PAY's hold is state the closeout reads back, so that one row is written for real; every other audit row is
// only recorded as a call.
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => (event?.action === 'visit.report_after_pay_held' ? jest.requireActual('../services/audit-log').recordAuditEvent(event) : ({}))),
}));
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
const mockGate = { on: true, reportAfterPay: false };
jest.mock('../config/feature-gates', () => ({ reviewAskAfterReportLive: () => false, reviewLateCloseAskLive: () => false, gateEnvTimestamp: () => null, isEnabled: (gate) => gate === 'invoiceIssuedClosesVisit' && mockGate.on, reportAfterPayLive: () => mockGate.reportAfterPay === true }));
const { randomUUID } = require('node:crypto');
const {
  resolveVisitForIssuedInvoice,
  closeOutVisitForIssuedInvoice,
  retrySettledStatementCloseouts,
  issuedCloseoutVisitRefusal,
  issuedCloseoutTarget,
} = require('../services/invoice-issued-closeout');
const { recordAuditEvent } = require('../services/audit-log');
const { ACTIVE_WRITE_GENERATION } = require('../constants/staff-time');

const { backfillCompletionPlan, backfillCompletionEndInstant } = jest.requireActual('../services/complete-scheduled-service');

describe('backfillCompletionPlan same-day switch', () => {
  test('the shared issued-closeout rule: a past day closes an unstarted or an arrived visit; today closes only an arrived visit, and only on payment (owner 2026-10-04)', () => {
    const options = { today: '2040-03-04' };
    const rule = (status, day, trigger) => issuedCloseoutVisitRefusal(status, day, { ...options, ...(trigger ? { trigger } : {}) });
    // A past day: a send or a payment closes an unstarted (pending / confirmed /
    // legacy NULL) visit and an arrived (on_site) one.
    for (const status of ['pending', 'confirmed', null, 'on_site']) {
      expect(rule(status, '2040-03-03', 'sent')).toBeNull();
      expect(rule(status, '2040-03-03', 'paid')).toBeNull();
      expect(rule(status, '2040-03-03')).toBeNull();
    }
    // Today, arrived: money received closes it; a send does not.
    expect(rule('on_site', '2040-03-04', 'paid')).toBeNull();
    expect(rule('on_site', '2040-03-04', 'sent')).toBe('visit_scheduled_today');
    // Today, nobody has arrived: a payment is a prepayment — the visit stays
    // with its technician. A send never closed it.
    for (const status of ['pending', 'confirmed', null]) {
      expect(rule(status, '2040-03-04', 'paid')).toBe('visit_scheduled_today');
      expect(rule(status, '2040-03-04', 'sent')).toBe('visit_scheduled_today');
    }
    // Fail closed: a missing or unknown trigger never admits today (allowlist,
    // pre-push audit P1).
    expect(rule('on_site', '2040-03-04')).toBe('visit_scheduled_today');
    expect(rule('on_site', '2040-03-04', 'resend')).toBe('visit_scheduled_today');
    // The future and an unparseable day never close, whatever the status.
    expect(rule('on_site', '2040-03-05', 'paid')).toBe('visit_in_future');
    expect(rule('confirmed', '2040-03-05', 'paid')).toBe('visit_in_future');
    expect(rule('confirmed', 'not-a-date', 'paid')).toBe('visit_in_future');
    // UNSTARTED on a past day: the invoice must have been settled / delivered
    // AFTER the visit day. With no stamp, the call day stands in (above).
    const proof = (issuedDay, day = '2040-03-02') => issuedCloseoutVisitRefusal('confirmed', day, { ...options, trigger: 'paid', issuedDay });
    expect(proof('2040-03-03')).toBeNull();
    expect(proof('2040-03-02')).toBe('visit_prepaid');
    expect(proof('2040-03-01')).toBe('visit_prepaid');
    // A stamp from the future proves nothing yet: the call day stands in.
    expect(proof('2040-03-09')).toBeNull();
    expect(proof('2040-03-09', '2040-03-03')).toBeNull();
    // An ARRIVED visit ignores the stamp.
    expect(issuedCloseoutVisitRefusal('on_site', '2040-03-02', { ...options, trigger: 'paid', issuedDay: '2040-03-01' })).toBeNull();
    // en_route (nobody has reached the property) and every terminal status
    // stay as they are, on any day.
    for (const status of ['en_route', 'completed', 'cancelled', 'skipped', 'no_show']) {
      expect(rule(status, '2040-03-03', 'paid')).toBe(`visit_${status}`);
      expect(rule(status, '2040-03-04', 'paid')).toBe(`visit_${status}`);
    }
  });

  test('report after pay (GATE_REPORT_AFTER_PAY, owner 2026-11-19): a visit a payment holds stays open on its day; a past day closes it', () => {
    const rule = (status, day, trigger, heldForReport) => issuedCloseoutVisitRefusal(status, day, { today: '2040-03-04', trigger, heldForReport });
    expect(rule('on_site', '2040-03-04', 'paid', true)).toBe('visit_scheduled_today');
    expect(rule('on_site', '2040-03-04', 'sent', true)).toBe('visit_scheduled_today');
    expect(rule('on_site', '2040-03-03', 'paid', true)).toBeNull();
    expect(rule('on_site', '2040-03-03', 'sent', true)).toBeNull();
    // A visit nobody arrived at keeps the prepayment rule.
    expect(rule('confirmed', '2040-03-04', 'paid', true)).toBe('visit_scheduled_today');
    // Not held (another invoice on the visit, no hold recorded, or no answer at all): the payment closes it, as with the gate off.
    expect(rule('on_site', '2040-03-04', 'paid', false)).toBeNull();
    expect(rule('on_site', '2040-03-04', 'paid')).toBeNull();
  });

  // Pre-push audit rounds 8, 9 and 11: with the gate on, a close on a payment, and a hold on one, need that payment still on the
  // invoice row read under the lock. The closeout carries the payment it loaded (paidAtMs). A send closes on its delivery, and
  // the gate off closes as before: neither is ever refused here.
  test('report after pay: a paid close needs its own payment still on the invoice: undone, charged back or replaced by another refuses it; a send and the gate off never do', () => {
    const { paymentReversed } = require('../services/invoice-issued-closeout');
    const paidAt = new Date('2040-03-04T15:00:00Z');
    const paidAtMs = paidAt.getTime();
    mockGate.reportAfterPay = true;
    try {
      expect(paymentReversed({ status: 'paid', paid_at: paidAt }, { trigger: 'paid', paidAtMs })).toBe(false);
      expect(paymentReversed({ status: 'prepaid', paid_at: paidAt }, { trigger: 'paid', paidAtMs })).toBe(false);
      // A caller that carries no payment (none was loaded) is held to the settled status only.
      expect(paymentReversed({ status: 'paid', paid_at: paidAt }, { trigger: 'paid' })).toBe(false);
      expect(paymentReversed({ status: 'sent', paid_at: null }, { trigger: 'paid', paidAtMs })).toBe(true);
      expect(paymentReversed({ status: 'refunded', paid_at: paidAt }, { trigger: 'paid', paidAtMs })).toBe(true);
      expect(paymentReversed({ status: 'overdue', paid_at: null }, { trigger: 'paid' })).toBe(true);
      // Undone and made again: settled, by another payment.
      expect(paymentReversed({ status: 'paid', paid_at: new Date(paidAtMs + 1) }, { trigger: 'paid', paidAtMs })).toBe(true);
      expect(paymentReversed({ status: 'sent', paid_at: null }, { trigger: 'sent' })).toBe(false);
      mockGate.reportAfterPay = false;
      expect(paymentReversed({ status: 'sent', paid_at: null }, { trigger: 'paid', paidAtMs })).toBe(false);
      expect(paymentReversed({ status: 'paid', paid_at: new Date(paidAtMs + 1) }, { trigger: 'paid', paidAtMs })).toBe(false);
    } finally {
      mockGate.reportAfterPay = false;
    }
  });

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
  // GATE_REPORT_AFTER_PAY: the held fixtures arrive at 9:00 AM ET and are paid at 10:00 AM ET, both on TODAY. The hold itself is
  // what the payment's closeout records, read back by every reader; no reader reads these stamps.
  const ARRIVED_AT = new Date(`${TODAY}T14:00:00Z`);
  const PAID_AT = new Date(`${TODAY}T15:00:00Z`);

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local/CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    mockGate.on = true;
    mockGate.reportAfterPay = false;
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
  // A record_payment card's pin, as its settlement writes it. The audit module is mocked here: write the row it would have written.
  async function pinPayment(invoiceId, target, approvedVisit = null) {
    const { recordApprovedPaidCloseoutTarget } = require('../services/invoice-issued-closeout');
    await recordApprovedPaidCloseoutTarget(invoiceId, target, { conn: trx, approvedVisit });
    const pin = recordAuditEvent.mock.calls.map(([event]) => event).filter((event) => event.action === 'invoice.send_closeout_target_approved').pop();
    await trx('audit_log').insert({ actor_type: pin.actor_type, action: pin.action, resource_type: pin.resource_type, resource_id: pin.resource_id, metadata: JSON.stringify(pin.metadata) });
  }

  test('a linked open visit on or before today resolves; closed, future and cancelled visits do not', async () => {
    const open = await visit({ date: TODAY });
    // No trigger supplied → the resolver fails closed on a same-day visit
    // (allowlist, pre-push audit P1); only payment proves today happened.
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: open.id, date: TODAY }), { today: TODAY })).toMatchObject({ svc: null, reason: 'visit_scheduled_today' });
    const past = await visit({ date: '2040-02-20', status: 'pending' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: past.id, date: '2040-02-20' }), { today: TODAY })).svc.id).toBe(past.id);
    // A SEND leaves a visit scheduled for TODAY open (Codex P1 r7 #4131): the
    // office picker sends pre-completion invoices for today's visits before
    // the tech arrives. A PAYMENT against a visit nobody has reached today is
    // a prepayment and leaves it open too (owner 2026-10-04); a past day
    // closes on a send.
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: open.id, date: TODAY }), { today: TODAY, trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_scheduled_today' });
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: open.id, date: TODAY }), { today: TODAY, trigger: 'paid' })).toMatchObject({ svc: null, reason: 'visit_scheduled_today' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: past.id, date: '2040-02-20' }), { today: TODAY, trigger: 'sent' })).svc.id).toBe(past.id);
    // YESTERDAY is the fixture default precisely because it closes on a send.
    const yesterday = await visit();
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: yesterday.id }), { today: TODAY, trigger: 'sent' })).svc.id).toBe(yesterday.id);
    // A visit its technician ARRIVED at and never closed out (owner
    // 2026-10-04; the GPS arrival sets on_site on nearly every worked visit):
    // a past day closes it like an unstarted one; today only a payment does.
    const onSite = await visit({ date: '2040-02-21', status: 'on_site' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: onSite.id, date: '2040-02-21' }), { today: TODAY, trigger: 'sent' })).svc.id).toBe(onSite.id);
    const onSiteToday = await visit({ date: TODAY, status: 'on_site' });
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: onSiteToday.id, date: TODAY }), { today: TODAY, trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_scheduled_today' });
    expect((await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: onSiteToday.id, date: TODAY }), { today: TODAY, trigger: 'paid' })).svc.id).toBe(onSiteToday.id);
    // en_route stays with its technician: nobody has reached the property.
    const enRoute = await visit({ date: '2040-02-22', status: 'en_route' });
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: enRoute.id, date: '2040-02-22' }), { today: TODAY, trigger: 'paid' })).toMatchObject({ svc: null, reason: 'visit_en_route' });
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

  test('issuedCloseoutTarget names the visit the closeout would complete — same verdicts, no audit row, no completion (the IB resend card)', async () => {
    const open = await visit({ date: '2040-02-20', serviceType: 'Lawn Care Visit' });
    const inv = await invoice({ scheduled_service_id: open.id, date: '2040-02-20' });
    expect(await issuedCloseoutTarget(inv, { today: TODAY, conn: trx })).toMatchObject({ visitId: open.id, serviceType: 'Lawn Care Visit', date: '2040-02-20', resuming: false });
    // A same-day visit its technician ARRIVED at closes on payment (the
    // default trigger here), never on a send; one nobody has reached does
    // not close at all today — the payment is a prepayment (owner 2026-10-04).
    const sameDay = await visit({ date: TODAY });
    const sameDayInv = await invoice({ scheduled_service_id: sameDay.id, date: TODAY });
    expect(await issuedCloseoutTarget(sameDayInv, { today: TODAY, conn: trx })).toBeNull();
    await trx('scheduled_services').where({ id: sameDay.id }).update({ status: 'on_site' });
    expect(await issuedCloseoutTarget(sameDayInv, { today: TODAY, conn: trx })).toMatchObject({ visitId: sameDay.id });
    expect(await issuedCloseoutTarget(sameDayInv, { today: TODAY, conn: trx, trigger: 'sent' })).toBeNull();
    // Future, completed-with-nothing-parked and unlinked invoices close nothing.
    const future = await visit({ date: '2040-03-05' });
    expect(await issuedCloseoutTarget(await invoice({ scheduled_service_id: future.id, date: '2040-03-05' }), { today: TODAY, conn: trx })).toBeNull();
    const done = await visit({ status: 'completed' });
    const doneInv = await invoice({ scheduled_service_id: done.id });
    expect(await issuedCloseoutTarget(doneInv, { today: TODAY, conn: trx })).toBeNull();
    expect(await issuedCloseoutTarget(await invoice({}), { today: TODAY, conn: trx })).toBeNull();
    // Our own parked attempt: the closeout would resume it.
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: done.id, idempotency_key: `invoice-issued:${doneInv.id}`, status: 'side_effects_pending', request_hash: 'x' });
    expect(await issuedCloseoutTarget(doneInv, { today: TODAY, conn: trx })).toMatchObject({ visitId: done.id, resuming: true });
    // Read-only: nothing completed, nothing audited.
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
    // And the closeout itself then completes exactly the visit the card named.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: true, visitId: open.id });
    // Gate off: the card says nothing.
    mockGate.on = false;
    expect(await issuedCloseoutTarget(inv, { today: TODAY, conn: trx })).toBeNull();
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
    // Settled the day AFTER the fixture visits (YESTERDAY): an ordinary NET-terms settlement, no prepayment.
    const recent = await statement(new Date('2040-03-04T15:00:00Z'));
    const stale = await statement(new Date(Date.now() - 30 * 86400000));
    // Settled ON the visit day, and in ADVANCE of it: prepayments.
    const sameDaySettled = await statement(new Date('2040-03-03T15:00:00Z'));
    const advanceSettled = await statement(new Date('2040-03-01T15:00:00Z'));
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

    // 9. arrived (on_site) TODAY, never ran → retried: a payment closes an arrived visit on its own day (owner 2026-10-04)
    const v9 = await visit({ status: 'on_site', date: TODAY }); await invoice({ status: 'paid', date: TODAY, payer_statement_id: recent, scheduled_service_id: v9.id });
    // 10. unstarted TODAY → not a candidate: the settlement is a prepayment until someone arrives or the day passes
    const v10 = await visit({ date: TODAY }); await invoice({ status: 'paid', date: TODAY, payer_statement_id: recent, scheduled_service_id: v10.id });
    // 11. unstarted, the statement settled before anyone arrived (visit_scheduled_today), the day has passed → LEFT ALONE: a prepayment is not proof the visit happened
    const v11 = await visit(); const i11 = await invoice({ status: 'paid', payer_statement_id: sameDaySettled, scheduled_service_id: v11.id });
    await auditRow(v11.id, i11.id, 'visit.completion_on_invoice_issued_refused', 'visit_scheduled_today');
    // 13. ARRIVED, refused before 2026-10-04 with the historical visit_on_site → retried under the rule that now admits it
    const v13 = await visit({ status: 'on_site' }); const i13 = await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v13.id });
    await auditRow(v13.id, i13.id, 'visit.completion_on_invoice_issued_refused', 'visit_on_site');
    // 14. unstarted, statement settled ON the visit day, the closeout NEVER ran (or its audit write failed) → left alone: no audit row is not evidence either
    const v14 = await visit(); await invoice({ status: 'paid', payer_statement_id: sameDaySettled, scheduled_service_id: v14.id });
    // 15. …and settled in ADVANCE of the visit day → left alone
    const v15 = await visit(); await invoice({ status: 'paid', payer_statement_id: advanceSettled, scheduled_service_id: v15.id });
    // 16. ARRIVED, settled on the visit day, never ran → retried: the technician was there
    const v16 = await visit({ status: 'on_site' }); await invoice({ status: 'paid', payer_statement_id: sameDaySettled, scheduled_service_id: v16.id });
    // ── DELIVERED, unpaid statements (NET terms): the 'sent' trigger, proof = the statement's sent_at (GitHub r5 P1 #5886) ──
    const deliveredStatement = async (sentAt, status = 'sent') => {
      const [id] = await trx('payer_statements').insert({
        payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status, terms_snapshot: 'net30',
        token: randomUUID().replace(/-/g, ''), sent_at: sentAt,
      }).returning('id').then((r) => r.map((x) => x.id ?? x));
      return id;
    };
    const delivered = await deliveredStatement(new Date('2040-03-04T15:00:00Z'));
    const sentAudit = (visitId, invoiceId, code) => trx('audit_log').insert({
      actor_type: 'system', action: 'visit.completion_on_invoice_issued_refused', resource_type: 'scheduled_services', resource_id: visitId,
      metadata: JSON.stringify({ invoiceId, trigger: 'sent', code }),
    });
    // 17. arrived child, refused at delivery while its job timer ran; the timer has stopped → retried with 'sent'
    const v17 = await visit({ status: 'on_site' }); const i17 = await invoice({ status: 'sent', payer_statement_id: delivered, scheduled_service_id: v17.id });
    await sentAudit(v17.id, i17.id, 'visit_timer_running');
    // 18. unstarted child, delivery closeout failed with an outage → retried with 'sent' (the statement went out after the visit day)
    const v18 = await visit(); const i18 = await invoice({ status: 'sent', payer_statement_id: delivered, scheduled_service_id: v18.id });
    await sentAudit(v18.id, i18.id, 'error');
    // 19. arrived TODAY on a delivered statement → not a candidate: a send never closes a same-day visit
    const v19 = await visit({ status: 'on_site', date: TODAY }); await invoice({ status: 'sent', date: TODAY, payer_statement_id: delivered, scheduled_service_id: v19.id });
    // 20. a 'viewed' statement delivered ON the visit day, unstarted child → left alone (prepayment rule)
    const viewedSameDay = await deliveredStatement(new Date('2040-03-03T15:00:00Z'), 'viewed');
    const v20 = await visit(); await invoice({ status: 'sent', payer_statement_id: viewedSameDay, scheduled_service_id: v20.id });
    // 21. a FINALIZED (never delivered) statement → not a candidate
    const [finalized] = await trx('payer_statements').insert({ payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status: 'finalized', terms_snapshot: 'net30', token: randomUUID().replace(/-/g, '') }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const v21 = await visit({ status: 'on_site' }); await invoice({ status: 'draft', payer_statement_id: finalized, scheduled_service_id: v21.id });
    // 12. en_route → not a candidate
    const v12 = await visit({ status: 'en_route' }); await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v12.id });
    // 22. arrived; its latest paid row is a receipt resend's refusal (visit_not_on_card: the visit became closable after the
    //     card, which had named none) → retried: that card's target limits its own run, not the settlement's retry
    const v22 = await visit({ status: 'on_site' }); const i22 = await invoice({ status: 'paid', payer_statement_id: recent, scheduled_service_id: v22.id });
    await auditRow(v22.id, i22.id, 'visit.completion_on_invoice_issued_refused', 'visit_not_on_card');

    const out = await retrySettledStatementCloseouts({ conn: trx, today: TODAY });
    expect(out).toEqual({ candidates: 14, retried: 9, closed: 9 });
    const retriedIds = mockCompleteScheduledService.mock.calls.map(([args]) => args.serviceId).sort();
    expect(retriedIds).toEqual([v1.id, v2.id, v7.id, v9.id, v13.id, v16.id, v17.id, v18.id, v22.id].sort());
    const triggerOf = (id) => mockCompleteScheduledService.mock.calls.find(([args]) => args.serviceId === id)[0].issuedInvoiceCloseout.trigger;
    expect([triggerOf(v17.id), triggerOf(v18.id), triggerOf(v1.id)]).toEqual(['sent', 'sent', 'paid']);
    for (const left of [v19, v20, v21]) expect(retriedIds).not.toContain(left.id);
    for (const left of [v11, v14, v15]) expect(retriedIds).not.toContain(left.id);
    expect(retriedIds).not.toContain(v10.id);
    expect(retriedIds).not.toContain(v12.id);
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
  test('a visit whose job timer is still running stays with its technician; once the timer stops the same invoice closes it — the closeout never writes time_entries (GitHub r9 P1 #4127, r1 P1 ×3 #5886)', async () => {
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Fixture Tech' });
    const startedAt = new Date(Date.now() - 45 * 60000);
    await trx('time_entries').insert({ id: randomUUID(), technician_id: techId, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(startedAt.getTime() - 60000) });
    const arrived = await visit({ status: 'on_site', technician_id: techId });
    const timerId = randomUUID();
    await trx('time_entries').insert({ id: timerId, technician_id: techId, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: startedAt, job_id: arrived.id });
    const inv = await invoice({ scheduled_service_id: arrived.id, status: 'paid' });
    const before = await trx('time_entries').where({ id: timerId }).first();

    expect(await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'paid' })).toMatchObject({ svc: null, reason: 'visit_timer_running', visit: expect.objectContaining({ id: arrived.id }) });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_timer_running', visitId: arrived.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ resource_id: arrived.id, action: 'visit.completion_on_invoice_issued_refused', metadata: expect.objectContaining({ code: 'visit_timer_running' }) }));
    // Read-only: the running entry is exactly as it was.
    expect(await trx('time_entries').where({ id: timerId }).first()).toEqual(before);

    // An unstarted visit with a running timer is being worked too.
    const unstarted = await visit({ technician_id: techId, date: '2040-03-01' });
    await trx('time_entries').insert({ id: randomUUID(), technician_id: techId, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: startedAt, job_id: unstarted.id });
    expect(await resolveVisitForIssuedInvoice(trx, await invoice({ scheduled_service_id: unstarted.id, date: '2040-03-01' }), { today: TODAY, trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_timer_running' });

    // The technician stopped the timer (payroll's own write): the visit closes.
    const stoppedAt = new Date();
    await trx('time_entries').where({ id: timerId }).update({ status: 'completed', clock_out: stoppedAt, duration_minutes: 45 });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: true, visitId: arrived.id });
    expect(await trx('time_entries').where({ id: timerId }).first()).toMatchObject({ status: 'completed', duration_minutes: expect.anything() });
    // Another visit's running timer never blocks this one.
  });

  test('no job timer starts on a COMPLETED visit — a timer start that raced a closeout is refused before any time_entries write (GitHub r2 P1 #5886)', async () => {
    const timeTracking = require('../services/time-tracking');
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Fixture Tech' });
    await trx('time_entries').insert({ id: randomUUID(), technician_id: techId, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(Date.now() - 3600000) });
    // The technician's timer on another stop is running.
    const current = await visit({ status: 'on_site', technician_id: techId, date: '2040-03-02' });
    const currentTimer = randomUUID();
    await trx('time_entries').insert({ id: currentTimer, technician_id: techId, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(Date.now() - 600000), job_id: current.id });
    const done = await visit({ status: 'completed', technician_id: techId });
    // Unscoped (admin start).
    await expect(timeTracking.startJob(techId, done.id, { lat: 27.4, lng: -82.5 })).rejects.toMatchObject({ status: 409, code: 'job_already_completed' });
    expect(await trx('time_entries').where({ job_id: done.id })).toHaveLength(0);
    // The refusal came before the "close any other active job" write.
    expect((await trx('time_entries').where({ id: currentTimer }).first()).status).toBe('active');
  });

  test('a failed timer lookup is audited as an error against the visit, so the paid-invoice sweep can retry it (pre-push audit P1)', async () => {
    const svc = await visit({ status: 'on_site' });
    const inv = await invoice({ scheduled_service_id: svc.id, status: 'paid', paid_at: new Date() });
    // A connection whose time_entries read fails; every other table reads through.
    const flaky = Object.assign((table) => {
      if (table === 'time_entries') throw new Error('time_entries lookup reset');
      return trx(table);
    }, { raw: (...a) => trx.raw(...a) });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: flaky, today: TODAY });
    expect(out).toMatchObject({ closed: false, reason: 'error', visitId: svc.id, audited: true });
    // Written through the helper's CRITICAL path: its default swallows a failed insert and would report a row that does not exist.
    expect(recordAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ critical: true, metadata: expect.objectContaining({ code: 'error' }) }));
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // A failure with NO durable audit row says so, and the Stripe webhook
    // hands it back for redelivery: the audit write itself failing…
    recordAuditEvent.mockRejectedValueOnce(new Error('audit insert reset'));
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: flaky, today: TODAY })).toMatchObject({ reason: 'error', visitId: svc.id, audited: false });
    // …or a read that failed before any visit was in hand.
    const blind = Object.assign(() => { throw new Error('invoice lookup reset'); }, { raw: (...a) => trx.raw(...a) });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: blind, today: TODAY })).toMatchObject({ reason: 'error', visitId: null, audited: false });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', resource_id: svc.id,
      metadata: expect.objectContaining({ invoiceId: inv.id, trigger: 'paid', code: 'error' }),
    }));
    // The audit module is mocked here; write the row it would have written, then sweep.
    await trx('audit_log').insert({ actor_type: 'system', action: 'visit.completion_on_invoice_issued_refused', resource_type: 'scheduled_services', resource_id: svc.id, metadata: JSON.stringify({ invoiceId: inv.id, trigger: 'paid', code: 'error' }) });
    const { retryIssuedInvoiceCloseouts } = require('../services/invoice-issued-closeout');
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 1, retried: 1, closed: 1 });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => args.serviceId)).toEqual([svc.id]);
  });

  test('a visit NOBODY ARRIVED AT closes only on an invoice settled or delivered AFTER its day — the same verdict for a live trigger, a redelivered webhook and a sweep, whatever day the visit is moved to (the prepayment rule)', async () => {
    const paidAt = new Date('2040-03-02T15:00:00Z');
    // Visit on 03-01, paid the day after: no prepayment → closes.
    const svc = await visit({ date: '2040-03-01' });
    const inv = await invoice({ scheduled_service_id: svc.id, status: 'paid', paid_at: paidAt, date: '2040-03-01' });
    expect((await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'paid' })).svc.id).toBe(svc.id);
    // Moved onto the payment day itself (still in the past): now a prepayment
    // for the day it is on → refused, days later, by any caller.
    await trx('scheduled_services').where({ id: svc.id }).update({ scheduled_date: '2040-03-02' });
    expect(await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'paid' })).toMatchObject({ svc: null, reason: 'visit_prepaid' });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_prepaid', visitId: svc.id });
    expect(await issuedCloseoutTarget(inv, { today: TODAY, conn: trx })).toBeNull();
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // The proof is per trigger: a payment stamp says nothing for a send…
    expect((await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'sent' })).svc.id).toBe(svc.id);
    // …and a delivery stamp on the visit day refuses the send too; a later delivery proves it.
    const sentSameDay = await invoice({ scheduled_service_id: svc.id, date: '2040-03-02', sent_at: new Date('2040-03-02T15:00:00Z') });
    expect(await resolveVisitForIssuedInvoice(trx, sentSameDay, { today: TODAY, trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_prepaid' });
    await trx('invoices').where({ id: sentSameDay.id }).update({ email_sent_at: new Date('2040-03-03T15:00:00Z') });
    expect((await resolveVisitForIssuedInvoice(trx, await trx('invoices').where({ id: sentSameDay.id }).first(), { today: TODAY, trigger: 'sent' })).svc.id).toBe(svc.id);
    // An ARRIVED visit is never a prepayment case.
    await trx('scheduled_services').where({ id: svc.id }).update({ status: 'on_site' });
    expect((await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'paid' })).svc.id).toBe(svc.id);
  });

  test('a statement child reads its delivery proof from the STATEMENT: delivered on or before the visit day it is a prepayment for a visit nobody arrived at; delivered after, it closes', async () => {
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const [statementId] = await trx('payer_statements').insert({
      payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status: 'sent', terms_snapshot: 'net30',
      token: randomUUID().replace(/-/g, ''), sent_at: new Date('2040-03-02T15:00:00Z'),
    }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const before = await visit({ date: '2040-03-01' });
    const onTheDay = await visit({ date: '2040-03-02' });
    const child = (svc) => invoice({ scheduled_service_id: svc.id, date: '2040-03-01', payer_statement_id: statementId });
    expect((await resolveVisitForIssuedInvoice(trx, await child(before), { today: TODAY, trigger: 'sent' })).svc.id).toBe(before.id);
    expect(await resolveVisitForIssuedInvoice(trx, await child(onTheDay), { today: TODAY, trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_prepaid' });
    // Arrived: never a prepayment case.
    await trx('scheduled_services').where({ id: onTheDay.id }).update({ status: 'on_site' });
    expect((await resolveVisitForIssuedInvoice(trx, await child(onTheDay), { today: TODAY, trigger: 'sent' })).svc.id).toBe(onTheDay.id);
  });

  test('issued-invoice retry: an ARRIVED visit with a delivered or settled invoice is retried whether or not a closeout ever ran; an UNSTARTED one only after a closeout that ran and failed; real refusals, prepayments, statement children and old invoices are left alone (GitHub r1 P1, r3 P1 ×2 #5886)', async () => {
    const { retryIssuedInvoiceCloseouts } = require('../services/invoice-issued-closeout');
    const refused = 'visit.completion_on_invoice_issued_refused';
    const auditRow = (visitId, invoiceId, code, { trigger = 'paid', status = null, action = refused } = {}) => trx('audit_log').insert({
      actor_type: 'system', action, resource_type: 'scheduled_services', resource_id: visitId,
      metadata: JSON.stringify({ invoiceId, trigger, code, ...(status ? { status } : {}) }),
    });
    const paid = (svc, rest = {}) => invoice({ status: 'paid', paid_at: new Date(), scheduled_service_id: svc.id, ...rest });
    const sent = (svc, rest = {}) => invoice({ status: 'sent', sent_at: new Date(), scheduled_service_id: svc.id, ...rest });
    const expectRetried = [];
    const want = (svc, trigger) => { expectRetried.push([svc.id, trigger]); return svc; };

    // ── ARRIVED (on_site): the state itself is the proof ──
    // A1. paid, NEVER ran (the process died after the payment committed, or a cash rail ignored an unaudited failure) → retried
    const a1 = want(await visit({ status: 'on_site' }), 'paid'); await paid(a1);
    // A2. paid TODAY, never ran → retried (a payment closes an arrived visit on its own day)
    const a2 = want(await visit({ status: 'on_site', date: TODAY }), 'paid'); await paid(a2, { date: TODAY });
    // A3. SENT (unpaid), past day, never ran → retried with the 'sent' trigger
    const a3 = want(await visit({ status: 'on_site' }), 'sent'); await sent(a3);
    // A4. sent, refused while its job timer ran (audited with trigger 'sent'); the timer has stopped → retried
    const a4 = want(await visit({ status: 'on_site' }), 'sent'); const ia4 = await sent(a4); await auditRow(a4.id, ia4.id, 'visit_timer_running', { trigger: 'sent' });
    // A5. sent, the completion RETURNED a 503 → retried
    const a5 = want(await visit({ status: 'on_site' }), 'sent'); const ia5 = await sent(a5); await auditRow(a5.id, ia5.id, 'completion_profile_lookup_failed', { trigger: 'sent', status: 503 });
    // A6. paid, failed with an outage → retried
    const a6 = want(await visit({ status: 'on_site' }), 'paid'); const ia6 = await paid(a6); await auditRow(a6.id, ia6.id, 'error');
    // A7. paid, refused under the lock (timer started / reassigned mid-closeout) → retried
    const a7 = want(await visit({ status: 'on_site' }), 'paid'); const ia7 = await paid(a7); await auditRow(a7.id, ia7.id, 'issued_visit_identity_changed');
    // A8. viewed (delivered, unpaid) → the same as sent
    const a8 = want(await visit({ status: 'on_site' }), 'sent'); await invoice({ status: 'viewed', sent_at: new Date(), scheduled_service_id: a8.id });
    // A16. refused before 2026-10-04 with the historical visit_on_site (every arrived visit was) → retried under the rule that now admits it
    const a16 = want(await visit({ status: 'on_site' }), 'sent'); const ia16 = await sent(a16); await auditRow(a16.id, ia16.id, 'visit_on_site', { trigger: 'sent' });
    // A17. arrived, sent on its own day (visit_scheduled_today), the day has passed → retried: on an arrived visit that row only meant "not paid yet, today"
    const a17 = want(await visit({ status: 'on_site' }), 'sent'); const ia17 = await sent(a17); await auditRow(a17.id, ia17.id, 'visit_scheduled_today', { trigger: 'sent' });
    // A18. paid BEFORE the visit day (visit_in_future then); the technician has since arrived and the day has passed → retried: that refusal was about a state that changed
    const a18 = want(await visit({ status: 'on_site' }), 'paid'); const ia18 = await paid(a18, { paid_at: new Date('2040-03-01T15:00:00Z') }); await auditRow(a18.id, ia18.id, 'visit_in_future');
    // A19. refused while the technician was on the way (visit_en_route); arrived since → retried
    const a19 = want(await visit({ status: 'on_site' }), 'paid'); const ia19 = await paid(a19); await auditRow(a19.id, ia19.id, 'visit_en_route');
    // A20. sent_at BEFORE the visit and outside the window, emailed again AFTER it: the NEWEST delivery stamp is the proof and the window (the resolver reads the same stamp)
    const a20 = want(await visit({ status: 'pending' }), 'sent'); await invoice({ status: 'sent', scheduled_service_id: a20.id, sent_at: new Date(Date.now() - 30 * 86400000), email_sent_at: new Date('2040-03-04T15:00:00Z') });
    // A9. SENT today → not a candidate: a send never closes a same-day visit
    const a9 = await visit({ status: 'on_site', date: TODAY }); await sent(a9, { date: TODAY });
    // A10. refused for a real reason → left alone, never re-audited
    const a10 = await visit({ status: 'on_site' }); const ia10 = await paid(a10); await auditRow(a10.id, ia10.id, 'grouped_visit');
    // A11. the completion's own verdict (a 409 with an unlisted code) → left alone
    const a11 = await visit({ status: 'on_site' }); const ia11 = await paid(a11); await auditRow(a11.id, ia11.id, 'project_required_completion', { status: 409 });
    // A12. a DRAFT invoice (never delivered) → not a candidate
    const a12 = await visit({ status: 'on_site' }); await invoice({ status: 'draft', scheduled_service_id: a12.id });
    // A13. issued outside the window → not a candidate
    const a13 = await visit({ status: 'on_site' }); await paid(a13, { paid_at: new Date(Date.now() - 30 * 86400000) });
    // A14. a statement child → the statement sweep's, not this one's
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const [statementId] = await trx('payer_statements').insert({ payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status: 'paid', terms_snapshot: 'net30', token: randomUUID().replace(/-/g, ''), paid_at: new Date() }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const a14 = await visit({ status: 'on_site' }); await paid(a14, { payer_statement_id: statementId });
    // A15. en_route → not a candidate
    const a15 = await visit({ status: 'en_route' }); await paid(a15);

    // ── UNSTARTED (pending / confirmed), past day: nobody is known to have gone ──
    // U1. paid ON the visit day (2040-03-03 fixture day, paid then), NEVER ran → left alone: a prepayment whose day passed is not proof the visit happened
    const u1 = await visit(); await paid(u1, { paid_at: new Date('2040-03-03T15:00:00Z') });
    // U7. paid BEFORE the visit day, never ran → left alone
    const u7 = await visit(); await paid(u7, { paid_at: new Date('2040-03-01T15:00:00Z') });
    // U8. paid on a LATER day than the visit, never ran (the process died before the closeout) → retried: no prepayment, the live path closes exactly this
    const u8 = want(await visit(), 'paid'); await paid(u8, { paid_at: new Date('2040-03-04T15:00:00Z') });
    // U9. …and the same for a send delivered after the visit day
    const u9 = want(await visit({ status: 'pending' }), 'sent'); await sent(u9, { sent_at: new Date('2040-03-04T15:00:00Z') });
    // U10. 11:30 PM ET on the visit day is 03:30Z the next day — still the visit day in ET → left alone
    const u10 = await visit(); await paid(u10, { paid_at: new Date('2040-03-04T03:30:00Z') });
    // U2. paid before anyone arrived (visit_scheduled_today), the day has passed → STILL left alone
    const u2 = await visit(); const iu2 = await paid(u2, { paid_at: new Date('2040-03-03T15:00:00Z') }); await auditRow(u2.id, iu2.id, 'visit_scheduled_today');
    // U3. a closeout that RAN on an eligible day and failed → retried
    const u3 = want(await visit(), 'paid'); const iu3 = await paid(u3, { paid_at: new Date('2040-03-04T15:00:00Z') }); await auditRow(u3.id, iu3.id, 'error');
    // U4. …also for a send
    const u4 = want(await visit({ status: 'pending' }), 'sent'); const iu4 = await sent(u4, { sent_at: new Date('2040-03-04T15:00:00Z') }); await auditRow(u4.id, iu4.id, 'issued_visit_rescheduled', { trigger: 'sent' });
    // U11. a closeout failed (error row), but the invoice was settled ON the visit day → left alone: an error row is not evidence anyone went
    const u11 = await visit(); const iu11 = await paid(u11, { paid_at: new Date('2040-03-03T15:00:00Z') }); await auditRow(u11.id, iu11.id, 'error');
    // U12. a rescheduling race (issued_visit_rescheduled) moved the visit to a day AFTER the invoice; that day has passed → left alone: it is a prepayment for the day the visit is on now
    const u12 = await visit(); const iu12 = await paid(u12, { paid_at: new Date('2040-03-01T15:00:00Z') }); await auditRow(u12.id, iu12.id, 'issued_visit_rescheduled');
    // U5. sent on the visit day, never ran → left alone
    const u5 = await visit(); await sent(u5, { sent_at: new Date('2040-03-03T15:00:00Z') });
    // U6. unstarted TODAY with an error row → not a candidate today
    const u6 = await visit({ date: TODAY }); const iu6 = await paid(u6, { date: TODAY }); await auditRow(u6.id, iu6.id, 'error');

    // ── COMPLETED with this closeout's own attempt parked → resumed ──
    const c1 = want(await visit({ status: 'completed' }), 'paid'); const ic1 = await paid(c1);
    await trx('service_completion_attempts').insert({ id: randomUUID(), service_id: c1.id, idempotency_key: `invoice-issued:${ic1.id}`, status: 'side_effects_pending', request_hash: 'x' });
    // …a completed visit with nothing parked is not a candidate
    const c2 = await visit({ status: 'completed' }); await paid(c2);

    const out = await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY });
    expect(out).toEqual({ candidates: 27, retried: 18, closed: 18 });
    const calls = mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout.trigger]);
    expect(calls.sort()).toEqual(expectRetried.sort());
    // A retry is nobody's action: the system is the actor.
    for (const [args] of mockCompleteScheduledService.mock.calls) expect(args.actor).toEqual({ techRole: 'admin', technicianId: null, technician: null });
    mockGate.on = false;
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 0, retried: 0, closed: 0 });
  });

  test('report after pay (GATE_REPORT_AFTER_PAY): an arrived visit paid on its own day stays open for the payment and for that day\'s sweep; the next day\'s sweep closes it', async () => {
    const { retryIssuedInvoiceCloseouts } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const inv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY });
    // The payment rail's own closeout: refused for the day, nothing completed.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
    // The audit module is mocked here; write the row it would have written.
    await trx('audit_log').insert({ actor_type: 'system', action: 'visit.completion_on_invoice_issued_refused', resource_type: 'scheduled_services', resource_id: svc.id, metadata: JSON.stringify({ invoiceId: inv.id, trigger: 'paid', code: 'visit_scheduled_today' }) });
    // The sweep on the visit day does not pick it up.
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 0, retried: 0, closed: 0 });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // The day after: the refusal was about the day, so the sweep closes the visit quietly.
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: '2040-03-05' })).toEqual({ candidates: 1, retried: 1, closed: 1 });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout.trigger])).toEqual([[svc.id, 'paid']]);
  });

  // Pre-push audit rounds 8-11: a record_payment card that deferred its close met the hold in a new way each round (its pin, its
  // settlement, the receipt resend card). The card's payment now holds nothing. Its probe (noHold) names an immediate close, as with
  // the gate off, and its pin, written with the payment, keeps that payment from holding its visit on every later path: the card's
  // own closeout, a receipt resend and its preview, another caller with no target, and the visit-day sweep all close the visit.
  test('report after pay: a payment the record_payment card approved holds nothing: its probe names an immediate close, and the payment closes the visit on every path, as with the gate off', async () => {
    const { retryIssuedInvoiceCloseouts, reportAfterPayHold } = require('../services/invoice-issued-closeout');
    const { settlementFenceFor } = require('../services/intelligence-bar/record-payment-fences');
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const open = await invoice({ status: 'sent', scheduled_service_id: svc.id, date: TODAY });
    // Gate off: the payment closes the visit now, and the card's probe names it.
    expect(await issuedCloseoutTarget(open, { today: TODAY, conn: trx, noHold: true })).toMatchObject({ visitId: svc.id });
    mockGate.reportAfterPay = true;
    // Gate on: any other payment of this invoice would hold the visit, so a probe that reads one names no close today.
    expect(await issuedCloseoutTarget(open, { today: TODAY, conn: trx })).toBeNull();
    // The card's probe names the visit its payment closes now. A send never closes a same-day visit.
    const target = await issuedCloseoutTarget(open, { today: TODAY, conn: trx, noHold: true });
    expect(target).toMatchObject({ visitId: svc.id, status: 'on_site', date: TODAY, resuming: false });
    expect(target).not.toHaveProperty('deferred');
    expect(await issuedCloseoutTarget(open, { today: TODAY, conn: trx, trigger: 'sent', noHold: true })).toBeNull();
    // The payment: the settlement pins the card's target with the visit's facts, as on main.
    const fence = settlementFenceFor({ invoiceId: open.id, closeoutTarget: target.visitId, paymentDate: TODAY,
      closeout: { visitId: target.visitId, serviceType: target.serviceType, date: target.date, status: target.status, updatedAtMs: new Date(target.updatedAt).getTime(), resuming: false } });
    expect(fence.closeoutVisit).toEqual({ serviceType: svc.service_type, date: TODAY, status: 'on_site', updatedAtMs: new Date(svc.updated_at).getTime() });
    await trx('invoices').where({ id: open.id }).update({ status: 'paid', paid_at: PAID_AT });
    await pinPayment(open.id, fence.closeoutTarget, fence.closeoutVisit);
    const paid = await trx('invoices').where({ id: open.id }).first();
    // The card's own closeout closes the visit at once.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: open.id, trigger: 'paid', conn: trx, today: TODAY, approvedTarget: fence.closeoutTarget, approvedVisit: fence.closeoutVisit }))
      .toMatchObject({ closed: true, visitId: svc.id });
    // A receipt resend: its card's preview names the close, and its run (which records no hold) makes it.
    expect(await issuedCloseoutTarget(paid, { today: TODAY, conn: trx })).toMatchObject({ visitId: svc.id, resuming: false });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: open.id, trigger: 'paid', conn: trx, today: TODAY, recordHold: false })).toMatchObject({ closed: true, visitId: svc.id });
    // Another caller with no target of its own, and the visit-day sweep, which honors the pin.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: open.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: true, visitId: svc.id });
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 1, retried: 1, closed: 1 });
    // Each close carries the payment it ran for; the two with the card's target re-assert the visit's facts. Nothing is held.
    const paidAtMs = PAID_AT.getTime();
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([
      [svc.id, { invoiceId: open.id, trigger: 'paid', expectedVisit: fence.closeoutVisit, paidAtMs }],
      [svc.id, { invoiceId: open.id, trigger: 'paid', paidAtMs }],
      [svc.id, { invoiceId: open.id, trigger: 'paid', paidAtMs }],
      [svc.id, { invoiceId: open.id, trigger: 'paid', expectedVisit: fence.closeoutVisit, paidAtMs }],
    ]);
    expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
    expect(recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held')).toEqual([]);
  });

  // Pre-push audit round 3: held open, a visit with a second invoice had its two invoices picked differently by Dispatch, Charge
  // Now, the completion and the sweep. The gate holds only a visit its paid invoice alone bills; any other closes as with it off.
  test('report after pay: a visit with another invoice on it is not held: every probe names the close, and the same-day payment closes it on the paid invoice, as with the gate off', async () => {
    const { reportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const open = await invoice({ status: 'sent', scheduled_service_id: svc.id, date: TODAY });
    const draft = await invoice({ status: 'draft', scheduled_service_id: svc.id, date: TODAY });
    expect(await issuedCloseoutTarget(open, { today: TODAY, conn: trx })).toMatchObject({ visitId: svc.id, status: 'on_site' });
    await trx('invoices').where({ id: open.id }).update({ status: 'paid', paid_at: PAID_AT });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: open.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: true, visitId: svc.id });
    // The close carries the payment the closeout loaded (the completion refuses a locked row that carries another one).
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([[svc.id, { invoiceId: open.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }]]);
    // The other row is left as it was, for the office.
    expect(await trx('invoices').where({ id: draft.id }).first()).toMatchObject({ status: 'draft', service_record_id: null });
    expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
  });

  // Pre-push audit round 11: a receipt resend after the technician arrived could record the visit's first hold, which its card had
  // not shown (the preview read no close). A resend retries a close and is not the payment's closeout: it records no hold, so the
  // preview and the run agree. The next closeout that may record one (here the visit-day sweep) decides the hold.
  test('report after pay: a receipt resend records no hold: a visit its payment would hold stays open today, as the resend card previews, and the visit-day sweep records the hold', async () => {
    const { retryIssuedInvoiceCloseouts, reportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    // Paid before the technician arrived (a prepayment, which holds nothing); the technician has arrived since.
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const inv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY });
    const preview = (today = TODAY) => issuedCloseoutTarget(inv, { today, conn: trx });
    const resend = (today = TODAY) => closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today, recordHold: false });
    expect(await preview()).toBeNull();
    expect(await resend()).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
    expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
    expect(recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held')).toEqual([]);
    // The visit-day sweep is a closeout of the payment: it records the hold.
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 1, retried: 1, closed: 0 });
    expect(await reportAfterPayHold(trx, svc.id)).toMatchObject({ id: inv.id, hold_paid_at_ms: String(PAID_AT.getTime()) });
    // Held: the preview still reads no close, and the resend still makes none.
    expect(await preview()).toBeNull();
    expect(await resend()).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // The day after, a resend closes the held visit on its payment, as the sweep would, and the preview names it.
    expect(await preview('2040-03-05')).toMatchObject({ visitId: svc.id, resuming: false });
    expect(await resend('2040-03-05')).toMatchObject({ closed: true, visitId: svc.id });
    // Gate off: a resend on the visit day closes the arrived visit, as before the gate.
    mockGate.reportAfterPay = false;
    expect(await preview()).toMatchObject({ visitId: svc.id });
    expect(await resend()).toMatchObject({ closed: true, visitId: svc.id });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([
      [svc.id, { invoiceId: inv.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }],
      [svc.id, { invoiceId: inv.id, trigger: 'paid' }],
    ]);
  });

  // Pre-push audit round 12 on #8239. A card-driven receipt resend checks its card under the claim, then runs the closeout, which
  // resolves the visit again. A visit that became closable in between was closed although the card had not named it. The writer
  // now hands the closeout the card's target (invoice-receipt-resend.js runCloseout; `resend` below is its call), and the
  // closeout leaves any other visit open. The target limits that run only: the refusal is of the moment (visit_not_on_card),
  // so the payment's own retry, and a later send's, decide the visit again by the ordinary rule.
  test('a card-driven receipt resend closes only the visit its card named: a visit that became closable after the card stays open for that run, and a later retry decides it by the ordinary rule', async () => {
    const { retryIssuedInvoiceCloseouts } = require('../services/invoice-issued-closeout');
    const resend = (inv, approvedTarget) => closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', actorTechnicianId: null, conn: trx, today: TODAY, recordHold: false, approvedTarget, targetBindsRetries: false });
    const preview = (inv) => issuedCloseoutTarget(inv, { today: TODAY, conn: trx });
    // The audit module is mocked here: write the row the closeout recorded last, so the sweep reads it.
    const writeLastAudit = async () => {
      const [event] = recordAuditEvent.mock.calls.at(-1);
      await trx('audit_log').insert({ actor_type: event.actor_type, action: event.action, resource_type: event.resource_type, resource_id: event.resource_id, metadata: JSON.stringify(event.metadata) });
      return event;
    };
    // 1. Report after pay: the card read no close, because the payment would hold the arrived visit. The office adds a bill
    //    after the writer's check. The payment holds nothing any more and the closeout would close the visit: the card said none.
    mockGate.reportAfterPay = true;
    const held = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const heldInv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: held.id, date: TODAY });
    expect(await preview(heldInv)).toBeNull();
    await invoice({ status: 'draft', scheduled_service_id: held.id, date: TODAY });
    expect(await preview(heldInv)).toMatchObject({ visitId: held.id });
    expect(await resend(heldInv, 'none')).toMatchObject({ closed: false, reason: 'visit_not_on_card', visitId: held.id, approvedTarget: 'none', audited: true });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(await writeLastAudit()).toMatchObject({
      action: 'visit.completion_on_invoice_issued_refused', resource_id: held.id, metadata: { invoiceId: heldInv.id, trigger: 'paid', code: 'visit_not_on_card' },
    });
    // The day's sweep is the payment's own retry: it closes the visit, as it closes any arrived visit with another bill on it.
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 1, retried: 1, closed: 1 });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([[held.id, { invoiceId: heldInv.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }]]);
    // 2. Gate off, the same window: the technician was on the way when the card was made (no close) and arrives before the
    //    closeout runs. The card said none, so the visit stays open. A card that names the visit closes it, and only it.
    mockGate.reportAfterPay = false;
    mockCompleteScheduledService.mockClear();
    const late = await visit({ status: 'en_route', date: TODAY });
    const lateInv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: late.id, date: TODAY });
    expect(await preview(lateInv)).toBeNull();
    await trx('scheduled_services').where({ id: late.id }).update({ status: 'on_site', arrived_at: ARRIVED_AT });
    expect(await resend(lateInv, 'none')).toMatchObject({ closed: false, reason: 'visit_not_on_card', visitId: late.id });
    expect(await resend(lateInv, randomUUID())).toMatchObject({ closed: false, reason: 'visit_not_on_card', visitId: late.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    const card = await preview(lateInv);
    expect(await resend(lateInv, card.visitId)).toMatchObject({ closed: true, visitId: late.id });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => args.serviceId)).toEqual([late.id]);
    // 3. The payment is undone after the refusal (pre-push audit of this fix): the invoice is delivered and unpaid again. The
    //    next day's sweep closes the arrived visit on the send, as for any delivered invoice: a resend's refusal blocks no
    //    retry. The same refusal from a card whose target does bind (a send's, a record_payment's) leaves the visit to a
    //    person, as before.
    const NEXT_DAY = '2040-03-05';
    for (const [cardBinds, reason, closedOnTheSend] of [[false, 'visit_not_on_card', 1], [true, 'approved_target_mismatch', 0]]) {
      const undone = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
      const undoneInv = await invoice({ status: 'paid', paid_at: PAID_AT, sent_at: new Date(), scheduled_service_id: undone.id, date: TODAY });
      expect(await closeOutVisitForIssuedInvoice({ invoiceId: undoneInv.id, trigger: 'paid', conn: trx, today: TODAY, recordHold: false, approvedTarget: 'none', targetBindsRetries: cardBinds }))
        .toMatchObject({ closed: false, reason, visitId: undone.id });
      await writeLastAudit();
      await trx('invoices').where({ id: undoneInv.id }).update({ status: 'sent', paid_at: null });
      mockCompleteScheduledService.mockClear();
      await retryIssuedInvoiceCloseouts({ conn: trx, today: NEXT_DAY });
      const onTheSend = mockCompleteScheduledService.mock.calls.filter(([args]) => args.serviceId === undone.id);
      expect(onTheSend.map(([args]) => args.issuedInvoiceCloseout.trigger)).toEqual(closedOnTheSend ? ['sent'] : []);
    }
  });

  // The visit-day sweep skips only a visit with a live hold. Any other arrived visit with a settled invoice is admitted, and its
  // closeout decides as the payment's own would have: it records the hold when the paid invoice is the visit's only bill (a void
  // row does not count) and closes the visit when another bill is on it, as with the gate off.
  test('report after pay: on the visit day the sweep skips a visit with a live hold and admits the others: the closeout holds a visit its paid invoice alone bills and closes one with another bill on it', async () => {
    const { retryIssuedInvoiceCloseouts, reportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const settled = (svc) => invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY });
    const shared = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const paid = await settled(shared);
    await invoice({ status: 'draft', scheduled_service_id: shared.id, date: TODAY });
    const alone = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const aloneInv = await settled(alone);
    await invoice({ status: 'void', scheduled_service_id: alone.id, date: TODAY });
    // Held at its payment; a bill added since does not end the hold.
    const held = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const heldInv = await settled(held);
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: heldInv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_scheduled_today' });
    await invoice({ status: 'draft', scheduled_service_id: held.id, date: TODAY });
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 2, retried: 2, closed: 1 });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([[shared.id, { invoiceId: paid.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }]]);
    expect((await reportAfterPayHold(trx, alone.id))?.id).toBe(aloneInv.id);
    expect((await reportAfterPayHold(trx, held.id))?.id).toBe(heldInv.id);
    expect(await reportAfterPayHold(trx, shared.id)).toBeNull();
  });

  // Pre-push audit rounds 6-7: the hold belongs to the payment, decided once by its closeout and recorded; no reader re-derives it
  // from the visit's or the invoice's stamps, which can change after the payment (the completion backdates an arrival; a webhook
  // stamps its processing time). A payment whose closeout ran before the technician arrived (a prepayment), or on another day,
  // records nothing. The record is live only while its invoice still carries that payment on the visit: undone, or paid again,
  // the hold ends and every reader acts as with the gate off. The resolver, the completion's held invoice, the visit-day sweep
  // and the Dispatch flag all read the record. Gate off: every reader ignores it.
  test('report after pay: the hold is decided once by the payment\'s closeout and read from its record by every reader; a prepayment or another day records nothing; an undone or repeated payment ends it', async () => {
    const { retryIssuedInvoiceCloseouts, reportAfterPayHold, reportAfterPayHeldVisitIds } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const pay = (inv, at = PAID_AT) => trx('invoices').where({ id: inv.id }).update({ status: 'paid', paid_at: at });
    const closeout = (inv, today = TODAY) => closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today });
    const held = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const heldInv = await invoice({ status: 'sent', scheduled_service_id: held.id, date: TODAY });
    await pay(heldInv);
    expect(await closeout(heldInv)).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: held.id });
    // Paid while nobody had arrived: its closeout leaves the visit open as a prepayment and records nothing. The arrival stamp
    // written later, even one backdated before the payment, changes nothing.
    const prepaid = await visit({ status: 'confirmed', date: TODAY });
    const prepaidInv = await invoice({ status: 'sent', scheduled_service_id: prepaid.id, date: TODAY });
    await pay(prepaidInv);
    expect(await closeout(prepaidInv)).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: prepaid.id });
    await trx('scheduled_services').where({ id: prepaid.id }).update({ status: 'completed', arrived_at: ARRIVED_AT });
    // Yesterday's visit, paid today: its closeout closes it.
    const paidLate = await visit({ status: 'on_site', date: YESTERDAY, arrived_at: new Date(`${YESTERDAY}T14:00:00Z`) });
    const paidLateInv = await invoice({ status: 'sent', scheduled_service_id: paidLate.id, date: YESTERDAY });
    await pay(paidLateInv);
    expect(await closeout(paidLateInv)).toMatchObject({ closed: true, visitId: paidLate.id });
    // The completion (mocked here) marks it completed.
    await trx('scheduled_services').where({ id: paidLate.id }).update({ status: 'completed' });
    expect(recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held').map(([event]) => [event.resource_id, event.metadata.invoiceId]))
      .toEqual([[held.id, String(heldInv.id)]]);
    expect((await reportAfterPayHold(trx, held.id))?.id).toBe(heldInv.id);
    expect(await reportAfterPayHold(trx, prepaid.id)).toBeNull();
    expect(await reportAfterPayHold(trx, paidLate.id)).toBeNull();
    expect([...await reportAfterPayHeldVisitIds(trx, [held.id, prepaid.id, paidLate.id])]).toEqual([String(held.id)]);
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 0, retried: 0, closed: 0 });
    // Gate off: every reader ignores the record, and the payment's closeout closes the visit, as before the gate.
    mockGate.reportAfterPay = false;
    expect(await reportAfterPayHold(trx, held.id)).toBeNull();
    expect((await reportAfterPayHeldVisitIds(trx, [held.id])).size).toBe(0);
    expect((await resolveVisitForIssuedInvoice(trx, heldInv, { today: TODAY, trigger: 'paid' })).svc.id).toBe(held.id);
    mockGate.reportAfterPay = true;
    // Undone: the record names a payment the invoice no longer carries, so nothing is held.
    await trx('invoices').where({ id: heldInv.id }).update({ status: 'sent', paid_at: null });
    expect(await reportAfterPayHold(trx, held.id)).toBeNull();
    expect((await reportAfterPayHeldVisitIds(trx, [held.id])).size).toBe(0);
    // Paid again: the old record is not this payment's; the new payment's closeout decides again and records its own.
    const repaidAt = new Date(PAID_AT.getTime() + 3600000);
    await pay(heldInv, repaidAt);
    expect(await reportAfterPayHold(trx, held.id)).toBeNull();
    expect(await closeout(heldInv)).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: held.id });
    expect(await reportAfterPayHold(trx, held.id)).toMatchObject({ id: heldInv.id, hold_paid_at_ms: String(repaidAt.getTime()) });
    // Refunded: the invoice keeps its paid_at, but a refunded payment holds nothing.
    await trx('invoices').where({ id: heldInv.id }).update({ status: 'refunded' });
    expect(await reportAfterPayHold(trx, held.id)).toBeNull();
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => args.serviceId)).toEqual([paidLate.id]);
  });

  // The record_payment card's pin stands as with the gate off, and its payment holds nothing (pre-push audit rounds 9-11). A payment
  // whose card named another visit, or none, leaves this visit for a person on the card's own closeout and on the sweep
  // (approved_target_mismatch), and a caller with no target of its own (a receipt resend after the technician arrived, another
  // rail) closes it, as on main: every path gives the same result with the gate on as with it off, and none records a hold. A
  // target handed in is checked before the hold is written, so a visit the card did not name is never held.
  test('report after pay: a payment whose card named another visit, or none, holds nothing: every path acts as with the gate off', async () => {
    const { retryIssuedInvoiceCloseouts, reportAfterPayHold } = require('../services/invoice-issued-closeout');
    const holdRows = () => recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held');
    mockGate.reportAfterPay = true;
    // No pin on file, but the caller hands in a target that is not this visit: refused before any hold.
    const unpinned = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const unpinnedInv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: unpinned.id, date: TODAY });
    for (const approvedTarget of ['none', randomUUID()]) {
      expect(await closeOutVisitForIssuedInvoice({ invoiceId: unpinnedInv.id, trigger: 'paid', conn: trx, today: TODAY, approvedTarget }))
        .toMatchObject({ closed: false, reason: 'approved_target_mismatch', visitId: unpinned.id });
    }
    expect(await reportAfterPayHold(trx, unpinned.id)).toBeNull();
    expect(holdRows()).toEqual([]);
    // The card pinned none (the payment came before the arrival); the technician has arrived since.
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const inv = await invoice({ status: 'paid', paid_at: new Date(PAID_AT.getTime() + 1000), scheduled_service_id: svc.id, date: TODAY });
    await pinPayment(inv.id, 'none');
    recordAuditEvent.mockClear();
    const everyPath = async () => ({
      card: await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY, approvedTarget: 'none' }),
      preview: await issuedCloseoutTarget(inv, { today: TODAY, conn: trx }),
      resend: await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY, recordHold: false }),
      otherRail: await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY }),
    });
    const gateOn = await everyPath();
    expect(gateOn.card).toMatchObject({ closed: false, reason: 'approved_target_mismatch', visitId: svc.id });
    expect(gateOn.preview).toMatchObject({ visitId: svc.id, resuming: false });
    expect(gateOn.resend).toMatchObject({ closed: true, visitId: svc.id });
    expect(gateOn.otherRail).toMatchObject({ closed: true, visitId: svc.id });
    // The visit-day sweep honors the pin for the pinned payment (left for a person) and holds the unpinned one.
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 2, retried: 2, closed: 0 });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused', resource_id: svc.id,
      metadata: expect.objectContaining({ invoiceId: inv.id, code: 'approved_target_mismatch' }) }));
    expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
    expect(holdRows().map(([event]) => event.resource_id)).toEqual([unpinned.id]);
    mockGate.reportAfterPay = false;
    expect(await everyPath()).toEqual(gateOn);
  });

  // Pre-push audit round 8: a payment undone or charged back after its closeout started is gone by the time the hold is written.
  // The visit stays open with its own code, which the retry sweep asks again; it is never closed quietly on the payment. The hold's
  // write also leaves a visit held on another invoice's payment for that payment. Round 11: a payment undone and made again is
  // gone too; the invoice carries another payment. Gate off, the closeout goes on as before.
  test('report after pay: a payment undone, charged back or replaced by another before the hold is written leaves the visit open (visit_payment_reversed), never closed or held on it', async () => {
    const { reportAfterPayHold, recordReportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    // The payment's closeout runs on a 'paid' trigger, but the invoice is due again.
    const reversed = await invoice({ status: 'overdue', scheduled_service_id: svc.id, date: TODAY });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: reversed.id, trigger: 'paid', conn: trx, today: TODAY }))
      .toMatchObject({ closed: false, reason: 'visit_payment_reversed', visitId: svc.id });
    expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // Held on another invoice's payment, written after this payment's closeout read the visit: left for that payment.
    const other = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const first = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: other.id, date: TODAY });
    expect(await recordReportAfterPayHold(trx, { visitId: other.id, invoiceId: first.id, today: TODAY })).toBe(true);
    const second = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: other.id, date: TODAY });
    expect(await recordReportAfterPayHold(trx, { visitId: other.id, invoiceId: second.id, today: TODAY })).toBe('visit_paid_on_other_invoice');
    // Round 11: undone and made again while its closeout ran. The closeout loaded one payment; by the time the hold is written the
    // invoice carries another. That payment is not this closeout's to hold: its own closeout decides for it, and records its own.
    const repaid = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const repaidInv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: repaid.id, date: TODAY });
    const repaidAt = new Date(PAID_AT.getTime() + 60000);
    const actualProfiles = jest.requireActual('../services/service-completion-profiles');
    mockProbe.profile = async (...args) => {
      // Between the resolver's reads and the hold's write: the office undoes the payment and records it again.
      await trx('invoices').where({ id: repaidInv.id }).update({ paid_at: repaidAt });
      return actualProfiles.resolveCompletionProfileForScheduledService(...args);
    };
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: repaidInv.id, trigger: 'paid', conn: trx, today: TODAY }))
      .toMatchObject({ closed: false, reason: 'visit_payment_reversed', visitId: repaid.id });
    mockProbe.profile = null;
    expect(await reportAfterPayHold(trx, repaid.id)).toBeNull();
    expect(await recordReportAfterPayHold(trx, { visitId: repaid.id, invoiceId: repaidInv.id, today: TODAY, paidAtMs: PAID_AT.getTime() })).toBe('visit_payment_reversed');
    // The new payment's own closeout holds the visit on it.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: repaidInv.id, trigger: 'paid', conn: trx, today: TODAY }))
      .toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: repaid.id });
    expect(await reportAfterPayHold(trx, repaid.id)).toMatchObject({ id: repaidInv.id, hold_paid_at_ms: String(repaidAt.getTime()) });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // Gate off: the payment's closeout closes the visit, as before the gate.
    mockGate.reportAfterPay = false;
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: reversed.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ visitId: svc.id });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => args.serviceId)).toEqual([svc.id]);
  });

  // A technician on site has a job timer running when the customer pays. Gate off, that timer leaves the visit open
  // (visit_timer_running) until a sweep finds it stopped. Gate on, the payment holds the visit all the same: a running timer does
  // not stand in the hold's way. A caller that holds nothing (the record_payment card's probe) still reads the timer, as with the
  // gate off, and so does the closeout once the visit's day has passed.
  test('report after pay: a running job timer does not stop the hold; the card\'s probe and the next day\'s closeout still read the timer', async () => {
    const { reportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Fixture Tech' });
    await trx('time_entries').insert({ id: randomUUID(), technician_id: techId, entry_type: 'shift', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: new Date(ARRIVED_AT.getTime() - 60000) });
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT, technician_id: techId });
    await trx('time_entries').insert({ id: randomUUID(), technician_id: techId, entry_type: 'job', status: 'active', staff_write_generation: ACTIVE_WRITE_GENERATION, clock_in: ARRIVED_AT, job_id: svc.id });
    const inv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY });
    expect(await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'paid', noHold: true })).toMatchObject({ svc: null, reason: 'visit_timer_running' });
    expect(await resolveVisitForIssuedInvoice(trx, inv, { today: TODAY, trigger: 'paid' })).toMatchObject({ svc: null, reason: 'visit_scheduled_today' });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
    expect(await reportAfterPayHold(trx, svc.id)).toMatchObject({ id: inv.id });
    // The day after, the hold no longer keeps the visit open, and the running timer does, as with the gate off.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: '2040-03-05' })).toMatchObject({ closed: false, reason: 'visit_timer_running', visitId: svc.id });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
  });

  // A bill added while the payment's closeout runs, between the resolver's reads and the hold's write. The write reads the visit's
  // bills again under the mint lock: the visit now has another bill, so nothing is held, and the closeout goes on and closes the
  // visit on the paid invoice, as it does with the gate off for a visit with another bill.
  test('report after pay: a bill added between the closeout\'s reads and the hold\'s write is not held over: the closeout closes the visit on the paid invoice', async () => {
    const { reportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const inv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY });
    const actualProfiles = jest.requireActual('../services/service-completion-profiles');
    const added = [];
    mockProbe.profile = async (...args) => {
      if (!added.length) added.push(await invoice({ status: 'draft', scheduled_service_id: svc.id, date: TODAY }));
      return actualProfiles.resolveCompletionProfileForScheduledService(...args);
    };
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: true, visitId: svc.id });
    mockProbe.profile = null;
    expect(added).toHaveLength(1);
    expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
    expect(recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held')).toEqual([]);
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout]))
      .toEqual([[svc.id, { invoiceId: inv.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }]]);
  });

  // The hold's write reads the visit again under the mint lock, too. A visit that was completed, set back to unstarted or moved
  // off the day since the closeout's reads is not one the payment holds: nothing is recorded, and the closeout goes on to the
  // completion, whose locked recheck judges the visit as it stands (the closeout-completion suite covers that recheck).
  test('report after pay: a visit closed, set back or moved between the closeout\'s reads and the hold\'s write is not held', async () => {
    const { reportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const actualProfiles = jest.requireActual('../services/service-completion-profiles');
    for (const change of [{ status: 'completed' }, { status: 'confirmed' }, { scheduled_date: '2040-03-05' }]) {
      const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
      const inv = await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY });
      let changed = 0;
      mockProbe.profile = async (...args) => {
        if (!changed) changed = await trx('scheduled_services').where({ id: svc.id }).update(change);
        return actualProfiles.resolveCompletionProfileForScheduledService(...args);
      };
      mockCompleteScheduledService.mockClear();
      await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY });
      mockProbe.profile = null;
      expect(changed).toBe(1);
      expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
      expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout]))
        .toEqual([[svc.id, { invoiceId: inv.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }]]);
    }
    expect(recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held')).toEqual([]);
  });

  // Pre-push audit round 12: the hold waits for the technician's report, so the payment holds only a visit whose completion sends
  // the customer one. Any other closes on its payment, as with the gate off: before this, such a visit was held with no Dispatch
  // badge (the badge read the profile; the hold did not). The answer is the completion's own delivery posture, read from the
  // visit's profile; the Dispatch badge now reads the hold alone.
  test('report after pay: only a visit whose completion sends the customer a report is held; any other closes on its payment, as with the gate off', async () => {
    const { reportAfterPayHold, recordReportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const ROUTINE = { serviceKey: 'fixture_routine', completionMode: 'service_report', deliveryMode: 'auto_send', category: 'pest' };
    const holdRows = () => recordAuditEvent.mock.calls.filter(([event]) => event.action === 'visit.report_after_pay_held').map(([event]) => event.resource_id);
    const paidOnSite = async () => {
      const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
      return { svc, inv: await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY }) };
    };
    const closeout = (inv) => closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY });
    const savedKill = process.env.SPECIALTY_REPORT_DELIVERY_DISABLED;
    try {
      const noReport = [
        ['an internal-only consultation', { ...ROUTINE, completionMode: 'internal_only' }],
        ['delivery disabled', { ...ROUTINE, deliveryMode: 'disabled' }],
        ['internal-only delivery', { ...ROUTINE, deliveryMode: 'internal_only' }],
        ['a typed report kept internal', { ...ROUTINE, findingsType: 'bed_bug', deliveryMode: 'internal_only', category: 'specialty' }],
        ['a specialty report under the specialty kill', { ...ROUTINE, category: 'specialty' }, 'true'],
        ['a typed report of any category under the specialty kill', { ...ROUTINE, findingsType: 'cockroach' }, 'true'],
      ];
      for (const [name, profile, kill] of noReport) {
        if (kill) process.env.SPECIALTY_REPORT_DELIVERY_DISABLED = kill; else delete process.env.SPECIALTY_REPORT_DELIVERY_DISABLED;
        mockProbe.profile = async () => profile;
        const { svc, inv } = await paidOnSite();
        // The resend card's preview names the close, the payment's closeout makes it, and the hold's own write records nothing.
        expect([name, await issuedCloseoutTarget(inv, { today: TODAY, conn: trx })]).toEqual([name, expect.objectContaining({ visitId: svc.id })]);
        expect([name, await closeout(inv)]).toEqual([name, expect.objectContaining({ closed: true, visitId: svc.id })]);
        expect([name, await recordReportAfterPayHold(trx, { visitId: svc.id, invoiceId: inv.id, today: TODAY, paidAtMs: PAID_AT.getTime() })]).toEqual([name, null]);
        expect([name, await reportAfterPayHold(trx, svc.id)]).toEqual([name, null]);
      }
      expect(holdRows()).toEqual([]);
      // The same two profiles with the specialty kill off, and a routine visit: each sends a report, so each is held.
      delete process.env.SPECIALTY_REPORT_DELIVERY_DISABLED;
      const heldIds = [];
      for (const profile of [{ ...ROUTINE, category: 'specialty' }, { ...ROUTINE, findingsType: 'cockroach' }, ROUTINE]) {
        mockProbe.profile = async () => profile;
        mockProbe.profileCalls = [];
        const { svc, inv } = await paidOnSite();
        expect(await issuedCloseoutTarget(inv, { today: TODAY, conn: trx })).toBeNull();
        expect(await closeout(inv)).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
        expect(await reportAfterPayHold(trx, svc.id)).toMatchObject({ id: inv.id });
        heldIds.push(svc.id);
      }
      expect(holdRows()).toEqual(heldIds);
      // Every profile read of a held closeout is STRICT: the preview's and the closeout's hold decision, the closeout's project
      // probe, and the hold's write. An unverifiable profile is an audited error (which the retry sweep asks again), never a hold
      // and never a close.
      expect(mockProbe.profileCalls).toEqual([{ strict: true }, { strict: true }, { strict: true }, { strict: true }]);
      const { svc, inv } = await paidOnSite();
      mockProbe.profile = async () => { throw new Error('relation probe failed'); };
      mockCompleteScheduledService.mockClear();
      expect(await closeout(inv)).toMatchObject({ closed: false, reason: 'error', error: 'relation probe failed', visitId: svc.id });
      expect(await reportAfterPayHold(trx, svc.id)).toBeNull();
      expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    } finally {
      if (savedKill === undefined) delete process.env.SPECIALTY_REPORT_DELIVERY_DISABLED; else process.env.SPECIALTY_REPORT_DELIVERY_DISABLED = savedKill;
    }
  });

  // The report condition reads the visit's own catalog service and its completion profile, from the stored rows. The hold's write
  // reads the visit again under the mint lock and resolves the profile from that row: the row must carry the columns the profile
  // is resolved from, and a profile changed since the resolver's reads is read as it stands.
  test('report after pay: the report condition reads the visit\'s own completion profile, at the resolver and again under the lock at the hold\'s write', async () => {
    const { reportAfterPayHold, recordReportAfterPayHold } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const catalog = async (name, profile) => {
      const id = randomUUID();
      const key = `fixture_${id.slice(0, 8)}`;
      await trx('services').insert({ id, name, service_key: key, category: 'pest', is_active: true });
      await trx('service_completion_profiles').insert({ service_key: key, creates_service_record: true, ...profile });
      return id;
    };
    const paidOnSite = async (rest = {}) => {
      const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT, ...rest });
      return { svc, inv: await invoice({ status: 'paid', paid_at: PAID_AT, scheduled_service_id: svc.id, date: TODAY }) };
    };
    const closeout = (inv) => closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY });
    // An internal-only consultation (as the Waves Assessment), named by the visit's service_id; the visit's label is a routine
    // service's. Not held on any path: the write resolves the same service from the row it reads.
    const consult = await paidOnSite({ service_id: await catalog('Fixture Walkthrough Consultation', { completion_mode: 'internal_only' }) });
    expect(await issuedCloseoutTarget(consult.inv, { today: TODAY, conn: trx })).toMatchObject({ visitId: consult.svc.id });
    expect(await recordReportAfterPayHold(trx, { visitId: consult.svc.id, invoiceId: consult.inv.id, today: TODAY, paidAtMs: PAID_AT.getTime() })).toBeNull();
    expect(await closeout(consult.inv)).toMatchObject({ closed: true, visitId: consult.svc.id });
    // A routine report service: held, by the closeout and by the write alone.
    const routineId = await catalog('Fixture Routine Report Service', { completion_mode: 'service_report' });
    const routine = await paidOnSite({ service_id: routineId });
    expect(await closeout(routine.inv)).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: routine.svc.id });
    const direct = await paidOnSite({ service_id: routineId });
    expect(await recordReportAfterPayHold(trx, { visitId: direct.svc.id, invoiceId: direct.inv.id, today: TODAY, paidAtMs: PAID_AT.getTime() })).toBe(true);
    // A project-backed visit completes only through its project: no payment holds it, and every caller reads its own refusal, as
    // with the gate off (a read that expected a hold would name the day instead).
    const project = await paidOnSite({ service_id: await catalog('Fixture Exclusion Project', { completion_mode: 'project_required', project_type: 'rodent_exclusion' }) });
    for (const deferSameDay of [undefined, true]) {
      expect(await resolveVisitForIssuedInvoice(trx, project.inv, { today: TODAY, trigger: 'paid', deferSameDay })).toMatchObject({ svc: null, reason: 'project_backed' });
    }
    expect(await closeout(project.inv)).toMatchObject({ closed: false, reason: 'project_backed', visitId: project.svc.id });
    // The office turns the service's report off between the resolver's reads and the hold's write. The write reads the profile
    // again under the lock (its own transaction), records nothing, and the closeout closes the visit, as with the gate off.
    const changed = await paidOnSite({ service_id: routineId });
    const actualProfiles = jest.requireActual('../services/service-completion-profiles');
    mockProbe.profile = async (row, knex, opts) => (knex === trx
      ? actualProfiles.resolveCompletionProfileForScheduledService(row, knex, opts)
      : { ...(await actualProfiles.resolveCompletionProfileForScheduledService(row, knex, opts)), deliveryMode: 'disabled' });
    mockCompleteScheduledService.mockClear();
    expect(await closeout(changed.inv)).toMatchObject({ closed: true, visitId: changed.svc.id });
    mockProbe.profile = null;
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout]))
      .toEqual([[changed.svc.id, { invoiceId: changed.inv.id, trigger: 'paid', paidAtMs: PAID_AT.getTime() }]]);
    const held = async (id) => (await reportAfterPayHold(trx, id))?.id || null;
    expect([await held(consult.svc.id), await held(routine.svc.id), await held(direct.svc.id), await held(project.svc.id), await held(changed.svc.id)])
      .toEqual([null, routine.inv.id, direct.inv.id, null, null]);
  });

  // Pre-push audit round 4: a bill made after the payment must not end the hold for the day. Every reader reads the recorded
  // hold, so a redelivered payment and the visit-day sweep leave the visit open too. Round 5: the next day the later bill's closeout leaves the held visit alone (visit_paid_on_other_invoice), whichever
  // invoice the sweep reaches first, and the visit closes on the paid invoice.
  test('report after pay: a bill made after the payment keeps the hold for the day; the next day the visit closes on the paid invoice, never on the later bill', async () => {
    const { retryIssuedInvoiceCloseouts } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    // Paid at 10:00 AM ET on the visit's own day, after the technician arrived.
    const paidAt = PAID_AT;
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    // Ids that sort the later bill first: the sweep reaches it before the paid invoice.
    const paidId = 'ffffffff-ffff-4fff-bfff-fffffffffff1';
    const laterId = '00000000-0000-4000-8000-000000000001';
    const bill = (id, fields) => trx('invoices').insert({
      id, customer_id: customerId, invoice_number: `TST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), total: 117, subtotal: 117,
      service_date: TODAY, service_type: svc.service_type, scheduled_service_id: svc.id,
      line_items: JSON.stringify([{ description: svc.service_type, amount: 117, quantity: 1, unit_price: 117 }]), ...fields,
    });
    await bill(paidId, { status: 'paid', paid_at: paidAt, created_at: new Date(paidAt.getTime() - 3600000) });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: paidId, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
    // The audit module is mocked here; write the row it would have written.
    await trx('audit_log').insert({ actor_type: 'system', action: 'visit.completion_on_invoice_issued_refused', resource_type: 'scheduled_services', resource_id: svc.id, metadata: JSON.stringify({ invoiceId: paidId, trigger: 'paid', code: 'visit_scheduled_today' }) });
    const madeAfter = new Date(paidAt.getTime() + 60000);
    await bill(laterId, { status: 'sent', sent_at: madeAfter, created_at: madeAfter });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: paidId, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_scheduled_today', visitId: svc.id });
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: TODAY })).toEqual({ candidates: 0, retried: 0, closed: 0 });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    // The next day: the later bill's closeout is refused, and the completion the paid invoice's closeout runs marks the visit completed.
    mockCompleteScheduledService.mockImplementationOnce(async ({ serviceId }) => {
      await trx('scheduled_services').where({ id: serviceId }).update({ status: 'completed' });
      return { status: 200, body: { success: true } };
    });
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: '2040-03-05' })).toEqual({ candidates: 2, retried: 2, closed: 1 });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused', resource_id: svc.id,
      metadata: expect.objectContaining({ invoiceId: laterId, code: 'visit_paid_on_other_invoice' }) }));
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([[svc.id, { invoiceId: paidId, trigger: 'paid', paidAtMs: paidAt.getTime() }]]);
  });

  // Pre-push audit round 5: the paid invoice of a held visit can be a payer-statement child, swept by the statement sweep, which runs
  // after the standalone one. A standalone bill sent after the settlement must not close the visit first; with the gate off it does,
  // as before.
  test('report after pay: a visit held on a statement child\'s same-day settlement closes on that child; a bill sent after it never closes the visit, in either sweep', async () => {
    const { retryIssuedInvoiceCloseouts } = require('../services/invoice-issued-closeout');
    mockGate.reportAfterPay = true;
    const paidAt = PAID_AT;
    const [payerId] = await trx('payers').insert({ display_name: 'Fixture Bill-To' }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const [statementId] = await trx('payer_statements').insert({
      payer_id: payerId, period_start: '2040-02-01', period_end: '2040-02-29', status: 'paid', terms_snapshot: 'net30',
      token: randomUUID().replace(/-/g, ''), paid_at: paidAt,
    }).returning('id').then((r) => r.map((x) => x.id ?? x));
    const svc = await visit({ status: 'on_site', date: TODAY, arrived_at: ARRIVED_AT });
    const child = await invoice({ status: 'paid', paid_at: paidAt, created_at: new Date(paidAt.getTime() - 3600000), payer_statement_id: statementId, scheduled_service_id: svc.id, date: TODAY });
    // The settlement runs each child's closeout: the child is the visit's only bill, so it records the hold.
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: child.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'visit_scheduled_today' });
    const madeAfter = new Date(paidAt.getTime() + 60000);
    const later = await invoice({ status: 'sent', sent_at: madeAfter, created_at: madeAfter, scheduled_service_id: svc.id, date: TODAY });
    expect(await resolveVisitForIssuedInvoice(trx, later, { today: '2040-03-05', trigger: 'sent' })).toMatchObject({ svc: null, reason: 'visit_paid_on_other_invoice' });
    // The next day the standalone sweep runs first: the later bill's closeout leaves the visit open.
    expect(await retryIssuedInvoiceCloseouts({ conn: trx, today: '2040-03-05' })).toEqual({ candidates: 1, retried: 1, closed: 0 });
    expect(mockCompleteScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused', resource_id: svc.id,
      metadata: expect.objectContaining({ invoiceId: later.id, code: 'visit_paid_on_other_invoice' }) }));
    // The statement sweep closes it on the child.
    expect(await retrySettledStatementCloseouts({ conn: trx, today: '2040-03-05' })).toEqual({ candidates: 1, retried: 1, closed: 1 });
    expect(mockCompleteScheduledService.mock.calls.map(([args]) => [args.serviceId, args.issuedInvoiceCloseout])).toEqual([[svc.id, { invoiceId: child.id, trigger: 'paid', paidAtMs: paidAt.getTime() }]]);
    // Gate off: the later bill closes the visit, as before.
    mockGate.reportAfterPay = false;
    expect((await resolveVisitForIssuedInvoice(trx, later, { today: '2040-03-05', trigger: 'sent' })).svc.id).toBe(svc.id);
  });

  test('a refused completion is reported, audited as refused, and never thrown', async () => {
    mockCompleteScheduledService.mockResolvedValueOnce({ status: 409, body: { code: 'already_completed' } });
    const open = await visit();
    const inv = await invoice({ scheduled_service_id: open.id });
    expect(await closeOutVisitForIssuedInvoice({ invoiceId: inv.id, trigger: 'paid', conn: trx, today: TODAY })).toMatchObject({ closed: false, reason: 'already_completed' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'visit.completion_on_invoice_issued_refused' }));
  });
});
