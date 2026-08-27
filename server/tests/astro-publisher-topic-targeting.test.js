/**
 * publishAstro — topic-targeting gate (owner rulings 2026-08-27) runs first
 * inside the publish try, before hero/LLM/GitHub work, for NEW posts only.
 * A block throws BLOG_TOPIC_TARGETING_BLOCKED (deterministic → the calendar
 * scheduler parks it) and the row is stamped publish_failed with the reason.
 */
const IN_WALL = {
  file: 'src/content/blog/pest-control/in-wall-pest-control.mdx',
  url: '/pest-control/in-wall-pest-control/',
  body: "---\ntitle: 'So…You’re Pumping Pesticides Into Your Walls on Purpose?'\nslug: /pest-control/in-wall-pest-control/\nmeta_description: What Taexx in-wall pest control actually pumps into your walls.\nprimary_keyword: in wall pest control\ncategory: pest-control\n---\n\n## What Is Taexx Pest Control?\n\n## So What Is the Taexx System Actually Doing?\n\n## Already Have Taexx? No Judgment.\n",
};

function load({ post, corpus = [IN_WALL], corpusError = null }) {
  jest.resetModules();
  const updates = [];
  const dbMock = jest.fn((table) => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'select', 'whereNull', 'whereNotNull']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn().mockResolvedValue(table === 'blog_posts' ? post : null);
    chain.update = jest.fn((patch) => { updates.push({ table, patch }); return Promise.resolve(1); });
    chain.then = (resolve) => resolve([]);
    return chain;
  });
  dbMock.raw = jest.fn();
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  jest.doMock('../services/content-astro/github-client', () => ({ getFile: jest.fn().mockResolvedValue(null), listDirectory: jest.fn().mockResolvedValue([]) }));
  const loader = corpusError ? jest.fn().mockRejectedValue(new Error(corpusError)) : jest.fn().mockResolvedValue(corpus);
  jest.doMock('../services/content/internal-link-planner', () => ({ loadAstroCorpusFromGitHub: loader }));
  const pub = require('../services/content-astro/astro-publisher');
  return { pub, updates, loader };
}

const TAEXX_ROW = { id: 'post_1', title: 'Your New Lakewood Ranch Home Came With Taexx', keyword: 'taexx system lakewood ranch', tag: 'Pest Control', slug: 'lakewood-ranch-taexx', status: 'draft', content: '## Body\n\nprose', astro_status: null, featured_image_url: null };

describe('publishAstro — topic-targeting gate', () => {
  test('a NEW owned-entity post is blocked before any publish work: BLOG_TOPIC_TARGETING_BLOCKED + publish_failed stamped with the reason', async () => {
    const { pub, updates } = load({ post: TAEXX_ROW });
    await expect(pub.publishAstro('post_1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
    const patch = updates.find((u) => u.table === 'blog_posts' && u.patch.astro_status === 'publish_failed')?.patch;
    expect(patch).toBeDefined();
    expect(patch.astro_publish_error).toMatch(/P0 TOPIC_CANNIBALIZES_EXISTING/);
    expect(patch.astro_publish_error).toMatch(/in-wall-pest-control/);
  });

  test('a statewide-only NEW post is blocked the same way', async () => {
    const { pub } = load({ post: { ...TAEXX_ROW, title: 'New-Construction Pest Control in Florida', keyword: 'new construction pest control', slug: 'new-construction-pest-control-florida' } });
    await expect(pub.publishAstro('post_1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
  });

  test('a post already live on the hub is a refresh — exempt from the gate even when the corpus is DOWN', async () => {
    const { pub, updates } = load({ post: { ...TAEXX_ROW, astro_status: 'live', astro_live_url: 'https://www.wavespestcontrol.com/pest-control/lakewood-ranch-taexx/' }, corpusError: 'github_down' });
    // Fails later on hero/GitHub plumbing this harness does not provide — what is pinned is that the failure is NOT the topic gate.
    const err = await pub.publishAstro('post_1').catch((e) => e);
    expect(err?.code).not.toBe('BLOG_TOPIC_TARGETING_BLOCKED');
    expect(String(err?.message || '')).not.toMatch(/github_down/);
    expect(updates.some((u) => /TOPIC_|github_down/.test(String(u.patch.astro_publish_error || '')))).toBe(false);
  });

  test('normalizeCategory is exported for the legacy blog_posts producers (single tag→category source)', () => {
    const { pub } = load({ post: TAEXX_ROW });
    expect(pub.normalizeCategory(null, 'Termites')).toBe('termite');
    expect(pub.normalizeCategory(null, 'Lawn Pests')).toBe('lawn-care');
    expect(pub.normalizeCategory(null, 'Mosquitoes')).toBe('mosquito');
    expect(pub.normalizeCategory(null, 'Roaches')).toBe('pest-control');
  });
});
