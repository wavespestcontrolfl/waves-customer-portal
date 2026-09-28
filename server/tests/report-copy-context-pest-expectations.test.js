// Unit tests for the EXPECTATIONS grounding section buildReportCopyContext
// feeds to the AI report writer (owner-approved 2026-09-27,
// GATE_PEST_REPORT_EXPECTATIONS) — same facts, same classifier as the
// customer-facing Pest Report V2 expectations blocks (pest-report-expectations.js).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildReportCopyContext } = require('../services/service-report/report-copy-context');

function makeKnexStub({ customers = [], catalogProducts = [] } = {}) {
  const stub = (table) => {
    const chain = { _whereIns: [] };
    for (const method of ['whereNull', 'whereNot', 'andWhere', 'orWhere', 'orWhereNot', 'orderBy', 'orderByRaw', 'limit', 'select', 'join', 'leftJoin', 'groupBy', 'count', 'whereRaw', 'whereBetween', 'modify']) {
      chain[method] = () => chain;
    }
    chain.whereIn = (column, values) => { chain._whereIns.push([column, values]); return chain; };
    chain.where = (...args) => {
      if (typeof args[0] === 'function') { args[0].call(chain); return chain; }
      return chain;
    };
    const resolveRows = () => {
      if (table === 'customers') return customers;
      if (table === 'products_catalog') {
        return chain._whereIns.reduce((rows, [column, values]) => (
          rows.filter((row) => values.includes(row[column]))
        ), catalogProducts);
      }
      return [];
    };
    chain.first = async () => resolveRows()[0];
    chain.then = (resolve, reject) => Promise.resolve(resolveRows()).then(resolve, reject);
    chain.catch = () => chain;
    return chain;
  };
  stub.raw = (expression) => expression;
  return stub;
}

// No geocode → weekWeather/live-conditions fetches are skipped (buildReportCopyContext
// only fetches when lat/lng are present) — the rainy-season calendar signal still
// fires on its own, which is exactly what's under test without a network call.
const CUSTOMER = { id: 'c1', first_name: 'Pat', last_name: 'Pest', city: 'Bradenton', state: 'FL', latitude: null, longitude: null };

const FIPRONIL_PRODUCT = {
  id: 'p1', name: 'Termidor SC', category: 'insecticide', product_type: 'pesticide',
  active_ingredient: 'Fipronil', epa_reg_number: '432-1348', approved_for_service_report: true,
  moa_group: null, rainfast_minutes: null,
};

describe('buildReportCopyContext — EXPECTATIONS grounding (gate on)', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  afterEach(() => { process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL; });

  it('includes an EXPECTATIONS section with the rainy-season line and the product-class line', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [FIPRONIL_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15', // July — rainy season
      products: [{ productId: 'p1', name: 'Termidor SC' }],
      knex,
    });
    expect(contextText).toMatch(/EXPECTATIONS/);
    expect(contextText).toMatch(/Heavy rain pushes ants indoors/);
    expect(contextText).toMatch(/Non-repellent products/);
    // No rain reading (no geocode in this stub) — a null rainInches must
    // never render as "0 inches" (Number(null) === 0 footgun).
    expect(contextText).not.toMatch(/rained about/);
  });

  it('omits the EXPECTATIONS section outside rainy season with no classifiable product and no rain data', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-02-15', // February — outside rainy season
      products: [],
      knex,
    });
    expect(contextText).not.toMatch(/EXPECTATIONS/);
  });
});

describe('buildReportCopyContext — EXPECTATIONS grounding (gate off)', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  afterEach(() => { process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL; });

  it('never adds the EXPECTATIONS section when the gate is off', async () => {
    delete process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [FIPRONIL_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15',
      products: [{ productId: 'p1', name: 'Termidor SC' }],
      knex,
    });
    expect(contextText).not.toMatch(/EXPECTATIONS/);
  });
});
