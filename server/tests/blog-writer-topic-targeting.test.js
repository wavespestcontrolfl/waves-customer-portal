/**
 * Idea lane — owner rulings 2026-08-27. Every generated idea passes the same
 * topic-targeting gate as the runner: geo on title/keyword/SLUG (an idea is a
 * title, so statewide framing is strict) and entity ownership against the
 * LIVE blog corpus, loaded before any LLM spend and fail-closed.
 */
const IN_WALL = {
  file: 'src/content/blog/pest-control/in-wall-pest-control.mdx',
  url: '/pest-control/in-wall-pest-control/',
  body: "---\ntitle: 'So…You’re Pumping Pesticides Into Your Walls on Purpose?'\nslug: /pest-control/in-wall-pest-control/\nmeta_description: What Taexx in-wall pest control actually pumps into your walls.\nprimary_keyword: in wall pest control\ncategory: pest-control\n---\n\n## What Is Taexx Pest Control?\n\n## So What Is the Taexx System Actually Doing?\n\n## Already Have Taexx? No Judgment.\n",
};

function makeDbMock({ post = null, updateResult = 1 } = {}) {
  const inserts = [];
  const updates = [];
  const dbMock = jest.fn((table) => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'select', 'whereNotNull', 'whereRaw', 'whereNot', 'whereNull', 'orWhere', 'orWhereNot', 'orWhereNotIn']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn().mockResolvedValue(table === 'blog_posts' ? post : null);
    chain.insert = jest.fn((row) => { inserts.push(row); return Promise.resolve([1]); });
    chain.update = jest.fn((patch) => { updates.push({ table, patch }); return Promise.resolve(updateResult); });
    chain.then = (resolve) => resolve([]);
    return chain;
  });
  dbMock._inserts = inserts;
  dbMock._updates = updates;
  return dbMock;
}

// Termite post that owns "bait" in its category; "bait" is common across
// pest-control posts, so only a same-category frequency finds the owner.
const TERMITE_BAIT = { url: '/termite/termite-bait-stations/', body: '---\ntitle: Termite Bait Stations Explained\nslug: /termite/termite-bait-stations/\nprimary_keyword: termite bait stations\ncategory: termite\n---\n## How bait stations work\n## When bait beats liquid\n' };
const PEST_BAITS = ['ant-bait-basics', 'roach-bait-gel', 'rodent-bait-safety'].map((leaf) => ({
  url: `/pest-control/${leaf}/`,
  body: `---\ntitle: ${leaf.replace(/-/g, ' ')}\nslug: /pest-control/${leaf}/\nprimary_keyword: ${leaf.replace(/-/g, ' ')}\ncategory: pest-control\n---\n`,
}));

function load({ ideas = [], corpus = [IN_WALL], corpusError = null, post = null, updateResult = 1 }) {
  jest.resetModules();
  const dbMock = makeDbMock({ post, updateResult });
  const dispatch = jest.fn().mockResolvedValue({ ok: true, json: ideas });
  jest.doMock('../models/db', () => dbMock);
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/llm/call', () => ({ dispatchWithFallback: dispatch }));
  jest.doMock('../services/content/internal-link-planner', () => ({
    loadAstroCorpusFromGitHub: corpusError ? jest.fn().mockRejectedValue(new Error(corpusError)) : jest.fn().mockResolvedValue(corpus),
  }));
  const writer = require('../services/content/blog-writer');
  return { writer, dbMock, dispatch };
}

const IDEAS = [
  { title: 'WDO Inspection Near Tampa: What to Expect', keyword: 'wdo inspection tampa', tag: 'termite', slug: 'wdo-inspection-tampa', city: 'Sarasota' },
  { title: 'What a WDO Inspection Actually Covers', keyword: 'wdo inspection checklist', tag: 'termite', slug: 'wdo-inspection-tampa', city: 'Sarasota' },
  { title: 'New-Construction Pest Control in Florida', keyword: 'new construction pest control', tag: 'pest control', slug: 'new-construction-pest-control-florida', city: 'Bradenton' },
  { title: 'Your New Lakewood Ranch Home Came With Taexx', keyword: 'taexx system lakewood ranch', tag: 'pest control', slug: 'lakewood-ranch-taexx', city: 'Lakewood Ranch' },
  { title: 'Ghost Ants in Sarasota Kitchens: Why They Keep Coming Back', keyword: 'ghost ants sarasota kitchen', tag: 'pest control', slug: 'ghost-ants-sarasota-kitchens', city: 'Sarasota' },
];

describe('blog-writer idea lane — topic-targeting gate', () => {
  test('rejects out-of-area (title OR slug), statewide-only, and owned-entity ideas; keeps the localized one', async () => {
    const { writer, dbMock } = load({ ideas: IDEAS });
    const accepted = await writer.generateNewIdeas(5);
    expect(accepted.map((a) => a.title)).toEqual(['Ghost Ants in Sarasota Kitchens: Why They Keep Coming Back']);
    expect(dbMock._inserts.map((r) => r.slug)).toEqual(['ghost-ants-sarasota-kitchens']);
  });

  test('ownership is judged in the category the idea TAG maps to (termite bait idea vs a termite owner, despite pest-control bait posts)', async () => {
    const { writer } = load({
      ideas: [{ title: 'Bait Station Costs for Sarasota Homes', keyword: 'bait station cost', tag: 'Termites', slug: 'bait-station-costs-sarasota', city: 'Sarasota' }],
      corpus: [IN_WALL, TERMITE_BAIT, ...PEST_BAITS],
    });
    await expect(writer.generateNewIdeas(1)).resolves.toEqual([]);
  });

  test('row → category is the publisher\'s own normalizeCategory (explicit category wins, then tag); an unmapped tag is null = conservative all-corpus ownership', () => {
    const { writer } = load({ ideas: [] });
    const { BLOG_TAGS, categoryForRow } = writer._internals;
    expect(categoryForRow({ category: 'termite', tag: 'Pest Control' })).toBe('termite');
    const mapped = Object.fromEntries(BLOG_TAGS.map((t) => [t, categoryForRow({ tag: t })]));
    expect(mapped).toEqual({
      Roaches: 'pest-control', Ants: 'pest-control', Rodents: 'pest-control', Termites: 'termite', Mosquitoes: 'mosquito',
      'Fleas & Ticks': 'pest-control', 'Stinging Insects': null, Spiders: 'pest-control', 'Bed Bugs': 'pest-control',
      'Lawn Disease': 'lawn-care', 'Lawn Pests': 'lawn-care', 'Lawn Care': 'lawn-care', 'Pest Control': 'pest-control',
    });
  });

  test('fails closed with no LLM spend when the live corpus is unavailable', async () => {
    const { writer, dbMock, dispatch } = load({ ideas: IDEAS, corpusError: 'github_down' });
    await expect(writer.generateNewIdeas(5)).resolves.toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(dbMock._inserts).toEqual([]);
  });

  test('fails closed on an empty corpus', async () => {
    const { writer, dispatch } = load({ ideas: IDEAS, corpus: [] });
    await expect(writer.generateNewIdeas(5)).resolves.toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('blog-writer generatePost — every persisted row is gated before writer spend', () => {
  const TAEXX_ROW = { id: 'post_1', title: 'Your New Lakewood Ranch Home Came With Taexx', keyword: 'taexx system lakewood ranch', tag: 'Pest Control', slug: 'lakewood-ranch-taexx', status: 'queued', content: null };

  test('a queued owned-entity row is de-queued (status → idea, reason recorded) and generation throws BLOG_TOPIC_TARGETING_BLOCKED with no LLM spend', async () => {
    const { writer, dbMock, dispatch } = load({ post: TAEXX_ROW });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
    expect(dispatch).not.toHaveBeenCalled();
    const patch = dbMock._updates.find((u) => u.table === 'blog_posts')?.patch;
    expect(patch.status).toBe('idea');
    expect(patch.astro_publish_error).toMatch(/^BLOG_TOPIC_TARGETING_BLOCKED: P0 TOPIC_CANNIBALIZES_EXISTING/);
  });

  test('the de-queue is a CAS: a row that entered the publish pipeline while the corpus loaded is left alone (409)', async () => {
    const { writer, dispatch } = load({ post: TAEXX_ROW, updateResult: 0 });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/entered the Astro pipeline while the topic gate ran/) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('an owned entity only in the TITLE (generic keyword) is still blocked', async () => {
    const { writer, dispatch } = load({ post: { ...TAEXX_ROW, keyword: 'new home pest control', slug: 'new-home-pest-control-lakewood-ranch' } });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('the row\'s explicit category outranks its tag when judging ownership', async () => {
    const { writer } = load({ post: { ...TAEXX_ROW, category: 'termite' } });
    const gate = require('../services/content/topic-targeting-gate');
    const spy = jest.spyOn(gate, 'evaluateBlogPostRow');
    await writer.generatePost('post_1').catch(() => null);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'post_1' }), { category: 'termite' });
  });

  test('corpus unavailable → generation throws (fail closed) and the row is left untouched', async () => {
    const { writer, dbMock, dispatch } = load({ post: TAEXX_ROW, corpusError: 'github_down' });
    await expect(writer.generatePost('post_1')).rejects.toThrow('github_down');
    expect(dispatch).not.toHaveBeenCalled();
    expect(dbMock._updates).toEqual([]);
  });

  test('a row already live on the hub is a refresh — exempt even with the corpus DOWN, proceeds to the writer', async () => {
    const { writer, dispatch } = load({ post: { ...TAEXX_ROW, astro_status: 'live' }, ideas: null, corpusError: 'github_down' });
    dispatch.mockResolvedValue({ ok: false, error: 'stop_here' });
    await writer.generatePost('post_1').catch(() => null);
    expect(dispatch).toHaveBeenCalled();
  });
});
