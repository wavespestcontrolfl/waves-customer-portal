jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { cardExpiryOutlook } = require('../services/autopay-notifications');

describe('cardExpiryOutlook (hook #3495 P1 — ET, valid through end of expiry month)', () => {
  test('a card stays valid through its final ET calendar day', () => {
    // UTC is already March 1st, but ET is still Feb 28 — a 02/2026 card is
    // on its last valid day, NOT expired (the old local-Date construction
    // marked it expired for the entire final day).
    const utcMarchButEtFebruary = new Date('2026-03-01T02:30:00Z');
    expect(cardExpiryOutlook(2026, 2, utcMarchButEtFebruary)).toEqual({ daysUntil: 0, expired: false });
    expect(cardExpiryOutlook(2026, 1, utcMarchButEtFebruary).expired).toBe(true);
  });

  test('rolls to expired only once ET enters the next month', () => {
    const etMarchFirst = new Date('2026-03-01T12:00:00Z');
    expect(cardExpiryOutlook(2026, 2, etMarchFirst).expired).toBe(true);
    expect(cardExpiryOutlook(2026, 3, etMarchFirst)).toEqual({ daysUntil: 30, expired: false });
  });

  test('day counts anchor the 7/30-day reminder stages', () => {
    const midJuly = new Date('2026-07-16T16:00:00Z'); // ET July 16
    expect(cardExpiryOutlook(2026, 7, midJuly).daysUntil).toBe(15);
    expect(cardExpiryOutlook(2026, 8, midJuly).daysUntil).toBe(46);
  });
});
