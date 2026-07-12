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
const db = require('../models/db');

describe('retryStrandedNewsletterShares', () => {
  beforeEach(() => { mockStrandedRows = []; mockLastTable = null; });

  test('selection predicate compiles the full stranded-share filter (real knex)', async () => {
    // The recorder mock above discards every where() argument, so it cannot
    // notice a deleted or inverted clause. Compile the real query once and pin
    // the predicate — dropping shared_to_social=false would re-share every
    // recent newsletter to social.
    const realKnex = require('knex')({ client: 'pg' });
    let captured;
    db.mockImplementationOnce((table) => {
      captured = realKnex(table);
      // Compile-only: resolve instead of executing (no DB in unit tests).
      captured.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return captured;
    });

    const res = await ContentScheduler.retryStrandedNewsletterShares();
    expect(res.candidates).toBe(0);

    const { sql, bindings } = captured.toSQL();
    expect(sql).toContain('"status" = ?');
    expect(sql).toContain('"shared_to_social" = ?');
    expect(sql).toContain('"auto_share_social" = ?');
    expect(sql).toContain('"sent_at" >= ?');
    // Share-status subtree: pending/failed, never-attempted, or stale processing.
    expect(sql).toContain('"social_share_status" in (?, ?)');
    expect(sql).toContain('"social_share_status" is null');
    expect(sql).toContain('"social_share_attempted_at" < ?');
    expect(sql).toContain('order by "sent_at" asc');
    expect(sql).toContain('limit ?');
    expect(bindings).toEqual([
      'sent',            // status — only completed sends
      false,             // shared_to_social — the stranded condition
      true,              // auto_share_social — respect the per-send opt-in
      expect.any(Date),  // 7-day lookback cutoff
      'pending', 'failed',
      'processing',
      expect.any(Date),  // stale-processing cutoff
      25,                // default limit
    ]);
  });

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
