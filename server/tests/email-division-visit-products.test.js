// Email division per-visit product reader — pure-function tests only (no
// DB). DB-backed reads are covered in email-division-postgres.test.js.
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const {
  PRODUCT_FAMILIES, PRODUCT_LABELS, PEST_KEYWORDS, classifyProduct, rankVisibleProducts, parsePestsNamed, treatmentTargets, nutrientsListed,
  allCustomerFacingStrings, readVisitProducts, FIRST_VISIT_DEFAULT_SHIPPED_AT,
} = require('../services/email-division/visit-products');
const { FACTS } = require('../services/email-division/fact-register-data');
const { targetForSentence } = require('../services/email-division/area-intel');
const { etDateString } = require('../utils/datetime-et');

// Minimal knex-shaped stub:
// conn('service_products as sp').leftJoin(...).where(...).orderBy(...).select(...) -> rows.
function stubConn(rows) {
  return () => ({ leftJoin: () => ({ where: () => ({ orderBy: () => ({ select: async () => rows }) }) }) });
}
async function readOne(row) {
  const { products } = await readVisitProducts('sr-1', { conn: stubConn([row]) });
  return products[0];
}

describe('readVisitProducts source scope: a recorded active ingredient wins over the product name', () => {
  test('"ZOECON 10578 Gentrol Complete EC3" (pyriproxyfen + permethrin + tetramethrin) never gets the Gentrol IGR label phrase or fact-gentrol-igr-hydroprene', async () => {
    const { products } = await readVisitProducts('sr-1', { conn: stubConn([
      { product_name: 'ZOECON 10578 Gentrol Complete EC3 Insecticide and Growth Regulator', active_ingredient: 'Nylar (pyriproxyfen) + Permethrin + Tetramethrin' },
    ]) });
    expect(products[0]).toMatchObject({ family: 'igr', verified: false, notes: [], factSlugs: [] });
  });

  test.each([
    ['Gentrol IGR', 'hydroprene', true],
    ['Gentrol IGR', '', true], // no active ingredient recorded -> the name is the only evidence
    ['Gentrol IGR', '   ', true], // whitespace-only counts as absent
    ['Gentrol IGR', null, true],
    ['Taurus SC', 'imidacloprid', false], // the name matches, but the recorded AI is not fipronil
    ['Talstar P', 'lambda-cyhalothrin', false], // the name matches, but not bifenthrin
    // Sharing the labeled product's active ingredient is never enough — the
    // claim is the LABEL's, and these are different labels (pricing.csv).
    ['Topchoice Granular Insecticide', 'Fipronil 0.0143%', false],
    ['LESCO Crosscheck Plus', '7.9% Bifenthrin', false],
    ['House Brand Bifenthrin', 'bifenthrin', false],
    ['Distance IGR', 'Pyriproxyfen', false],
    ['Gentrol Point Source', 'hydroprene', false],
  ])('%s / %j -> verified:%s', async (productName, activeIngredient, verified) => {
    const product = await readOne({ product_name: productName, active_ingredient: activeIngredient });
    expect(product.verified).toBe(verified);
    if (!verified) {
      expect(product).toMatchObject({ notes: [], factSlugs: [], dryRule: null, source: null });
    }
  });
});

describe('readVisitProducts wording comes from the product\'s own data, never a family default', () => {
  test.each([
    // Topchoice is granular fipronil for fire ants — not Taurus SC's
    // colony-transfer description.
    ['Topchoice Granular Insecticide', 'Fipronil 0.0143%', 'an insecticide'],
    ['Alpine WSG', 'dinotefuran', 'an insecticide'],
    ['Delta Dust', 'deltamethrin', 'an insecticide'],
    // Distance IGR is a Tree & Shrub whitefly/scale product — never "immature roaches".
    ['Distance IGR', 'Pyriproxyfen', 'an insect growth regulator'],
    // Talak's label states no mode of action and no residual -> neutral phrase.
    ['Talstar P', 'bifenthrin', 'an insecticide'],
    // Exactly templates PR #5277's manufacturer wording — no colony claim
    // (the phrase is rendered for roach visits too).
    ['Taurus SC', 'fipronil', 'a non-repellent insecticide that target pests cannot detect, so they touch, ingest and spread it'],
    ['Gentrol IGR', '(S)-Hydroprene 9.0%', 'an insect growth regulator: cockroaches exposed to it become adults that cannot reproduce'],
  ])('%s (%s) -> %j', async (productName, activeIngredient, phrase) => {
    expect((await readOne({ product_name: productName, active_ingredient: activeIngredient })).phrase).toBe(phrase);
  });

  test('recorded targets ride along as data (the technician\'s picks, not a family assumption)', async () => {
    const product = await readOne({ product_name: 'Distance IGR', active_ingredient: 'Pyriproxyfen', targets: ['Ficus whitefly', ' ', 'Scale insects'] });
    expect(product.targets).toEqual(['Ficus whitefly', 'Scale insects']);
  });

  test.each([
    // pricing.csv rows 43-45 / 176: iron + manganese, no potassium.
    ['LESCO Chelated Iron Plus 12-0-0 6% Fe 2% Mn All Purpose Liquid Fertilizer', 'Nitrogen + iron + manganese', 'a nutrition product with nitrogen, iron and manganese'],
    ['ArborJet Mn-Jet Fe Micros', 'Manganese + Iron', 'a nutrition product with iron and manganese'],
    ['LESCO Chelated Iron Plus 12-0-0 2%Mn 6%Fe 4%S', '12-0-0 2%Mn 6%Fe 4%S', 'a nutrition product with nitrogen, iron, manganese and sulfur'],
    ['LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', 'Potassium 0-0-25 + sulfur', 'a nutrition product with potassium and sulfur'],
    ['LESCO Chelated AM + Micros', 'Chelated micronutrients', 'a nutrition product with micronutrients'],
    ['LESCO K-Flow 0-0-25', null, 'a nutrition product'], // no AI recorded -> no nutrient named, even from the name
  ])('%s (%s) -> %j', async (productName, activeIngredient, phrase) => {
    const product = await readOne({ product_name: productName, active_ingredient: activeIngredient });
    expect(product).toMatchObject({ family: 'nutrition', phrase });
  });

  test('nutrientsListed never reads a stray capital letter as an element', () => {
    expect(nutrientsListed('(S)-Hydroprene 9.0%')).toEqual([]);
    expect(nutrientsListed('Mn + Fe + Mg + S')).toEqual(['iron', 'manganese', 'magnesium']);
    expect(nutrientsListed('0-0-25')).toEqual(['potassium']);
  });
});

describe('classifyProduct', () => {
  test.each([
    ['Taurus SC', 'fipronil', 'non_repellent'],
    ['Alpine WSG', 'dinotefuran', 'non_repellent'],
    ['Talstar P', 'bifenthrin', 'contact_residual'],
    ['Bifen I/T', 'bifenthrin', 'contact_residual'],
    ['Talak', 'bifenthrin', 'contact_residual'],
    ['Demand CS', 'lambda-cyhalothrin', 'contact_residual'],
    ['Delta Dust', 'deltamethrin', 'contact_residual'],
    ['Gentrol IGR', 'hydroprene', 'igr'],
    ['Celsius WG', 'thiencarbazone + iodosulfuron + dicamba', 'herbicide'],
    ['Sedgehammer', 'halosulfuron', 'herbicide'],
    ['Artavia 2 SC', 'azoxystrobin', 'fungicide'],
    ['T-Storm', 'thiophanate-methyl', 'fungicide'],
    ['LESCO K-Flow 0-0-25', 'potassium', 'nutrition'],
    ['LESCO chelated iron', 'iron', 'nutrition'],
    ['LESCO chelated manganese', 'manganese', 'nutrition'],
    ['LESCO chelated micronutrients', 'micronutrient', 'nutrition'],
    ['LESCO 90/10 nonionic surfactant', 'nonionic surfactant', 'adjuvant'],
    // pricing.csv row 116 — neither the AI nor a chemistry list names it,
    // but it is a wetting agent (catalog: Soil Surfactant / wetting_agent).
    ['Dispatch Sprayable Wetting Agent', 'Alkoxylated polyols + glucoethers', 'adjuvant'],
    ['LESCO Moisture Manager', 'Humectants + non-ionic surfactant', 'adjuvant'],
  ])('%s (%s) classifies as %s', (productName, activeIngredient, expected) => {
    expect(classifyProduct({ productName, activeIngredient })).toBe(expected);
  });

  test('a catalogued/recorded adjuvant category or product type keeps any product internal', () => {
    for (const fields of [
      { productCategory: 'Soil Surfactant' }, { catalogCategory: 'soil_surfactant' }, { catalogCategory: 'adjuvant' },
      { catalogProductType: 'wetting_agent' },
    ]) {
      expect(classifyProduct({ productName: 'Brand X', activeIngredient: 'Alkoxylated polyols', ...fields })).toBe('adjuvant');
    }
    expect(classifyProduct({ productName: 'Taurus SC', activeIngredient: 'fipronil', catalogCategory: 'termiticide' })).toBe('non_repellent');
  });

  test('a catalogued/recorded category decides the generic herbicide, fungicide and IGR families (codex round 8 P2) — ingredient/name matches still win first', () => {
    // Real rows from 20260401000017_dispatch.js:50-53 — neither name nor
    // active ingredient is in any FAMILIES list, so only the recorded
    // category can save them from 'other'.
    expect(classifyProduct({ productName: 'Prodiamine 65 WDG', activeIngredient: 'Prodiamine', catalogCategory: 'herbicide' })).toBe('herbicide');
    expect(classifyProduct({ productName: 'Pillar G Intrinsic', activeIngredient: 'Pyraclostrobin + Triticonazole', catalogCategory: 'fungicide' })).toBe('fungicide');
    // pricing.csv Category column spelling, and product_category too.
    expect(classifyProduct({ productName: 'Some Broadleaf Mix', activeIngredient: 'unlisted-chemistry', productCategory: 'Herbicide' })).toBe('herbicide');
    expect(classifyProduct({ productName: 'Some Turf Fungicide', activeIngredient: 'unlisted-chemistry', catalogProductType: 'Fungicide' })).toBe('fungicide');
    expect(classifyProduct({ productName: 'Some IGR Blend', activeIngredient: 'unlisted-chemistry', catalogCategory: 'IGR' })).toBe('igr');
    expect(classifyProduct({ productName: 'Some IGR Blend', activeIngredient: 'unlisted-chemistry', productCategory: 'Insect Growth Regulator' })).toBe('igr');
    // A specific ingredient/name match still wins over a misleading category.
    expect(classifyProduct({ productName: 'Taurus SC', activeIngredient: 'fipronil', catalogCategory: 'herbicide' })).toBe('non_repellent');
    // A 'termiticide' category is now caught by the generic pesticide
    // fallback (codex round 10 P2) — no longer 'other'.
    expect(classifyProduct({ productName: 'Mystery Blend 42', activeIngredient: 'unobtanium', catalogCategory: 'termiticide' })).toBe('insecticide');
    // No matching category at all -> still 'other'.
    expect(classifyProduct({ productName: 'Mystery Blend 42', activeIngredient: 'unobtanium', catalogCategory: 'greenhouse supply' })).toBe('other');
  });

  test('a catalogued herbicide/fungicide caught only by category carries no label claim or fact slug, and ranks above nutrition', async () => {
    const { products, primary, secondary } = await readVisitProducts('sr-1', { conn: stubConn([
      { product_name: 'LESCO 6-0-0 Liquid', active_ingredient: '6-0-0', catalog_category: 'Fertilizer' },
      { product_name: 'Prodiamine 65 WDG', active_ingredient: 'Prodiamine', catalog_category: 'herbicide' },
    ]) });
    const prodiamine = products.find((p) => p.productName === 'Prodiamine 65 WDG');
    expect(prodiamine).toMatchObject({
      family: 'herbicide', verified: false, notes: [], factSlugs: [], dryRule: null, source: null, phrase: 'a weed control',
    });
    // The pesticide ranks primary over the fertilizer's feeding-goal phrase.
    expect(primary.productName).toBe('Prodiamine 65 WDG');
    expect(secondary.productName).toBe('LESCO 6-0-0 Liquid');
  });

  test('a recorded pesticide category outranks a generic NPK/nutrient-substring match (codex round 9 P2) — exact Stonewall row', () => {
    // pricing.csv:146 — "LESCO Stonewall 0.43% 0-0-7" is a real pre-emergent
    // herbicide + potassium combo, category Herbicide. Its AI text contains
    // the nutrition family's generic '0-0-' NPK pattern, which the ai
    // substring loop used to hit before the herbicide-category fallback
    // ever ran, misclassifying it 'nutrition' and dropping its weed targets.
    expect(classifyProduct({
      productName: 'LESCO Stonewall 0.43% 0-0-7', activeIngredient: 'Prodiamine 0.43% + 0-0-7', catalogCategory: 'Herbicide',
    })).toBe('herbicide');
    // Same shape, a different NPK analysis and category spelling.
    expect(classifyProduct({
      productName: 'LESCO Stonewall 0.37% 18-0-10', activeIngredient: 'Prodiamine 0.37% + 18-0-10', productCategory: 'herbicide',
    })).toBe('herbicide');
    // No recorded category at all -> the generic NPK pattern is all that's
    // left, and it still means nutrition (unchanged from before this fix).
    expect(classifyProduct({ productName: 'Mystery 0-0-7 Blend', activeIngredient: '0-0-7' })).toBe('nutrition');
  });

  test('a specific pesticide ingredient/name match outranks a Fertilizer category (codex round 9 P2) — a weed-and-feed catalogued as Fertilizer still counts its herbicide targets', () => {
    // Deliberate decision: the herbicide chemistry is real, so it is counted
    // (safest for customer copy) rather than swallowed by the catalog's
    // Fertilizer label.
    expect(classifyProduct({ productName: 'Brand Weed & Feed', activeIngredient: 'dicamba', catalogCategory: 'Fertilizer' })).toBe('herbicide');
    expect(classifyProduct({ productName: 'Talstar P', activeIngredient: 'bifenthrin', catalogCategory: 'Fertilizer' })).toBe('contact_residual');
    // No specific ingredient/name match -> the Fertilizer category still wins
    // (unchanged from round 7).
    expect(classifyProduct({ productName: 'Brand Weed & Feed', activeIngredient: 'unlisted-chemistry', catalogCategory: 'Fertilizer' })).toBe('nutrition');
  });

  test('a catalogued insecticide caught only by the generic pesticide category never falls to \'other\' and ranks above a fertilizer (codex round 10 P2) — exact Acelepryn Xtra row', async () => {
    // pricing.csv:15 — neither name nor active ingredient is in any FAMILIES
    // list; only the recorded category ("Insecticide") saves it.
    expect(classifyProduct({
      productName: 'Acelepryn Xtra', activeIngredient: 'Chlorantraniliprole & Thiamethoxam', productCategory: 'Insecticide',
    })).toBe('insecticide');
    const { products, primary, secondary } = await readVisitProducts('sr-1', { conn: stubConn([
      { product_name: 'LESCO 6-0-0 Liquid', active_ingredient: '6-0-0', catalog_category: 'Fertilizer' },
      { product_name: 'Acelepryn Xtra', active_ingredient: 'Chlorantraniliprole & Thiamethoxam', product_category: 'Insecticide' },
    ]) });
    const acelepryn = products.find((p) => p.productName === 'Acelepryn Xtra');
    expect(acelepryn).toMatchObject({ family: 'insecticide', verified: false, notes: [], factSlugs: [], dryRule: null, source: null, phrase: 'an insecticide' });
    expect(primary.productName).toBe('Acelepryn Xtra');
    expect(secondary.productName).toBe('LESCO 6-0-0 Liquid');
  });

  test('every distinct pesticide Category in pricing.csv classifies as a real family, never "other" or "nutrition" (codex round 10 P2) — the general rule, not a hardcoded list', () => {
    // Categories genuinely NOT a pesticide (nutrition/adjuvant, already
    // handled by their own category regexes) or not a pesticide at all
    // (plant growth regulators — Primo Maxx/Anuew/Shortstop mow-frequency
    // products, chemically nothing like an insecticide/herbicide/fungicide)
    // are excluded from this sweep on purpose.
    const NON_PESTICIDE_CATEGORIES = new Set([
      '', 'Adjuvant', 'Fertilizer', 'Micronutrient Fertilizer', 'Soil Amendment / Biostimulant',
      'Soil Moisture Management Aid', 'Soil Surfactant', 'Soils, Mulch & Amendments',
      'Growth Regulator', 'Plant Growth Regulator',
    ]);
    const rows = parse(fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true });
    const categories = [...new Set(rows.map((r) => r.Category).filter((c) => c != null))];
    const pesticideCategories = categories.filter((c) => !NON_PESTICIDE_CATEGORIES.has(c));
    expect(pesticideCategories.length).toBeGreaterThan(3); // the sweep must actually cover something
    for (const category of pesticideCategories) {
      const family = classifyProduct({ productName: 'Unlisted Synthetic Product', activeIngredient: 'unlisted-chemistry', productCategory: category });
      expect({ category, family }).not.toMatchObject({ family: 'other' });
      expect({ category, family }).not.toMatchObject({ family: 'nutrition' });
    }
  });

  test('a catalogued nutrition category decides nutrition even when name and analysis miss the lists (codex round 7 P2)', () => {
    for (const fields of [
      { catalogCategory: 'Fertilizer' }, { catalogCategory: 'Micronutrient Fertilizer' }, { productCategory: 'Soil Amendment / Biostimulant' },
    ]) {
      expect(classifyProduct({ productName: 'LESCO 6-0-0 Liquid', activeIngredient: '6-0-0', ...fields })).toBe('nutrition');
    }
    // a weed-and-feed is catalogued as Herbicide and stays a herbicide
    expect(classifyProduct({ productName: 'Brand Weed & Feed', activeIngredient: 'atrazine', catalogCategory: 'Herbicide' })).not.toBe('nutrition');
    // and a fertilizer's feeding goals are never counted as pests treated
    expect(treatmentTargets([{ product_name: 'LESCO 6-0-0 Liquid', active_ingredient: '6-0-0', catalog_category: 'Fertilizer', targets: ['Nitrogen green-up'] }])).toEqual([]);
  });

  test('a catalogued wetting agent is never ranked primary and carries no customer phrase', async () => {
    const { products, primary } = await readVisitProducts('sr-1', { conn: stubConn([
      { product_name: 'Dispatch Sprayable Wetting Agent', active_ingredient: 'Alkoxylated polyols + glucoethers', catalog_category: 'soil_surfactant' },
      { product_name: 'Catalog Soil Aid', active_ingredient: 'Alkoxylated polyols', product_category: 'Soil Surfactant' },
    ]) });
    expect(products.map((p) => [p.family, p.customerVisible, p.phrase])).toEqual([['adjuvant', false, null], ['adjuvant', false, null]]);
    expect(primary).toBeNull();
  });

  test('case-insensitive, falls back to product_name, active_ingredient wins, unrecognized -> "other"', () => {
    expect(classifyProduct({ productName: 'taurus sc', activeIngredient: 'FIPRONIL' })).toBe('non_repellent');
    expect(classifyProduct({ productName: 'Talstar P', activeIngredient: '' })).toBe('contact_residual');
    expect(classifyProduct({ productName: 'House Brand Spray', activeIngredient: 'fipronil' })).toBe('non_repellent');
    expect(classifyProduct({ productName: 'Mystery Blend 42', activeIngredient: 'unobtanium' })).toBe('other');
    expect(PRODUCT_FAMILIES.other.labels).toEqual([]);
  });
});

describe('rankVisibleProducts (primary/secondary selection)', () => {
  function product(family) {
    return { family, customerVisible: PRODUCT_FAMILIES[family].customerVisible, productName: family };
  }

  test('non_repellent > contact_residual > rest; adjuvants excluded and never primary; adjuvant-only has no primary', () => {
    expect(rankVisibleProducts([product('contact_residual'), product('non_repellent'), product('igr')]))
      .toMatchObject({ primary: { family: 'non_repellent' }, secondary: { family: 'contact_residual' } });
    const products = [product('adjuvant'), product('herbicide')];
    expect(products.filter((p) => p.customerVisible)).toHaveLength(1);
    expect(rankVisibleProducts(products)).toMatchObject({ primary: { family: 'herbicide' }, secondary: null });
    expect(rankVisibleProducts([product('adjuvant')])).toEqual({ primary: null, secondary: null });
  });
});

describe('parsePestsNamed', () => {
  test('parses the elided plural list ("ghost, big-headed, and crazy ants") into three species, and a 2-item list', () => {
    const notes = 'WHAT WE DID: treated the perimeter for ghost, big-headed, and crazy ants near the foundation.';
    expect(parsePestsNamed(notes)).toEqual(expect.arrayContaining(['ghost ants', 'big-headed ants', 'crazy ants']));
    expect(parsePestsNamed(notes)).toHaveLength(3);
    expect(parsePestsNamed('Found big-headed and crazy ants at the slab.'))
      .toEqual(expect.arrayContaining(['big-headed ants', 'crazy ants']));
  });

  test.each([
    ['Applied at the labeled rate. Treated a separate zone out back.', []],
    ['Set bait stations for rats in the garage.', ['rats']],
    ['', []],
    [null, []],
    ['WHAT WE DID: sprayed for German cockroaches under the sink and saw a few fire ants outside.', ['fire ants', 'German cockroaches']],
    // "widow spiders" also matches the generic "spiders" regex — the
    // specific subtype suppresses its generic parent so it's reported once.
    ['WHAT WE DID: found widow spiders in the garage.', ['widow spiders']],
    ['WHAT WE DID: swept spider webs from the eaves.', ['spiders']], // no specific subtype -> generic still reports
  ])('%s -> %j (canonical names only, never free text)', (notes, expected) => {
    expect(parsePestsNamed(notes)).toEqual(expected);
  });
});

describe('PRODUCT_FAMILIES customer-facing text carries no fabricated timeline', () => {
  // Only this exact string may contain a digit+time unit — it is the Talak
  // label's application condition (rain in the next 24 hours), not an
  // efficacy timeline. Owner ruling 2026-09-28: no product statement states
  // an efficacy timeline.
  const ALLOWED_TIMELINE_STRINGS = [
    'The label asks for application when rain is not predicted for the next 24 hours; people and pets stay off treated surfaces until the spray has dried.',
  ];

  test('no stray digit+day/week/month/hour claim outside the one allowed string, which is present', () => {
    const strings = allCustomerFacingStrings();
    const timelinePattern = /\d+\s*(day|week|month|hour)/i;
    for (const str of strings) {
      if (ALLOWED_TIMELINE_STRINGS.includes(str)) continue;
      expect(str).not.toMatch(timelinePattern);
    }
    for (const allowed of ALLOWED_TIMELINE_STRINGS) expect(strings).toContain(allowed);
    expect(PRODUCT_FAMILIES.adjuvant.customerVisible).toBe(false);
  });

  test('no customer-facing string claims a colony or a "you may still see … for a while" window', () => {
    const strings = allCustomerFacingStrings();
    expect(strings).toContain('a non-repellent insecticide that target pests cannot detect, so they touch, ingest and spread it');
    for (const str of strings) {
      expect(str).not.toMatch(/colon(y|ies)/i);
      expect(str).not.toMatch(/still see|for a while/i);
    }
    for (const label of Object.values(PRODUCT_LABELS)) expect(label.notes).toEqual([]);
  });

  test('every fact slug visit-products can emit is a live fact in the fact register', () => {
    // The register (server/services/email-division/fact-register-data.js,
    // #5187) is the authority: a slug that is missing, or a fact past its
    // expiresOn, must never be emitted. Families carry no slugs at all; a
    // label carries its fact's.
    const register = new Map(FACTS.map((fact) => [fact.slug, fact]));
    const today = etDateString();
    const emittable = [...new Set(Object.values(PRODUCT_LABELS).flatMap((label) => label.factSlugs))];
    for (const def of Object.values(PRODUCT_FAMILIES)) expect(def.factSlugs).toBeUndefined();
    expect(emittable.length).toBeGreaterThan(0);
    for (const slug of emittable) {
      const fact = register.get(slug);
      expect({ slug, inRegister: Boolean(fact) }).toEqual({ slug, inRegister: true });
      if (fact.expiresOn) expect(today < fact.expiresOn).toBe(true);
    }
  });

  test('no label text claims a residual, and every label cites its source', () => {
    for (const label of Object.values(PRODUCT_LABELS)) {
      expect(label.source).toBeTruthy();
      for (const text of [label.phrase, label.dryRule?.text, ...label.notes.map((n) => n.text)].filter(Boolean)) {
        expect(text).not.toMatch(/residual|lasts?\b|long-lasting/i);
      }
    }
  });

  test.each([
    ['Talak 7.9 F', 'bifenthrin', 'fact-bifenthrin-talak-label', 'Talak 7.9 F label (EPA 91234-145)', true],
    ['Bifen IT', 'Bifenthrin 7.9%', 'fact-bifenthrin-talak-label', 'Talak 7.9 F label (EPA 91234-145)', true],
    ['Gentrol IGR', 'hydroprene', 'fact-gentrol-igr-hydroprene', 'Gentrol IGR Concentrate label', true],
    ['Taurus SC', 'fipronil', 'fact-taurus-sc-non-repellent', 'Control Solutions, Taurus SC product page', true],
    ['Bifen XTS', 'bifenthrin + zeta-cypermethrin', null, null, true], // different registration
    ['Artavia 2 SC', 'azoxystrobin', null, null, true],
  ])('%s -> slug %s, source %s, noTimeline %s', async (productName, activeIngredient, slug, source, noTimeline) => {
    const product = await readOne({ product_name: productName, active_ingredient: activeIngredient });
    expect(product.factSlugs).toEqual(slug ? [slug] : []);
    expect(product.source).toBe(source);
    expect(product.noTimeline).toBe(noTimeline);
  });

  test('every family phrase is target-neutral: no pest name, and no pest word outside a sourced label phrase', () => {
    for (const [family, def] of Object.entries(PRODUCT_FAMILIES)) {
      if (!def.phrase) continue;
      for (const [, pattern] of PEST_KEYWORDS) expect(`${family}: ${def.phrase}`).not.toMatch(pattern);
      expect(def.phrase).not.toMatch(/\b(ants?|roach(es)?|cockroach(es)?|colony|potassium|iron|manganese|nitrogen)\b/i);
    }
  });

  test.each(['fungicide', 'herbicide', 'insecticide', 'nutrition', 'adjuvant', 'other'])('%s has no label, so its products are never verified', async (family) => {
    expect(PRODUCT_FAMILIES[family].labels).toEqual([]);
  });
});

describe('treatmentTargets (area-intel treatment evidence)', () => {
  const bifen = (targets) => ({ product_name: 'Bifen I/T', active_ingredient: 'bifenthrin', targets });

  // The completion picker's own catalog (SchedulePage.jsx) — the canonical
  // source of service_products.targets chips. Read as text: it is client code.
  const schedulePage = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/SchedulePage.jsx'), 'utf8');
  const pickerList = (name) => {
    const match = schedulePage.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };

  test.each(['PEST_TARGET_SUGGESTIONS', 'LAWN_TARGET_SUGGESTIONS', 'ORNAMENTAL_TARGET_SUGGESTIONS'])('every %s chip on a pest product is counted as itself', (list) => {
    const chips = pickerList(list);
    expect(chips.length).toBeGreaterThan(10);
    const keys = treatmentTargets([bifen(chips)]);
    expect(keys).toHaveLength(new Set(chips.map((c) => c.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase())).size);
  });

  test('NUTRITION_TARGET_SUGGESTIONS chips on a fertilizer are feeding goals, never pests', () => {
    const chips = pickerList('NUTRITION_TARGET_SUGGESTIONS');
    expect(chips.length).toBeGreaterThan(5);
    expect(treatmentTargets([{ product_name: 'LESCO K-Flow 0-0-25', active_ingredient: 'Potassium 0-0-25 + sulfur', targets: chips }])).toEqual([]);
  });

  test('species a keyword allowlist dropped are counted, keyed case-/space-insensitively across products', () => {
    expect(treatmentTargets([
      bifen(['White-footed ants', 'Bed bugs', ' Subterranean  termites ']),
      { product_name: 'Distance IGR', active_ingredient: 'Pyriproxyfen', targets: ['Chilli thrips', 'white-footed ants'] },
      { product_name: 'Celsius WG', active_ingredient: 'thiencarbazone', targets: ['Annual bluegrass (Poa annua)'] },
    ])).toEqual(['white-footed ants', 'bed bugs', 'subterranean termites', 'chilli thrips', 'annual bluegrass']);
  });

  test('an adjuvant\'s chips and blank / missing targets never count', () => {
    expect(treatmentTargets([
      { product_name: 'Dispatch Sprayable Wetting Agent', active_ingredient: 'Alkoxylated polyols', catalog_category: 'soil_surfactant', targets: ['Dry spots'] },
      bifen([' ', '']), bifen(null), { product_name: 'Talak' },
    ])).toEqual([]);
    expect(treatmentTargets(null)).toEqual([]);
  });

  test('the area-intel sentence restores proper nouns in a lower-cased key', () => {
    expect(targetForSentence('german cockroaches')).toBe('German cockroaches');
    expect(targetForSentence('sri lanka weevil')).toBe('Sri Lanka weevil');
    expect(targetForSentence('big-headed ants')).toBe('big-headed ants');
  });
});

// Owner ruling 2026-09-29: getActivityRatingAverages excludes a legacy
// NULL-flag first-visit 5 only from this exact instant onward — the
// first-visit default rating's own ship time (owner ruling 2026-09-24,
// server/services/pest-pressure/first-visit.js, #4741 / #4767). Pinned here
// so an accidental edit to the exported constant is caught immediately,
// without needing Postgres.
describe('FIRST_VISIT_DEFAULT_SHIPPED_AT (owner ruling 2026-09-29)', () => {
  test('is the first-visit default rating\'s own ship instant', () => {
    expect(FIRST_VISIT_DEFAULT_SHIPPED_AT).toBe('2026-09-24T10:21:12Z');
    expect(new Date(FIRST_VISIT_DEFAULT_SHIPPED_AT).toISOString()).toBe('2026-09-24T10:21:12.000Z');
  });
});
