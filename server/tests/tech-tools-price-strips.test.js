/**
 * Technician visibility audit (pack 2a, price strips) - the Intelligence Bar
 * tech tools for a TECHNICIAN login:
 *  - B4  get_protocol returns no owner-only job costs and no priced lines
 *  - B9  check_customer_status / get_stop_details return no CRM notes, health
 *        score, churn risk or balance (the customer page gives a technician none)
 *  - B20 get_my_route applies the 7-day window and the dead-status list
 *  - B3  search_knowledge_base reads field categories only, with vendor price
 *        lines and dollar tokens removed
 * The owner reading the tech rail (techRole 'admin') and an admin workflow with
 * an empty context keep every field.
 */

const state = { customers: [], scheduled_services: [], property_preferences: [], service_records: [], invoices: [], customer_health_scores: [], knowledge_base: [] };
const mockUnifiedSearch = jest.fn();

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/knowledge-bridge', () => ({ unifiedSearch: (...args) => mockUnifiedSearch(...args) }));
jest.mock('../services/previsit-brief', () => ({
  visitFactsGateEnabled: () => false,
  deterministicVisitFacts: jest.fn(),
}));
jest.mock('../services/visit-context/balance', () => ({
  openInvoiceFacts: jest.fn(async () => ({ balance: 240, count: 1, overdue: false })),
}));
jest.mock('../models/db', () => {
  function query(table) {
    const preds = [];
    const log = [];
    const api = {
      __log: log,
      where(a, op, val) {
        if (typeof a === 'function') return api;
        if (typeof a === 'object') {
          Object.entries(a).forEach(([k, v]) => preds.push((r) => r[k.replace(/^.*\./, '')] === v));
        } else if (val === undefined) {
          preds.push((r) => r[a.replace(/^.*\./, '')] === op);
        } else if (op === '>=') {
          preds.push((r) => r[a.replace(/^.*\./, '')] >= val);
        } else {
          preds.push((r) => r[a.replace(/^.*\./, '')] === val);
        }
        log.push(['where', a, op, val]);
        return api;
      },
      whereNotIn(col, arr) { preds.push((r) => !arr.includes(r[col.replace(/^.*\./, '')])); log.push(['whereNotIn', col, arr]); return api; },
      whereIn(col, arr) { preds.push((r) => arr.includes(r[col.replace(/^.*\./, '')])); return api; },
      whereNull() { return api; },
      whereILike() { return api; },
      whereRaw() { return api; },
      orderBy() { return api; },
      orderByRaw() { return api; },
      distinct() { return api; },
      limit() { return api; },
      leftJoin() { return api; },
      select() { return api; },
      first() {
        const match = (state[table] || []).find((r) => preds.every((p) => p(r)));
        return Promise.resolve(match ? { ...match } : undefined);
      },
      then(resolve) {
        return Promise.resolve((state[table] || []).filter((r) => preds.every((p) => p(r)))).then(resolve);
      },
    };
    return api;
  }
  const db = (table) => query(table);
  db.raw = (sql) => ({ __raw: sql });
  return db;
});

const { etDateString, addETDays } = require('../utils/datetime-et');
const { executeTechTool } = require('../services/intelligence-bar/tech-tools');

const today = () => etDateString(new Date());
const daysAgo = (n) => etDateString(addETDays(new Date(), -n));

const TECHNICIAN = { techId: 'tech-1', techName: 'Pat Example', techRole: 'technician' };
const OWNER_ON_TECH_RAIL = { techId: 'tech-1', techName: 'Pat Example', techRole: 'admin' };

beforeEach(() => {
  jest.clearAllMocks();
  state.customers = [{
    id: 'cust-mine', first_name: 'Test', last_name: 'Caller', phone: '555-0101',
    waveguard_tier: 'Gold', active: true, crm_notes: 'Second contact named on a call',
  }];
  state.scheduled_services = [
    { id: 'svc-today', customer_id: 'cust-mine', technician_id: 'tech-1', status: 'scheduled', scheduled_date: today() },
  ];
  state.property_preferences = [{ customer_id: 'cust-mine' }];
  state.service_records = [];
  state.customer_health_scores = [{ customer_id: 'cust-mine', overall_score: 41, churn_risk: 'high' }];
  mockUnifiedSearch.mockResolvedValue({ claudeopedia: [], wiki: [] });
});

describe('B4 get_protocol', () => {
  const json = (r) => JSON.stringify(r);

  test('a technician gets no owner-only job costs and no priced lines', async () => {
    const r = await executeTechTool('get_protocol', { service_type: 'tree_shrub' }, TECHNICIAN);
    expect(r.type).toBe('tree_shrub');
    expect(json(r)).not.toContain('costing_assumptions');
    expect(json(r)).not.toMatch(/\$\d/);
    expect(Array.isArray(r.protocol.visits) || Object.keys(r.protocol).length > 0).toBe(true);
  });

  test('a technician gets no per-visit lawn cost keys', async () => {
    const r = await executeTechTool('get_protocol', { service_type: 'lawn', lawn_track: 'A' }, TECHNICIAN);
    expect(json(r)).not.toMatch(/"(material_cost|labor_cost|conditional_cost)"/);
    expect(json(r)).not.toMatch(/\$\d/);
  });

  test.each([
    ['the owner on the tech rail', OWNER_ON_TECH_RAIL],
    ['an admin workflow with no tech context', {}],
  ])('%s still gets the full protocol', async (_label, context) => {
    const r = await executeTechTool('get_protocol', { service_type: 'tree_shrub' }, context);
    expect(json(r)).toContain('costing_assumptions');
    expect(json(r)).toMatch(/\(\$\d/);
  });
});

describe('B9 customer status and stop details', () => {
  test('a technician gets no CRM notes, health score, churn risk or balance from check_customer_status', async () => {
    const r = await executeTechTool('check_customer_status', { customer_id: 'cust-mine' }, TECHNICIAN);
    expect(r.name).toBe('Test Caller');
    expect(r.tier).toBe('Gold');
    expect(r).not.toHaveProperty('notes');
    expect(r).not.toHaveProperty('health_score');
    expect(r).not.toHaveProperty('churn_risk');
    expect(r).not.toHaveProperty('balance_owed');
  });

  test('an admin still gets every check_customer_status field', async () => {
    const r = await executeTechTool('check_customer_status', { customer_id: 'cust-mine' }, OWNER_ON_TECH_RAIL);
    expect(r).toMatchObject({ notes: 'Second contact named on a call', health_score: 41, churn_risk: 'high', balance_owed: 240 });
  });

  test('a technician gets no CRM notes from get_stop_details; an admin still does', async () => {
    const tech = await executeTechTool('get_stop_details', { customer_id: 'cust-mine' }, TECHNICIAN);
    expect(tech.customer.name).toBe('Test Caller');
    expect(tech.customer).not.toHaveProperty('notes');
    const owner = await executeTechTool('get_stop_details', { customer_id: 'cust-mine' }, OWNER_ON_TECH_RAIL);
    expect(owner.customer.notes).toBe('Second contact named on a call');
  });
});

describe('B20 get_my_route window', () => {
  beforeEach(() => {
    state.customers = [{ id: 'c1', first_name: 'Test', last_name: 'Caller' }];
    state.scheduled_services = [
      { id: 's-live', customer_id: 'c1', technician_id: 'tech-1', status: 'scheduled', scheduled_date: today() },
      { id: 's-resched', customer_id: 'c1', technician_id: 'tech-1', status: 'rescheduled', scheduled_date: today() },
      { id: 's-skipped', customer_id: 'c1', technician_id: 'tech-1', status: 'skipped', scheduled_date: today() },
    ];
  });

  test('a technician gets no rescheduled, skipped or no-show rows', async () => {
    const r = await executeTechTool('get_my_route', {}, TECHNICIAN);
    expect(r.stops.map((s) => s.id)).toEqual(['s-live']);
  });

  test('a technician asking for a day older than the access window gets no stops', async () => {
    state.scheduled_services = [
      { id: 's-old', customer_id: 'c1', technician_id: 'tech-1', status: 'completed', scheduled_date: daysAgo(30) },
    ];
    const r = await executeTechTool('get_my_route', { date: daysAgo(30) }, TECHNICIAN);
    expect(r.stops).toEqual([]);
  });

  test('an admin on the tech rail still gets every row for a day', async () => {
    const r = await executeTechTool('get_my_route', {}, OWNER_ON_TECH_RAIL);
    expect(r.stops.map((s) => s.id).sort()).toEqual(['s-live', 's-resched', 's-skipped']);
  });
});

describe('B3 search_knowledge_base', () => {
  const kbHit = [{ id: 1, title: 'Sample Herbicide', category: 'chemicals' }];

  beforeEach(() => {
    mockUnifiedSearch.mockResolvedValue({ claudeopedia: kbHit, wiki: [] });
    state.knowledge_base = [{ id: 1, content: '**Sample Herbicide**\nBest Price: $139.50 (Test Vendor)\nSignal Word: Caution\nCost note ($4.20 per gal)' }];
  });

  test('a technician search is limited to field categories and returns no vendor price', async () => {
    const r = await executeTechTool('search_knowledge_base', { query: 'herbicide' }, TECHNICIAN);
    const options = mockUnifiedSearch.mock.calls[0][1];
    expect(options.kbCategories).toEqual(expect.arrayContaining(['protocols', 'chemicals']));
    expect(options.kbCategories).not.toEqual(expect.arrayContaining(['pricing']));
    expect(options.kbCategories).not.toContain('techs');
    const snippet = r.results[0].snippet;
    expect(snippet).toContain('Signal Word: Caution');
    expect(snippet).not.toMatch(/Best Price|Test Vendor|\$/);
  });

  test('an admin workflow search passes no category limit and keeps the page as stored', async () => {
    const r = await executeTechTool('search_knowledge_base', { query: 'herbicide' }, {});
    expect(mockUnifiedSearch.mock.calls[0][1]).not.toHaveProperty('kbCategories');
    expect(r.results[0].snippet).toContain('Best Price: $139.50');
  });
});
