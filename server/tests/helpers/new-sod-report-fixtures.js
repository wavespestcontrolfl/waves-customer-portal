// Fixture harness for the new-sod report tests: a table-keyed fake knex, one synthetic lawn visit and the
// shared resolver's reads. Extracted from lawn-new-sod-report-data.test.js. Synthetic data only.
const { buildReportIdentitySnapshot } = require('../../services/service-report/report-identity-snapshot');

const FAIL = Symbol('table read fails');
function makeKnex(fixtures) {
  const knex = (table) => {
    const failing = fixtures[table] === FAIL;
    let rows = failing ? [] : [...(fixtures[table] || [])];
    const sortKeys = [];
    const q = {};
    const applySort = () => {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of sortKeys) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b, c) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        } else if (arguments.length === 3) {
          rows = rows.filter((r) => {
            const left = String(r[a] ?? '');
            const right = String(c);
            if (b === '>') return left > right;
            if (b === '>=') return left >= right;
            if (b === '<') return left < right;
            if (b === '<=') return left <= right;
            return true;
          });
        }
        return q;
      },
      andWhere(a, b, c) {
        if (typeof a === 'function') {
          // the lawn/turf service-type scope: whereRaw('LOWER(service_type) LIKE ?')
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) {
            rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          }
          return q;
        }
        return q.where(a, b, c);
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) {
        if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
        else rows = rows.filter((r) => r[a] !== b);
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
      first() { return failing ? Promise.reject(new Error('read failed')) : Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: (fn) => (failing ? Promise.resolve(fn(new Error('read failed'))) : Promise.resolve(rows)),
      then: (resolve, reject) => (failing ? Promise.reject(new Error('read failed')) : Promise.resolve(rows)).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';
const facts = (rule) => ({
  productType: 'pesticide', name: 'Celsius WG', category: 'herbicide', activeIngredient: 'thiencarbazone',
  epaRegNumber: '432-1524', irrigationRequired: false, wateringRule: rule,
});
const HOLD = { mode: 'hold', hold_hours: 24, source: 'label' };
const WATER_IN = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default' };

function serviceWith(rule) {
  const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID]: facts(rule) } });
  return {
    id: 'svc-lawn-w1',
    scheduled_service_id: 'ss-current',
    customer_id: 'cust-lawn-w1',
    service_line: 'lawn',
    service_type: 'Lawn Care Treatment Program',
    service_date: '2026-09-30',
    completed_at: '2026-09-30T18:40:00Z',
    first_name: 'Test',
    last_name: 'Customer',
    areas_serviced: JSON.stringify(['Front Lawn']),
    structured_notes: '{}',
    service_data: JSON.stringify({ reportIdentitySnapshot: snapshot }),
  };
}

const fixtures = (prefs = []) => ({
  service_products: [{ id: 'sp-1', service_record_id: 'svc-lawn-w1', product_id: PRODUCT_ID, product_name: 'Celsius WG', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' }],
  property_geometries: [],
  property_zones: [],
  service_findings: [],
  service_photos: [],
  lawn_assessment_photos: [],
  lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-current', customer_id: 'cust-lawn-w1', scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: prefs,
  lawn_assessments: [{
    id: 'la-w1', customer_id: 'cust-lawn-w1', service_record_id: 'svc-lawn-w1', confirmed_by_tech: true,
    service_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z',
    turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
  }],
});


// The shared resolver's reads (lawn-new-sod-visit.js): the service record's own day, its
// appointment (stamped at the customer's primary address) and the customer's primary address.
const HOME = { line1: '100 Example Court', city: 'Bradenton', zip: '34201' };
const withIdentity = (prefs, { record = {}, appointment = {}, customer = {} } = {}) => ({
  ...fixtures(prefs),
  'service_records as sr': [{ 'sr.id': 'svc-lawn-w1', service_date: '2026-09-30', scheduled_service_id: 'ss-current', customer_id: 'cust-lawn-w1', ...record }],
  'scheduled_services as ss': [{
    'ss.id': 'ss-current', id: 'ss-current', customer_id: 'cust-lawn-w1', scheduled_date: '2026-09-30', property_id: null, source_estimate_id: null,
    service_address_line1: HOME.line1, service_address_line2: null, service_address_city: HOME.city, service_address_zip: HOME.zip, ...appointment,
  }],
  'customers as c': [{ 'c.id': 'cust-lawn-w1', address_line1: HOME.line1, address_line2: null, city: HOME.city, zip: HOME.zip, has_multi_home: false, ...customer }],
});


const SOD_PREFS = (sod_laid_on) => [{ customer_id: 'cust-lawn-w1', sod_laid_on }];
module.exports = { FAIL, makeKnex, PRODUCT_ID, facts, serviceWith, fixtures, withIdentity, SOD_PREFS, HOLD, WATER_IN };
