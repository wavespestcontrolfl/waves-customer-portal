const SKIP = !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

// Migration 20261121110000 moves the catalog's stored winners onto the delivered basis (owner 2026-11-21: the lower price per
// unit, shipping always counted). It must recalculate a product whose stored winner loses once shipping is counted, and leave
// every other product exactly as it is.
//
// Every fixture and the migration run inside a transaction that is always rolled back, so a populated database never loses its
// real catalog rows.
d('20261121110000 best price on the delivered basis', () => {
  let db;
  const migration = require('../models/migrations/20261121110000_best_price_delivered_basis');
  const ROLLBACK = new Error('rollback');
  const STAMP = new Date('2026-09-30T15:00:00.000Z');
  // A seller with no published shipping policy: the price scan's rule for it is the labelled estimate.
  const OTHER = 'Delivered Basis Test Seller';

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

  // A product with its vendor rows, and the catalog pointing at the row named `winner` the way the last recalculation left it.
  const seed = async (trx, { name, container, oz = null, rows, winner, bestPrice, status = 'current' }) => {
    const [product] = await trx('products_catalog').insert({
      name, category: 'Insecticide', active_ingredient: 'x', epa_reg_number: 'x', formulation: 'SC', active: true,
      container_size: container, unit_size_oz: oz,
    }).returning('id');
    const ids = {};
    for (const [key, row] of Object.entries(rows)) {
      const { vendor, ...fields } = row;
      const [vp] = await trx('vendor_pricing').insert({
        product_id: product.id, vendor_id: await vendorId(trx, vendor), approval_status: 'approved', is_active: true,
        is_best_price: key === winner, ...fields,
      }).returning('id');
      ids[key] = vp.id;
    }
    await trx('products_catalog').where({ id: product.id }).update({
      best_price: bestPrice, best_vendor: rows[winner].vendor, best_vendor_pricing_id: ids[winner], best_price_status: status,
      best_price_updated_at: STAMP, needs_pricing: false,
    });
    return { productId: product.id, rows: ids };
  };

  const state = async (trx, seeded) => {
    const p = await trx('products_catalog').where({ id: seeded.productId }).first();
    const flagged = await trx('vendor_pricing').where({ product_id: seeded.productId, is_best_price: true }).pluck('id');
    return {
      best: p.best_price == null ? null : Number(p.best_price), vendor: p.best_vendor, winner: p.best_vendor_pricing_id,
      status: p.best_price_status, flagged, touched: new Date(p.best_price_updated_at).getTime() !== STAMP.getTime(),
    };
  };

  test('a measured product whose stored winner loses once shipping is counted moves to the delivered winner', async () => {
    await inRollback(async (trx) => {
      const seeded = await seed(trx, {
        name: 'Delivered basis test concentrate', container: '1 gal', oz: 128, winner: 'cheap', bestPrice: 91.98,
        rows: {
          cheap: { vendor: OTHER, price: 91.98, price_amount: 91.98, quantity: '1 gal' },
          siteone: { vendor: 'SiteOne', price: 94.13, price_amount: 94.13, quantity: '1 gal' },
        },
      });
      await migration.up(trx);
      // The stored cost is the winner's own price for the catalog container: no shipping estimate is written into it.
      expect(await state(trx, seeded)).toEqual({
        best: 94.13, vendor: 'SiteOne', winner: seeded.rows.siteone, status: 'current', flagged: [seeded.rows.siteone], touched: true,
      });
    });
  });

  test('a count product moves the same way, and its cost per unit follows the winner', async () => {
    await inRollback(async (trx) => {
      const seeded = await seed(trx, {
        name: 'Delivered basis test station', container: '1 station', winner: 'single', bestPrice: 14,
        rows: {
          single: { vendor: OTHER, price: 14, price_amount: 14, quantity: '1 station' },
          siteone: { vendor: 'SiteOne', price: 143, price_amount: 143, quantity: '10 stations' },
        },
      });
      await migration.up(trx);
      expect(await state(trx, seeded)).toMatchObject({ best: 14.3, vendor: 'SiteOne', winner: seeded.rows.siteone, status: 'current', touched: true });
      const product = await trx('products_catalog').where({ id: seeded.productId }).first('cost_per_unit', 'cost_unit');
      expect({ cost: Number(product.cost_per_unit), unit: product.cost_unit }).toEqual({ cost: 14.3, unit: 'each' });
    });
  });

  test('a product whose delivered winner is already the stored winner is left exactly as it is', async () => {
    await inRollback(async (trx) => {
      // The stored best price is deliberately not what a recalculation would write: it must stay.
      const seeded = await seed(trx, {
        name: 'Delivered basis test unchanged', container: '1 gal', oz: 128, winner: 'siteone', bestPrice: 90,
        rows: {
          siteone: { vendor: 'SiteOne', price: 94.13, price_amount: 94.13, quantity: '1 gal' },
          other: { vendor: OTHER, price: 99, price_amount: 99, quantity: '1 gal' },
        },
      });
      await migration.up(trx);
      expect(await state(trx, seeded)).toEqual({
        best: 90, vendor: 'SiteOne', winner: seeded.rows.siteone, status: 'current', flagged: [seeded.rows.siteone], touched: false,
      });
    });
  });

  test('a seller that states free shipping on its row keeps the win', async () => {
    await inRollback(async (trx) => {
      const seeded = await seed(trx, {
        name: 'Delivered basis test stated free', container: '1 gal', oz: 128, winner: 'cheap', bestPrice: 91.98,
        rows: {
          cheap: { vendor: OTHER, price: 91.98, price_amount: 91.98, quantity: '1 gal', shipping_cost: 0 },
          siteone: { vendor: 'SiteOne', price: 94.13, price_amount: 94.13, quantity: '1 gal' },
        },
      });
      await migration.up(trx);
      expect(await state(trx, seeded)).toMatchObject({ best: 91.98, winner: seeded.rows.cheap, touched: false });
    });
  });

  test('a product the catalog does not price from a current winner is left alone', async () => {
    await inRollback(async (trx) => {
      const rows = {
        cheap: { vendor: OTHER, price: 91.98, price_amount: 91.98, quantity: '1 gal' },
        siteone: { vendor: 'SiteOne', price: 94.13, price_amount: 94.13, quantity: '1 gal' },
      };
      const stale = await seed(trx, { name: 'Delivered basis test stale', container: '1 gal', oz: 128, winner: 'cheap', bestPrice: 91.98, status: 'stale', rows });
      // One eligible row: nobody to lose to, whatever the catalog says.
      const single = await seed(trx, {
        name: 'Delivered basis test single', container: '1 gal', oz: 128, winner: 'cheap', bestPrice: 80, rows: { cheap: rows.cheap },
      });
      // The cheaper row is no longer eligible, so the product has one eligible row.
      const expired = await seed(trx, { name: 'Delivered basis test expired', container: '1 gal', oz: 128, winner: 'siteone', bestPrice: 94.13, rows });
      await trx('vendor_pricing').where({ id: expired.rows.cheap }).update({ expires_at: new Date('2026-01-01T00:00:00.000Z') });
      await migration.up(trx);
      expect(await state(trx, stale)).toMatchObject({ best: 91.98, winner: stale.rows.cheap, status: 'stale', touched: false });
      expect(await state(trx, single)).toMatchObject({ best: 80, winner: single.rows.cheap, touched: false });
      expect(await state(trx, expired)).toMatchObject({ best: 94.13, winner: expired.rows.siteone, touched: false });
    });
  });

  test('down() changes nothing', async () => {
    await inRollback(async (trx) => {
      const seeded = await seed(trx, {
        name: 'Delivered basis test down', container: '1 gal', oz: 128, winner: 'cheap', bestPrice: 91.98,
        rows: {
          cheap: { vendor: OTHER, price: 91.98, price_amount: 91.98, quantity: '1 gal' },
          siteone: { vendor: 'SiteOne', price: 94.13, price_amount: 94.13, quantity: '1 gal' },
        },
      });
      await migration.up(trx);
      const after = await state(trx, seeded);
      await migration.down(trx);
      expect(await state(trx, seeded)).toEqual(after);
    });
  });
});
