// Lawn result timing in the AI report writer's grounding (lawn report rebuild
// P15, rides GATE_LAWN_REPORT_COPY_V6): the only timing the writer may use is
// an owner-approved expectation sentence, quoted word for word; none approved
// means no timing at all. Gate off = no lawn EXPECTATIONS section (unchanged).
// Synthetic customer data; real catalog product names (the rows are keyed by
// exact catalog name).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/service-report/application-conditions', () => ({
  ...jest.requireActual('../services/service-report/application-conditions'),
  fetchServiceWeekWeather: jest.fn().mockResolvedValue({ rainInches: null, et0Inches: null, dailyRain: null, rainConfidence: null, rainSource: null, windowClosed: true }),
}));

const { buildReportCopyContext } = require('../services/service-report/report-copy-context');
const { approvedExpectationSentences } = require('../services/service-report/lawn-copy-v6');

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

const CUSTOMER = { id: 'c1', first_name: 'Test', last_name: 'Customer', city: 'Bradenton', state: 'FL', latitude: null, longitude: null };
const HERBICIDE = {
  id: 'p1', name: 'Celsius WG', category: 'herbicide', product_type: 'herbicide',
  active_ingredient: 'Thiencarbazone', epa_reg_number: '432-1507', approved_for_service_report: true, moa_group: null, rainfast_minutes: null,
};
const UNMAPPED = { ...HERBICIDE, id: 'p9', name: 'Test Product Not In The Table' };

const ENV = ['GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
const saved = {};
beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
const live = () => { process.env.GATE_LAWN_REPORT_COPY_V6 = 'true'; process.env.GATE_LAWN_REPORT_LEAD = 'true'; };

const contextFor = (product) => buildReportCopyContext({
  customerId: 'c1',
  serviceType: 'Lawn Care Treatment Program',
  serviceLine: 'lawn',
  serviceDate: '2026-07-15',
  products: [{ productId: product.id, name: product.name }],
  knex: makeKnexStub({ customers: [CUSTOMER], catalogProducts: [product] }),
}).then((r) => r.contextText);

describe('buildReportCopyContext — lawn EXPECTATIONS (P15)', () => {
  it('gate live: the approved sentence for today\'s product, word for word, as the only timing source', async () => {
    live();
    const text = await contextFor(HERBICIDE);
    const [sentence] = approvedExpectationSentences([{ name: 'Celsius WG' }], { visitDate: '2026-07-15' }).sentences;
    expect(sentence).toBeTruthy();
    expect(text).toMatch(/EXPECTATIONS \(owner-approved wording/);
    expect(text).toContain(`- ${sentence}`);
    expect(text).toMatch(/Quote a sentence word for word or say nothing about timing/);
  });

  it('gate live, no approved row for the product: the writer is told to give no timing at all', async () => {
    live();
    const text = await contextFor(UNMAPPED);
    expect(text).toMatch(/EXPECTATIONS: none approved for today's products/);
  });

  it('gate off (or lead off): no lawn EXPECTATIONS section, as before', async () => {
    expect(await contextFor(HERBICIDE)).not.toMatch(/EXPECTATIONS/);
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    expect(await contextFor(HERBICIDE)).not.toMatch(/EXPECTATIONS/);
  });
});
