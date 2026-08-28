/**
 * Topic-targeting gate — owner rulings 2026-08-27 after astro #476 (Tampa),
 * #490 (second Taexx post), #491 ("… in Florida") each targeted the wrong
 * thing. Pinned behaviors: geo scope precedence, statewide-only = too broad,
 * entity ownership is corpus-adaptive + category-scoped + refresh-exempt,
 * and a missing corpus throws (fail closed) rather than passing.
 */
const gate = require('../services/content/topic-targeting-gate');

const post = (slug, title, extra = '', headings = [], prose = 'Intro prose that mentions Tampa and Florida everywhere but is NOT a targeting field.') => ({
  path: `src/content/blog${slug.replace(/\/$/, '')}.mdx`,
  url: slug,
  body: `---\ntitle: ${JSON.stringify(title)}\nslug: ${slug}\nmeta_description: ${JSON.stringify(extra)}\nprimary_keyword: ${JSON.stringify(title.toLowerCase())}\nsecondary_keywords:\n  - ${JSON.stringify(`${title.toLowerCase()} cost`)}\ncategory: ${slug.split('/')[1]}\n---\n\n${prose}\n\n${headings.map((h) => `## ${h}`).join('\n\n')}\n`,
});

// A miniature of the live corpus: the in-wall post names Taexx in meta +
// several headings (owner); a roach guide names bug bombs twice (not an
// owner); a mosquito post is built around In2Care (owner, other category).
const CORPUS = [
  post('/pest-control/in-wall-pest-control/', "So…You're Pumping Pesticides Into Your Walls on Purpose?",
    'What Taexx in-wall pest control actually pumps into your walls.',
    ['What Is Taexx Pest Control?', 'So What Is the Taexx System Actually Doing?', 'Already Have Taexx? No Judgment.'],
    'Builders install Taexx during framing. The Taexx tubes run inside the walls, and most owners never see Taexx work.'),
  post('/pest-control/get-rid-of-cockroaches/', 'How to Get Rid of Cockroaches', 'Roach control that works.',
    ['Do bug bombs work?', 'Why bug bombs make roaches spread']),
  post('/mosquito/professional-mosquito-treatment/', 'Professional Mosquito Treatment', 'In2Care station programs explained.',
    ['What In2Care does', 'How long In2Care lasts', 'In2Care and pollinators'],
    'Each In2Care station holds a larvicide. Mosquitoes visit the In2Care trap and carry it onward.'),
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
  test('ownership is scoped to the category (a termite In2Care post does not collide with the mosquito owner)', () => {
    const termite = gate.evaluate(blog({ query: 'in2care pre-treatment', title: 'How Long a Builder In2Care Pre-Treat Lasts', slug: '/termite/in2care-pretreat/' }), { corpus: CORPUS });
    expect(termite.ok).toBe(true);
    const mosquito = gate.evaluate(blog({ query: 'in2care mosquito stations', title: 'In2Care Mosquito Stations', slug: '/mosquito/in2care-mosquito-stations/' }), { corpus: CORPUS });
    expect(mosquito.ok).toBe(false);
    expect(mosquito.findings[0].owners).toEqual(['/mosquito/professional-mosquito-treatment/']);
  });
  test('category can come from the engine service key when no slug is pinned; unknown category compares against all', () => {
    const viaService = gate.evaluate(blog({ query: 'in2care pre-treatment', service: 'termite' }), { corpus: CORPUS });
    expect(viaService.ok).toBe(true);
    const unknown = gate.evaluate(blog({ query: 'in2care pre-treatment' }), { corpus: CORPUS });
    expect(unknown.ok).toBe(false);
  });
  test('a NEW action pinned to the owner\'s own slug is NOT exempt — live rows are exempted upstream (isLiveRow / refresh_existing_page), never by URL match', () => {
    const r = gate.evaluate(blog({ query: 'taexx pest control', title: 'In-wall pest control', slug: '/pest-control/in-wall-pest-control/' }), { corpus: CORPUS });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual([gate.CODES.SLUG_COLLIDES_LIVE, gate.CODES.CANNIBALIZES_EXISTING]);
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
  const post = (url, title, extra = '') => ({ url, body: `---\ntitle: ${title}\nslug: ${url}\nprimary_keyword: ${title.toLowerCase()}\n---\nTechnicians place Advion where pests travel. Most Advion placements last a season.\n${extra}` });
  // "Advion" is a proper noun common across the whole corpus (4 posts) but
  // only ONE termite post is built around it — a global count hides that owner.
  const corpus = [
    post('/termite/advion-termite-bait/', 'Advion Termite Bait Stations', '## How Advion stations work\n## When Advion beats liquid\n'),
    post('/pest-control/advion-ant-gel/', 'Advion Ant Gel Basics'),
    post('/pest-control/advion-roach-gel/', 'Advion Roach Gel Explained'),
    post('/pest-control/advion-rodent-safety/', 'Advion Rodent Safety With Pets'),
  ];

  test('same-category owner is found even when the token is common corpus-wide', () => {
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'advion station cost', service: 'termite' }, { corpus });
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe(gate.CODES.CANNIBALIZES_EXISTING);
    expect(r.findings[0].owners).toEqual(['/termite/advion-termite-bait/']);
  });

  test('unknown candidate category falls back to corpus-wide rarity (conservative pool, global frequency)', () => {
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'advion station cost' }, { corpus });
    expect(r.ok).toBe(true);
    expect(r.entity_owners).toEqual([]);
  });

  test('index caches one frequency table per category', () => {
    const index = gate.indexCorpus(corpus);
    const a = gate._internals.dfForCategory(index, 'termite');
    const b = gate._internals.dfForCategory(index, 'termite');
    expect(a).toBe(b);
    expect(a.get('advion')).toBe(1);
    expect(index.df.get('advion')).toBe(4);
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
  test('PR codex r2: Hillsborough County blocks county-wide targeting only, never a served locality (and is not in the prose blocklist)', () => {
    expect(gate.classifyGeoScope('pest control hillsborough county').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('Tampa, Hillsborough County termite bond').scope).toBe('out_of_area');
    const served = gate.classifyGeoScope('pest control in Ruskin, Hillsborough County');
    expect(served.scope).toBe('footprint');
    expect(served.out_of_area).toEqual([]);
    expect(gate.classifyGeoScope('Sun City Center, south Hillsborough County lawn care').scope).toBe('footprint');
    expect(gate._internals.outOfAreaCityList().map((c) => c.toLowerCase())).not.toContain('hillsborough county');
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
  test('the guardrails\' documented exclusions (Brandon, Sunrise, Plantation, Cocoa, Mobile, Stuart) are covered here with context', () => {
    for (const t of ['pest control in Brandon', 'Brandon, FL exterminator', 'lawn care in sunrise', 'termite treatment plantation fl', 'pest control near cocoa', 'exterminator mobile, al', 'Stuart, Florida termite bond']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['brandon asked about ghost ants', 'treat at sunrise before the heat', 'plantation shutters and wasps', 'cocoa mulch and termites', 'mobile app for scheduling', 'stuart little and the mice',
      // "in/near <Name>" followed by an ordinary noun is a topic, not a place (hook r7)
      'pest control in mobile homes', 'pests in cocoa mulch', 'ants in plantation shutters', 'termites in homestead lumber']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
    expect(gate.classifyGeoScope('Ants in Cocoa: What to Do').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('Pest Control in Homestead, FL').scope).toBe('out_of_area');
  });
  test('common-word names in the context list are NOT in the shared prose blocklist (except the metros the guardrails already carry)', () => {
    const shared = new Set(gate._internals.outOfAreaCityList().map((c) => c.toLowerCase()));
    for (const n of gate._internals.CONTEXT_PLACE_NAMES) {
      if (['orlando', 'lakeland'].includes(n.toLowerCase())) continue;
      expect(shared.has(n.toLowerCase())).toBe(false);
    }
  });
  test('"<city> tx" / "fresno, ca" / "Mobile, AL" are out-of-area; "va loan" and "ants in kitchen" are not', () => {
    for (const t of ['termite treatment plano tx', 'pest control fresno, ca', 'Mobile, AL termite control', 'exterminator omaha, ne cost']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['wdo inspection va loan', 'ants in kitchen', 'is pest control ok for pets', 'contact me about termites', 'pest control or exterminator']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
  test('hook (PR codex r2 push): a safe abbreviation LEADING the text or slug is out-of-state; ambiguous ones stay context-gated', () => {
    for (const t of ['TX termite treatment', 'ca pest control laws', 'tx termite control']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'Termite Control Basics', slug: '/tx-termite-control/' } }).ok).toBe(false);
    for (const t of ['in wall pest control', 'me and my ants', 'or exterminator', 'ok pest control for pets']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
  test('hook (PR codex r2 push 2): "in <Name> homes/neighborhoods/residents" is a place; "mobile homes" / "cocoa mulch" stay topics', () => {
    for (const t of ['Pest Control in Brandon Homes', 'Lawn Care in Stuart Neighborhoods', 'Pest Control in Austin Homes', 'termite risk for homeowners in plantation communities']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['pest control in mobile homes', 'pests in cocoa mulch', 'ants in homestead kitchens', 'pest control for mobile home residents']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
  test('PR codex r2: "mt" is Montana only trailing or after a comma — "mt dora" / "mt pleasant" are towns', () => {
    for (const t of ['termite control billings mt', 'Billings, MT pest control', 'exterminator missoula mt?']) {
      expect(gate.classifyGeoScope(t).out_of_area).toContain('MT');
    }
    for (const t of ['termite bond mt pleasant', 'pest control mt dora fl', 'mt pleasant exterminator cost']) {
      expect(gate.classifyGeoScope(t).out_of_area).not.toContain('MT');
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
  test('an owned entity carried only by the title or slug (generic/empty keyword) is still caught', () => {
    const index = gate.indexCorpus(CORPUS);
    const byTitle = gate.evaluate(blog({ query: 'new home pest control', title: 'Your New Lakewood Ranch Home Came With Taexx', slug: '/pest-control/new-home-pest-control-lakewood-ranch/' }), { index });
    expect(byTitle.ok).toBe(false);
    expect(byTitle.findings[0].entities).toEqual(['taexx']);
    const bySlug = gate.evaluate(blog({ query: '', title: 'What Came With Your New Build', slug: '/pest-control/lakewood-ranch-taexx/' }), { index });
    expect(bySlug.ok).toBe(false);
    // A word one post merely mentions (heading-only "judgment", 1×) is not owned — an owner is BUILT AROUND the token (≥ 3×).
    expect(gate.evaluate(blog({ query: 'no judgment pest control', title: 'No Judgment: Pest Control Basics for New Owners' }), { index }).ok).toBe(true);
  });

  test('the EMITTED frontmatter.category is authoritative for ownership scope; tree-shrub is its own category', () => {
    const arborjet = (url, cat) => ({ url, body: `---\ntitle: Arborjet Trunk Injection\nslug: ${url}\nprimary_keyword: arborjet trunk injection\ncategory: ${cat}\n---\nArborists inject Arborjet at the flare. One Arborjet dose protects the canopy for a season.\n## How Arborjet works\n## When Arborjet is worth it\n` });
    const index = gate.indexCorpus([arborjet('/tree-shrub/arborjet-trunk-injection/', 'tree-shrub')]);
    const draft = { frontmatter: { title: 'Arborjet Costs for Sarasota Palms', slug: '/tree-shrub/arborjet-costs-sarasota/', primary_keyword: 'arborjet cost', category: 'tree-shrub' } };
    const r = gate.evaluateDraftTargeting(draft, { index, service: 'tree-shrub' });
    expect(r.ok).toBe(false);
    expect(r.category).toBe('tree-shrub');
    expect(r.findings[0].owners).toEqual(['/tree-shrub/arborjet-trunk-injection/']);
    // An emitted category that differs from the coarse service wins.
    const other = gate.evaluateDraftTargeting({ frontmatter: { ...draft.frontmatter, category: 'mosquito' } }, { index, service: 'tree-shrub' });
    expect(other.category).toBe('mosquito');
    expect(other.ok).toBe(true);
    expect(gate._internals.SERVICE_TO_CATEGORY['tree-shrub']).toBe('tree-shrub');
  });

  test('a NEW blog that reuses a live post URL is blocked (no self-exemption for new actions)', () => {
    const r = gate.evaluate(blog({ query: 'in wall pest control', title: 'In-Wall Pest Control, Revisited', slug: '/pest-control/in-wall-pest-control/' }), { corpus: CORPUS });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain(gate.CODES.SLUG_COLLIDES_LIVE);
  });

  test('framing failures report stage=framing before any ownership work', () => {
    const r = gate.evaluateDraftTargeting({ frontmatter: { title: 'Ants in Florida', slug: '/pest-control/ants/', primary_keyword: 'taexx' } }, { index: gate.indexCorpus(CORPUS) });
    expect(r.stage).toBe('framing');
    expect(r.findings[0].code).toBe(gate.CODES.GEO_STATEWIDE);
  });
  test('a blog_posts row already live on the hub is exempt BEFORE the corpus loads; a new row is judged', async () => {
    const loadIndex = jest.fn().mockRejectedValue(new Error('github_down'));
    const live = await gate.evaluateBlogPostRow({ title: 'Taexx Refill Guide', keyword: 'taexx refill', slug: 'taexx-refill', astro_status: 'live' }, { loadIndex });
    expect(live.skipped).toBe('already_live');
    expect(loadIndex).not.toHaveBeenCalled();
    await expect(gate.evaluateBlogPostRow({ title: 'Taexx Refill Guide', keyword: 'taexx refill', slug: 'taexx-refill' }, { loadIndex })).rejects.toThrow('github_down');
    const r = await gate.evaluateBlogPostRow({ title: 'Taexx Refill Guide', keyword: 'taexx refill', slug: 'taexx-refill' }, { index: gate.indexCorpus(CORPUS), category: 'pest-control' });
    expect(r.ok).toBe(false);
    expect(r.findings[0].code).toBe(gate.CODES.CANNIBALIZES_EXISTING);
  });
  test('Washington / Virginia count with state context, never as a person name', () => {
    for (const t of ['pest control in Washington', 'termite treatment in Virginia', 'pest control spokane washington', 'Washington State termite season', 'exterminator richmond, virginia']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['ask virginia about your plan', 'Meet Virginia', 'Virginia: Our Office Manager', 'thanks virginia', 'call virginia']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
});

describe('entity identity = proper noun in body prose (uncapped audit 2026-08-27; measured on the live corpus)', () => {
  const owner = (url, title, prose) => ({ url, body: `---\ntitle: ${title}\nslug: ${url}\nprimary_keyword: ${title.toLowerCase()}\n---\n${prose}\n## ${title} basics\n## Why ${title.split(' ')[0]} matters\n` });
  test('an ordinary rare word a post is built around does NOT become an owned entity (Seasonal Ant Pressure vs Seasonal Roach Pressure)', () => {
    const corpus = [owner('/pest-control/seasonal-ant-pressure/', 'Seasonal Ant Pressure', 'Ants surge when the seasonal rains start; the pressure follows the water.')];
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'seasonal roach pressure', title: 'Seasonal Roach Pressure in Sarasota Homes', slug: '/pest-control/seasonal-roach-pressure/' }, { corpus });
    expect(r.ok).toBe(true);
  });
  test('species, chemicals, and months are not entities; a capitalized brand is', () => {
    const corpus = [
      owner('/pest-control/get-rid-of-clover-mites/', 'Clover Mites', 'Tiny red mites gather on sunny walls; the mites do not bite.'),
      owner('/lawn-care/december-lawn-care/', 'December Lawn Care', 'Growth slows by December, and by late December the lawn is nearly dormant.'),
      owner('/termite/termidor-treatment/', 'Termidor Treatment', 'Applicators trench and apply Termidor along the slab. A Termidor barrier lasts years.'),
    ];
    expect(gate.evaluate({ actionType: 'new_supporting_blog', query: 'rat mites bradenton', title: 'Rat Mites in Bradenton Homes' }, { corpus }).ok).toBe(true);
    expect(gate.evaluate({ actionType: 'new_supporting_blog', query: 'december pest control', title: 'December Pest Control Checklist for Venice' }, { corpus }).ok).toBe(true);
    const brand = gate.evaluate({ actionType: 'new_supporting_blog', query: 'termidor cost', title: 'What Termidor Costs in Sarasota', slug: '/termite/termidor-cost/' }, { corpus });
    expect(brand.ok).toBe(false);
    expect(brand.findings[0].entities).toEqual(['termidor']);
    const index = gate.indexCorpus(corpus);
    expect([...index.properNouns]).toEqual(['termidor']);
  });
  test('a brand with no prose mentions (headings only) is not an entity — the signal is prose capitalization', () => {
    const corpus = [{ url: '/pest-control/x/', body: '---\ntitle: Taexx Basics\nslug: /pest-control/x/\nprimary_keyword: taexx basics\n---\n## Taexx one\n## Taexx two\n## Taexx three\n' }];
    expect(gate.indexCorpus(corpus).properNouns.size).toBe(0);
  });
});

describe('PR codex r3 (86e165cc1)', () => {
  test('"Florida room" and "fl oz" are not statewide targeting; "in Florida" still is', () => {
    expect(gate.classifyGeoScope('Pest Control for Florida Rooms').scope).toBe('none');
    expect(gate.classifyGeoScope('Pesticide Dilution in fl oz').scope).toBe('none');
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'Keeping Bugs Out of Your Florida Room', slug: '/pest-control/florida-room-bugs/' } }).ok).toBe(true);
    expect(gate.classifyGeoScope('new construction pest control in florida').scope).toBe('statewide');
    expect(gate.classifyGeoScope('florida room pest control in florida').scope).toBe('statewide');
  });
  test('the Hillsborough County exemption needs a south-Hillsborough town, not any served city', () => {
    expect(gate.classifyGeoScope('Hillsborough County vs Sarasota County pest control').scope).toBe('out_of_area');
    expect(gate.classifyGeoScope('Pest control across Hillsborough County and Bradenton').scope).toBe('out_of_area');
    for (const town of ['Ruskin', 'Apollo Beach', 'Sun City Center', 'Wimauma', 'Gibsonton', 'Riverview']) {
      expect(gate.classifyGeoScope(`pest control in ${town}, Hillsborough County`).scope).toBe('footprint');
    }
  });
  test('a legacy status=published row (no astro fields) is an existing post → refresh-exempt before the corpus loads', async () => {
    const loadIndex = jest.fn().mockRejectedValue(new Error('github_down'));
    const r = await gate.evaluateBlogPostRow({ title: 'Your Home Came With Taexx', keyword: 'taexx', slug: 'taexx-home', status: 'published', astro_status: null, astro_live_url: null }, { loadIndex });
    expect(r).toMatchObject({ ok: true, applicable: false, skipped: 'already_live' });
    expect(loadIndex).not.toHaveBeenCalled();
    const fresh = await gate.evaluateBlogPostRow({ title: 'Your Home Came With Taexx', keyword: 'taexx', slug: 'taexx-home', status: 'draft' }, { loadIndex }).catch((e) => e);
    expect(fresh).toBeInstanceOf(Error);
  });
  test('possessives normalize to the entity: "Taexx\'s" owns nothing new', () => {
    const index = gate.indexCorpus(CORPUS);
    const r = gate.evaluateDraftTargeting({ frontmatter: { title: "What Taexx's Tubes Mean for Your Home", slug: '/pest-control/what-taexxs-tubes-mean/', primary_keyword: "taexx's tubes" } }, { index, service: 'pest' });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.code === gate.CODES.CANNIBALIZES_EXISTING)).toBe(true);
  });
});

describe('PR codex r4 (2b1bcc9cb)', () => {
  test('place-first service phrases are geographic; Mobile/Sunrise stay ordinary words', () => {
    for (const t of ['Boston pest control', 'Austin exterminator', 'homestead termite treatment', 'phoenix lawn care cost']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['mobile pest control service', 'sunrise mosquito activity', 'plantation shutters and pests']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
  test('ambiguous abbreviations count after a geo preposition at phrase end, or between a word and a service; English words never', () => {
    expect(gate.classifyGeoScope('pest control in va').out_of_area).toContain('VA');
    expect(gate.classifyGeoScope('termites in la?').out_of_area).toContain('LA');
    expect(gate.classifyGeoScope('boulder co pest control').out_of_area).toContain('CO');
    expect(gate.classifyGeoScope('birmingham al exterminator').out_of_area).toContain('AL');
    for (const t of ['ants in or around the house', 'wdo inspection va loan', 'pest control or exterminator', 'is pest control ok for pets', 'what pests live in me and my walls']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
  test('Florida vernacular ("palmetto bugs", "laurel oaks") is not a footprint anchor, so statewide framing still blocks', () => {
    expect(gate.classifyGeoScope('Palmetto Bugs in Florida').scope).toBe('statewide');
    expect(gate.classifyGeoScope('Florida Laurel Oak Problems').scope).toBe('statewide');
    expect(gate.evaluateDraftFraming({ frontmatter: { title: 'Palmetto Bugs in Florida: What They Are', slug: '/pest-control/palmetto-bugs-florida/' } }).ok).toBe(false);
    expect(gate.classifyGeoScope('pest control palmetto').scope).toBe('footprint');
    expect(gate.classifyGeoScope('saw palmetto beds in sarasota').scope).toBe('footprint');
  });
  test('an owner whose prose only uses the possessive ("Acme\u2019s") still owns the entity', () => {
    const corpus = [{ url: '/termite/acme-bait/', body: "---\ntitle: Acme Bait Stations Explained\nslug: /termite/acme-bait/\nprimary_keyword: acme bait stations\nmeta_description: How Acme stations work.\ncategory: termite\n---\n\nTechnicians place Acme\u2019s stations along the slab. Most of Acme\u2019s baits last a season, and Acme\u2019s monitors tell you when.\n" }];
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'acme bait review', title: 'Is Acme Bait Worth It?', slug: '/termite/acme-bait-review/', category: 'termite' }, { corpus });
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ code: gate.CODES.CANNIBALIZES_EXISTING, entities: ['acme'] });
  });
  test('a persisted row\u2019s city is targeting: generic fields + city=Tampa is out-of-area; city=Sarasota is fine', async () => {
    const index = gate.indexCorpus(CORPUS);
    const generic = { title: 'How Often Should Pest Control Come?', keyword: 'pest control frequency', slug: 'pest-control-frequency', status: 'draft' };
    const tampa = await gate.evaluateBlogPostRow({ ...generic, city: 'Tampa' }, { index });
    expect(tampa.ok).toBe(false);
    expect(tampa.findings[0]).toMatchObject({ code: gate.CODES.GEO_OUT_OF_AREA, cities: ['Tampa'] });
    expect(tampa.findings[0].message).toMatch(/Row city/);
    expect((await gate.evaluateBlogPostRow({ ...generic, city: 'Sarasota' }, { index })).ok).toBe(true);
  });
});

describe('hook (PR codex r5 push): state names / leading abbreviations before a service; unknown category unions per-category ownership', () => {
  test('"Virginia termite treatment", "Washington pest control", "AL termite treatment", "PA pest control laws" are out-of-state', () => {
    for (const t of ['Virginia termite treatment', 'Washington pest control', 'AL termite treatment', 'PA pest control laws', 'virginia pest control services cost']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['ask virginia about pest control', 'in wall pest control', 'or pest control', 'virginia creeper vine pests', 'washington navel orange pests']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
  test('an unmapped tag (unknown category) still finds the same-category owner of a brand named across categories', () => {
    const prose = 'Technicians place Advion where pests travel. Most Advion placements last a season.';
    const termite = { url: '/termite/advion-termite-bait/', body: `---\ntitle: Advion Termite Bait Stations\nslug: /termite/advion-termite-bait/\nprimary_keyword: advion termite bait stations\ncategory: termite\n---\n${prose}\n## How Advion stations work\n## When Advion beats liquid\n` };
    const pest = ['advion-ant-gel', 'advion-roach-gel', 'advion-rodent-safety'].map((leaf) => ({ url: `/pest-control/${leaf}/`, body: `---\ntitle: ${leaf.replace(/-/g, ' ')}\nslug: /pest-control/${leaf}/\nprimary_keyword: ${leaf.replace(/-/g, ' ')}\ncategory: pest-control\n---\n${prose}\n` }));
    const corpus = [termite, ...pest];
    // Global DF for "advion" is 4 (> RARE_ENTITY_DF_MAX) — a global pass would hide the termite owner.
    const r = gate.evaluate({ actionType: 'new_supporting_blog', query: 'advion termite bait review', title: 'Is Advion Termite Bait Worth It?', slug: '/advion-termite-bait-review/' }, { corpus });
    expect(r.category).toBeNull();
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ code: gate.CODES.CANNIBALIZES_EXISTING, entities: ['advion'], owners: ['/termite/advion-termite-bait/'] });
  });
});

describe('PR codex r5 (ab050983a)', () => {
  test('service-first place phrases are geographic too; Mobile/Sunrise still ordinary words', () => {
    for (const t of ['pest control Boston', 'termite treatment Austin', 'exterminator Houston', 'lawn care wellington']) {
      expect(gate.classifyGeoScope(t).scope).toBe('out_of_area');
    }
    for (const t of ['pest control mobile app', 'mosquito sunrise spraying', 'pest control homesteading tips']) {
      expect(gate.classifyGeoScope(t).scope).toBe('none');
    }
  });
});
