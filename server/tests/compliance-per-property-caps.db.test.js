// The compliance summaries judge annual_max_apps per lawn (the treated property), the way
// application-limits enforces it, so a customer with two properties, or a company with many
// customers, is never reported as over a per-lawn cap on a total. Runs on the migrated test
// database with synthetic rows, removed afterwards.
const { randomUUID } = require('crypto');
const db = require('../models/db');
const ComplianceService = require('../services/compliance');
const { fixture } = require('./helpers/lawn-history-db');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describe('worstPropertyCount (no database)', () => {
  const { worstPropertyCount } = ComplianceService;
  test('the busiest property plus every unplaced application', () => {
    expect(worstPropertyCount([])).toBe(0);
    expect(worstPropertyCount([{ treated_property_id: 'a' }, { treated_property_id: 'a' }, { treated_property_id: 'b' }])).toBe(2);
    expect(worstPropertyCount([{ treated_property_id: 'a' }, { treated_property_id: 'b' }])).toBe(1);
    expect(worstPropertyCount([{ treated_property_id: 'a' }, { treated_property_id: null }, { treated_property_id: 'b' }])).toBe(2);
    expect(worstPropertyCount([{ treated_property_id: null }, { treated_property_id: undefined }])).toBe(2);
  });
});

describeDb('compliance summaries: annual_max_apps is per lawn', () => {
  const made = { customers: [], products: [], limits: [], records: [] };
  let product;
  let limit;

  async function customerWithTwoProperties(applicationsAt, forProduct = product) {
    const f = await fixture(db);
    made.customers.push(f.customerId);
    const [propertyB] = await db('customer_properties').insert({ customer_id: f.customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
    const properties = [f.property.id, propertyB.id];
    const today = new Date().toISOString().slice(0, 10);
    for (const index of applicationsAt) {
      const [visit] = await db('scheduled_services').insert({ customer_id: f.customerId, property_id: properties[index], scheduled_date: today, service_type: 'Lawn fixture' }).returning('*');
      const [record] = await db('service_records').insert({ customer_id: f.customerId, scheduled_service_id: visit.id, service_date: today, service_type: 'Lawn fixture' }).returning('*');
      made.records.push(record.id);
      await db('property_application_history').insert({ customer_id: f.customerId, product_id: forProduct.id, application_date: today, application_rate: 0.1, rate_unit: 'oz', service_record_id: record.id });
    }
    return f.customerId;
  }
  const row = async (customerId) => (await ComplianceService.getProductLimits(customerId)).limits.find((l) => l.limitId === limit.id);

  beforeAll(async () => {
    [product] = await db('products_catalog').insert({ name: `Count cap fixture ${randomUUID()}`, category: 'herbicide', active: true }).returning('*');
    made.products.push(product.id);
    [limit] = await db('product_limits').insert({ product_id: product.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: 'fixture' }).returning('*');
    made.limits.push(limit.id);
  });
  afterAll(async () => {
    await db('property_application_history').whereIn('customer_id', made.customers).del();
    await db('service_records').whereIn('id', made.records).del();
    await db('scheduled_services').whereIn('customer_id', made.customers).del();
    await db('customer_properties').whereIn('customer_id', made.customers).del();
    await db('customers').whereIn('id', made.customers).del();
    await db('product_limits').whereIn('id', made.limits).del();
    await db('products_catalog').whereIn('id', made.products).del();
    await db.destroy();
  });

  test('getProductLimits: one application at each of two properties is 1 of 2 per lawn, not 2 of 2', async () => {
    const customerId = await customerWithTwoProperties([0, 1]);
    expect(await row(customerId)).toMatchObject({ currentUsage: 1, status: 'warning' });
  });

  test('getProductLimits: two at one property reaches the cap; three applications over two properties count the busiest lawn (2)', async () => {
    const atCap = await customerWithTwoProperties([0, 0]);
    expect(await row(atCap)).toMatchObject({ currentUsage: 2, status: 'exceeded' });
    const spread = await customerWithTwoProperties([0, 1, 0]);
    expect(await row(spread)).toMatchObject({ currentUsage: 2, status: 'exceeded' });
    const oneEach = await customerWithTwoProperties([1]);
    expect(await row(oneEach)).toMatchObject({ currentUsage: 1, status: 'warning' });
  });

  test('getProductLimits follows the v13 gate for Celsius: the stored row is the legacy 3, so two applications are a warning with the gate off and exceeded (cap 2) with it on', async () => {
    const celsius = await db('products_catalog').where({ name: 'Celsius WG' }).first();
    const stored = await db('product_limits').where({ product_id: celsius.id, limit_type: 'annual_max_apps', match_type: 'product' }).first();
    expect(Number(stored.limit_value)).toBe(3);
    const customerId = await customerWithTwoProperties([0, 0], celsius);
    const saved = process.env.GATE_LAWN_V13;
    try {
      delete process.env.GATE_LAWN_V13;
      const off = (await ComplianceService.getProductLimits(customerId)).limits.find((l) => l.limitId === stored.id);
      expect(off).toMatchObject({ limitValue: '3.0000', currentUsage: 2, status: 'warning' });
      process.env.GATE_LAWN_V13 = 'true';
      const on = (await ComplianceService.getProductLimits(customerId)).limits.find((l) => l.limitId === stored.id);
      expect(on).toMatchObject({ limitValue: 2, currentUsage: 2, status: 'exceeded' });
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    }
  });

  test('getProductLimits follows the gate for the v13-only caps: Arena has no stored row, so it appears (cap 2, exceeded) only with the gate on', async () => {
    const arena = await db('products_catalog').where({ name: 'Arena 50 WDG' }).first();
    expect(await db('product_limits').where({ product_id: arena.id, limit_type: 'annual_max_apps' })).toHaveLength(0);
    const customerId = await customerWithTwoProperties([0, 0], arena);
    const saved = process.env.GATE_LAWN_V13;
    const forArena = async () => (await ComplianceService.getProductLimits(customerId)).limits.find((l) => l.productId === arena.id && l.limitType === 'annual_max_apps');
    try {
      delete process.env.GATE_LAWN_V13;
      expect(await forArena()).toBeUndefined();
      process.env.GATE_LAWN_V13 = 'true';
      expect(await forArena()).toMatchObject({ limitValue: 2, currentUsage: 2, status: 'exceeded', severity: 'hard_block' });
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    }
  });

  // Arena carries three v13 limits (the count of 2, the 56-day gap, the yearly amount): the summaries report all of them.
  describe('Arena\'s v13 limits are all reported (count, minimum interval, yearly amount)', () => {
    const shape = (rows) => rows.map((l) => [l.limit_type, l.match_type, Number(l.limit_value), l.severity]);
    const arenaRows = async (hardOnly = false) => (await ComplianceService.limitRowsWithV13Caps({ hardOnly })).filter((l) => l.product_name === 'Arena 50 WDG' || l.product_name === 'Arena S.E. 50 WDG Insecticide 2.5 lb. (Florida Only)');
    const ALL = [['annual_max_apps', 'product', 2, 'hard_block'], ['min_interval_days', 'product', 56, 'hard_block'], ['annual_max_rate', 'v13_amount', 0.294, 'hard_block']];
    const sorted = (rows) => rows.sort((a, b) => String(a[0]).localeCompare(b[0]));
    const withGate = async (value, fn) => {
      const saved = process.env.GATE_LAWN_V13;
      if (value === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = value;
      try { return await fn(); } finally { if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved; }
    };

    test('no stored row: the synthetic count, interval and amount rows are all there with the gate on, none with it off', async () => {
      const arena = await db('products_catalog').where({ name: 'Arena 50 WDG' }).first();
      expect(await db('product_limits').where({ product_id: arena.id })).toEqual([]);
      expect(sorted(shape(await withGate('true', () => arenaRows())))).toEqual(sorted([...ALL]));
      expect(sorted(shape(await withGate('true', () => arenaRows(true))))).toEqual(sorted([...ALL]));
      expect(await withGate(undefined, () => arenaRows())).toEqual([]);
    });

    test('stored count and interval rows: each is reported once (lowered / raised / hard), the amount joins, nothing is duplicated', async () => {
      const arena = await db('products_catalog').where({ name: 'Arena 50 WDG' }).first();
      const stored = await db('product_limits').insert([
        { product_id: arena.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 5, limit_unit: 'applications', severity: 'warning', description: 'fixture count' },
        { product_id: arena.id, match_type: 'product', limit_type: 'min_interval_days', limit_value: 30, limit_unit: 'days', severity: 'warning', description: 'fixture interval' },
      ]).returning('*');
      made.limits.push(...stored.map((r) => r.id));
      try {
        const rows = await withGate('true', () => arenaRows());
        expect(sorted(shape(rows))).toEqual(sorted([...ALL]));
        expect(rows.filter((l) => l.limit_type !== 'annual_max_rate').map((l) => l.id).sort()).toEqual(stored.map((r) => r.id).sort());
        // Gate off: exactly the stored rows as stored.
        expect(sorted(shape(await withGate(undefined, () => arenaRows())))).toEqual(sorted([['annual_max_apps', 'product', 5, 'warning'], ['min_interval_days', 'product', 30, 'warning']]));
      } finally {
        await db('product_limits').whereIn('id', stored.map((r) => r.id)).del();
      }
    });

    test('getProductLimits lists the three rows for a customer, and only Arena is given an interval or an amount row', async () => {
      const arena = await db('products_catalog').where({ name: 'Arena 50 WDG' }).first();
      const customerId = await customerWithTwoProperties([0], arena);
      const limits = (await withGate('true', () => ComplianceService.getProductLimits(customerId))).limits.filter((l) => l.productId === arena.id);
      expect(limits.map((l) => l.limitType).sort()).toEqual(['annual_max_apps', 'annual_max_rate', 'min_interval_days']);
      const others = (await withGate('true', () => ComplianceService.limitRowsWithV13Caps())).filter((l) => l.match_type === 'v13_amount' || (l.synthetic && l.limit_type === 'min_interval_days'));
      expect(new Set(others.map((l) => l.product_id))).toEqual(new Set([arena.id]));
    });
  });

  test('getPropertyComplianceStatus (the compliance page, the context aggregator) is per lawn: one application at each of two properties is no block; two at one property is', async () => {
    const applicationLimits = require('../services/application-limits');
    const spread = await customerWithTwoProperties([0, 1]);
    expect((await applicationLimits.getPropertyComplianceStatus(spread)).blocks).toBe(0);
    const stacked = await customerWithTwoProperties([0, 0]);
    expect((await applicationLimits.getPropertyComplianceStatus(stacked)).blocks).toBe(1);
  });

  test('the dashboard reads the v13 caps BEFORE its hard-only filter: a stored warning row of 1 on a capped product is a hard cap of 1 (not dropped for a synthetic 2); gate off it is not a hard row at all', async () => {
    const certainty = await db('products_catalog').where({ name: 'Certainty Turf Herbicide' }).first();
    const [warning] = await db('product_limits').insert({ product_id: certainty.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 1, limit_unit: 'applications', severity: 'warning', description: 'fixture warning row' }).returning('*');
    made.limits.push(warning.id);
    const saved = process.env.GATE_LAWN_V13;
    const hardRows = async () => (await ComplianceService.limitRowsWithV13Caps({ hardOnly: true })).filter((l) => l.product_id === certainty.id && l.limit_type === 'annual_max_apps');
    try {
      process.env.GATE_LAWN_V13 = 'true';
      const on = await hardRows();
      expect(on).toHaveLength(1);
      expect(on[0]).toMatchObject({ id: warning.id, severity: 'hard_block' });
      expect(Number(on[0].limit_value)).toBe(1);
      delete process.env.GATE_LAWN_V13;
      expect(await hardRows()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    }
  });

  test('the summaries read the property frozen on the ledger row: moving the visit to another property afterwards does not move the count', async () => {
    const customerId = await customerWithTwoProperties([0, 0]);
    const [a, b] = (await db('customer_properties').where({ customer_id: customerId }).orderBy('is_primary', 'desc')).map((p) => p.id);
    await db('property_application_history').where({ customer_id: customerId }).update({ property_id: a });
    await db('scheduled_services').where({ customer_id: customerId }).update({ property_id: b });
    expect(await row(customerId)).toMatchObject({ currentUsage: 2, status: 'exceeded' });
    // A legacy row (no frozen property) follows its visit: with the visits on B and one frozen at A, the busiest lawn is 1.
    const [one] = await db('property_application_history').where({ customer_id: customerId }).orderBy('id').select('id');
    await db('property_application_history').where({ id: one.id }).update({ property_id: null });
    expect(await row(customerId)).toMatchObject({ currentUsage: 1, status: 'warning' });
  });

  test('the dashboard groups by the property frozen on the ledger row: two applications frozen to one lawn still warn after one visit is moved to another property', async () => {
    const [capped] = await db('products_catalog').insert({ name: `Count cap frozen dashboard ${randomUUID()}`, category: 'herbicide', active: true }).returning('*');
    made.products.push(capped.id);
    const [cap3] = await db('product_limits').insert({ product_id: capped.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: 'fixture' }).returning('*');
    made.limits.push(cap3.id);
    const before = (await ComplianceService.getDashboard()).warningCount;
    const customerId = await customerWithTwoProperties([0, 0], capped);
    const [a, b] = (await db('customer_properties').where({ customer_id: customerId }).orderBy('is_primary', 'desc')).map((p) => p.id);
    await db('property_application_history').where({ customer_id: customerId }).update({ property_id: a });
    // Staff move one of the two visits to the other property afterwards: the live join would now say 1 + 1.
    const [moved] = await db('scheduled_services').where({ customer_id: customerId }).orderBy('id').select('id');
    await db('scheduled_services').where({ id: moved.id }).update({ property_id: b });
    // 2 of 3 on one lawn is the warning ("this would be the LAST allowed"); 1 + 1 would not warn.
    expect((await ComplianceService.getDashboard()).warningCount).toBe(before + 1);
    // A legacy row (no frozen property) follows its visit: 1 at A, 1 at B, nothing near the cap.
    await db('property_application_history').where({ customer_id: customerId }).update({ property_id: null });
    expect((await ComplianceService.getDashboard()).warningCount).toBe(before);
  });

  test('the dashboard cap usage is one grouped SQL query for all capped products, and no application row is pulled into Node', async () => {
    const [p1] = await db('products_catalog').insert({ name: `Count cap sql a ${randomUUID()}`, category: 'herbicide', active: true }).returning('*');
    const [p2] = await db('products_catalog').insert({ name: `Count cap sql b ${randomUUID()}`, category: 'herbicide', active: true }).returning('*');
    made.products.push(p1.id, p2.id);
    for (const p of [p1, p2]) {
      const [l] = await db('product_limits').insert({ product_id: p.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: 'fixture' }).returning('*');
      made.limits.push(l.id);
    }
    const before = (await ComplianceService.getDashboard()).warningCount;
    await customerWithTwoProperties([0, 0], p1); // 2 of 3 on one lawn: warns
    await customerWithTwoProperties([0, 1], p2); // 1 + 1: does not
    const seen = [];
    const listener = (q) => { if (/property_application_history/.test(q.sql)) seen.push(q.sql); };
    db.on('query', listener);
    let dashboard;
    try { dashboard = await ComplianceService.getDashboard(); } finally { db.removeListener('query', listener); }
    expect(dashboard.warningCount).toBe(before + 1);
    const grouped = seen.filter((sql) => /group by/i.test(sql) && /product_id/.test(sql) && /ANY\(/i.test(sql));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatch(/COALESCE\(pah\.property_id, ss_prop\.property_id\)/);
    // The other ledger reads are the dashboard's own counts and the recent list, never a per-limit row dump.
    expect(seen.filter((sql) => /select "?pah"?\."?customer_id"?/i.test(sql) && !/group by/i.test(sql))).toEqual([]);
  });

  test('getDashboard: three customers with one application each never trip a per-lawn cap of 3 on the company total; two at one lawn of 3 does warn', async () => {
    const [capped] = await db('products_catalog').insert({ name: `Count cap dashboard ${randomUUID()}`, category: 'herbicide', active: true }).returning('*');
    made.products.push(capped.id);
    const [cap3] = await db('product_limits').insert({ product_id: capped.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 3, limit_unit: 'applications', severity: 'hard_block', description: 'fixture' }).returning('*');
    made.limits.push(cap3.id);
    const before = (await ComplianceService.getDashboard()).warningCount;
    for (let i = 0; i < 3; i += 1) await customerWithTwoProperties([i % 2], capped);
    // 3 applications company-wide against a cap of 3 per lawn: the company total is not the lawn's count.
    expect((await ComplianceService.getDashboard()).warningCount).toBe(before);
    await customerWithTwoProperties([0, 0], capped);
    expect((await ComplianceService.getDashboard()).warningCount).toBe(before + 1);
  });
});
