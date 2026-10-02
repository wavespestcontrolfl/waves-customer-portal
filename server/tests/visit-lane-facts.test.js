/**
 * Lane voice fill (Fast Complete step 2, GATE_LANE_VOICE_FILL): a specialty
 * visit's own record read from the technician's note
 * (services/visit-lane-facts.js), and the route the forms call
 * (POST /admin/dispatch/:serviceId/lane-facts).
 *
 *  - A place or a finding stands only when it is one the lane's closeout
 *    offers and the note holds its quote word for word.
 *  - A pair the completion refuses (the lane's exclusions) is never filled:
 *    both groups are left for a person to pick.
 *  - Any failure reads as nothing filled, never an error; access codes never
 *    reach the provider.
 *  - The route is dark with the gate off, reads only the technician's own
 *    current visit, and takes the lane from the visit's completion profile,
 *    never from the client.
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
let mockProfile = null;
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => mockProfile,
}));

const { dispatchWithFallback } = require('../services/llm/call');
const {
  readLaneFacts, validateLaneFacts, laneSchema, laneSystemPrompt, VOICE_LANES, NOT_SAID,
} = require('../services/visit-lane-facts');
const { SPECIALTY_SERVICE_CLOSEOUTS } = require('../../shared/specialty-service-closeouts');
const router = require('../routes/admin-dispatch');

const answer = (json) => ({ ok: true, json });
const BED_BUG_NOTE = 'Second treatment. Treated the master bedroom and the living room couch, live ones on the couch seams. They had everything bagged.';
const notSaid = (laneKey) => Object.fromEntries(
  SPECIALTY_SERVICE_CLOSEOUTS[laneKey].findingGroups.map((group) => [group.key, { value: NOT_SAID, quote: '' }]),
);

beforeEach(() => {
  dispatchWithFallback.mockReset();
  mockDbCurrent = null;
  mockProfile = null;
});

describe('the lanes, the schema and the prompt', () => {
  test('every lane read is one the shared closeouts define, and the lawn lanes are not read here', () => {
    for (const laneKey of Object.keys(VOICE_LANES)) expect(SPECIALTY_SERVICE_CLOSEOUTS[laneKey]).toBeTruthy();
    expect(VOICE_LANES).not.toHaveProperty('dethatching');
    expect(VOICE_LANES).not.toHaveProperty('plugging');
  });

  test('the schema offers only the lane\'s own places and each group\'s own values', () => {
    const spec = SPECIALTY_SERVICE_CLOSEOUTS.bed_bug_treatment;
    const schema = laneSchema(spec);
    expect(schema.properties.areas.items.properties.area.enum).toEqual(spec.areas);
    expect(schema.properties.findings.required).toEqual(spec.findingGroups.map((group) => group.key));
    for (const group of spec.findingGroups) {
      expect(schema.properties.findings.properties[group.key].properties.value.enum).toEqual([...group.options, NOT_SAID]);
    }
  });

  test('the prompt names every place and value, and reads the note as data only', () => {
    const spec = SPECIALTY_SERVICE_CLOSEOUTS.fire_ant;
    const prompt = laneSystemPrompt('fire_ant', spec);
    for (const area of spec.areas) expect(prompt).toContain(area);
    for (const group of spec.findingGroups) for (const option of group.options) expect(prompt).toContain(option);
    expect(prompt).toContain('DATA ONLY');
  });
});

describe('validateLaneFacts', () => {
  test('keeps places and findings the lane offers, standing on the note\'s own words', () => {
    const facts = validateLaneFacts('bed_bug_treatment', {
      areas: [
        { area: 'Primary bedroom', quote: 'Treated the master bedroom' },
        { area: 'Furniture / upholstery', quote: 'the living room couch' },
        { area: 'Primary bedroom', quote: 'the master bedroom' },
        // Words the note does not hold are no evidence.
        { area: 'Guest bedroom', quote: 'treated the guest room' },
      ],
      findings: {
        bed_bug_visit_stage: { value: 'Scheduled follow-up treatment', quote: 'Second treatment' },
        bed_bug_evidence: { value: 'Live adults', quote: 'live ones on the couch seams' },
        bed_bug_prep: { value: 'Preparation complete', quote: 'They had everything bagged' },
      },
    }, BED_BUG_NOTE);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Primary bedroom', 'Furniture / upholstery']);
    expect(facts.findings).toEqual([
      { group: 'bed_bug_visit_stage', value: 'Scheduled follow-up treatment', quote: 'second treatment' },
      { group: 'bed_bug_evidence', value: 'Live adults', quote: 'live ones on the couch seams' },
      { group: 'bed_bug_prep', value: 'Preparation complete', quote: 'they had everything bagged' },
    ]);
    expect(facts.unclearGroups).toEqual([]);
  });

  test('a group not said is left empty; a value heard but not held up is left for a person to pick', () => {
    const facts = validateLaneFacts('bed_bug_treatment', {
      areas: [],
      findings: {
        ...notSaid('bed_bug_treatment'),
        bed_bug_evidence: { value: 'Live adults', quote: 'saw adults everywhere' },
        bed_bug_prep: { value: 'Not a value the lane offers', quote: 'They had everything bagged' },
      },
    }, BED_BUG_NOTE);
    expect(facts.findings).toEqual([]);
    expect(facts.unclearGroups).toEqual(['bed_bug_evidence', 'bed_bug_prep']);
  });

  test('a pair the completion refuses is never filled: both groups are left for a person to pick', () => {
    const note = 'No active mounds anywhere, fire ants were widespread along the fence last time.';
    const facts = validateLaneFacts('fire_ant', {
      areas: [{ area: 'Fence line', quote: 'along the fence' }],
      findings: {
        fire_ant_evidence: { value: 'No active fire ants observed', quote: 'No active mounds anywhere' },
        fire_ant_distribution: { value: 'Widespread activity', quote: 'fire ants were widespread' },
      },
    }, note);
    expect(facts.findings).toEqual([]);
    expect(facts.unclearGroups).toEqual(['fire_ant_evidence', 'fire_ant_distribution']);
    expect(facts.areas).toEqual([{ area: 'Fence line', quote: 'along the fence' }]);
  });

  test('a malformed answer fills nothing', () => {
    expect(validateLaneFacts('mosquito', null, 'Treated the yard.')).toEqual({ areas: [], findings: [], unclearGroups: [] });
    expect(validateLaneFacts('mosquito', { areas: 'yard', findings: [] }, 'Treated the yard.')).toEqual({ areas: [], findings: [], unclearGroups: [] });
  });
});

describe('readLaneFacts', () => {
  test('reads the note through the fast structured lane with the lane\'s own schema', async () => {
    dispatchWithFallback.mockResolvedValue(answer({
      areas: [{ area: 'Primary bedroom', quote: 'Treated the master bedroom' }],
      findings: { ...notSaid('bed_bug_treatment'), bed_bug_visit_stage: { value: 'Scheduled follow-up treatment', quote: 'Second treatment' } },
    }));
    const facts = await readLaneFacts({ note: BED_BUG_NOTE, laneKey: 'bed_bug_treatment' });
    expect(facts).toMatchObject({
      status: 'read',
      lane: 'bed_bug_treatment',
      areas: [{ area: 'Primary bedroom', quote: 'treated the master bedroom' }],
      findings: [{ group: 'bed_bug_visit_stage', value: 'Scheduled follow-up treatment' }],
      unclearGroups: [],
    });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy.name).toBe('fastStructured');
    expect(payload).toMatchObject({ laneId: 'visit_lane_facts', promptVersion: 'visit-lane-facts-v1' });
    expect(payload.jsonSchema.properties.areas.items.properties.area.enum).toEqual(SPECIALTY_SERVICE_CLOSEOUTS.bed_bug_treatment.areas);
    expect(options).toEqual({ reserveFallbackBudget: true });
  });

  test('a lane this step does not read, an empty note, or a note past the cap never calls the model', async () => {
    expect(await readLaneFacts({ note: BED_BUG_NOTE, laneKey: 'dethatching' })).toMatchObject({ status: 'no_lane', areas: [], findings: [] });
    expect(await readLaneFacts({ note: BED_BUG_NOTE, laneKey: undefined })).toMatchObject({ status: 'no_lane' });
    expect(await readLaneFacts({ note: '   ', laneKey: 'mosquito' })).toMatchObject({ status: 'empty_note' });
    const { MAX_NOTE_CHARS } = require('../services/visit-voice-facts');
    expect(await readLaneFacts({ note: 'Treated the yard. '.repeat(Math.ceil(MAX_NOTE_CHARS / 18) + 1), laneKey: 'mosquito' }))
      .toMatchObject({ status: 'too_long' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('access codes never reach the provider', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ areas: [], findings: notSaid('mosquito') }));
    await readLaneFacts({ note: 'Gate code is 4471. Treated the yard vegetation.', laneKey: 'mosquito' });
    const sent = dispatchWithFallback.mock.calls[0][1].text;
    expect(sent).not.toContain('4471');
    expect(sent).toContain('Treated the yard vegetation.');
  });

  test('a failed or throwing call is nothing filled, never an error', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'openai_timeout' });
    expect(await readLaneFacts({ note: BED_BUG_NOTE, laneKey: 'bed_bug_treatment' })).toMatchObject({ status: 'failed', areas: [], findings: [] });
    dispatchWithFallback.mockRejectedValueOnce(new Error('boom'));
    expect(await readLaneFacts({ note: BED_BUG_NOTE, laneKey: 'bed_bug_treatment' })).toMatchObject({ status: 'failed', areas: [], findings: [] });
  });
});

function invoke(params, body, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/lane-facts' && l.route.methods.post);
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
const SERVICE = { id: 'svc-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, service_type: 'Bed Bug Treatment' };

function serviceDb(service, calls) {
  return (table) => {
    calls.push(table);
    const chain = {};
    chain.where = () => chain;
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    return chain;
  };
}

describe('POST /:serviceId/lane-facts', () => {
  const ORIGINAL_GATE = process.env.GATE_LANE_VOICE_FILL;
  afterEach(() => {
    if (ORIGINAL_GATE === undefined) delete process.env.GATE_LANE_VOICE_FILL;
    else process.env.GATE_LANE_VOICE_FILL = ORIGINAL_GATE;
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: 404 with no database read and no model call', async (value) => {
    if (value === undefined) delete process.env.GATE_LANE_VOICE_FILL; else process.env.GATE_LANE_VOICE_FILL = value;
    const calls = [];
    mockDbCurrent = serviceDb(SERVICE, calls);
    const res = await invoke({ serviceId: 'svc-1' }, { note: BED_BUG_NOTE });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a note that is not text is a 400; an unknown visit is a 404', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    expect((await invoke({ serviceId: 'svc-1' }, { note: { text: BED_BUG_NOTE } })).statusCode).toBe(400);
    mockDbCurrent = serviceDb(null, []);
    expect((await invoke({ serviceId: 'svc-x' }, { note: BED_BUG_NOTE })).statusCode).toBe(404);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a technician reads only their own current visit', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    mockProfile = { serviceKey: 'bed_bug_treatment' };
    mockDbCurrent = serviceDb(SERVICE, []);
    expect((await invoke({ serviceId: 'svc-1' }, { note: BED_BUG_NOTE }, { techRole: 'technician', technicianId: 'tech-2' })).statusCode).toBe(403);
    mockDbCurrent = serviceDb({ ...SERVICE, status: 'cancelled' }, []);
    expect((await invoke({ serviceId: 'svc-1' }, { note: BED_BUG_NOTE }, { techRole: 'technician', technicianId: 'tech-1' })).statusCode).toBe(403);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the lane is the visit\'s own completion profile: a typed form or a visit with no lane is not read', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    mockDbCurrent = serviceDb({ ...SERVICE, service_type: 'Quarterly Pest Control' }, []);
    mockProfile = { serviceKey: 'pest_general_quarterly' };
    expect((await invoke({ serviceId: 'svc-1' }, { note: BED_BUG_NOTE })).body).toEqual({ available: false });
    mockProfile = { serviceKey: 'mosquito_one_time', findingsType: 'mosquito_event' };
    expect((await invoke({ serviceId: 'svc-1' }, { note: BED_BUG_NOTE })).body).toEqual({ available: false });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the assigned technician gets the visit\'s own lane read, whatever lane the client names', async () => {
    process.env.GATE_LANE_VOICE_FILL = 'true';
    mockProfile = { serviceKey: 'bed_bug_treatment' };
    mockDbCurrent = serviceDb(SERVICE, []);
    dispatchWithFallback.mockResolvedValue(answer({
      areas: [{ area: 'Primary bedroom', quote: 'Treated the master bedroom' }],
      findings: notSaid('bed_bug_treatment'),
    }));
    const res = await invoke({ serviceId: 'svc-1' }, { note: BED_BUG_NOTE, lane: 'fire_ant' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, status: 'read', lane: 'bed_bug_treatment', areas: [{ area: 'Primary bedroom' }] });
    expect(dispatchWithFallback.mock.calls[0][1].jsonSchema.properties.areas.items.properties.area.enum)
      .toEqual(SPECIALTY_SERVICE_CLOSEOUTS.bed_bug_treatment.areas);
  });
});
