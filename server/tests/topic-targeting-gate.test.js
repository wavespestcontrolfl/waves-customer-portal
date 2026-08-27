/**
 * Topic-targeting gate — owner rulings 2026-08-27 after astro #476 (Tampa),
 * #490 (second Taexx post), #491 ("… in Florida") each targeted the wrong
 * thing. Pinned behaviors: geo scope precedence, statewide-only = too broad,
 * entity ownership is corpus-adaptive + category-scoped + refresh-exempt,
 * and a missing corpus throws (fail closed) rather than passing.
 */
const gate = require('../services/content/topic-targeting-gate');

const post = (slug, title, extra = '', headings = []) => ({
  path: `src/content/blog${slug.replace(/\/$/, '')}.mdx`,
  url: slug,
  body: `---\ntitle: ${JSON.stringify(title)}\nslug: ${slug}\nmeta_description: ${JSON.stringify(extra)}\nprimary_keyword: ${JSON.stringify(title.toLowerCase())}\nsecondary_keywords:\n  - ${JSON.stringify(`${title.toLowerCase()} cost`)}\ncategory: ${slug.split('/')[1]}\n---\n\nIntro prose that mentions taexx tampa florida everywhere but is NOT a targeting field.\n\n${headings.map((h) => `## ${h}`).join('\n\n')}\n`,
});

// A miniature of the live corpus: the in-wall post names Taexx in meta +
// several headings (owner); a roach guide names bug bombs twice (not an
// owner); a mosquito post is built around bifenthrin (owner, other category).
const CORPUS = [
  post('/pest-control/in-wall-pest-control/', "So…You're Pumping Pesticides Into Your Walls on Purpose?",
    'What Taexx in-wall pest control actually pumps into your walls.',
    ['What Is Taexx Pest Control?', 'So What Is the Taexx System Actually Doing?', 'Already Have Taexx? No Judgment.']),
  post('/pest-control/get-rid-of-cockroaches/', 'How to Get Rid of Cockroaches', 'Roach control that works.',
    ['Do bug bombs work?', 'Why bug bombs make roaches spread']),
  post('/mosquito/professional-mosquito-treatment/', 'Professional Mosquito Treatment', 'Bifenthrin barrier sprays explained.',
    ['What bifenthrin does', 'How long bifenthrin lasts', 'Bifenthrin and pollinators']),
  // "drywood" is generic vocabulary: four termite posts are built around it.
  post('/termite/drywood-termites-sarasota/', 'Drywood Termites in Sarasota', 'Drywood termite signs.', ['Drywood frass', 'Drywood swarmers', 'Drywood treatment']),
  post('/termite/drywood-termites-venice/', 'Drywood Termites in Venice', 'Drywood termite signs.', ['Drywood frass', 'Drywood swarmers', 'Drywood treatment']),
  post('/termite/drywood-termites-bradenton/', 'Drywood Termites in Bradenton', 'Drywood termite signs.', ['Drywood frass', 'Drywood swarmers', 'Drywood treatment']),
  post('/termite/drywood-termites-parrish/', 'Drywood Termites in Parrish', 'Drywood termite signs.', ['Drywood frass', 'Drywood swarmers', 'Drywood treatment']),
  post('/termite/subterranean-termites-venice/', 'Subterranean Termites in Venice', 'Subterranean termite signs.', ['Mud tubes', 'Swarmers']),
  post('/lawn-care/fertilizer-blackout-manatee-county/', 'Manatee County Fertilizer Blackout', 'Blackout dates.', ['Blackout dates', 'Blackout rules', 'After the blackout']),
];

const blog = (over) => ({ actionType: 'new_supporting_blog', pageType: 'supporting-blog', ...over });

describe('classifyGeoScope', () => {
  test('out-of-footprint metro wins over everything ("Tampa" next to "Florida" and a served city)', () => {
    const g = gate.classifyGeoScope('WDO Inspection Near Tampa: What Florida Buyers in Sarasota Should Know');
    expect(g.scope).toBe('out_of_area');
    expect(g.out_of_area.map((c) => c.toLowerCase())).toContain('tampa');
  });
  test('served city → footprint; region phrase → regional; bare Florida → statewide; nothing → none', () => {
    expect(gate.classifyGeoScope('pest control new home lakewood ranch').scope).toBe('footprint');
    expect(gate.classifyGeoScope('Why national lawn programs fail in SWFL').scope).toBe('regional');
    expect(gate.classifyGeoScope('Manatee County fertilizer blackout').scope).toBe('regional');
    expect(gate.classifyGeoScope('new construction pest control florida').scope).toBe('statewide');
    expect(gate.classifyGeoScope('termite inspection fl').scope).toBe('statewide');
    expect(gate.classifyGeoScope('house came with taexx').scope).toBe('none');
  });
  test('"Florida" WITH a served-city anchor is footprint, not statewide', () => {
    expect(gate.classifyGeoScope('Sarasota, Florida termite season').scope).toBe('footprint');
  });
  test('word boundaries: "St. Augustine" grass and "Tampa" inside another word never match', () => {
    expect(gate.classifyGeoScope('your St. Augustine lawn in Parrish').scope).toBe('footprint');
    expect(gate.classifyGeoScope('tampanade recipes').scope).toBe('none');
  });
  test('"St. Petersburg" matches with or without the period', () => {
    expect(gate.classifyGeoScope('pest control st petersburg').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('pest control St. Petersburg').scope).toBe('out_of_area');
  });
});

describe('geoBlockReason (shared by miner + idea lane)', () => {
  test('blocks out-of-area and statewide-only; passes footprint / regional / no-geo', () => {
    expect(gate.geoBlockReason('wdo inspection tampa')).toBe(gate.CODES.GEO_OUT_OF_AREA);
    expect(gate.geoBlockReason('new construction pest control florida')).toBe(gate.CODES.GEO_STATEWIDE);
    expect(gate.geoBlockReason('ghost ants sarasota kitchen')).toBeNull();
    expect(gate.geoBlockReason('mosquito season southwest florida')).toBeNull();
    expect(gate.geoBlockReason('do bug bombs work')).toBeNull();
  });
  test('allowStatewide (the miner): statewide DEMAND passes, out-of-area still blocks', () => {
    expect(gate.geoBlockReason('kinds of ants in florida', { allowStatewide: true })).toBeNull();
    expect(gate.geoBlockReason('wdo inspection tampa', { allowStatewide: true })).toBe(gate.CODES.GEO_OUT_OF_AREA);
  });
});

describe('evaluateDraftFraming (post-draft, the writer\'s own title/slug/keyword)', () => {
  test('#491 shape: a statewide-only title is a P0 even when the demand query was allowed', () => {
    const r = gate.evaluateDraftFraming({ frontmatter: { title: 'New-Construction Pest Control in Florida: Your First-Year Plan', slug: '/pest-control/new-construction-pest-control-first-year-plan/', primary_keyword: 'new construction pest control florida' } });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([gate.CODES.GEO_STATEWIDE]);
  });
  test('the localized rewrite passes', () => {
    const r = gate.evaluateDraftFraming({ frontmatter: { title: 'New-Construction Pest Control in Lakewood Ranch: Your First-Year Plan', slug: '/pest-control/new-construction-pest-control-first-year-plan/', primary_keyword: 'new construction pest control florida' } });
    expect(r.ok).toBe(true);
    expect(r.geo.scope).toBe('footprint');
  });
  test('out-of-area framing is a P0; no-geo framing passes; metadata-shape drafts use top-level title/url', () => {
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'WDO Inspection Near Tampa', slug: '/termite/wdo-inspection-tampa/' } }).ok).toBe(false);
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'Do Bug Bombs Actually Work?', slug: '/pest-control/do-bug-bombs-work/' } }).ok).toBe(true);
    expect(gate.evaluateDraftFraming({ title: 'Termite Season in Florida', url: 'https://www.wavespestcontrol.com/termite/termite-season-florida/' }).ok).toBe(false);
    expect(gate.evaluateDraftFraming({}).ok).toBe(true);
  });
});

describe('evaluate — applicability', () => {
  test('refreshes and non-blog actions are exempt (refreshing the entity owner is the sanctioned move)', () => {
    const r = gate.evaluate({ actionType: 'refresh_existing_page', query: 'taexx system review', slug: '/pest-control/in-wall-pest-control/' }, { corpus: CORPUS });
    expect(r).toMatchObject({ ok: true, applicable: false, skipped: 'not_a_new_blog' });
    expect(gate.isApplicable({ actionType: 'create_or_refresh_city_service_page' })).toBe(false);
    expect(gate.isApplicable({ actionType: 'new_supporting_blog' })).toBe(true);
    expect(gate.isApplicable({ pageType: 'supporting-blog' })).toBe(true);
  });
});

describe('evaluate — geo (the #476 / #491 shapes)', () => {
  test('#476: a post built around Tampa is blocked before the corpus is even consulted', () => {
    const r = gate.evaluate(blog({ query: 'wdo inspection tampa', title: 'WDO Inspection Near Tampa: What Florida Buyers Should Know', slug: '/termite/wdo-inspection-tampa/' }), { requireCorpus: true });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([gate.CODES.GEO_OUT_OF_AREA]);
    expect(r.findings[0].severity).toBe('P0');
  });
  test('#491: a PINNED statewide-only title is too broad pre-draft (the query alone never decides framing)', () => {
    const r = gate.evaluate(blog({ query: 'new construction pest control florida', title: 'New-Construction Pest Control in Florida: Your First-Year Plan', slug: '/pest-control/new-construction-pest-control-first-year-plan/' }), { corpus: CORPUS });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([gate.CODES.GEO_STATEWIDE]);
  });
  test('a bare statewide QUERY (no pinned framing) passes pre-draft — the writer localizes and evaluateDraftFraming judges the result', () => {
    const r = gate.evaluate(blog({ query: 'kinds of ants in florida', service: 'pest' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
    expect(r.geo.scope).toBe('statewide');
  });
  test('a bare out-of-area QUERY is still blocked pre-draft (demand Waves cannot serve)', () => {
    const r = gate.evaluate(blog({ query: 'wdo inspection tampa', service: 'termite' }), { requireCorpus: true });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([gate.CODES.GEO_OUT_OF_AREA]);
  });
  test('the same brief re-anchored to a served city passes', () => {
    const r = gate.evaluate(blog({ query: 'new construction pest control lakewood ranch', title: 'New-Construction First-Year Pest & Termite Plan for SWFL Builds', slug: '/pest-control/new-construction-pest-control-first-year-plan/' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
    expect(r.geo.scope).toBe('footprint');
  });
  test('a served-city query + "Florida" in the pinned title is footprint, not statewide', () => {
    const r = gate.evaluate(blog({ query: 'termite season sarasota', title: 'Termite Season in Sarasota, Florida', slug: '/termite/termite-season-sarasota/' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
    expect(r.geo.scope).toBe('footprint');
  });
});

describe('evaluate — entity ownership (the #490 shape)', () => {
  test('#490: a second Taexx post is blocked because the in-wall post owns the entity', () => {
    const r = gate.evaluate(blog({ query: 'house came with taexx', title: 'Your New Lakewood Ranch Home Came With Taexx: What It Misses', slug: '/pest-control/taexx-system-new-home-lakewood-ranch/' }), { corpus: CORPUS });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: 'P0', code: gate.CODES.CANNIBALIZES_EXISTING, entities: ['taexx'], owners: ['/pest-control/in-wall-pest-control/'] });
    expect(r.entity_owners[0].title).toMatch(/Pumping Pesticides/);
  });
  test('entities come from the PRIMARY keyword, not title framing words', () => {
    const r = gate.evaluate(blog({ query: 'termite sensor subscription', title: 'Sensor Subscriptions vs. Actual Inspections: What Smart Protection Really Means', slug: '/termite/sensor-subscriptions/' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
  });
  test('generic vocabulary with high document frequency never trips it', () => {
    const r = gate.evaluate(blog({ query: 'drywood termite frass', title: 'Drywood Termite Frass: What the Piles Mean', slug: '/termite/drywood-termite-frass/' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
  });
  test('an owner must be BUILT AROUND the entity — two passing heading mentions are not ownership', () => {
    const r = gate.evaluate(blog({ query: 'do bug bombs work for roaches', title: 'Do Bug Bombs Actually Work?', slug: '/pest-control/do-bug-bombs-work/' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
  });
  test('ownership is scoped to the category (a termite bifenthrin post does not collide with the mosquito owner)', () => {
    const termite = gate.evaluate(blog({ query: 'bifenthrin pre-treatment', title: 'How Long a Builder Bifenthrin Pre-Treat Lasts', slug: '/termite/bifenthrin-pretreat/' }), { corpus: CORPUS });
    expect(termite.ok).toBe(true);
    const mosquito = gate.evaluate(blog({ query: 'bifenthrin mosquito spray', title: 'Bifenthrin Mosquito Spray', slug: '/mosquito/bifenthrin-mosquito-spray/' }), { corpus: CORPUS });
    expect(mosquito.ok).toBe(false);
    expect(mosquito.findings[0].owners).toEqual(['/mosquito/professional-mosquito-treatment/']);
  });
  test('category can come from the engine service key when no slug is pinned; unknown category compares against all', () => {
    const viaService = gate.evaluate(blog({ query: 'bifenthrin pre-treatment', service: 'termite' }), { corpus: CORPUS });
    expect(viaService.ok).toBe(true);
    const unknown = gate.evaluate(blog({ query: 'bifenthrin pre-treatment' }), { corpus: CORPUS });
    expect(unknown.ok).toBe(false);
  });
  test('the owner itself is exempt (pinned slug == owner slug)', () => {
    const r = gate.evaluate(blog({ query: 'taexx pest control', title: 'In-wall pest control', slug: '/pest-control/in-wall-pest-control/' }), { corpus: CORPUS });
    expect(r.ok).toBe(true);
  });
  test('a pre-built index is reused across candidates and reports corpus size', () => {
    const index = gate.indexCorpus(CORPUS);
    const r = gate.evaluate(blog({ query: 'house came with taexx', slug: '/pest-control/x/' }), { index });
    expect(r.corpus_size).toBe(CORPUS.length);
    expect(r.ok).toBe(false);
  });
});

describe('evaluate — fail closed', () => {
  test('an applicable candidate with no corpus THROWS when the corpus is required — never a pass', () => {
    expect(() => gate.evaluate(blog({ query: 'house came with taexx' }), { requireCorpus: true })).toThrow(/corpus required/);
  });
  test('requireCorpus:false reports skipped=no_corpus so the caller can load the corpus and re-run', () => {
    const r = gate.evaluate(blog({ query: 'house came with taexx' }), { requireCorpus: false });
    expect(r).toMatchObject({ ok: true, skipped: 'no_corpus' });
  });
  test('geo blocks do not need a corpus at all', () => {
    const r = gate.evaluate(blog({ query: 'wdo inspection tampa' }), { requireCorpus: true });
    expect(r.ok).toBe(false);
  });
});

describe('corpus parsing', () => {
  test('reads targeting fields (frontmatter scalars, secondary_keywords list, H2/H3) and ignores body prose', () => {
    const f = gate._internals.parseTargetingFields(CORPUS[0].body);
    expect(f.title).toMatch(/Pumping Pesticides/);
    expect(f.slug).toBe('/pest-control/in-wall-pest-control/');
    expect(f.secondary_keywords).toHaveLength(1);
    expect(f.headings).toHaveLength(3);
    expect(f.category).toBe('pest-control');
    const idx = gate.indexCorpus([CORPUS[0]]);
    // "tampa" appears only in body prose → not indexed.
    expect(idx.df.get('tampa') || 0).toBe(0);
    expect(idx.posts[0].counts.get('taexx')).toBeGreaterThanOrEqual(3);
  });
  test('category falls back to the slug prefix; malformed items are skipped', () => {
    expect(gate._internals.categoryFromSlug('https://www.wavespestcontrol.com/termite/wdo-inspection-tampa/')).toBe('termite');
    expect(gate._internals.categoryFromSlug('/termite/')).toBeNull();
    expect(gate.indexCorpus([null, { path: 'x' }, { body: 42 }]).posts).toHaveLength(0);
  });
});

describe('entity rarity is judged within the candidate category', () => {
  const post = (url, title, extra = '') => ({ url, body: `---\ntitle: ${title}\nslug: ${url}\nprimary_keyword: ${title.toLowerCase()}\n---\n${extra}` });
  // "bait" is common across the whole corpus (4 posts) but only ONE termite
  // post is built around it — a global count hides that owner.
  const corpus = [
    post('/termite/termite-bond/', 'Termite Bait Stations and the Bond', '## How bait stations work\n## When bait beats liquid\n'),
    post('/pest-control/ant-bait-basics/', 'Ant Bait Basics'),
    post('/pest-control/roach-bait-gel/', 'Roach Bait Gel Explained'),
    post('/pest-control/rodent-bait-safety/', 'Rodent Bait Safety With Pets'),
  ];

  test('same-category owner is found even when the token is common corpus-wide', () => {
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'bait station cost', service: 'termite' }, { corpus });
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe(gate.CODES.CANNIBALIZES_EXISTING);
    expect(r.findings[0].owners).toEqual(['/termite/termite-bond/']);
  });

  test('unknown candidate category falls back to corpus-wide rarity (conservative pool, global frequency)', () => {
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'bait station cost' }, { corpus });
    expect(r.ok).toBe(true);
    expect(r.entity_owners).toEqual([]);
  });

  test('index caches one frequency table per category', () => {
    const index = gate.indexCorpus(corpus);
    const a = gate._internals.dfForCategory(index, 'termite');
    const b = gate._internals.dfForCategory(index, 'termite');
    expect(a).toBe(b);
    expect(a.get('bait')).toBe(1);
    expect(index.df.get('bait')).toBe(4);
  });
});

describe('framing parts are judged on their own (hook r3)', () => {
  test('a served-city keyword does not rescue a statewide title — pre-draft (pinned) and post-draft', () => {
    const pre = gate.evaluate({ actionType: 'new_supporting_blog', query: 'pest control sarasota', title: 'Pest Control in Florida: What It Costs' }, { requireCorpus: false });
    expect(pre.ok).toBe(false);
    expect(pre.findings.map((f) => f.code)).toEqual([gate.CODES.GEO_STATEWIDE]);
    const post = gate.evaluateDraftFraming({ frontmatter: { title: 'Pest Control in Florida: What It Costs', slug: '/pest-control/pest-control-costs/', primary_keyword: 'pest control sarasota' } });
    expect(post.ok).toBe(false);
    expect(post.findings[0].code).toBe(gate.CODES.GEO_STATEWIDE);
  });

  test('a statewide slug alone is a block; a statewide KEYWORD alone never is', () => {
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'Ants in Sarasota Kitchens', slug: '/pest-control/ants-in-florida/', primary_keyword: 'ants sarasota' } }).ok).toBe(false);
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'Ants in Sarasota Kitchens', slug: '/pest-control/ants-sarasota/', primary_keyword: 'kinds of ants in florida' } }).ok).toBe(true);
    expect(gate.evaluate({ actionType: 'new_supporting_blog', query: 'kinds of ants in florida', title: 'Ants in Sarasota Kitchens' }, { requireCorpus: false }).ok).toBe(true);
  });
});

describe('frontmatter is read by the canonical YAML parser', () => {
  test('inline arrays and folded scalars count toward targeting', () => {
    const body = '---\ntitle: >-\n  Taexx Systems\n  Explained\nslug: /pest-control/taexx-explained/\nsecondary_keywords: [taexx cost, taexx refill]\nmeta_description: "Taexx, folded: fine"\n---\n## Taexx basics\n';
    const f = gate._internals.parseTargetingFields(body);
    expect(f.title).toBe('Taexx Systems Explained');
    expect(f.secondary_keywords).toEqual(['taexx cost', 'taexx refill']);
    expect(f.headings).toEqual(['Taexx basics']);
    const idx = gate.indexCorpus([{ url: '/pest-control/taexx-explained/', body }]);
    expect(idx.posts[0].counts.get('taexx')).toBe(6);
  });

  test('unparseable frontmatter yields empty targeting, never a throw', () => {
    const f = gate._internals.parseTargetingFields('---\ntitle: [unclosed\n---\n## H\n');
    expect(f.title).toBe('');
    expect(f.headings).toEqual([]);
  });
});

describe('out-of-footprint coverage beyond the original 48-name list (hook r4)', () => {
  test('destination geos, second-tier FL cities, US metros, and other states all classify out_of_area', () => {
    for (const t of ['pest control in key west', 'termite inspection coral springs', 'pest control atlanta', 'Termite Season in Georgia', 'mosquito control texas', 'lawn care pasco county']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
      expect(gate.geoBlockReason(t, { allowStatewide: true })).toBe(gate.CODES.GEO_OUT_OF_AREA);
    }
  });
  test('served south-Hillsborough towns and person-name places stay clear', () => {
    expect(gate.classifyGeoScope('pest control ruskin').scope).toBe('footprint');
    expect(gate.classifyGeoScope('pest control apollo beach').scope).toBe('footprint');
    expect(gate.classifyGeoScope('ask virginia about your plan').scope).toBe('none');
    expect(gate.classifyGeoScope('brandon asked about ghost ants').scope).toBe('none');
  });
});

describe('PR codex r1: ambiguous place names need geo context; postal abbreviations', () => {
  test('common-word places count only as "in/near <Name>" or "<Name>, <state>"', () => {
    expect(gate.classifyGeoScope('pest control in homestead').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('homestead fl pest control').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('Boston, MA termite season').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('protects your homestead from year-round pressure').scope).toBe('none');
    expect(gate.classifyGeoScope('boston fern pests').scope).toBe('none');
    expect(gate.classifyGeoScope('phoenix palm scale').scope).toBe('none');
  });
  test('those names are NOT in the shared prose blocklist', () => {
    const shared = new Set(gate._internals.outOfAreaCityList().map((c) => c.toLowerCase()));
    for (const n of gate._internals.CONTEXT_PLACE_NAMES) expect(shared.has(n.toLowerCase())).toBe(false);
  });
  test('"<city> tx" / "fresno, ca" / "Mobile, AL" are out-of-area; "va loan" and "ants in kitchen" are not', () => {
    for (const t of ['termite treatment plano tx', 'pest control fresno, ca', 'Mobile, AL termite control', 'exterminator omaha, ne cost']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['wdo inspection va loan', 'ants in kitchen', 'is pest control ok for pets', 'contact me about termites', 'pest control or exterminator']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
});

describe('evaluateDraftTargeting / evaluateBlogPostRow', () => {
  test('a clean brief whose writer emits an owned primary_keyword is caught at the ownership stage', () => {
    const index = gate.indexCorpus(CORPUS);
    const r = gate.evaluateDraftTargeting({ frontmatter: { title: 'Your New Lakewood Ranch Home Came With an In-Wall System', slug: '/pest-control/lakewood-ranch-in-wall-system/', primary_keyword: 'taexx in wall system' } }, { index, service: 'pest' });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('ownership');
    expect(r.findings[0].code).toBe(gate.CODES.CANNIBALIZES_EXISTING);
    expect(r.findings[0].owners).toEqual(['/pest-control/in-wall-pest-control/']);
  });
  test('framing failures report stage=framing before any ownership work', () => {
    const r = gate.evaluateDraftTargeting({ frontmatter: { title: 'Ants in Florida', slug: '/pest-control/ants/', primary_keyword: 'taexx' } }, { index: gate.indexCorpus(CORPUS) });
    expect(r.stage).toBe('framing');
    expect(r.findings[0].code).toBe(gate.CODES.GEO_STATEWIDE);
  });
  test('a blog_posts row already live on the hub is exempt; a new row is judged', () => {
    const index = gate.indexCorpus(CORPUS);
    expect(gate.evaluateBlogPostRow({ title: 'Taexx Refill Guide', keyword: 'taexx refill', slug: 'taexx-refill', astro_status: 'live' }, { index }).skipped).toBe('already_live');
    const r = gate.evaluateBlogPostRow({ title: 'Taexx Refill Guide', keyword: 'taexx refill', slug: 'taexx-refill' }, { index, category: 'pest-control' });
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe(gate.CODES.CANNIBALIZES_EXISTING);
  });
});
