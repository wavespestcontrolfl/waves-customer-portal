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

  test('bulkRanks posts targets on the one_hundred rank scale (0–100 = domain_rating semantics)', async () => {
    await dataforseo.bulkRanks(['a.com', 'b.com']);
    expect(calls[0].endpoint).toBe('/backlinks/bulk_ranks/live');
    expect(calls[0].body[0]).toEqual({ targets: ['a.com', 'b.com'], rank_scale: 'one_hundred' });
  });

  test('bulkReferringDomains / bulkTrafficEstimation: bulk endpoints, no-op on empty input, US/en for traffic', async () => {
    expect(await dataforseo.bulkReferringDomains([])).toBeNull();
    expect(await dataforseo.bulkTrafficEstimation([])).toBeNull();
    expect(calls).toHaveLength(0);
    await dataforseo.bulkReferringDomains(['a.com']);
    expect(calls[0]).toEqual({ endpoint: '/backlinks/bulk_referring_domains/live', body: [{ targets: ['a.com'] }] });
    await dataforseo.bulkTrafficEstimation(['a.com']);
    expect(calls[1]).toEqual({ endpoint: '/dataforseo_labs/google/bulk_traffic_estimation/live', body: [{ targets: ['a.com'], location_code: 2840, language_code: 'en' }] });
  });

  test('bulkSpamScore posts targets', async () => {
    await dataforseo.bulkSpamScore(['a.com', 'b.com']);
    expect(calls[0].endpoint).toBe('/backlinks/bulk_spam_score/live');
    expect(calls[0].body[0].targets).toEqual(['a.com', 'b.com']);
  });

  test('serpOrganic uses location_name for a place and location_coordinate for "lat,lng"', async () => {
    await dataforseo.serpOrganic('pest control', 'Bradenton,Florida,United States');
    expect(calls[0].body[0].location_name).toBe('Bradenton,Florida,United States');
    expect(calls[0].body[0].location_coordinate).toBeUndefined();
    await dataforseo.serpOrganic('pest control', '27.5743,-82.4276');
    expect(calls[1].body[0].location_coordinate).toBe('27.5743,-82.4276,20'); // radius appended (lat,lng,radius)
    expect(calls[1].body[0].location_name).toBeUndefined();
    await dataforseo.serpOrganic('pest control', '27.5743,-82.4276,15'); // explicit radius preserved
    expect(calls[2].body[0].location_coordinate).toBe('27.5743,-82.4276,15');
  });

  describe('serpOrganic poisoned-page fix (GATE_DATAFORSEO_RESOLVE_POISONED)', () => {
    const ENV = 'GATE_DATAFORSEO_RESOLVE_POISONED';
    let saved;
    beforeEach(() => { saved = process.env[ENV]; });
    afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

    test('gate unset: the task carries no resolve_poisoned_results (no added cost)', async () => {
      delete process.env[ENV];
      await dataforseo.serpOrganic('pest control', 'Bradenton,Florida,United States');
      expect(calls[0].endpoint).toBe('/serp/google/organic/live/advanced');
      expect(calls[0].body[0]).not.toHaveProperty('resolve_poisoned_results');
    });

    test('gate exactly "true": every serpOrganic task asks DataForSEO to repair a poisoned page', async () => {
      process.env[ENV] = 'true';
      await dataforseo.serpOrganic('pest control', 'Bradenton,Florida,United States');
      await dataforseo.serpOrganic('pest control', '27.5743,-82.4276', 'desktop');
      expect(calls[0].body[0]).toMatchObject({
        resolve_poisoned_results: true, device: 'mobile', os: 'iOS', location_name: 'Bradenton,Florida,United States',
      });
      expect(calls[1].body[0]).toMatchObject({
        resolve_poisoned_results: true, device: 'desktop', os: 'macos', location_coordinate: '27.5743,-82.4276,20',
      });
    });

    test('strict: any value other than "true" stays off', async () => {
      for (const value of ['TRUE', '1', 'yes', '']) {
        process.env[ENV] = value;
        await dataforseo.serpOrganic('pest control');
      }
      expect(calls).toHaveLength(4);
      calls.forEach((c) => expect(c.body[0]).not.toHaveProperty('resolve_poisoned_results'));
    });

    test('checkIndexed keeps its own organic call without the flag', async () => {
      process.env[ENV] = 'true';
      await dataforseo.checkIndexed('https://example.com/page');
      expect(calls[0].endpoint).toBe('/serp/google/organic/live/advanced');
      expect(calls[0].body[0]).not.toHaveProperty('resolve_poisoned_results');
    });
  });
});
