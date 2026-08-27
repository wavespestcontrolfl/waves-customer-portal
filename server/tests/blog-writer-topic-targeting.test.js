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

function makeDbMock() {
  const inserts = [];
  const dbMock = jest.fn(() => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'select', 'whereNotNull']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn().mockResolvedValue(null);
    chain.insert = jest.fn((row) => { inserts.push(row); return Promise.resolve([1]); });
    chain.then = (resolve) => resolve([]);
    return chain;
  });
  dbMock._inserts = inserts;
  return dbMock;
}

// Termite post that owns "bait" in its category; "bait" is common across
// pest-control posts, so only a same-category frequency finds the owner.
const TERMITE_BAIT = { url: '/termite/termite-bait-stations/', body: '---\ntitle: Termite Bait Stations Explained\nslug: /termite/termite-bait-stations/\nprimary_keyword: termite bait stations\ncategory: termite\n---\n## How bait stations work\n## When bait beats liquid\n' };
const PEST_BAITS = ['ant-bait-basics', 'roach-bait-gel', 'rodent-bait-safety'].map((leaf) => ({
  url: `/pest-control/${leaf}/`,
  body: `---\ntitle: ${leaf.replace(/-/g, ' ')}\nslug: /pest-control/${leaf}/\nprimary_keyword: ${leaf.replace(/-/g, ' ')}\ncategory: pest-control\n---\n`,
}));

function load({ ideas, corpus = [IN_WALL], corpusError = null }) {
  jest.resetModules();
  const dbMock = makeDbMock();
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

  test('tag → category mapping covers the closed tag set', () => {
    const { writer } = load({ ideas: [] });
    const { BLOG_TAGS, tagToCategory } = writer._internals;
    expect(new Set(BLOG_TAGS.map(tagToCategory))).toEqual(new Set(['termite', 'mosquito', 'lawn-care', 'pest-control']));
    expect(tagToCategory('Termites')).toBe('termite');
    expect(tagToCategory('Ants')).toBe('pest-control');
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
