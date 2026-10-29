/**
 * IB Agent Review drafts on real Postgres (committed rows, cleaned up), the canonical sender (sendCustomerMessage) mocked, so no
 * provider is ever called: the composer's own POST /sms handler runs in process (sendSmsFromBar) with the Use Draft body.
 *  - the handler's claim holds the carded draft: two Confirms at once send ONCE, the loser is refused
 *  - accepted / corrected are recorded by the composer's own settlement; the thread's other waiting drafts end ignored
 *  - a draft edited, retired or handled after the card is not claimed: nothing is sent
 *  - a customer text landing after the card, or between the sender's checks and the provider boundary, stops the send and reopens the draft
 *  - ignore records ignored (and returns the draft to the judge pool) and sends nothing; a second ignore is refused
 * Synthetic names and 555 numbers only.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const usable = !SKIP && url && (/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
  || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test'));
jest.setTimeout(30000);

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { executeAgentReviewTool } = require('../services/intelligence-bar/agent-review-tools');

const ADMIN = { isAdmin: true, technicianId: null };
// A per-run number so no other suite's leftover inbound text from the same phone can read as "newer".
const PHONE = `+1941555${String(1000 + Math.floor(Math.random() * 9000))}`;
const LAST4 = PHONE.slice(-4);
const OFFICE = '+19415550100';
const TEXT = 'Yes, Thursday works. See you then!';

(usable ? describe : describe.skip)('IB Agent Review drafts (real PG)', () => {
  const created = { customers: [], logs: [], decisions: [] };
  let providerHook = null;

  beforeAll(() => {
    process.env.GATE_IB_AGENT_REVIEW_DRAFTS = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
    // The composer route is a large module: load it before the first test's clock starts.
    require('../routes/admin-communications');
  }, 90000);
  beforeEach(() => {
    providerHook = null;
    sendCustomerMessage.mockReset();
    // The sender's order: preDispatchCheck (not given here), then the provider boundary check, then the provider.
    sendCustomerMessage.mockImplementation(async (input) => {
      if (providerHook) await providerHook(input);
      if (typeof input.providerPreSendCheck === 'function') {
        const verdict = await input.providerPreSendCheck({ channel: 'sms', dbi: db });
        if (!verdict || verdict.ok !== true) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: verdict?.code || 'PRE_SEND_CHECK_FAILED', reason: verdict?.reason };
      }
      return { sent: true, providerMessageId: `SM_${randomUUID().slice(0, 8)}`, deliveryOutcome: 'accepted' };
    });
  });
  async function cleanUp() {
    if (created.decisions.length) await db('agent_decisions').whereIn('id', created.decisions).del();
    if (created.logs.length) {
      await db('sms_log').whereIn('id', created.logs).del();
      await db('sms_log').where({ to_phone: PHONE, direction: 'outbound' }).del();
    }
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
    created.customers = []; created.logs = []; created.decisions = [];
  }
  afterEach(cleanUp);
  afterAll(async () => {
    delete process.env.GATE_IB_AGENT_REVIEW_DRAFTS;
    delete process.env.GATE_IB_PLATFORM;
    await cleanUp();
    await db.destroy();
  });

  async function customer() {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Review', phone: PHONE, email: `${id}@example.invalid`, property_type: 'residential' });
    created.customers.push(id);
    return id;
  }
  async function inbound(customerId, fields = {}) {
    const id = randomUUID();
    await db('sms_log').insert({ id, customer_id: customerId, direction: 'inbound', from_phone: PHONE, to_phone: OFFICE, message_body: 'Can you come Thursday?', status: 'received', ...fields });
    created.logs.push(id);
    return id;
  }
  async function decision(customerId, logId, fields = {}) {
    const id = randomUUID();
    await db('agent_decisions').insert({
      id, workflow: 'sms_house_voice_suggest', agent_name: 'fixture', decision_version: 'v1', status: 'pending_review', source_channel: 'sms',
      customer_id: customerId, sms_log_id: logId, suggested_message: TEXT, input_snapshot: JSON.stringify({ sms: { body: 'Can you come Thursday?' }, comms_lint: [], intended_actions: [] }),
      ...fields,
    });
    created.decisions.push(id);
    return id;
  }
  const row = (id) => db('agent_decisions').where({ id }).first();
  const card = (tool, id, extra = {}) => executeAgentReviewTool(tool, { decision_id: id, ...extra }, ADMIN);
  const confirm = (tool, preview, id, extra = {}) => executeAgentReviewTool(tool, { decision_id: id, ...extra, confirmed: true, _verified_agent_review_version: preview._version }, ADMIN);

  test('approve: the card, then one send of exactly the carded text, recorded accepted', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('approve_agent_review_draft', id);
    expect(preview).toMatchObject({ preview: true, final_text: TEXT, recipient: `Fixture Review (…${LAST4})` });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'pending_review' });
    expect(await confirm('approve_agent_review_draft', preview, id)).toMatchObject({ success: true, sent_to_customer: true, sent_text: TEXT });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ to: PHONE, body: TEXT, entryPoint: 'admin_communications_manual_sms', customerId: c });
    expect(await row(id)).toMatchObject({ status: 'accepted', human_verdict: 'accepted' });
  });

  test('revise: sends exactly the carded text and the composer records corrected', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('revise_agent_review_draft', id, { revised_text: 'Thursday at 10 works.' });
    expect(await confirm('revise_agent_review_draft', preview, id, { revised_text: 'Thursday at 10 works.' })).toMatchObject({ success: true, sent_text: 'Thursday at 10 works.' });
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ body: 'Thursday at 10 works.' });
    expect(await row(id)).toMatchObject({ status: 'corrected', human_verdict: 'corrected' });
  });

  test('a double Confirm sends once: the second is refused and nothing more goes out', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('approve_agent_review_draft', id);
    const first = await confirm('approve_agent_review_draft', preview, id);
    const second = await confirm('approve_agent_review_draft', preview, id);
    expect(first.success).toBe(true);
    expect(second).toMatchObject({ preview_changed: true });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('two Confirms at the same instant claim the draft once', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('approve_agent_review_draft', id);
    providerHook = () => new Promise((resolve) => setTimeout(resolve, 200));
    const results = await Promise.all([1, 2, 3].map(() => confirm('approve_agent_review_draft', preview, id)));
    expect(results.filter((r) => r.success === true)).toHaveLength(1);
    expect(results.filter((r) => r.success !== true).every((r) => r.failed === true || r.preview_changed === true || r.outcome_unknown === true)).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a draft edited after the card is not claimed and nothing is sent', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('approve_agent_review_draft', id);
    await db('agent_decisions').where({ id }).update({ suggested_message: 'A different draft.' });
    expect(await confirm('approve_agent_review_draft', preview, id)).toMatchObject({ preview_changed: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'pending_review' });
  });

  test('handled or retired after the card: nothing is sent', async () => {
    const c = await customer();
    const first = await decision(c, await inbound(c));
    const second = await decision(c, await inbound(c));
    const p1 = await card('approve_agent_review_draft', first);
    const p2 = await card('ignore_agent_review_draft', second);
    await db('agent_decisions').where({ id: first }).update({ status: 'accepted' });
    await db('agent_decisions').where({ id: second }).update({ status: 'superseded' });
    expect(await confirm('approve_agent_review_draft', p1, first)).toMatchObject({ preview_changed: true });
    expect(await confirm('ignore_agent_review_draft', p2, second)).toMatchObject({ preview_changed: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a customer text after the card: refused, nothing sent, the draft is retired by the composer\'s own staleness rule', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('approve_agent_review_draft', id);
    await inbound(c, { message_body: 'Actually, make it Friday.', created_at: new Date(Date.now() + 5000) });
    expect(await confirm('approve_agent_review_draft', preview, id)).toMatchObject({ preview_changed: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a customer text between the sender\'s checks and the provider boundary: stopped at the boundary, nothing sent, the draft reopened', async () => {
    const c = await customer();
    const log = await inbound(c);
    const id = await decision(c, log);
    const preview = await card('approve_agent_review_draft', id);
    // The text lands after every pre-send check passed (the sender is mid-flight), before the boundary callback runs.
    providerHook = async () => { await inbound(c, { message_body: 'Never mind, Friday.', created_at: new Date(Date.now() + 5000), message_type: 'manual_reply_test' }); };
    const out = await confirm('approve_agent_review_draft', preview, id);
    expect(out).toMatchObject({ failed: true, code: 'preview_changed', preview_changed: true });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.results[0].value).resolves.toMatchObject({ sent: false });
    expect(await row(id)).toMatchObject({ status: 'pending_review' });
  });

  test('a blocked send reopens the draft', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('approve_agent_review_draft', id);
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'OPTED_OUT', reason: 'Customer opted out' });
    expect(await confirm('approve_agent_review_draft', preview, id)).toMatchObject({ success: false, blocked: true, code: 'OPTED_OUT' });
    expect(await row(id)).toMatchObject({ status: 'pending_review' });
  });

  test('the thread\'s other waiting drafts end ignored when the reply goes out (the composer\'s own sweep)', async () => {
    const c = await customer();
    const log = await inbound(c);
    const id = await decision(c, log);
    const other = await decision(c, log);
    const preview = await card('approve_agent_review_draft', id);
    expect((await confirm('approve_agent_review_draft', preview, id)).success).toBe(true);
    expect(await row(other)).toMatchObject({ status: 'ignored', human_verdict: 'ignored' });
  });

  test('ignore records ignored, sends nothing, and a second ignore is refused', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const preview = await card('ignore_agent_review_draft', id);
    expect(await confirm('ignore_agent_review_draft', preview, id)).toMatchObject({ success: true, sent_to_customer: false });
    expect(await row(id)).toMatchObject({ status: 'ignored', human_verdict: 'ignored' });
    expect(await confirm('ignore_agent_review_draft', preview, id)).toMatchObject({ preview_changed: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the list shows the waiting draft with a masked number', async () => {
    const c = await customer();
    const id = await decision(c, await inbound(c));
    const out = await executeAgentReviewTool('list_agent_review_drafts', { limit: 25 }, ADMIN);
    expect(out.agent_review_drafts.find((r) => r.decision_id === id)).toMatchObject({ customer: 'Fixture Review', sends_to: `…${LAST4}`, suggested_reply: TEXT });
    expect(JSON.stringify(out)).not.toContain(PHONE.slice(2));
  });
});
