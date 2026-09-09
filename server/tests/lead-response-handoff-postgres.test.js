// Actual canonical pipeline, consent, suppression, provider adapter and audits.
// External delivery and diagnostics are doubles; a transparent loader pause
// exercises the real transaction reads at the reviewed race boundary.
const { randomUUID } = require('node:crypto');
const mockCreate = jest.fn();
const mockLookup = jest.fn();
let pauseConsent;
jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: mockCreate },
  lookups: { v2: { phoneNumbers: phone => ({ fetch: options => mockLookup(phone, options) }) } },
})));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('assigned lead SDK handoff with a two-connection pool (PostgreSQL)', () => {
  let db;
  let executeLeadTool;
  const customers = [randomUUID(), randomUUID(), randomUUID()];
  const leads = [randomUUID(), randomUUID()];
  const phones = ['+19415550120', '+19415550121'];
  const contexts = leads.map((leadId, i) => ({ leadId, customerId: customers[i], sessionId: randomUUID(), toolUseId: randomUUID() }));
  const input = { message: 'Thanks for reaching out. Our office will review your request.' };
  const originalEnv = {};
  const touchpoints = [];
  const captures = [];

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const expected = `/waves_qa_${(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const managedQa = process.env.WAVES_LOCAL_DEV === '1' && !!process.env.WAVES_WORKTREE_ID && url.pathname === expected;
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!managedQa && !ciTest) throw new Error('Use only the worktree-owned QA database or isolated CI database.');
    for (const [key, value] of Object.entries({ TWILIO_ACCOUNT_SID: 'AC_qa_handoff', TWILIO_AUTH_TOKEN: 'qa_transport_double',
      GATE_PROACTIVE_LINETYPE_LOOKUP: 'true', GATE_PUSH_CHANNEL_ROUTING: 'true', DB_POOL_MAX: '2' })) {
      originalEnv[key] = process.env[key]; process.env[key] = value;
    }
    require('../knexfile').test.acquireConnectionTimeout = 1500;
    db = require('../models/db');
    const consent = require('../services/messaging/validators/consent');
    const read = consent.loadContactState;
    jest.spyOn(consent, 'loadContactState').mockImplementation(async (...args) => {
      const state = await read(...args);
      if (args[1]?.isTransaction && pauseConsent) await pauseConsent(args[1]);
      return state;
    });
    ({ executeLeadTool } = require('../services/lead-response-tools'));
    // Observe the real detached writes so cleanup waits for their completion.
    for (const [modulePath, method, pending] of [
      ['../services/conversations', 'recordTouchpoint', touchpoints],
      ['../services/reply-training-capture', 'captureReplyExampleForMessage', captures],
    ]) {
      const service = require(modulePath); const real = service[method];
      jest.spyOn(service, method).mockImplementation((...args) => { const result = real(...args); pending.push(result); return result; });
    }
    await db('customers').insert(customers.map((id, i) => ({ id, first_name: 'QA', last_name: 'Handoff', active: true,
      email: `qa-handoff-${id}@example.invalid`, phone: phones[i] || '+19415550122', pipeline_stage: 'new_lead' })));
    await db('leads').insert(leads.map((id, i) => ({ id, customer_id: customers[i], first_name: 'QA', phone: phones[i], first_contact_at: new Date() })));
    await db('notification_prefs').insert(customers.map(customer_id => ({ customer_id, sms_enabled: true })));
    expect(db.client.pool.max).toBe(2);
  }, 30000);

  async function settleAndClear() {
    await Promise.all(touchpoints.splice(0));
    await Promise.all(captures.splice(0));
    const threads = await db('conversations').whereIn('customer_id', customers).pluck('id');
    await db('messages').whereIn('conversation_id', threads).del();
    await db('conversations').whereIn('id', threads).del();
    for (const table of ['sms_log', 'messaging_audit_log', 'customer_interactions']) await db(table).whereIn('customer_id', customers).del();
    await db('lead_activities').whereIn('lead_id', leads).del();
    await db('phone_line_types').whereIn('phone', phones).del();
    await db('messaging_suppression').whereIn('phone', phones).del();
  }

  beforeEach(async () => {
    await settleAndClear();
    pauseConsent = null;
    mockCreate.mockReset().mockImplementation(async () => ({ sid: `SM${randomUUID().replaceAll('-', '')}` }));
    mockLookup.mockReset().mockResolvedValue({ lineTypeIntelligence: { type: 'mobile' } });
    await db('customers').whereIn('id', customers).update({ deleted_at: null, pipeline_stage: 'new_lead' });
    for (let i = 0; i < leads.length; i++) {
      await db('customers').where({ id: customers[i] }).update({ phone: phones[i] });
      await db('leads').where({ id: leads[i] }).update({ customer_id: customers[i], deleted_at: null, status: 'new' });
    }
    await db('notification_prefs').whereIn('customer_id', customers).update({ sms_enabled: true });
  });

  afterAll(async () => {
    try {
      if (db) {
        await settleAndClear();
        await db('notification_prefs').whereIn('customer_id', customers).del();
        await db('leads').whereIn('id', leads).del();
        await db('customers').whereIn('id', customers).where('email', 'like', 'qa-handoff-%@example.invalid').del();
      }
    } finally {
      jest.restoreAllMocks();
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (db) await db.destroy();
    }
  }, 30000);

  test('concurrent distinct leads reach the SDK and commit real logs without pool starvation', async () => {
    let release;
    let timer;
    const bothAtProvider = new Promise((resolve, reject) => {
      release = resolve;
      timer = setTimeout(() => reject(new Error('Both sends did not reach the real provider boundary')), 5000);
    });
    // The old outer transaction pinned both connections before canonical
    // consent/provider/audit reads could acquire either one.
    mockCreate.mockImplementation(async () => {
      if (mockCreate.mock.calls.length === 2) release();
      await bothAtProvider;
      return { sid: `SM${randomUUID().replaceAll('-', '')}` };
    });
    try {
      const results = await Promise.all(contexts.map(context => executeLeadTool('send_lead_response', input, context)));
      expect(results.every(result => result.sent)).toBe(true);
      await Promise.all(touchpoints);
      expect(await db('sms_log').whereIn('customer_id', customers)).toHaveLength(2);
      const audits = await db('messaging_audit_log').whereIn('lead_id', leads);
      expect(audits).toHaveLength(2);
      expect(audits.every(row => row.provider_message_id?.startsWith('SM') && row.sent_at && !row.blocked_code)).toBe(true);
      expect(await db('messages').whereIn('twilio_sid', audits.map(row => row.provider_message_id))).toHaveLength(2);
      expect((await db('customers').whereIn('id', customers.slice(0, 2))).every(row => row.pipeline_stage === 'contacted')).toBe(true);
    } finally { clearTimeout(timer); }
  }, 15000);

  test.each(['reassign', 'archive_lead', 'archive_customer', 'change_phone'])('refuses %s during actual canonical preparation', async change => {
    mockLookup.mockImplementationOnce(async () => {
      if (change === 'reassign') await db('leads').where({ id: leads[0] }).update({ customer_id: customers[2] });
      if (change === 'archive_lead') await db('leads').where({ id: leads[0] }).update({ deleted_at: new Date() });
      if (change === 'archive_customer') await db('customers').where({ id: customers[0] }).update({ deleted_at: new Date() });
      if (change === 'change_phone') await db('customers').where({ id: customers[0] }).update({ phone: '+19415550129' });
      return { lineTypeIntelligence: { type: 'mobile' } };
    });
    expect(await executeLeadTool('send_lead_response', input, contexts[0])).toMatchObject({ sent: false, blocked: true, code: 'LEAD_SUBJECT_CHANGED' });
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    const activities = await db('lead_activities').where({ lead_id: leads[0] });
    // A changed phone still belongs to the assigned lead: record the blocked
    // attempt for triage. Reassigned/archived subjects receive no bookkeeping.
    expect(activities.map(row => row.activity_type)).toEqual(change === 'change_phone' ? ['sms_blocked'] : []);
    expect((await db('customers').where({ id: customers[0] }).first()).pipeline_stage).toBe('new_lead');
    expect((await db('leads').where({ id: leads[0] }).first()).status).toBe('new');
    expect(await db('messaging_audit_log').where({ lead_id: leads[0], blocked_code: 'LEAD_SUBJECT_CHANGED' })).toHaveLength(1);
  });

  test.each(['comms', 'customer', 'lead'].flatMap(lock => ['consent', 'suppression'].map(change => [lock, change])))(
    '%s lock wait observes a committed %s opt-out before the SDK', async (lock, change) => {
      const holder = await db.transaction();
      let attempt;
      try {
        const { rows: [{ pid }] } = await holder.raw('SELECT pg_backend_pid() AS pid');
        if (lock === 'comms') await require('../utils/customer-comms-lock').lockCustomerComms(holder, customers[0]);
        else await holder(lock === 'customer' ? 'customers' : 'leads')
          .where({ id: lock === 'customer' ? customers[0] : leads[0] }).forUpdate().first();
        let sendError;
        attempt = executeLeadTool('send_lead_response', input, contexts[0]).catch(error => { sendError = error; });
        const deadline = Date.now() + 5000;
        while (true) {
          if (sendError) throw sendError;
          const { rows } = await holder.raw('SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))', [pid]);
          if (rows.length) break;
          if (Date.now() >= deadline) throw new Error('Send did not wait on the held authority lock');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(mockLookup).toHaveBeenCalledTimes(1);
        if (change === 'consent') await holder('notification_prefs').where({ customer_id: customers[0] }).update({ sms_enabled: false });
        else await holder('messaging_suppression').insert({ phone: phones[0], reason: 'opt_out_keyword', source: 'qa_handoff', active: true });
        await holder.commit();
        const code = change === 'consent' ? 'SMS_OPTED_OUT' : 'SUPPRESSED_OPT_OUT';
        expect(await attempt).toMatchObject({ sent: false, blocked: true, code });
        expect(mockCreate).not.toHaveBeenCalled();
        expect(await db('sms_log').where({ customer_id: customers[0], direction: 'outbound' })).toHaveLength(0);
        expect((await db('lead_activities').where({ lead_id: leads[0] })).map(row => row.activity_type)).toEqual(['sms_blocked']);
        expect((await db('customers').where({ id: customers[0] }).first()).pipeline_stage).toBe('new_lead');
        expect((await db('leads').where({ id: leads[0] }).first()).status).toBe('new');
        expect(await db('messaging_audit_log').where({ lead_id: leads[0], blocked_code: code })).toHaveLength(1);
      } finally {
        if (!holder.isCompleted()) await holder.rollback();
        if (attempt) await attempt;
      }
    }, 15000,
  );

  test.each(['preferences', 'suppression'])('%s opt-out after the final consent read waits until the SDK handoff finishes', async change => {
    let ready; let resume; let held;
    const read = new Promise(resolve => { ready = resolve; });
    const release = new Promise(resolve => { resume = resolve; });
    pauseConsent = async trx => { held = trx; ready(); await release; };
    const send = executeLeadTool('send_lead_response', input, contexts[0]);
    await read;
    const handler = require('../routes/notifications').stack
      .find(layer => layer.route?.path === '/preferences' && layer.route.methods.put).route.stack[0].handle;
    let saved = false;
    const save = change === 'suppression'
      ? require('../services/messaging/validators/suppression').recordSuppression({
        phone: phones[0], reason: 'opt_out_keyword', source: 'qa',
      }).then(result => { expect(result.ok).toBe(true); saved = true; })
      : handler({ customerId: customers[0], body: { smsEnabled: false } }, {
      json: result => { expect(result.success).toBe(true); saved = true; },
      status: code => { throw new Error(`Unexpected HTTP ${code}`); },
    }, error => { throw error; });
    try {
      const deadline = Date.now() + 3000;
      while (true) {
        const { rows } = await held.raw('SELECT pid FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))');
        if (rows.length) break;
        if (Date.now() >= deadline) throw new Error('Portal opt-out did not wait on final consent authority');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(saved).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();
      mockCreate.mockImplementationOnce(async () => {
        expect(saved).toBe(false);
        return { sid: `SM${randomUUID().replaceAll('-', '')}` };
      });
    } finally {
      resume();
      const [result] = await Promise.all([send, save]);
      expect(result.sent).toBe(true);
      pauseConsent = null;
    }
    expect(saved).toBe(true);
    expect(await executeLeadTool('send_lead_response', input, contexts[0]))
      .toMatchObject({ sent: false, blocked: true, code: change === 'preferences' ? 'SMS_OPTED_OUT' : 'SUPPRESSED_OPT_OUT' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('SDK-time locks allow foreign-key audit inserts and prevent authority edits', async () => {
    mockCreate.mockImplementationOnce(async () => {
      await db('lead_activities').insert({ lead_id: leads[0], activity_type: 'qa_handoff', description: 'Synthetic FK probe' });
      await db('customer_interactions').insert({ customer_id: customers[0], interaction_type: 'note', subject: 'QA handoff', body: 'Synthetic FK probe' });
      for (const [table, id, update] of [['customers', customers[0], { phone: '+19415550129' }], ['leads', leads[0], { customer_id: customers[2] }]]) {
        await expect(db.transaction(async trx => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx(table).where({ id }).update(update);
        })).rejects.toMatchObject({ code: '55P03' });
      }
      return { sid: `SM${randomUUID().replaceAll('-', '')}` };
    });
    expect(await executeLeadTool('send_lead_response', input, contexts[0])).toMatchObject({ sent: true });
    expect(await db('messaging_audit_log').where({ lead_id: leads[0] }).whereNotNull('provider_message_id')).toHaveLength(1);
  }, 10000);

  test('real SMS opt-out blocks before the SDK and does not advance the pipeline', async () => {
    await db('notification_prefs').where({ customer_id: customers[0] }).update({ sms_enabled: false });
    expect(await executeLeadTool('send_lead_response', input, contexts[0])).toMatchObject({ sent: false, blocked: true, code: 'SMS_OPTED_OUT' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect((await db('customers').where({ id: customers[0] }).first()).pipeline_stage).toBe('new_lead');
  });
});
