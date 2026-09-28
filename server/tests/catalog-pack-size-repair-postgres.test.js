const SKIP = !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

// Every fixture and the migration run inside a transaction that is always
// rolled back, so a populated database never loses its real catalog rows.
d('20260928050000 catalog pack-size repair (full 020000-050000 sequence)', () => {
  let db;
  const first = require('../models/migrations/20260928020000_catalog_package_size_corrections');
  const second = require('../models/migrations/20260928030000_catalog_package_size_vendor_rows');
  const third = require('../models/migrations/20260928040000_catalog_pack_size_recalc');
  const migration = require('../models/migrations/20260928050000_catalog_pack_size_repair');
  // Every environment runs the whole frozen sequence in order.
  const runAll = async (trx) => {
    await first.up(trx); await second.up(trx); await third.up(trx); await migration.up(trx);
  };
  const DOMINION = 'Dominion 2L 1 gal';
  const SEDGE = 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide';
  const ROLLBACK = new Error('rollback');

  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => { await db.destroy(); });

  const inRollback = async (fn) => {
    await expect(db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; })).rejects.toBe(ROLLBACK);
  };

  const vendorId = async (trx, name) => {
    const found = await trx('vendors').whereRaw('lower(name) = ?', [name.toLowerCase()]).first('id');
    if (found) return found.id;
    const [row] = await trx('vendors').insert({ name }).returning('id');
    return row.id;
  };

  // A product with one winning SiteOne row, as the pricing import leaves it.
  const seed = async (trx, { name, container, oz, bestPrice, vendorPrice, vendorQty }) => {
    await trx('products_catalog').where({ name }).update({ name: trx.raw("name || ' (pre-test)'") });
    const [product] = await trx('products_catalog').insert({
      name, category: 'Insecticide', active_ingredient: 'x', epa_reg_number: 'x', formulation: 'SC', active: true,
      container_size: container, unit_size_oz: oz, best_price: bestPrice,
    }).returning('id');
    const [vp] = await trx('vendor_pricing').insert({
      product_id: product.id, vendor_id: await vendorId(trx, 'SiteOne'), price: vendorPrice, quantity: vendorQty,
      price_per_oz: 0.0001, approval_status: 'approved', is_active: true,
    }).returning('id');
    await trx('products_catalog').where({ id: product.id }).update({ best_vendor_pricing_id: vp.id });
    return { productId: product.id, vendorRowId: vp.id };
  };

  const state = async (trx, ids) => {
    const p = await trx('products_catalog').where({ id: ids.productId }).first();
    const v = await trx('vendor_pricing').where({ id: ids.vendorRowId }).first();
    return {
      container: p.container_size, oz: Number(p.unit_size_oz), best: Number(p.best_price),
      vendorQty: v.quantity, perOz: Number(v.price_per_oz),
    };
  };

  test('Dominion: catalog and imported vendor row move to the case together', async () => {
    await inRollback(async (trx) => {
      const ids = await seed(trx, { name: DOMINION, container: '1 gal', oz: 128, bestPrice: 469.53, vendorPrice: 469.53, vendorQty: '1 gal' });
      await runAll(trx);
      expect(await state(trx, ids)).toEqual({
        container: '4 x 1 gal case', oz: 512, best: 469.53, vendorQty: '4 x 1 gal case', perOz: 0.9171,
      });
    });
  });

  test('SedgeHammer: a price already scaled to 64 oz returns to the bottle price', async () => {
    await inRollback(async (trx) => {
      // Corrected CSV imported while the catalog still said 64 oz:
      // recalc stored round(59.99 / 1.33 * 64, 2).
      // The import already wrote that vendor row's per-oz for 1.33 oz.
      const ids = await seed(trx, { name: SEDGE, container: '64 oz', oz: 64, bestPrice: 2886.74, vendorPrice: 59.99, vendorQty: '1.33 oz' });
      await trx('vendor_pricing').where({ id: ids.vendorRowId }).update({ price_per_oz: 45.1053 });
      await runAll(trx);
      expect(await state(trx, ids)).toEqual({
        container: '1.33 oz', oz: 1.33, best: 59.99, vendorQty: '1.33 oz', perOz: 45.1053,
      });
    });
  });

  test('SedgeHammer: the original 64 oz import is corrected too', async () => {
    await inRollback(async (trx) => {
      const ids = await seed(trx, { name: SEDGE, container: '64 oz', oz: 64, bestPrice: 3485.35, vendorPrice: 72.43, vendorQty: '64 oz' });
      await runAll(trx);
      expect(await state(trx, ids)).toMatchObject({ container: '1.33 oz', oz: 1.33, best: 72.43, vendorQty: '1.33 oz' });
    });
  });

  test('after 20260928020000 already moved the catalog size, the vendor row and price still follow', async () => {
    await inRollback(async (trx) => {
      const ids = await seed(trx, { name: DOMINION, container: '1 gal', oz: 128, bestPrice: 469.53, vendorPrice: 469.53, vendorQty: '1 gal' });
      await runAll(trx);
      expect(await state(trx, ids)).toEqual({
        container: '4 x 1 gal case', oz: 512, best: 469.53, vendorQty: '4 x 1 gal case', perOz: 0.9171,
      });
    });
  });

  test("another vendor's gallon offer keeps its own pack size", async () => {
    await inRollback(async (trx) => {
      const ids = await seed(trx, { name: DOMINION, container: '1 gal', oz: 128, bestPrice: 469.53, vendorPrice: 469.53, vendorQty: '1 gal' });
      const [other] = await trx('vendor_pricing').insert({
        product_id: ids.productId, vendor_id: await vendorId(trx, 'Test Gallon Vendor'), price: 140, quantity: '1 gal',
        approval_status: 'approved', is_active: true,
      }).returning('id');
      await runAll(trx);
      const row = await trx('vendor_pricing').where({ id: other.id }).first('quantity');
      expect(row.quantity).toBe('1 gal');
      // The case ($0.92/oz) is cheaper per ounce than $140/gal ($1.09/oz),
      // so recalc keeps SiteOne and prices the 512 oz pack at the case price.
      const p = await trx('products_catalog').where({ id: ids.productId }).first('best_price', 'best_vendor_pricing_id');
      expect([Number(p.best_price), p.best_vendor_pricing_id]).toEqual([469.53, ids.vendorRowId]);
    });
  });

  test('full sequence: stale landed cost and price_amount on the SiteOne row are re-derived', async () => {
    await inRollback(async (trx) => {
      const ids = await seed(trx, { name: DOMINION, container: '1 gal', oz: 128, bestPrice: 469.53, vendorPrice: 469.53, vendorQty: '1 gal' });
      await trx('vendor_pricing').where({ id: ids.vendorRowId }).update({ price_amount: 400, landed_unit_price: 3.9, landed_cost: 499 });
      await runAll(trx);
      const v = await trx('vendor_pricing').where({ id: ids.vendorRowId }).first('price_amount', 'landed_unit_price', 'landed_cost', 'price_per_oz');
      expect([Number(v.price_amount), v.landed_unit_price, v.landed_cost, Number(v.price_per_oz)]).toEqual([469.53, null, null, 0.9171]);
      const p = await trx('products_catalog').where({ id: ids.productId }).first('best_price');
      expect(Number(p.best_price)).toBe(469.53);
    });
  });

  test('a catalog row already moved off the old size is left alone', async () => {
    await inRollback(async (trx) => {
      const ids = await seed(trx, { name: SEDGE, container: '2 x 1.33 oz', oz: 2.66, bestPrice: 110, vendorPrice: 110, vendorQty: '2 x 1.33 oz' });
      await runAll(trx);
      expect(await state(trx, ids)).toEqual({
        container: '2 x 1.33 oz', oz: 2.66, best: 110, vendorQty: '2 x 1.33 oz', perOz: 0.0001,
      });
    });
  });
});
