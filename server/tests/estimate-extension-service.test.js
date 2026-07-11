const {
  computeExtensionExpiry,
  extensionStatusUpdate,
  EXTENDABLE_STATUSES,
} = require('../services/estimate-extension');

const DAY = 86400000;
const NOW = new Date('2026-07-10T12:00:00Z');
const FUTURE = new Date(NOW.getTime() + 3 * DAY).toISOString();
const PAST = new Date(NOW.getTime() - 3 * DAY).toISOString();

describe('computeExtensionExpiry (shared by admin extend + public auto-grant)', () => {
  it('extends an already-expired estimate from NOW, not from the lapsed expiry', () => {
    const result = computeExtensionExpiry({ expires_at: PAST }, 7, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });

  it('pushes an active estimate out from its CURRENT expiry', () => {
    const result = computeExtensionExpiry({ expires_at: FUTURE }, 7, NOW);
    expect(result.getTime()).toBe(new Date(FUTURE).getTime() + 7 * DAY);
  });

  it('treats a missing expiry as "now" (7d from today)', () => {
    const result = computeExtensionExpiry({ expires_at: null }, 7, NOW);
    expect(result.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });
});

describe('extensionStatusUpdate (sweep-expired revival)', () => {
  it('revives a sweep-expired row to viewed when the customer had viewed', () => {
    expect(extensionStatusUpdate({ status: 'expired', viewed_at: PAST })).toBe('viewed');
  });

  it('revives a sweep-expired unviewed row to sent', () => {
    expect(extensionStatusUpdate({ status: 'expired', viewed_at: null })).toBe('sent');
  });

  it('leaves non-expired statuses untouched (returns null = no status write)', () => {
    expect(extensionStatusUpdate({ status: 'sent', viewed_at: null })).toBe(null);
    expect(extensionStatusUpdate({ status: 'viewed', viewed_at: PAST })).toBe(null);
  });
});

describe('EXTENDABLE_STATUSES', () => {
  it('matches the admin extend contract: sent / viewed / expired only', () => {
    expect(EXTENDABLE_STATUSES).toEqual(['sent', 'viewed', 'expired']);
  });
});
