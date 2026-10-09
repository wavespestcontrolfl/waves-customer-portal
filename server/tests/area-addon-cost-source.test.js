/**
 * The product cost each chemical area add-on is priced from can be reproduced from
 * server/data/pricing.csv the way POST /api/admin/import/pricing reads it: the importer
 * keeps only the FIRST line of each product + vendor (a later line of the same pair is a
 * duplicate that never imports), then ranks the vendors of a product by price per ounce.
 * The price that wins is the governed product's unit price, and unit price x the governed
 * rate per 1,000 sq ft is the add-on's materialPer1000.
 */
jest.mock('../models/db', () => { const db = () => { throw new Error('no database in this suite'); }; db.raw = db; db.transaction = db; return db; });
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (req, res, next) => next(), requireAdmin: (req, res, next) => next(), requireTechOrAdmin: (req, res, next) => next() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { areaAddOnPricingDefaults } = require('../services/pricing-engine/constants');
const protocols = require('../config/protocols.json');
const importRouter = require('../routes/admin-import-sheets');
const inventoryRouter = require('../routes/admin-inventory');

const rows = parse(fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
// What the importer imports, line by line, with the stored per-ounce price it would write.
const imported = importRouter.selectPricingRows(rows).lines;
const linesOf = (product) => imported.filter((line) => line.product.toLowerCase() === product.toLowerCase());
const rowOf = (product) => rows.find((row) => row.Product === product && row.Vendor === 'SiteOne');
// The importer's own ranking: vendor rows get their per-ounce fields from approvedPerOzFields,
// scoreVendorRows picks the cheapest per ounce. Returns the winner as the CSV's unit price unit.
const winnerOf = (product, perUnitOz) => {
  const lines = linesOf(product).filter((line) => line.vendor && Number(line.priceStr) > 0);
  const vendorRows = lines.map((line) => ({ vendor: line.vendor, price: Number(line.priceStr), quantity: line.size, ...inventoryRouter.approvedPerOzFields(Number(line.priceStr), line.size) }));
  const { pool } = inventoryRouter.scoreVendorRows(vendorRows, { unit_size_oz: inventoryRouter.quantityToOz(lines[0].size) });
  return { vendor: pool[0].row.vendor, amount: pool[0].perOz * perUnitOz, vendors: vendorRows.map((v) => v.vendor) };
};
const unitPriceOf = (product) => {
  const row = rowOf(product);
  const [, amount, unit] = /^\$([\d.,]+)\/(.+)$/.exec(row['Unit Price']);
  return { amount: Number(amount.replace(/,/g, '')), unit: unit.trim().replace(/\s+/g, '_'), vendor: row.Vendor };
};

const EXPECTED = [
  ['bed_pre_emergent', 'Snapshot 2.5TG', 'lb'],
  ['lawn_insect_spot', 'Arena 50 WDG', 'oz'],
  ['fire_ant_yard', 'Topchoice Granular Insecticide', 'lb'],
  ['lawn_insect_preventive', 'Acelepryn Insecticide', 'fl_oz'],
  ['hardscape_weed', 'Roundup QuikPro SC', 'fl_oz'],
];

describe('area add-on product costs come from pricing.csv', () => {
  const visits = protocols.area_addon.visits;
  const factsOf = (product) => visits.map((visit) => visit.labelFacts).find((facts) => facts && visits.find((v) => v.labelFacts === facts && JSON.stringify(v).includes(product)));

  test.each(EXPECTED)('%s: %s unit price x the governed rate is its material cost per 1,000 sq ft', (key, product, unit) => {
    const price = unitPriceOf(product);
    expect(price).toMatchObject({ unit, vendor: 'SiteOne' });
    const facts = factsOf(product);
    expect(facts).toMatchObject({ rateUnit: unit });
    const material = areaAddOnPricingDefaults().items[key].materialPer1000;
    expect(Math.abs(price.amount * facts.ratePer1000 - material)).toBeLessThan(0.02);
  });

  test.each(EXPECTED)('%s: %s has exactly ONE SiteOne line in the file (a second line of the pair never imports)', (key, product) => {
    expect(rows.filter((row) => row.Product === product && row.Vendor === 'SiteOne')).toHaveLength(1);
    expect(importRouter.selectPricingRows(rows).lines.filter((line) => line.product === product && line.vendor === 'SiteOne')).toHaveLength(1);
  });

  test.each(EXPECTED)('%s: %s the importer ranks the SiteOne price first, and it is the unit price the add-on cost uses', (key, product, unit) => {
    const winner = winnerOf(product, unit === 'lb' ? 16 : 1);
    expect(winner.vendor).toBe('SiteOne');
    expect(Math.abs(winner.amount - unitPriceOf(product).amount)).toBeLessThan(0.01);
    const facts = factsOf(product);
    expect(Math.abs(winner.amount * facts.ratePer1000 - areaAddOnPricingDefaults().items[key].materialPer1000)).toBeLessThan(0.02);
  });

  test('Arena 50 WDG is two vendors; the SiteOne line is a distinct key and the cheaper per ounce', () => {
    const { vendors } = winnerOf('Arena 50 WDG', 1);
    expect(vendors.sort()).toEqual(['Seed World', 'SiteOne']);
  });

  test('the importer keeps the FIRST line of a product + vendor pair, so a price change belongs on the original line', () => {
    const two = [
      { Product: 'Sample Product', Vendor: 'SiteOne', Size: '50 lb', Price: '$10.00' },
      { Product: 'sample product', Vendor: 'siteone', Size: '50 lb', Price: '$12.00' },
      { Product: 'Sample Product', Vendor: 'Other', Size: '50 lb', Price: '$11.00' },
    ];
    const { lines, duplicates } = importRouter.selectPricingRows(two);
    expect(duplicates).toBe(1);
    expect(lines.map((line) => [line.vendor, line.priceStr])).toEqual([['SiteOne', '10.00'], ['Other', '11.00']]);
  });

  test('the governed Acelepryn is the single-active product, not Acelepryn Xtra', () => {
    expect(rows.filter((row) => row.Product === 'Acelepryn Insecticide')).toHaveLength(1);
    expect(unitPriceOf('Acelepryn Insecticide').amount).toBe(14.14);
  });

  test('the web sweep uses no product', () => {
    expect(areaAddOnPricingDefaults().items.web_sweep.materialPer1000).toBe(0);
  });
});
