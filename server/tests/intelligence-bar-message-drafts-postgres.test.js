/**
 * IB suggested replies on real Postgres (committed rows, cleaned up), the canonical sender mocked (no provider is ever called):
 * the page's own approve / revise / reject handlers run in process (approveDraftFromBar and siblings) with the card's pins.
 *  - the claim is one atomic UPDATE on (status 'pending', the carded text): two Confirms at once send ONCE
 *  - a draft edited, approved or ignored after the card is not claimed: nothing is sent
 *  - a newer inbound text after the card releases the claim (the draft is pending again) and nothing is sent
 *  - a campaign draft is refused before the campaign guard can retire it
 *  - revise sends exactly the carded text; ignore marks the draft rejected with the review verdict and sends nothing
 * Rows use intent 'click_followup': prod's BEFORE INSERT trigger (block_message_drafts_when_disabled) refuses any other
 * campaign-less pending shape unless system_config legacy_ai_drafts_enabled is true. Synthetic names and 555 numbers only.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/send-manual-customer-sms', () => ({
  sendManualCustomerSms: jest.fn(),
  manualSmsDeliveryState: (value) => value?.manualSmsInterlock?.deliveryState || null,
}));

const SKIP = !process.env.DATABASE_URL;
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const usable = !SKIP && url && (/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
  || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test')
  || (['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test' && process.env.IB_DRAFTS_LOCAL_TEST_DB === 'true'));
jest.setTimeout(30000);

const db = require('../models/db');
const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');
const drafts = require('../routes/admin-drafts');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { executeMessageDraftTool } = require('../services/intelligence-bar/message-draft-tools');

const ADMIN = { isAdmin: true, technicianId: null };
// A per-run number so no other suite's leftover inbound text from the same phone can read as "newer".
const PHONE = `+1941555${String(1000 + Math.floor(Math.random() * 9000))}`;
const LAST4 = PHONE.slice(-4);
const OFFICE = '+19415550100';
const TEXT = 'Yes, Thursday works. See you then!';

(usable ? describe : describe.skip)('IB suggested replies (real PG)', () => {
  const created = { customers: [], logs: [], drafts: [] };
  beforeAll(() => {
    process.env.GATE_IB_MESSAGE_DRAFTS = 'true';
    process.env.GATE_IB_PLATFORM = 'true';
  });
  beforeEach(() => {
    sendManualCustomerSms.mockReset();
    sendManualCustomerSms.mockResolvedValue({ sent: true, providerMessageId: 'SM_synthetic' });
  });
  // Every test shares one phone, so each test's rows go before the next test starts (a future-dated inbound text
  // from one test must not read as "newer" in the next).
  async function cleanUp() {
    if (created.drafts.length) await db('message_drafts').whereIn('id', created.drafts).del();
    if (created.logs.length) await db('sms_log').whereIn('id', created.logs).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
    created.drafts = []; created.logs = []; created.customers = [];
  }
  afterEach(cleanUp);
  afterAll(async () => {
    delete process.env.GATE_IB_MESSAGE_DRAFTS;
    delete process.env.GATE_IB_PLATFORM;
    await cleanUp();
    await db.destroy();
  });

  async function customer() {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Reply', phone: PHONE, email: `${id}@example.invalid`, property_type: 'residential' });
    created.customers.push(id);
    return id;
  }
  async function inbound(customerId, fields = {}) {
    const id = randomUUID();
    await db('sms_log').insert({ id, customer_id: customerId, direction: 'inbound', from_phone: PHONE, to_phone: OFFICE, message_body: 'Can you come Thursday?', status: 'received', ...fields });
    created.logs.push(id);
    return id;
  }
  async function draft(customerId, logId, fields = {}) {
    const id = randomUUID();
    await db('message_drafts').insert({ id, sms_log_id: logId, customer_id: customerId, inbound_message: 'Can you come Thursday?', draft_response: TEXT, intent: 'click_followup', status: 'pending', ...fields });
    created.drafts.push(id);
    return id;
  }
  const row = (id) => db('message_drafts').where({ id }).first();
  const card = (tool, id, extra = {}) => executeMessageDraftTool(tool, { draft_id: id, ...extra }, ADMIN);
  const confirm = (tool, preview, id, extra = {}) => executeMessageDraftTool(tool, { draft_id: id, ...extra, confirmed: true, _verified_draft_version: preview._version }, ADMIN);

  test('approve: the card, then one send of exactly the carded text, then the draft is approved', async () => {
    const c = await customer();
    const log = await inbound(c);
    const id = await draft(c, log);
    const preview = await card('approve_suggested_reply', id);
    expect(preview).toMatchObject({ preview: true, final_text: TEXT, recipient: `Fixture Reply (…${LAST4})` });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'pending' });
    expect(await confirm('approve_suggested_reply', preview, id)).toMatchObject({ success: true, sent_to_customer: true });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(sendManualCustomerSms.mock.calls[0][0]).toMatchObject({ to: PHONE, body: TEXT, entryPoint: 'admin_draft_approve' });
    expect(await row(id)).toMatchObject({ status: 'approved', final_response: TEXT });
    expect((await row(id)).sent_at).not.toBeNull();
  });

  test('smart punctuation and an https link: the card shows what the sender delivers, and the page claims on the raw draft', async () => {
    const SMART = 'We\u2019ll be there Thursday \u2014 \u201Cmorning\u201D. https://wavespestcontrol.com/appointments/abc';
    const delivered = (t) => normalizeGsmPunctuation(stripSmsUrlScheme(t));
    const c = await customer();
    const id = await draft(c, await inbound(c), { draft_response: SMART });
    const preview = await card('approve_suggested_reply', id);
    expect(preview.final_text).toBe(delivered(SMART));
    expect(await confirm('approve_suggested_reply', preview, id)).toMatchObject({ success: true, sent_text: delivered(SMART) });
    // The page's sender gets the raw stored draft and applies the transformation itself: same text as the card.
    const sentBody = sendManualCustomerSms.mock.calls[0][0].body;
    expect(sentBody).toBe(SMART);
    expect(delivered(sentBody)).toBe(preview.final_text);
    expect(await row(id)).toMatchObject({ status: 'approved' });
  });

  test('revise with the same transformations is carded and sent as the delivered text', async () => {
    const REV = 'Thursday at 10 \u2013 we\u2019ll see you. https://wavespestcontrol.com/pay/xyz';
    const delivered = (t) => normalizeGsmPunctuation(stripSmsUrlScheme(t));
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const preview = await card('revise_suggested_reply', id, { revised_text: REV });
    expect(await confirm('revise_suggested_reply', preview, id, { revised_text: REV })).toMatchObject({ success: true });
    expect(delivered(sendManualCustomerSms.mock.calls[0][0].body)).toBe(preview.final_text);
    expect(sendManualCustomerSms.mock.calls[0][0].body).toBe(delivered(REV));
  });

  test('a double Confirm sends once: the second is refused and nothing more goes out', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const preview = await card('approve_suggested_reply', id);
    const [first, second] = [await confirm('approve_suggested_reply', preview, id), await confirm('approve_suggested_reply', preview, id)];
    expect([first.success, second.success]).toEqual([true, undefined]);
    expect(second).toMatchObject({ preview_changed: true });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
  });

  test('two handler runs at the same instant claim the draft once (atomic claim, not a read-then-write)', async () => {
    const c = await customer();
    const log = await inbound(c);
    const id = await draft(c, log);
    const pins = { draftText: TEXT, recipientPhone: PHONE, customerId: c, latestInboundId: log };
    sendManualCustomerSms.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ sent: true, providerMessageId: 'SM_synthetic' }), 150)));
    const results = await Promise.all([
      drafts.approveDraftFromBar({ draftId: id, actor: {}, pins }),
      drafts.approveDraftFromBar({ draftId: id, actor: {}, pins }),
      drafts.approveDraftFromBar({ draftId: id, actor: {}, pins }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.json.code === 'preview_changed')).toBe(true);
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
  });

  test('a draft edited after the card is not claimed and nothing is sent', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const preview = await card('approve_suggested_reply', id);
    await db('message_drafts').where({ id }).update({ draft_response: 'A different suggestion.' });
    expect(await confirm('approve_suggested_reply', preview, id)).toMatchObject({ preview_changed: true });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'pending', draft_response: 'A different suggestion.' });
  });

  test('the page handled it first: approved or ignored after the card, nothing is sent', async () => {
    const c = await customer();
    const first = await draft(c, await inbound(c));
    const second = await draft(c, await inbound(c));
    const p1 = await card('approve_suggested_reply', first);
    const p2 = await card('ignore_suggested_reply', second);
    await db('message_drafts').where({ id: first }).update({ status: 'approved' });
    await db('message_drafts').where({ id: second }).update({ status: 'rejected' });
    expect(await confirm('approve_suggested_reply', p1, first)).toMatchObject({ preview_changed: true });
    expect(await confirm('ignore_suggested_reply', p2, second)).toMatchObject({ preview_changed: true });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a newer inbound text after the card: refused, the claim is released, nothing is sent', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const preview = await card('approve_suggested_reply', id);
    await inbound(c, { message_body: 'Actually, make it Friday.', created_at: new Date(Date.now() + 5000) });
    expect(await confirm('approve_suggested_reply', preview, id)).toMatchObject({ preview_changed: true });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: 'pending', approved_by: null });
  });

  test('the same newer text arriving while the send pipeline runs stops the send at the last await', async () => {
    const c = await customer();
    const log = await inbound(c);
    const id = await draft(c, log);
    const pins = { draftText: TEXT, recipientPhone: PHONE, customerId: c, latestInboundId: log };
    sendManualCustomerSms.mockImplementation(async ({ preDispatchCheck }) => {
      await inbound(c, { message_body: 'Hold on, change of plans.', created_at: new Date(Date.now() + 5000) });
      const verdict = await preDispatchCheck({ channel: 'sms' });
      return verdict.ok ? { sent: true } : { sent: false, blocked: true, code: verdict.code, reason: verdict.reason };
    });
    const out = await drafts.approveDraftFromBar({ draftId: id, actor: {}, pins });
    expect(out.status).toBe(422);
    expect(out.json.code).toBe('preview_changed');
    expect(await row(id)).toMatchObject({ status: 'pending', approved_by: null });
  });

  test.each([['approve', 'approveDraftFromBar', undefined], ['revise', 'reviseDraftFromBar', { revisedResponse: 'Thursday at 10 works.' }]])(
    '%s: a text landing AFTER preDispatchCheck but BEFORE dispatch is stopped at the provider boundary, nothing sent, claim released', async (_n, fn, body) => {
      const c = await customer();
      const log = await inbound(c);
      const id = await draft(c, log);
      const pins = { draftText: TEXT, recipientPhone: PHONE, customerId: c, latestInboundId: log };
      let atDispatch;
      sendManualCustomerSms.mockImplementation(async (input) => {
        // The sender's order: preDispatchCheck passes, provider preparation runs, THEN the customer texts, THEN the boundary.
        expect(await input.preDispatchCheck({ channel: 'sms' })).toEqual({ ok: true });
        await inbound(c, { message_body: 'Never mind, Friday.', created_at: new Date(Date.now() + 5000) });
        atDispatch = await input.preProviderCheck({ channel: 'sms' });
        return atDispatch.ok ? { sent: true, providerMessageId: 'SM_synthetic' }
          : { sent: false, blocked: true, code: atDispatch.code, reason: atDispatch.reason };
      });
      const out = await drafts[fn]({ draftId: id, actor: {}, pins, body });
      expect(atDispatch).toMatchObject({ ok: false, code: 'preview_changed' });
      expect(out.status).toBe(422);
      expect(out.json.code).toBe('preview_changed');
      expect(await row(id)).toMatchObject({ status: 'pending', approved_by: null, sent_at: null });
    });

  test('a campaign draft is refused before the campaign guard can retire it', async () => {
    const c = await customer();
    const id = await draft(c, null, { campaign_type: 'upsell', purpose: 'marketing', source_ref: 'upsell_opportunities:none' });
    expect(await card('approve_suggested_reply', id)).toMatchObject({ code: 'needs_communications_page' });
    const out = await drafts.approveDraftFromBar({ draftId: id, actor: {}, pins: { draftText: TEXT, recipientPhone: PHONE, customerId: c, latestInboundId: null } });
    expect(out).toMatchObject({ status: 409, json: { code: 'needs_communications_page' } });
    expect(await row(id)).toMatchObject({ status: 'pending' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('revise sends exactly the carded text and records the edit', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const preview = await card('revise_suggested_reply', id, { revised_text: 'Thursday at 10 works.' });
    expect(await confirm('revise_suggested_reply', preview, id, { revised_text: 'Thursday at 10 works.' })).toMatchObject({ success: true, sent_text: 'Thursday at 10 works.' });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(sendManualCustomerSms.mock.calls[0][0]).toMatchObject({ body: 'Thursday at 10 works.', entryPoint: 'admin_draft_revise' });
    expect(await row(id)).toMatchObject({ status: 'revised', revised_response: 'Thursday at 10 works.', final_response: 'Thursday at 10 works.' });
  });

  test('ignore marks the draft rejected with the review verdict, sends nothing, and a second ignore is refused', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c), { flags: JSON.stringify({}) });
    const preview = await card('ignore_suggested_reply', id);
    expect(await confirm('ignore_suggested_reply', preview, id)).toMatchObject({ success: true, sent_to_customer: false });
    const after = await row(id);
    expect(after).toMatchObject({ status: 'rejected' });
    expect(after.flags).toMatchObject({ review_verdict: 'rejected' });
    expect(await confirm('ignore_suggested_reply', preview, id)).toMatchObject({ preview_changed: true });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a blocked send leaves the draft pending (the page releases the claim)', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const preview = await card('approve_suggested_reply', id);
    sendManualCustomerSms.mockResolvedValue({ sent: false, blocked: true, code: 'OPTED_OUT', reason: 'Customer opted out' });
    expect(await confirm('approve_suggested_reply', preview, id)).toMatchObject({ success: false, blocked: true, code: 'OPTED_OUT' });
    expect(await row(id)).toMatchObject({ status: 'pending', approved_by: null });
  });

  test('the list shows the waiting reply with a masked number', async () => {
    const c = await customer();
    const id = await draft(c, await inbound(c));
    const out = await executeMessageDraftTool('list_suggested_replies', { limit: 25 }, ADMIN);
    const mine = out.suggested_replies.find((r) => r.draft_id === id);
    expect(mine).toMatchObject({ customer: 'Fixture Reply', sends_to: `…${LAST4}`, suggested_reply: TEXT });
    expect(JSON.stringify(out)).not.toContain(PHONE.slice(2));
  });
});
