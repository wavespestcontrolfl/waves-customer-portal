/**
 * Idea lane — owner rulings 2026-08-27. Every generated idea passes the same
 * topic-targeting gate as the runner: geo on title/keyword/SLUG (an idea is a
 * title, so statewide framing is strict) and entity ownership against the
 * LIVE blog corpus, loaded before any LLM spend and fail-closed.
 */
const IN_WALL = {
  file: 'src/content/blog/pest-control/in-wall-pest-control.mdx',
  url: '/pest-control/in-wall-pest-control/',
  body: "---\ntitle: 'So…You’re Pumping Pesticides Into Your Walls on Purpose?'\nslug: /pest-control/in-wall-pest-control/\nmeta_description: What Taexx in-wall pest control actually pumps into your walls.\nprimary_keyword: in wall pest control\ncategory: pest-control\n---\n\nBuilders install Taexx during framing. The Taexx tubes run inside the walls, and most owners never see Taexx work.\n\n## What Is Taexx Pest Control?\n\n## So What Is the Taexx System Actually Doing?\n\n## Already Have Taexx? No Judgment.\n",
};

function makeDbMock({ post = null, updateResult = 1 } = {}) {
  const inserts = [];
  const updates = [];
  const dbMock = jest.fn((table) => {
    const chain = {};
    for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'select', 'whereNotNull', 'whereRaw', 'whereNot', 'whereNull', 'orWhere', 'orWhereNot', 'orWhereNotIn']) chain[m] = jest.fn(() => chain);
    chain.first = jest.fn().mockImplementation(() => Promise.resolve(table === 'blog_posts' ? (typeof post === 'function' ? post() : post) : null));
    chain.insert = jest.fn((row) => { inserts.push(row); return Promise.resolve([1]); });
    chain.update = jest.fn((patch) => { updates.push({ table, patch }); return Promise.resolve(updateResult); });
    chain.then = (resolve) => resolve([]);
    return chain;
  });
  dbMock._inserts = inserts;
  dbMock._updates = updates;
  return dbMock;
}

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

describe('blog-writer row → category', () => {
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

  test('the de-queue is fenced on the targeting columns: a row an operator edited while the corpus loaded is left alone (409, distinct message)', async () => {
    let reads = 0;
    const post = () => (reads++ === 0 ? TAEXX_ROW : { ...TAEXX_ROW, title: 'Ghost Ants in Sarasota Kitchens', keyword: 'ghost ants sarasota' });
    const { writer, dbMock } = load({ post, updateResult: 0 });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/targeting was edited while the topic gate ran/) });
    // The fenced CAS was attempted once (0 rows); nothing else was written.
    expect(dbMock._updates).toHaveLength(1);
    expect(dbMock._updates[0].patch.status).toBe('idea');
  });

  test('the updated_at fence compares at DB millisecond precision, not Date equality (PR codex r15)', async () => {
    const stamped = { ...TAEXX_ROW, updated_at: new Date('2026-08-28T05:00:00.123Z') };
    const { writer, dbMock } = load({ post: stamped });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
    // The de-queue succeeded (status → idea), and the fence used date_trunc rather than where('updated_at', Date).
    const patch = dbMock._updates.find((u) => u.patch.status === 'idea');
    expect(patch).toBeDefined();
    const chainCalls = dbMock.mock.results.map((r) => r.value);
    const rawCalls = chainCalls.flatMap((c) => c.whereRaw.mock.calls);
    expect(rawCalls.some(([sql, binds]) => /date_trunc\('milliseconds', updated_at\) = \?/.test(sql) && binds[0] instanceof Date)).toBe(true);
    const plainUpdatedAt = chainCalls.flatMap((c) => c.where.mock.calls).some(([col]) => col === 'updated_at');
    expect(plainUpdatedAt).toBe(false);
  });

  test('the fence covers meta_description / content / secondary_keywords too (hook, PR codex r8 push)', async () => {
    let reads = 0;
    const post = () => (reads++ === 0 ? TAEXX_ROW : { ...TAEXX_ROW, meta_description: 'Rewritten by the operator mid-gate.' });
    const { writer } = load({ post, updateResult: 0 });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/targeting was edited while the topic gate ran/) });
    reads = 0;
    const post2 = () => (reads++ === 0 ? TAEXX_ROW : { ...TAEXX_ROW, secondary_keywords: ['ghost ants'] });
    const { writer: w2 } = load({ post: post2, updateResult: 0 });
    await expect(w2.generatePost('post_1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/targeting was edited/) });
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
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'post_1' }), expect.objectContaining({ category: 'termite' }));
  });

  test('generated content is fenced on the targeting snapshot: a row re-targeted while the LLM ran gets a 409, nothing overwritten (hook r31 P1)', async () => {
    const snapshot = { ...TAEXX_ROW, keyword: 'palm weevil sarasota', title: 'Palm Weevils in Sarasota', slug: 'palm-weevils-sarasota' };
    let reads = 0;
    // First read = the snapshot the gate + LLM use; later reads = the operator's edit.
    const { writer, dbMock, dispatch } = load({ post: () => (reads++ === 0 ? snapshot : { ...snapshot, title: 'Palm Weevils in Venice', city: 'Venice' }), ideas: null, updateResult: 0 });
    dispatch.mockResolvedValue({ ok: true, text: '## Palm weevils\n\nBody text for the post.' });
    await expect(writer.generatePost('post_1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/targeting was edited while content was generating/) });
    // The write was attempted (and CAS-refused) — never an unconditional overwrite.
    expect(dbMock._updates.some((u) => u.patch.content)).toBe(true);
  });

  test('a pre-loaded live index (bulk generation) is passed to the gate, so the corpus is not re-fetched per post (codex r30)', async () => {
    const { writer, dispatch } = load({ post: { ...TAEXX_ROW, keyword: 'palm weevil sarasota', title: 'Palm Weevils in Sarasota', slug: 'palm-weevils-sarasota' }, ideas: null, corpusError: 'github_down' });
    const gate = require('../services/content/topic-targeting-gate');
    const index = gate.indexCorpus([{ url: '/lawn-care/sod-webworms/', body: '---\ntitle: Sod Webworms\nslug: /lawn-care/sod-webworms/\nprimary_keyword: sod webworms\ncategory: lawn-care\n---\n\ntext\n' }]);
    const spy = jest.spyOn(gate, 'evaluateBlogPostRow');
    dispatch.mockResolvedValue({ ok: false, error: 'stop_here' });
    await writer.generatePost('post_1', { index }).catch(() => null);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'post_1' }), expect.objectContaining({ index }));
    // The corpus is DOWN in this rig — with the batch index the gate never needed it.
    expect(dispatch).toHaveBeenCalled();
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

describe('PR codex r17: generation topic block is an operational 400', () => {
  test('the thrown error carries statusCode 400 + isOperational so the admin generate endpoint returns the finding, not a 500', async () => {
    const row = { id: 'post_1', title: 'Your New Lakewood Ranch Home Came With Taexx', keyword: 'taexx system lakewood ranch', tag: 'Pest Control', slug: 'lakewood-ranch-taexx', status: 'draft', content: '## Body\n\nprose', astro_status: null };
    const { writer } = load({ post: row });
    const err = await writer.generatePost('post_1').catch((e) => e);
    expect(err).toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED', statusCode: 400, isOperational: true });
    expect(Array.isArray(err.details)).toBe(true);
  });
});
