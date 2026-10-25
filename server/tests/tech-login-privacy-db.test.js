/**
 * GATE_TECH_LOGIN_PRIVACY against live Postgres (owner 2026-10-25, second
 * technician): the SQL half. The non-admin bell lists, counts and marks read
 * a customer's alert only for a customer on the technician's route (M4), and
 * the Promises feeds and PATCH hold only own-customer rows (M5). Every row
 * these tests insert is deleted afterwards. The mocked half (who is pushed,
 * the 404 wiring, the account-deleted push) is tech-login-privacy.test.js.
 */
const { randomUUID } = require('crypto');

// Read when the gate map loads, so it is set before any require.
process.env.GATE_CALL_COMMITMENTS = 'true';
process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

jest.mock('../config', () => ({ jwt: { secret: 'test-jwt-secret' }, twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technicianId = global.__privacyActor.id;
      req.techRole = global.__privacyActor.role;
      next();
    },
  };
});

afterAll(async () => {
  delete process.env.GATE_CALL_COMMITMENTS;
  delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
  delete process.env.GATE_TECH_LOGIN_PRIVACY;
  if (!SKIP) await require('../models/db').destroy();
});

maybeDescribe('technician login privacy (live Postgres)', () => {
  let db;
  let NotificationService;
  let express;
  let router;
  const RUN = `techpriv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ids = { techA: randomUUID(), techB: randomUUID(), admin: randomUUID() };
  const customer = { a: randomUUID(), b: randomUUID(), orphan: null };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const made = { notifications: [], calls: [], commitments: [], triage: [], visits: [], customers: [], staff: [] };

  const as = (id, role) => { global.__privacyActor = { id, role }; };

  beforeAll(async () => {
    db = require('../models/db');
    NotificationService = require('../services/notification-service');
    express = require('express');
    router = require('../routes/admin-call-recordings');

    await db('technicians').insert([
      { id: ids.techA, name: `${RUN} Tech A`, role: 'technician', active: true },
      { id: ids.techB, name: `${RUN} Tech B`, role: 'technician', active: true },
      { id: ids.admin, name: `${RUN} Admin`, role: 'admin', active: true },
    ]);
    made.staff.push(ids.techA, ids.techB, ids.admin);
    await db('customers').insert([
      { id: customer.a, first_name: `${RUN}A`, last_name: 'Example', phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}` },
      { id: customer.b, first_name: `${RUN}B`, last_name: 'Example', phone: `+1941556${String(Math.floor(Math.random() * 9000) + 1000)}` },
    ]);
    made.customers.push(customer.a, customer.b);
    // Tech A services customer A; tech B services customer B.
    const visits = await db('scheduled_services').insert([
      { customer_id: customer.a, technician_id: ids.techA, scheduled_date: today, service_type: 'Pest Control', status: 'confirmed' },
      { customer_id: customer.b, technician_id: ids.techB, scheduled_date: today, service_type: 'Pest Control', status: 'confirmed' },
    ]).returning('id');
    made.visits.push(...visits.map((v) => v.id || v));
  });

  afterAll(async () => {
    if (!db) return;
    await db('call_commitments').whereIn('id', made.commitments).del();
    await db('triage_items').whereIn('id', made.triage).del();
    await db('call_log').whereIn('id', made.calls).del();
    await db('notifications').whereIn('id', made.notifications).del();
    await db('scheduled_services').whereIn('id', made.visits).del();
    await db('customers').whereIn('id', made.customers).del();
    await db('technicians').whereIn('id', made.staff).del();
  });

  describe('M4: the non-admin bell', () => {
    const rows = {};
    const bell = async (name, triggerKey, meta) => {
      const [row] = await db('notifications').insert({
        recipient_type: 'admin', category: 'alert', title: `${RUN} ${name}`, body: 'Fixture body', link: '/admin/communications',
        metadata: JSON.stringify({ triggerKey, ...meta }),
      }).returning('id');
      rows[name] = row.id || row;
      made.notifications.push(rows[name]);
    };
    const titles = async (opts) => (await NotificationService.getAdminNotifications(200, 0, opts))
      .filter((r) => String(r.title).startsWith(RUN)).map((r) => r.title.slice(RUN.length + 1)).sort();

    beforeAll(async () => {
      // A trigger row keeps the customer in metadata.payload; a row written straight through notifyAdmin keeps it in metadata.
      await bell('sms-own', 'sms_reply', { payload: { threadId: customer.a } });
      await bell('sms-other', 'sms_reply', { payload: { threadId: customer.b } });
      await bell('reschedule-own', 'appointment_reschedule_intent', { payload: { customerId: customer.a } });
      await bell('reschedule-other', 'appointment_reschedule_intent', { payload: { customerId: customer.b } });
      await bell('followup-own', 'sms_operational_followup', { customerId: customer.a });
      await bell('followup-other', 'sms_operational_followup', { customerId: customer.b });
      await bell('promise-other', 'call_commitment_overdue', { customer_id: customer.b });
      await bell('report-other', 'service_report_pdf_failed', { payload: { scopeCustomerId: customer.b } });
      await bell('sms-unknown-sender', 'sms_reply', { payload: { threadId: null, twilioSid: 'SM-fixture' } });
      await bell('sandy-no-context', 'sandy_transfer_no_context', { callSid: 'CA-fixture' });
      await bell('payment-admin-only', 'payment_failed', { payload: { customerId: customer.b } });
    });

    test('gate on: a technician sees own-customer rows and customer-less rows, not another technician\'s customer', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      expect(await titles({ role: 'technician', technicianId: ids.techA })).toEqual([
        'followup-own', 'reschedule-own', 'sandy-no-context', 'sms-own', 'sms-unknown-sender',
      ]);
      expect(await titles({ role: 'technician', technicianId: ids.techB })).toEqual([
        'followup-other', 'promise-other', 'reschedule-other', 'sandy-no-context', 'sms-other', 'sms-unknown-sender', 'report-other',
      ].sort());
    });

    test('gate on: an admin sees every row', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      expect((await titles({ role: 'admin', technicianId: ids.admin })).length).toBe(Object.keys(rows).length);
    });

    test('gate off: a technician sees every tech-visible row, as before', async () => {
      delete process.env.GATE_TECH_LOGIN_PRIVACY;
      const seen = await titles({ role: 'technician', technicianId: ids.techA });
      expect(seen).toEqual(expect.arrayContaining(['sms-other', 'reschedule-other', 'followup-other', 'promise-other', 'report-other']));
      expect(seen).not.toContain('payment-admin-only');
    });

    test('gate on: the unread count, mark-read and mark-done follow the same scope', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      const tech = { role: 'technician', technicianId: ids.techA };
      const total = (opts) => NotificationService.getAdminUnreadCount(opts);
      const before = await total(tech);
      const all = await total({ role: 'technician' }); // no technicianId: key-only scope
      expect(all).toBeGreaterThan(before);
      expect(await NotificationService.markReadAdmin(rows['sms-other'], tech)).toBe(false);
      expect(await NotificationService.markReadAdmin(rows['sms-own'], tech)).toBe(true);
      expect(await NotificationService.markAdminDone([rows['reschedule-other']], { by: ids.techA, ...tech })).toBe(0);
      expect(await NotificationService.markAdminDone([rows['reschedule-own']], { by: ids.techA, ...tech })).toBe(1);
      expect(await NotificationService.getAdminNotificationState(rows['sms-other'], tech)).toBeNull();
      const state = await NotificationService.getAdminNotificationState(rows['reschedule-own'], tech);
      expect(state).toMatchObject({ done: true });
    });
  });

  describe('M5: the Promises tab', () => {
    const ctx = {};
    function withServer(fn) {
      const app = express();
      app.use(express.json());
      app.use('/calls', router);
      app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
      const server = app.listen(0);
      const base = `http://127.0.0.1:${server.address().port}`;
      return fn(base).finally(() => new Promise((r) => server.close(r)));
    }
    const req = (base, method, route, body) => fetch(`${base}/calls${route}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });

    beforeAll(async () => {
      const mkCall = async (customerId) => {
        const [call] = await db('call_log').insert({ customer_id: customerId, direction: 'inbound', from_phone: '+19415550142', to_phone: '+19415550143' }).returning('id');
        made.calls.push(call.id || call);
        return call.id || call;
      };
      const mkPromise = async (callId, key, over = {}) => {
        const [row] = await db('call_commitments').insert({
          call_log_id: callId, commitment_key: `${RUN}:${key}`, party: 'waves', kind: 'send_estimate', description: `${RUN} ${key}`, status: 'open', ...over,
        }).returning('id');
        made.commitments.push(row.id || row);
        return row.id || row;
      };
      const mkProposal = async (callId) => {
        const [row] = await db('triage_items').insert({
          category: 'reschedule', reason_code: 'reschedule_proposal', status: 'open', call_log_id: callId,
          payload: JSON.stringify({ reschedule_proposal: { proposed_start_at: '2030-01-07T15:00:00-05:00' } }),
        }).returning('id');
        made.triage.push(row.id || row);
        return row.id || row;
      };
      ctx.callA = await mkCall(customer.a);
      ctx.callB = await mkCall(customer.b);
      ctx.callNone = await mkCall(null);
      // Closed rows sit on calls of their own: an open read re-checks the proof of the calls it lists.
      ctx.callClosedA = await mkCall(customer.a);
      ctx.callClosedB = await mkCall(customer.b);
      ctx.promiseA = await mkPromise(ctx.callA, 'own');
      ctx.promiseB = await mkPromise(ctx.callB, 'other');
      ctx.promiseNone = await mkPromise(ctx.callNone, 'no-customer');
      const closed = JSON.stringify({ closed_by: 'promise_evidence', closed_at: new Date().toISOString() });
      ctx.closedA = await mkPromise(ctx.callClosedA, 'closed-own', { status: 'fulfilled', fulfillment: closed });
      ctx.closedB = await mkPromise(ctx.callClosedB, 'closed-other', { status: 'fulfilled', fulfillment: closed });
      ctx.proposalA = await mkProposal(ctx.callA);
      ctx.proposalB = await mkProposal(ctx.callB);
    });

    const mine = (list) => list.filter((r) => String(r.description || '').startsWith(RUN)).map((r) => r.description.slice(RUN.length + 1)).sort();

    test('gate on: a technician\'s open and auto-closed feeds hold only own-customer rows; an admin sees all', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      await withServer(async (base) => {
        const closedFor = async (id, role) => { as(id, role); return mine((await (await req(base, 'GET', '/commitments/auto-closed')).json()).commitments); };
        const openFor = async (id, role) => { as(id, role); return mine((await (await req(base, 'GET', '/commitments/open?limit=200')).json()).commitments); };
        expect(await closedFor(ids.techA, 'technician')).toEqual(['closed-own']);
        expect(await closedFor(ids.techB, 'technician')).toEqual(['closed-other']);
        expect(await closedFor(ids.admin, 'admin')).toEqual(['closed-other', 'closed-own']);

        expect(await openFor(ids.techA, 'technician')).toEqual(['own']);
        expect(await openFor(ids.techB, 'technician')).toEqual(['other']);
        // A customer_id filter for someone else's customer finds nothing.
        as(ids.techB, 'technician');
        expect((await (await req(base, 'GET', `/commitments/open?customer_id=${customer.a}`)).json()).commitments).toEqual([]);
        expect(await openFor(ids.admin, 'admin')).toEqual(expect.arrayContaining(['no-customer', 'other', 'own']));
      });
    });

    test('gate on: the proposals feed lists only the technician\'s own customers', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      await withServer(async (base) => {
        const idsFor = async () => (await (await req(base, 'GET', '/proposals')).json()).proposals
          .map((p) => p.id).filter((id) => [ctx.proposalA, ctx.proposalB].includes(id));
        as(ids.techA, 'technician');
        expect(await idsFor()).toEqual([ctx.proposalA]);
        as(ids.techB, 'technician');
        expect(await idsFor()).toEqual([ctx.proposalB]);
        as(ids.admin, 'admin');
        expect((await idsFor()).sort()).toEqual([ctx.proposalA, ctx.proposalB].sort());
      });
    });

    test('gate on: PATCH on another technician\'s promise is 404 with no write; on an own promise it works', async () => {
      process.env.GATE_TECH_LOGIN_PRIVACY = 'true';
      await withServer(async (base) => {
        as(ids.techA, 'technician');
        const refused = await req(base, 'PATCH', `/commitments/${ctx.promiseB}`, { action: 'dismiss' });
        expect(refused.status).toBe(404);
        const none = await req(base, 'PATCH', `/commitments/${ctx.promiseNone}`, { action: 'dismiss' });
        expect(none.status).toBe(404);
        const untouched = await db('call_commitments').whereIn('id', [ctx.promiseB, ctx.promiseNone]).select('status', 'human_state');
        expect(untouched.map((r) => [r.status, r.human_state])).toEqual([['open', null], ['open', null]]);

        const ok = await req(base, 'PATCH', `/commitments/${ctx.promiseA}`, { action: 'dismiss' });
        expect(ok.status).toBe(200);
        expect((await db('call_commitments').where({ id: ctx.promiseA }).first('human_state')).human_state).toBe('dismissed');
      });
    });

    test('gate off: a technician still sees and changes any customer\'s promise, as before', async () => {
      delete process.env.GATE_TECH_LOGIN_PRIVACY;
      await withServer(async (base) => {
        as(ids.techA, 'technician');
        const open = await (await req(base, 'GET', '/commitments/open?limit=200')).json();
        expect(mine(open.commitments)).toEqual(expect.arrayContaining(['other', 'no-customer']));
        expect((await req(base, 'PATCH', `/commitments/${ctx.promiseB}`, { action: 'dismiss' })).status).toBe(200);
      });
    });
  });
});
