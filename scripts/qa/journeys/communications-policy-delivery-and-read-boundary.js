'use strict';
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

module.exports = {
  name: 'communications-policy-delivery-and-read-boundary',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const headers = { Authorization: `Bearer ${ctx.adminToken}` };
    await db('notification_prefs').insert({ customer_id: fixture.customerId, sms_enabled: true }).onConflict('customer_id').merge({ sms_enabled: true });
    const outbound = await json(await page.request.post(`${baseUrl}/api/admin/communications/sms`, { headers,
      data: { customerId: fixture.customerId, to: fixture.phone, body: 'QA connected messaging check', messageType: 'manual' } }));
    assert.equal(outbound.sent, true, JSON.stringify(outbound));
    const legacy = await db('sms_log').where({ customer_id: fixture.customerId, message_body: 'QA connected messaging check', direction: 'outbound' }).first();
    assert.ok(legacy?.twilio_sid);
    assert.equal(legacy.admin_user_id, fixture.adminId);
    let unified;
    // The canonical sender deliberately dual-writes asynchronously. Await
    // the observable handoff before delivering its carrier callback.
    for (let attempt = 0; attempt < 50; attempt++) {
      unified = await db('messages').where({ twilio_sid: legacy.twilio_sid }).first();
      if (unified) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(unified, 'Accepted SMS must reach the unified inbox');
    assert.equal(unified.admin_user_id, fixture.adminId);
    const callbackUrl = `${baseUrl}/api/webhooks/twilio/status`;
    const form = { MessageSid: legacy.twilio_sid, MessageStatus: 'delivered' };
    assert.equal((await page.request.post(callbackUrl, { form })).status(), 403);
    const signature = require('twilio').getExpectedTwilioSignature('qa-fixture-auth-token', callbackUrl, form);
    for (let retry = 0; retry < 2; retry++) assert.equal((await page.request.post(callbackUrl, { headers: { 'X-Twilio-Signature': signature }, form })).status(), 200);
    assert.equal((await db('sms_log').where({ id: legacy.id }).first()).status, 'delivered');
    assert.equal((await db('messages').where({ id: unified.id }).first()).delivery_status, 'delivered');
    assert.equal((await db('messages').where({ twilio_sid: legacy.twilio_sid })).length, 1);
    // Keep the synthetic read-boundary messages after the accepted manual
    // send above. Unread semantics did not care about this ordering, but a
    // real human reply correctly resolves any earlier customer question.
    const acceptedAt = Math.max(new Date(unified.created_at).getTime(), new Date(legacy.created_at).getTime());
    const boundary = new Date(acceptedAt + 1000);
    const inbound = [crypto.randomUUID(), crypto.randomUUID()];
    const sids = inbound.map(id => `SM${id.replaceAll('-', '')}`);
    const inboundBody = 'Can you confirm the QA visit time?';
    for (let index = 0; index < 2; index++) {
      const created = new Date(boundary.getTime() + (index ? 500 : -500));
      await db('messages').insert({ id: inbound[index], conversation_id: unified.conversation_id, channel: 'sms', direction: 'inbound', author_type: 'customer',
        body: inboundBody, twilio_sid: sids[index], is_read: false, created_at: created });
      await db('sms_log').insert({ customer_id: fixture.customerId, direction: 'inbound', from_phone: fixture.phone, to_phone: legacy.from_phone,
        message_body: inboundBody, twilio_sid: sids[index], is_read: false, created_at: created });
    }
    const read = await json(await page.request.post(`${baseUrl}/api/admin/communications/messages/read`, { headers,
      data: { conversationIds: [unified.conversation_id], readBefore: boundary.toISOString() } }));
    assert.equal(read.updated, 1);
    assert.equal((await db('messages').where({ id: inbound[0] }).first()).read_by_admin_user_id, fixture.adminId);
    assert.equal((await db('messages').where({ id: inbound[1] }).first()).is_read, false);
    assert.equal((await db('sms_log').where({ twilio_sid: sids[0] }).first()).is_read, true);
    assert.equal((await db('sms_log').where({ twilio_sid: sids[1] }).first()).is_read, false);
    const count = await json(await page.request.get(`${baseUrl}/api/admin/communications/unread-count?customerId=${fixture.customerId}`, { headers }));
    assert.deepEqual(count, { conversations: 1, messages: 1 });
    const pendingLog = async () => json(await page.request.get(`${baseUrl}/api/admin/communications/log?customerId=${fixture.customerId}&needsResponse=true`, { headers }));
    const pendingBeforeRead = await pendingLog();
    assert.deepEqual(pendingBeforeRead.messages.filter(message => message.responseNeedsResponse).map(message => message.id), [inbound[1]]);
    await json(await page.request.post(`${baseUrl}/api/admin/communications/messages/read`, { headers, data: { messageIds: [inbound[1]] } }));
    // Owner 2026-11-19 (option A): the red Messages count is unread texts that need a reply,
    // so a read text leaves the count, while the Unanswered list still holds it.
    assert.deepEqual(await json(await page.request.get(`${baseUrl}/api/admin/communications/unread-count?customerId=${fixture.customerId}`, { headers })), { conversations: 0, messages: 0 });
    assert.deepEqual((await pendingLog()).messages.filter(message => message.responseNeedsResponse).map(message => message.id), [inbound[1]]);
    await db('messages').insert({ id: crypto.randomUUID(), conversation_id: unified.conversation_id, channel: 'sms', direction: 'outbound', author_type: 'admin',
      body: 'Yes, the QA visit time is confirmed.', message_type: 'manual', delivery_status: 'delivered', created_at: new Date(boundary.getTime() + 1500) });
    assert.deepEqual(await json(await page.request.get(`${baseUrl}/api/admin/communications/unread-count?customerId=${fixture.customerId}`, { headers })), { conversations: 0, messages: 0 });
    assert.deepEqual((await pendingLog()).messages, []);
    const laterQuestion = crypto.randomUUID();
    await db('messages').insert({ id: laterQuestion, conversation_id: unified.conversation_id, channel: 'sms', direction: 'inbound', author_type: 'customer',
      body: 'Can you also confirm the QA arrival window?', is_read: false, created_at: new Date(boundary.getTime() + 2000) });
    assert.deepEqual(await json(await page.request.get(`${baseUrl}/api/admin/communications/unread-count?customerId=${fixture.customerId}`, { headers })), { conversations: 1, messages: 1 });
    assert.deepEqual((await pendingLog()).messages.filter(message => message.responseNeedsResponse).map(message => message.id), [laterQuestion]);
    return { providerTransportSimulated: true, signedCallbackStatus: 200, unsignedCallbackStatus: 403,
      legacyAndUnifiedDelivered: true, callbackRetryRows: 1, authorAttributed: true, readBoundaryPreserved: true,
      readClearsBadge: true, readDoesNotClearNeedResponse: true, humanReplyClearsNeedResponse: true, laterQuestionRestoresNeedResponse: true };
  },
};
