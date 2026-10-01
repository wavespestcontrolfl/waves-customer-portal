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

// scheduledServices/serviceRecords rows are pre-resolved fixtures — this
// stub never evaluates the real COALESCE/divergence SQL (that lives in
// stamped-address.js + its own SQL-mirror tests), it just proves
// report-copy-context.js's plumbing reads coordinates FROM these tables
// (keyed by the visit) rather than from the customer's primary row.
function makeKnexStub({
  customers = [], catalogProducts = [], scheduledServices = [], serviceRecords = [],
  serviceFindings = [], propertyPreferences = [],
} = {}) {
  const stub = (table) => {
    const chain = { _whereIns: [], _wheres: [] };
    for (const method of ['whereNull', 'whereNot', 'andWhere', 'orWhere', 'orWhereNot', 'orderBy', 'orderByRaw', 'limit', 'select', 'join', 'leftJoin', 'groupBy', 'count', 'whereRaw', 'whereBetween', 'modify']) {
      chain[method] = () => chain;
    }
    chain.whereIn = (column, values) => { chain._whereIns.push([column, values]); return chain; };
    chain.where = (...args) => {
      if (typeof args[0] === 'function') { args[0].call(chain); return chain; }
      if (args[0] && typeof args[0] === 'object') {
        chain._wheres.push(...Object.entries(args[0]));
      } else {
        chain._wheres.push([args[0], args[1]]);
      }
      return chain;
    };
    const byWheres = (rows) => chain._wheres.reduce((filtered, [column, value]) => (
      filtered.filter((row) => row[String(column).split('.').pop()] === value)
    ), rows);
    const resolveRows = () => {
      if (table === 'customers') return customers;
      if (table === 'products_catalog') {
        return chain._whereIns.reduce((rows, [column, values]) => (
          rows.filter((row) => values.includes(row[column]))
        ), catalogProducts);
      }
      if (table === 'scheduled_services as ss') return byWheres(scheduledServices);
      if (table === 'service_records') return byWheres(serviceRecords);
      if (table === 'service_findings') {
        return chain._whereIns.reduce((rows, [column, values]) => (
          rows.filter((row) => values.includes(row[column]))
        ), serviceFindings);
      }
      if (table === 'property_preferences') return byWheres(propertyPreferences);
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
    expect(contextText).toMatch(/-based non-repellent/);
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
    expect(contextText).not.toMatch(/-based non-repellent/);
  });

  it('never grounds rain or ants lines, even with a real rain reading and a geocode (codex P1 round 4: the window is still open at generation time)', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    mockFetchServiceWeekWeather.mockResolvedValue({ rainInches: 0.6, rainConfidence: null, et0Inches: null, dailyRain: null, rainSource: null, windowClosed: false });
    const knex = makeKnexStub({ customers: [GEOCODED_CUSTOMER], catalogProducts: [NON_REPELLENT_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c2',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15',
      products: [{ productId: 'p1', name: 'Taurus SC' }],
      knex,
    });
    const expectations = contextText.split('EXPECTATIONS')[1] || '';
    expect(expectations).not.toMatch(/rained about/);
    expect(expectations).not.toMatch(/Rain gauges/);
    expect(expectations).not.toMatch(/Heavy rain pushes ants indoors/);
    expect(expectations).not.toMatch(/treated band/);
    // the deterministic product-class line still grounds the writer
    expect(expectations).toMatch(/-based non-repellent/);
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

  it('the pest grounding never calls the week-weather provider for the visit (no serviced-parcel lookup, no pin read) — rain is a render-time card only', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    mockFetchServiceWeekWeather.mockClear();
    const knex = makeKnexStub({
      customers: [GEOCODED_CUSTOMER],
      catalogProducts: [],
      scheduledServices: [{ id: 'ss-alt', lat: 26.1, lng: -81.4 }],
    });
    await buildReportCopyContext({
      customerId: 'c2',
      scheduledServiceId: 'ss-alt',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15',
      products: [],
      knex,
    });
    // The general WEATHER section may still read the customer's primary
    // coordinates (pre-existing, out of scope); the visit's parcel is never
    // looked up for expectations grounding.
    const visitCalls = mockFetchServiceWeekWeather.mock.calls.filter(([args]) => args?.latitude === 26.1);
    expect(visitCalls).toHaveLength(0);
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

// GATE_REPORT_WRITER_RULES: the route passes writerRules only for writers in
// its scope (never lawn or tree/shrub/palm).
describe('buildReportCopyContext — writer rules', () => {
  const ORIGINAL = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  afterEach(() => { process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL; });

  const knexFor = () => makeKnexStub({
    customers: [CUSTOMER],
    catalogProducts: [{ ...NON_REPELLENT_PRODUCT, rei_hours: 0.5 }],
    serviceRecords: [
      { id: 'sr-1', customer_id: 'c1', status: 'completed', service_line: 'pest', service_date: '2026-04-15', service_type: 'Pest Control Service' },
    ],
    serviceFindings: [
      { service_record_id: 'sr-1', category: 'no_activity', severity: 'info', title: 'No activity observed this visit' },
    ],
    propertyPreferences: [{ customer_id: 'c1', pet_count: 2, chemical_sensitivities: null }],
  });
  const args = (knex, writerRules) => ({
    customerId: 'c1',
    serviceType: 'Pest Control Service',
    serviceLine: 'pest',
    serviceDate: '2026-07-15',
    products: [{
      productId: 'p1', name: 'Taurus SC', applicationMethod: 'perimeter_spray', applicationArea: 'Exterior perimeter', areaValue: '120', areaUnit: 'linear_ft',
    }],
    writerRules,
    knex,
  });

  it('drops footage, product safety, household notes and the automatic no-activity finding; gives the approved wording', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const { contextText, writerAllowedPhrases } = await buildReportCopyContext(args(knexFor(), true));
    expect(contextText).toMatch(/APPLICATION DETAILS/);
    expect(contextText).toContain('selected area: Exterior perimeter');
    expect(contextText).not.toContain('treated area entered');
    expect(contextText).not.toContain('PRODUCT SAFETY');
    expect(contextText).not.toContain('Taurus');
    expect(contextText).not.toContain('Fipronil');
    expect(contextText).not.toContain('HOUSEHOLD NOTES');
    expect(contextText).not.toContain('No activity observed this visit');
    expect(contextText).toContain('PRIOR VISITS: this is an established customer');
    expect(contextText).toContain('EXPECTATIONS (approved wording on what the customer may see');
    expect(contextText).toMatch(/We applied a non-repellent.*over the next couple of weeks/);
    // This fixture's EPA number matches no approved product wording, so no
    // HOW IT WORKS line: unmatched products fail closed.
    expect(contextText).not.toContain('HOW IT WORKS');
    expect(writerAllowedPhrases.some((phrase) => /days$/.test(phrase))).toBe(true);
  });

  it('gives the writer the approved wording even while the expectations card is off', async () => {
    delete process.env.GATE_PEST_REPORT_EXPECTATIONS;
    const { contextText } = await buildReportCopyContext(args(knexFor(), true));
    expect(contextText).toContain('EXPECTATIONS (approved wording on what the customer may see');
    expect(contextText).not.toContain('EXPECTATIONS (honest, deterministic facts');
  });

  it('keeps every block exactly as before without the rules', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    const { contextText } = await buildReportCopyContext(args(knexFor(), false));
    expect(contextText).toContain('treated area entered: 120 linear_ft');
    expect(contextText).toContain('PRODUCT SAFETY / RE-ENTRY');
    expect(contextText).toContain('HOUSEHOLD NOTES: pets on site: 2');
    expect(contextText).toContain('No activity observed this visit');
    expect(contextText).toContain('EXPECTATIONS (honest, deterministic facts');
  });
});

describe('buildReportCopyContext — writer rules: name-only products', () => {
  test('a name-only product beside an id-backed one still grounds the writer', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], catalogProducts: [NON_REPELLENT_PRODUCT, ROACH_GEL_PRODUCT] });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Pest Control Service',
      serviceLine: 'pest',
      serviceDate: '2026-07-15',
      products: [
        { productId: 'p1', name: 'Taurus SC', applicationMethod: 'perimeter_spray', applicationArea: 'Exterior perimeter' },
        { productId: null, name: 'Advion Cockroach Gel Bait', applicationMethod: 'bait_placement', applicationArea: 'Kitchen' },
      ],
      writerRules: true,
      knex,
    });
    expect(contextText).toContain('We placed a gel bait as crack-and-crevice placements');
  });
});
