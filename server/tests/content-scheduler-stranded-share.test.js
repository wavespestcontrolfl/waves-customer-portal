/**
 * retryStrandedNewsletterShares — the durability sweep that re-drives
 * newsletter social shares stranded when the fire-and-forget share in
 * sendCampaign never ran (process crash/restart between send-completion
 * and the share). Social flags are mocked OFF so sharePublishedNewsletter
 * short-circuits to a safe no-op and we can assert the sweep's selection
 * + iteration without real social/db writes.
 */

let mockStrandedRows = [];
let mockLastTable = null;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: { automationEnabled: false, newsletterAutoshare: false },
  isPausedByAdmin: jest.fn().mockResolvedValue(false),
}));
jest.mock('../models/db', () => {
  const builder = {
    where: jest.fn(function (arg) { if (typeof arg === 'function') arg(builder); return builder; }),
    whereIn: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    orWhere: jest.fn(function (arg) { if (typeof arg === 'function') arg(builder); return builder; }),
    orWhereNull: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(mockStrandedRows)),
  };
  return jest.fn((table) => { mockLastTable = table; return builder; });
});

const ContentScheduler = require('../services/content-scheduler');

describe('retryStrandedNewsletterShares', () => {
  beforeEach(() => { mockStrandedRows = []; mockLastTable = null; });

  test('queries newsletter_sends and drives every stranded candidate', async () => {
    mockStrandedRows = [
      { id: 's1', status: 'sent', shared_to_social: false, auto_share_social: true, social_share_status: 'pending', slug: 'a' },
      { id: 's2', status: 'sent', shared_to_social: false, auto_share_social: true, social_share_status: 'failed', slug: 'b' },
    ];
    const res = await ContentScheduler.retryStrandedNewsletterShares();
    expect(mockLastTable).toBe('newsletter_sends');
    expect(res.candidates).toBe(2);
    expect(res.retried).toBe(2);
  });

  test('no-ops cleanly when nothing is stranded', async () => {
    mockStrandedRows = [];
    const res = await ContentScheduler.retryStrandedNewsletterShares();
    expect(res.candidates).toBe(0);
    expect(res.retried).toBe(0);
  });
});
