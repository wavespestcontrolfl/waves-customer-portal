// The first-visit pest email reads one visit through readVisitSummary (email-division/visit-products). That
// reader borrows four helpers of service-report/report-data, and report-data loads visit-products back through
// its own tree: a require cycle. In the production boot report-data loads first. A destructure at load then read
// exports that did not exist yet, so all four helpers were undefined and readVisitSummary threw
// "applicationAreaValues is not a function" (found 2026-11-21; the automation of that email was paused).
// These tests load the two modules in both orders and read a visit.

const REPORT_DATA = '../services/service-report/report-data';
const VISIT_PRODUCTS = '../services/email-division/visit-products';

// A knex stand-in: every chain resolves to no rows; .first() on service_records gives the one visit.
function fakeConn(visit) {
  const conn = (table) => {
    const chain = new Proxy(function chainTarget() {}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve([]).then(resolve, reject);
        if (prop === 'first') return async () => (String(table).startsWith('service_records') ? visit : undefined);
        return () => chain;
      },
    });
    return chain;
  };
  conn.raw = async () => ({ rows: [] });
  return conn;
}

const VISIT = {
  id: 'visit-1', customer_id: null, service_type: 'Pest Control', service_date: '2026-11-02',
  areas_serviced: JSON.stringify(['Perimeter', 'perimeter', 'Garage']),
  structured_notes: null, service_data: null, advisory: null, conditions: null,
  technician_notes: null, client_pest_rating: null,
};

// The read runs INSIDE the isolated registry: the call-time require of report-data must resolve to the module
// of this same cycle, as in production, not to a second copy loaded after the registry closed.
async function readInOrder(first, second) {
  let summary;
  await jest.isolateModulesAsync(async () => {
    require(first);
    require(second);
    summary = await require(VISIT_PRODUCTS).readVisitSummary('visit-1', { conn: fakeConn(VISIT) });
  });
  return summary;
}

describe('visit-products inside the require cycle with service-report/report-data', () => {
  test.each([
    ['report-data loads first (the production boot order)', REPORT_DATA, VISIT_PRODUCTS],
    ['visit-products loads first', VISIT_PRODUCTS, REPORT_DATA],
  ])('%s: readVisitSummary reaches the four report helpers', async (_name, first, second) => {
    const summary = await readInOrder(first, second);
    // uniqueStrings + applicationAreaValues: one spelling per area, the first one seen.
    expect(summary.areasTreated).toEqual(['Perimeter', 'Garage']);
    // normalizeAdvisoryForTreatmentScope + resolveTracedExteriorZone: the advisory block is built, not thrown.
    expect(Object.keys(summary.advisory).sort()).toEqual(['exteriorReentryMin', 'interiorReentryMin', 'irrigationHoldHr', 'petAdvisory']);
  });

  test('the module reads report-data at call time: no destructure of it at load', () => {
    const source = require('fs').readFileSync(require.resolve(VISIT_PRODUCTS), 'utf8');
    expect(source).not.toMatch(/=\s*require\('\.\.\/service-report\/report-data'\)\s*;/);
    expect(source).toMatch(/const reportData = \(\) => require\('\.\.\/service-report\/report-data'\);/);
  });
});
