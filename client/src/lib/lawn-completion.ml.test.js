import { expect, it } from 'vitest';
import { lawnPlanSelections, reconcileLawnPlanSelections } from './lawn-completion';
import { resolveRatePrefill } from './product-rate-prefill';

// The lawn plan's mix carries the catalog unit its quantity was computed in.
// A quantity in mL is never a completion default (owner ruling 2026-09-29:
// nothing a tech sees or enters is in mL): the row starts blank, its amount
// in fl oz, and the plan snapshot holds those same clean values.

// The closeout builds each row through the shared resolver (SchedulePage
// buildSelectedProduct); only the fields the plan helpers read.
const build = (product) => {
  const resolved = resolveRatePrefill(product, { applicationMethod: 'broadcast_spray', serviceLine: 'lawn' });
  return {
    productId: product.id, name: product.name, rate: resolved.rate, rateUnit: resolved.rateUnit,
    amountUnit: resolved.amountUnit, areaValue: '', areaUnit: '', totalAmount: '', applicationMethod: 'broadcast_spray',
  };
};
const CATALOG = [
  { id: 'kelp', name: 'Example Liquid Kelp', rate_unit: 'ml', default_rate_per_1000: '30' },
  { id: 'potash', name: 'Example Liquid Potash', rate_unit: 'fl_oz', default_rate_per_1000: '3' },
];
const PLAN_FIELDS = ['rate', 'rateUnit', 'amountUnit', 'areaValue', 'areaUnit', 'totalAmount', 'applicationMethod'];
const ML_ITEM = {
  product: { id: 'kelp' }, applicationMethod: 'broadcast_spray',
  mix: { ratePer1000: 30, rateUnit: 'ml', amount: 150, amountUnit: 'ml', treatedSqft: 5000 },
};

it('a plan quantity in mL starts blank with its amount in fl oz, and the plan snapshot holds the same values', () => {
  for (const governed of [false, true]) {
    const [row] = lawnPlanSelections([ML_ITEM], build, CATALOG, { governed });
    expect(row).toMatchObject({ rate: '', rateUnit: '', totalAmount: '', amountUnit: 'fl_oz', areaValue: 5000, areaUnit: 'sqft' });
    expect(JSON.stringify(row)).not.toMatch(/\bml\b/i);
    if (governed) expect(row.lawnPlanDefaults).toEqual(Object.fromEntries(PLAN_FIELDS.map((key) => [key, row[key]])));
  }
});

it('either unit in mL withdraws the quantity; a rate unit that is not mL stays', () => {
  const [perGallon] = lawnPlanSelections([{
    product: { id: 'kelp' }, mix: { ratePer1000: 5, rateUnit: 'mL/gal', amount: 25, amountUnit: 'mL', treatedSqft: 5000 },
  }], build, CATALOG);
  expect(perGallon).toMatchObject({ rate: '', rateUnit: '', totalAmount: '', amountUnit: 'fl_oz' });
  const [amountOnly] = lawnPlanSelections([{
    product: { id: 'potash' }, mix: { ratePer1000: 3, rateUnit: 'fl_oz', amount: 443.6, amountUnit: 'milliliters', treatedSqft: 5000 },
  }], build, CATALOG);
  expect(amountOnly).toMatchObject({ rate: '', rateUnit: 'fl_oz', totalAmount: '', amountUnit: 'fl_oz' });
});

it('a plan refresh reconciles against the clean values and never brings mL back', () => {
  const [seeded] = lawnPlanSelections([ML_ITEM], build, CATALOG, { governed: true });
  const fresh = lawnPlanSelections([ML_ITEM], build, CATALOG, { governed: true });
  // An untouched row is unchanged by the refresh.
  const untouched = reconcileLawnPlanSelections([seeded], fresh);
  expect(untouched).toEqual([seeded]);
  // The tech's actual in fl oz stands.
  const [entered] = reconcileLawnPlanSelections([{ ...seeded, totalAmount: '5', totalAmountManual: true }], fresh);
  expect(entered).toMatchObject({ totalAmount: '5', amountUnit: 'fl_oz' });
  expect(JSON.stringify([untouched, entered])).not.toMatch(/\bml\b/i);
});

it('a plan quantity in any other unit is unchanged', () => {
  const [row] = lawnPlanSelections([{
    product: { id: 'potash' }, mix: { ratePer1000: 3, rateUnit: 'fl_oz', amount: 15, amountUnit: 'fl_oz', treatedSqft: 5000 },
  }], build, CATALOG, { governed: true });
  expect(row).toMatchObject({ rate: 3, rateUnit: 'fl_oz', totalAmount: 15, amountUnit: 'fl_oz', areaValue: 5000, areaUnit: 'sqft' });
  expect(row.lawnPlanDefaults).toMatchObject({ rate: 3, rateUnit: 'fl_oz', totalAmount: 15, amountUnit: 'fl_oz' });
  // No plan quantity at all: the catalog row's own units, as before.
  expect(lawnPlanSelections([{ product: { id: 'potash' }, mix: {} }], build, CATALOG)[0])
    .toMatchObject({ rate: '', rateUnit: 'fl_oz', totalAmount: '', amountUnit: 'fl_oz' });
});
