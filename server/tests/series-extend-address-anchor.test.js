/**
 * customer-properties.anchorSeriesAddress — series-extension address
 * inheritance (prod 2026-09-28: a Square-imported quarterly series' parent
 * had no property_id/address stamp; extending the series fell all the way
 * through to the customer's CURRENT primary address, a different house than
 * every visit the series actually ran at). Precedence:
 *   1. copyStampedServiceAddressFields' own stamp from the parent — never
 *      touched here.
 *   2. The most recent ADDRESSED, live-enough sibling in the same series.
 *   3. The existing sole-active-property fallback (anchorSoleProperty).
 *
 * A tiny in-memory knex-chain fake stands in for the DB — it actually
 * evaluates the .where/.andWhere/.orWhere/.whereNotIn predicates
 * anchorSeriesAddress's own query builds, so these tests exercise the real
 * production filtering (status exclusion, address-or-property-id
 * candidacy), not a canned result list.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const { anchorSeriesAddress } = require('../services/customer-properties');

const COLS = {
  property_id: true,
  service_address_line1: true,
  service_address_line2: true,
  service_address_city: true,
  service_address_state: true,
  service_address_zip: true,
  lat: true,
  lng: true,
  zone: true,
  source_estimate_id: true,
};

// ---- minimal knex-chain fake, general enough for both tables the helper
// touches (scheduled_services siblings, customer_properties active check).

function makeBuilder() {
  const groups = [[]];
  const push = (pred, isOr) => {
    if (isOr) groups.push([pred]);
    else groups[groups.length - 1].push(pred);
  };
  const toPred = (args) => {
    if (typeof args[0] === 'function') {
      const sub = makeBuilder();
      args[0].call(sub, sub);
      return (r) => sub.matches(r);
    }
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      const obj = args[0];
      return (r) => Object.entries(obj).every(([k, v]) => r[k] === v);
    }
    if (args.length === 2) {
      const [field, val] = args;
      return (r) => r[field] === val;
    }
    if (args.length === 3 && args[1] === '!=') {
      const [field, , val] = args;
      return (r) => r[field] !== val;
    }
    throw new Error(`sibling-fake: unsupported where() args ${JSON.stringify(args)}`);
  };
  const b = {
    where(...a) { push(toPred(a), false); return b; },
    andWhere(...a) { push(toPred(a), false); return b; },
    orWhere(...a) { push(toPred(a), true); return b; },
    whereNotNull(field) { push((r) => r[field] !== null && r[field] !== undefined, false); return b; },
    whereNotIn(field, arr) { push((r) => !arr.includes(r[field]), false); return b; },
    matches(r) { return groups.some((g) => g.every((p) => p(r))); },
  };
  return b;
}

function makeTable(rows) {
  const b = makeBuilder();
  const order = [];
  let limitN = Infinity;
  return Object.assign(b, {
    orderBy(field, dir) { order.push({ field, dir }); return this; },
    limit(n) { limitN = n; return this; },
    async select() {
      let out = rows.filter((r) => b.matches(r));
      for (const { field, dir } of [...order].reverse()) {
        out = out.slice().sort((x, y) => {
          const xv = x[field] ?? '';
          const yv = y[field] ?? '';
          if (xv === yv) return 0;
          const cmp = xv < yv ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return out.slice(0, limitN);
    },
    async first() {
      return rows.filter((r) => b.matches(r))[0];
    },
  });
}

function fakeConn(tables) {
  const conn = (name) => {
    if (!tables[name]) throw new Error(`sibling-fake: unexpected table "${name}"`);
    return makeTable(tables[name]);
  };
  conn.isTransaction = false;
  return conn;
}

function throwingConn() {
  const conn = () => { throw new Error('anchorSeriesAddress must not query when already resolved'); };
  conn.isTransaction = false;
  return conn;
}

const SIBLING_FIELDS = {
  id: 'sib', customer_id: 'cust-1', recurring_parent_id: 'parent-1',
  status: 'pending', scheduled_date: '2026-06-01', created_at: '2026-01-01T00:00:00Z',
  property_id: null, service_address_line1: null, service_address_line2: null,
  service_address_city: null, service_address_state: null, service_address_zip: null,
  lat: null, lng: null, zone: null, recurring_template_overrides: null,
};

describe('anchorSeriesAddress', () => {
  test('precedence 1: an explicit property_id stamp is never touched, and no query runs', async () => {
    const target = { customer_id: 'cust-1', property_id: 'p-explicit' };
    await anchorSeriesAddress(target, 'parent-1', COLS, throwingConn());
    expect(target.property_id).toBe('p-explicit');
  });

  test('precedence 1: an already-stamped service address is never touched, and no query runs', async () => {
    const target = { customer_id: 'cust-1', property_id: null, service_address_line1: '9 Elsewhere Rd' };
    await anchorSeriesAddress(target, 'parent-1', COLS, throwingConn());
    expect(target.property_id).toBeNull();
    expect(target.service_address_line1).toBe('9 Elsewhere Rd');
  });

  test('estimate-linked row is left to the estimate linkage, untouched', async () => {
    const target = { customer_id: 'cust-1', property_id: null, source_estimate_id: 'est-1' };
    await anchorSeriesAddress(target, 'parent-1', COLS, throwingConn());
    expect(target.property_id).toBeNull();
    expect(target.service_address_line1).toBeUndefined();
  });

  test('precedence 2: the most recent addressed sibling (active property) anchors the row', async () => {
    const older = {
      ...SIBLING_FIELDS, id: 'sib-old', scheduled_date: '2026-03-01',
      property_id: 'p-rental', service_address_line1: '10 Old Ave',
      service_address_city: 'Bradenton', service_address_state: 'FL', service_address_zip: '34205',
    };
    const newer = {
      ...SIBLING_FIELDS, id: 'sib-new', scheduled_date: '2026-06-01',
      property_id: 'p-rental', service_address_line1: '20 Rental Ln',
      service_address_city: 'Bradenton', service_address_state: 'FL', service_address_zip: '34205',
      lat: 27.5, lng: -82.5,
    };
    const conn = fakeConn({
      scheduled_services: [older, newer],
      customer_properties: [{ id: 'p-rental', customer_id: 'cust-1', active: true }],
    });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-rental');
    expect(target.service_address_line1).toBe('20 Rental Ln');
    expect(target.lat).toBe(27.5);
  });

  test('precedence 2: the sibling address replaces main-address coordinates an addressless parent left on the row', async () => {
    const sibling = {
      ...SIBLING_FIELDS, id: 'sib-rental', property_id: 'p-rental',
      service_address_line1: '20 Rental Ln', service_address_city: 'Sarasota',
      service_address_state: 'FL', service_address_zip: '34231',
      lat: 27.38, lng: -82.39, zone: null,
    };
    const conn = fakeConn({
      scheduled_services: [sibling],
      customer_properties: [{ id: 'p-rental', customer_id: 'cust-1', active: true }],
    });
    // What copyStampedServiceAddressFields leaves from a parent with no
    // address but a main-address geocode and a routing zone.
    const target = {
      customer_id: 'cust-1', property_id: null, service_address_line1: null,
      lat: 27.51, lng: -82.37, zone: 'north',
    };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-rental');
    expect(target.service_address_city).toBe('Sarasota');
    expect(target.lat).toBe(27.38);
    expect(target.lng).toBe(-82.39);
    expect(target.zone).toBe('north');
  });

  test('precedence 2: a sibling with only a stamped address (no property_id) still anchors the row', async () => {
    const sibling = {
      ...SIBLING_FIELDS, id: 'sib-legacy', property_id: null,
      service_address_line1: '5 Legacy St', service_address_city: 'Sarasota',
      service_address_state: 'FL', service_address_zip: '34231',
    };
    const conn = fakeConn({ scheduled_services: [sibling], customer_properties: [] });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBeNull();
    expect(target.service_address_line1).toBe('5 Legacy St');
  });

  test('dead-status sibling (cancelled) is skipped in favor of an older completed one', async () => {
    const cancelledNewest = {
      ...SIBLING_FIELDS, id: 'sib-cancelled', status: 'cancelled', scheduled_date: '2026-08-01',
      property_id: 'p-wrong', service_address_line1: '1 Should Not Use',
    };
    const completedOlder = {
      ...SIBLING_FIELDS, id: 'sib-completed', status: 'completed', scheduled_date: '2026-03-01',
      property_id: 'p-right', service_address_line1: '2 Real House',
    };
    const conn = fakeConn({
      scheduled_services: [cancelledNewest, completedOlder],
      customer_properties: [{ id: 'p-right', customer_id: 'cust-1', active: true }],
    });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    // completed rows ARE valid evidence — a cancelled row never wins even
    // though it is the more recent date.
    expect(target.property_id).toBe('p-right');
    expect(target.service_address_line1).toBe('2 Real House');
  });

  test('rescheduled-placeholder and no_show siblings are also skipped as dead', async () => {
    const rows = ['rescheduled', 'no_show', 'skipped'].map((status, i) => ({
      ...SIBLING_FIELDS, id: `sib-${status}`, status, scheduled_date: `2026-0${7 - i}-01`,
      property_id: 'p-wrong', service_address_line1: 'wrong address',
    }));
    const liveOldest = {
      ...SIBLING_FIELDS, id: 'sib-live', status: 'pending', scheduled_date: '2026-01-01',
      property_id: 'p-right', service_address_line1: 'right address',
    };
    const conn = fakeConn({
      scheduled_services: [...rows, liveOldest],
      customer_properties: [{ id: 'p-right', customer_id: 'cust-1', active: true }],
    });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-right');
  });

  test('a sibling whose property is no longer active is skipped for the next-most-recent valid sibling', async () => {
    const newestInactive = {
      ...SIBLING_FIELDS, id: 'sib-inactive', scheduled_date: '2026-07-01',
      property_id: 'p-deactivated', service_address_line1: 'deactivated address',
    };
    const olderActive = {
      ...SIBLING_FIELDS, id: 'sib-active', scheduled_date: '2026-04-01',
      property_id: 'p-active', service_address_line1: 'active address',
    };
    const conn = fakeConn({
      scheduled_services: [newestInactive, olderActive],
      customer_properties: [
        { id: 'p-deactivated', customer_id: 'cust-1', active: false },
        { id: 'p-active', customer_id: 'cust-1', active: true },
      ],
    });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-active');
  });

  test('precedence 3: no addressed sibling in the series falls through to the sole-active-property anchor', async () => {
    const conn = fakeConn({
      scheduled_services: [],
      customer_properties: [{ id: 'p-sole', customer_id: 'cust-1', active: true }],
    });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-sole');
  });

  test('precedence 3: an inactive-only sibling AND no sole property both miss → property_id stays null', async () => {
    const inactiveOnly = {
      ...SIBLING_FIELDS, id: 'sib-inactive', property_id: 'p-deactivated', service_address_line1: 'x',
    };
    const conn = fakeConn({
      scheduled_services: [inactiveOnly],
      customer_properties: [{ id: 'p-deactivated', customer_id: 'cust-1', active: false }],
    });
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBeNull();
  });

  test('best-effort: a failing sibling lookup still resolves through the sole-property fallback', async () => {
    let calls = 0;
    const conn = (name) => {
      calls += 1;
      if (name === 'scheduled_services') throw new Error('boom');
      return makeTable([{ id: 'p-sole', customer_id: 'cust-1', active: true }]);
    };
    conn.isTransaction = false;
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-sole');
    expect(calls).toBeGreaterThan(0);
  });
});

describe('at least one extension writer calls anchorSeriesAddress', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes/admin-schedule.js'), 'utf8');

  test('admin-schedule.js imports anchorSeriesAddress from customer-properties', () => {
    expect(src).toContain("const { anchorSoleProperty, anchorSeriesAddress } = require('../services/customer-properties');");
  });

  test('every series-extension writer (5) uses anchorSeriesAddress; the two brand-new-series spawn loops keep anchorSoleProperty', () => {
    const seriesAnchored = src.match(/copyStampedServiceAddressFields\((\w+), \w+, cols\);\n(?:[^\n]*\n)?\s*await anchorSeriesAddress\(\1, \w+(?:\.\w+)?, cols, (?:trx|conn)\);/g) || [];
    expect(seriesAnchored.length).toBe(5);
    const soleAnchored = src.match(/copyStampedServiceAddressFields\((\w+), \w+, cols\);\n\s*if \(!propertyOwnedByEstimateLinkage\) await anchorSoleProperty\(\1, cols, trx\);/g) || [];
    expect(soleAnchored.length).toBe(2);
    // reconcileRecurringSeriesVisitCount — the bug's own repro path.
    expect(src).toContain('copyStampedServiceAddressFields(data, parent, cols);\n    await anchorSeriesAddress(data, parentId, cols, trx);');
  });
});
