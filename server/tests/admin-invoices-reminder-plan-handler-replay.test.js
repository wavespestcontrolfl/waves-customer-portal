/**
 * The Intelligence Bar's reminder and payment-plan cards (GATE_IB_INVOICE_REMINDERS, GATE_IB_PAYMENT_PLAN) replay the
 * Invoices page's own handlers (admin-invoices.js followupControlFromBar, sendReminderNowFromBar, scheduleSendFromBar,
 * createPaymentPlanFromBar, cancelPaymentPlanFromBar). This drives the REAL route handlers through the page (HTTP) and
 * the bar (in process) and pins: both reach the same service calls, the page's calls are unchanged (no pin, no extra
 * predicate), the bar's pins (invoice edit time, reminder step) refuse with 409 PREVIEW_CHANGED and write nothing, and
 * the HTTP body can never carry a pin. Synthetic data only; nothing reaches a provider.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, __bindings: bindings }));
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice-payer-ownership', () => ({ invoicePayerOwnership: jest.fn(async () => null) }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendPaymentPlanConfirmed: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/invoice-followups', () => ({
  pauseSequence: jest.fn(async () => undefined),
  resumeSequence: jest.fn(async () => undefined),
  stopSequence: jest.fn(async () => undefined),
  sendNextTouchNow: jest.fn(async () => undefined),
  scheduleForInvoice: jest.fn(async () => undefined),
  followupSteps: jest.fn(() => []),
}));

const express = require('express');
const db = require('../models/db');
const FollowUps = require('../services/invoice-followups');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const router = require('../routes/admin-invoices');

const INV = '00000000-0000-4000-8000-0000000000a9';
const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const UPDATED_MS = UPDATED.getTime();
const FUTURE = '2099-01-15T09:30';
const BAR_ACTOR = { technicianId: 'staff-1', name: 'Pat Staff', email: 'pat.staff@example.com' };

async function page(path, body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/${INV}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A query-builder recorder: every chained method is recorded; modify() runs its callback on the builder.
function recorder(results = {}) {
  const calls = [];
  const qb = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'then') return undefined;
      return (...args) => {
        calls.push([String(prop), args]);
        if (prop === 'modify') { args[0](qb); return qb; }
        if (prop in results) return typeof results[prop] === 'function' ? results[prop](...args) : results[prop];
        return qb;
      };
    },
  });
  return qb;
}
const called = (qb, name) => qb.calls.filter(([n]) => n === name).map(([, args]) => args);

beforeEach(() => jest.clearAllMocks());

describe('follow-up controls: the page and the bar reach the same service calls', () => {
  test('pause: reason and the admin id; the page body’s extra fields are not special', async () => {
    const viaPage = await page('/followup/pause', { reason: 'paying Friday', ibApprovedReminder: { x: 1 } });
    const viaBar = await router.followupControlFromBar({ invoiceId: INV, control: 'pause', body: { reason: 'paying Friday' }, actor: { technicianId: 'admin-1' } });
    expect(viaPage).toEqual({ status: 200, json: { ok: true } });
    expect(viaBar).toEqual(viaPage);
    expect(FollowUps.pauseSequence).toHaveBeenCalledTimes(2);
    expect(FollowUps.pauseSequence.mock.calls[0]).toEqual(FollowUps.pauseSequence.mock.calls[1]);
    expect(FollowUps.pauseSequence.mock.calls[0]).toEqual([INV, { reason: 'paying Friday', until: undefined, adminId: 'admin-1' }]);
  });

  test('stop and resume: same calls; the bar names the staff member as the admin', async () => {
    await page('/followup/stop', { reason: 'waived' });
    await router.followupControlFromBar({ invoiceId: INV, control: 'stop', body: { reason: 'waived' }, actor: { technicianId: 'admin-1' } });
    expect(FollowUps.stopSequence.mock.calls[0]).toEqual(FollowUps.stopSequence.mock.calls[1]);
    await page('/followup/resume');
    await router.followupControlFromBar({ invoiceId: INV, control: 'resume', body: {}, actor: BAR_ACTOR });
    expect(FollowUps.resumeSequence.mock.calls).toEqual([[INV], [INV]]);
    await router.followupControlFromBar({ invoiceId: INV, control: 'pause', body: {}, actor: BAR_ACTOR });
    expect(FollowUps.pauseSequence.mock.calls[0]).toEqual([INV, { reason: undefined, until: undefined, adminId: 'staff-1' }]);
  });

  describe('with the card’s pin (reminder id, status, step)', () => {
    const approved = { sequenceId: 'seq-1', status: 'paused', stepIndex: 0 };

    test('the bar hands the pin to the service; the page passes none and the body cannot add one', async () => {
      await page('/followup/pause', { reason: 'x', approved, ibApprovedControl: approved });
      await page('/followup/resume', { approved, ibApprovedControl: approved });
      await page('/followup/stop', { reason: 'x', approved, ibApprovedControl: approved });
      expect(FollowUps.pauseSequence.mock.calls[0]).toEqual([INV, { reason: 'x', until: undefined, adminId: 'admin-1' }]);
      expect(FollowUps.resumeSequence.mock.calls[0]).toEqual([INV]);
      expect(FollowUps.stopSequence.mock.calls[0]).toEqual([INV, { reason: 'x', adminId: 'admin-1' }]);
      await router.followupControlFromBar({ invoiceId: INV, control: 'pause', body: { reason: 'x' }, actor: BAR_ACTOR, approved });
      await router.followupControlFromBar({ invoiceId: INV, control: 'resume', body: {}, actor: BAR_ACTOR, approved });
      await router.followupControlFromBar({ invoiceId: INV, control: 'stop', body: { reason: 'x' }, actor: BAR_ACTOR, approved });
      expect(FollowUps.pauseSequence.mock.calls[1]).toEqual([INV, { reason: 'x', until: undefined, adminId: 'staff-1', approved }]);
      expect(FollowUps.resumeSequence.mock.calls[1]).toEqual([INV, undefined, { approved }]);
      expect(FollowUps.stopSequence.mock.calls[1]).toEqual([INV, { reason: 'x', adminId: 'staff-1', approved }]);
    });

    test.each(['pause', 'resume', 'stop'])('%s: a service refusal of the pin is a 409 PREVIEW_CHANGED and the page-shaped answer is untouched', async (control) => {
      const service = { pause: 'pauseSequence', resume: 'resumeSequence', stop: 'stopSequence' }[control];
      FollowUps[service].mockResolvedValueOnce({ previewChanged: true });
      const result = await router.followupControlFromBar({ invoiceId: INV, control, body: {}, actor: BAR_ACTOR, approved });
      expect(result).toEqual({ status: 409, json: { error: 'The invoice reminders changed after the card was shown, so nothing was changed.', code: 'PREVIEW_CHANGED' } });
      FollowUps[service].mockResolvedValueOnce(undefined);
      expect(await router.followupControlFromBar({ invoiceId: INV, control, body: {}, actor: BAR_ACTOR, approved })).toEqual({ status: 200, json: { ok: true } });
    });
  });

  test('stop: a service refusal that would cancel a combined session is a 409 NEEDS_INVOICES_PAGE', async () => {
    FollowUps.stopSequence.mockResolvedValueOnce({ needsInvoicesPage: true });
    const result = await router.followupControlFromBar({ invoiceId: INV, control: 'stop', body: {}, actor: BAR_ACTOR, approved: { sequenceId: 'seq-1', status: 'active', stepIndex: 0 } });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: 'NEEDS_INVOICES_PAGE' });
  });

  test('an unknown control is refused before any handler runs', async () => {
    await expect(router.followupControlFromBar({ invoiceId: INV, control: 'send-now', body: {}, actor: BAR_ACTOR })).rejects.toThrow('Unknown follow-up control');
    expect(FollowUps.sendNextTouchNow).not.toHaveBeenCalled();
  });

  test('a service error rejects the bar’s promise (nothing is reported as done)', async () => {
    FollowUps.stopSequence.mockRejectedValueOnce(new Error('Could not verify invoice active payment'));
    await expect(router.followupControlFromBar({ invoiceId: INV, control: 'stop', body: {}, actor: BAR_ACTOR })).rejects.toThrow('Could not verify');
  });
});

describe('send-now: the bar hands the card’s pin to the service, which judges it under its locks', () => {
  const approved = { invoiceUpdatedAtMs: UPDATED_MS, sequenceId: 'seq-1', status: 'active', stepIndex: 0 };

  test('the page’s call is unchanged: the operator flag, no combined confirmation, no pin, no report, and no extra read', async () => {
    const result = await page('/followup/send-now');
    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(FollowUps.sendNextTouchNow).toHaveBeenCalledWith(INV, { operatorInitiated: true, combined: null });
    expect(db).not.toHaveBeenCalled();
  });

  test('the HTTP body can never carry a pin or ask for a report', async () => {
    const result = await page('/followup/send-now', { approved, report: true, ibApprovedReminder: approved });
    expect(result).toEqual({ status: 200, json: { ok: true } });
    expect(FollowUps.sendNextTouchNow).toHaveBeenCalledWith(INV, { operatorInitiated: true, combined: null });
  });

  test('the bar passes the pin and asks for the per-channel report; the answer carries it', async () => {
    const legs = { sms: { state: 'sent' }, email: { state: 'held', reason: 'collections_policy_denied' } };
    FollowUps.sendNextTouchNow.mockResolvedValueOnce({ ok: true, report: { legs } });
    const result = await router.sendReminderNowFromBar({ invoiceId: INV, actor: BAR_ACTOR, approvedReminder: approved });
    expect(result).toEqual({ status: 200, json: { ok: true, reminder: { legs } } });
    expect(FollowUps.sendNextTouchNow).toHaveBeenCalledTimes(1);
    expect(FollowUps.sendNextTouchNow).toHaveBeenCalledWith(INV, { operatorInitiated: true, combined: null, approved, report: true });
    // The route does its own unlocked pin read no more: the service judges the pin under the locks.
    expect(db).not.toHaveBeenCalled();
  });

  test('a service refusal of the pin is a 409 PREVIEW_CHANGED', async () => {
    FollowUps.sendNextTouchNow.mockResolvedValueOnce({ ok: false, reason: 'preview_changed', message: 'The invoice or its reminder changed after the card was shown, so nothing was sent.' });
    const result = await router.sendReminderNowFromBar({ invoiceId: INV, actor: BAR_ACTOR, approvedReminder: approved });
    expect(result).toEqual({ status: 409, json: { error: 'The invoice or its reminder changed after the card was shown, so nothing was sent.', code: 'PREVIEW_CHANGED' } });
  });

  test('the handler’s own "nothing to send" answer reaches the bar as a 409 NOT_SENT', async () => {
    FollowUps.sendNextTouchNow.mockResolvedValueOnce({ ok: false, reason: 'nothing_to_send', message: 'Not sent: this invoice is paid or its reminders are finished.' });
    const result = await router.sendReminderNowFromBar({ invoiceId: INV, actor: BAR_ACTOR, approvedReminder: approved });
    expect(result).toEqual({ status: 409, json: { error: 'Not sent: this invoice is paid or its reminders are finished.', code: 'NOT_SENT' } });
  });
});

describe('schedule-send: the bar adds the card’s edit time as one more predicate on the UPDATE', () => {
  let updateQb;
  let readQb;
  beforeEach(() => {
    readQb = recorder({ first: async () => ({ payer_statement_id: null, scheduled_send_error: null }) });
    updateQb = recorder({ returning: async () => [{ id: INV, status: 'scheduled', scheduled_send_at: new Date('2099-01-15T14:30:00Z') }] });
    db.mockImplementation(() => {
      // The two guard reads come first; the third builder is the UPDATE chain.
      const used = db.mock.calls.length;
      return used <= 2 ? readQb : updateQb;
    });
  });

  test('the page’s UPDATE has no edit-time predicate', async () => {
    const result = await page('/schedule-send', { scheduledFor: FUTURE, ibApprovedSchedule: { updatedAtMs: 1 } });
    expect(result.status).toBe(200);
    expect(result.json.invoice).toMatchObject({ status: 'scheduled' });
    expect(called(updateQb, 'whereRaw').filter(([sql]) => /date_trunc/.test(sql))).toEqual([]);
    expect(called(updateQb, 'update')).toHaveLength(1);
    expect(called(updateQb, 'update')[0][0]).toMatchObject({ status: 'scheduled', scheduled_request_review: false });
  });

  test('the bar’s UPDATE requires the edit time the card showed, and sets the same fields as the page', async () => {
    const result = await router.scheduleSendFromBar({ invoiceId: INV, body: { scheduledFor: FUTURE }, actor: BAR_ACTOR, approvedSchedule: { updatedAtMs: UPDATED_MS } });
    expect(result.status).toBe(200);
    const pins = called(updateQb, 'whereRaw').filter(([sql]) => /date_trunc\('milliseconds', updated_at\) = \?::timestamptz/.test(sql));
    expect(pins).toEqual([[expect.any(String), ['2099-01-01T12:00:00.123Z']]]);
    const [fields] = called(updateQb, 'update')[0];
    expect(fields).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, scheduled_request_review: false, scheduled_review_delay_minutes: null });
    expect(fields.scheduled_send_at.getTime()).toBe(new Date('2099-01-15T14:30:00Z').getTime());
  });

  test('an invoice that changed after the card (the UPDATE matches no row) is 409 PREVIEW_CHANGED for the bar, 404 for the page', async () => {
    updateQb = recorder({ returning: async () => [] });
    const bar = await router.scheduleSendFromBar({ invoiceId: INV, body: { scheduledFor: FUTURE }, actor: BAR_ACTOR, approvedSchedule: { updatedAtMs: UPDATED_MS } });
    expect(bar.status).toBe(409);
    expect(bar.json).toMatchObject({ code: 'PREVIEW_CHANGED' });
    db.mockClear();
    const viaPage = await page('/schedule-send', { scheduledFor: FUTURE });
    expect(viaPage).toEqual({ status: 404, json: { error: 'Not found' } });
  });

  test('the handler’s own time checks reach the bar unchanged', async () => {
    const past = await router.scheduleSendFromBar({ invoiceId: INV, body: { scheduledFor: '2020-01-15T09:30' }, actor: BAR_ACTOR, approvedSchedule: { updatedAtMs: UPDATED_MS } });
    expect(past).toEqual({ status: 400, json: { error: 'scheduledFor must be in the future' } });
    const missing = await router.scheduleSendFromBar({ invoiceId: INV, body: {}, actor: BAR_ACTOR, approvedSchedule: { updatedAtMs: UPDATED_MS } });
    expect(missing).toEqual({ status: 400, json: { error: 'scheduledFor required' } });
    expect(called(updateQb, 'update')).toEqual([]);
  });
});

describe('payment plans: the real create and cancel handlers', () => {
  const INVOICE = { id: INV, customer_id: 'cust-1', status: 'sent', total: '100.00', credit_applied: '0', invoice_number: 'WPC-2099-0009', payer_id: null, updated_at: UPDATED };
  const CREATED = { id: 'plan-1', total_balance: '100.00', customer_id: 'cust-1', status: 'active' };
  const BODY = { totalBalance: 100, paymentAmount: 40, paymentFrequency: 'monthly', planStartDate: '2099-01-20', nextPaymentDate: '2099-02-01' };
  let trxInvoices;
  let trxPlans;
  let trxFollowups;
  let lockedInvoice;
  let lockedReminder;

  function wireDb() {
    trxInvoices = recorder({ first: async () => lockedInvoice });
    trxPlans = recorder({ insert: () => ({ returning: async () => [CREATED] }), first: async (...a) => (a[0] === 'status' ? { status: 'active' } : null) });
    trxFollowups = recorder({ first: async () => lockedReminder });
    const trx = jest.fn((table) => ({ invoices: trxInvoices, payment_plans: trxPlans, invoice_followup_sequences: trxFollowups }[table]));
    trx.isTransaction = true;
    trx.raw = jest.fn((sql, bindings) => ({ __raw: sql, __bindings: bindings }));
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.mockImplementation((table) => {
      if (table === 'invoices') return recorder({ first: async () => ({ ...INVOICE }) });
      if (table === 'payment_plans') return recorder({ first: async (...a) => (a[0] === 'status' ? { status: 'active' } : null) });
      return recorder();
    });
    db.transaction.mockImplementation(async (cb) => cb(trx));
  }

  beforeEach(() => {
    lockedInvoice = { ...INVOICE };
    lockedReminder = { touch_claimed_at: null };
    require('../services/invoice-payer-ownership').invoicePayerOwnership.mockResolvedValue(null);
    wireDb();
  });

  test('create: the page and the bar insert the same plan; the bar names the staff member as the creator', async () => {
    const viaPage = await page('/payment-plan', BODY);
    expect(viaPage.status).toBe(201);
    const viaBar = await router.createPaymentPlanFromBar({ invoiceId: INV, body: BODY, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS } });
    expect(viaBar.status).toBe(201);
    expect(viaBar.json.paymentPlan).toMatchObject({ id: 'plan-1', status: 'active' });
    const inserts = trxPlans.calls.filter(([n]) => n === 'insert').map(([, args]) => args[0]);
    expect(inserts).toHaveLength(2);
    const { created_by: pageBy, created_by_user_id: pageId, ...pageRest } = inserts[0];
    const { created_by: barBy, created_by_user_id: barId, ...barRest } = inserts[1];
    expect(barRest).toEqual(pageRest);
    expect(pageRest).toMatchObject({ total_balance: 100, payment_amount: 40, payment_frequency: 'monthly', plan_start_date: '2099-01-20', next_payment_date: '2099-02-01', status: 'active', payment_method_id: null });
    expect([pageBy, pageId]).toEqual(['admin-1', 'admin-1']);
    expect([barBy, barId]).toEqual(['Pat Staff', 'staff-1']);
    // The confirmation email goes out once per create, through the same sender.
    expect(PaymentLifecycleEmail.sendPaymentPlanConfirmed).toHaveBeenCalledTimes(2);
  });

  test('create: the bar hands its recipient digest to the confirmation email; the page hands none', async () => {
    await page('/payment-plan', BODY);
    await router.createPaymentPlanFromBar({ invoiceId: INV, body: BODY, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS, emailRecipientDigest: 'digest-1' } });
    const [pageCall, barCall] = PaymentLifecycleEmail.sendPaymentPlanConfirmed.mock.calls.map(([arg]) => arg);
    expect(pageCall).not.toHaveProperty('expectedRecipientDigest');
    expect(barCall.expectedRecipientDigest).toBe('digest-1');
  });

  test('create: the bar’s pin is checked on the LOCKED invoice row; a changed invoice is 409 PREVIEW_CHANGED with no plan and no email', async () => {
    lockedInvoice = { ...INVOICE, updated_at: new Date('2099-01-05T00:00:00Z') };
    const result = await router.createPaymentPlanFromBar({ invoiceId: INV, body: BODY, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS } });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: 'PREVIEW_CHANGED' });
    expect(trxPlans.calls.filter(([n]) => n === 'insert')).toEqual([]);
    expect(trxFollowups.calls.filter(([n]) => n === 'update')).toEqual([]);
    expect(PaymentLifecycleEmail.sendPaymentPlanConfirmed).not.toHaveBeenCalled();
  });

  test('create: the bar’s plan is refused on the locked row when the live resolver names a payer (invoices.payer_id still NULL) or cannot answer; the page is not asked', async () => {
    const Ownership = require('../services/invoice-payer-ownership');
    for (const verdict of ['payer_owned', 'payer_unverifiable']) {
      Ownership.invoicePayerOwnership.mockResolvedValue(verdict);
      const result = await router.createPaymentPlanFromBar({ invoiceId: INV, body: BODY, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS } });
      expect(result.status).toBe(409);
      expect(result.json).toMatchObject({ code: 'PREVIEW_CHANGED' });
    }
    expect(trxPlans.calls.filter(([n]) => n === 'insert')).toEqual([]);
    expect(PaymentLifecycleEmail.sendPaymentPlanConfirmed).not.toHaveBeenCalled();
    expect((await page('/payment-plan', BODY)).status).toBe(201);
    expect(Ownership.invoicePayerOwnership).toHaveBeenCalledTimes(2);
  });

  test('create: the bar’s plan locks the reminder row and is refused while a reminder worker holds its claim; the page is not asked', async () => {
    lockedReminder = { touch_claimed_at: new Date() };
    const result = await router.createPaymentPlanFromBar({ invoiceId: INV, body: BODY, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS } });
    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ code: 'PREVIEW_CHANGED' });
    expect(called(trxFollowups, 'forUpdate')).not.toEqual([]);
    expect(trxPlans.calls.filter(([n]) => n === 'insert')).toEqual([]);
    expect(trxFollowups.calls.filter(([n]) => n === 'update')).toEqual([]);
    expect((await page('/payment-plan', BODY)).status).toBe(201);
  });

  test('create: the page carries no pin, so an edited invoice still creates (unchanged), and its HTTP body cannot add one', async () => {
    lockedInvoice = { ...INVOICE, updated_at: new Date('2099-01-05T00:00:00Z') };
    const result = await page('/payment-plan', { ...BODY, ibApprovedPlan: { updatedAtMs: 1 } });
    expect(result.status).toBe(201);
    expect(trxPlans.calls.filter(([n]) => n === 'insert')).toHaveLength(1);
  });

  test('create: the handler’s own refusals reach the bar (payer-billed, over the balance)', async () => {
    db.mockImplementation(() => recorder({ first: async () => ({ ...INVOICE, payer_id: 'payer-1' }) }));
    const payer = await router.createPaymentPlanFromBar({ invoiceId: INV, body: BODY, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS } });
    expect(payer.status).toBe(400);
    wireDb();
    const over = await router.createPaymentPlanFromBar({ invoiceId: INV, body: { ...BODY, paymentAmount: 150 }, actor: BAR_ACTOR, approvedPlan: { updatedAtMs: UPDATED_MS } });
    expect(over).toEqual({ status: 400, json: { error: 'paymentAmount cannot exceed totalBalance' } });
  });

  describe('cancel', () => {
    const PLAN = { id: 'plan-1', invoice_id: INV, customer_id: 'cust-1', status: 'active' };
    let planUpdates;
    beforeEach(() => {
      planUpdates = [];
      trxInvoices = recorder({ first: async () => ({ ...INVOICE }) });
      trxPlans = recorder({
        first: async () => ({ ...PLAN }),
        update: (fields) => { planUpdates.push(fields); return { returning: async () => [{ ...PLAN, status: 'cancelled' }] }; },
      });
      trxFollowups = recorder({ first: async () => undefined });
      const trx = jest.fn((table) => ({ invoices: trxInvoices, payment_plans: trxPlans, invoice_followup_sequences: trxFollowups }[table]));
      trx.isTransaction = true;
      trx.raw = jest.fn();
      db.mockImplementation((table) => (table === 'activity_log' ? recorder({ first: async () => null, insert: async () => 1 }) : recorder()));
      db.transaction.mockImplementation(async (cb) => cb(trx));
    });

    test('the page and the bar cancel the same plan; the bar names the staff member', async () => {
      const viaPage = await page('/payment-plan/cancel', { paymentPlanId: 'plan-1', reason: 'paid by check' });
      const viaBar = await router.cancelPaymentPlanFromBar({ invoiceId: INV, body: { paymentPlanId: 'plan-1', reason: 'paid by check' }, actor: BAR_ACTOR });
      expect(viaPage.status).toBe(200);
      expect(viaBar.status).toBe(200);
      expect(viaBar.json.paymentPlan).toMatchObject({ id: 'plan-1', status: 'cancelled' });
      expect(planUpdates).toHaveLength(2);
      expect(planUpdates[0]).toMatchObject({ status: 'cancelled', cancelled_by: 'admin-1' });
      expect(planUpdates[1]).toMatchObject({ status: 'cancelled', cancelled_by: 'Pat Staff' });
    });

    test('the plan id is required, exactly as on the page', async () => {
      const result = await router.cancelPaymentPlanFromBar({ invoiceId: INV, body: {}, actor: BAR_ACTOR });
      expect(result).toEqual({ status: 400, json: { error: 'paymentPlanId is required — cancel names the exact plan being cancelled' } });
      expect(planUpdates).toEqual([]);
    });
  });
});
