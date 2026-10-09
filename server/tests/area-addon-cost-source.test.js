/**
 * The product cost each chemical area add-on is priced from can be reproduced from
 * server/data/pricing.csv: the newest row of the governed product gives a unit price,
 * and unit price x the governed rate per 1,000 sq ft is the add-on's materialPer1000.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { areaAddOnPricingDefaults } = require('../services/pricing-engine/constants');
const protocols = require('../config/protocols.json');

const rows = parse(fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
const unitPriceOf = (product) => {
  const hits = rows.filter((row) => row.Product === product && /^\$[\d.,]+\//.test(row['Unit Price'] || ''));
  const last = hits[hits.length - 1];
  if (!last) return null;
  const [, amount, unit] = /^\$([\d.,]+)\/(.+)$/.exec(last['Unit Price']);
  return { amount: Number(amount.replace(/,/g, '')), unit: unit.trim().replace(/\s+/g, '_'), vendor: last.Vendor };
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

  test('the governed Acelepryn is the single-active product, not Acelepryn Xtra', () => {
    expect(rows.filter((row) => row.Product === 'Acelepryn Insecticide')).toHaveLength(1);
    expect(unitPriceOf('Acelepryn Insecticide').amount).toBe(14.14);
  });

  test('the web sweep uses no product', () => {
    expect(areaAddOnPricingDefaults().items.web_sweep.materialPer1000).toBe(0);
  });
});
