// services/equipment-tech-projection.js: what a technician never gets from an
// equipment read (technician visibility audit 2026-11-04, A6 / C10).
const {
  isTechnicianCaller, stripEquipmentRow, stripMixCosts, stripFleetOverview, mapRows, stripMaintenanceRecord,
} = require('../services/equipment-tech-projection');

describe('stripMixCosts', () => {
  const mix = {
    id: 'mix-1', name: 'Synthetic mix', tank_size_gal: 100, coverage_sqft: 10000,
    cost_per_tank: 6.67, cost_per_1000sf: 0.667, cost_incomplete: true,
    products: [{ product_name: 'Synthetic A', oz_per_tank: 8, rate_per_1000sf: 1, rate_unit: 'oz', cost_per_oz: 0.83, cost_in_tank: 6.67, cost_unknown: true }],
  };

  test('drops the totals, the incomplete flag and every per-line cost; keeps the recipe and the rates', () => {
    const out = stripMixCosts(mix);
    for (const key of ['cost_per_tank', 'cost_per_1000sf', 'cost_incomplete']) expect(out).not.toHaveProperty(key);
    expect(out.products[0]).toEqual({ product_name: 'Synthetic A', oz_per_tank: 8, rate_per_1000sf: 1, rate_unit: 'oz' });
    expect(out).toMatchObject({ name: 'Synthetic mix', tank_size_gal: 100, coverage_sqft: 10000 });
  });

  test('keeps the column shape: a JSON string stays a string', () => {
    const out = stripMixCosts({ ...mix, products: JSON.stringify(mix.products) });
    expect(typeof out.products).toBe('string');
    expect(JSON.parse(out.products)[0]).not.toHaveProperty('cost_per_oz');
  });

  test('still drops the totals when the products column is not a list', () => {
    const out = stripMixCosts({ ...mix, products: '{"not":"a list"}' });
    expect(out).not.toHaveProperty('cost_per_tank');
  });

  test('does not change its input', () => {
    stripMixCosts(mix);
    expect(mix.cost_per_tank).toBe(6.67);
    expect(mix.products[0].cost_per_oz).toBe(0.83);
  });
});

describe('row strips', () => {
  test('equipment, record and overview strips drop money and keep the rest', () => {
    expect(stripEquipmentRow({ name: 'A', purchase_price: 1, tax_equipment_id: 't', condition_rating: 7 })).toEqual({ name: 'A', condition_rating: 7 });
    expect(stripMaintenanceRecord({ task_name: 'T', total_cost: 2, receipt_url: 'u' })).toEqual({ task_name: 'T' });
    expect(stripFleetOverview({ total_assets: 2, ytd_fuel_cost: 3, ytd_maintenance_spend: 4, ytd_irs_deduction: 5 })).toEqual({ total_assets: 2 });
  });

  test('a missing row or list passes through', () => {
    expect(stripEquipmentRow(null)).toBeNull();
    expect(mapRows(undefined, stripEquipmentRow)).toBeUndefined();
  });

  test('only an admin is not a technician caller', () => {
    expect(isTechnicianCaller({ techRole: 'admin' })).toBe(false);
    expect(isTechnicianCaller({ techRole: 'technician' })).toBe(true);
    expect(isTechnicianCaller({})).toBe(true);
  });
});
