// Email division per-visit product reader — pure-function tests only (no
// DB). DB-backed reads are covered in email-division-postgres.test.js.
const {
  PRODUCT_FAMILIES, PRODUCT_LABELS, PEST_KEYWORDS, classifyProduct, rankVisibleProducts, parsePestsNamed, pestsTargeted, nutrientsListed,
  allCustomerFacingStrings, readVisitProducts,
} = require('../services/email-division/visit-products');

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
  test('"ZOECON 10578 Gentrol Complete EC3" (pyriproxyfen + permethrin + tetramethrin) never gets the Gentrol IGR label note or fact-gentrol-igr-hydroprene', async () => {
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
    ['Taurus SC', 'fipronil', 'a non-repellent insecticide that target pests cannot detect, so they touch it, ingest it and spread it through the colony'],
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
  // Only these two exact phrases may contain a digit+day/week/hour — both
  // label-sourced. Every other family's text (herbicide/fungicide/nutrition/
  // adjuvant have no verified source yet) must say nothing time-specific.
  const ALLOWED_TIMELINE_STRINGS = [
    'The label asks for application when rain is not predicted for the next 24 hours; people and pets stay off treated surfaces until the spray has dried.',
    'The Gentrol IGR label states continuous protection for 4 months.',
  ];

  test('no stray digit+day/week/hour claim outside the two allowed strings, which are both present', () => {
    const strings = allCustomerFacingStrings();
    const timelinePattern = /\d+\s*(day|week|hour|month)/i;
    for (const str of strings) {
      if (ALLOWED_TIMELINE_STRINGS.includes(str)) continue;
      expect(str).not.toMatch(timelinePattern);
    }
    for (const allowed of ALLOWED_TIMELINE_STRINGS) expect(strings).toContain(allowed);
    expect(PRODUCT_FAMILIES.adjuvant.customerVisible).toBe(false);
  });

  test('the ONLY fact slugs visit-products can emit are these three fact-register slugs', () => {
    // Each must exist in server/services/email-division/fact-register-data.js
    // (PR #5187). A slug that is not a real register fact must never be
    // emitted — families carry no slugs at all; a label carries its fact's.
    const emittable = new Set(Object.values(PRODUCT_LABELS).flatMap((label) => label.factSlugs));
    for (const def of Object.values(PRODUCT_FAMILIES)) expect(def.factSlugs).toBeUndefined();
    expect([...emittable].sort()).toEqual(['fact-bifenthrin-talak-label', 'fact-gentrol-igr-hydroprene', 'fact-taurus-sc-non-repellent']);
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
    ['Gentrol IGR', 'hydroprene', 'fact-gentrol-igr-hydroprene', 'Gentrol IGR Concentrate label', false],
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

  test.each(['fungicide', 'herbicide', 'nutrition', 'adjuvant', 'other'])('%s has no label, so its products are never verified', async (family) => {
    expect(PRODUCT_FAMILIES[family].labels).toEqual([]);
  });
});

describe('pestsTargeted (area-intel treatment evidence)', () => {
  test.each([
    [['Ghost ants', 'Big-headed ants', 'Fire ants'], ['ghost ants', 'big-headed ants', 'fire ants']],
    [['Wolf spiders', 'Widow spiders'], ['widow spiders']], // specific subtype suppresses generic parent
    [['Green-up', 'Iron chlorosis', 'Ficus whitefly'], []], // non-pest / unlisted targets never count
    [[], []], [null, []],
  ])('%j -> %j', (targets, expected) => {
    expect(pestsTargeted(targets)).toEqual(expect.arrayContaining(expected));
    expect(pestsTargeted(targets)).toHaveLength(expected.length);
  });
});
