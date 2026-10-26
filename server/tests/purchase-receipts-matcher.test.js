/**
 * purchase-receipts/product-matcher.js — title -> exactly one active
 * product, via alias exact-match, then whole-word catalog-name containment.
 */
const { matchTitleToProduct, VARIANT_WORDS, variantWordsMissingFromName } = require('../services/purchase-receipts/product-matcher');

// Mimics the real query's server-side filtering (`.where('pc.active', true)`
// on the alias join, `.where({ active: true })` on the catalog scan) so a
// fixture's inactive rows are actually excluded, the way Postgres would.
function makeConn({ aliases = [], products = [] }) {
  return (table) => {
    const q = { _where: {} };
    q.join = () => q;
    q.where = (...args) => {
      if (args.length === 1 && typeof args[0] === 'object') Object.assign(q._where, args[0]);
      else if (args.length >= 2) q._where[String(args[0]).replace(/^\w+\./, '')] = args[1];
      return q;
    };
    q.select = async () => {
      const rows = table === 'product_aliases as pa' ? aliases : products;
      return rows.filter((row) => Object.entries(q._where).every(([k, v]) => row[k] === v));
    };
    return q;
  };
}

describe('matchTitleToProduct', () => {
  test('exact alias match (case/space-insensitive), active product only', async () => {
    const conn = makeConn({
      aliases: [{ alias_name: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)', id: 'p-talak', name: 'Talak 96 oz', active: true, container_size: '96 fl oz' }],
      products: [],
    });
    const result = await matchTitleToProduct('  atticus talak 7.9 f bifenthrin insecticide concentrate (96OZ)  ', conn);
    expect(result).toMatchObject({ matched: true, matchType: 'alias', product: { id: 'p-talak' } });
  });

  test('catalog-name containment: whole words, exactly one active hit', async () => {
    const conn = makeConn({
      aliases: [],
      products: [
        { id: 'p-taurus', name: 'Taurus SC', active: true, container_size: '78 fl oz' },
        { id: 'p-other', name: 'Termidor SC', active: true, container_size: '78 fl oz' },
      ],
    });
    const result = await matchTitleToProduct('Control Solutions Taurus SC Termiticide 78 oz', conn);
    expect(result).toMatchObject({ matched: true, matchType: 'containment', product: { id: 'p-taurus' } });
  });

  test('containment never matches a substring of a longer word ("SC" must not match "Scatter")', async () => {
    const conn = makeConn({ aliases: [], products: [{ id: 'p-sc', name: 'SC', active: true }] });
    const result = await matchTitleToProduct('Scatter Granules 5 lb Bag', conn);
    expect(result.matched).toBe(false);
  });

  test('ambiguous: 2+ active catalog names contained in the title -> unmatched', async () => {
    const conn = makeConn({
      aliases: [],
      products: [
        { id: 'p1', name: 'Bifen', active: true },
        { id: 'p2', name: 'Bifen IT', active: true },
      ],
    });
    const result = await matchTitleToProduct('Generic Bifen IT Insecticide 32oz', conn);
    expect(result).toMatchObject({ matched: false, reason: 'ambiguous' });
  });

  test('an inactive (retired duplicate) row is never matched, by name or alias', async () => {
    const conn = makeConn({
      aliases: [], // the join already filters pc.active = true, so a retired product's alias never appears here
      products: [{ id: 'p-retired', name: 'Taurus SC', active: false }],
    });
    const result = await matchTitleToProduct('Control Solutions Taurus SC Termiticide 78 oz', conn);
    expect(result.matched).toBe(false);
  });

  test('a non-chemical personal item (Chromebook, shampoo, brass fittings) is unmatched', async () => {
    const conn = makeConn({
      aliases: [],
      products: [{ id: 'p-taurus', name: 'Taurus SC', active: true }],
    });
    expect((await matchTitleToProduct('Lenovo Chromebook Duet 11 inch', conn)).matched).toBe(false);
    expect((await matchTitleToProduct('Dove Shampoo 12 oz', conn)).matched).toBe(false);
    expect((await matchTitleToProduct('Brass Fittings Assortment Kit', conn)).matched).toBe(false);
  });

  test('empty title is unmatched without querying', async () => {
    const result = await matchTitleToProduct('   ', makeConn({}));
    expect(result).toEqual({ matched: false, reason: 'empty_title' });
  });
});

describe('GATE_PRODUCT_INTAKE_GUARD — near-name guard on the containment step', () => {
  const originalGate = process.env.GATE_PRODUCT_INTAKE_GUARD;
  afterEach(() => {
    if (originalGate === undefined) delete process.env.GATE_PRODUCT_INTAKE_GUARD;
    else process.env.GATE_PRODUCT_INTAKE_GUARD = originalGate;
  });
  const gateOn = () => { process.env.GATE_PRODUCT_INTAKE_GUARD = 'true'; };
  const catalogOf = (...names) => makeConn({ aliases: [], products: names.map((name, i) => ({ id: `p${i}`, name, active: true })) });

  const MUST_MATCH = [
    ['CSI-Pest Taurus SC Broad Spectrum Liquid Concentrate Termiticide/Insecticide 78 fl oz. Bottle (QGCY)', 'Taurus SC'],
    ['CSI-PEST TAURUS SC BROAD SPECTRUM LIQUID CONCENTRATE TERMITICIDE/INSECTICIDE 78 FL OZ. BOTTLE (QGCY)', 'Taurus SC'],
    ['SYNGENTA HERITAGE G AZOXYSTROBIN 0.31% BROAD SPECTRUM GRANULAR FUNGICIDE 30 LB. BAG', 'Heritage G'],
    ['Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz) | Control Ants, Mosquitoes, Cockroaches, Spiders, Fleas, Ticks & More', 'Atticus Talak 7.9 F'],
  ];
  test.each(MUST_MATCH)('gate on: the real containment title still matches (%s)', async (title, name) => {
    gateOn();
    const result = await matchTitleToProduct(title, catalogOf(name));
    expect(result).toMatchObject({ matched: true, matchType: 'containment', product: { name } });
  });

  test('gate on: an alias match is never guarded ("Antapex WSG is same as alpine", owner 2026-10-09)', async () => {
    gateOn();
    const conn = makeConn({
      aliases: [{ alias_name: 'ANTAPEX WSG BROAD SPECTURM WATER DISPERSIBLE GRANULE (WDG/WG) INSECTICIDE 500 GM. BOTTLE', id: 'p-alpine', name: 'Alpine WSG', active: true }],
      products: [{ id: 'p-alpine', name: 'Alpine WSG', active: true }],
    });
    const result = await matchTitleToProduct('ANTAPEX WSG BROAD SPECTURM WATER DISPERSIBLE GRANULE (WDG/WG) INSECTICIDE 500 GM. BOTTLE', conn);
    expect(result).toMatchObject({ matched: true, matchType: 'alias', product: { id: 'p-alpine' } });
  });

  const MUST_NOT_MATCH = [
    ['Dismiss NXT Turf Herbicide 1 gal', 'Dismiss', ['nxt']],
    ['Zoecon Gentrol Complete EC3 Insecticide 16 fl oz', 'Gentrol', ['complete', 'ec3']],
    ['Maxforce FC Magnum Roach Bait Gel 4 x 30 g', 'Maxforce FC', ['magnum']],
  ];
  test.each(MUST_NOT_MATCH)('gate on: "%s" no longer matches catalog "%s"', async (title, name, variantWords) => {
    gateOn();
    const result = await matchTitleToProduct(title, catalogOf(name));
    expect(result).toEqual({ matched: false, reason: 'variant_word', matchType: 'containment', candidates: ['p0'], variantWords });
  });

  test.each(MUST_NOT_MATCH)('gate off: "%s" still matches "%s" exactly as before', async (title, name) => {
    delete process.env.GATE_PRODUCT_INTAKE_GUARD;
    const result = await matchTitleToProduct(title, catalogOf(name));
    expect(result).toMatchObject({ matched: true, matchType: 'containment', product: { name } });
    process.env.GATE_PRODUCT_INTAKE_GUARD = 'false';
    expect((await matchTitleToProduct(title, catalogOf(name))).matched).toBe(true);
  });

  test('gate on: two containment hits stay ambiguous, as today', async () => {
    gateOn();
    const result = await matchTitleToProduct('Generic Bifen IT Insecticide 32oz', catalogOf('Bifen', 'Bifen IT'));
    expect(result).toMatchObject({ matched: false, reason: 'ambiguous' });
  });

  test('gate on: a size such as "4 x 30 g" or "500 g" never triggers the guard by itself', async () => {
    gateOn();
    expect((await matchTitleToProduct('Advion Cockroach Gel Bait 4 x 30 g', catalogOf('Advion Cockroach Gel Bait'))).matched).toBe(true);
    expect((await matchTitleToProduct('Alpine WSG Insecticide 500 g Bottle', catalogOf('Alpine WSG'))).matched).toBe(true);
  });
});

describe('variantWordsMissingFromName', () => {
  test('lists the variant words the name lacks, in title order, once each', () => {
    expect(variantWordsMissingFromName('zoecon gentrol complete ec3 complete insecticide', ['gentrol'])).toEqual(['complete', 'ec3']);
  });
  test('words the name already has do not count', () => {
    expect(variantWordsMissingFromName('syngenta heritage g fungicide', ['heritage', 'g'])).toEqual([]);
  });
  test('a word right after a number is a unit or size, never a variant', () => {
    expect(variantWordsMissingFromName('roach gel 4 x 30 g tube', ['roach', 'gel'])).toEqual([]);
    expect(variantWordsMissingFromName('roach gel 30 g magnum', ['roach', 'gel'])).toEqual(['magnum']);
  });
  test('generic descriptors are never variant words', () => {
    for (const word of ['liquid', 'concentrate', 'granular', 'granules', 'broad', 'spectrum', 'bait', 'spray', 'insecticide']) {
      expect(VARIANT_WORDS.has(word)).toBe(false);
    }
  });
  test('the reviewed list is the literal one the owner brief gave', () => {
    expect([...VARIANT_WORDS].sort()).toEqual(['advanced', 'aerosol', 'complete', 'cs', 'df', 'dg', 'duo', 'dust', 'ec', 'ec3', 'elite', 'evolution', 'ew', 'extra', 'fc', 'foam', 'forte', 'g', 'gold', 'gr', 'he', 'ii', 'iii', 'iv', 'magnum', 'max', 'maxx', 'me', 'nxt', 'plus', 'prime', 'pro', 'pt', 'rtu', 'sc', 'select', 'sl', 'trio', 'ultra', 'wdg', 'wg', 'wp', 'wsg', 'xl', 'xp', 'xt', 'xtra', 'xts'].sort());
  });
});
