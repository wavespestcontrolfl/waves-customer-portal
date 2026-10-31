/**
 * The estimate margin audit costs a pre-slab termiticide line from the product the estimate
 * quoted (Termidor SC, Taurus SC or Talak 7.9 F), not always from the Termidor usage rows.
 * A Talak slab costed as Termidor read about $1.95 per fl oz instead of about $0.43 and
 * tripped a false low-margin warning.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => false) };
  return fn;
});

const { buildEstimatePricingAudit } = require('../services/estimate-pricing-audit');
const { pricePreSlabTermiticide } = require('../services/pricing-engine/service-pricing');
const { SPECIALTY } = require('../services/pricing-engine/constants');

// The registry carries one pre-slab product: Termidor SC, 80 fl oz per 1,000 sq ft at $152.10 / 78 fl oz.
const TERMIDOR_ROW = {
  service_type: 'Pre-Slab Termiticide Treatment',
  product_id: 1,
  product_name: 'Termidor SC',
  usage_amount: 80,
  usage_unit: 'fl oz',
  usage_per_1000sf: 80,
  notes: '',
  cost_per_unit: null,
  cost_unit: null,
  best_price: 152.1,
  unit_size_oz: 78,
  best_vendor: 'Test vendor',
};
const inventory = { available: true, rows: [TERMIDOR_ROW] };

const SLAB_SQFT = 3000;
const termidorRegistryCost = (sqFt) => Math.round((152.1 / 78) * 80 * (sqFt / 1000) * 100) / 100;

const quote = (productKey, sqFt = SLAB_SQFT) => pricePreSlabTermiticide(sqFt, { productKey, labelConfirmed: true });

async function auditOf(estimateData, onetimeTotal) {
  const audit = await buildEstimatePricingAudit(
    { id: 'est-1', annual_total: 0, onetime_total: onetimeTotal, estimate_data: estimateData },
    { inventory },
  );
  return audit.lines.find((l) => /^pre_slab/.test(l.serviceKey));
}

// The quote-wizard projection of a pre-slab line: the fields the mapper keeps on a oneTime item.
const projected = (li) => ({
  service: li.service,
  name: 'Pre-Slab Termiticide Treatment',
  price: li.price,
  productKey: li.productKey,
  productLabel: li.productLabel,
  slabSqFt: li.slabSqFt,
  productOzPer10SqFt: li.productOzPer10SqFt,
  productOz: li.productOz,
  chemicalCostPerOz: li.chemicalCostPerOz,
  allocatedProductCost: li.allocatedProductCost,
  productCost: li.productCost,
});

describe('estimate pricing audit costs a pre-slab line from the quoted product', () => {
  test('a Talak slab (raw engine result) costs at the Talak product cost and trips no low-margin warning', async () => {
    const li = quote('talstar_p');
    const line = await auditOf({ engineResult: { lineItems: [li] } }, li.price);
    expect(line.cogs.status).toBe('explicit');
    expect(line.cogs.quotedProductKey).toBe('talstar_p');
    expect(line.cogs.estimatedCost).toBeCloseTo(li.productCost, 2);
    expect(line.cogs.estimatedCost).toBeLessThan(termidorRegistryCost(SLAB_SQFT) / 3);
    expect(line.warnings).toEqual([]);
    expect(line.status).toBe('ok');
  });

  test('the same Talak line without a product identity costs as Termidor and trips the low-margin warning', async () => {
    const li = quote('talstar_p');
    const { productKey, productLabel, productCost, allocatedProductCost, ...anonymous } = li;
    const line = await auditOf(
      { engineInput: { homeSqFt: SLAB_SQFT }, engineResult: { lineItems: [anonymous] } },
      li.price,
    );
    expect(line.preSlabQuote).toBeUndefined();
    expect(line.cogs.status).toBe('ok');
    expect(line.cogs.estimatedCost).toBeCloseTo(termidorRegistryCost(SLAB_SQFT), 2);
    expect(line.warnings.join(' ')).toMatch(/Margin below 35% floor/);
  });

  test('a Talak slab in the quote-wizard projection (bifen_it key) costs at the Talak product cost', async () => {
    const li = quote('bifen_it');
    const line = await auditOf({ result: { oneTime: { items: [projected(li)], specItems: [] } } }, li.price);
    expect(line.priceSource).toBe('saved_estimate.result.oneTime.items');
    expect(line.cogs.status).toBe('explicit');
    expect(line.cogs.quotedProductKey).toBe('bifen_it');
    expect(line.cogs.estimatedCost).toBeCloseTo(li.productCost, 2);
    expect(line.warnings).toEqual([]);
  });

  test('a projected line kept in specItems is read the same way', async () => {
    const li = quote('talstar_p');
    const line = await auditOf({ result: { oneTime: { items: [], specItems: [projected(li)] } } }, li.price);
    expect(line.priceSource).toBe('saved_estimate.result.oneTime.specItems');
    expect(line.cogs.estimatedCost).toBeCloseTo(li.productCost, 2);
  });

  test('a Termidor line keeps the Termidor cost', async () => {
    const li = quote('termidor_sc');
    const line = await auditOf({ engineResult: { lineItems: [li] } }, li.price);
    expect(line.cogs.quotedProductKey).toBe('termidor_sc');
    expect(line.cogs.estimatedCost).toBeCloseTo(li.productCost, 2);
    // Same per-ounce basis as the registry row, so the figures agree to within the config/catalog price gap.
    const perOzConfig = SPECIALTY.preSlabTermiticide.products.termidor_sc.containerCost
      / SPECIALTY.preSlabTermiticide.products.termidor_sc.containerOz;
    expect(line.cogs.estimatedCost).toBeCloseTo(perOzConfig * 0.8 * (SLAB_SQFT / 10), 0);
  });

  test('a Taurus line costs at the Taurus product cost', async () => {
    const li = quote('taurus_sc');
    const line = await auditOf({ engineResult: { lineItems: [li] } }, li.price);
    expect(line.cogs.quotedProductKey).toBe('taurus_sc');
    expect(line.cogs.estimatedCost).toBeCloseTo(li.productCost, 2);
    expect(line.cogs.estimatedCost).toBeLessThan(termidorRegistryCost(SLAB_SQFT));
    expect(line.cogs.estimatedCost).toBeGreaterThan(quote('talstar_p').productCost);
  });

  test('a line that names the product but not its cost is costed from the live product constants', async () => {
    const li = quote('talstar_p');
    const { productCost, allocatedProductCost, ...noCost } = projected(li);
    const line = await auditOf({ result: { oneTime: { items: [noCost] } } }, li.price);
    expect(line.cogs.costSource).toBe('live_product_constants');
    // container cost / container oz x oz per 10 sq ft x slab / 10
    const p = SPECIALTY.preSlabTermiticide.products.talstar_p;
    expect(line.cogs.estimatedCost).toBeCloseTo((p.containerCost / p.containerOz) * p.productOzPer10SqFt * (SLAB_SQFT / 10), 2);
  });

  test('a line that names the product but not its slab uses the property area the usage registry reads', async () => {
    const li = quote('talstar_p');
    const { productCost, allocatedProductCost, slabSqFt, ...noCostNoSlab } = projected(li);
    const line = await auditOf(
      { engineInput: { homeSqFt: 2000 }, result: { oneTime: { items: [noCostNoSlab] } } },
      li.price,
    );
    const p = SPECIALTY.preSlabTermiticide.products.talstar_p;
    expect(line.cogs.costSource).toBe('live_product_constants');
    expect(line.cogs.estimatedCost).toBeCloseTo((p.containerCost / p.containerOz) * p.productOzPer10SqFt * 200, 2);
  });

  test('a line with no product identity keeps the Termidor usage rows', async () => {
    const li = quote('talstar_p');
    const { productKey, productLabel, productCost, allocatedProductCost, ...anonymous } = projected(li);
    const line = await auditOf(
      { engineInput: { homeSqFt: 2000 }, result: { oneTime: { items: [anonymous] } } },
      li.price,
    );
    expect(line.cogs.status).toBe('ok');
    expect(line.cogs.estimatedCost).toBeCloseTo(termidorRegistryCost(2000), 2);
  });

  test('a product key the engine does not know keeps the Termidor usage rows', async () => {
    const li = quote('talstar_p');
    const line = await auditOf(
      { engineInput: { homeSqFt: 2000 }, result: { oneTime: { items: [{ ...projected(li), productKey: 'mystery_product', productCost: undefined, allocatedProductCost: undefined }] } } },
      li.price,
    );
    expect(line.cogs.status).toBe('ok');
    expect(line.cogs.estimatedCost).toBeCloseTo(termidorRegistryCost(2000), 2);
  });

  test('the product identity survives when the mapped line and the raw engine line are the same charge', async () => {
    const li = quote('talstar_p');
    const { productKey, productLabel, productCost, allocatedProductCost, slabSqFt, ...anonymous } = projected(li);
    const line = await auditOf(
      {
        engineInput: { homeSqFt: SLAB_SQFT },
        result: { oneTime: { items: [anonymous] } },
        engineResult: { lineItems: [li] },
      },
      li.price,
    );
    expect(line.cogs.quotedProductKey).toBe('talstar_p');
    expect(line.cogs.estimatedCost).toBeCloseTo(li.productCost, 2);
  });
});
