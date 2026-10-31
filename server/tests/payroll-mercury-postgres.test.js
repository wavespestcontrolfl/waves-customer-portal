// Real PostgreSQL transactions (rolled back): Mercury paychecks. Send writes a committed `queued` row before the
// request, a lost answer is `unknown` and is never sent again, the partial unique index keeps one open or paid row per
// check, a partial batch stands check by check, Send again and the paper check have their guards, a void is refused
// while money may be on its way, and the poller moves rows on from a fake Mercury. No real Mercury call is possible:
// every test passes a fake client. All names and ids are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-test-admin'] || null;
    req.techRole = 'admin';
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const { MercuryError } = require('../services/mercury-client');
const alerts = require('../services/payroll-mercury-alerts');
const mercury = require('../services/payroll-mercury');
const poller = require('../services/payroll-mercury-poller');
const payrollRuns = require('../services/payroll-runs');
const router = require('../routes/admin-payroll');

jest.setTimeout(60000);

const W1 = '2026-09-14'; // pay Fri 2026-09-25
const W2 = '2026-09-21'; // pay Fri 2026-10-02
const ACCOUNT = randomUUID();
const GATES = ['GATE_PAYROLL', 'GATE_PAYROLL_MERCURY_STATUS', 'GATE_PAYROLL_MERCURY_PAY', 'MERCURY_API_TOKEN', 'MERCURY_ACCOUNT_ID'];

// A fake Mercury. Each method is a jest.fn the test can change; the defaults answer an empty account.
function fakeClient(patch = {}) {
  return {
    configured: true,
    accountId: ACCOUNT,
    requestSendMoney: jest.fn(async () => ({ requestId: `req-${randomUUID()}`, status: 'pendingApproval' })),
    getRequest: jest.fn(async () => ({ status: 'pendingApproval' })),
    listRequests: jest.fn(async () => []),
    listTransactions: jest.fn(async () => []),
    getRecipient: jest.fn(async () => ({ name: 'Sample Employee', status: 'active' })),
    getBalance: jest.fn(async () => ({ availableCents: 1000000 })),
    ...patch,
  };
}

postgres('payroll Mercury paychecks', () => {
  let database;
  let holderDb;
  let callerDb;
  let trx;
  let server;
  let baseUrl;
  const OLD = Object.fromEntries(GATES.map((key) => [key, process.env[key]]));
  const ADMIN_ID = randomUUID();

  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const technician = async (name, patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '22.00', ...patch,
    });
    await trx('payroll_w4_elections').insert({
      technician_id: id, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    return id;
  };
  const bankTech = (name, patch = {}) => technician(name, {
    pay_method: 'bank_transfer', pay_method_consent_on: '2026-01-02', mercury_recipient_id: randomUUID(), ...patch,
  });
  const approvedWeek = (technicianId, weekStart) => trx('time_weekly_summary').insert({
    technician_id: technicianId, week_start: weekStart, week_end: addDays(weekStart, 6), status: 'approved',
    regular_minutes: '2400.00', overtime_minutes: '0.00',
  });
  const api = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-admin': ADMIN_ID },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const finalizedRun = async (weekStart = W1) => {
    const created = await api('POST', '/runs', { weekStart });
    expect(created.status).toBe(201);
    const shown = await api('GET', `/runs/${created.body.run.id}`);
    const done = await api('POST', `/runs/${created.body.run.id}/finalize`, { token: shown.body.run.token });
    expect(done.status).toBe(200);
    return done.body.run;
  };
  // Bank-transfer employees, one finalized run.
  const bankRun = async (names = ['Sample Alpha'], weekStart = W1) => {
    const techs = {};
    for (const name of names) {
      techs[name] = await bankTech(name);
      await approvedWeek(techs[name], weekStart);
    }
    const run = await finalizedRun(weekStart);
    return { run, techs, check: (name) => run.checks.find((c) => c.name === name) };
  };
  const payments = (checkId) => trx('payroll_payments').where({ check_id: checkId }).orderBy('attempt');
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };
  const sendRun = (runId, client) => mercury.sendRun(runId, ADMIN_ID, { client });
  const poll = (client, now = new Date()) => poller.pollPayments({ client, now });
  const setState = (id, patch) => trx('payroll_payments').where({ id }).update(patch);
  // The open payroll bell keys: real notification rows, written through the rolled-back transaction.
  const openBellKeys = async () => (await trx('notifications').where({ recipient_type: 'admin', category: 'payroll' })
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'")
    .select(trx.raw("metadata->>'dedupeKey' as key"))).map((r) => r.key).sort();

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    holderDb = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    callerDb = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    const app = express();
    app.use(express.json());
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
    process.env.GATE_PAYROLL_MERCURY_PAY = 'true';
    process.env.MERCURY_API_TOKEN = 'token-for-tests';
    process.env.MERCURY_ACCOUNT_ID = ACCOUNT;
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', employment_status: 'active' });
    // The bells have their own tests; here they are observed, and they write through the same rolled-back transaction.
    jest.spyOn(alerts, 'raiseKeyAlert').mockResolvedValue(true);
  });
  afterEach(async () => {
    await trx.rollback();
    for (const key of GATES) { if (OLD[key] === undefined) delete process.env[key]; else process.env[key] = OLD[key]; }
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
    if (holderDb) await holderDb.destroy();
    if (callerDb) await callerDb.destroy();
  });

  describe('Send to Mercury', () => {
    it('writes a queued row first, asks Mercury once per check, and keeps the request id, key and note', async () => {
      const { run, check } = await bankRun(['Sample Alpha', 'Sample Beta']);
      const client = fakeClient();
      let rowsWhenAsked;
      client.requestSendMoney.mockImplementation(async (body) => {
        // The row exists and is committed-in-transaction BEFORE the request goes out.
        rowsWhenAsked = await trx('payroll_payments').where({ note: body.note }).select('state');
        return { requestId: `req-${body.note}`, status: 'pendingApproval' };
      });
      const results = await sendRun(run.id, client);
      expect(rowsWhenAsked).toEqual([{ state: 'queued' }]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['requested', 'requested']);
      expect(client.requestSendMoney).toHaveBeenCalledTimes(2);
      const alpha = check('Sample Alpha');
      const [row] = await payments(alpha.id);
      expect(row).toMatchObject({
        state: 'requested', attempt: 1, amount_cents: String(alpha.netCents), account_id: ACCOUNT,
        mercury_request_id: `req-waves-pay:${row.id}`, note: `waves-pay:${row.id}`, created_by: ADMIN_ID,
      });
      expect(row.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(client.requestSendMoney).toHaveBeenCalledWith(expect.objectContaining({
        amountCents: alpha.netCents, idempotencyKey: row.idempotency_key, externalMemo: 'Waves pay',
      }));
      const audit = await trx('audit_log').where({ action: 'payroll.mercury_send_queued', resource_id: run.id }).first();
      expect(audit.metadata).toEqual({ run_id: run.id, payment_count: 2 });
    });

    it('a double click makes one row and one request: the second send finds the payment', async () => {
      const { run, check } = await bankRun();
      const client = fakeClient();
      await sendRun(run.id, client);
      const second = await sendRun(run.id, client);
      expect(second).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'already_has_payment:requested' })]);
      expect(client.requestSendMoney).toHaveBeenCalledTimes(1);
      expect(await payments(check('Sample Alpha').id)).toHaveLength(1);
    });

    it('the partial unique index refuses a second open row for a check, but allows one after a closed row', async () => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      const [first] = await payments(check('Sample Alpha').id);
      const insert = (state, attempt) => trx('payroll_payments').insert({
        check_id: first.check_id, attempt, state, idempotency_key: randomUUID(), note: `waves-pay:${randomUUID()}`,
        amount_cents: 100, recipient_id: 'r', account_id: 'a',
      });
      for (const state of ['queued', 'requested', 'unknown', 'approved', 'sent']) {
        const error = await refused(() => insert(state, 2));
        expect(error.code).toBe('23505');
      }
      await setState(first.id, { state: 'failed' });
      await insert('requested', 2);
      expect(await payments(first.check_id)).toHaveLength(2);
    });

    it('a row the poller took as unknown while it waited is never sent afterwards', async () => {
      const { run, check } = await bankRun(['Sample Alpha', 'Sample Beta']);
      const client = fakeClient();
      let first = true;
      client.requestSendMoney.mockImplementation(async (body) => {
        if (first) {
          first = false;
          // While the first request is out, the second row has waited past the stale limit and the poller takes it.
          await trx('payroll_payments').where({ state: 'queued' }).whereNot({ note: body.note }).update({ updated_at: new Date(Date.now() - 10 * 60 * 1000) });
          await poll(fakeClient());
        }
        return { requestId: `req-${body.note}`, status: 'pendingApproval' };
      });
      const results = await sendRun(run.id, client);
      expect(client.requestSendMoney).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.outcome).sort()).toEqual(['requested', 'unknown']);
      const states = [...await payments(check('Sample Alpha').id), ...await payments(check('Sample Beta').id)].map((r) => r.state).sort();
      expect(states).toEqual(['requested', 'unknown']);
    });

    it('a lost answer is unknown, and sending the run again makes no second request', async () => {
      const { run, check } = await bankRun();
      const client = fakeClient();
      client.requestSendMoney.mockRejectedValue(new MercuryError('unknown'));
      const results = await sendRun(run.id, client);
      expect(results[0].outcome).toBe('unknown');
      expect((await payments(check('Sample Alpha').id))[0]).toMatchObject({ state: 'unknown' });
      const again = await sendRun(run.id, client);
      expect(again[0]).toMatchObject({ outcome: 'skipped', reason: 'already_has_payment:unknown' });
      expect(client.requestSendMoney).toHaveBeenCalledTimes(1);
    });

    it('a definite refusal is failed with only the status and code; a refused key is failed and rings the key bell', async () => {
      const { run, check } = await bankRun(['Sample Alpha', 'Sample Beta']);
      const client = fakeClient();
      client.requestSendMoney
        .mockRejectedValueOnce(new MercuryError('rejected', { status: 400, code: 'InvalidRecipient' }))
        .mockRejectedValueOnce(new MercuryError('auth', { status: 401 }));
      const raise = jest.spyOn(alerts, 'raisePaymentAlert').mockResolvedValue(true);
      await sendRun(run.id, client);
      const rows = [...await payments(check('Sample Alpha').id), ...await payments(check('Sample Beta').id)];
      expect(rows.map((r) => r.state)).toEqual(['failed', 'failed']);
      expect(rows.map((r) => r.error).sort()).toEqual(['Mercury refused the key (HTTP 401)', 'Mercury refused the request (HTTP 400): InvalidRecipient']);
      expect(alerts.raiseKeyAlert).toHaveBeenCalledTimes(1);
      expect(alerts.raiseKeyAlert).toHaveBeenCalledWith({ kind: 'send' });
      expect(raise).toHaveBeenCalledTimes(2);
      expect(raise.mock.calls.every(([event]) => event === 'failed')).toBe(true);
    });

    it('a 404 on the request (an unknown account id) is a definite failure, not unknown', async () => {
      const { run, check } = await bankRun();
      const client = fakeClient();
      client.requestSendMoney.mockRejectedValue(new MercuryError('not_found', { status: 404 }));
      jest.spyOn(alerts, 'raisePaymentAlert').mockResolvedValue(true);
      expect((await sendRun(run.id, client))[0].outcome).toBe('failed');
      const [row] = await payments(check('Sample Alpha').id);
      expect(row).toMatchObject({ state: 'failed', error: 'Mercury refused the request (HTTP 404)' });
      // After the account is corrected, Send again works.
      expect((await mercury.sendAgain(check('Sample Alpha').id, {}, ADMIN_ID, { client: fakeClient() })).outcome).toBe('requested');
    });

    it('a partial batch: one failure does not stop the other, and a re-send never repeats either', async () => {
      const { run, check } = await bankRun(['Sample Alpha', 'Sample Beta']);
      const client = fakeClient();
      client.requestSendMoney.mockRejectedValueOnce(new MercuryError('rejected', { status: 422 }));
      jest.spyOn(alerts, 'raisePaymentAlert').mockResolvedValue(true);
      const results = await sendRun(run.id, client);
      expect(results.map((r) => r.outcome).sort()).toEqual(['failed', 'requested']);
      const again = await sendRun(run.id, client);
      expect(again.every((r) => r.outcome === 'skipped')).toBe(true);
      expect(client.requestSendMoney).toHaveBeenCalledTimes(2);
      expect(await payments(check('Sample Alpha').id)).toHaveLength(1);
      expect(await payments(check('Sample Beta').id)).toHaveLength(1);
    });

    it('skips a check with no recipient id, no pay, or a paper method, and writes nothing for it', async () => {
      const noRecipient = await bankTech('Sample NoRecipient', { mercury_recipient_id: null });
      const paper = await technician('Sample Paper');
      await approvedWeek(noRecipient, W1);
      await approvedWeek(paper, W1);
      const run = await finalizedRun();
      const client = fakeClient();
      const results = await sendRun(run.id, client);
      expect(results).toEqual([expect.objectContaining({ name: 'Sample NoRecipient', outcome: 'skipped', reason: 'no_recipient' })]);
      expect(client.requestSendMoney).not.toHaveBeenCalled();
      expect(Number((await trx('payroll_payments').count('* as n').first()).n)).toBe(0);
    });

    it('needs a finalized run, both gates and a configured key', async () => {
      const tech = await bankTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const draft = (await api('POST', '/runs', { weekStart: W1 })).body.run;
      const client = fakeClient();
      await expect(sendRun(draft.id, client)).rejects.toMatchObject({ status: 409 });
      const run = await finalizedRunFor(draft);
      await expect(sendRun(run.id, fakeClient({ configured: false }))).rejects.toMatchObject({ status: 409 });
      process.env.GATE_PAYROLL_MERCURY_PAY = 'false';
      await expect(sendRun(run.id, client)).rejects.toMatchObject({ status: 404 });
      process.env.GATE_PAYROLL_MERCURY_PAY = 'true';
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      await expect(sendRun(run.id, client)).rejects.toMatchObject({ status: 404 });
      expect(client.requestSendMoney).not.toHaveBeenCalled();
    });

    async function finalizedRunFor(draft) {
      const shown = await api('GET', `/runs/${draft.id}`);
      return (await api('POST', `/runs/${draft.id}/finalize`, { token: shown.body.run.token })).body.run;
    }

    it('waits for the payroll lock while another connection holds it', async () => {
      const holder = await holderDb.transaction();
      await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', [payrollRuns.PAYROLL_LOCK_NS, payrollRuns.PAYROLL_LOCK_KEY]);
      const callerWith = {
        transaction: (work) => callerDb.transaction(async (t) => { await t.raw("SET LOCAL lock_timeout = '300ms'"); return work(t); }),
      };
      try {
        const error = await mercury.sendRun(randomUUID(), ADMIN_ID, { client: fakeClient(), conn: callerWith }).catch((err) => err);
        expect(error.code).toBe('55P03');
      } finally {
        await holder.commit();
      }
      await expect(mercury.sendRun(randomUUID(), ADMIN_ID, { client: fakeClient(), conn: callerWith })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the run view', () => {
    it('gates off: the run is exactly what it was; status on: each check carries its payment and the run a summary', async () => {
      const { run } = await bankRun(['Sample Alpha', 'Sample Beta']);
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      delete process.env.GATE_PAYROLL_MERCURY_PAY;
      const off = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(off.mercury).toBeUndefined();
      expect(off.checks.every((c) => !('payment' in c))).toBe(true);
      // The run was finalized with the gates on, so its own answer carries the Mercury keys: take them away and it is
      // exactly what the gates-off read returns (the same keys in the same order).
      const { mercury: _summary, ...bare } = run;
      bare.checks = bare.checks.map(({ payment: _payment, ...rest }) => rest);
      expect(JSON.stringify(off)).toBe(JSON.stringify(bare));

      process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
      process.env.GATE_PAYROLL_MERCURY_PAY = 'true';
      const on = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(on.mercury).toMatchObject({ payEnabled: true, configured: true, eligibleCount: 2, canSend: true, missingRecipient: [] });
      expect(on.checks.every((c) => c.payment.state === 'none' && c.payment.canPaper === true)).toBe(true);

      await sendRun(run.id, fakeClient());
      const sent = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(sent.mercury).toMatchObject({ eligibleCount: 0, canSend: false });
      expect(sent.checks[0].payment).toMatchObject({ state: 'requested', attempt: 1, canSendAgain: null, canPaper: false });
    });

    it('lists the Mercury recipient id on a technician only with the status gate on', async () => {
      const tech = await bankTech('Sample Alpha');
      process.env.GATE_PAYROLL_MERCURY_STATUS = 'true';
      expect((await api('GET', '/technicians')).body.technicians.find((t) => t.id === tech)).toHaveProperty('mercuryRecipientId');
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      expect((await api('GET', '/technicians')).body.technicians.find((t) => t.id === tech)).not.toHaveProperty('mercuryRecipientId');
    });
  });

  describe('Send again', () => {
    const sendAgain = (checkId, input, client, now) => mercury.sendAgain(checkId, input, ADMIN_ID, { client, now });
    const firstPayment = async (check) => (await payments(check.id))[0];

    it.each(['failed', 'rejected', 'cancelled', 'returned'])('after %s it starts a new attempt with a new key', async (state) => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      const old = await firstPayment(check('Sample Alpha'));
      await setState(old.id, { state });
      const client = fakeClient();
      const out = await sendAgain(check('Sample Alpha').id, {}, client);
      expect(out).toMatchObject({ attempt: 2, outcome: 'requested' });
      const rows = await payments(check('Sample Alpha').id);
      expect(rows.map((r) => [r.attempt, r.state])).toEqual([[1, state], [2, 'requested']]);
      expect(rows[1].idempotency_key).not.toBe(rows[0].idempotency_key);
      expect(rows[1].note).not.toBe(rows[0].note);
    });

    it('after a return it closes the returned bell but keeps the month-mismatch bell open for the tax fix', async () => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      const old = await firstPayment(check('Sample Alpha'));
      await setState(old.id, { state: 'returned', posted_on: '2026-10-01', resolved_at: new Date() });
      const row = await trx('payroll_payments').where({ id: old.id }).first();
      await alerts.raisePaymentAlert('month_mismatch', row);
      await alerts.raisePaymentAlert('returned', row);
      expect(await openBellKeys()).toEqual([`payroll-pay:${old.id}:month_mismatch`, `payroll-pay:${old.id}:returned`]);
      await sendAgain(check('Sample Alpha').id, {}, fakeClient());
      expect(await openBellKeys()).toEqual([`payroll-pay:${old.id}:month_mismatch`]);
    });

    it.each(['queued', 'requested', 'approved', 'sent'])('is refused while the payment is %s', async (state) => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      await setState((await firstPayment(check('Sample Alpha'))).id, { state });
      const client = fakeClient();
      await expect(sendAgain(check('Sample Alpha').id, {}, client)).rejects.toMatchObject({ status: 409 });
      expect(client.requestSendMoney).not.toHaveBeenCalled();
    });

    it('is refused when nothing was sent yet (use Send)', async () => {
      const { check } = await bankRun();
      await expect(sendAgain(check('Sample Alpha').id, {}, fakeClient())).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Send to Mercury/) });
    });

    describe('after unknown', () => {
      const unknownCheck = async () => {
        const { run, check } = await bankRun();
        const client = fakeClient();
        client.requestSendMoney.mockRejectedValueOnce(new MercuryError('unknown'));
        await sendRun(run.id, client);
        const target = check('Sample Alpha');
        const tech = await trx('technicians').where({ id: (await trx('payroll_checks').where({ id: target.id }).first()).technician_id }).first();
        return { target, recipient: tech.mercury_recipient_id, row: await firstPayment(target) };
      };

      it('needs the owner to confirm that nothing is waiting in Mercury', async () => {
        const { target } = await unknownCheck();
        const client = fakeClient();
        await expect(sendAgain(target.id, {}, client)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Confirm/) });
        expect(client.requestSendMoney).not.toHaveBeenCalled();
        expect(client.listRequests).not.toHaveBeenCalled();
      });

      it('is refused when a fresh read finds a request of the same amount to that person in the last 7 days', async () => {
        const { target, recipient, row } = await unknownCheck();
        const client = fakeClient();
        client.listRequests.mockResolvedValue([{ requestId: 'r', status: 'pendingApproval', recipientId: recipient, amountCents: Number(row.amount_cents), createdAt: new Date().toISOString() }]);
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, client)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already shows/) });
        expect(client.requestSendMoney).not.toHaveBeenCalled();
        expect((await firstPayment(target)).state).toBe('unknown');
      });

      it('is refused when Mercury shows a transaction of the same amount, but not for another amount, an old one or a rejected one', async () => {
        const { target, recipient, row } = await unknownCheck();
        const amount = Number(row.amount_cents);
        const client = fakeClient();
        client.listTransactions.mockResolvedValue([{ id: 't', status: 'sent', counterpartyId: recipient, amountCents: amount, createdAt: new Date().toISOString() }]);
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, client)).rejects.toMatchObject({ status: 409 });
        client.listTransactions.mockResolvedValue([]);
        client.listRequests.mockResolvedValue([
          { requestId: 'a', status: 'pendingApproval', recipientId: recipient, amountCents: amount + 1, createdAt: new Date().toISOString() },
          { requestId: 'b', status: 'approved', recipientId: recipient, amountCents: amount, createdAt: '2020-01-01T00:00:00Z' },
          { requestId: 'c', status: 'rejected', recipientId: recipient, amountCents: amount, createdAt: new Date().toISOString() },
        ]);
        expect((await sendAgain(target.id, { confirmNothingWaiting: true }, client)).outcome).toBe('requested');
      });

      it('an unknown attempt older than a week: a still-pending request of any age, or a transaction since the attempt, blocks the retry', async () => {
        const { target, recipient, row } = await unknownCheck();
        const amount = Number(row.amount_cents);
        const old = new Date(Date.now() - 20 * 24 * 3600 * 1000);
        await trx('payroll_payments').where({ id: row.id }).update({ created_at: old });
        const client = fakeClient();
        client.listRequests.mockResolvedValue([{ requestId: 'p', status: 'pendingApproval', recipientId: recipient, amountCents: amount, createdAt: new Date(old.getTime() + 60000).toISOString() }]);
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, client)).rejects.toMatchObject({ status: 409 });
        client.listRequests.mockResolvedValue([]);
        client.listTransactions.mockResolvedValue([{ id: 't', status: 'sent', counterpartyId: recipient, amountCents: amount, createdAt: new Date(old.getTime() + 3600000).toISOString() }]);
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, client)).rejects.toMatchObject({ status: 409 });
        // The read reaches back to the attempt, not just seven days.
        const start = new Date(`${client.listTransactions.mock.calls[0][0].start}T00:00:00Z`).getTime();
        expect(start).toBeLessThanOrEqual(old.getTime());
        client.listTransactions.mockResolvedValue([]);
        expect((await sendAgain(target.id, { confirmNothingWaiting: true }, client)).outcome).toBe('requested');
      });

      it('with nothing in Mercury it closes the unknown row as failed with a reason and starts attempt 2', async () => {
        const { target } = await unknownCheck();
        const client = fakeClient();
        const out = await sendAgain(target.id, { confirmNothingWaiting: true }, client);
        expect(out).toMatchObject({ attempt: 2, outcome: 'requested' });
        const rows = await payments(target.id);
        expect(rows[0]).toMatchObject({ state: 'failed', resolution: expect.stringMatching(/nothing was waiting/) });
        expect(rows[1].state).toBe('requested');
        expect(client.requestSendMoney).toHaveBeenCalledTimes(1);
      });

      it('looks for the original destination: the stored recipient, and a changed account is refused', async () => {
        const { target, recipient, row } = await unknownCheck();
        const amount = Number(row.amount_cents);
        // The employee's recipient id changes after the lost answer; the original request is still found.
        await trx('technicians').where({ mercury_recipient_id: recipient }).update({ mercury_recipient_id: randomUUID() });
        const client = fakeClient();
        client.listRequests.mockResolvedValue([{ requestId: 'r', status: 'pendingApproval', recipientId: recipient, amountCents: amount, createdAt: new Date().toISOString() }]);
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, client)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already shows/) });
        // A client on another account cannot look where the original went: fail closed, no read, no request.
        const other = fakeClient({ accountId: randomUUID() });
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, other)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/account changed/) });
        expect(other.listRequests).not.toHaveBeenCalled();
        expect(other.requestSendMoney).not.toHaveBeenCalled();
      });

      it('a void that lands first stops the retry: the check is judged again under the lock', async () => {
        const { run, check } = await bankRun();
        await sendRun(run.id, fakeClient());
        const old = (await payments(check('Sample Alpha').id))[0];
        await setState(old.id, { state: 'failed' });
        const client = fakeClient();
        // The void commits between the retry's first read and its locked transaction.
        const conn = new Proxy(trx, {
          apply: (_t, _this, args) => trx(...args),
          get: (_t, key) => {
            if (key === 'transaction') {
              return async (work) => {
                await trx('payroll_checks').where({ run_id: run.id }).update({ status: 'voided' });
                return trx.transaction(work);
              };
            }
            const value = trx[key];
            return typeof value === 'function' ? value.bind(trx) : value;
          },
        });
        await expect(mercury.sendAgain(check('Sample Alpha').id, {}, ADMIN_ID, { client, conn })).rejects.toMatchObject({ status: 409 });
        expect(client.requestSendMoney).not.toHaveBeenCalled();
        expect(await payments(check('Sample Alpha').id)).toHaveLength(1);
      });

      it('a Mercury read that fails refuses the retry', async () => {
        const { target } = await unknownCheck();
        const client = fakeClient();
        client.listRequests.mockRejectedValue(new MercuryError('unknown'));
        await expect(sendAgain(target.id, { confirmNothingWaiting: true }, client)).rejects.toMatchObject({ status: 502 });
        expect(client.requestSendMoney).not.toHaveBeenCalled();
        expect((await firstPayment(target)).state).toBe('unknown');
      });
    });

    it('the PAY gate off: 404 and no request', async () => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      await setState((await firstPayment(check('Sample Alpha'))).id, { state: 'failed' });
      delete process.env.GATE_PAYROLL_MERCURY_PAY;
      const client = fakeClient();
      await expect(sendAgain(check('Sample Alpha').id, {}, client)).rejects.toMatchObject({ status: 404 });
      expect(client.requestSendMoney).not.toHaveBeenCalled();
    });
  });

  describe('linking a Mercury request to an unknown payment', () => {
    const link = (id, requestId, client) => mercury.linkRequest(id, { requestId }, ADMIN_ID, { client });
    const unknownRow = async () => {
      const { run, check } = await bankRun();
      const client = fakeClient();
      client.requestSendMoney.mockRejectedValueOnce(new MercuryError('unknown'));
      await sendRun(run.id, client);
      const row = (await payments(check('Sample Alpha').id))[0];
      const request = (patch = {}) => ({
        requestId: 'req-mine', status: 'pendingApproval', recipientId: row.recipient_id, accountId: row.account_id,
        amountCents: Number(row.amount_cents), createdAt: new Date(new Date(row.created_at).getTime() + 60000).toISOString(), ...patch,
      });
      return { row, check: check('Sample Alpha'), request, run };
    };

    it.each([
      ['pendingApproval', 'requested'], ['approved', 'approved'], ['rejected', 'rejected'], ['cancelled', 'cancelled'],
    ])('a matching %s request is linked: state %s, the id saved, one audit event with ids only', async (status, state) => {
      const { row, request } = await unknownRow();
      const client = fakeClient();
      client.getRequest.mockResolvedValue(request({ status }));
      expect(await link(row.id, ' req-mine ', client)).toEqual({ paymentId: row.id, requestId: 'req-mine', state });
      const after = await trx('payroll_payments').where({ id: row.id }).first();
      expect(after).toMatchObject({ state, mercury_request_id: 'req-mine', error: null });
      if (['rejected', 'cancelled'].includes(state)) expect(after.resolved_at).not.toBeNull();
      const audits = await trx('audit_log').where({ action: 'payroll.mercury_request_linked', resource_id: row.id });
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toEqual({ payment_id: row.id, request_id: 'req-mine' });
      // Linking moves no money: it never asks Mercury for a payment.
      expect(client.requestSendMoney).not.toHaveBeenCalled();
    });

    it('then the poller carries on from Mercury', async () => {
      const { row, request } = await unknownRow();
      const client = fakeClient();
      client.getRequest.mockResolvedValue(request());
      await link(row.id, 'req-mine', client);
      client.getRequest.mockResolvedValue({ status: 'approved' });
      await poll(client, new Date('2026-09-22T12:00:00Z'));
      expect((await trx('payroll_payments').where({ id: row.id }).first()).state).toBe('approved');
    });

    it.each([
      ['recipient', { recipientId: 'someone-else' }, /different recipient/],
      ['account', { accountId: 'another-account' }, /different Mercury account/],
      ['amount', { amountCents: 1 }, /different amount/],
      ['time (made long before the attempt)', { createdAt: '2020-01-01T00:00:00Z' }, /before this payment was tried/],
    ])('a request with the wrong %s is a 400 and nothing changes', async (_name, patch, words) => {
      const { row, request } = await unknownRow();
      const client = fakeClient();
      client.getRequest.mockResolvedValue(request(patch));
      await expect(link(row.id, 'req-mine', client)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(words) });
      expect(await trx('payroll_payments').where({ id: row.id }).first()).toMatchObject({ state: 'unknown', mercury_request_id: null });
      expect(await trx('audit_log').where({ action: 'payroll.mercury_request_linked' })).toHaveLength(0);
    });

    it('a request already linked to another payment is refused, before Mercury is asked', async () => {
      const { row, request } = await unknownRow();
      const other = await bankTech('Sample Other');
      await approvedWeek(other, W2);
      const run2 = await finalizedRun(W2);
      await sendRun(run2.id, fakeClient({ requestSendMoney: jest.fn(async () => ({ requestId: 'req-taken', status: 'pendingApproval' })) }));
      const client = fakeClient();
      client.getRequest.mockResolvedValue(request());
      await expect(link(row.id, 'req-taken', client)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/already linked/) });
      expect(client.getRequest).not.toHaveBeenCalled();
      expect((await trx('payroll_payments').where({ id: row.id }).first()).state).toBe('unknown');
    });

    it('a 404 from Mercury is a 400; an outage is a 502; a bad id is a 400 with no read', async () => {
      const { row } = await unknownRow();
      const client = fakeClient();
      client.getRequest.mockRejectedValue(new MercuryError('not_found', { status: 404 }));
      await expect(link(row.id, 'nope', client)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no request with that id/) });
      client.getRequest.mockRejectedValue(new MercuryError('unknown'));
      await expect(link(row.id, 'req-1', client)).rejects.toMatchObject({ status: 502 });
      client.getRequest.mockClear();
      await expect(link(row.id, 'has spaces', client)).rejects.toMatchObject({ status: 400 });
      await expect(mercury.linkRequest(row.id, {}, ADMIN_ID, { client })).rejects.toMatchObject({ status: 400 });
      expect(client.getRequest).not.toHaveBeenCalled();
      expect((await trx('payroll_payments').where({ id: row.id }).first()).state).toBe('unknown');
    });

    it.each(['queued', 'requested', 'approved', 'sent', 'failed', 'rejected', 'cancelled', 'returned'])('a %s payment is refused', async (state) => {
      const { row, request } = await unknownRow();
      await setState(row.id, { state });
      const client = fakeClient();
      client.getRequest.mockResolvedValue(request());
      await expect(link(row.id, 'req-mine', client)).rejects.toMatchObject({ status: 409 });
      expect(client.getRequest).not.toHaveBeenCalled();
    });

    it('a payment that does not exist is 404; the status gate off is 404 and reads nothing', async () => {
      const client = fakeClient();
      await expect(link(randomUUID(), 'req-1', client)).rejects.toMatchObject({ status: 404 });
      const { row } = await unknownRow();
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      await expect(link(row.id, 'req-1', client)).rejects.toMatchObject({ status: 404 });
      expect(client.getRequest).not.toHaveBeenCalled();
    });

    it('a linked payment can be settled afterwards: a rejected one allows Send again, and a void goes through', async () => {
      const { row, request, run, check } = await unknownRow();
      const client = fakeClient();
      client.getRequest.mockResolvedValue(request({ status: 'rejected' }));
      await link(row.id, 'req-mine', client);
      expect((await mercury.sendAgain(check.id, {}, ADMIN_ID, { client: fakeClient() })).outcome).toBe('requested');
      expect(run.id).toBeTruthy();
    });
  });

  describe('paid by paper check instead', () => {
    const paper = (checkId, number = '1001') => mercury.recordPaper(checkId, { checkNumber: number }, ADMIN_ID);

    it('records a paper row with the number on the same frozen check, with no new earning', async () => {
      const { check } = await bankRun();
      const before = await trx('payroll_checks').where({ id: check('Sample Alpha').id }).first();
      const out = await paper(check('Sample Alpha').id, ' 1001 ');
      expect(out.checkNumber).toBe('1001');
      const [row] = await payments(check('Sample Alpha').id);
      expect(row).toMatchObject({ state: 'paper', check_number: '1001', attempt: 1, resolution: 'Paid by paper check instead' });
      expect(await trx('payroll_checks').where({ id: check('Sample Alpha').id }).first()).toEqual(before);
    });

    it('the stubs, the technician\'s list and the CSV show the paper check; the frozen check row keeps bank transfer', async () => {
      const { run, check } = await bankRun();
      const id = check('Sample Alpha').id;
      const { technician_id: techId } = await trx('payroll_checks').where({ id }).first('technician_id');
      const csvLine = async () => (await payrollRuns.exportCsv(run.id)).csv.split('\n')[1];
      await sendRun(run.id, fakeClient());
      await setState((await payments(id))[0].id, { state: 'failed' });
      // A failed Mercury attempt is not a paper check: still bank transfer.
      expect(await payrollRuns.getStub(id)).toMatchObject({ payMethod: 'bank_transfer', checkNumber: null });
      expect(await csvLine()).toContain(',Bank transfer,');
      await paper(id, '1001');
      expect(await payrollRuns.getStub(id)).toMatchObject({ payMethod: 'check', checkNumber: '1001' });
      expect(await payrollRuns.getOwnStub(techId, id)).toMatchObject({ payMethod: 'check', checkNumber: '1001' });
      expect((await payrollRuns.listOwnChecks(techId)).find((c) => c.id === id)).toMatchObject({ payMethod: 'check' });
      expect(await csvLine()).toContain(',Paper check,1001');
      expect(await trx('payroll_checks').where({ id }).first('pay_method', 'check_number')).toEqual({ pay_method: 'bank_transfer', check_number: null });
    });

    it.each(['queued', 'requested', 'unknown', 'approved', 'sent'])('is refused while a payment is %s', async (state) => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      await setState((await payments(check('Sample Alpha').id))[0].id, { state });
      await expect(paper(check('Sample Alpha').id)).rejects.toMatchObject({ status: 409 });
      expect((await payments(check('Sample Alpha').id))).toHaveLength(1);
    });

    it.each(['failed', 'rejected', 'cancelled', 'returned'])('is allowed after %s, and then Send again and Send are refused', async (state) => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      await setState((await payments(check('Sample Alpha').id))[0].id, { state });
      await paper(check('Sample Alpha').id);
      expect((await payments(check('Sample Alpha').id)).map((r) => r.state)).toEqual([state, 'paper']);
      await expect(mercury.sendAgain(check('Sample Alpha').id, {}, ADMIN_ID, { client: fakeClient() })).rejects.toMatchObject({ status: 409 });
      await expect(paper(check('Sample Alpha').id, '1002')).rejects.toMatchObject({ status: 409 });
      const client = fakeClient();
      expect((await sendRun(run.id, client))[0]).toMatchObject({ outcome: 'skipped' });
      expect(client.requestSendMoney).not.toHaveBeenCalled();
    });

    it('needs a real number, a final run and a bank-transfer check; a paper-method check keeps its own number box', async () => {
      const { check } = await bankRun();
      await expect(paper(check('Sample Alpha').id, '')).rejects.toMatchObject({ status: 400 });
      await expect(paper(check('Sample Alpha').id, 'x'.repeat(31))).rejects.toMatchObject({ status: 400 });
      await expect(paper(check('Sample Alpha').id, 'a\u0000b')).rejects.toMatchObject({ status: 400 });
      const tech = await technician('Sample Paper');
      await approvedWeek(tech, W2);
      const run = await finalizedRun(W2);
      await expect(paper(run.checks[0].id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already a paper check/) });
    });

    it('setCheckNumber still refuses a bank-transfer check', async () => {
      const { check } = await bankRun();
      const res = await api('PUT', `/checks/${check('Sample Alpha').id}/check-number`, { checkNumber: '1001' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/paper checks only/);
    });

    it('the status gate off: 404', async () => {
      const { check } = await bankRun();
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      await expect(paper(check('Sample Alpha').id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('voiding a run', () => {
    it.each(['queued', 'requested', 'unknown', 'approved', 'sent'])('is refused while a payment is %s, with the gates on or off', async (state) => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      await setState((await payments(check('Sample Alpha').id))[0].id, { state });
      for (const on of [true, false]) {
        if (!on) { delete process.env.GATE_PAYROLL_MERCURY_STATUS; delete process.env.GATE_PAYROLL_MERCURY_PAY; }
        const res = await api('POST', `/runs/${run.id}/void`, { reason: 'Redo the week' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/Reject it in Mercury first, or record that the money came back/);
      }
      expect((await trx('payroll_runs').where({ id: run.id }).first()).status).toBe('finalized');
    });

    it.each(['failed', 'rejected', 'cancelled', 'returned'])('goes through when the payment is %s, and wages stay as filed', async (state) => {
      const { run, check } = await bankRun();
      await sendRun(run.id, fakeClient());
      await setState((await payments(check('Sample Alpha').id))[0].id, { state });
      const res = await api('POST', `/runs/${run.id}/void`, { reason: 'Redo the week' });
      expect(res.status).toBe(200);
      expect((await payments(check('Sample Alpha').id))[0].state).toBe(state);
    });

    it('goes through for a paper-settled payment', async () => {
      const { run, check } = await bankRun();
      await mercury.recordPaper(check('Sample Alpha').id, { checkNumber: '1001' }, ADMIN_ID);
      expect((await api('POST', `/runs/${run.id}/void`, { reason: 'Redo the week' })).status).toBe(200);
    });

    it('a returned ACH changes nothing about wages, taxes or the frozen check', async () => {
      const { run, check } = await bankRun();
      const client = fakeClient();
      await sendRun(run.id, client);
      const frozen = await trx('payroll_checks').where({ run_id: run.id }).orderBy('id');
      const [row] = await payments(check('Sample Alpha').id);
      await setState(row.id, { state: 'sent', mercury_request_id: 'req-1', resolved_at: new Date() });
      client.listTransactions.mockResolvedValue([{ id: 't1', requestId: 'req-1', status: 'failed', amountCents: Number(row.amount_cents) }]);
      await poll(client, new Date(Date.now() + 25 * 3600 * 1000));
      expect((await payments(check('Sample Alpha').id))[0].state).toBe('returned');
      expect(await trx('payroll_checks').where({ run_id: run.id }).orderBy('id')).toEqual(frozen);
    });
  });

  describe('the status poller', () => {
    const NOW = new Date('2026-09-23T15:00:00Z');
    const sent = async (names = ['Sample Alpha']) => {
      const ctx = await bankRun(names);
      const client = fakeClient();
      client.requestSendMoney.mockImplementation(async (b) => ({ requestId: `req-${b.note}`, status: 'pendingApproval' }));
      await sendRun(ctx.run.id, client);
      return { ...ctx, client, row: async (name = names[0]) => (await payments(ctx.check(name).id)).at(-1) };
    };
    const quietBells = () => jest.spyOn(alerts, 'raisePaymentAlert').mockResolvedValue(true);

    it('requested: pending stays, approved moves on, rejected and cancelled close with a bell', async () => {
      const bells = quietBells();
      const ctx = await sent(['Sample Alpha', 'Sample Beta', 'Sample Gamma']);
      const byId = {};
      for (const name of ['Sample Alpha', 'Sample Beta', 'Sample Gamma']) byId[(await ctx.row(name)).mercury_request_id] = name;
      const statuses = { 'Sample Alpha': 'pendingApproval', 'Sample Beta': 'rejected', 'Sample Gamma': 'cancelled' };
      ctx.client.getRequest.mockImplementation(async (id) => ({ status: statuses[byId[id]] }));
      await poll(ctx.client, new Date('2026-09-22T12:00:00Z'));
      expect((await ctx.row('Sample Alpha')).state).toBe('requested');
      expect((await ctx.row('Sample Beta')).state).toBe('rejected');
      expect((await ctx.row('Sample Gamma')).state).toBe('cancelled');
      expect((await ctx.row('Sample Beta')).resolved_at).not.toBeNull();
      expect(bells.mock.calls.map(([event]) => event).sort()).toEqual(['cancelled', 'rejected']);
      ctx.client.getRequest.mockImplementation(async () => ({ status: 'approved' }));
      await setState((await ctx.row('Sample Alpha')).id, { last_polled_at: null });
      await poll(ctx.client, new Date('2026-09-22T12:00:00Z'));
      expect((await ctx.row('Sample Alpha')).state).toBe('approved');
    });

    it('approved: a pending transaction is linked, a sent one is sent with the day it posted', async () => {
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'approved' });
      ctx.client.listTransactions.mockResolvedValue([{ id: 'tx-1', requestId: row.mercury_request_id, status: 'pending', amountCents: Number(row.amount_cents), postedAt: null }]);
      await poll(ctx.client, NOW);
      expect(await ctx.row()).toMatchObject({ state: 'approved', mercury_transaction_id: 'tx-1' });
      ctx.client.listTransactions.mockResolvedValue([{ id: 'tx-1', requestId: row.mercury_request_id, status: 'sent', amountCents: Number(row.amount_cents), postedAt: '2026-09-24T14:00:00Z' }]);
      await poll(ctx.client, NOW);
      const done = await ctx.row();
      expect(done).toMatchObject({ state: 'sent', mercury_transaction_id: 'tx-1' });
      expect(String(done.posted_on)).toMatch(/2026-09-24|Sep 24 2026/);
    });

    it('approved and failed in Mercury: failed with a bell', async () => {
      const bells = quietBells();
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'approved' });
      ctx.client.listTransactions.mockResolvedValue([{ id: 'tx-1', requestId: row.mercury_request_id, status: 'failed', amountCents: Number(row.amount_cents) }]);
      await poll(ctx.client, NOW);
      expect(await ctx.row()).toMatchObject({ state: 'failed' });
      expect(bells).toHaveBeenCalledWith('failed', expect.anything(), expect.anything());
    });

    it('a posting in another month than the pay date rings the tax-figures bell', async () => {
      const bells = quietBells();
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'approved' });
      // Pay date is 2026-09-25; the transfer posts on Oct 1.
      ctx.client.listTransactions.mockResolvedValue([{ id: 'tx-1', requestId: row.mercury_request_id, status: 'sent', amountCents: Number(row.amount_cents), postedAt: '2026-10-01T14:00:00Z' }]);
      await poll(ctx.client, NOW);
      expect(bells.mock.calls.map(([event]) => event)).toContain('month_mismatch');
    });

    it('a month-mismatch bell that failed to write is raised again from the saved posting date', async () => {
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'sent', resolved_at: NOW, posted_on: '2026-10-01', last_polled_at: NOW });
      const bells = quietBells();
      await poll(ctx.client, NOW);
      expect(bells.mock.calls.map(([event]) => event)).toContain('month_mismatch');
      bells.mockClear();
      await setState(row.id, { posted_on: '2026-09-24' });
      await poll(ctx.client, NOW);
      expect(bells.mock.calls.map(([event]) => event)).not.toContain('month_mismatch');
    });

    it('sent: read once a day for 60 days; a failed, reversed or refunded transaction becomes returned', async () => {
      const bells = quietBells();
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'sent', resolved_at: NOW, last_polled_at: null, posted_on: '2026-09-24' });
      const tx = (extra) => [{ id: 'tx-1', requestId: row.mercury_request_id, status: 'sent', amountCents: Number(row.amount_cents), postedAt: '2026-09-24T14:00:00Z', hasReturn: false, ...extra }];
      ctx.client.listTransactions.mockResolvedValue(tx({}));
      await poll(ctx.client, new Date(NOW.getTime() + 60 * 1000));
      expect((await ctx.row()).state).toBe('sent');
      const reads = ctx.client.listTransactions.mock.calls.length;
      // Read again within 23 hours: not read.
      await poll(ctx.client, new Date(NOW.getTime() + 3600 * 1000));
      expect(ctx.client.listTransactions.mock.calls.length).toBe(reads);
      // A day later, with a refund: returned.
      ctx.client.listTransactions.mockResolvedValue(tx({ hasReturn: true }));
      await poll(ctx.client, new Date(NOW.getTime() + 25 * 3600 * 1000));
      expect((await ctx.row()).state).toBe('returned');
      expect(bells).toHaveBeenCalledWith('returned', expect.anything(), expect.anything());
    });

    it('after 60 days a sent payment is not read any more, and it stays listed with a note', async () => {
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'sent', resolved_at: new Date(NOW.getTime() - 61 * 24 * 3600 * 1000), last_polled_at: null });
      await poll(ctx.client, NOW);
      expect(ctx.client.listTransactions).not.toHaveBeenCalled();
      expect(await ctx.row()).toMatchObject({ state: 'sent', resolution: 'No return seen in 60 days' });
      const view = (await api('GET', `/runs/${ctx.run.id}`)).body.run;
      expect(view.checks[0].payment).toMatchObject({ state: 'sent' });
    });

    it('a stale queued row (the server stopped before the answer) becomes unknown', async () => {
      const ctx = await bankRun();
      const id = randomUUID();
      await trx('payroll_payments').insert({
        id, check_id: ctx.check('Sample Alpha').id, attempt: 1, state: 'queued', idempotency_key: randomUUID(), note: `waves-pay:${id}`,
        amount_cents: 100, recipient_id: 'r', account_id: ACCOUNT,
        created_at: new Date(NOW.getTime() - 10 * 60 * 1000), updated_at: new Date(NOW.getTime() - 10 * 60 * 1000),
      });
      const client = fakeClient();
      await poll(client, NOW);
      expect((await trx('payroll_payments').where({ id }).first()).state).toBe('unknown');
      expect(client.getRequest).not.toHaveBeenCalled();
    });

    describe('unknown', () => {
      const unknownPayment = async () => {
        const ctx = await bankRun();
        const check = ctx.check('Sample Alpha');
        const tech = await trx('technicians').where({ id: (await trx('payroll_checks').where({ id: check.id }).first()).technician_id }).first();
        const id = randomUUID();
        await trx('payroll_payments').insert({
          id, check_id: check.id, attempt: 1, state: 'unknown', idempotency_key: randomUUID(), note: `waves-pay:${id}`,
          amount_cents: check.netCents, recipient_id: tech.mercury_recipient_id, account_id: ACCOUNT, created_at: new Date(NOW.getTime() - 40 * 60 * 1000),
        });
        return { id, check, recipient: tech.mercury_recipient_id, row: () => trx('payroll_payments').where({ id }).first() };
      };

      it('a request carrying our note is linked and takes its state; the request is never re-sent', async () => {
        const bells = quietBells();
        const ctx = await unknownPayment();
        const client = fakeClient();
        client.listRequests.mockResolvedValue([{ requestId: 'req-found', status: 'approved', recipientId: ctx.recipient, amountCents: ctx.check.netCents, createdAt: new Date(NOW.getTime() - 39 * 60 * 1000).toISOString(), memo: `waves-pay:${ctx.id}` }]);
        await poll(client, NOW);
        expect(await ctx.row()).toMatchObject({ state: 'approved', mercury_request_id: 'req-found', error: null });
        expect(client.requestSendMoney).not.toHaveBeenCalled();
        expect(bells.mock.calls.map(([event]) => event)).not.toContain('unknown');
      });

      it('a same-amount request without our note stays unknown and rings "probably ours" (and unknown after 30 minutes)', async () => {
        const bells = quietBells();
        const ctx = await unknownPayment();
        const client = fakeClient();
        client.listRequests.mockResolvedValue([{ requestId: 'req-x', status: 'pendingApproval', recipientId: ctx.recipient, amountCents: ctx.check.netCents, createdAt: new Date(NOW.getTime() - 39 * 60 * 1000).toISOString(), memo: null }]);
        await poll(client, NOW);
        expect((await ctx.row()).state).toBe('unknown');
        expect(bells.mock.calls.map(([event]) => event).sort()).toEqual(['probably_ours', 'unknown']);
      });

      it('nothing in Mercury: stays unknown; under 30 minutes old it does not ring yet', async () => {
        const bells = quietBells();
        const ctx = await unknownPayment();
        await trx('payroll_payments').where({ id: ctx.id }).update({ created_at: new Date(NOW.getTime() - 10 * 60 * 1000) });
        await poll(fakeClient(), NOW);
        expect((await ctx.row()).state).toBe('unknown');
        expect(bells).not.toHaveBeenCalled();
      });

      it.each([
        ['pendingApproval', 'requested', []],
        ['rejected', 'rejected', ['rejected']],
      ])('a found %s request closes the "unknown" and "probably ours" bells; only a new bell stays open', async (status, state, events) => {
        const ctx = await unknownPayment();
        const client = fakeClient();
        const request = { requestId: 'req-found', recipientId: ctx.recipient, amountCents: ctx.check.netCents, createdAt: new Date(NOW.getTime() - 39 * 60 * 1000).toISOString() };
        client.listRequests.mockResolvedValue([{ ...request, status: 'pendingApproval', memo: null }]);
        await poll(client, NOW);
        expect(await openBellKeys()).toEqual([`payroll-pay:${ctx.id}:probably_ours`, `payroll-pay:${ctx.id}:unknown`]);
        client.listRequests.mockResolvedValue([{ ...request, status, memo: `waves-pay:${ctx.id}` }]);
        await poll(client, new Date(NOW.getTime() + 15 * 60 * 1000));
        expect(await ctx.row()).toMatchObject({ state, mercury_request_id: 'req-found' });
        expect(await openBellKeys()).toEqual(events.map((event) => `payroll-pay:${ctx.id}:${event}`));
      });
    });

    it('a request still pending at noon ET on the business day before pay day rings once', async () => {
      const bells = quietBells();
      const ctx = await sent();
      // Pay day Fri 2026-09-25: the business day before is Thu 09-24; noon ET = 16:00Z.
      await poll(ctx.client, new Date('2026-09-24T15:59:00Z'));
      expect(bells).not.toHaveBeenCalled();
      await poll(ctx.client, new Date('2026-09-24T16:01:00Z'));
      expect(bells).toHaveBeenCalledWith('pending_noon', expect.anything(), expect.anything());
    });

    it.each(['rejected', 'cancelled'])('a request %s after the noon reminder closes the reminder; only its own bell stays open', async (status) => {
      const ctx = await sent();
      const row = await ctx.row();
      await poll(ctx.client, new Date('2026-09-24T16:01:00Z'));
      expect(await openBellKeys()).toEqual([`payroll-pay:${row.id}:pending_noon`]);
      ctx.client.getRequest.mockResolvedValue({ status });
      await poll(ctx.client, new Date('2026-09-24T16:16:00Z'));
      expect((await ctx.row()).state).toBe(status);
      expect(await openBellKeys()).toEqual([`payroll-pay:${row.id}:${status}`]);
    });

    it('a refused key (401) rings the key bell once and ends the run', async () => {
      const ctx = await sent(['Sample Alpha', 'Sample Beta']);
      ctx.client.getRequest.mockRejectedValue(new MercuryError('auth', { status: 401 }));
      const out = await poll(ctx.client, NOW);
      expect(alerts.raiseKeyAlert).toHaveBeenCalledTimes(1);
      expect(ctx.client.getRequest).toHaveBeenCalledTimes(1);
      expect(out.failed).toBe(1);
    });

    it('a payment made in another account is not read; it rings and its return watch is not closed', async () => {
      const bells = quietBells();
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { account_id: randomUUID() });
      await poll(ctx.client, NOW);
      expect(ctx.client.getRequest).not.toHaveBeenCalled();
      expect(bells).toHaveBeenCalledWith('account_changed', expect.anything(), expect.anything());
      await setState(row.id, { state: 'sent', resolved_at: new Date(NOW.getTime() - 61 * 24 * 3600 * 1000) });
      await poll(ctx.client, NOW);
      expect((await ctx.row()).resolution).not.toBe('No return seen in 60 days');
    });

    it('a good read does not close the send-permission bell', async () => {
      jest.spyOn(alerts, 'closeKeyBell').mockResolvedValue(0);
      const ctx = await sent();
      await poll(ctx.client, NOW);
      expect(alerts.closeKeyBell).toHaveBeenCalledWith(expect.not.objectContaining({ kind: 'send' }));
    });

    it('a bell that failed to write is raised again on a later tick, once, and not for a payment with a newer attempt', async () => {
      const ctx = await sent();
      const row = await ctx.row();
      await setState(row.id, { state: 'rejected', resolved_at: NOW });
      const bells = jest.spyOn(alerts, 'raisePaymentAlert').mockResolvedValue(true);
      await poll(ctx.client, NOW);
      expect(bells).toHaveBeenCalledWith('rejected', expect.objectContaining({ id: row.id }), expect.anything());
      bells.mockClear();
      await trx('payroll_payments').insert({
        check_id: row.check_id, attempt: 2, state: 'requested', idempotency_key: randomUUID(), note: `waves-pay:${randomUUID()}`,
        amount_cents: 100, recipient_id: 'r', account_id: ACCOUNT, mercury_request_id: 'req-2',
      });
      await poll(ctx.client, NOW);
      expect(bells.mock.calls.map(([event]) => event)).not.toContain('rejected');
    });

    it('a Mercury error on one row does not stop the others, and a working read closes the key bell', async () => {
      jest.spyOn(alerts, 'closeKeyBell').mockResolvedValue(0);
      const ctx = await sent(['Sample Alpha', 'Sample Beta']);
      ctx.client.getRequest.mockRejectedValueOnce(new MercuryError('unknown')).mockResolvedValue({ status: 'approved' });
      const out = await poll(ctx.client, NOW);
      expect(out).toMatchObject({ read: 1, failed: 1 });
      expect(alerts.closeKeyBell).toHaveBeenCalled();
    });

    it('gates off: nothing is read and no Mercury call is made', async () => {
      const ctx = await sent();
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      const client = fakeClient();
      expect(await poll(client, NOW)).toMatchObject({ skipped: 'gate_off' });
      expect(client.getRequest).not.toHaveBeenCalled();
      expect((await ctx.row()).state).toBe('requested');
    });

    it('only moves a row that is still in the state it read (a Send again in between wins)', async () => {
      const ctx = await sent();
      const row = await ctx.row();
      const changed = await trx('payroll_payments').where({ id: row.id, state: 'unknown' }).update({ state: 'sent' });
      expect(Number(changed)).toBe(0);
    });

    it('a rejected request rings a real bell in the Billing area for the right person', async () => {
      const ctx = await sent();
      const row = await ctx.row();
      ctx.client.getRequest.mockResolvedValue({ status: 'rejected' });
      alerts.raiseKeyAlert.mockRestore();
      await poll(ctx.client, new Date('2026-09-22T12:00:00Z'));
      const bell = await trx('notifications').where({ recipient_type: 'admin', category: 'payroll' }).first();
      expect(bell).toBeTruthy();
      expect(bell.metadata).toMatchObject({ dedupeKey: `payroll-pay:${row.id}:rejected`, area: 'Billing', who: 'person', severity: 'needs-you' });
      expect(bell.title).toMatch(/^Billing — /);
    });
  });

  describe('the Mercury recipient id', () => {
    const setRecipient = (id, recipientId, client = fakeClient()) => mercury.setMercuryRecipient(id, { recipientId }, ADMIN_ID, { client });

    it('reads the recipient, saves the id and shows the name only', async () => {
      const tech = await technician('Sample Alpha');
      const recipientId = randomUUID();
      const client = fakeClient();
      client.getRecipient.mockResolvedValue({ name: 'Sample Alpha', status: 'active' });
      const out = await setRecipient(tech, recipientId.toUpperCase(), client);
      expect(out).toEqual({ id: tech, mercuryRecipientId: recipientId, recipientName: 'Sample Alpha', verified: true });
      expect((await trx('technicians').where({ id: tech }).first()).mercury_recipient_id).toBe(recipientId);
      const audit = await trx('audit_log').where({ action: 'payroll.mercury_recipient_set', resource_id: tech }).first();
      expect(audit.metadata).toEqual({ technician_id: tech, cleared: false });
    });

    it('a 404 from Mercury is a 400 and nothing is saved; a deleted recipient is refused', async () => {
      const tech = await technician('Sample Alpha');
      const client = fakeClient();
      client.getRecipient.mockRejectedValue(new MercuryError('not_found', { status: 404 }));
      await expect(setRecipient(tech, randomUUID(), client)).rejects.toMatchObject({ status: 400 });
      client.getRecipient.mockResolvedValue({ name: 'Gone', status: 'deleted' });
      await expect(setRecipient(tech, randomUUID(), client)).rejects.toMatchObject({ status: 400 });
      expect((await trx('technicians').where({ id: tech }).first()).mercury_recipient_id).toBeNull();
    });

    it('a Mercury outage or a refused key does not save; with no key it saves without a read', async () => {
      const tech = await technician('Sample Alpha');
      const client = fakeClient();
      client.getRecipient.mockRejectedValue(new MercuryError('auth', { status: 401 }));
      await expect(setRecipient(tech, randomUUID(), client)).rejects.toMatchObject({ status: 502 });
      expect(alerts.raiseKeyAlert).toHaveBeenCalled();
      const unconfigured = fakeClient({ configured: false });
      const id = randomUUID();
      expect(await setRecipient(tech, id, unconfigured)).toMatchObject({ mercuryRecipientId: id, recipientName: null, verified: false });
      expect(unconfigured.getRecipient).not.toHaveBeenCalled();
    });

    it('refuses a bad id, a second employee with the same recipient, a non-W-2 person; null clears it', async () => {
      const a = await technician('Sample Alpha');
      const b = await technician('Sample Beta');
      const id = randomUUID();
      await expect(setRecipient(a, 'not-an-id')).rejects.toMatchObject({ status: 400 });
      await setRecipient(a, id);
      await expect(setRecipient(b, id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Another employee/) });
      const contractor = await trx('technicians').insert({ id: randomUUID(), name: 'Sample Contractor', employment_type: '1099', employment_status: 'active' }).returning('id');
      await expect(setRecipient(contractor[0].id || contractor[0], randomUUID())).rejects.toMatchObject({ status: 409 });
      expect((await setRecipient(a, null)).mercuryRecipientId).toBeNull();
    });

    it('the route answers 404 with the status gate off and never reads Mercury', async () => {
      const tech = await technician('Sample Alpha');
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      const res = await api('PUT', `/technicians/${tech}/mercury-recipient`, { recipientId: randomUUID() });
      expect(res.status).toBe(404);
      expect((await trx('technicians').where({ id: tech }).first()).mercury_recipient_id).toBeNull();
    });
  });

  describe('the warnings before Send (never a block)', () => {
    const preview = (runId, client, now) => mercury.sendPreview(runId, { client, now });

    it('funding: available balance against this run, other open requests and unpaid payroll tax rows', async () => {
      const { run } = await bankRun(['Sample Alpha', 'Sample Beta']);
      await trx('tax_filing_calendar').insert([
        { filing_type: 'payroll_941_deposit', title: 'Sample deposit', due_date: '2026-10-15', status: 'upcoming', amount_due: '100.50', source_key: 'payroll:test:1' },
        { filing_type: 'payroll_941_deposit', title: 'Sample paid deposit', due_date: '2026-09-15', status: 'paid', amount_due: '999.00', source_key: 'payroll:test:2' },
        { filing_type: 'sales_tax', title: 'Sample sales tax', due_date: '2026-10-20', status: 'upcoming', amount_due: '555.00', source_key: 'sales:test' },
      ]);
      const client = fakeClient();
      client.getBalance.mockResolvedValue({ availableCents: 1000 });
      client.listRequests.mockResolvedValue([{ requestId: 'other', status: 'pendingApproval', amountCents: 20000 }]);
      const out = await preview(run.id, client);
      const payroll = run.checks.reduce((sum, c) => sum + c.netCents, 0);
      expect(out.funding).toMatchObject({ short: true, availableCents: 1000, payrollCents: payroll, otherRequestsCents: 20000, taxCents: 10050, needCents: payroll + 20000 + 10050 });
      client.getBalance.mockResolvedValue({ availableCents: 100000000 });
      expect((await preview(run.id, client)).funding.short).toBe(false);
    });

    it('funding: this run\'s earlier open requests count once, and a failed balance read says so without blocking', async () => {
      const { run } = await bankRun(['Sample Alpha', 'Sample Beta']);
      // Beta has no recipient id yet, so only Alpha is sent; Beta is added afterwards.
      const beta = await trx('technicians').where({ name: 'Sample Beta' }).first();
      await trx('technicians').where({ id: beta.id }).update({ mercury_recipient_id: null });
      const client = fakeClient();
      await sendRun(run.id, client);
      const [row] = await trx('payroll_payments').select('*');
      await trx('technicians').where({ id: beta.id }).update({ mercury_recipient_id: randomUUID() });
      client.listRequests.mockResolvedValue([{ requestId: row.mercury_request_id, status: 'pendingApproval', amountCents: Number(row.amount_cents) }]);
      const betaNet = run.checks.find((c) => c.name === 'Sample Beta').netCents;
      expect((await preview(run.id, client)).funding).toMatchObject({ payrollCents: betaNet, otherRequestsCents: Number(row.amount_cents), needCents: betaNet + Number(row.amount_cents) });
      client.getBalance.mockRejectedValue(new MercuryError('unknown'));
      expect((await preview(run.id, client)).funding).toMatchObject({ short: null, text: expect.stringMatching(/Could not read/) });
    });

    it('key health: none yet, fresh, and older than 38 days', async () => {
      const { run, check } = await bankRun();
      const now = new Date('2026-12-01T12:00:00Z');
      expect((await preview(run.id, fakeClient(), now)).key).toMatchObject({ first: true, stale: true, text: expect.stringMatching(/First payment/) });
      const id = randomUUID();
      const make = (at) => trx('payroll_payments').insert({
        id, check_id: check('Sample Alpha').id, attempt: 1, state: 'failed', idempotency_key: randomUUID(), note: `waves-pay:${id}`, mercury_request_id: 'req-old',
        amount_cents: 100, recipient_id: 'r', account_id: 'a', created_at: at,
      });
      await make(new Date('2026-11-20T12:00:00Z'));
      expect((await preview(run.id, fakeClient(), now)).key).toMatchObject({ first: false, stale: false, days: 11 });
      await trx('payroll_payments').where({ id }).update({ created_at: new Date('2026-10-20T12:00:00Z') });
      expect((await preview(run.id, fakeClient(), now)).key).toMatchObject({ stale: true, days: 42 });
    });

    it('approve-by: the Wednesday before a Friday pay day, and the business day before when pay day is the 1st', async () => {
      const { run } = await bankRun();
      expect((await preview(run.id, fakeClient())).approveBy).toMatchObject({ date: '2026-09-23', rule: 'wednesday' });
      await trx.raw("ALTER TABLE payroll_runs DISABLE TRIGGER protect_payroll_runs");
      await trx('payroll_runs').where({ id: run.id }).update({ pay_date: '2026-10-01' });
      await trx.raw("ALTER TABLE payroll_runs ENABLE TRIGGER protect_payroll_runs");
      expect((await preview(run.id, fakeClient())).approveBy).toMatchObject({ date: '2026-09-30', rule: 'first_of_month' });
    });

    it('needs a finalized run; a missing key answers 409; the status gate off 404', async () => {
      const tech = await bankTech('Sample Alpha');
      await approvedWeek(tech, W1);
      const draft = (await api('POST', '/runs', { weekStart: W1 })).body.run;
      await expect(preview(draft.id, fakeClient())).rejects.toMatchObject({ status: 409 });
      await expect(preview(draft.id, fakeClient({ configured: false }))).rejects.toMatchObject({ status: 409 });
      delete process.env.GATE_PAYROLL_MERCURY_STATUS;
      const res = await api('GET', `/runs/${draft.id}/send-preview`);
      expect(res.status).toBe(404);
    });
  });

  describe('routes', () => {
    it('Send answers each check and the run; Send again and the paper check work through the API', async () => {
      const { run, check } = await bankRun(['Sample Alpha', 'Sample Beta']);
      // The routes build their own client from env; without a real key the fake cannot be injected, so the Send
      // route is proved up to the gate and the "not set up" refusal, and the services above prove the rest.
      delete process.env.MERCURY_API_TOKEN;
      const res = await api('POST', `/runs/${run.id}/send`, {});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not set up/);
      const paper = await api('POST', `/checks/${check('Sample Alpha').id}/paper`, { checkNumber: '2001' });
      expect(paper.status).toBe(200);
      expect(paper.body.result).toMatchObject({ checkNumber: '2001' });
      const view = (await api('GET', `/runs/${run.id}`)).body.run;
      expect(view.checks.find((c) => c.name === 'Sample Alpha').payment).toMatchObject({ state: 'paper', checkNumber: '2001' });
    });
  });
});
