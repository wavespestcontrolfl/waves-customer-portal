/**
 * GATE_CALL_PREPAY_CHOICE through PostgreSQL (owner 2026-10-29): a caller with an open estimate chose annual
 * prepay on a call the pipeline BOOKED. The sweep files ONE admin-only card (call_prepay_choice) per call when the
 * customer's newest open estimate is prepay-eligible; the card's tap runs the same accept the New appointment form
 * runs. Real queries and the real eligibility guard run inside a rolled-back transaction; only the accept itself
 * (markEstimateManuallyAccepted: converter, invoice, term) is a spy, because its own suites own that behavior and
 * this suite pins what is handed to it. Synthetic names, numbers and addresses only. Skips without DATABASE_URL.
 */
const SKIP = !process.env.DATABASE_URL;

jest.setTimeout(60000);
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = null;
    req.techRole = req.headers['x-test-role'] || 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const acceptance = require('../services/estimate-manual-acceptance');
const {
  runCallPrepayChoiceSweep, evaluateCallPrepay, REASON_CODE,
} = require('../services/call-prepay-choice');

const GATE = 'GATE_CALL_PREPAY_CHOICE';
const describeDb = SKIP ? describe.skip : describe;

const ABSENT = Symbol('absent');
const extractionWith = (choice) => ({
  meta: { call_summary: 'Caller wants the quarterly plan.' },
  service_request: { primary_service_category: 'pest_general', ...(choice === ABSENT ? {} : { billing_choice: choice }) },
  scheduling: { status: 'confirmed' },
});
const quotedData = (over = {}) => ({
  recurring: { services: [{ name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4, price: 118, perApp: 118, annual: 472 }] },
  customerSelection: { frequency: 'quarterly' },
  ...over,
});

describeDb('call prepay choice (PostgreSQL)', () => {
  let database; let trx; let server; let base;
  const savedGate = process.env[GATE];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const router = require('../routes/admin-triage');
    const app = express();
    app.use(express.json());
    app.use('/admin/triage', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
    if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
  });
  let acceptSpy;
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env[GATE] = 'true';
    trx = await database.transaction();
    mockConn = trx;
    acceptSpy = jest.spyOn(acceptance, 'markEstimateManuallyAccepted').mockResolvedValue({ conversion: { draftInvoiceId: 'inv-sample-1' }, warnings: [] });
  });
  afterEach(async () => { acceptSpy.mockRestore(); await trx.rollback(); });

  let seq = 0;
  async function customer(over = {}) {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Pat', last_name: 'Sampleton', phone: `+1941555${String(3000 + (seq += 1))}`, ...over });
    return id;
  }
  async function estimate(customerId, over = {}) {
    const [row] = await trx('estimates').insert({
      customer_id: customerId, status: 'sent', monthly_total: 39.33, annual_total: 472, estimate_data: JSON.stringify(quotedData()),
      address: '100 Example Lane, Sampleton, FL 34200',
      expires_at: new Date(Date.now() + 14 * 86400000), ...over,
    }).returning('*');
    return row;
  }
  async function call(customerId, choice = 'annual_prepay', over = {}) {
    const id = randomUUID();
    await trx('call_log').insert({
      id, customer_id: customerId, twilio_call_sid: `CA${id.replace(/-/g, '')}`, from_phone: '+19415550101',
      processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify(extractionWith(choice)), ...over,
    });
    return id;
  }
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  async function visit(customerId, callLogId, over = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, source_call_log_id: callLogId, scheduled_date: inDays(9), window_start: '09:00',
      service_type: 'Quarterly Pest Control Service', status: 'pending', source_action: 'ai_call_pipeline',
      service_address_line1: '100 Example Lane', service_address_city: 'Sampleton', service_address_state: 'FL', service_address_zip: '34200', ...over,
    });
    return id;
  }
  async function booked(callOver = {}, estimateOver = {}) {
    const customerId = await customer();
    const est = await estimate(customerId, estimateOver);
    const callLogId = await call(customerId, 'annual_prepay', callOver);
    const visitId = await visit(customerId, callLogId);
    return { customerId, est, callLogId, visitId };
  }
  const cardsFor = (callLogId) => trx('triage_items').where({ call_log_id: callLogId, reason_code: REASON_CODE });
  async function post(path, body, headers = {}) {
    const res = await fetch(`${base}/admin/triage/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  describe('the sweep: when ONE card is filed', () => {
    test('an eligible estimate and a call-booked visit file one admin-only advisory card that names the plan and the amount', async () => {
      const { customerId, est, callLogId, visitId } = await booked();
      const out = await runCallPrepayChoiceSweep();
      expect(out).toMatchObject({ filed: 1 });
      const [card] = await cardsFor(callLogId);
      expect(card).toMatchObject({
        status: 'open', severity: 'advisory', category: 'billing_review', related_customer_id: customerId, related_estimate_id: est.id, related_scheduled_service_id: visitId,
      });
      const payload = card.payload;
      expect(payload).toMatchObject({
        flag: REASON_CODE, billing_choice: 'annual_prepay', estimate_id: String(est.id), customer_id: customerId, scheduled_service_ids: [visitId],
        first_visit_date: inDays(9), cadence: 'quarterly', covered_visits: 4, service_type: 'Quarterly Pest Control Service',
      });
      expect(payload.invoice_total).toBeGreaterThan(0);
      expect(card.summary).toMatch(/Caller chose annual prepay/);
      expect((await trx('call_log').where({ id: callLogId }).first()).review_status).toBe('open');
      // The sweep sends and accepts nothing.
      expect(acceptSpy).not.toHaveBeenCalled();
      expect((await trx('estimates').where({ id: est.id }).first()).status).toBe('sent');
    });

    test('a second sweep, and a sweep after the card was closed, file nothing more (one card per call, ever)', async () => {
      const { callLogId } = await booked();
      await runCallPrepayChoiceSweep();
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
      await trx('triage_items').where({ call_log_id: callLogId }).update({ status: 'dismissed', resolution_source: 'human' });
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
      expect(await cardsFor(callLogId)).toHaveLength(1);
    });

    test('gate off: the sweep returns before any query and files nothing', async () => {
      const { callLogId } = await booked();
      delete process.env[GATE];
      expect(await runCallPrepayChoiceSweep()).toEqual({ skipped: true, scanned: 0, filed: 0, closed: 0 });
      expect(await cardsFor(callLogId)).toHaveLength(0);
    });

    test('a call that chose pay per application, named no plan, or is not a valid extraction files nothing', async () => {
      const customerId = await customer();
      await estimate(customerId);
      const perApp = await call(customerId, 'per_application');
      const none = await call(customerId, null);
      const absent = await call(customerId, ABSENT);
      const invalid = await call(customerId, 'annual_prepay', { v2_extraction_status: 'invalid' });
      for (const id of [perApp, none, absent, invalid]) await visit(customerId, id);
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
    });

    test('only a visit the call itself created counts as booked; a visit the call was attached to stays in the plan check (Codex #7050 r2, r4)', async () => {
      const longAgo = new Date(Date.now() - 30 * 86400000);
      // The call was attached to a booking a person made DURING the call (findAttachableCallAppointment):
      // it carries the call's id but not a call-created source_action, so nothing was booked from the call.
      const a = await booked();
      await trx('scheduled_services').where({ id: a.visitId }).update({ source_action: null });
      expect(await evaluateCallPrepay({ callLogId: a.callLogId, customerId: a.customerId })).toMatchObject({ ok: false, reason: 'no_booked_visit' });
      // The call booked a new visit AND was attached to the customer's existing recurring visit: the existing one
      // stays in the plan check, so the account is not switched to annual prepay.
      const b = await booked();
      await visit(b.customerId, b.callLogId, { source_action: null, created_at: longAgo, scheduled_date: inDays(30), is_recurring: true, recurring_pattern: 'quarterly' });
      const out = await evaluateCallPrepay({ callLogId: b.callLogId, customerId: b.customerId });
      expect(out.ok).toBe(false);
      expect(['existing_customer', 'live_plan_unknown']).toContain(out.reason);
      await runCallPrepayChoiceSweep();
      expect(await cardsFor(a.callLogId).first()).toBeUndefined();
      expect(await cardsFor(b.callLogId).first()).toBeUndefined();
    });

    test('a termite estimate files no card: its accept can send the termite notice and agreement (Codex #7050 r1)', async () => {
      const { customerId, est, callLogId } = await booked();
      await trx('estimates').where({ id: est.id }).update({ estimate_data: JSON.stringify(quotedData({
        recurring: { services: [{ service: 'termite_bait', name: 'Termite Bait Stations', frequency: 'quarterly', visitsPerYear: 4, price: 118, perApp: 118, annual: 472 }] },
      })) });
      expect(await evaluateCallPrepay({ callLogId, customerId })).toMatchObject({ ok: false, reason: 'termite_estimate' });
      const out = await runCallPrepayChoiceSweep();
      expect(out.filed).toBe(0);
      expect(await cardsFor(callLogId).first()).toBeUndefined();
    });

    test('no live visit from the call (cancelled, or booked by hand with no call link): no card', async () => {
      const customerId = await customer();
      await estimate(customerId);
      const cancelledCall = await call(customerId);
      await visit(customerId, cancelledCall, { status: 'cancelled' });
      await call(customerId);
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
    });

    test('an ineligible estimate files no card, each for its own reason: already accepted, a one-time quote, an invoice-mode quote, an unowned quote, a customer with a live plan', async () => {
      const cases = [
        { est: { status: 'accepted' }, reason: 'no_open_estimate' },
        { est: { estimate_data: JSON.stringify({ services: [{ name: 'One-Time Pest', price: 125 }] }), annual_total: null, monthly_total: null, onetime_total: 125 }, reason: 'no_recurring_annual' },
        { est: { bill_by_invoice: true }, reason: 'not_eligible' },
        { est: { unowned: true }, reason: 'no_open_estimate' },
        { est: {}, livePlan: true, reason: 'existing_customer' },
      ];
      for (const c of cases) {
        const customerId = await customer();
        const { unowned, ...over } = c.est;
        await estimate(customerId, { ...over, ...(unowned ? { customer_id: null, customer_phone: '+19415550101' } : {}) });
        if (c.livePlan) await trx('scheduled_services').insert({ customer_id: customerId, scheduled_date: inDays(30), service_type: 'Lawn Care', status: 'confirmed', is_recurring: true });
        const callLogId = await call(customerId);
        await visit(customerId, callLogId);
        expect(await evaluateCallPrepay({ callLogId, customerId })).toMatchObject({ ok: false, reason: c.reason });
        expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
        expect(await cardsFor(callLogId)).toHaveLength(0);
      }
    });

    test('only the NEWEST open estimate counts: an older eligible one does not stand in for a newer ineligible one', async () => {
      const customerId = await customer();
      await estimate(customerId, { created_at: new Date(Date.now() - 5 * 86400000) });
      await estimate(customerId, { bill_by_invoice: true, created_at: new Date() });
      const callLogId = await call(customerId);
      await visit(customerId, callLogId);
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
    });

    test('a booked cadence that differs from the quoted one, or a mixed booking, files no card (money must reconcile)', async () => {
      const a = await customer();
      await estimate(a);
      const callA = await call(a);
      await visit(a, callA, { is_recurring: true, recurring_pattern: 'monthly' });
      const b = await customer();
      await estimate(b);
      const callB = await call(b);
      await visit(b, callB);
      await visit(b, callB, { service_type: 'Lawn Care Service', scheduled_date: inDays(10) });
      expect(await evaluateCallPrepay({ callLogId: callA, customerId: a })).toMatchObject({ ok: false, reason: 'booked_cadence_differs' });
      expect(await evaluateCallPrepay({ callLogId: callB, customerId: b })).toMatchObject({ ok: false, reason: 'mixed_services' });
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 0 });
    });

    test('a visit booked on the quoted cadence (recurring, with a follow-up visit of the same service) files the card on the earliest date', async () => {
      const customerId = await customer();
      await estimate(customerId);
      const callLogId = await call(customerId);
      await visit(customerId, callLogId, { is_recurring: true, recurring_pattern: 'quarterly', scheduled_date: inDays(20) });
      await visit(customerId, callLogId, { scheduled_date: inDays(12) });
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ filed: 1 });
      expect((await cardsFor(callLogId).first()).payload.first_visit_date).toBe(inDays(12));
    });
  });

  describe('a card that stopped being true closes itself', () => {
    test('the estimate was accepted since: the card is dismissed by the sweep (auto), and the call review status settles', async () => {
      const { est, callLogId } = await booked();
      await runCallPrepayChoiceSweep();
      await trx('estimates').where({ id: est.id }).update({ status: 'accepted' });
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ closed: 1 });
      expect((await cardsFor(callLogId).first())).toMatchObject({ status: 'dismissed', resolution_source: 'auto', resolution_rule: 'call_prepay_choice_moot' });
      expect((await trx('call_log').where({ id: callLogId }).first()).review_status).toBe('dismissed');
    });

    test('a card that is only ineligible right now (a live plan appeared) stays open: the office reads the reason on it', async () => {
      const { customerId, callLogId } = await booked();
      await runCallPrepayChoiceSweep();
      await trx('scheduled_services').insert({ customer_id: customerId, scheduled_date: inDays(30), service_type: 'Lawn Care', status: 'confirmed', is_recurring: true });
      expect(await runCallPrepayChoiceSweep()).toMatchObject({ closed: 0 });
      expect((await cardsFor(callLogId).first()).status).toBe('open');
    });
  });

  describe('Accept as annual prepay (POST /:id/accept-call-prepay)', () => {
    // The card as the list shows it, with the terms token the tap must send back (preview_token).
    async function tokenOf(cardId) {
      const { items } = await (await fetch(`${base}/admin/triage?status=open`)).json();
      return items.find((i) => i.id === cardId)?.call_prepay?.preview_token || null;
    }
    async function filed() {
      const ctx = await booked();
      await runCallPrepayChoiceSweep();
      const card = await cardsFor(ctx.callLogId).first();
      return { ...ctx, card, token: await tokenOf(card.id) };
    }

    test('runs the form\'s accept (prepay_annual, term anchored to the booked date, coverage from the booked series), links the visit, resolves the card', async () => {
      const { est, callLogId, visitId, card, token } = await filed();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      const out = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, status: 'resolved', invoice_id: 'inv-sample-1' });
      expect(acceptSpy).toHaveBeenCalledTimes(1);
      expect(acceptSpy.mock.calls[0][0]).toMatchObject({
        estimateId: est.id, bookedAppointmentIds: [visitId], billingTerm: 'prepay_annual', source: 'verbal_annual_prepay_booking',
        annualPrepayTermStart: inDays(9),
        annualPrepayCoverage: { coverageServiceType: 'Quarterly Pest Control Service', coverageVisitCount: 4, coverageCadence: 'quarterly' },
      });
      // Pre-push audit P0: the estimate row and the booked visits are pinned, and re-checked inside the accept.
      expect(acceptSpy.mock.calls[0][0].expected).toMatchObject({
        estimateStatus: 'sent', customerId: est.customer_id, bookedVisits: { ids: [visitId], pin: expect.any(String), noAddons: true },
      });
      expect(acceptSpy.mock.calls[0][0].expected.bookedVisits.pin).toContain(String(visitId));
      // The link is the accept's own last step (beforeCommit, under its locks); this service never links on
      // the side, so with the accept stubbed the visit stays unlinked.
      expect(acceptSpy.mock.calls[0][0].beforeCommit).toEqual(expect.any(Function));
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
      expect(await cardsFor(callLogId).first()).toMatchObject({ status: 'resolved', resolution_source: 'human' });
    });

    test('the list stamps what the tap can do now, with the amount; a non-admin neither sees the card nor can accept it', async () => {
      const { card } = await filed();
      const res = await fetch(`${base}/admin/triage?status=open`);
      const { items } = await res.json();
      const row = items.find((i) => i.id === card.id);
      expect(row.call_prepay).toMatchObject({ can_accept: true, message: null });
      expect(row.call_prepay.amount).toBeGreaterThan(0);
      const tech = await (await fetch(`${base}/admin/triage?status=open`, { headers: { 'x-test-role': 'technician' } })).json();
      expect(tech.items.some((i) => i.id === card.id)).toBe(false);
      const denied = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at }, { 'x-test-role': 'technician' });
      expect(denied.status).toBe(403);
      expect(acceptSpy).not.toHaveBeenCalled();
    });

    test('a stale card, a closed card, a card of another reason and a gate that is off all refuse and accept nothing', async () => {
      const { card, callLogId } = await filed();
      expect((await post(`${card.id}/accept-call-prepay`, { expected_updated_at: '2020-01-01T00:00:00Z' })).status).toBe(409);
      expect((await post(`${card.id}/accept-call-prepay`, {})).status).toBe(409);
      const other = randomUUID();
      await trx('triage_items').insert({ id: other, call_log_id: callLogId, category: 'service_unknown', reason_code: 'quote_promised', status: 'open', payload: '{}' });
      expect((await post(`${other}/accept-call-prepay`, { expected_updated_at: new Date().toISOString() })).status).toBe(400);
      process.env[GATE] = 'false';
      expect((await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at })).status).toBe(404);
      process.env[GATE] = 'true';
      await trx('triage_items').where({ id: card.id }).update({ status: 'resolved' });
      expect((await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at })).status).toBe(409);
      expect(acceptSpy).not.toHaveBeenCalled();
    });

    test('an estimate accepted since the card was filed is refused with a plain message: nothing runs, the visit stays unlinked', async () => {
      const { est, visitId, card } = await filed();
      await trx('estimates').where({ id: est.id }).update({ status: 'accepted' });
      const out = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ code: 'estimate_not_open', error: expect.stringMatching(/no longer open/) });
      expect(acceptSpy).not.toHaveBeenCalled();
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
      expect((await trx('triage_items').where({ id: card.id }).first()).status).toBe('open');
    });

    test('an estimate that became ineligible, or a visit that was cancelled, is refused the same way', async () => {
      const a = await filed();
      await trx('estimates').where({ id: a.est.id }).update({ bill_by_invoice: true });
      const refusedA = await post(`${a.card.id}/accept-call-prepay`, { expected_updated_at: a.card.updated_at });
      expect(refusedA.status).toBe(409);
      expect(refusedA.body.error).toMatch(/not eligible/);
      const b = await filed();
      await trx('scheduled_services').where({ id: b.visitId }).update({ status: 'cancelled' });
      const refusedB = await post(`${b.card.id}/accept-call-prepay`, { expected_updated_at: b.card.updated_at });
      expect(refusedB.body).toMatchObject({ code: 'no_booked_visit' });
      expect(acceptSpy).not.toHaveBeenCalled();
    });

    test('terms that changed after the list loaded (or no token at all) are refused before the accept runs', async () => {
      const { est, card, token } = await filed();
      // The estimate row moves (an edit, a re-price) after the admin's screen loaded the card.
      await trx('estimates').where({ id: est.id }).update({ updated_at: new Date(Date.now() + 60 * 1000) });
      const stale = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: 'preview_changed', error: expect.stringMatching(/Reload to see the new terms/) });
      const missing = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at });
      expect(missing.body).toMatchObject({ code: 'preview_changed' });
      expect(acceptSpy).not.toHaveBeenCalled();
      expect((await trx('triage_items').where({ id: card.id }).first()).status).toBe('open');
      // A fresh look carries the new token, and that one goes through.
      const fresh = await tokenOf(card.id);
      expect(fresh).not.toBe(token);
      expect((await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: fresh })).status).toBe(200);
    });

    test('a call re-read to another plan is refused and the sweep closes its card; a pass still running only waits', async () => {
      const { callLogId, card, token } = await filed();
      await trx('call_log').where({ id: callLogId }).update({ processing_status: 'processing' });
      const waiting = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(waiting.body).toMatchObject({ code: 'call_reprocessing' });
      await runCallPrepayChoiceSweep();
      expect((await trx('triage_items').where({ id: card.id }).first()).status).toBe('open');
      await trx('call_log').where({ id: callLogId }).update({ processing_status: 'processed', ai_extraction_enriched: JSON.stringify(extractionWith('per_application')) });
      const changed = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ code: 'choice_changed' });
      expect(acceptSpy).not.toHaveBeenCalled();
      await runCallPrepayChoiceSweep();
      expect(await trx('triage_items').where({ id: card.id }).first()).toMatchObject({ status: 'dismissed', resolution_source: 'auto' });
    });

    test("the accept's last step against real rows: links when unchanged, throws on a moved visit or a relinked call", async () => {
      const { lastStepInAccept } = require('../services/call-prepay-choice');
      const { customerId, est, callLogId, visitId } = await booked();
      const rowsNow = async () => trx('scheduled_services').whereIn('id', [visitId]).select('*');
      // Unchanged: the step links the visit (inside the test's transaction, rolled back after).
      await trx.transaction(async (sp) => {
        await lastStepInAccept({ callLogId, customerId, bookedRows: await rowsNow() })(sp, { estimate: est });
        expect((await sp('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBe(est.id);
        throw Object.assign(new Error('undo'), { undo: true });
      }).catch((e) => { if (!e.undo) throw e; });
      // A visit moved after the check: the step refuses before linking.
      const checked = await rowsNow();
      await trx('scheduled_services').where({ id: visitId }).update({ scheduled_date: inDays(16) });
      await expect(lastStepInAccept({ callLogId, customerId, bookedRows: checked })(trx, { estimate: est }))
        .rejects.toMatchObject({ callPrepayRefusal: 'changed_since_check' });
      // A call relinked to another customer: the step refuses.
      const other = await customer();
      await trx('call_log').where({ id: callLogId }).update({ customer_id: other });
      await expect(lastStepInAccept({ callLogId, customerId, bookedRows: await rowsNow() })(trx, { estimate: est }))
        .rejects.toMatchObject({ callPrepayRefusal: 'customer_changed' });
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
    });

    test('a payment recorded on the visit after the card was filed refuses the tap (Codex #7050 r3)', async () => {
      const { visitId, card, token } = await filed();
      await trx('scheduled_services').where({ id: visitId }).update({ prepaid_amount: 118, prepaid_method: 'zelle' });
      const out = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ code: 'visit_prepaid' });
      expect(acceptSpy).not.toHaveBeenCalled();
    });

    test('a record that changed inside the accept (preview_changed) is a plain refusal; the card stays open', async () => {
      const { card, token } = await filed();
      acceptSpy.mockRejectedValueOnce(Object.assign(new Error('changed'), { statusCode: 409, code: 'preview_changed' }));
      const out = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ code: 'changed_since_check' });
      expect((await trx('triage_items').where({ id: card.id }).first()).status).toBe('open');
    });

    test('another session won the accept: the answer says so, the visit is not linked, the card stays for the sweep to close', async () => {
      const { visitId, card, token } = await filed();
      acceptSpy.mockResolvedValueOnce({ alreadyAccepted: true });
      const out = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ code: 'already_accepted' });
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
    });

    test('an accept that throws leaves the estimate, the visit and the card as they were', async () => {
      const { visitId, card, token } = await filed();
      acceptSpy.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
      const out = await post(`${card.id}/accept-call-prepay`, { expected_updated_at: card.updated_at, preview_token: token });
      expect(out.status).toBe(409);
      expect(out.body).toMatchObject({ code: 'accept_failed' });
      expect((await trx('scheduled_services').where({ id: visitId }).first()).source_estimate_id).toBeNull();
      expect((await trx('triage_items').where({ id: card.id }).first()).status).toBe('open');
    });
  });

  describe('the call verdict never accepts an estimate', () => {
    test('Accept / Deny on the call is refused for this card (it has its own accept), and a verdict on another card leaves it open', async () => {
      const { card, callLogId } = await (async () => { const c = await booked(); await runCallPrepayChoiceSweep(); return { ...c, card: await cardsFor(c.callLogId).first() }; })();
      const out = await post(`${card.id}/verdict`, { verdict: 'accept', expected_updated_at: card.updated_at });
      expect(out.status).toBe(400);
      expect(out.body.error).toMatch(/annual prepay/);
      expect((await trx('triage_items').where({ id: card.id }).first()).status).toBe('open');
      expect(callLogId).toBeTruthy();
    });
  });

  test('evaluateCallPrepay names a customer-less call plainly', async () => {
    expect(await evaluateCallPrepay({ callLogId: randomUUID(), customerId: null })).toMatchObject({ ok: false, reason: 'no_customer' });
  });
});
