/**
 * Typed voice fill (Fast Complete step 3, GATE_TYPED_VOICE_FILL): a typed
 * visit's own findings read from the technician's note
 * (services/visit-typed-facts.js), and the route the forms call
 * (POST /admin/dispatch/:serviceId/typed-facts).
 *
 *  - A value stands only when it is one of its field's own options and the
 *    note holds its quote word for word; free-text, count, product-filled and
 *    internal fields are never read.
 *  - A combination the completion's own validator refuses is never filled:
 *    every side of the clash is left for a person to pick.
 *  - Any failure reads as nothing filled, never an error; access codes never
 *    reach the provider.
 *  - The route is dark with the gate off, reads only the technician's own
 *    current visit, and takes the form from the visit's completion profile,
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
  readTypedFacts, validateTypedFacts, voiceFieldsFor, voiceTypeFor, typedSchema, typedSystemPrompt, VOICE_TYPES, NOT_SAID,
} = require('../services/visit-typed-facts');
const { PROJECT_TYPES } = require('../services/project-types');
const router = require('../routes/admin-dispatch');

const answer = (json) => ({ ok: true, json });
const ROACH_NOTE = 'German roaches, heavy, behind the fridge and under the sink. Saw live ones and droppings.';
// Every field of a type answered as the model answers "not said".
const nothingSaid = (type) => Object.fromEntries(voiceFieldsFor(type).map((field) => [field.key, field.type === 'select' ? { value: NOT_SAID, quote: '' } : []]));
const fieldsOf = (type, fields) => ({ fields: { ...nothingSaid(type), ...fields } });

beforeEach(() => {
  dispatchWithFallback.mockReset();
  mockDbCurrent = null;
  mockProfile = null;
});

describe('the forms, the schema and the prompt', () => {
  test('every form read is a typed form the completion defines; counts, termite, tree and lawn forms are other steps', () => {
    for (const type of Object.keys(VOICE_TYPES)) expect(PROJECT_TYPES[type]?.findingsFields?.length).toBeGreaterThan(0);
    for (const type of ['rodent_trapping', 'rodent_bait_station', 'termite_bait_station', 'termite_treatment', 'wdo_inspection', 'tree_shrub', 'one_time_lawn_treatment', 'palm_injection']) {
      expect(VOICE_TYPES).not.toHaveProperty(type);
    }
  });

  test('only pick fields are read: free text, counts and the product-filled work list never are', () => {
    const roach = voiceFieldsFor('cockroach').map((field) => field.key);
    expect(roach).toEqual(['species', 'activity_level', 'activity_locations', 'evidence_observed', 'conducive_conditions', 'areas_treated', 'customer_prep']);
    expect(roach).not.toContain('work_completed');
    expect(voiceFieldsFor('german_roach_knockdown').map((field) => field.key)).not.toContain('rooms_treated');
    expect(voiceFieldsFor('pest_inspection').map((field) => field.key)).not.toContain('pests_identified');
    const wildlife = voiceFieldsFor('wildlife_trapping').map((field) => field.key);
    expect(wildlife).not.toContain('traps_checked');
    expect(wildlife).not.toContain('captures');
  });

  test('the schema offers each field only its own options: one value (or not said) for a select, a list for chips', () => {
    const fields = voiceFieldsFor('cockroach');
    const schema = typedSchema(fields);
    const props = schema.properties.fields.properties;
    expect(schema.properties.fields.required).toEqual(fields.map((field) => field.key));
    const species = fields.find((field) => field.key === 'species');
    expect(props.species.properties.value.enum).toEqual([...species.options, NOT_SAID]);
    const locations = fields.find((field) => field.key === 'activity_locations');
    expect(props.activity_locations.type).toBe('array');
    expect(props.activity_locations.items.properties.value.enum).toEqual(locations.options);
  });

  test('the prompt names every field and option, and reads the note as data only', () => {
    const fields = voiceFieldsFor('flea');
    const prompt = typedSystemPrompt('flea', fields);
    for (const field of fields) {
      expect(prompt).toContain(field.key);
      for (const option of field.options) expect(prompt).toContain(option);
    }
    expect(prompt).toContain('DATA ONLY');
  });

  test('the form is the profile\'s own findings type, only when this step reads it', () => {
    expect(voiceTypeFor({ findingsType: 'cockroach' })).toBe('cockroach');
    expect(voiceTypeFor({ findingsType: 'termite_bait_station' })).toBeNull();
    expect(voiceTypeFor({ serviceKey: 'fire_ant' })).toBeNull();
    expect(voiceTypeFor(null)).toBeNull();
  });
});

describe('validateTypedFacts', () => {
  test('keeps values the form offers, standing on the note\'s own words, in the form\'s own encoding', () => {
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      activity_level: { value: 'Heavy', quote: 'heavy' },
      // Chips are kept in the form's own option order, joined ", ".
      evidence_observed: [{ value: 'Droppings', quote: 'droppings' }, { value: 'Live roaches', quote: 'Saw live ones' }],
    }), ROACH_NOTE);
    expect(facts.values).toEqual({ species: 'German', activity_level: 'Heavy', evidence_observed: 'Live roaches, Droppings' });
    expect(facts.heard.evidence_observed).toEqual([{ value: 'Live roaches', quote: 'saw live ones' }, { value: 'Droppings', quote: 'droppings' }]);
    expect(facts.unclearFields).toEqual([]);
  });

  test('a field not said is left empty; a value heard but not held up by the note is left for a person to pick', () => {
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'American', quote: 'big American roaches' },
      activity_locations: [{ value: 'Garage', quote: 'in the garage' }],
    }), ROACH_NOTE);
    expect(facts.values).toEqual({});
    expect(facts.unclearFields).toEqual(['species', 'activity_locations']);
  });

  test('chips keep what the note holds up and drop what it does not', () => {
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      activity_locations: [{ value: 'Under sink', quote: 'under the sink' }, { value: 'Garage', quote: 'in the garage' }],
    }), ROACH_NOTE);
    expect(facts.values).toEqual({ activity_locations: 'Under sink' });
    expect(facts.unclearFields).toEqual([]);
  });

  test('a combination the completion refuses is never filled: every side of it is left for a person', () => {
    const note = 'German roaches. Nothing seen today. Under the sink there were live ones.';
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      activity_level: { value: 'None observed', quote: 'Nothing seen today' },
      activity_locations: [{ value: 'Under sink', quote: 'Under the sink' }],
      evidence_observed: [{ value: 'Live roaches', quote: 'live ones' }],
    }), note);
    expect(facts.values).toEqual({ species: 'German' });
    expect(facts.unclearFields).toEqual(['activity_level', 'activity_locations', 'evidence_observed']);
  });

  test('chips that contradict each other are left for a person', () => {
    const note = 'Inspection only today, did the exterior flea treatment in the yard.';
    const facts = validateTypedFacts('flea', fieldsOf('flea', {
      treatment_completed: [{ value: 'Inspection only', quote: 'Inspection only' }, { value: 'Exterior flea treatment', quote: 'exterior flea treatment' }],
    }), note);
    expect(facts.values).toEqual({});
    expect(facts.unclearFields).toEqual(['treatment_completed']);
  });

  test('a malformed answer fills nothing', () => {
    expect(validateTypedFacts('cockroach', { fields: 'German' }, ROACH_NOTE)).toEqual({ values: {}, heard: {}, unclearFields: [] });
    expect(validateTypedFacts('cockroach', null, ROACH_NOTE)).toEqual({ values: {}, heard: {}, unclearFields: [] });
  });
});

describe('readTypedFacts', () => {
  test('reads the note through the fast structured lane with the form\'s own schema', async () => {
    dispatchWithFallback.mockResolvedValue(answer(fieldsOf('cockroach', { species: { value: 'German', quote: 'German roaches' } })));
    const facts = await readTypedFacts({ note: ROACH_NOTE, findingsType: 'cockroach' });
    expect(facts).toMatchObject({ status: 'read', type: 'cockroach', values: { species: 'German' }, unclearFields: [] });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy.name).toBe('fastStructured');
    expect(payload).toMatchObject({ laneId: 'visit_typed_facts', promptVersion: 'visit-typed-facts-v1' });
    expect(payload.jsonSchema.properties.fields.required).toEqual(voiceFieldsFor('cockroach').map((field) => field.key));
    expect(options).toEqual({ reserveFallbackBudget: true });
  });

  test('a form this step does not read, an empty note, or a note past the cap never calls the model', async () => {
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: 'termite_bait_station' })).toMatchObject({ status: 'no_type', values: {} });
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: undefined })).toMatchObject({ status: 'no_type' });
    expect(await readTypedFacts({ note: '   ', findingsType: 'cockroach' })).toMatchObject({ status: 'empty_note' });
    const { MAX_NOTE_CHARS } = require('../services/visit-voice-facts');
    expect(await readTypedFacts({ note: 'Saw roaches. '.repeat(Math.ceil(MAX_NOTE_CHARS / 13) + 1), findingsType: 'cockroach' }))
      .toMatchObject({ status: 'too_long' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('access codes never reach the provider', async () => {
    dispatchWithFallback.mockResolvedValue(answer(fieldsOf('cockroach', {})));
    await readTypedFacts({ note: 'Gate code is 4471. German roaches under the sink.', findingsType: 'cockroach' });
    const sent = dispatchWithFallback.mock.calls[0][1].text;
    expect(sent).not.toContain('4471');
    expect(sent).toContain('German roaches under the sink.');
  });

  test('a failed or throwing call is nothing filled, never an error', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false });
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: 'cockroach' })).toMatchObject({ status: 'failed', values: {} });
    dispatchWithFallback.mockRejectedValue(new Error('provider down'));
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: 'cockroach' })).toMatchObject({ status: 'failed', values: {} });
  });
});

function invoke(params, body, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/typed-facts' && l.route.methods.post);
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
const SERVICE = { id: 'svc-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, service_type: 'Cockroach Control' };

function serviceDb(service, calls) {
  return (table) => {
    calls.push(table);
    const chain = {};
    chain.where = () => chain;
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    return chain;
  };
}

describe('POST /:serviceId/typed-facts', () => {
  const ORIGINAL_GATE = process.env.GATE_TYPED_VOICE_FILL;
  afterEach(() => {
    if (ORIGINAL_GATE === undefined) delete process.env.GATE_TYPED_VOICE_FILL;
    else process.env.GATE_TYPED_VOICE_FILL = ORIGINAL_GATE;
  });

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: 404 with no database read and no model call', async (value) => {
    if (value === undefined) delete process.env.GATE_TYPED_VOICE_FILL; else process.env.GATE_TYPED_VOICE_FILL = value;
    const calls = [];
    mockDbCurrent = serviceDb(SERVICE, calls);
    const res = await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ enabled: false });
    expect(calls).toEqual([]);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a note that is not text is a 400; an unknown visit is a 404', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    expect((await invoke({ serviceId: 'svc-1' }, { note: { text: ROACH_NOTE } })).statusCode).toBe(400);
    mockDbCurrent = serviceDb(null, []);
    expect((await invoke({ serviceId: 'svc-x' }, { note: ROACH_NOTE })).statusCode).toBe(404);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a technician reads only their own current visit', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    mockProfile = { serviceKey: 'cockroach_control', findingsType: 'cockroach' };
    mockDbCurrent = serviceDb(SERVICE, []);
    expect((await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE }, { techRole: 'technician', technicianId: 'tech-2' })).statusCode).toBe(403);
    mockDbCurrent = serviceDb({ ...SERVICE, status: 'cancelled' }, []);
    expect((await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE }, { techRole: 'technician', technicianId: 'tech-1' })).statusCode).toBe(403);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the form is the visit\'s own completion profile: an untyped visit or a form this step does not read is not read', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    mockDbCurrent = serviceDb(SERVICE, []);
    mockProfile = { serviceKey: 'fire_ant', findingsType: null };
    expect((await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE })).body).toEqual({ available: false });
    mockProfile = { serviceKey: 'termite_active_bait_quarterly', findingsType: 'termite_bait_station' };
    expect((await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE })).body).toEqual({ available: false });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the assigned technician gets the visit\'s own form read, whatever form the client names', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    mockProfile = { serviceKey: 'cockroach_control', findingsType: 'cockroach' };
    mockDbCurrent = serviceDb(SERVICE, []);
    dispatchWithFallback.mockResolvedValue(answer(fieldsOf('cockroach', { species: { value: 'German', quote: 'German roaches' } })));
    const res = await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE, findingsType: 'flea' }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ available: true, status: 'read', type: 'cockroach', values: { species: 'German' } });
    expect(dispatchWithFallback.mock.calls[0][1].jsonSchema.properties.fields.required)
      .toEqual(voiceFieldsFor('cockroach').map((field) => field.key));
  });
});
