// Unit tests for the EXPECTATIONS grounding section buildReportCopyContext
// feeds to the AI report writer (owner-approved 2026-09-27,
// GATE_PEST_REPORT_EXPECTATIONS) — same facts, same classifier as the
// customer-facing Pest Report V2 expectations blocks (pest-report-expectations.js).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
// weekWeather is a real network call (application-conditions.js) — mocked so
// the geocoded-customer test controls the rain reading without hitting the
// network; the null-geocode tests never call it at all (this mock just makes
// that assertable / never a surprise live fetch in CI).
// Default: no rain reading (report-copy-context.js's OWN finiteOrNull has
// the same Number(null)===0 footgun pest-report-expectations.js had, so a
// null-lat/lng customer still computes lat=0/lng=0 and calls this — the real
// fetchServiceWeekWeather short-circuits 0,0 to an empty result; this mock's
// default mirrors that so a test that doesn't care about weather doesn't
// have to stub it).
const EMPTY_WEEK_WEATHER = { rainInches: null, et0Inches: null, dailyRain: null, rainConfidence: null, rainSource: null, windowClosed: true };
const mockFetchServiceWeekWeather = jest.fn().mockResolvedValue(EMPTY_WEEK_WEATHER);
jest.mock('../services/service-report/application-conditions', () => ({
  ...jest.requireActual('../services/service-report/application-conditions'),
  fetchServiceWeekWeather: (...args) => mockFetchServiceWeekWeather(...args),
}));

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
// Geocoded — buildReportCopyContext fetches weekWeather for this one
// (mockFetchServiceWeekWeather controls the reading per test).
const GEOCODED_CUSTOMER = { ...CUSTOMER, id: 'c2', latitude: 27.5, longitude: -82.5 };

// Real catalog product name (owner-approved explicit classification map,
// pest-report-expectations.js) — classification is name-only now, never
// inferred from active_ingredient/category/moa_group.
const NON_REPELLENT_PRODUCT = {
  id: 'p1', name: 'Taurus SC', category: 'insecticide', product_type: 'pesticide',
  active_ingredient: 'Fipronil', epa_reg_number: '432-1348', approved_for_service_report: true,
  moa_group: null, rainfast_minutes: null,
};
// The classifier needs the NAME (owner-flagged P1 2026-09-28: this
// grounding path used to build its product list without `name`, so this
// exact product would have silently failed to classify here while still
// classifying correctly on the customer-facing render path).
const ROACH_GEL_PRODUCT = {
  id: 'p2', name: 'Advion Cockroach Gel Bait', category: 'bait', product_type: 'bait',
  active_ingredient: 'Indoxacarb', epa_reg_number: '352-687', approved_for_service_report: true,
  moa_group: null, rainfast_minutes: null,
};

describe('buildReportCopyContext — EXPECTATIONS grounding (gate on)', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  beforeEach(() => { mockFetchServiceWeekWeather.mockResolvedValue(EMPTY_WEEK_WEATHER); });
  afterEach(() => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL;
    mockFetchServiceWeekWeather.mockClear();
  });

  it('includes an EXPECTATIONS section with the product-class line; no ants line with no rain data (no geocode)', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [NON_REPELLENT_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15', // July — rainy season, but no rain reading
      products: [{ productId: 'p1', name: 'Taurus SC' }],
      knex,
    });
    expect(contextText).toMatch(/EXPECTATIONS/);
    expect(contextText).toMatch(/Non-repellent products/);
    // Owner ruling 2026-09-28: rainy season alone (no rain reading, no live
    // forecast signal) never adds the ants line.
    expect(contextText).not.toMatch(/Heavy rain pushes ants indoors/);
    // No rain reading (no geocode in this stub) — a null rainInches must
    // never render as "0 inches" (Number(null) === 0 footgun).
    expect(contextText).not.toMatch(/rained about/);
  });

  it('classifies a name-dependent product (roach gel bait) correctly — same as the render path (owner-flagged P1 regression)', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [ROACH_GEL_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-02-15', // outside rainy season — isolates the product-class line
      products: [{ productId: 'p2', name: 'Advion Cockroach Gel Bait' }],
      knex,
    });
    expect(contextText).toMatch(/EXPECTATIONS/);
    expect(contextText).toMatch(/gel bait/);
    expect(contextText).not.toMatch(/Non-repellent products/);
  });

  it('rainy season + a real >= 0.5" rain reading adds the ants line', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    mockFetchServiceWeekWeather.mockResolvedValue({ rainInches: 0.6, rainConfidence: null, et0Inches: null, dailyRain: null, rainSource: null, windowClosed: true });
    const knex = makeKnexStub({ customers: [GEOCODED_CUSTOMER], catalogProducts: [] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c2',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15',
      products: [],
      knex,
    });
    expect(contextText).toMatch(/rained about 0\.6"/);
    expect(contextText).toMatch(/Heavy rain pushes ants indoors/);
    // codex P1 2026-09-29: the "treated band" claim requires confirmed
    // exterior/perimeter application evidence (method/area) that this
    // grounding path structurally never has — productSafety is deduped by
    // CATALOG PRODUCT, not by application, so it always falls back to the
    // treatment-neutral ants wording, same as the customer-facing card
    // would with no such evidence (never a stronger claim in the prompt
    // than the deterministic block itself makes).
    expect(contextText).not.toMatch(/treated band/);
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
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [NON_REPELLENT_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15',
      products: [{ productId: 'p1', name: 'Taurus SC' }],
      knex,
    });
    expect(contextText).not.toMatch(/EXPECTATIONS/);
  });
});
