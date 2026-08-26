// Tri-state marketing-consent dropper on PUT /api/notification-prefs:
// unchanged round-trips of seasonal_tips / marketing_offers must never
// write (NULL -> true would fabricate consent; NULL -> false burns the
// never-asked state), but an SMS-capable channel FLIP in the same request
// is an explicit opt-in and keeps the submitted true.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({ authenticate: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const route = require('../routes/notification-prefs');
const { dropRoundTrippedMarketingFlags } = route._private;

describe('dropRoundTrippedMarketingFlags', () => {
  test('NULL seasonal_tips round-trip (rendered ON, channel unchanged) is dropped — no fabricated consent', () => {
    const updates = { seasonal_tips: true, seasonal_channel: 'email' };
    dropRoundTrippedMarketingFlags(updates, { seasonal_tips: null, seasonal_channel: null });
    expect(updates).toEqual({ seasonal_channel: 'email' });
  });

  test('NULL seasonal_tips + channel flipped to sms in the same request keeps the opt-in', () => {
    const updates = { seasonal_tips: true, seasonal_channel: 'sms' };
    dropRoundTrippedMarketingFlags(updates, { seasonal_tips: null, seasonal_channel: null });
    expect(updates).toEqual({ seasonal_tips: true, seasonal_channel: 'sms' });
  });

  test('channel already sms-capable: a full-object round-trip still never mints consent from NULL', () => {
    const updates = { seasonal_tips: true, seasonal_channel: 'both' };
    dropRoundTrippedMarketingFlags(updates, { seasonal_tips: null, seasonal_channel: 'both' });
    expect(updates).toEqual({ seasonal_channel: 'both' });
  });

  test('explicit opt-out (true -> false) is a real flip and persists', () => {
    const updates = { seasonal_tips: false };
    dropRoundTrippedMarketingFlags(updates, { seasonal_tips: null, seasonal_channel: null });
    expect(updates).toEqual({ seasonal_tips: false });
  });

  test('marketing_offers NULL renders OFF, so submitted true is a flip and persists without a channel change', () => {
    const updates = { marketing_offers: true };
    dropRoundTrippedMarketingFlags(updates, { marketing_offers: null, marketing_channel: null });
    expect(updates).toEqual({ marketing_offers: true });
  });

  test('marketing_offers stored true round-trip is dropped even alongside a channel flip (consent already captured)', () => {
    const updates = { marketing_offers: true, marketing_channel: 'sms' };
    dropRoundTrippedMarketingFlags(updates, { marketing_offers: true, marketing_channel: 'email' });
    expect(updates).toEqual({ marketing_channel: 'sms' });
  });

  test('no prefs row: seasonal round-trip drops, sms channel selection opts in', () => {
    const drop = { seasonal_tips: true, seasonal_channel: 'email' };
    dropRoundTrippedMarketingFlags(drop, undefined);
    expect(drop).toEqual({ seasonal_channel: 'email' });

    const keep = { seasonal_tips: true, seasonal_channel: 'sms' };
    dropRoundTrippedMarketingFlags(keep, undefined);
    expect(keep).toEqual({ seasonal_tips: true, seasonal_channel: 'sms' });
  });
});
