jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ getBacklinks: jest.fn() }));

const db = require('../models/db');
const dataforseo = require('../services/seo/dataforseo');
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

  test('DataForSEO loss detection excludes GSC-discovered backlinks', async () => {
    dataforseo.getBacklinks.mockResolvedValue({
      tasks: [{ result: [{ items: [], total_count: 0 }] }],
    });
    const sourceFilter = {
      whereNull: jest.fn(() => sourceFilter),
      orWhere: jest.fn(() => sourceFilter),
    };
    const activeQuery = {
      where: jest.fn((arg) => {
        if (typeof arg === 'function') arg(sourceFilter);
        return activeQuery;
      }),
      select: jest.fn(async () => [
        {
          id: 'dataforseo-link',
          source_url: 'https://dataforseo.example/link',
          target_url: 'https://wavespestcontrol.com/',
          source_domain: 'dataforseo.example',
          domain_rating: 20,
          anchor_text: 'Waves Pest Control',
        },
      ]),
    };
    const lostUpdate = {
      whereIn: jest.fn(() => lostUpdate),
      update: jest.fn(async () => 1),
    };

    db.mockImplementation((table) => {
      if (table !== 'seo_backlinks') throw new Error(`Unexpected table ${table}`);
      if (activeQuery.where.mock.calls.length === 0) return activeQuery;
      return lostUpdate;
    });

    const result = await BacklinkMonitor.scan();

    expect(result).toEqual(expect.objectContaining({
      scanComplete: true,
      lostCount: 1,
    }));
    expect(sourceFilter.whereNull).toHaveBeenCalledWith('discovery_source');
    expect(sourceFilter.orWhere).toHaveBeenCalledWith('discovery_source', 'dataforseo');
    expect(lostUpdate.whereIn).toHaveBeenCalledWith('id', ['dataforseo-link']);
  });
});
