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
    // Follow-up pulled to now — via a single GUARDED update (only when the
    // existing follow-up is missing or later; a concurrent operator edit to
    // an earlier date must never be pushed back).
    const patch = leadUpdate.update.mock.calls[0][0];
    expect(patch.next_follow_up_at).toBeInstanceOf(Date);
    const guardFn = leadUpdate._wheres.map((a) => a[0]).find((a) => typeof a === 'function');
    expect(guardFn).toBeDefined();
    const guard = {
      whereNull: jest.fn(function whereNull() { return this; }),
      orWhere: jest.fn(function orWhere() { return this; }),
    };
    guardFn.call(guard);
    expect(guard.whereNull).toHaveBeenCalledWith('next_follow_up_at');
    expect(guard.orWhere).toHaveBeenCalledWith('next_follow_up_at', '>', expect.any(Date));
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

  test('claim exists but its lead is no longer open → STOP (never stamp a newer lead sharing the phone)', async () => {
    const smsChain = chainFor({ id: 'sms1', to_phone: '+19412268022' });
    const claimChain = chainFor({ lead_id: 'lead1' });
    const leadLookup = chainFor(undefined); // lead1 converted/deleted before the delayed bounce
    const leadChains = [leadLookup];
    db.mockImplementation((table) => {
      if (table === 'sms_log') return smsChain;
      if (table === 'voicemail_sms_claims') return claimChain;
      if (table === 'leads') return leadChains.shift() || chainFor(null);
      return chainFor(null);
    });

    const result = await handleUndeliveredQuoteLink({ sid: 'SMabc', status: 'undelivered', errorCode: '30006', to: '+19412268022' });

    expect(result).toMatchObject({ handled: false, reason: 'claimed_lead_not_open' });
  });

  test('no claim row falls back to the newest still-new recent lead on the phone', async () => {
    const smsChain = chainFor({ id: 'sms1', to_phone: '+19412268022' });
    const claimChain = chainFor(undefined); // pre-claims-table send
    const leadLookup = chainFor({ id: 'lead9', next_follow_up_at: null });
    const leadUpdate = chainFor(null);
    const stampChain = chainFor(null);
    const leadChains = [leadLookup, leadUpdate, stampChain];
    db.mockImplementation((table) => {
      if (table === 'sms_log') return smsChain;
      if (table === 'voicemail_sms_claims') return claimChain;
      if (table === 'leads') return leadChains.shift() || chainFor(null);
      return chainFor(null);
    });

    const result = await handleUndeliveredQuoteLink({ sid: 'SMabc', status: 'undelivered', errorCode: '30006', to: '+19412268022' });

    expect(result).toMatchObject({ handled: true, leadId: 'lead9' });
    expect(leadLookup._wheres).toEqual(expect.arrayContaining([
      ['phone', '+19412268022'],
      ['status', 'new'],
    ]));
  });
});
