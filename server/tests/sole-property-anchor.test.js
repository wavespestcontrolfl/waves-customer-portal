/**
 * customer-properties.anchorSoleProperty — the write-time half of the
 * sole-property anchor (the 20260903000050 backfill is the other half).
 * Pins the rule and that every spawned-row writer calls it.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => ({}), { virtual: false });
const { anchorSoleProperty } = require('../services/customer-properties');

const COLS = { property_id: true, service_address_line1: true, source_estimate_id: true };

function fakeConn(propertiesByCustomer) {
  return (table) => {
    if (table !== 'customer_properties') throw new Error(`unexpected table ${table}`);
    const q = { _f: null, _l: null };
    q.where = (f) => { q._f = f; return q; };
    q.limit = (n) => { q._l = n; return q; };
    q.select = async () => (propertiesByCustomer[q._f.customer_id] || [])
      .filter((p) => p.active === q._f.active).slice(0, q._l).map((p) => ({ id: p.id }));
    return q;
  };
}

describe('anchorSoleProperty', () => {
  const conn = fakeConn({
    'c-sole': [{ id: 'p1', active: true }, { id: 'p-old', active: false }],
    'c-multi': [{ id: 'p1', active: true }, { id: 'p2', active: true }],
  });

  test('stamps the sole active property on an unstamped row with none', async () => {
    const row = { customer_id: 'c-sole', property_id: null };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBe('p1');
  });

  test('never overrides an explicit stamp', async () => {
    const row = { customer_id: 'c-sole', property_id: 'p-explicit' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBe('p-explicit');
  });

  test('leaves a row with a stamped service address alone (may be an unregistered address)', async () => {
    const row = { customer_id: 'c-sole', property_id: null, service_address_line1: '9 Elsewhere Rd' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBeNull();
  });

  test('an estimate-backed row is left to the estimate linkage (a new address must not anchor to the old property)', async () => {
    const row = { customer_id: 'c-sole', property_id: null, source_estimate_id: 'est-1' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBeNull();
  });

  test('two active properties → null (office places it)', async () => {
    const row = { customer_id: 'c-multi', property_id: null };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBeNull();
  });

  test('cols-guarded: no property_id column → untouched', async () => {
    const row = { customer_id: 'c-sole' };
    await anchorSoleProperty(row, { service_address_line1: true }, conn);
    expect(row.property_id).toBeUndefined();
    await anchorSoleProperty(row, null, conn);
    expect(row.property_id).toBeUndefined();
  });

  test('best-effort: a failing lookup yields null, never throws', async () => {
    const row = { customer_id: 'c-sole', property_id: null };
    await anchorSoleProperty(row, COLS, () => { throw new Error('boom'); });
    expect(row.property_id).toBeNull();
  });

  test('inside a caller transaction the lookup runs in a savepoint, so a failure cannot abort the caller (pre-push #3837 r3 P1)', async () => {
    // A knex trx: isTransaction + .transaction(fn) opens a nested savepoint.
    // The inner read fails; the savepoint rolls back and the outer trx
    // stays usable — pinned by the outer conn never being queried directly.
    let savepoints = 0;
    let outerQueried = false;
    const trx = () => { outerQueried = true; throw new Error('must read through the savepoint'); };
    trx.isTransaction = true;
    trx.transaction = async (fn) => {
      savepoints += 1;
      const sp = () => { throw new Error('boom'); };
      sp.isTransaction = true;
      return fn(sp);
    };
    const row = { customer_id: 'c-sole', property_id: null };
    await anchorSoleProperty(row, COLS, trx);
    expect(row.property_id).toBeNull();
    expect(savepoints).toBe(1);
    expect(outerQueried).toBe(false);

    // And a healthy savepoint read resolves the anchor as before.
    const okTrx = () => { throw new Error('must read through the savepoint'); };
    okTrx.isTransaction = true;
    okTrx.transaction = async (fn) => fn(fakeConn({ 'c-sole': [{ id: 'p1', active: true }] }));
    const row2 = { customer_id: 'c-sole', property_id: null };
    await anchorSoleProperty(row2, COLS, okTrx);
    expect(row2.property_id).toBe('p1');
  });
});

describe('anchorSoleProperty — a series child follows its series (ops 2026-10-02)', () => {
  // scheduled_services ⋈ customer_properties, as seriesAgreedPropertyId reads it.
  function seriesConn({ visits, properties }) {
    const conn = (table) => {
      if (table === 'customer_properties') return fakeConn({ [properties[0]?.customer_id]: properties })(table);
      const f = [];
      const q = {
        join: () => q,
        where: (a) => { f.push(a); return q; },
        whereNotIn: (col, vals) => { f.push({ notIn: vals }); return q; },
        distinct: () => q,
        limit: async (n) => {
          const [orFn, eq, notIn] = f;
          let root = null;
          orFn({ where: (c, v) => { root = v; return { orWhere: () => {} }; } });
          const rows = visits.filter((v) => (v.id === root || v.recurring_parent_id === root)
            && v.customer_id === eq['ss.customer_id'] && !notIn.notIn.includes(v.status) && v.property_id
            && properties.some((p) => p.id === v.property_id && p.active && p.customer_id === eq['p.customer_id']));
          return [...new Set(rows.map((r) => r.property_id))].slice(0, n).map((property_id) => ({ property_id }));
        },
      };
      return q;
    };
    return conn;
  }
  const properties = [
    { id: 'home', customer_id: 'c', active: true },
    { id: 'rental', customer_id: 'c', active: true },
  ];

  test('a multi-property customer\'s next visit takes the house the series is at, even when the root has none', async () => {
    const conn = seriesConn({ properties, visits: [
      { id: 'root', customer_id: 'c', status: 'cancelled', property_id: null },
      { id: 'k1', recurring_parent_id: 'root', customer_id: 'c', status: 'pending', property_id: 'home' },
      { id: 'k2', recurring_parent_id: 'root', customer_id: 'c', status: 'completed', property_id: 'home' },
    ] });
    const row = { customer_id: 'c', property_id: null, recurring_parent_id: 'root' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBe('home');
  });

  test('a series at two houses, or at none, stays for the office to place', async () => {
    const split = seriesConn({ properties, visits: [
      { id: 'k1', recurring_parent_id: 'root', customer_id: 'c', status: 'pending', property_id: 'home' },
      { id: 'k2', recurring_parent_id: 'root', customer_id: 'c', status: 'pending', property_id: 'rental' },
    ] });
    const a = { customer_id: 'c', property_id: null, recurring_parent_id: 'root' };
    await anchorSoleProperty(a, COLS, split);
    expect(a.property_id).toBeNull();
    const none = seriesConn({ properties, visits: [{ id: 'root', customer_id: 'c', status: 'pending', property_id: null }] });
    const b = { customer_id: 'c', property_id: null, recurring_parent_id: 'root' };
    await anchorSoleProperty(b, COLS, none);
    expect(b.property_id).toBeNull();
  });

  test('a cancelled visit at another house does not count', async () => {
    const conn = seriesConn({ properties, visits: [
      { id: 'k1', recurring_parent_id: 'root', customer_id: 'c', status: 'cancelled', property_id: 'rental' },
      { id: 'k2', recurring_parent_id: 'root', customer_id: 'c', status: 'pending', property_id: 'home' },
    ] });
    const row = { customer_id: 'c', property_id: null, recurring_parent_id: 'root' };
    await anchorSoleProperty(row, COLS, conn);
    expect(row.property_id).toBe('home');
  });
});

describe('every spawned-row writer anchors the sole property', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('the recurring seeder resolves the anchor on the parent copy the children are built from', () => {
    const src = read('services/recurring-appointment-seeder.js');
    const i = src.indexOf("anchorSoleProperty(anchoredParent, columns, conn)");
    const j = src.indexOf('buildRecurringFollowUpRows(anchoredParent, {');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });

  test('every admin-schedule spawned-row writer copies the parent stamp AND anchors', () => {
    const src = read('routes/admin-schedule.js');
    const anchored = src.match(/copyStampedServiceAddressFields\((\w+), (\w+), cols\);\n\s*(?:if \(!propertyOwnedByEstimateLinkage\) )?await anchorSoleProperty\(\1, cols, (trx|conn)\);/g) || [];
    const allCopies = src.match(/copyStampedServiceAddressFields\(\w+, \w+, cols\);/g) || [];
    // Five extension/spawn writers + the direct admin-create child and
    // booster loops (GH codex #3837 r1 P1).
    expect(allCopies.length).toBe(7);
    expect(anchored.length).toBe(allCopies.length);
    // The direct-create loops spawn from the freshly inserted parent `svc`.
    // Deferred estimate link (GH codex #3837 r2 P1): the rows carry no
    // source_estimate_id yet, so the anchor is gated on the deferral — the
    // parent's own anchor included, since the children copy the parent.
    expect(src).toContain('copyStampedServiceAddressFields(childData, svc, cols);\n        if (!propertyOwnedByEstimateLinkage) await anchorSoleProperty(childData, cols, trx);');
    expect(src).toContain('copyStampedServiceAddressFields(boosterData, svc, cols);\n          if (!propertyOwnedByEstimateLinkage) await anchorSoleProperty(boosterData, cols, trx);');
    expect(src).toContain('const propertyOwnedByEstimateLinkage = !!linkedEstimateId && !insertLinkId;');
    expect(src).toContain("if (cols.property_id && insertData.property_id === undefined && !propertyOwnedByEstimateLinkage) {");
    // …and the rows the anchor left to the linkage DO get stamped: the
    // acceptance's linkage ran before source_estimate_id existed on them
    // (GH codex #3837 r2 P1), so both post-commit link writers re-run it
    // scoped to the created rows.
    expect(src).toContain('if (await linkCreatedRowsToEstimate()) {\n          await retireRodentSetupStampAfterAcceptance(acceptResult);\n          await stampCreatedRowsFromEstimateProperty();');
    expect(src).toContain(".update({ source_estimate_id: linkedEstimateId });\n        await stampCreatedRowsFromEstimateProperty();");
    // The annual-prepay overlap fallback links the same rows (pre-push r6 P1).
    expect(src).toContain('if (await linkCreatedRowsToEstimate()) {\n              await retireRodentSetupStampAfterAcceptance(retryResult);\n              await stampCreatedRowsFromEstimateProperty();');
    // Every durable link is followed by the stamp.
    const links = src.match(/if \(await linkCreatedRowsToEstimate\(\)\) \{\n\s*await retireRodentSetupStampAfterAcceptance\(\w+\);\n\s*await stampCreatedRowsFromEstimateProperty\(\);/g) || [];
    expect(links.length).toBe((src.match(/await linkCreatedRowsToEstimate\(\)/g) || []).length);
    expect(src).toMatch(/linkAcceptedEstimateProperty\(\{\s*estimateId: linkedEstimateId,\s*customerId,\s*onlyServiceIds: createdAppointments\.map\(\(a\) => a\.id\),/);
  });
});
