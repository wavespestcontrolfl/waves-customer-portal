/**
 * Delivery-bounce handling for the voicemail quote-link text-back
 * (handleUndeliveredQuoteLink, wired into the Twilio /status callback).
 *
 * A bounced quote link (30006 landline) means the lead has had NO successful
 * first contact and nothing else surfaces that — the lead sat silently cold
 * on 2026-07-17. The handler must pull next_follow_up_at to now and leave a
 * call-instead breadcrumb, and it must ignore non-quote-link sids.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn(() => ({ __raw: true }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn().mockReturnValue(true) }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(), cacheLineType: jest.fn(), lookupLineType: jest.fn(),
}));
jest.mock('../utils/lead-prefill-token', () => ({ mintLeadPrefillToken: jest.fn() }));
jest.mock('../services/short-url', () => ({ createShortCode: jest.fn() }));

const db = require('../models/db');
const { handleUndeliveredQuoteLink } = require('../services/voicemail-lead-sms');

function chainFor(result) {
  const q = {
    _wheres: [],
    where: jest.fn(function (...args) { q._wheres.push(args); return q; }),
    whereNull: jest.fn(function (...args) { q._wheres.push(['null', ...args]); return q; }),
    orderBy: jest.fn(() => q),
    first: jest.fn(() => Promise.resolve(result)),
    update: jest.fn(() => Promise.resolve(1)),
    insert: jest.fn(() => Promise.resolve([1])),
  };
  return q;
}

afterEach(() => jest.clearAllMocks());

describe('handleUndeliveredQuoteLink', () => {
  test('30006 bounce on a quote-link sid pulls the lead follow-up to now and logs a call-instead note', async () => {
    const smsChain = chainFor({ id: 'sms1', to_phone: '+19412268022' });
    // The one-shot claim row names the EXACT lead this text went to —
    // correlation must go through it, never phone+recency (a newer lead
    // sharing the number must not be stamped instead).
    const claimChain = chainFor({ lead_id: 'lead1' });
    const leadLookup = chainFor({ id: 'lead1', next_follow_up_at: null });
    const leadUpdate = chainFor(null);
    const stampChain = chainFor(null);
    const activityChain = chainFor(null);
    const leadChains = [leadLookup, leadUpdate, stampChain];
    db.mockImplementation((table) => {
      if (table === 'sms_log') return smsChain;
      if (table === 'voicemail_sms_claims') return claimChain;
      if (table === 'leads') return leadChains.shift() || chainFor(null);
      if (table === 'lead_activities') return activityChain;
      return chainFor(null);
    });

    const result = await handleUndeliveredQuoteLink({
      sid: 'SMabc', status: 'undelivered', errorCode: '30006', to: '+19412268022',
    });

    expect(result).toMatchObject({ handled: true, leadId: 'lead1' });
    expect(smsChain._wheres[0][0]).toMatchObject({ twilio_sid: 'SMabc', message_type: 'voicemail_quote_link' });
    // Resolved by the claim's lead_id, guarded by the open-lead predicate.
    expect(leadLookup._wheres).toEqual(expect.arrayContaining([
      ['id', 'lead1'],
      ['status', 'new'],
      ['null', 'deleted_at'],
    ]));
    // Follow-up pulled to now.
    const patch = leadUpdate.update.mock.calls[0][0];
    expect(patch.next_follow_up_at).toBeInstanceOf(Date);
    // Call-instead breadcrumb on the timeline.
    const activity = activityChain.insert.mock.calls[0][0];
    expect(activity.lead_id).toBe('lead1');
    expect(activity.description).toContain('landline');
    expect(activity.description).toContain('Call the lead');
  });

  test('a non-quote-link sid is ignored', async () => {
    const smsChain = chainFor(undefined);
    db.mockImplementation(() => smsChain);

    const result = await handleUndeliveredQuoteLink({ sid: 'SMother', status: 'undelivered', errorCode: '30006', to: '+15550001111' });

    expect(result).toMatchObject({ handled: false, reason: 'not_quote_link' });
  });

  test('an existing EARLIER follow-up is never pushed out', async () => {
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    const smsChain = chainFor({ id: 'sms1', to_phone: '+19412268022' });
    const leadLookup = chainFor({ id: 'lead1', next_follow_up_at: earlier });
    const leadUpdate = chainFor(null);
    const stampChain = chainFor(null);
    const leadChains = [leadLookup, leadUpdate, stampChain];
    db.mockImplementation((table) => {
      if (table === 'sms_log') return smsChain;
      if (table === 'leads') return leadChains.shift() || chainFor(null);
      return chainFor(null);
    });

    const result = await handleUndeliveredQuoteLink({ sid: 'SMabc', status: 'undelivered', errorCode: '30006', to: '+19412268022' });

    expect(result).toMatchObject({ handled: true });
    // The first leads chain after the lookup is the extracted_data stamp,
    // NOT a next_follow_up_at write — the overdue follow-up stays put.
    const wroteFollowUp = leadUpdate.update.mock.calls.some((c) => c[0] && c[0].next_follow_up_at);
    expect(wroteFollowUp).toBe(false);
  });
});
