// Email division per-visit product reader — pure-function tests only (no
// DB). DB-backed reads are covered in email-division-postgres.test.js.
const {
  PRODUCT_FAMILIES, classifyProduct, rankVisibleProducts, parsePestsNamed, allCustomerFacingStrings,
} = require('../services/email-division/visit-products');

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
  ])('%s (%s) classifies as %s', (productName, activeIngredient, expected) => {
    expect(classifyProduct({ productName, activeIngredient })).toBe(expected);
  });

  test('case-insensitive, falls back to product_name, active_ingredient wins, unrecognized -> "other"', () => {
    expect(classifyProduct({ productName: 'taurus sc', activeIngredient: 'FIPRONIL' })).toBe('non_repellent');
    expect(classifyProduct({ productName: 'Talstar P', activeIngredient: '' })).toBe('contact_residual');
    expect(classifyProduct({ productName: 'House Brand Spray', activeIngredient: 'fipronil' })).toBe('non_repellent');
    expect(classifyProduct({ productName: 'Mystery Blend 42', activeIngredient: 'unobtanium' })).toBe('other');
    expect(PRODUCT_FAMILIES.other.notes).toEqual([]);
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
    'The Gentrol IGR (hydroprene) label states 120 days of control.',
  ];

  test('no stray digit+day/week/hour claim outside the two allowed strings, which are both present', () => {
    const strings = allCustomerFacingStrings();
    const timelinePattern = /\d+\s*(day|week|hour)/i;
    for (const str of strings) {
      if (ALLOWED_TIMELINE_STRINGS.includes(str)) continue;
      expect(str).not.toMatch(timelinePattern);
    }
    for (const allowed of ALLOWED_TIMELINE_STRINGS) expect(strings).toContain(allowed);
    expect(PRODUCT_FAMILIES.adjuvant.customerVisible).toBe(false);
  });

  test.each([
    ['herbicide', false], ['fungicide', false], ['nutrition', false], ['adjuvant', false],
    ['non_repellent', true], ['contact_residual', true], ['igr', true],
  ])('%s is verified:%s', (family, verified) => {
    expect(PRODUCT_FAMILIES[family].verified).toBe(verified);
    if (!verified) expect(PRODUCT_FAMILIES[family].notes).toEqual([]);
  });
});
