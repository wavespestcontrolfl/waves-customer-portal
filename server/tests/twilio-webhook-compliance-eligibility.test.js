// STOP / HELP / START handling only applies to numbers Waves has texted.
// A first-contact stranger's body is never scanned for opt-out phrasing, so a
// robotext's own "reply NO to stop texting" footer cannot earn an
// unsubscribe reply from a Waves line (audit 2026-09-09).
const state = { results: [], fail: false, tables: [] };
jest.mock('../models/db', () => {
  const q = {
    where: jest.fn(() => q), whereIn: jest.fn(() => q), whereNotIn: jest.fn(() => q), whereRaw: jest.fn(() => q),
    whereNot: jest.fn(() => q), orWhereNull: jest.fn(() => q), join: jest.fn(() => q),
    first: jest.fn(async () => { if (state.fail) throw Object.assign(new Error('query failed for +19415551234'), { code: '08006' }); return state.results.shift() ?? null; }),
  };
  const db = jest.fn((table) => { state.tables.push(table); return q; });
  db.raw = jest.fn((sql) => sql);
  return db;
});
jest.mock('../services/twilio', () => ({ isKnownOwnerPhone: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(), clearSuppression: jest.fn() }));
jest.mock('../services/messaging/opt-out-detector', () => ({ detectSmsOptCommand: jest.fn(() => ({ action: null })) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), updateByTwilioSid: jest.fn() }));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(), isFailureStatus: jest.fn(() => false) }));
jest.mock('../services/sms-intent', () => ({ hasSchedulingIntent: jest.fn(() => false), isSmsReaction: jest.fn(() => false) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn(() => 'https://portal.wavespestcontrol.com') }));

const { hasOutboundHistory } = require('../routes/twilio-webhook')._internals;

describe('hasOutboundHistory — who may receive a STOP/HELP/START reply', () => {
  beforeEach(() => { state.results = []; state.fail = false; state.tables = []; });

  test('a number Waves never texted, never bounced, never suppressed is not eligible', async () => {
    expect(await hasOutboundHistory('+18139342698')).toBe(false);
    expect(state.tables).toEqual(['sms_log', 'messages', 'messaging_suppression']);
  });

  test('a provider-accepted outbound row is enough', async () => {
    state.results = [{ id: 'sms-1' }];
    expect(await hasOutboundHistory('+19415551234')).toBe(true);
    expect(state.tables).toEqual(['sms_log']);
  });

  test('a unified outbound message counts when the legacy log write was lost', async () => {
    state.results = [null, { id: 'msg-1' }];
    expect(await hasOutboundHistory('+19415551234')).toBe(true);
    expect(state.tables).toEqual(['sms_log', 'messages']);
  });

  test('an active suppression row counts so START can clear it', async () => {
    state.results = [null, null, { id: 'sup-1' }];
    expect(await hasOutboundHistory('+19415551234')).toBe(true);
  });

  test('untyped operator alerts cannot establish customer history, while suppression still can', async () => {
    const twilio = require('../services/twilio');
    twilio.isKnownOwnerPhone.mockReturnValueOnce(true);
    expect(await hasOutboundHistory('+19415550199')).toBe(false);
    expect(state.tables).toEqual(['messaging_suppression']);
    state.results = [{ id: 'suppression-1' }];
    twilio.isKnownOwnerPhone.mockReturnValueOnce(true);
    expect(await hasOutboundHistory('+19415550199')).toBe(true);
  });

  test('an unusable number is never eligible', async () => {
    state.results = [{ id: 'sms-1' }];
    expect(await hasOutboundHistory('')).toBe(false);
    expect(await hasOutboundHistory('12345')).toBe(false);
    expect(state.tables).toEqual([]);
  });

  test('fails OPEN on a query error so a real STOP is still honored', async () => {
    state.fail = true;
    expect(await hasOutboundHistory('+19415551234')).toBe(true);
    const log = require('../services/logger').warn.mock.calls.at(-1);
    expect(JSON.stringify(log)).not.toContain('19415551234');
    expect(log[1]).toEqual({ code: '08006' });
  });
});
