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
  getLiveRelatedPaths,
  candidateFromRow,
  candidateFromAutonomousRun,
  candidateFromRegistryRow,
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

  test('service aliases share the blog SEO contract identity without defaulting a missing entity to pest', () => {
    const generalPest = candidate({ category: 'Pest Control', path: '/pest-control/general-guide/', keyword: 'pest control in florida' });
    expect(rankRelatedPosts({ service: 'pest', keyword: 'pest control in Florida' }, [generalPest]))
      .toEqual([{ title: 'Untitled', path: '/pest-control/general-guide/', keyword: 'pest control in florida' }]);
    expect(rankRelatedPosts({ keyword: 'pest control in Florida' }, [generalPest])).toEqual([]);
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

  test('equal scores and titles use normalized path as a final deterministic tie-breaker', () => {
    const same = { title: 'Same', keyword: 'termite bait systems', service: 'termite' };
    const rows = rankRelatedPosts({ service: 'termite' }, [
      candidate({ ...same, id: 'b', path: '/termite/z-post/' }),
      candidate({ ...same, id: 'a', path: '/termite/a-post/' }),
    ]);
    expect(rows.map((row) => row.path)).toEqual(['/termite/a-post/', '/termite/z-post/']);
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

    test('a candidate with no domains is hub-only, never implicitly available on a spoke', () => {
      const candidates = [candidate({ service: 'termite', path: '/termite/legacy/', targetSites: [] })];
      expect(rankRelatedPosts({ service: 'termite' }, candidates)).toHaveLength(1);
      expect(rankRelatedPosts({ service: 'termite', domains: ['sarasotaflpestcontrol.com'] }, candidates)).toEqual([]);
    });

    test('an explicit spoke domain requires the candidate to render on THAT domain too', () => {
      const target = { service: 'termite', domains: ['sarasotaflpestcontrol.com'] };
      const candidates = [
        candidate({ id: 'right-spoke', service: 'termite', path: '/termite/sarasota-post/', targetSites: ['sarasotaflpestcontrol.com'] }),
        candidate({ id: 'wrong-spoke', service: 'termite', path: '/termite/venice-post/', targetSites: ['veniceflpestcontrol.com'] }),
        candidate({ id: 'hub-default', service: 'termite', path: '/termite/legacy/', targetSites: null }),
      ];
      const out = rankRelatedPosts(target, candidates).map((r) => r.path);
      expect(out).toEqual(['/termite/sarasota-post/']);
      expect(out).not.toContain('/termite/venice-post/');
      expect(out).not.toContain('/termite/legacy/');
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
    expect(c.astroStatus).toBe('live');
    expect(c.targetSites).toEqual(['wavespestcontrol.com']);
  });

  test('derives domain eligibility from the verified live URL, never stale target_sites', () => {
    const c = candidateFromRow({
      id: 'spoke-stale',
      title: 'Hub Post',
      status: 'published',
      astro_status: 'live',
      astro_live_url: '/termite/hub-post/',
      target_sites: ['sarasotaflpestcontrol.com'],
    });
    expect(c.targetSites).toEqual(['wavespestcontrol.com']);
    expect(rankRelatedPosts(
      { service: 'termite', domains: ['sarasotaflpestcontrol.com'] },
      [{ ...c, service: 'termite' }]
    )).toEqual([]);
  });

  test.each([
    ['https://www.wavespestcontrol.com/termite/hub-post/', 'wavespestcontrol.com'],
    ['https://www.sarasotaflpestcontrol.com/termite/spoke-post/', 'sarasotaflpestcontrol.com'],
  ])('derives the fleet domain from an absolute live URL (%s)', (astroLiveUrl, domain) => {
    const c = candidateFromRow({
      id: domain,
      title: 'Verified Post',
      status: 'published',
      astro_status: 'live',
      astro_live_url: astroLiveUrl,
      target_sites: ['veniceflpestcontrol.com'],
    });
    expect(c.targetSites).toEqual([domain]);
    expect(c.pathVerified).toBe(true);
  });

  test('rejects a verified URL outside the known content fleet', () => {
    const c = candidateFromRow({
      id: 'off-fleet',
      title: 'External Post',
      status: 'published',
      astro_status: 'live',
      astro_live_url: 'https://example.com/termite/post/',
    });
    expect(c.pathVerified).toBe(false);
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

describe('candidateFromAutonomousRun', () => {
  // Fields arrive pre-projected from SQL (Codex #4984 r6+ P2: never load the
  // full draft_payload JSONB blob for every historical run) — not a nested
  // draft_payload/frontmatter object.
  test('uses projected frontmatter and brief signals for a fleet URL', () => {
    expect(candidateFromAutonomousRun({
      id: 'run-1',
      published_url: 'https://www.wavespestcontrol.com/termite/autonomous-post/',
      brief_service: 'termite',
      frontmatter_title: 'Autonomous Termite Post',
      frontmatter_primary_keyword: 'termite mud tubes',
    })).toMatchObject({
      path: '/termite/autonomous-post/',
      service: 'termite',
      title: 'Autonomous Termite Post',
      keyword: 'termite mud tubes',
    });
  });

  test('falls back to the top-level payload title and brief/frontmatter service/city/category', () => {
    expect(candidateFromAutonomousRun({
      id: 'run-2',
      published_url: 'https://www.wavespestcontrol.com/termite/fallback-post/',
      payload_title: 'Top-Level Payload Title',
      frontmatter_first_area: 'Venice',
      frontmatter_service: 'termite',
      frontmatter_category: 'termite',
      brief_city: 'Sarasota',
    })).toMatchObject({
      title: 'Top-Level Payload Title',
      city: 'Venice',
      service: 'termite',
      category: 'termite',
    });
  });

  test('rejects an off-fleet absolute URL', () => {
    expect(candidateFromAutonomousRun({ published_url: 'https://example.com/post/' })).toBeNull();
  });
});

describe('candidateFromRegistryRow', () => {
  const liveAstroOnly = {
    id: 'registry-1',
    canonical_url_normalized: '/termite/direct-astro-post/',
    content_type: 'blog',
    reconciliation_status: 'astro_only',
    workflow_status: 'published',
    astro_status: 'present',
    live_status: 'live',
    noindex_detected: false,
    title: 'Direct Astro Termite Post',
    target_keyword: 'termite mud tubes',
    target_service: 'termite',
    metadata: { frontmatter: { domains: ['wavespestcontrol.com'] } },
  };

  test('accepts a verified live Astro-only blog and preserves its domain', () => {
    expect(candidateFromRegistryRow(liveAstroOnly)).toMatchObject({
      path: '/termite/direct-astro-post/',
      service: 'termite',
      targetSites: ['wavespestcontrol.com'],
      workflowStatus: 'published',
      astroStatus: 'live',
      pathVerified: true,
    });
  });

  // Codex #4984 r7 P2: a republish at the same URL flags the row
  // astro_changed_since_sync (content-registry.js's astro-item/no-db-match
  // branch — the SAME lineage as astro_only, never db_changed_since_sync,
  // which only a DB-matched row reaches and the blog_posts query already
  // covers) while its live-status fields stay accurate until the next sync.
  test('accepts an astro_changed_since_sync row exactly like astro_only, provided it is still published/present/live/indexable', () => {
    expect(candidateFromRegistryRow({
      ...liveAstroOnly,
      reconciliation_status: 'astro_changed_since_sync',
    })).toMatchObject({
      path: '/termite/direct-astro-post/',
      service: 'termite',
      targetSites: ['wavespestcontrol.com'],
      workflowStatus: 'published',
      astroStatus: 'live',
      pathVerified: true,
    });
  });

  test('still rejects an astro_changed_since_sync row that is no longer live/present/published/indexable', () => {
    for (const override of [
      { live_status: 'missing' },
      { astro_status: 'draft' },
      { workflow_status: 'draft' },
      { noindex_detected: true },
    ]) {
      expect(candidateFromRegistryRow({
        ...liveAstroOnly,
        reconciliation_status: 'astro_changed_since_sync',
        ...override,
      })).toBeNull();
    }
  });

  test('rejects an astro_changed_since_sync row that is DB-matched (db_blog_id set) — not Astro-only lineage', () => {
    expect(candidateFromRegistryRow({
      ...liveAstroOnly,
      reconciliation_status: 'astro_changed_since_sync',
      db_blog_id: 'blog-123',
    })).toBeNull();
  });

  test('rejects db_changed_since_sync — that status is only reachable from a DB-matched row the blog_posts query already covers', () => {
    expect(candidateFromRegistryRow({
      ...liveAstroOnly,
      reconciliation_status: 'db_changed_since_sync',
    })).toBeNull();
  });

  test.each([
    ['missing', {}],
    ['empty', { domains: [] }],
  ])('defaults %s Astro domains to hub-only and excludes the post from spokes', (_label, frontmatter) => {
    const c = candidateFromRegistryRow({
      ...liveAstroOnly,
      metadata: { frontmatter },
    });
    expect(c.targetSites).toEqual(['wavespestcontrol.com']);
    expect(rankRelatedPosts(
      { service: 'termite', domains: ['sarasotaflpestcontrol.com'] },
      [c]
    )).toEqual([]);
  });

  test.each([
    ['missing', {}],
    ['empty', { domains: [] }],
  ])('does not admit an absolute spoke URL when %s renderer domains default to hub', (_label, frontmatter) => {
    expect(candidateFromRegistryRow({
      ...liveAstroOnly,
      canonical_url_normalized: 'https://www.sarasotaflpestcontrol.com/termite/direct-astro-post/',
      metadata: { frontmatter },
    })).toBeNull();
  });

  test('uses tracking.domains when top-level domains are absent', () => {
    expect(candidateFromRegistryRow({
      ...liveAstroOnly,
      live_url: '/termite/direct-astro-post/',
      canonical_url: 'https://www.sarasotaflpestcontrol.com/canonical-post/',
      metadata: { frontmatter: { tracking: { domains: ['sarasotaflpestcontrol.com'] } } },
    })).toMatchObject({
      path: '/termite/direct-astro-post/',
      targetSites: ['sarasotaflpestcontrol.com'],
    });
  });

  test('rejects a spoke-configured row when only its relative hub URL was checked', () => {
    expect(candidateFromRegistryRow({
      ...liveAstroOnly,
      metadata: { frontmatter: { domains: ['sarasotaflpestcontrol.com'] } },
    })).toBeNull();
  });

  test.each([
    ['not Astro-only', { reconciliation_status: 'matched' }],
    ['not live', { live_status: 'missing' }],
    ['not published', { workflow_status: 'draft' }],
    ['not a blog', { content_type: 'page' }],
    ['noindexed', { noindex_detected: true }],
    ['off-fleet canonical', { canonical_url_normalized: 'https://example.com/termite/post/' }],
  ])('rejects %s registry rows', (_label, override) => {
    expect(candidateFromRegistryRow({ ...liveAstroOnly, ...override })).toBeNull();
  });
});

describe('getRelatedPostsForBrief — DB wrapper', () => {
  function fakeDb({ blogRows = [], autonomousRows = [], registryRows = [] } = {}) {
    const autonomousQuery = {};
    autonomousQuery.leftJoin = jest.fn(() => autonomousQuery);
    autonomousQuery.where = jest.fn(() => autonomousQuery);
    autonomousQuery.whereNotNull = jest.fn(() => autonomousQuery);
    autonomousQuery.select = jest.fn().mockResolvedValue(autonomousRows);
    const database = jest.fn((table) => {
      if (table === 'blog_posts') return { select: jest.fn().mockResolvedValue(blogRows) };
      if (table === 'content_registry') return { select: jest.fn().mockResolvedValue(registryRows) };
      if (table === 'autonomous_runs') return autonomousQuery;
      throw new Error(`unexpected table: ${table}`);
    });
    // The autonomous-run query projects frontmatter_*/payload_title fields
    // via db.raw(...) instead of selecting the whole draft_payload column
    // (Codex #4984 r6+ P2) — a passthrough is enough since these fixtures
    // supply the already-projected row shape directly.
    database.raw = jest.fn((sql) => sql);
    database.autonomousQuery = autonomousQuery;
    return database;
  }

  test('combines verified-live DB and Astro-only registry posts', async () => {
    const rows = [
      { id: 'a', title: 'Termite Bait Stations Explained', keyword: 'termite bait stations', tag: 'Termites', category: 'termite', slug: 'bait-stations', city: null, target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/termite/bait-stations/' },
      { id: 'b', title: 'Queued Termite Draft', keyword: 'termite draft', tag: 'Termites', category: 'termite', slug: 'queued-draft', city: null, target_sites: null, status: 'queued', astro_status: 'draft', astro_live_url: null },
      { id: 'c', title: 'Unrelated Rodent Post', keyword: 'rats in attic', tag: 'Rodents', category: 'rodent', slug: 'attic-noises', city: null, target_sites: null, status: 'published', astro_status: 'live', astro_live_url: '/rodent/attic-noises/' },
      // The exact garage-door incident shape (migration 20260830000030):
      // status='published' but no astro_live_url — the bare-slug guess is
      // NOT the real category-prefixed route. Must be excluded even though
      // workflowStatus normalizes to 'published'.
      { id: 'd', title: 'Legacy Termite Post (unverified slug)', keyword: 'termite legacy post', tag: 'Termites', category: 'termite', slug: 'termite-legacy-slug', city: null, target_sites: null, status: 'published', astro_status: 'draft', astro_live_url: null },
      // Merge-time stamps are insufficient: until the production poll marks
      // astro_status live, the URL may still 404 or serve an older build.
      { id: 'e', title: 'Merged But Build Failed', keyword: 'termite failed build', tag: 'Termites', category: 'termite', slug: 'failed-build', city: null, target_sites: null, status: 'published', astro_status: 'build_failed', astro_live_url: '/termite/failed-build/' },
    ];
    const registryRows = [{
      id: 'registry-db-a',
      canonical_url_normalized: '/termite/bait-stations/',
      content_type: 'blog',
      reconciliation_status: 'matched',
      workflow_status: 'published',
      astro_status: 'present',
      live_status: 'live',
      noindex_detected: false,
    }, {
      id: 'registry-1',
      canonical_url_normalized: '/termite/direct-astro-post/',
      content_type: 'blog',
      reconciliation_status: 'astro_only',
      workflow_status: 'published',
      astro_status: 'present',
      live_status: 'live',
      noindex_detected: false,
      title: 'Direct Astro Termite Post',
      target_keyword: 'termite bait placement',
      target_service: 'termite',
      metadata: { frontmatter: {} },
    }];
    const database = fakeDb({ blogRows: rows, registryRows });
    const out = await getRelatedPostsForBrief({ service: 'termite', keyword: 'termite bait stations' }, { database });
    expect(database).toHaveBeenCalledWith('blog_posts');
    expect(database).toHaveBeenCalledWith('content_registry');
    expect(out.map((r) => r.path)).toEqual([
      '/termite/bait-stations/',
      '/termite/direct-astro-post/',
    ]);
    expect(out.some((r) => r.path.includes('termite-legacy-slug'))).toBe(false);
    expect(out.some((r) => r.path.includes('failed-build'))).toBe(false);
  });

  test('getLiveRelatedPaths keeps only frozen paths that are still verified live', async () => {
    const registryRows = [{
      id: 'registry-1',
      canonical_url_normalized: '/termite/direct-astro-post/',
      content_type: 'blog',
      reconciliation_status: 'astro_only',
      workflow_status: 'published',
      astro_status: 'present',
      live_status: 'live',
      noindex_detected: false,
      title: 'Direct Astro Termite Post',
      metadata: { frontmatter: {} },
    }];
    const database = fakeDb({ registryRows });
    const live = await getLiveRelatedPaths(['/termite/direct-astro-post/', '/termite/unpublished-since/'], { database });
    expect([...live]).toEqual(['/termite/direct-astro-post/']);
    expect([...(await getLiveRelatedPaths([], { database }))]).toEqual([]);
  });

  test('getLiveRelatedPaths sees every host when two live rows share a pathname', async () => {
    const base = {
      canonical_url_normalized: '/termite/shared-path/',
      content_type: 'blog',
      reconciliation_status: 'astro_only',
      workflow_status: 'published',
      astro_status: 'present',
      live_status: 'live',
      noindex_detected: false,
      title: 'Shared Path Post',
    };
    const registryRows = [
      { ...base, id: 'hub-row', metadata: { frontmatter: {} } },
      { ...base, id: 'spoke-row', live_url: 'https://www.sarasotaflpestcontrol.com/termite/shared-path/', metadata: { frontmatter: { domains: ['sarasotaflpestcontrol.com'] } } },
    ];
    for (const rows of [registryRows, [...registryRows].reverse()]) {
      const database = fakeDb({ registryRows: rows });
      expect([...(await getLiveRelatedPaths(['/termite/shared-path/'], { database, hosts: ['wavespestcontrol.com'] }))]).toEqual(['/termite/shared-path/']);
      expect([...(await getLiveRelatedPaths(['/termite/shared-path/'], { database, hosts: ['sarasotaflpestcontrol.com'] }))]).toEqual(['/termite/shared-path/']);
    }
  });

  test('a spoke brief still gets its spoke row when a hub row shares the pathname', async () => {
    const base = {
      canonical_url_normalized: '/termite/shared-path/',
      content_type: 'blog',
      reconciliation_status: 'astro_only',
      workflow_status: 'published',
      astro_status: 'present',
      live_status: 'live',
      noindex_detected: false,
      title: 'Termite swarm season guide',
      target_keyword: 'termite swarm season',
      target_service: 'termite',
    };
    const registryRows = [
      { ...base, id: 'hub-row', metadata: { frontmatter: {} } },
      { ...base, id: 'spoke-row', live_url: 'https://www.sarasotaflpestcontrol.com/termite/shared-path/', metadata: { frontmatter: { domains: ['sarasotaflpestcontrol.com'] } } },
    ];
    for (const rows of [registryRows, [...registryRows].reverse()]) {
      const out = await getRelatedPostsForBrief(
        { service: 'termite', keyword: 'termite swarm season', domains: ['sarasotaflpestcontrol.com'] },
        { database: fakeDb({ registryRows: rows }) }
      );
      expect(out.map((r) => r.path)).toEqual(['/termite/shared-path/']);
    }
  });

  test('getLiveRelatedPaths requires the path to be live on the frozen publish host', async () => {
    // The selected hub post has since moved to a spoke: its path is still
    // live in the fleet, but not on the hub the draft publishes to.
    const registryRows = [{
      id: 'registry-moved',
      canonical_url_normalized: '/termite/moved-post/',
      live_url: 'https://www.sarasotaflpestcontrol.com/termite/moved-post/',
      content_type: 'blog',
      reconciliation_status: 'astro_only',
      workflow_status: 'published',
      astro_status: 'present',
      live_status: 'live',
      noindex_detected: false,
      title: 'Moved Termite Post',
      metadata: { frontmatter: { domains: ['sarasotaflpestcontrol.com'] } },
    }];
    const database = fakeDb({ registryRows });
    expect([...(await getLiveRelatedPaths(['/termite/moved-post/'], { database, hosts: ['wavespestcontrol.com'] }))]).toEqual([]);
    expect([...(await getLiveRelatedPaths(['/termite/moved-post/'], { database, hosts: ['sarasotaflpestcontrol.com'] }))]).toEqual(['/termite/moved-post/']);
  });

  test('matches current registry health to an absolute spoke URL by domain and path', async () => {
    const spoke = 'sarasotaflpestcontrol.com';
    const path = '/termite/spoke-live/';
    const blogRows = [{
      id: 'spoke-db', title: 'Spoke Termite Post', keyword: 'termite damage inspection',
      category: 'termite', status: 'published', astro_status: 'live',
      astro_live_url: `https://www.${spoke}${path}`,
    }];
    const registryRows = [{
      id: 'registry-spoke', canonical_url_normalized: `https://www.${spoke}${path}`,
      content_type: 'blog', reconciliation_status: 'matched', workflow_status: 'published',
      astro_status: 'present', live_status: 'live', noindex_detected: false,
      metadata: { astro: { frontmatter: { domains: [spoke] } } },
    }];

    const out = await getRelatedPostsForBrief(
      { service: 'termite', keyword: 'termite damage inspection', domains: [spoke] },
      { database: fakeDb({ blogRows, registryRows }) }
    );

    expect(out.map((candidate) => candidate.path)).toEqual([path]);
  });

  test('excludes a historically live DB post when current registry health is missing', async () => {
    const blogRows = [{
      id: 'stale-db', title: 'Stale Termite Post', keyword: 'termite damage inspection',
      category: 'termite', slug: 'stale', status: 'published', astro_status: 'live',
      astro_live_url: '/termite/stale/',
    }];
    const registryRows = [{
      id: 'registry-stale', canonical_url_normalized: '/termite/stale/', content_type: 'blog',
      reconciliation_status: 'matched', workflow_status: 'published', astro_status: 'present',
      live_status: 'missing', noindex_detected: false,
    }];

    await expect(getRelatedPostsForBrief(
      { service: 'termite', keyword: 'termite damage inspection' },
      { database: fakeDb({ blogRows, registryRows }) }
    )).resolves.toEqual([]);
  });

  test('admits completed autonomous posts only through matching current live registry truth', async () => {
    const autonomousRows = [
      { id: 'live-run', published_url: 'https://www.wavespestcontrol.com/termite/live-run/', brief_service: 'rodent', frontmatter_title: 'Old Rodent Title', frontmatter_primary_keyword: 'old rodent topic' },
      { id: 'stale-run', published_url: 'https://www.wavespestcontrol.com/termite/stale-run/', brief_service: 'termite', frontmatter_title: 'Stale Run' },
      { id: 'missing-run', published_url: 'https://www.wavespestcontrol.com/termite/missing-run/', brief_service: 'termite', frontmatter_title: 'Missing Run' },
    ];
    const baseRegistry = {
      content_type: 'blog', reconciliation_status: 'astro_only', workflow_status: 'published',
      astro_status: 'present', live_status: 'live', noindex_detected: false,
      target_service: 'termite', metadata: { frontmatter: { domains: ['wavespestcontrol.com'] } },
    };
    const registryRows = [
      { ...baseRegistry, id: 'live-registry', canonical_url_normalized: '/termite/live-run/', title: 'Current Termite Title', target_keyword: 'current termite topic', target_service: 'termite' },
      { ...baseRegistry, id: 'stale-registry', canonical_url_normalized: '/termite/stale-run/', live_status: 'missing' },
    ];
    const database = fakeDb({ autonomousRows, registryRows });

    const out = await getRelatedPostsForBrief({ service: 'termite' }, { database });

    expect(out.map((candidate) => candidate.path)).toEqual(['/termite/live-run/']);
    expect(out[0]).toMatchObject({
      title: 'Current Termite Title',
      keyword: 'current termite topic',
      path: '/termite/live-run/',
    });
  });

  test('uses current registry domains for an autonomous path', async () => {
    const autonomousRows = [{ id: 'run', published_url: 'https://www.wavespestcontrol.com/termite/domain-run/', brief_service: 'termite' }];
    const registryRows = [{
      id: 'registry', canonical_url_normalized: '/termite/domain-run/', content_type: 'blog',
      reconciliation_status: 'astro_only', workflow_status: 'published', astro_status: 'present',
      live_status: 'live', noindex_detected: false, target_service: 'termite',
      metadata: { frontmatter: { domains: ['sarasotaflpestcontrol.com'] } },
    }];
    const database = fakeDb({ autonomousRows, registryRows });

    await expect(getRelatedPostsForBrief(
      { service: 'termite', domains: ['wavespestcontrol.com'] },
      { database }
    )).resolves.toEqual([]);
  });

  test('never donates a stale run\'s metadata to an unrelated page that reused its pathname on another domain (Codex #4984 r6+ P2)', async () => {
    const spoke = 'sarasotaflpestcontrol.com';
    const path = '/lawn-care/shared-slug/';
    // A hub run once published at this SAME pathname; the slug was later
    // reused on a completely different spoke page. Path-only matching would
    // let the hub run's own keyword (a fallback field the registry lacks)
    // leak onto the unrelated spoke page.
    const autonomousRows = [{
      id: 'hub-old-run', published_url: `https://www.wavespestcontrol.com${path}`,
      brief_service: 'rodent', frontmatter_primary_keyword: 'old hub rodent topic',
    }];
    const registryRows = [{
      id: 'spoke-registry', canonical_url_normalized: `https://www.${spoke}${path}`,
      content_type: 'blog', reconciliation_status: 'astro_only', workflow_status: 'published',
      astro_status: 'present', live_status: 'live', noindex_detected: false,
      title: 'Current Spoke Lawn Post', target_service: 'lawn',
      // No target_keyword: the merge loop would otherwise mask the bug by
      // always overwriting candidate.keyword with the registry's own value.
      metadata: { frontmatter: { domains: [spoke] } },
    }];
    const database = fakeDb({ autonomousRows, registryRows });

    const out = await getRelatedPostsForBrief({ service: 'lawn', domains: [spoke] }, { database });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path, title: 'Current Spoke Lawn Post' });
    expect(out[0].keyword).not.toBe('old hub rodent topic');
  });

  test('keeps only the newest completed run for a re-published domain+path before ranking (Codex #4984 r6+ P2)', async () => {
    const path = '/termite/republished/';
    const autonomousRows = [
      { id: 'older-run', published_url: `https://www.wavespestcontrol.com${path}`, brief_service: 'termite', completed_at: '2026-01-01T00:00:00Z', frontmatter_primary_keyword: 'old topic version' },
      { id: 'newer-run', published_url: `https://www.wavespestcontrol.com${path}`, brief_service: 'termite', completed_at: '2026-06-01T00:00:00Z', frontmatter_primary_keyword: 'new topic version' },
    ];
    const registryRows = [{
      id: 'registry-republished', canonical_url_normalized: path, content_type: 'blog',
      reconciliation_status: 'astro_only', workflow_status: 'published', astro_status: 'present',
      live_status: 'live', noindex_detected: false, title: 'Current Registry Title', target_service: 'termite',
      // No target_keyword: whichever run's keyword survives dedup is the
      // one that reaches the final candidate — the test signal.
      metadata: { frontmatter: {} },
    }];
    const database = fakeDb({ autonomousRows, registryRows });

    const out = await getRelatedPostsForBrief({ service: 'termite' }, { database });

    expect(out).toHaveLength(1);
    expect(out[0].keyword).toBe('new topic version');
  });

  test('a DB read failure propagates (the caller is responsible for the fallback-to-empty catch)', async () => {
    const database = jest.fn(() => ({ select: jest.fn().mockRejectedValue(new Error('boom')) }));
    await expect(getRelatedPostsForBrief({ service: 'termite' }, { database })).rejects.toThrow('boom');
  });
});
