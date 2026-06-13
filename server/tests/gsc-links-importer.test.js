jest.mock('../models/db', () => jest.fn());
jest.mock('../services/seo/backlink-monitor', () => ({
  classifyLinkType: jest.fn(() => 'directory'),
  classifyTargetPage: jest.fn(() => 'homepage'),
  takeSnapshot: jest.fn(async () => {}),
}));

describe('GSC Links importer', () => {
  beforeEach(() => {
    jest.resetModules();
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
      skipped: { missing_source_url: 1 },
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
});
