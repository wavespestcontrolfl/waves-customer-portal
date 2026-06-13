jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const BacklinkMonitor = require('../services/seo/backlink-monitor');

describe('BacklinkMonitor snapshots', () => {
  beforeEach(() => {
    db.mockReset();
  });

  test('unknown dofollow state is excluded from dofollow and nofollow counts', async () => {
    const activeBacklinks = [
      {
        source_domain: 'follow.example',
        anchor_text: 'Waves Pest Control',
        first_seen: '2026-06-01',
        domain_rating: 20,
        is_dofollow: true,
        severity: 'clean',
      },
      {
        source_domain: 'nofollow.example',
        anchor_text: 'Visit Website',
        first_seen: '2026-06-02',
        domain_rating: 10,
        is_dofollow: false,
        severity: 'watch',
      },
      {
        source_domain: 'unknown.example',
        anchor_text: 'Waves Pest Control',
        first_seen: '2026-06-03',
        domain_rating: 5,
        is_dofollow: null,
        severity: 'clean',
      },
    ];
    const snapshotWrites = [];

    db.mockImplementation((table) => {
      if (table === 'seo_backlinks') {
        return {
          where: jest.fn(async () => activeBacklinks),
        };
      }
      if (table === 'seo_backlink_snapshots') {
        const builder = {
          orderBy: jest.fn(() => builder),
          first: jest.fn(async () => null),
          insert: jest.fn((payload) => {
            snapshotWrites.push(payload);
            return { onConflict: jest.fn(() => ({ merge: jest.fn(async () => {}) })) };
          }),
        };
        return builder;
      }
      throw new Error(`Unexpected table ${table}`);
    });

    await BacklinkMonitor.takeSnapshot();

    expect(snapshotWrites).toHaveLength(1);
    expect(snapshotWrites[0]).toEqual(expect.objectContaining({
      total_backlinks: 3,
      dofollow_count: 1,
      nofollow_count: 1,
    }));
  });
});
