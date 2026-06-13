jest.mock('../models/db', () => jest.fn());
jest.mock('../services/seo/backlink-monitor', () => ({
  classifyLinkType: jest.fn(() => 'directory'),
  classifyTargetPage: jest.fn(() => 'homepage'),
  scoreToxicity: jest.fn(() => ({ score: 0, severity: 'clean', reasons: [] })),
  takeSnapshot: jest.fn(async () => {}),
}));

describe('GSC Links importer', () => {
  beforeEach(() => {
    jest.resetModules();
    require('../models/db').mockReset();
    require('../services/seo/backlink-monitor').takeSnapshot.mockClear();
  });

  test('dry run accepts source-page exports and skips aggregate rows', async () => {
    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'Source page,Target page,Anchor text,First seen,Last crawled',
      'https://example.com/listing,https://wavespestcontrol.com/,Waves Pest Control,2026-06-01,2026-06-10',
      'showmysites.com/wavespestcontrol,https://www.wavespestcontrol.com/pest-control-bradenton-fl,Visit Website,6/2/2026,6/11/2026',
      'Top linking sites,Incoming links',
      'example.org,42',
    ].join('\n');

    const result = await importer.importCsv(csv, { apply: false });

    expect(result).toMatchObject({
      apply: false,
      parsed: 4,
      candidates: 2,
      inserted: 0,
      updated: 0,
      skipped: { missing_source_url: 1, missing_target_url: 1 },
    });
    expect(result.sample).toEqual([
      expect.objectContaining({
        source_url: 'https://example.com/listing',
        source_domain: 'example.com',
        target_url: 'https://wavespestcontrol.com/',
        anchor_text: 'Waves Pest Control',
        first_seen: '2026-06-01',
        last_checked: '2026-06-10',
      }),
      expect.objectContaining({
        source_url: 'https://showmysites.com/wavespestcontrol',
        source_domain: 'showmysites.com',
        target_url: 'https://www.wavespestcontrol.com/pest-control-bradenton-fl',
      }),
    ]);
  });

  test('dry run accepts standard GSC Links column with first discovered date', async () => {
    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'Links,Target page,First discovered',
      'https://example.com/gsc-link,https://wavespestcontrol.com/pest-control-bradenton-fl/,2026-06-01',
    ].join('\n');

    const result = await importer.importCsv(csv, { apply: false });

    expect(result).toMatchObject({
      apply: false,
      parsed: 1,
      candidates: 1,
      skipped: {},
    });
    expect(result.sample[0]).toEqual(expect.objectContaining({
      source_url: 'https://example.com/gsc-link',
      source_domain: 'example.com',
      target_url: 'https://wavespestcontrol.com/pest-control-bradenton-fl/',
      first_seen: '2026-06-01',
      discovered_date: '2026-06-01',
    }));
  });

  test('target-less GSC source exports are skipped unless a default target is explicit', async () => {
    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'URL,First discovered',
      'https://example.com/source-only,2026-06-01',
    ].join('\n');

    const withoutDefault = await importer.importCsv(csv, { apply: false });
    expect(withoutDefault).toMatchObject({
      parsed: 1,
      candidates: 0,
      skipped: { missing_target_url: 1 },
    });

    const withDefault = await importer.importCsv(csv, {
      apply: false,
      defaultTargetUrl: 'https://wavespestcontrol.com/pest-control-sarasota-fl/',
    });
    expect(withDefault).toMatchObject({
      parsed: 1,
      candidates: 1,
      skipped: {},
    });
    expect(withDefault.sample[0]).toEqual(expect.objectContaining({
      source_url: 'https://example.com/source-only',
      target_url: 'https://wavespestcontrol.com/pest-control-sarasota-fl/',
    }));
  });

  test('normalizeRow rejects non-Waves targets', () => {
    const importer = require('../services/seo/gsc-links-importer');

    expect(importer.normalizeRow({
      'Source page': 'https://example.com/listing',
      'Target page': 'https://competitor.example/',
    })).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'non_waves_target',
    }));
  });

  test('re-import preserves existing disavow and toxicity decisions', async () => {
    const db = require('../models/db');
    const BacklinkMonitor = require('../services/seo/backlink-monitor');
    BacklinkMonitor.scoreToxicity.mockReturnValue({ score: 5, severity: 'clean', reasons: [] });
    const existing = {
      id: 'backlink-1',
      source_url: 'https://example.com/listing',
      target_url: 'https://wavespestcontrol.com/',
      status: 'disavowed',
      severity: 'critical',
      toxicity_score: 90,
      toxicity_reasons: JSON.stringify(['manual_disavow']),
      is_dofollow: false,
      first_seen: '2026-05-01',
    };
    const updates = [];

    db.mockImplementation((table) => {
      if (table !== 'seo_backlinks') throw new Error(`Unexpected table ${table}`);
      const builder = {
        where: jest.fn(() => builder),
        first: jest.fn(async () => existing),
        update: jest.fn(async (patch) => {
          updates.push(patch);
          return 1;
        }),
      };
      return builder;
    });

    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'Source page,Target page,Anchor text',
      'https://example.com/listing,https://wavespestcontrol.com/,Waves Pest Control',
    ].join('\n');

    const result = await importer.importCsv(csv, { apply: true });

    expect(result).toMatchObject({ inserted: 0, updated: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(expect.objectContaining({
      status: 'disavowed',
      severity: 'critical',
      toxicity_score: 90,
      toxicity_reasons: JSON.stringify(['manual_disavow']),
      is_dofollow: false,
      first_seen: '2026-05-01',
    }));
  });

  test('re-import preserves existing anchor when GSC CSV has none', async () => {
    const db = require('../models/db');
    const BacklinkMonitor = require('../services/seo/backlink-monitor');
    BacklinkMonitor.scoreToxicity.mockReturnValue({ score: 0, severity: 'clean', reasons: [] });
    const existing = {
      id: 'backlink-1',
      source_url: 'https://example.com/listing',
      target_url: 'https://wavespestcontrol.com/',
      status: 'active',
      severity: 'clean',
      toxicity_score: 0,
      toxicity_reasons: JSON.stringify([]),
      anchor_text: 'Known DataForSEO Anchor',
      notes: 'Manual backlink review note',
      is_dofollow: true,
      first_seen: '2026-05-01',
    };
    const updates = [];

    db.mockImplementation((table) => {
      if (table !== 'seo_backlinks') throw new Error(`Unexpected table ${table}`);
      const builder = {
        where: jest.fn(() => builder),
        first: jest.fn(async () => existing),
        update: jest.fn(async (patch) => {
          updates.push(patch);
          return 1;
        }),
      };
      return builder;
    });

    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'Source page,Target page',
      'https://example.com/listing,https://wavespestcontrol.com/',
    ].join('\n');

    const result = await importer.importCsv(csv, { apply: true });

    expect(result).toMatchObject({ inserted: 0, updated: 1 });
    expect(updates[0]).toEqual(expect.objectContaining({
      anchor_text: 'Known DataForSEO Anchor',
      notes: 'Manual backlink review note',
      is_dofollow: true,
    }));
  });

  test('re-import tags legacy GSC rows for source-aware loss detection', async () => {
    const db = require('../models/db');
    const existing = {
      id: 'backlink-1',
      source_url: 'https://example.com/listing',
      target_url: 'https://wavespestcontrol.com/',
      status: 'active',
      severity: 'clean',
      toxicity_score: 0,
      toxicity_reasons: JSON.stringify([]),
      notes: 'Imported from gsc_links_export. GSC Links exports do not include dofollow or authority metrics; verify separately.',
      discovery_source: null,
      first_seen: '2026-05-01',
    };
    const updates = [];

    db.mockImplementation((table) => {
      if (table !== 'seo_backlinks') throw new Error(`Unexpected table ${table}`);
      const builder = {
        where: jest.fn(() => builder),
        first: jest.fn(async () => existing),
        update: jest.fn(async (patch) => {
          updates.push(patch);
          return 1;
        }),
      };
      return builder;
    });

    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'Source page,Target page',
      'https://example.com/listing,https://wavespestcontrol.com/',
    ].join('\n');

    const result = await importer.importCsv(csv, { apply: true });

    expect(result).toMatchObject({ inserted: 0, updated: 1 });
    expect(updates[0]).toEqual(expect.objectContaining({
      discovery_source: 'gsc_links_export',
    }));
  });

  test('new imports use backlink toxicity scoring instead of defaulting clean', async () => {
    const db = require('../models/db');
    const BacklinkMonitor = require('../services/seo/backlink-monitor');
    BacklinkMonitor.scoreToxicity.mockReturnValue({
      score: 85,
      severity: 'critical',
      reasons: ['toxic_niche'],
    });
    const inserts = [];

    db.mockImplementation((table) => {
      if (table !== 'seo_backlinks') throw new Error(`Unexpected table ${table}`);
      const builder = {
        where: jest.fn(() => builder),
        first: jest.fn(async () => null),
        insert: jest.fn((payload) => {
          inserts.push(payload);
          return { returning: jest.fn(async () => [{ id: 'new-backlink' }]) };
        }),
      };
      return builder;
    });

    const importer = require('../services/seo/gsc-links-importer');
    const csv = [
      'Source page,Target page,Anchor text',
      'https://cheap-casino.example/listing,https://wavespestcontrol.com/,pest control',
    ].join('\n');

    const result = await importer.importCsv(csv, { apply: true });

    expect(result).toMatchObject({ inserted: 1, updated: 0 });
    expect(BacklinkMonitor.scoreToxicity).toHaveBeenCalledWith(expect.objectContaining({
      domain_from: 'cheap-casino.example',
      url_from: 'https://cheap-casino.example/listing',
      anchor: 'pest control',
    }));
    expect(inserts[0]).toEqual(expect.objectContaining({
      toxicity_score: 85,
      toxicity_reasons: JSON.stringify(['toxic_niche']),
      severity: 'critical',
      status: 'active',
      discovery_source: 'gsc_links_export',
    }));
  });
});
