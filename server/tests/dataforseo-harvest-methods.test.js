const dataforseo = require('../services/seo/dataforseo');

describe('dataforseo harvest methods', () => {
  let calls;
  const orig = dataforseo.request;
  beforeEach(() => { calls = []; dataforseo.request = async (endpoint, body) => { calls.push({ endpoint, body }); return { ok: true }; }; });
  afterEach(() => { dataforseo.request = orig; });

  test('getReferringDomains hits the referring_domains endpoint', async () => {
    await dataforseo.getReferringDomains('competitor.com', { limit: 500 });
    expect(calls[0].endpoint).toBe('/backlinks/referring_domains/live');
    expect(calls[0].body[0]).toMatchObject({ target: 'competitor.com', limit: 500 });
  });

  test('getBacklinks keeps the dofollow filter by default (existing callers unaffected)', async () => {
    await dataforseo.getBacklinks('x.com');
    expect(calls[0].body[0].filters).toEqual(['dofollow', '=', true]);
  });

  test('getBacklinks with dofollowOnly:false drops the filter (nofollow visible)', async () => {
    await dataforseo.getBacklinks('x.com', 1000, { dofollowOnly: false });
    expect(calls[0].body[0].filters).toBeUndefined();
  });

  test('bulkSpamScore / bulkRanks no-op on empty input (no API spend)', async () => {
    expect(await dataforseo.bulkSpamScore([])).toBeNull();
    expect(await dataforseo.bulkRanks([])).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('bulkSpamScore posts targets', async () => {
    await dataforseo.bulkSpamScore(['a.com', 'b.com']);
    expect(calls[0].endpoint).toBe('/backlinks/bulk_spam_score/live');
    expect(calls[0].body[0].targets).toEqual(['a.com', 'b.com']);
  });
});
