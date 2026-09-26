/**
 * Unit tests for related-posts.js — the related-existing-blog-post
 * selector for new supporting-blog briefs (owner audit 2026-09-26: 115/278
 * blog posts link to no other post because the writer's closed internal-link
 * set never included any blog post).
 */

jest.mock('../models/db', () => jest.fn());

const {
  rankRelatedPosts,
  getRelatedPostsForBrief,
  candidateFromRow,
  RELATED_POSTS_DEFAULT_LIMIT,
} = require('../services/content/related-posts');

function candidate(over = {}) {
  return {
    id: 'id-1',
    title: 'Untitled',
    path: '/pest-control/some-post/',
    keyword: null,
    city: null,
    service: null,
    category: null,
    targetSites: null,
    workflowStatus: 'published',
    ...over,
  };
}

describe('rankRelatedPosts — ranking', () => {
  test('pest/service entity match outranks keyword overlap', () => {
    const target = { keyword: 'termite swarmers in spring', service: 'termite' };
    const candidates = [
      candidate({ id: 'a', title: 'Termite Swarmer Season Guide', path: '/termite/swarmer-season/', keyword: 'termite swarmers', service: 'termite' }),
      candidate({ id: 'b', title: 'Spring Lawn Fertilizer Timing', path: '/lawn-care/spring-fertilizer-timing/', keyword: 'spring lawn fertilizer', service: 'lawn' }),
    ];
    const out = rankRelatedPosts(target, candidates);
    expect(out.map((r) => r.path)).toEqual(['/termite/swarmer-season/', '/lawn-care/spring-fertilizer-timing/']);
  });

  test('keyword-token overlap ranks above a same-city-only match', () => {
    const target = { keyword: 'chinch bug damage st augustine grass', service: null, city: 'Sarasota' };
    const candidates = [
      candidate({ id: 'a', title: 'Chinch Bug Damage Identification', path: '/lawn-care/chinch-bug-damage/', keyword: 'chinch bug damage' }),
      candidate({ id: 'b', title: 'Sarasota Mosquito Season', path: '/mosquito/sarasota-season/', keyword: 'mosquito season', city: 'Sarasota' }),
    ];
    const out = rankRelatedPosts(target, candidates);
    expect(out[0].path).toBe('/lawn-care/chinch-bug-damage/');
    expect(out[1].path).toBe('/mosquito/sarasota-season/');
  });

  test('a candidate sharing neither entity nor keyword nor city is dropped, never force-filled', () => {
    const target = { keyword: 'termite swarmers', service: 'termite' };
    const candidates = [
      candidate({ id: 'a', title: 'Unrelated Rodent Post', path: '/rodent/attic-noises/', keyword: 'rats in attic', service: 'rodent' }),
    ];
    expect(rankRelatedPosts(target, candidates)).toEqual([]);
  });

  test('deterministic tie-break: equal score sorts by title', () => {
    const target = { service: 'termite' };
    const candidates = [
      candidate({ id: 'b', title: 'Zebra Termite Post', path: '/termite/zebra/', service: 'termite' }),
      candidate({ id: 'a', title: 'Alpha Termite Post', path: '/termite/alpha/', service: 'termite' }),
    ];
    const out = rankRelatedPosts(target, candidates);
    expect(out.map((r) => r.title)).toEqual(['Alpha Termite Post', 'Zebra Termite Post']);
  });

  test('output shape is exactly title, path, keyword — no internal ranking fields leak', () => {
    const target = { service: 'termite' };
    const out = rankRelatedPosts(target, [candidate({ service: 'termite', keyword: 'termite bait stations' })]);
    expect(out).toEqual([{ title: 'Untitled', path: '/pest-control/some-post/', keyword: 'termite bait stations' }]);
  });

  describe('exclusion of self', () => {
    test('excludeId drops the matching candidate', () => {
      const target = { service: 'termite', excludeId: 'self-id' };
      const candidates = [
        candidate({ id: 'self-id', service: 'termite', path: '/termite/self/' }),
        candidate({ id: 'other-id', service: 'termite', path: '/termite/other/' }),
      ];
      const out = rankRelatedPosts(target, candidates);
      expect(out.map((r) => r.path)).toEqual(['/termite/other/']);
    });

    test('excludePath drops the matching candidate regardless of trailing-slash / absolute-URL formatting', () => {
      const target = { service: 'termite', excludePath: 'https://www.wavespestcontrol.com/termite/self' };
      const candidates = [
        candidate({ id: 'self-id', service: 'termite', path: '/termite/self/' }),
        candidate({ id: 'other-id', service: 'termite', path: '/termite/other/' }),
      ];
      const out = rankRelatedPosts(target, candidates);
      expect(out.map((r) => r.path)).toEqual(['/termite/other/']);
    });
  });

  describe('domain restriction', () => {
    test('default (no domains given) restricts to hub-visible posts: a spoke-only candidate is excluded', () => {
      const target = { service: 'termite' };
      const candidates = [
        candidate({ id: 'hub', service: 'termite', path: '/termite/hub-post/', targetSites: null }),
        candidate({ id: 'spoke-only', service: 'termite', path: '/termite/spoke-post/', targetSites: ['sarasotaflpestcontrol.com'] }),
      ];
      const out = rankRelatedPosts(target, candidates);
      expect(out.map((r) => r.path)).toEqual(['/termite/hub-post/']);
    });

    test('a candidate with no target_sites (legacy pre-filter row) renders everywhere, including hub', () => {
      const target = { service: 'termite' };
      const candidates = [candidate({ service: 'termite', path: '/termite/legacy/', targetSites: [] })];
      expect(rankRelatedPosts(target, candidates)).toHaveLength(1);
    });

    test('an explicit spoke domain requires the candidate to render on THAT domain too', () => {
      const target = { service: 'termite', domains: ['sarasotaflpestcontrol.com'] };
      const candidates = [
        candidate({ id: 'right-spoke', service: 'termite', path: '/termite/sarasota-post/', targetSites: ['sarasotaflpestcontrol.com'] }),
        candidate({ id: 'wrong-spoke', service: 'termite', path: '/termite/venice-post/', targetSites: ['veniceflpestcontrol.com'] }),
        candidate({ id: 'renders-everywhere', service: 'termite', path: '/termite/legacy/', targetSites: null }),
      ];
      const out = rankRelatedPosts(target, candidates).map((r) => r.path);
      expect(out).toEqual(expect.arrayContaining(['/termite/sarasota-post/', '/termite/legacy/']));
      expect(out).not.toContain('/termite/venice-post/');
    });
  });

  describe('cap', () => {
    test('caps at the default limit (12) even with more topically-related candidates', () => {
      const target = { service: 'termite' };
      const candidates = Array.from({ length: 20 }, (_, i) => candidate({
        id: `t${i}`, service: 'termite', title: `Termite Post ${String(i).padStart(2, '0')}`, path: `/termite/post-${i}/`,
      }));
      const out = rankRelatedPosts(target, candidates);
      expect(out).toHaveLength(RELATED_POSTS_DEFAULT_LIMIT);
    });

    test('a custom limit is honored', () => {
      const target = { service: 'termite' };
      const candidates = Array.from({ length: 5 }, (_, i) => candidate({ id: `t${i}`, service: 'termite', path: `/termite/post-${i}/` }));
      expect(rankRelatedPosts(target, candidates, { limit: 3 })).toHaveLength(3);
    });

    test('never pads below what genuinely relates — fewer than the target min is fine', () => {
      const target = { service: 'termite' };
      const candidates = [candidate({ service: 'termite', path: '/termite/only-one/' })];
      expect(rankRelatedPosts(target, candidates)).toHaveLength(1);
    });
  });
});

describe('candidateFromRow', () => {
  test('prefers astro_live_url as the canonical path when present', () => {
    const row = { id: '1', title: 'T', keyword: 'k', tag: 'Termites', category: 'termite', slug: 'leaf', city: 'Sarasota', target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/termite/leaf/' };
    const c = candidateFromRow(row);
    expect(c.path).toBe('/termite/leaf/');
    expect(c.workflowStatus).toBe('published');
  });

  test('falls back to a slug-derived path when astro_live_url is absent (legacy row)', () => {
    const row = { id: '2', title: 'T2', keyword: 'k2', tag: null, category: null, slug: 'old-flat-slug', city: null, target_sites: null, status: 'published', astro_status: 'draft', astro_live_url: null };
    const c = candidateFromRow(row);
    expect(c.path).toBe('/old-flat-slug/');
    expect(c.workflowStatus).toBe('published');
  });

  test('a non-published, non-live row is not workflow_status published', () => {
    const row = { id: '3', title: 'T3', slug: 'queued-post', status: 'queued', astro_status: 'draft', astro_live_url: null, target_sites: null };
    expect(candidateFromRow(row).workflowStatus).not.toBe('published');
  });
});

describe('getRelatedPostsForBrief — DB wrapper', () => {
  function fakeDb(rows) {
    return jest.fn(() => ({ select: jest.fn().mockResolvedValue(rows) }));
  }

  test('queries blog_posts, filters to published/live, and ranks the rest', async () => {
    const rows = [
      { id: 'a', title: 'Termite Bait Stations Explained', keyword: 'termite bait stations', tag: 'Termites', category: 'termite', slug: 'bait-stations', city: null, target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/termite/bait-stations/' },
      { id: 'b', title: 'Queued Termite Draft', keyword: 'termite draft', tag: 'Termites', category: 'termite', slug: 'queued-draft', city: null, target_sites: null, status: 'queued', astro_status: 'draft', astro_live_url: null },
      { id: 'c', title: 'Unrelated Rodent Post', keyword: 'rats in attic', tag: 'Rodents', category: 'rodent', slug: 'attic-noises', city: null, target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/rodent/attic-noises/' },
    ];
    const database = fakeDb(rows);
    const out = await getRelatedPostsForBrief({ service: 'termite', keyword: 'termite bait stations' }, { database });
    expect(database).toHaveBeenCalledWith('blog_posts');
    expect(out.map((r) => r.path)).toEqual(['/termite/bait-stations/']);
  });

  test('a DB read failure propagates (the caller is responsible for the fallback-to-empty catch)', async () => {
    const database = jest.fn(() => ({ select: jest.fn().mockRejectedValue(new Error('boom')) }));
    await expect(getRelatedPostsForBrief({ service: 'termite' }, { database })).rejects.toThrow('boom');
  });
});
