/**
 * GATE_DICTATION_CUSTOMER_NAMES: the staff mic word list also carries customer names.
 * Gate off (buildDictationPrompt) is byte-identical to before; gate on (buildDictationHints)
 * puts the on-screen customer first, then today's/tomorrow's route, then (admin only) people
 * who texted or called and recently updated active customers; stays under 1800 characters;
 * a technician login sees only its own stops; the list is cached 5 minutes per scope and day;
 * surnames come back as transcriber keywords. Synthetic names only.
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

const {
  buildDictationPrompt, buildDictationHints, resetNameCache, PROMPT_MAX_CHARS, NAMES_SECTION_CAPS, KEYWORD_MAX,
} = require('../services/dictation-word-list');
const { mergeTranscriptionKeywords, transcriptionKeywords } = require('../services/call-recording-processor')._test;
const featureGates = require('../config/feature-gates');

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

// A tiny knex that records each chain. Reads end at first() / select().
const P = (first, last) => ({ first_name: first, last_name: last });
function makeKnex({ onScreen = P('Testa', 'Examplesmith'), visits = [P('Route', 'Todayman'), P('Second', 'Stopper')], contacts = [P('Texta', 'Callerson')], recent = [P('Recenta', 'Updatedson')], calls = [] } = {}) {
  return (table) => {
    const state = { table, where: [], whereIn: [], limit: null };
    calls.push(state);
    const rows = () => {
      if (table === 'scheduled_services') return visits;
      if (table === 'conversations as cv') return contacts;
      if (table === 'customers') return recent;
      if (table === 'technicians') return [{ name: 'Alex Samplestaff' }];
      if (table === 'services') return [{ name: 'Quarterly Pest Control', short_name: 'Pest' }];
      return [];
    };
    const chain = {
      where(cond, ...rest) { state.where.push(rest.length ? [cond, ...rest] : cond); return chain; },
      whereIn(col, vals) { state.whereIn.push([col, vals]); return chain; },
      whereNull() { return chain; },
      whereBetween(col, range) { state.between = [col, range]; return chain; },
      join() { state.joined = true; return chain; },
      orderBy() { return chain; },
      limit(n) { state.limit = n; return chain; },
      first() {
        if (table === 'customers') return Promise.resolve(onScreen);
        return Promise.resolve(rows()[0]);
      },
      select() { return Promise.resolve(rows()); },
    };
    return chain;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetNameCache();
  mockCatalog.mockResolvedValue([
    { id: 1, name: 'Examplex Concentrate 78 oz', display_name: 'Examplex', category: 'insecticide' },
    { id: 2, name: 'Mop Bucket', display_name: null, category: 'supplies' },
  ]);
});

describe('gate reader', () => {
  const original = process.env.GATE_DICTATION_CUSTOMER_NAMES;
  afterAll(() => {
    if (original === undefined) delete process.env.GATE_DICTATION_CUSTOMER_NAMES;
    else process.env.GATE_DICTATION_CUSTOMER_NAMES = original;
  });
  test('dark unless exactly "true"', () => {
    delete process.env.GATE_DICTATION_CUSTOMER_NAMES;
    expect(featureGates.dictationCustomerNamesLive()).toBe(false);
    process.env.GATE_DICTATION_CUSTOMER_NAMES = '1';
    expect(featureGates.dictationCustomerNamesLive()).toBe(false);
    process.env.GATE_DICTATION_CUSTOMER_NAMES = 'true';
    expect(featureGates.dictationCustomerNamesLive()).toBe(true);
  });
});

describe('gate off: buildDictationPrompt is byte-identical to before', () => {
  test('no customer-name section and no name query is made', async () => {
    const calls = [];
    const knex = makeKnex({ calls });
    const prompt = await buildDictationPrompt({ customerId: CUSTOMER_ID }, knex);
    expect(prompt).toContain('Customer on this screen: Testa Examplesmith, Testa, Examplesmith.');
    expect(prompt).not.toMatch(/Customers who may be named/);
    expect(calls.some((c) => c.table === 'conversations as cv')).toBe(false);
  });

  test('golden: exact text from origin/main for fixed synthetic records', async () => {
    const data = {
      customers: { first_name: 'Testa', last_name: 'Examplesmith' },
      technicians: [{ name: 'Alex Samplestaff' }, { name: 'Jordan Fixturehand' }],
      services: [{ name: 'Quarterly Pest Control', short_name: 'Pest' }, { name: 'Lawn Fertilization', short_name: null }],
      product_aliases: [{ product_id: 1, alias_name: 'Synthetic Spray' }],
    };
    const knex = (table) => {
      const c = {
        where: () => c, whereIn: () => c, orderBy: () => c,
        first: () => Promise.resolve(Array.isArray(data[table]) ? data[table][0] : data[table]),
        select: () => Promise.resolve(data[table] || []),
      };
      return c;
    };
    const prompt = await buildDictationPrompt({ customerId: CUSTOMER_ID }, knex);
    expect(prompt).toBe("Dictated by Waves Pest Control staff (pest control and lawn care, Southwest Florida). Customer on this screen: Testa Examplesmith, Testa, Examplesmith. Staff who may be named: Alex Samplestaff, Jordan Fixturehand, Alex, Jordan. Products that may be said: Examplex, Synthetic Spray. Services that may be said: Quarterly Pest Control, Pest, Lawn Fertilization. Other words that may be said: Ants, Roaches, Spiders, Silverfish, Wasps, Earwigs, Fleas, Crickets, Centipedes, perimeter, foundation, spot treatment, bait placement, granules, lanai, linear feet, re-service, broadcast, granular, spreader, soil drench, foliar, pounds, ounces, gallons, per thousand, square feet, front lawn, back lawn, side lawns, weeds, dollarweed, sedge, crabgrass, chinch bugs, sod webworms, fungus, fertilizer, pre-emergent, Waves Pest Control, WaveGuard.");
  });
});

describe('gate on: buildDictationHints', () => {
  test('on-screen customer first, then the route, then texters and recent customers, full names', async () => {
    const { prompt } = await buildDictationHints({ customerId: CUSTOMER_ID, scope: {} }, makeKnex());
    const section = prompt.match(/Customers who may be named: ([^.]*)\./)[1];
    expect(section.split(', ')).toEqual([
      'Testa Examplesmith', 'Route Todayman', 'Second Stopper', 'Texta Callerson', 'Recenta Updatedson',
    ]);
    // the customer section comes first, the names right after it, staff after that
    const order = ['Customer on this screen', 'Customers who may be named', 'Staff who may be named', 'Products that may be said']
      .map((label) => prompt.indexOf(label));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the visit read asks for today and tomorrow in ET, live statuses, and nothing else', async () => {
    const calls = [];
    await buildDictationHints({ scope: {} }, makeKnex({ calls }));
    const visit = calls.find((c) => c.table === 'scheduled_services');
    expect(visit.whereIn).toContainEqual(['scheduled_services.status', ['pending', 'confirmed', 'en_route', 'on_site']]);
    const [col, [from, to]] = visit.between;
    expect(col).toBe('scheduled_services.scheduled_date');
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const days = (new Date(to) - new Date(from)) / 86400000;
    expect(days).toBe(1);
  });

  test('a name with no on-screen customer still lists the route', async () => {
    const { prompt, keywords } = await buildDictationHints({ scope: {} }, makeKnex({ onScreen: undefined }));
    expect(prompt).toMatch(/Customers who may be named: Route Todayman, Second Stopper/);
    expect(prompt).not.toMatch(/Customer on this screen/);
    expect(keywords[0]).toBe('Todayman');
  });

  test('products shrink to 400 characters and the prompt stays under the cap with a huge world', async () => {
    mockCatalog.mockResolvedValue(Array.from({ length: 400 }, (_, i) => ({ id: 1000 + i, name: `Syntheticide Formula ${i}`, display_name: `Syntheticide ${i}`, category: 'insecticide' })));
    const many = (n, tag) => Array.from({ length: n }, (_, i) => P(`${tag}First${i}`, `${tag}Last${i}`));
    const { prompt, keywords } = await buildDictationHints(
      { customerId: CUSTOMER_ID, scope: {} },
      makeKnex({ visits: many(40, 'V'), contacts: many(30, 'C'), recent: many(40, 'R') }),
    );
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    const list = (label) => (prompt.match(new RegExp(`${label}: ([^.]*)\\.`)) || [])[1] || '';
    expect(list('Customers who may be named').length).toBeLessThanOrEqual(NAMES_SECTION_CAPS.customers);
    expect(list('Products that may be said').length).toBeLessThanOrEqual(NAMES_SECTION_CAPS.products);
    expect(NAMES_SECTION_CAPS.products).toBe(400);
    // technicians and services survive; names never cut in half
    expect(prompt).toContain('Alex Samplestaff');
    expect(prompt).toContain('Quarterly Pest Control');
    for (const name of list('Customers who may be named').split(', ')) expect(name).toMatch(/^(Testa Examplesmith|[VCR]First\d+ [VCR]Last\d+)$/);
    // the keywords are surnames of names that fit, on-screen first, capped
    expect(keywords[0]).toBe('Examplesmith');
    expect(keywords.length).toBeLessThanOrEqual(KEYWORD_MAX);
    expect(keywords.every((word) => prompt.includes(word))).toBe(true);
  });

  test('keywords: surnames in prompt order, on-screen first, de-duplicated', async () => {
    const dup = [P('Route', 'Todayman'), P('Another', 'Todayman')];
    const { keywords } = await buildDictationHints({ customerId: CUSTOMER_ID, scope: {} }, makeKnex({ visits: dup }));
    expect(keywords).toEqual(['Examplesmith', 'Todayman', 'Callerson', 'Updatedson']);
  });

  test('technician fence: only its own stops, no texting or recent-customer reads', async () => {
    const calls = [];
    const { prompt, keywords } = await buildDictationHints({ customerId: CUSTOMER_ID, scope: { technicianId: 'tech-1' } }, makeKnex({ calls }));
    const visit = calls.find((c) => c.table === 'scheduled_services');
    expect(visit.where).toContainEqual(['scheduled_services.technician_id', 'tech-1']);
    expect(calls.some((c) => c.table === 'conversations as cv')).toBe(false);
    // the only customers read are the on-screen row (by id, already fenced by the route)
    const customerReads = calls.filter((c) => c.table === 'customers');
    expect(customerReads.every((c) => c.where.some((w) => w && w.id === CUSTOMER_ID))).toBe(true);
    expect(prompt).toMatch(/Customers who may be named: Testa Examplesmith, Route Todayman, Second Stopper\./);
    expect(prompt).not.toContain('Callerson');
    expect(prompt).not.toContain('Updatedson');
    expect(keywords).toEqual(['Examplesmith', 'Todayman', 'Stopper']);
  });

  test('cached 5 minutes per login scope: a second clip does not re-query, another scope does', async () => {
    const calls = [];
    const knex = makeKnex({ calls });
    await buildDictationHints({ scope: {} }, knex);
    const firstVisitReads = calls.filter((c) => c.table === 'scheduled_services').length;
    await buildDictationHints({ scope: {} }, knex);
    expect(calls.filter((c) => c.table === 'scheduled_services').length).toBe(firstVisitReads);
    await buildDictationHints({ scope: { technicianId: 'tech-1' } }, knex);
    expect(calls.filter((c) => c.table === 'scheduled_services').length).toBe(firstVisitReads + 1);
    await buildDictationHints({ scope: { technicianId: 'tech-1' } }, knex);
    expect(calls.filter((c) => c.table === 'scheduled_services').length).toBe(firstVisitReads + 1);
  });

  test('the cache expires after 5 minutes', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-10-20T15:00:00Z'));
      const calls = [];
      const knex = makeKnex({ calls });
      await buildDictationHints({ scope: {} }, knex);
      const n = calls.filter((c) => c.table === 'conversations as cv').length;
      jest.setSystemTime(new Date('2026-10-20T15:04:00Z'));
      await buildDictationHints({ scope: {} }, knex);
      expect(calls.filter((c) => c.table === 'conversations as cv').length).toBe(n);
      jest.setSystemTime(new Date('2026-10-20T15:06:00Z'));
      await buildDictationHints({ scope: {} }, knex);
      expect(calls.filter((c) => c.table === 'conversations as cv').length).toBe(n + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failed read drops its group; the rest still build', async () => {
    const knex = makeKnex();
    const broken = (table) => (table === 'conversations as cv' ? { join() { throw Object.assign(new Error('boom'), { code: 'XX000' }); } } : knex(table));
    const { prompt } = await buildDictationHints({ customerId: CUSTOMER_ID, scope: {} }, broken);
    expect(prompt).toContain('Route Todayman');
    expect(prompt).not.toContain('Callerson');
  });

  test('a non-UUID context id is never looked up', async () => {
    const calls = [];
    await buildDictationHints({ customerId: "1' OR '1'='1", scope: {} }, makeKnex({ calls }));
    expect(calls.some((c) => c.table === 'scheduled_services' && c.where.some((w) => w && w.id))).toBe(false);
  });
});

describe('mergeTranscriptionKeywords', () => {
  test('keeps the shared hints first, adds extras, de-duplicates and caps', () => {
    const base = transcriptionKeywords();
    const merged = mergeTranscriptionKeywords(base, ['Stumpfy', 'sarasota', 'Stumpfy', '', 'x'.repeat(41), 'Bad\nname']);
    expect(merged.slice(0, base.length)).toEqual(base);
    expect(merged.slice(base.length)).toEqual(['Stumpfy', 'Bad name']);
    const many = mergeTranscriptionKeywords(base, Array.from({ length: 80 }, (_, i) => `Surname${i}`));
    expect(many.length).toBe(base.length + 50);
  });
  test('no extras returns the base list as is', () => {
    const base = ['a', 'b'];
    expect(mergeTranscriptionKeywords(base, undefined)).toEqual(base);
  });
});

describe('transcribeWithOpenAI keywords[] form field', () => {
  const { transcribeWithOpenAI } = require('../services/call-recording-processor');
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let sent;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    sent = null;
    global.fetch = jest.fn(async (_url, init) => {
      sent = init.body;
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ text: 'hello there' }) };
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  });

  test('opts.keywords are appended after the shared hints; without it the list is exactly the shared one', async () => {
    const base = transcriptionKeywords();
    await transcribeWithOpenAI(Buffer.from('x'), { model: 'gpt-transcribe', prompt: 'p' });
    expect(sent.getAll('keywords[]')).toEqual(base);
    await transcribeWithOpenAI(Buffer.from('x'), { model: 'gpt-transcribe', prompt: 'p', keywords: ['Examplesmith'] });
    expect(sent.getAll('keywords[]')).toEqual([...base, 'Examplesmith']);
  });

  test('a model without keyword support never gets the field', async () => {
    await transcribeWithOpenAI(Buffer.from('x'), { model: 'gpt-4o-transcribe', prompt: 'p', keywords: ['Examplesmith'] });
    expect(sent.getAll('keywords[]')).toEqual([]);
  });
});
