/**
 * Voice fill for the Fast Complete report flow (GATE_FAST_COMPLETE_REPORT):
 * where the technician put product down and the pests they named, read from
 * the note they dictated (services/visit-voice-facts.js), and the route the
 * sheet calls (POST /admin/dispatch/:serviceId/voice-facts).
 *
 *  - A fact stands only when the note holds its quote word for word, and a
 *    pest's words sit inside that quote: a spoken "roaches" never comes back
 *    as a species the technician did not say.
 *  - Any failure reads as no facts, never an error.
 *  - Access codes never reach the provider.
 *  - The route is dark with the gate off and reads only the technician's own
 *    current visit.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatchWithFallback: jest.fn(),
}));

const { dispatchWithFallback } = require('../services/llm/call');
const { readVoiceFacts, validateVoiceFacts } = require('../services/visit-voice-facts');
const router = require('../routes/admin-dispatch');

const NOTE = 'Ghost ants on the kitchen counter and the back slider, light. Checked under the dishwasher like I promised, nothing there. '
  + 'Baited the counter edge and the slider track, sprayed around the outside of the house. Told her to keep the counters wiped.';

const answer = (json) => ({ ok: true, json });

afterEach(() => {
  mockDbCurrent = null;
  jest.clearAllMocks();
});

describe('validateVoiceFacts', () => {
  test('keeps grounded areas in the sheet order with its labels, and the pests in the technician\'s words', () => {
    const facts = validateVoiceFacts({
      areas: [
        { area: 'outside', quote: 'sprayed around the outside of the house' },
        { area: 'inside', quote: 'Baited the counter edge' },
      ],
      pests: [{ name: 'ghost ants', quote: 'Ghost ants on the kitchen counter' }],
    }, NOTE);
    expect(facts.areas).toEqual([
      { area: 'Inside', quote: 'baited the counter edge' },
      { area: 'Outside', quote: 'sprayed around the outside of the house' },
    ]);
    expect(facts.pests).toEqual([{ name: 'ghost ants', quote: 'ghost ants on the kitchen counter' }]);
  });

  test('a quote the note does not hold drops the fact', () => {
    const facts = validateVoiceFacts({
      areas: [{ area: 'garage', quote: 'treated the garage' }],
      pests: [{ name: 'spiders', quote: 'spiders in the eaves' }],
    }, NOTE);
    expect(facts).toEqual({ areas: [], pests: [] });
  });

  test('a species the technician did not say never stands', () => {
    const note = 'Saw roaches under the sink. Sprayed under the sink.';
    // The name must sit in its own grounded quote, so an upgraded name with
    // an honest quote is dropped, and so is a quote invented to carry it.
    expect(validateVoiceFacts({ areas: [], pests: [{ name: 'german roaches', quote: 'Saw roaches under the sink' }] }, note).pests).toEqual([]);
    expect(validateVoiceFacts({ areas: [], pests: [{ name: 'german roaches', quote: 'Saw german roaches under the sink' }] }, note).pests).toEqual([]);
    expect(validateVoiceFacts({ areas: [], pests: [{ name: 'roaches', quote: 'Saw roaches under the sink' }] }, note).pests)
      .toEqual([{ name: 'roaches', quote: 'saw roaches under the sink' }]);
  });

  test('a name matches whole words only, and stays short and plain', () => {
    const note = 'Treated for plant bugs and ants along the patio.';
    // "ant" sits inside "plant": not the technician's word.
    expect(validateVoiceFacts({ areas: [], pests: [{ name: 'ant', quote: 'plant bugs' }] }, note).pests).toEqual([]);
    expect(validateVoiceFacts({ areas: [], pests: [{ name: 'ants', quote: 'and ants along the patio' }] }, note).pests)
      .toEqual([{ name: 'ants', quote: 'and ants along the patio' }]);
    expect(validateVoiceFacts({ areas: [], pests: [{ name: 'treated for plant bugs and', quote: 'Treated for plant bugs and ants' }] }, note).pests).toEqual([]);
  });

  test('unknown areas, repeats and quotes under four characters are dropped', () => {
    const note = 'Sprayed the lanai. Sprayed the lanai again. Baited inside.';
    const facts = validateVoiceFacts({
      areas: [
        { area: 'attic', quote: 'Baited inside' },
        { area: 'outside', quote: 'Sprayed the lanai' },
        { area: 'outside', quote: 'Sprayed the lanai again' },
        { area: 'inside', quote: 'in' },
      ],
      pests: [],
    }, note);
    expect(facts.areas).toEqual([{ area: 'Outside', quote: 'sprayed the lanai' }]);
  });

  test('case, curly quotes and spacing never decide a match', () => {
    const note = 'Sprayed   the customer’s  garage door frame.';
    const facts = validateVoiceFacts({ areas: [{ area: 'garage', quote: "SPRAYED the customer's garage" }], pests: [] }, note);
    expect(facts.areas).toEqual([{ area: 'Garage', quote: "sprayed the customer's garage" }]);
  });

  test('a malformed answer is no facts', () => {
    expect(validateVoiceFacts(null, NOTE)).toEqual({ areas: [], pests: [] });
    expect(validateVoiceFacts({ areas: 'inside', pests: {} }, NOTE)).toEqual({ areas: [], pests: [] });
  });
});

describe('readVoiceFacts', () => {
  test('reads the note through the fast structured lane and returns what the sheet records', async () => {
    dispatchWithFallback.mockResolvedValue(answer({
      areas: [{ area: 'inside', quote: 'Baited the counter edge' }, { area: 'outside', quote: 'sprayed around the outside of the house' }],
      pests: [{ name: 'ghost ants', quote: 'Ghost ants on the kitchen counter' }],
    }));
    const facts = await readVoiceFacts(NOTE);
    expect(facts).toMatchObject({ status: 'read', areas: ['Inside', 'Outside'], pests: ['ghost ants'] });
    expect(facts.heard.areas).toHaveLength(2);
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy.name).toBe('fastStructured');
    expect(payload).toMatchObject({ laneId: 'visit_voice_facts', jsonSchema: expect.any(Object) });
    expect(payload.text).toContain('Baited the counter edge');
    expect(options).toEqual({ reserveFallbackBudget: true });
  });

  test('access codes never reach the provider', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ areas: [], pests: [] }));
    await readVoiceFacts('Gate code is 4471. Sprayed around the outside.');
    const sent = dispatchWithFallback.mock.calls[0][1].text;
    expect(sent).not.toContain('4471');
    expect(sent).toContain('Sprayed around the outside.');
  });

  test('an empty note never calls the model', async () => {
    expect(await readVoiceFacts('   ')).toMatchObject({ status: 'empty_note', areas: [], pests: [] });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a failed or throwing call is no facts, never an error', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'openai_timeout' });
    expect(await readVoiceFacts(NOTE)).toMatchObject({ status: 'failed', areas: [], pests: [] });
    dispatchWithFallback.mockRejectedValueOnce(new Error('boom'));
    expect(await readVoiceFacts(NOTE)).toMatchObject({ status: 'failed', areas: [], pests: [] });
  });
});

function invoke(params, body, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/voice-facts' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const TODAY = new Date().toISOString().slice(0, 10);
const SERVICE = { id: 'svc-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY };

function serviceDb(service, calls) {
  return (table) => {
    calls.push(table);
    const chain = {};
    chain.where = () => chain;
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    return chain;
  };
}

describe('POST /:serviceId/voice-facts', () => {
  const ORIGINAL_GATE = process.env.GATE_FAST_COMPLETE_REPORT;
  afterEach(() => {
    if (ORIGINAL_GATE === undefined) delete process.env.GATE_FAST_COMPLETE_REPORT;
    else process.env.GATE_FAST_COMPLETE_REPORT = ORIGINAL_GATE;
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: 404 with no database read and no model call', async (value) => {
    if (value === undefined) delete process.env.GATE_FAST_COMPLETE_REPORT; else process.env.GATE_FAST_COMPLETE_REPORT = value;
    const calls = [];
    mockDbCurrent = serviceDb(SERVICE, calls);
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a note that is not text is a 400', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    const res = await invoke({ serviceId: 'svc-1' }, { note: { text: NOTE } });
    expect(res.statusCode).toBe(400);
  });

  test('an unknown visit is a 404', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    mockDbCurrent = serviceDb(null, []);
    const res = await invoke({ serviceId: 'svc-x' }, { note: NOTE });
    expect(res.statusCode).toBe(404);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a technician reads only their own current visit', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    const other = await invoke({ serviceId: 'svc-1' }, { note: NOTE }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(other.statusCode).toBe(403);
    mockDbCurrent = serviceDb({ ...SERVICE, status: 'cancelled' }, []);
    const cancelled = await invoke({ serviceId: 'svc-1' }, { note: NOTE }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(cancelled.statusCode).toBe(403);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the assigned technician gets the facts heard', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    dispatchWithFallback.mockResolvedValue(answer({
      areas: [{ area: 'outside', quote: 'sprayed around the outside of the house' }],
      pests: [{ name: 'ghost ants', quote: 'Ghost ants on the kitchen counter' }],
    }));
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, status: 'read', areas: ['Outside'], pests: ['ghost ants'] });
  });

  test('a failed read answers with no facts, not an error', async () => {
    process.env.GATE_FAST_COMPLETE_REPORT = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'error' });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, status: 'failed', areas: [], pests: [] });
  });
});
