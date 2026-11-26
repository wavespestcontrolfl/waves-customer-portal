// The WDO inspection fee (owner 2026-11-26): quotes now vary by home size and construction, so the project fee is carried from the
// accepted WDO line, and a blank fee never bills the old flat default.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { acceptedWdoLineNet, seedWdoFeeFromVisit, wdoFeeNeedsEntry, resolveWdoInspectionFee } = require('../services/wdo-inspection-fee');

const bundleWith = (items) => ({ sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items } } } });
const resultWith = (items) => ({ result: { oneTime: { items } } });

describe('acceptedWdoLineNet reads the accepted work the way the accept card does', () => {
  test('an accepted $150 WDO line beside an add-on is isolated at $150', () => {
    expect(acceptedWdoLineNet(resultWith([
      { service: 'wdo_inspection', name: 'WDO Inspection', price: 150 },
      { service: 'one_time_pest', name: 'Pest', price: 80 },
    ]))).toBe(150);
  });

  test('a manual price change wins: a $175 line the office set to $150 seeds $150', () => {
    expect(acceptedWdoLineNet(resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, manualFinalOneTime: 150 }]))).toBe(150);
    expect(acceptedWdoLineNet(JSON.stringify(resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, manualFinalOneTime: 150 }])))).toBe(150);
  });

  test('a discount carried as the net after discount wins over the list price', () => {
    expect(acceptedWdoLineNet(resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, priceAfterDiscount: 160 }]))).toBe(160);
  });

  test('the raw engine twin of a manually priced mapped row does not disagree it away', () => {
    expect(acceptedWdoLineNet({
      result: { oneTime: { items: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, manualFinalOneTime: 150 }] } },
      engineResult: { lineItems: [{ service: 'wdo_inspection', price: 175 }] },
    })).toBe(150);
  });

  test('a snapshot-only estimate reads its sent pricing bundle', () => {
    expect(acceptedWdoLineNet(bundleWith([{ service: 'wdo_inspection', name: 'WDO Inspection', amount: 225 }, { service: 'one_time_lawn', name: 'Lawn', amount: 60 }]))).toBe(225);
  });

  test('an explicit $0 (a comped inspection) seeds 0, never the default', () => {
    expect(acceptedWdoLineNet(resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, manualFinalOneTime: 0 }]))).toBe(0);
    expect(acceptedWdoLineNet(resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, priceAfterDiscount: 0 }]))).toBe(0);
  });

  test('no WDO line, two WDO lines, or unreadable data cannot be isolated', () => {
    expect(acceptedWdoLineNet(resultWith([{ service: 'one_time_pest', name: 'Pest', price: 80 }]))).toBeNull();
    expect(acceptedWdoLineNet(resultWith([{ service: 'wdo_inspection', name: 'WDO A', price: 150 }, { service: 'wdo_inspection', name: 'WDO B', price: 200 }]))).toBeNull();
    expect(acceptedWdoLineNet(null)).toBeNull();
    expect(acceptedWdoLineNet('not json')).toBeNull();
  });
});

describe('seedWdoFeeFromVisit', () => {
  // A tiny knex stand-in keyed by table.
  const fakeKnex = (tables) => (name) => {
    let where = null;
    const chain = {
      where(w) { where = w; return chain; },
      first() { return Promise.resolve((tables[name] || []).find((r) => !where || Object.entries(where).every(([k, v]) => r[k] === v))); },
      select() { return Promise.resolve((tables[name] || []).filter((r) => !where || Object.entries(where).every(([k, v]) => r[k] === v))); },
    };
    return chain;
  };

  test('accepted $150 WDO + a billable add-on on the visit seeds $150, not the $230 group total', async () => {
    const knex = fakeKnex({
      scheduled_services: [{ id: 'v1', estimated_price: '230.00', source_estimate_id: 'e1' }],
      scheduled_service_addons: [{ scheduled_service_id: 'v1', estimated_price: '80.00' }],
      estimates: [{ id: 'e1', estimate_data: resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 150 }, { service: 'one_time_pest', name: 'Pest', price: 80 }]) }],
    });
    expect(await seedWdoFeeFromVisit(knex, 'v1')).toBe(150);
  });

  test('a manual $150 on a $175 accepted line seeds $150 through the visit', async () => {
    const knex = fakeKnex({
      scheduled_services: [{ id: 'v6', estimated_price: '230.00', source_estimate_id: 'e6' }],
      scheduled_service_addons: [{ scheduled_service_id: 'v6', estimated_price: '80.00' }],
      estimates: [{ id: 'e6', estimate_data: resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 175, manualFinalOneTime: 150 }, { service: 'one_time_pest', name: 'Pest', price: 80 }]) }],
    });
    expect(await seedWdoFeeFromVisit(knex, 'v6')).toBe(150);
  });

  test('with no isolable WDO line and a billable add-on the fee stays blank (a successful read, bills the default as before)', async () => {
    const knex = fakeKnex({
      scheduled_services: [{ id: 'v2', estimated_price: '255.00', source_estimate_id: null }],
      scheduled_service_addons: [{ scheduled_service_id: 'v2', estimated_price: '80.00' }],
    });
    expect(await seedWdoFeeFromVisit(knex, 'v2')).toBeNull();
  });

  test('a single-line visit seeds its own price; a zero price seeds zero', async () => {
    const one = fakeKnex({ scheduled_services: [{ id: 'v3', estimated_price: '175.00' }], scheduled_service_addons: [] });
    expect(await seedWdoFeeFromVisit(one, 'v3')).toBe(175);
    const zero = fakeKnex({ scheduled_services: [{ id: 'v4', estimated_price: '0' }], scheduled_service_addons: [] });
    expect(await seedWdoFeeFromVisit(zero, 'v4')).toBe(0);
    expect(await seedWdoFeeFromVisit(one, null)).toBeNull();
    expect(await seedWdoFeeFromVisit(fakeKnex({ scheduled_services: [] }), 'missing')).toBeNull();
  });

  test('a read error is never a blank fee: it propagates so the create fails and the office retries', async () => {
    const broken = () => { throw new Error('db down'); };
    await expect(seedWdoFeeFromVisit(broken, 'v5')).rejects.toThrow('db down');
    const addonsFail = (name) => {
      if (name === 'scheduled_service_addons') throw new Error('addons read failed');
      return { where() { return this; }, first: () => Promise.resolve({ id: 'v7', estimated_price: '175.00' }) };
    };
    await expect(seedWdoFeeFromVisit(addonsFail, 'v7')).rejects.toThrow('addons read failed');
  });

  test('the create route turns a failed seed read into a retryable 503 and creates nothing', () => {
    const fs = require('fs');
    const route = fs.readFileSync(require.resolve('../routes/admin-projects'), 'utf8');
    expect(route).toContain("code: 'wdo_fee_seed_unavailable'");
    expect(route).toMatch(/seedWdoFeeFromVisit\(db, linkedScheduledServiceId\);\s*\} catch \(err\) \{[\s\S]{0,400}res\.status\(503\)/);
  });
});

describe('a blank fee keeps billing as before unless the accepted estimate pins the WDO line', () => {
  test('wdoFeeNeedsEntry: blank and digit-free need a seed; a fee and an explicit zero do not', () => {
    for (const blank of [undefined, null, '', ' ', 'waived', 'TBD']) expect(wdoFeeNeedsEntry({ inspection_fee: blank })).toBe(true);
    expect(wdoFeeNeedsEntry({})).toBe(true);
    for (const entered of ['150', '$175', '1,250', 150, '0', 0, '0.00']) expect(wdoFeeNeedsEntry({ inspection_fee: entered })).toBe(false);
  });

  test('no estimate and a blank fee: the resolver bills $250 exactly as on main; entered fees and an explicit zero are untouched', () => {
    expect(resolveWdoInspectionFee({})).toBe(250);
    expect(resolveWdoInspectionFee({ inspection_fee: '' })).toBe(250);
    expect(resolveWdoInspectionFee({ inspection_fee: '150' })).toBe(150);
    expect(resolveWdoInspectionFee({ inspection_fee: '0' })).toBe(0);
  });

  test('accepted $150 WDO + an add-on: the seed makes the invoice fee $150, not the default and not the group total', async () => {
    const knex = (name) => {
      const rows = {
        scheduled_services: [{ id: 'v1', estimated_price: '230.00', source_estimate_id: 'e1' }],
        scheduled_service_addons: [{ scheduled_service_id: 'v1', estimated_price: '80.00' }],
        estimates: [{ id: 'e1', estimate_data: resultWith([{ service: 'wdo_inspection', name: 'WDO Inspection', price: 150 }, { service: 'one_time_pest', name: 'Pest', price: 80 }]) }],
      }[name] || [];
      const chain = { where() { return chain; }, first() { return Promise.resolve(rows[0]); }, select() { return Promise.resolve(rows); } };
      return chain;
    };
    const seeded = await seedWdoFeeFromVisit(knex, 'v1');
    expect(seeded).toBe(150);
    expect(resolveWdoInspectionFee({ inspection_fee: String(seeded) })).toBe(150);
  });
});
