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
      candidate({ id: 'b', title: 'Spring Swarmer Identification', path: '/pest-control/spring-swarmers/', keyword: 'spring swarmers' }),
    ];
    const out = rankRelatedPosts(target, candidates);
    expect(out.map((r) => r.path)).toEqual(['/termite/swarmer-season/', '/pest-control/spring-swarmers/']);
  });

  test('keyword-only admission requires at least two substantive shared tokens', () => {
    const target = { keyword: 'termite damage from mud tubes' };
    const candidates = [
      candidate({ id: 'a', title: 'Termite Mud Tubes on Foundations', path: '/termite/mud-tubes/', keyword: 'termite mud tubes' }),
      candidate({ id: 'b', title: 'Hurricane Damage Cleanup', path: '/home/hurricane-cleanup/', keyword: 'hurricane damage cleanup' }),
    ];

    expect(rankRelatedPosts(target, candidates).map((r) => r.path)).toEqual(['/termite/mud-tubes/']);
  });

  test('a same-city candidate with ZERO entity/keyword overlap is dropped — city alone never admits a candidate', () => {
    // Codex #4984 r2 P1: this list is enforced by a hard link-count gate, so
    // a city-only false positive could force an unrelated link into the
    // draft. "Sarasota Mosquito Season" shares no entity or keyword tokens
    // with a chinch-bug/lawn-care target — same city is not enough.
    const target = { keyword: 'chinch bug damage st augustine grass', service: null, city: 'Sarasota' };
    const candidates = [
      candidate({ id: 'a', title: 'Chinch Bug Damage Identification', path: '/lawn-care/chinch-bug-damage/', keyword: 'chinch bug damage' }),
      candidate({ id: 'b', title: 'Sarasota Mosquito Season', path: '/mosquito/sarasota-season/', keyword: 'mosquito season', city: 'Sarasota' }),
    ];
    const out = rankRelatedPosts(target, candidates);
    expect(out.map((r) => r.path)).toEqual(['/lawn-care/chinch-bug-damage/']);
  });

  test('city is a TIE-BREAKER between two ALREADY topically-related candidates, never the sole admission reason', () => {
    const target = { keyword: 'termite swarmers', service: 'termite', city: 'Bradenton' };
    const candidates = [
      candidate({ id: 'a', title: 'Termite Swarmer Season Elsewhere', path: '/termite/swarmer-season/', service: 'termite', keyword: 'termite swarmers' }),
      candidate({ id: 'b', title: 'Termite Swarmer Season in Bradenton', path: '/termite/swarmer-season-bradenton/', service: 'termite', keyword: 'termite swarmers', city: 'Bradenton' }),
    ];
    const out = rankRelatedPosts(target, candidates);
    // Both share entity + identical keyword overlap; b additionally matches
    // the target's city, so it ranks first — the city nudge only breaks a
    // tie between candidates that already earned inclusion on their own.
    expect(out[0].path).toBe('/termite/swarmer-season-bradenton/');
    expect(out[1].path).toBe('/termite/swarmer-season/');
  });

  test('a candidate sharing neither entity nor keyword nor city is dropped, never force-filled', () => {
    const target = { keyword: 'termite swarmers', service: 'termite' };
    const candidates = [
      candidate({ id: 'a', title: 'Unrelated Rodent Post', path: '/rodent/attic-noises/', keyword: 'rats in attic', service: 'rodent' }),
    ];
    expect(rankRelatedPosts(target, candidates)).toEqual([]);
  });

  test('generic service words alone never admit a candidate ("treatment", "control", "Florida", a city)', () => {
    // Codex #4984 r4 P2: the hard link gate requires min(3, N) of these, so
    // a generic-word false positive would force an unrelated link.
    const target = { keyword: 'termite treatment in Florida', service: 'termite', city: 'Sarasota' };
    const candidates = [
      candidate({ id: 'a', title: 'Termite Bait Stations', path: '/termite/bait-stations/', keyword: 'termite bait stations', service: 'termite' }),
      candidate({ id: 'b', title: 'Fire Ant Treatment Guide for Florida Homes', path: '/pest-control/fire-ant-treatment/', keyword: 'fire ant treatment', service: 'ants' }),
      candidate({ id: 'c', title: 'Mosquito Control in Sarasota', path: '/mosquito/control-sarasota/', keyword: 'mosquito control sarasota', service: 'mosquito', city: 'Sarasota' }),
    ];
    expect(rankRelatedPosts(target, candidates).map((r) => r.path)).toEqual(['/termite/bait-stations/']);
  });

  test('two rows that resolve to one live URL are listed once', () => {
    const target = { service: 'termite' };
    const candidates = [
      candidate({ id: 'a', title: 'Termite Bond Explained', path: '/termite/termite-bond/', service: 'termite' }),
      candidate({ id: 'b', title: 'Termite Bond (legacy row)', path: 'https://www.wavespestcontrol.com/termite/termite-bond', service: 'termite' }),
      candidate({ id: 'c', title: 'Drywood Termites', path: '/termite/drywood/', service: 'termite' }),
    ];
    const paths = rankRelatedPosts(target, candidates).map((r) => r.path);
    expect(paths).toEqual(['/termite/drywood/', '/termite/termite-bond/']);
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
  test('prefers astro_live_url as the canonical path when present, and marks it pathVerified', () => {
    const row = { id: '1', title: 'T', keyword: 'k', tag: 'Termites', category: 'termite', slug: 'leaf', city: 'Sarasota', target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/termite/leaf/' };
    const c = candidateFromRow(row);
    expect(c.path).toBe('/termite/leaf/');
    expect(c.workflowStatus).toBe('published');
    expect(c.pathVerified).toBe(true);
  });

  test('falls back to a slug-derived GUESS when astro_live_url is absent (legacy row) — and marks it NOT verified', () => {
    // The exact incident this guards against (migration 20260830000030): a
    // pre-publish slug shipped as a live link and 404'd because the real
    // route was category-prefixed, not the bare slug. candidateFromRow still
    // returns the guessed path (useful for other registry consumers), but
    // pathVerified:false means getRelatedPostsForBrief must never treat it
    // as a safe link target.
    const row = { id: '2', title: 'T2', keyword: 'k2', tag: null, category: null, slug: 'old-flat-slug', city: null, target_sites: null, status: 'published', astro_status: 'draft', astro_live_url: null };
    const c = candidateFromRow(row);
    expect(c.path).toBe('/old-flat-slug/');
    expect(c.workflowStatus).toBe('published');
    expect(c.pathVerified).toBe(false);
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

  test('queries blog_posts, filters to published/live with a confirmed URL, and ranks the rest', async () => {
    const rows = [
      { id: 'a', title: 'Termite Bait Stations Explained', keyword: 'termite bait stations', tag: 'Termites', category: 'termite', slug: 'bait-stations', city: null, target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/termite/bait-stations/' },
      { id: 'b', title: 'Queued Termite Draft', keyword: 'termite draft', tag: 'Termites', category: 'termite', slug: 'queued-draft', city: null, target_sites: null, status: 'queued', astro_status: 'draft', astro_live_url: null },
      { id: 'c', title: 'Unrelated Rodent Post', keyword: 'rats in attic', tag: 'Rodents', category: 'rodent', slug: 'attic-noises', city: null, target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/rodent/attic-noises/' },
      // The exact garage-door incident shape (migration 20260830000030):
      // status='published' but no astro_live_url — the bare-slug guess is
      // NOT the real category-prefixed route. Must be excluded even though
      // workflowStatus normalizes to 'published'.
      { id: 'd', title: 'Legacy Termite Post (unverified slug)', keyword: 'termite legacy post', tag: 'Termites', category: 'termite', slug: 'termite-legacy-slug', city: null, target_sites: null, status: 'published', astro_status: 'draft', astro_live_url: null },
    ];
    const database = fakeDb(rows);
    const out = await getRelatedPostsForBrief({ service: 'termite', keyword: 'termite bait stations' }, { database });
    expect(database).toHaveBeenCalledWith('blog_posts');
    expect(out.map((r) => r.path)).toEqual(['/termite/bait-stations/']);
    expect(out.some((r) => r.path.includes('termite-legacy-slug'))).toBe(false);
  });

  test('a DB read failure propagates (the caller is responsible for the fallback-to-empty catch)', async () => {
    const database = jest.fn(() => ({ select: jest.fn().mockRejectedValue(new Error('boom')) }));
    await expect(getRelatedPostsForBrief({ service: 'termite' }, { database })).rejects.toThrow('boom');
  });
});
