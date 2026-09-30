/**
 * Every admin alert opens the record it is about. The bell navigates to the
 * row's stored `link` (and web/native push send the same string as `url`), so
 * for each class fixed here the link must carry the record id in the param the
 * destination page reads, and fall back to the page itself when the payload
 * has no id:
 *   - Communications reads ?thread=<customerId> (CommunicationsPageV2, known
 *     sender), ?message=<Twilio MessageSid> (unknown sender; resolved by GET
 *     /admin/communications/log?twilioSid=) and #tab=calls&call=<call_log id>
 *     (CallLogTabV2).
 *   - Leads reads ?lead=<id> (LeadsTabs).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn() }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn() }));

const { TRIGGER_REGISTRY } = require('../services/notification-triggers');

const build = (key, payload) => TRIGGER_REGISTRY[key].build({ name: 'Test', count: 2, unanswered: 1, ...payload }).link;

describe('call alerts open the call', () => {
  test.each([
    'customer_missed_call',
    'customer_voicemail_callback',
    'repeat_caller',
    'promise_chaser',
    'sandy_transfer_no_context',
  ])('%s links the call by its call_log id, or the Calls tab without one', (key) => {
    expect(build(key, { callLogId: 'call-1' })).toBe('/admin/communications#tab=calls&call=call-1');
    expect(build(key, {})).toBe('/admin/communications#tab=calls');
    expect(build(key, { callLogId: 'a b&c' })).toBe('/admin/communications#tab=calls&call=a%20b%26c');
  });
});

describe('text alerts open the conversation', () => {
  test('a known sender keeps the exact thread link the read-state code matches', () => {
    // notification-service markInboundSmsReadAdmin and inbound-sms-read match
    // inbound_sms rows by exactly this string.
    expect(build('sms_reply', { threadId: 'cust-1', twilioSid: 'SM1' })).toBe('/admin/communications?thread=cust-1');
  });

  test('an unknown sender names the message, never the phone number', () => {
    const link = build('sms_reply', { fromPhone: '+19415550100', twilioSid: 'SM1abc' });
    expect(link).toBe('/admin/communications?message=SM1abc');
    expect(link).not.toMatch(/\d{7}/);
  });

  test('no customer and no message id falls back to the inbox', () => {
    expect(build('sms_reply', { fromPhone: '+19415550100' })).toBe('/admin/communications');
  });
});

describe('lead alerts open the lead', () => {
  test('new_lead links the lead it was given, the leads list otherwise', () => {
    expect(build('new_lead', { leadId: 'lead-1' })).toBe('/admin/leads?lead=lead-1');
    expect(build('new_lead', {})).toBe('/admin/leads');
  });
});
