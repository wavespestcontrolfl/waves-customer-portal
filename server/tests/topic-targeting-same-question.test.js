/**
 * Same-question rule of the topic-targeting gate (owner 2026-10-30, "all").
 *
 * Evidence: the engine published /pest-control/millipede-vs-centipede-southwest-florida/
 * (2026-10-20) and /pest-control/florida-millipedes-southwest-florida/ (2026-10-28,
 * keyword "florida millipede") 8 days apart. The entity rule only owns rare
 * proper nouns; this rule asks whether a live post's title / slug / primary
 * keyword already holds every topic word of the brief's keyword.
 */

const gate = require('../services/content/topic-targeting-gate');

function post(url, title, keyword, extra = '') {
  const slug = url.replace(/^\/|\/$/g, '');
  return { url, path: `src/content/blog/${slug}.mdx`, body: `---\ntitle: "${title}"\nslug: ${url}\nprimary_keyword: ${keyword}\ncategory: pest-control\n${extra}---\n\nBody text.\n` };
}

const MILLIPEDE = post('/pest-control/millipede-vs-centipede-southwest-florida/', 'Millipede vs Centipede in Southwest Florida: Which One Is in Your House?', 'millipede vs centipede');
const GERMAN = post('/pest-control/get-rid-of-german-cockroaches/', 'How to Get Rid of German Cockroaches', 'german cockroach');
const TERMITE = post('/termite/termite-swarm-season/', 'Termite Swarm Season in Sarasota', 'termite swarm');
const GHOST = post('/pest-control/ghost-ants-in-the-kitchen/', 'Ghost Ants in the Kitchen', 'ghost ants');

const candidate = (query, over = {}) => ({ actionType: 'new_supporting_blog', pageType: 'supporting-blog', query, ...over });
const run = (corpus, c) => gate.evaluateSameQuestion(c, { index: gate.indexCorpus(corpus) });

describe('evaluateSameQuestion', () => {
  test('"florida millipede" vs a corpus holding the millipede-vs-centipede post → that post is the owner', () => {
    const r = run([MILLIPEDE, GERMAN], candidate('florida millipede'));
    expect(r.applicable).toBe(true);
    expect(r.would_block).toBe(true);
    expect(r.reason).toBe('owner_found');
    expect(r.tokens).toEqual(['millipede']);
    expect(r.owner.url).toBe('/pest-control/millipede-vs-centipede-southwest-florida/');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ code: 'TOPIC_SAME_QUESTION_LIVE', severity: 'P0', owner_url: '/pest-control/millipede-vs-centipede-southwest-florida/', tokens: ['millipede'] });
  });

  test('plural and geo words fold: "millipedes in Bradenton, Florida" finds the same owner', () => {
    const r = run([MILLIPEDE], candidate('millipedes in bradenton florida'));
    expect(r.would_block).toBe(true);
    expect(r.tokens).toEqual(['millipede']);
  });

  test('"cockroach types in florida" vs a corpus with only the German cockroach post → no block (broad one-word topic)', () => {
    const r = run([GERMAN], candidate('cockroach types in florida'));
    expect(r.would_block).toBe(false);
    expect(r.reason).toBe('broad_single_word');
    expect(r.findings).toEqual([]);
  });

  test('a generic one-word topic never blocks, even with a single holder ("termite", "lawn", "ant")', () => {
    expect(run([TERMITE], candidate('termite')).would_block).toBe(false);
    expect(run([TERMITE], candidate('termites in florida')).reason).toBe('broad_single_word');
    expect(run([GHOST], candidate('ants')).would_block).toBe(false);
    expect(run([GHOST], candidate('lawn care')).would_block).toBe(false);
  });

  test('a one-word topic held by MORE than the rare threshold of posts is a cluster, not an owner', () => {
    const many = [1, 2, 3, 4].map((n) => post(`/pest-control/millipede-guide-${n}/`, `Millipede Question ${n}`, `millipede ${n}`));
    const r = run(many, candidate('florida millipede'));
    expect(r.would_block).toBe(false);
    expect(r.reason).toBe('common_topic');
  });

  test('every core word must be present: "german roach" matches the German cockroach post; "german millipede" matches nothing', () => {
    expect(run([GERMAN, MILLIPEDE], candidate('german roach')).owner.url).toBe('/pest-control/get-rid-of-german-cockroaches/');
    expect(run([GERMAN, MILLIPEDE], candidate('german millipede')).reason).toBe('no_owner');
  });

  test('only the STRICT fields count: a word in the meta description or a heading does not make an owner', () => {
    const headingOnly = {
      url: '/pest-control/house-centipedes/', path: 'src/content/blog/pest-control/house-centipedes.mdx',
      body: '---\ntitle: House Centipedes\nslug: /pest-control/house-centipedes/\nprimary_keyword: house centipede\nmeta_description: Not a millipede.\n---\n\n## Is it a millipede?\n',
    };
    expect(run([headingOnly], candidate('florida millipede')).reason).toBe('no_owner');
  });

  test('the owner is deterministic: most strict-field hits first, then URL order', () => {
    const a = post('/pest-control/b-millipede-facts/', 'Millipede Facts', 'millipede facts');
    const b = post('/pest-control/a-millipede-basics/', 'Millipede Basics', 'millipede basics');
    const strong = post('/pest-control/millipede-millipede/', 'Millipede or Millipede', 'millipede');
    expect(run([a, b], candidate('millipede')).owner.url).toBe('/pest-control/a-millipede-basics/');
    expect(run([a, b, strong], candidate('millipede')).owner.url).toBe('/pest-control/millipede-millipede/');
  });

  test('falls back to the working title, then the slug, when the keyword has no topic words', () => {
    const viaTitle = run([MILLIPEDE], candidate('best tips in florida', { title: 'Millipedes in Your Sarasota Home' }));
    expect(viaTitle.source).toBe('title');
    expect(viaTitle.source_text).toBe('Millipedes in Your Sarasota Home');
    expect(viaTitle.would_block).toBe(true);
    const viaSlug = run([MILLIPEDE], candidate('', { slug: '/pest-control/florida-millipedes-southwest-florida/' }));
    expect(viaSlug.source).toBe('slug');
    expect(viaSlug.source_text).toBe('florida millipedes southwest florida');
    expect(viaSlug.would_block).toBe(true);
  });

  test('a candidate that is only geo and framing words has no topic words → no block', () => {
    const r = run([MILLIPEDE], candidate('best guide tips florida southwest sarasota'));
    expect(r.would_block).toBe(false);
    expect(r.reason).toBe('no_topic_words');
  });

  test('a refresh is not applicable (refreshing the owner is the sanctioned move)', () => {
    const r = run([MILLIPEDE], { actionType: 'refresh_existing_page', query: 'florida millipede' });
    expect(r.applicable).toBe(false);
    expect(r.would_block).toBe(false);
    expect(r.reason).toBe('not_a_new_blog');
  });

  test('no corpus → no verdict, never a block', () => {
    expect(gate.evaluateSameQuestion(candidate('florida millipede'), {}).reason).toBe('no_corpus');
    expect(gate.evaluateSameQuestion(candidate('florida millipede'), { index: gate.indexCorpus([]) }).would_block).toBe(false);
  });

  test('evaluate() itself is unchanged: the existing entity rule and its result shape do not carry the new code', () => {
    const r = gate.evaluate(candidate('florida millipede'), { corpus: [MILLIPEDE, GERMAN], requireCorpus: true });
    expect((r.findings || []).map((f) => f.code)).not.toContain('TOPIC_SAME_QUESTION_LIVE');
  });
});
