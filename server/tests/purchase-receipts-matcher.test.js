/**
 * purchase-receipts/product-matcher.js — title -> exactly one active
 * product, via alias exact-match, then whole-word catalog-name containment.
 */
const { matchAmazonTitleToProduct } = require('../services/purchase-receipts/product-matcher');

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

describe('matchAmazonTitleToProduct', () => {
  test('exact alias match (case/space-insensitive), active product only', async () => {
    const conn = makeConn({
      aliases: [{ alias_name: 'Atticus Talak 7.9 F Bifenthrin Insecticide Concentrate (96oz)', id: 'p-talak', name: 'Talak 96 oz', active: true, container_size: '96 fl oz' }],
      products: [],
    });
    const result = await matchAmazonTitleToProduct('  atticus talak 7.9 f bifenthrin insecticide concentrate (96OZ)  ', conn);
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
    const result = await matchAmazonTitleToProduct('Control Solutions Taurus SC Termiticide 78 oz', conn);
    expect(result).toMatchObject({ matched: true, matchType: 'containment', product: { id: 'p-taurus' } });
  });

  test('containment never matches a substring of a longer word ("SC" must not match "Scatter")', async () => {
    const conn = makeConn({ aliases: [], products: [{ id: 'p-sc', name: 'SC', active: true }] });
    const result = await matchAmazonTitleToProduct('Scatter Granules 5 lb Bag', conn);
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
    const result = await matchAmazonTitleToProduct('Generic Bifen IT Insecticide 32oz', conn);
    expect(result).toMatchObject({ matched: false, reason: 'ambiguous' });
  });

  test('an inactive (retired duplicate) row is never matched, by name or alias', async () => {
    const conn = makeConn({
      aliases: [], // the join already filters pc.active = true, so a retired product's alias never appears here
      products: [{ id: 'p-retired', name: 'Taurus SC', active: false }],
    });
    const result = await matchAmazonTitleToProduct('Control Solutions Taurus SC Termiticide 78 oz', conn);
    expect(result.matched).toBe(false);
  });

  test('a non-chemical personal item (Chromebook, shampoo, brass fittings) is unmatched', async () => {
    const conn = makeConn({
      aliases: [],
      products: [{ id: 'p-taurus', name: 'Taurus SC', active: true }],
    });
    expect((await matchAmazonTitleToProduct('Lenovo Chromebook Duet 11 inch', conn)).matched).toBe(false);
    expect((await matchAmazonTitleToProduct('Dove Shampoo 12 oz', conn)).matched).toBe(false);
    expect((await matchAmazonTitleToProduct('Brass Fittings Assortment Kit', conn)).matched).toBe(false);
  });

  test('empty title is unmatched without querying', async () => {
    const result = await matchAmazonTitleToProduct('   ', makeConn({}));
    expect(result).toEqual({ matched: false, reason: 'empty_title' });
  });
});
