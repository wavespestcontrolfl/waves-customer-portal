/**
 * Word list for general staff dictation (GATE_SERVER_DICTATION).
 * Built only from the server's own records, capped, in priority order:
 * customer > technicians > products > services > terms. Synthetic names only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockCatalog = jest.fn();
jest.mock('../services/pest-recap', () => ({
  resolveEligibility: jest.fn(),
  loadRecapCatalogProducts: (...a) => mockCatalog(...a),
  loadCommonProducts: jest.fn(),
  sheetRecordFor: jest.fn(),
}));

const { buildDictationPrompt, composePrompt, cleanName, PROMPT_MAX_CHARS } = require('../services/dictation-word-list');

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';

// A tiny knex: knex(table) -> chain; where/orderBy keep the chain, first/select/await resolve to the table's data.
function fakeKnex(data, calls = []) {
  return (table) => {
    const state = { table, where: [] };
    calls.push(state);
    const chain = {
      where(cond) { state.where.push(cond); return chain; },
      whereIn() { return chain; },
      orderBy() { return chain; },
      first() { return Promise.resolve(Array.isArray(data[table]) ? data[table][0] : data[table]); },
      select() { return Promise.resolve(data[table] || []); },
    };
    return chain;
  };
}

const baseData = () => ({
  customers: { first_name: 'Testa', last_name: 'Examplesmith' },
  scheduled_services: { customer_id: CUSTOMER_ID },
  technicians: [{ name: 'Alex Samplestaff' }, { name: 'Jordan Fixturehand' }],
  services: [{ name: 'Quarterly Pest Control', short_name: 'Pest' }, { name: 'Lawn Fertilization', short_name: null }],
  product_aliases: [{ product_id: 1, alias_name: 'Synthetic Spray' }],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCatalog.mockResolvedValue([
    { id: 1, name: 'Examplex Concentrate 78 oz', display_name: 'Examplex', category: 'insecticide' },
    { id: 2, name: 'Mop Bucket', display_name: null, category: 'supplies' },
  ]);
});

describe('buildDictationPrompt', () => {
  test('carries the named customer, technicians, products with aliases, services and pest words', async () => {
    const prompt = await buildDictationPrompt({ customerId: CUSTOMER_ID }, fakeKnex(baseData()));
    expect(prompt).toMatch(/Customer on this screen: Testa Examplesmith, Testa, Examplesmith\./);
    expect(prompt).toMatch(/Staff who may be named: Alex Samplestaff, Jordan Fixturehand, Alex, Jordan\./);
    expect(prompt).toContain('Examplex');
    expect(prompt).toContain('Synthetic Spray');
    expect(prompt).toContain('Quarterly Pest Control');
    expect(prompt).toContain('Lawn Fertilization');
    // pest and lawn words the codebase already keeps
    expect(prompt).toContain('WaveGuard');
    expect(prompt).toContain('Roaches');
    expect(prompt).toContain('dollarweed');
    // a product in a category the sheet hides is not a word anyone says
    expect(prompt).not.toContain('Mop Bucket');
    // voice-fill's own idioms stay out
    expect(prompt).not.toContain('same as last time');
  });

  test('a service id names the customer behind that visit', async () => {
    const calls = [];
    const prompt = await buildDictationPrompt({ serviceId: SERVICE_ID }, fakeKnex(baseData(), calls));
    expect(prompt).toContain('Customer on this screen: Testa Examplesmith');
    const visit = calls.find((c) => c.table === 'scheduled_services');
    expect(visit.where).toEqual([{ id: SERVICE_ID }]);
    expect(calls.find((c) => c.table === 'customers').where).toEqual([{ id: CUSTOMER_ID }]);
  });

  test('a context id that is not a UUID is never looked up', async () => {
    const calls = [];
    const prompt = await buildDictationPrompt({ customerId: "1' OR '1'='1", serviceId: 'not-a-uuid' }, fakeKnex(baseData(), calls));
    expect(calls.some((c) => c.table === 'customers' || c.table === 'scheduled_services')).toBe(false);
    expect(prompt).not.toMatch(/Customer on this screen/);
  });

  test('only active technicians are asked for', async () => {
    const calls = [];
    await buildDictationPrompt({}, fakeKnex(baseData(), calls));
    expect(calls.find((c) => c.table === 'technicians').where).toEqual([{ employment_status: 'active' }]);
  });

  test('a failed source drops its section and the rest still build', async () => {
    mockCatalog.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' }));
    const prompt = await buildDictationPrompt({ customerId: CUSTOMER_ID }, fakeKnex(baseData()));
    expect(prompt).not.toMatch(/Products that may be said/);
    expect(prompt).toContain('Alex Samplestaff');
  });

  test('stays under the cap with a huge catalog, and the higher-priority sections survive', async () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ id: 1000 + i, name: `Syntheticide Formula ${i}`, display_name: `Syntheticide ${i}`, category: 'insecticide' }));
    mockCatalog.mockResolvedValue(big);
    const data = baseData();
    data.technicians = Array.from({ length: 60 }, (_, i) => ({ name: `Staffer${i} Lastname${i}` }));
    data.services = Array.from({ length: 80 }, (_, i) => ({ name: `Synthetic Service Plan ${i}`, short_name: null }));
    const prompt = await buildDictationPrompt({ customerId: CUSTOMER_ID }, fakeKnex(data));
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(prompt).toContain('Customer on this screen: Testa Examplesmith');
    expect(prompt).toContain('Staffer0 Lastname0');
    expect(prompt).toContain('Syntheticide 0');
    expect(prompt).toContain('Synthetic Service Plan 0');
    // sections come out in priority order
    const order = ['Customer on this screen', 'Staff who may be named', 'Products that may be said', 'Services that may be said'].map((l) => prompt.indexOf(l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('composePrompt', () => {
  test('an earlier section is never cut for a later one when the budget is tight', () => {
    const prompt = composePrompt([
      { key: 'customer', label: 'Customer: ', names: ['Testa Examplesmith'] },
      { key: 'products', label: 'Products: ', names: Array.from({ length: 500 }, (_, i) => `Product${i}`) },
      { key: 'terms', label: 'Terms: ', names: ['lanai'] },
    ]);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(prompt).toContain('Customer: Testa Examplesmith.');
    expect(prompt).toContain('Terms: lanai.');
  });

  test('never cuts a name in half', () => {
    const prompt = composePrompt([{ key: 'products', label: 'Products: ', names: Array.from({ length: 300 }, (_, i) => `Product${i}`) }]);
    const list = prompt.split('Products: ')[1].replace(/\.$/, '').split(', ');
    for (const name of list) expect(name).toMatch(/^Product\d+$/);
  });
});

describe('cleanName', () => {
  test('strips list breakers, control characters and over-long text', () => {
    expect(cleanName('Ignore this,\nand "do" <that>')).toBe('Ignore this and do that');
    expect(cleanName('x'.repeat(200)).length).toBe(60);
    expect(cleanName(null)).toBe('');
  });
});
