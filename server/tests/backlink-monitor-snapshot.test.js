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
      if (table === 'seo_backlink_events') {
        const ev = { where: jest.fn(() => ev), count: jest.fn(() => ev), first: jest.fn(async () => ({ count: '2' })) };
        return ev;
      }
      if (table === 'seo_backlink_snapshots') {
        const builder = {
          where: jest.fn(() => builder),
          orderBy: jest.fn(() => builder),
          first: jest.fn(async () => (builder.first.mock.calls.length > 1 ? null : { snapshot_date: '2026-06-01', created_at: new Date('2026-06-01T07:30:00Z'), updated_at: new Date('2026-06-01T19:00:00Z') })),
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
    // the baseline is the previous DAY's snapshot, never a same-day row about to be merged over
    expect(db.mock.results.map(r => r.value).find(b => b.where && b.orderBy && b.first).where).toHaveBeenCalledWith('snapshot_date', '<', expect.any(String));
    expect(snapshotWrites[0].updated_at).toBeInstanceOf(Date); // merged re-takes advance the next baseline
    // losses come from the event ledger (a lost-then-recovered link still counts), baselined on the previous row's updated_at
    const evBuilder = db.mock.results.map(r => r.value).find(b => b.count && b.where);
    expect(evBuilder.where).toHaveBeenCalledWith('event_type', 'lost');
    expect(evBuilder.where).toHaveBeenCalledWith('created_at', '>=', new Date('2026-06-01T19:00:00Z'));
    expect(snapshotWrites[0]).toEqual(expect.objectContaining({
      lost_backlinks_since_last: 2,
      total_backlinks: 3,
      dofollow_count: 1,
      nofollow_count: 1,
    }));
  });

  test('DataForSEO loss detection excludes GSC-discovered backlinks', async () => {
    // One unrelated live link so the scan is non-empty and "complete"; the
    // DataForSEO-sourced active row is absent and gets its first miss counted.
    dataforseo.getBacklinks.mockResolvedValue({
      tasks: [{ result: [{ items: [
        { url_from: 'https://other.example/a', url_to: 'https://wavespestcontrol.com/', domain_from: 'other.example', domain_from_rank: 10, dofollow: true },
      ], total_count: 1 }] }],
    });
    // ONE full-table load: a scan-tracked row (absent from the feed → first miss)
    // and a GSC-export row (absent too — but excluded from loss detection by design)
    const activeQuery = {
      select: jest.fn(async () => [
        {
          id: 'dataforseo-link',
          source_url: 'https://dataforseo.example/link',
          target_url: 'https://wavespestcontrol.com/',
          source_domain: 'dataforseo.example',
          domain_rating: 20,
          anchor_text: 'Waves Pest Control',
          status: 'active', discovery_source: 'dataforseo',
        },
        {
          id: 'gsc-link',
          source_url: 'https://gsc.example/link',
          target_url: 'https://wavespestcontrol.com/',
          source_domain: 'gsc.example',
          domain_rating: 20,
          anchor_text: 'Waves Pest Control',
          status: 'active', discovery_source: 'gsc',
        },
      ]),
    };
    // Serves the first-miss increment, then the "owed recovery" sweep query
    // (no rows) and any settle-stamp update.
    const missUpdate = {
      whereIn: jest.fn(() => missUpdate),
      where: jest.fn(() => missUpdate), whereNull: jest.fn(() => missUpdate),
      whereRaw: jest.fn(() => missUpdate), whereNotIn: jest.fn(() => missUpdate),
      select: jest.fn(async () => []), update: jest.fn(async () => 0),
      increment: jest.fn(async () => 1),
    };
    const upsert = {
      insert: jest.fn(() => ({ returning: jest.fn(async () => [1]) })),
    };

    db.transaction = jest.fn(async (fn) => fn(db));
    db.mockImplementation((table) => {
      if (table !== 'seo_backlinks') throw new Error(`Unexpected table ${table}`);
      if (activeQuery.select.mock.calls.length === 0) return activeQuery;
      if (upsert.insert.mock.calls.length === 0) return upsert;
      return missUpdate;
    });

    const result = await BacklinkMonitor.scan({ exclusive: (_n, fn) => fn(), crawlFn: jest.fn() });

    expect(result).toEqual(expect.objectContaining({
      scanComplete: true,
      missed: 1,
      lostCount: 0,
    }));
    // the DataForSEO row is the only loss candidate — first miss counted, not lost; the GSC row is never a candidate
    expect(missUpdate.whereIn).toHaveBeenCalledWith('id', ['dataforseo-link']);
    expect(missUpdate.whereIn).not.toHaveBeenCalledWith('id', expect.arrayContaining(['gsc-link']));
    expect(missUpdate.increment).toHaveBeenCalledWith('miss_count', 1);
  });
});
