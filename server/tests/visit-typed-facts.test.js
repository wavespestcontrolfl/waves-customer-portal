/**
 * Typed voice fill (Fast Complete steps 3 to 5, GATE_TYPED_VOICE_FILL): a typed
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
  readTypedFacts, validateTypedFacts, currentValuesFor, voiceFieldsFor, voiceTypeFor, sheetTypeFor, scoreOf, typedSchema, typedSystemPrompt,
  percentsStated, VOICE_TYPES, NOT_SAID,
} = require('../services/visit-typed-facts');
const { PROJECT_TYPES } = require('../services/project-types');
const router = require('../routes/admin-dispatch');

const answer = (json) => ({ ok: true, json });
const ROACH_NOTE = 'German roaches, heavy, behind the fridge and under the sink. Saw live ones and droppings.';
// Every field of a type answered as the model answers "not said".
const notSaid = (field) => {
  if (field.type === 'count' || field.readAs === 'percent') return { said: false, value: 0, quote: '' };
  return field.type === 'select' ? { value: NOT_SAID, quote: '' } : [];
};
const nothingSaid = (type, options) => Object.fromEntries(voiceFieldsFor(type, options).map((field) => [field.key, notSaid(field)]));
const fieldsOf = (type, fields) => ({ fields: { ...nothingSaid(type), ...fields } });

beforeEach(() => {
  dispatchWithFallback.mockReset();
  mockDbCurrent = null;
  mockProfile = null;
});

describe('the forms, the schema and the prompt', () => {
  test('every form read is a typed form the completion defines; step 4 adds the trap and station checks, step 5 termite treatment and inspection; WDO, tree and lawn forms are never read here', () => {
    for (const type of Object.keys(VOICE_TYPES)) expect(PROJECT_TYPES[type]?.findingsFields?.length).toBeGreaterThan(0);
    for (const type of ['rodent_trapping', 'rodent_bait_station', 'termite_bait_station', 'termite_treatment', 'termite_inspection']) {
      expect(VOICE_TYPES).toHaveProperty(type);
    }
    for (const type of ['wdo_inspection', 'tree_shrub', 'one_time_lawn_treatment', 'palm_injection']) {
      expect(VOICE_TYPES).not.toHaveProperty(type);
    }
  });

  test('pick fields and counts are read: free text and the product-filled work list never are', () => {
    const roach = voiceFieldsFor('cockroach').map((field) => field.key);
    expect(roach).toEqual(['species', 'activity_level', 'activity_locations', 'evidence_observed', 'conducive_conditions', 'areas_treated', 'customer_prep']);
    expect(roach).not.toContain('work_completed');
    expect(voiceFieldsFor('german_roach_knockdown').map((field) => field.key)).not.toContain('rooms_treated');
    expect(voiceFieldsFor('pest_inspection').map((field) => field.key)).not.toContain('pests_identified');
    const wildlife = voiceFieldsFor('wildlife_trapping').map((field) => field.key);
    expect(wildlife).toEqual(expect.arrayContaining(['traps_checked', 'captures']));
    // A required internal field (the trap visit) is the technician's to say.
    expect(voiceFieldsFor('rodent_trapping').map((field) => field.key)).toContain('trap_visit_type');
    expect(voiceFieldsFor('termite_bait_station').map((field) => field.key)).not.toContain('active_station_location');
  });

  test('the fields are the form as served for the visit\'s service key: a combined rodent service\'s module fields only where its key shows them', () => {
    const own = voiceFieldsFor('rodent_trapping', { serviceKey: 'rodent_trapping' }).map((field) => field.key);
    const all = voiceFieldsFor('rodent_trapping').map((field) => field.key);
    expect(all.length).toBeGreaterThan(own.length);
    for (const key of own) expect(all).toContain(key);
  });

  test('a count is a number the note gives or not, every key required; only a form whose score the technician sets asks for the rating', () => {
    const fields = voiceFieldsFor('rodent_trapping', { serviceKey: 'rodent_trapping' });
    const schema = typedSchema(fields, { scored: true });
    expect(schema.properties.fields.properties.traps_checked).toEqual({
      type: 'object',
      properties: { said: { type: 'boolean' }, value: { type: 'integer' }, quote: { type: 'string' } },
      required: ['said', 'value', 'quote'],
      additionalProperties: false,
    });
    expect(schema.required).toEqual(['fields', 'score']);
    expect(typedSchema(fields).properties).not.toHaveProperty('score');
    expect(scoreOf('rodent_trapping')).toEqual({ label: 'Rodent Activity' });
    expect(scoreOf('wildlife_trapping')).toEqual({ label: 'Wildlife Activity' });
    // A score derived from a field is never read from the note.
    expect(scoreOf('rodent_bait_station')).toBeNull();
    expect(scoreOf('termite_bait_station')).toBeNull();
    expect(scoreOf('cockroach')).toBeNull();
    const prompt = typedSystemPrompt('rodent_trapping', fields, { score: scoreOf('rodent_trapping') });
    expect(prompt).toContain('traps_checked (Traps checked; a count)');
    expect(prompt).toContain('Never rate it yourself.');
    expect(typedSystemPrompt('cockroach', voiceFieldsFor('cockroach'))).not.toContain('the score');
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
    expect(voiceTypeFor({ findingsType: 'termite_bait_station' })).toBe('termite_bait_station');
    expect(voiceTypeFor({ findingsType: 'tree_shrub' })).toBeNull();
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

  test('a short answer stands on the words around it; a bare short quote proves too little (codex local r1 on #5630)', () => {
    const note = 'German roaches, low activity in the kitchen. Rat droppings by the garage.';
    const kept = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      activity_level: { value: 'Low', quote: 'low activity in the kitchen' },
    }), note);
    expect(kept.values).toEqual({ activity_level: 'Low' });
    const bare = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      activity_level: { value: 'Low', quote: 'low' },
    }), note);
    expect(bare.values).toEqual({});
    expect(bare.unclearFields).toEqual(['activity_level']);
    // The prompt asks for the words around a short answer.
    expect(typedSystemPrompt('rodent_inspection', voiceFieldsFor('rodent_inspection'))).toMatch(/at least four characters long/);
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

  test('a field refused on its own takes no unrelated finding with it (pre-push P1)', () => {
    const note = 'Heavy flea activity. Inspection only today, did the exterior flea treatment in the yard. Asked them to wash pet bedding.';
    const facts = validateTypedFacts('flea', fieldsOf('flea', {
      evidence_level: { value: 'Heavy', quote: 'Heavy flea activity' },
      treatment_completed: [{ value: 'Inspection only', quote: 'Inspection only' }, { value: 'Exterior flea treatment', quote: 'exterior flea treatment' }],
      customer_prep: [{ value: 'Wash pet bedding', quote: 'wash pet bedding' }],
    }), note);
    expect(facts.values).toEqual({ evidence_level: 'Heavy', customer_prep: 'Wash pet bedding' });
    expect(facts.unclearFields).toEqual(['treatment_completed']);
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

describe('the form\'s present values (slice 2: the office form sends them)', () => {
  test('a field already set is never filled, even when the note says it', () => {
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      activity_level: { value: 'Heavy', quote: 'heavy' },
    }), ROACH_NOTE, { species: 'American' });
    expect(facts.values).toEqual({ activity_level: 'Heavy' });
    expect(facts.heard).not.toHaveProperty('species');
    expect(facts.unclearFields).toEqual([]);
  });

  test('a fill that clashes with a pick is left for a person; the rest stands', () => {
    const note = 'German roaches, saw live ones under the sink.';
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      evidence_observed: [{ value: 'Live roaches', quote: 'saw live ones' }],
    }), note, { activity_level: 'None observed' });
    expect(facts.values).toEqual({ species: 'German' });
    expect(facts.unclearFields).toEqual(['evidence_observed']);
  });

  test('a present value the completion refuses on its own does not switch the fill off; its field still counts as set', () => {
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      activity_level: { value: 'Heavy', quote: 'heavy' },
    }), ROACH_NOTE, { activity_level: 'Some old value' });
    expect(facts.values).toEqual({ species: 'German' });
  });

  test('a clash the form already holds takes no unrelated fill with it (Codex P2 on #5632)', () => {
    // "None observed" beside "Live roaches": each stands alone, the pair is
    // refused. The person fixes it at submit; the species the note says
    // still fills.
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
    }), ROACH_NOTE, { activity_level: 'None observed', evidence_observed: 'Live roaches' });
    expect(facts.values).toEqual({ species: 'German' });
    expect(facts.unclearFields).toEqual([]);
  });

  test('each side of a clash the form already holds still refuses a fill that contradicts it (Codex P2 r2 on #5632)', () => {
    // "Kitchen" as an activity location contradicts "None observed", even
    // with "None observed" itself in a clash of its own.
    const note = 'German roaches in the kitchen.';
    const facts = validateTypedFacts('cockroach', fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      activity_locations: [{ value: 'Kitchen', quote: 'in the kitchen' }],
    }), note, { activity_level: 'None observed', evidence_observed: 'Live roaches' });
    expect(facts.values).toEqual({ species: 'German' });
    expect(facts.unclearFields).toEqual(['activity_locations']);
  });

  test('the present values keep only the form\'s own fields, as text', () => {
    expect(currentValuesFor('cockroach', {
      species: 'German', made_up: 'x', activity_level: 3, evidence_observed: ['Live roaches'], customer_prep: '   ',
    })).toEqual({ species: 'German', activity_level: '3' });
    expect(currentValuesFor('cockroach', 'German')).toEqual({});
    expect(currentValuesFor('cockroach', null)).toEqual({});
    expect(currentValuesFor('cockroach', { species: 'x'.repeat(4001) })).toEqual({});
  });
});

describe('counts and the technician\'s rating (step 4)', () => {
  const TRAPS = voiceFieldsFor('rodent_trapping', { serviceKey: 'rodent_trapping' });
  const TRAP_NOTE = 'Follow-up check on the roof rats. Checked all eight traps in the attic, 2 caught by the AC chase. Reset and re-baited all of them. Activity is down, I\'d call it a 2.';
  const trapAnswer = (fields, score = { said: false, value: 0, quote: '' }) => ({ ...fieldsOf('rodent_trapping', fields), score });
  const read = (json, note = TRAP_NOTE, current = {}) => validateTypedFacts('rodent_trapping', json, note, current, { fields: TRAPS });

  test('a count stands on a quote that states it, in digits or in words', () => {
    const facts = read(trapAnswer({
      traps_checked: { said: true, value: 8, quote: 'Checked all eight traps' },
      captures: { said: true, value: 2, quote: '2 caught by the AC chase' },
    }));
    expect(facts.values).toMatchObject({ traps_checked: '8', captures: '2' });
    expect(facts.heard.traps_checked).toEqual([{ value: '8', quote: expect.stringMatching(/checked all eight traps/i) }]);
    expect(facts.unclearFields).toEqual([]);
  });

  test.each([
    ['states another number', { said: true, value: 3, quote: 'Checked all eight traps' }],
    ['states no number ("none caught")', { said: true, value: 0, quote: 'None caught out back' }],
    ['is not in the note', { said: true, value: 8, quote: 'Checked all 8 traps out back' }],
    ['is out of range', { said: true, value: 10000, quote: 'Checked all eight traps' }],
    ['is not a whole number', { said: true, value: 2.5, quote: '2 caught by the AC chase' }],
  ])('a count whose quote %s is left for a person', (_label, entry) => {
    const facts = read(trapAnswer({ captures: entry }), `${TRAP_NOTE} None caught out back.`);
    expect(facts.values).not.toHaveProperty('captures');
    expect(facts.unclearFields).toContain('captures');
  });

  test.each([
    ['a fraction never states its whole part', 'Checked 2.5 traps worth of the attic.', 2, 'Checked 2.5 traps worth', false],
    ['"one hundred" states 100, never 1', 'Checked one hundred traps.', 1, 'Checked one hundred traps', false],
    ['"one hundred" states 100', 'Checked one hundred traps.', 100, 'Checked one hundred traps', true],
    ['an ordinal states no count', 'The 2nd trap had a capture.', 2, 'The 2nd trap had a capture', false],
    ['a compound number in words', 'Checked twenty-one traps.', 21, 'Checked twenty-one traps', true],
    ['an ambiguous run of number words states nothing', 'Checked one fifty traps.', 150, 'Checked one fifty traps', false],
  ])('the number a quote states is read whole (pre-push P1): %s', (_label, note, value, quote, fills) => {
    const facts = read(trapAnswer({ traps_checked: { said: true, value, quote } }), note);
    if (fills) expect(facts.values.traps_checked).toBe(String(value));
    else expect(facts.unclearFields).toContain('traps_checked');
  });

  test.each([
    ['in digits', 'Activity rating 2.5'],
    ['as a spoken decimal', 'Activity rating two point five'],
    ['as a spoken fraction', 'Activity rating two and a half'],
    ['as a written fraction', 'Activity rating 2 1/2'],
  ])('a rating stated as a fraction %s waits for a person (pre-push P1)', (_label, quote) => {
    const facts = read(trapAnswer({}, { said: true, value: 2, quote }), `${TRAP_NOTE} ${quote}.`);
    expect(facts).not.toHaveProperty('score');
    expect(facts.scoreUnclear).toBe(true);
  });

  test('"entry point" is no decimal: the count beside it still stands', () => {
    const note = 'Sealed the entry point by the AC chase and set 6 traps.';
    const facts = read(trapAnswer({ traps_checked: { said: true, value: 6, quote: 'Sealed the entry point by the AC chase and set 6 traps' } }), note);
    expect(facts.values.traps_checked).toBe('6');
  });

  test('a count not said fills nothing and asks nothing; one already on the form is never filled over', () => {
    expect(read(trapAnswer({})).unclearFields).toEqual([]);
    const facts = read(trapAnswer({ traps_checked: { said: true, value: 8, quote: 'Checked all eight traps' } }), TRAP_NOTE, { traps_checked: '6' });
    expect(facts.values).not.toHaveProperty('traps_checked');
  });

  test('an initial setup stands with the trap count heard beside it, and waits for a person with none', () => {
    const note = 'Initial setup in the attic. Set 6 traps along the AC chase. Roof rats.';
    const setup = { trap_visit_type: { value: 'Initial setup', quote: 'Initial setup in the attic' }, species: { value: 'Roof rat', quote: 'Roof rats' } };
    const withCount = read(trapAnswer({ ...setup, traps_checked: { said: true, value: 6, quote: 'Set 6 traps along the AC chase' } }), note);
    expect(withCount.values).toEqual({ trap_visit_type: 'Initial setup', traps_checked: '6', species: 'Roof rat' });
    const noCount = read(trapAnswer(setup), note);
    expect(noCount.values).toEqual({ species: 'Roof rat' });
    expect(noCount.unclearFields).toEqual(['trap_visit_type']);
  });

  test('an initial setup heard beside work on traps already out: both sides wait for a person, the count and the rest stay', () => {
    const note = 'Initial setup, set 6 traps. Roof rats. Traps reset.';
    const facts = read(trapAnswer({
      trap_visit_type: { value: 'Initial setup', quote: 'Initial setup, set 6 traps' },
      traps_checked: { said: true, value: 6, quote: 'Initial setup, set 6 traps' },
      species: { value: 'Roof rat', quote: 'Roof rats' },
      trap_actions: [{ value: 'Traps reset', quote: 'Traps reset' }],
    }), note);
    expect(facts.values).toEqual({ traps_checked: '6', species: 'Roof rat' });
    expect(facts.unclearFields).toEqual(['trap_visit_type', 'trap_actions']);
  });

  test('an initial setup picked by hand: its count fills, and a fill that contradicts it waits for a person', () => {
    const note = 'Set 6 traps. Roof rats. Traps reset.';
    const facts = read(trapAnswer({
      traps_checked: { said: true, value: 6, quote: 'Set 6 traps' },
      species: { value: 'Roof rat', quote: 'Roof rats' },
      trap_actions: [{ value: 'Traps reset', quote: 'Traps reset' }],
    }), note, { trap_visit_type: 'Initial setup' });
    expect(facts.values).toEqual({ traps_checked: '6', species: 'Roof rat' });
    expect(facts.unclearFields).toEqual(['trap_actions']);
  });

  test('the technician\'s rating fills only where they set the score, on a quote that states it', () => {
    const facts = read(trapAnswer({}, { said: true, value: 2, quote: 'I\'d call it a 2' }));
    expect(facts.score).toEqual({ value: 2, quote: expect.stringMatching(/i'd call it a 2/i) });
    // A score derived from a field is never read from the note.
    const bait = validateTypedFacts('rodent_bait_station', { ...fieldsOf('rodent_bait_station', {}), score: { said: true, value: 2, quote: 'I\'d call it a 2' } }, TRAP_NOTE);
    expect(bait).not.toHaveProperty('score');
    expect(bait).not.toHaveProperty('scoreUnclear');
  });

  test.each([
    ['states no number', { said: true, value: 2, quote: 'Activity is down' }],
    ['is out of range', { said: true, value: 7, quote: 'I\'d call it a 2' }],
  ])('a rating whose quote %s waits for a person', (_label, score) => {
    const facts = read(trapAnswer({}, score));
    expect(facts).not.toHaveProperty('score');
    expect(facts.scoreUnclear).toBe(true);
  });
});

describe('termite treatment and inspection (step 5)', () => {
  const TRENCH_NOTE = 'Subterranean. Trenched the back wall and the patio edge, point zero six percent Termidor. Light activity at the patio corner.';
  const TRENCH = voiceFieldsFor('termite_treatment', { serviceKey: 'termite_trenching' });
  const trenchAnswer = (fields, score = { said: false, value: 0, quote: '' }) => ({
    fields: { ...nothingSaid('termite_treatment', { serviceKey: 'termite_trenching' }), ...fields }, score,
  });
  const readTrench = (json, note = TRENCH_NOTE, current = {}) => validateTypedFacts('termite_treatment', json, note, current, { fields: TRENCH });

  test('liquid, trenching, spot and foam are read; new-construction pre-treat never is; the sheet does not read them yet', () => {
    for (const serviceKey of ['termite_liquid', 'termite_trenching', 'termite_spot_treatment', 'foam_drill', 'foam_recurring']) {
      expect(voiceTypeFor({ serviceKey, findingsType: 'termite_treatment' })).toBe('termite_treatment');
      expect(sheetTypeFor({ serviceKey, findingsType: 'termite_treatment' })).toBeNull();
    }
    expect(voiceTypeFor({ serviceKey: 'termite_inspection', findingsType: 'termite_inspection' })).toBe('termite_inspection');
    expect(sheetTypeFor({ serviceKey: 'termite_inspection', findingsType: 'termite_inspection' })).toBeNull();
    expect(voiceTypeFor({ serviceKey: 'termite_pretreatment', findingsType: 'termite_treatment' })).toBeNull();
    expect(sheetTypeFor({ serviceKey: 'cockroach_control', findingsType: 'cockroach' })).toBe('cockroach');
  });

  test('the record\'s picks and its solution strength are read; the notice questions never are, nor the free text', () => {
    expect(TRENCH.map((field) => field.key)).toEqual(['target_termite', 'termite_evidence', 'areas_treated', 'treatment_method', 'percent_solution']);
    expect(TRENCH.find((field) => field.key === 'percent_solution')).toMatchObject({ readAs: 'percent' });
    expect(voiceFieldsFor('termite_inspection', { serviceKey: 'termite_inspection' }).map((field) => field.key)).toEqual(['termite_type', 'activity_status']);
    const schema = typedSchema(TRENCH, { scored: true });
    expect(schema.properties.fields.properties.percent_solution.properties.value).toEqual({ type: 'number' });
    expect(schema.properties.fields.properties).not.toHaveProperty('posted_notice');
    const prompt = typedSystemPrompt('termite_treatment', TRENCH, { score: scoreOf('termite_treatment') });
    expect(prompt).toContain('percent_solution (% solution; a percent)');
    expect(prompt).toContain('A "percent" field');
    expect(prompt).not.toContain('posted_notice');
    expect(scoreOf('termite_inspection')).toBeNull();
  });

  test('the trenching note fills target, method and solution strength with their words; "Light activity" states no rating', () => {
    const facts = readTrench(trenchAnswer({
      target_termite: { value: 'Subterranean termites', quote: 'Subterranean. Trenched' },
      treatment_method: { value: 'Trenching', quote: 'Trenched the back wall' },
      percent_solution: { said: true, value: 0.06, quote: 'point zero six percent' },
    }, { said: true, value: 1, quote: 'Light activity' }));
    expect(facts.values).toEqual({ target_termite: 'Subterranean termites', treatment_method: 'Trenching', percent_solution: '0.06%' });
    expect(facts.heard.percent_solution).toEqual([{ value: '0.06%', quote: 'point zero six percent' }]);
    expect(facts).not.toHaveProperty('score');
    expect(facts.scoreUnclear).toBe(true);
  });

  test.each([
    ['in digits', 'Trenched at 0.06% Termidor.', { said: true, value: 0.06, quote: 'Trenched at 0.06% Termidor' }, '0.06%'],
    ['a higher rate in words', 'Rodded the slab at point one two five percent.', { said: true, value: 0.125, quote: 'point one two five percent' }, '0.125%'],
    ['a number the quote does not state', TRENCH_NOTE, { said: true, value: 0.6, quote: 'point zero six percent' }, null],
    ['a number with no percent beside it', 'Mixed the Termidor at point zero six.', { said: true, value: 0.06, quote: 'Termidor at point zero six' }, null],
    ['a quote not in the note', TRENCH_NOTE, { said: true, value: 0.06, quote: 'zero point zero six percent solution' }, null],
    ['out of range', 'Mixed at 0 percent.', { said: true, value: 0, quote: 'Mixed at 0 percent' }, null],
  ])('a solution strength stands only as the percent its quote states: %s', (_label, note, entry, expected) => {
    const facts = readTrench(trenchAnswer({ percent_solution: entry }), note);
    if (expected) expect(facts.values.percent_solution).toBe(expected);
    else expect(facts.unclearFields).toContain('percent_solution');
  });

  test('the percents a quote states', () => {
    expect(percentsStated('point zero six percent')).toEqual([0.06]);
    expect(percentsStated('zero point oh six percent')).toEqual([0.06]);
    expect(percentsStated('0.125% on the slab, 0.06 percent outside')).toEqual([0.125, 0.06]);
    expect(percentsStated('point 06 per cent')).toEqual([0.06]);
    expect(percentsStated('at point zero six')).toEqual([]);
    expect(percentsStated('2.5 gallons')).toEqual([]);
  });

  test('a notice answer in the model\'s reply is never filled: always a tap', () => {
    const facts = readTrench({
      ...trenchAnswer({ treatment_method: { value: 'Trenching', quote: 'Trenched the back wall' } }),
      fields: {
        ...trenchAnswer({ treatment_method: { value: 'Trenching', quote: 'Trenched the back wall' } }).fields,
        posted_notice: { value: 'Yes', quote: 'Trenched the back wall' },
      },
    });
    expect(facts.values).toEqual({ treatment_method: 'Trenching' });
    expect(facts.unclearFields).not.toContain('posted_notice');
  });

  test('preventive evidence beside live termites leaves both for a person', () => {
    const note = 'Preventive treatment, no activity observed. Live termites observed at the patio corner.';
    const facts = readTrench(trenchAnswer({
      termite_evidence: [
        { value: 'Preventive treatment — no activity observed', quote: 'Preventive treatment, no activity observed' },
        { value: 'Live termites observed', quote: 'Live termites observed at the patio corner' },
      ],
      treatment_method: { value: 'Trenching', quote: 'Live termites observed' },
    }), note);
    expect(facts.values).not.toHaveProperty('termite_evidence');
    expect(facts.unclearFields).toContain('termite_evidence');
  });

  test('a termite inspection fills what was found; the inspection notice is a tap', () => {
    const note = 'Annual termite inspection, crawlspace and garage. No activity anywhere, no termites found.';
    const fields = voiceFieldsFor('termite_inspection', { serviceKey: 'termite_inspection' });
    const facts = validateTypedFacts('termite_inspection', {
      fields: {
        termite_type: { value: 'None observed', quote: 'no termites found' },
        activity_status: { value: 'No activity', quote: 'No activity anywhere' },
        inspection_notice_affixed: { value: 'Yes', quote: 'Annual termite inspection' },
      },
    }, note, {}, { fields });
    expect(facts.values).toEqual({ termite_type: 'None observed', activity_status: 'No activity' });
  });

  test('a pre-treat visit is never read, even asked directly', async () => {
    expect(await readTypedFacts({ note: TRENCH_NOTE, findingsType: 'termite_treatment', serviceKey: 'termite_pretreatment' }))
      .toMatchObject({ status: 'no_type', values: {} });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});

describe('readTypedFacts', () => {
  test('reads the note through the fast structured lane with the form\'s own schema', async () => {
    dispatchWithFallback.mockResolvedValue(answer(fieldsOf('cockroach', { species: { value: 'German', quote: 'German roaches' } })));
    const facts = await readTypedFacts({ note: ROACH_NOTE, findingsType: 'cockroach' });
    expect(facts).toMatchObject({ status: 'read', type: 'cockroach', values: { species: 'German' }, unclearFields: [] });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy.name).toBe('fastStructured');
    expect(payload).toMatchObject({ laneId: 'visit_typed_facts', promptVersion: 'visit-typed-facts-v3' });
    expect(payload.jsonSchema.properties.fields.required).toEqual(voiceFieldsFor('cockroach').map((field) => field.key));
    expect(options).toEqual({ reserveFallbackBudget: true });
  });

  test('a form this step does not read, an empty note, or a note past the cap never calls the model', async () => {
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: 'tree_shrub' })).toMatchObject({ status: 'no_type', values: {} });
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: undefined })).toMatchObject({ status: 'no_type' });
    expect(await readTypedFacts({ note: '   ', findingsType: 'cockroach' })).toMatchObject({ status: 'empty_note' });
    const { MAX_NOTE_CHARS } = require('../services/visit-voice-facts');
    expect(await readTypedFacts({ note: 'Saw roaches. '.repeat(Math.ceil(MAX_NOTE_CHARS / 13) + 1), findingsType: 'cockroach' }))
      .toMatchObject({ status: 'too_long' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a form that already holds every field the note could fill never calls the model (Codex P2 on #5632)', async () => {
    const current = Object.fromEntries(voiceFieldsFor('cockroach').map((field) => [field.key, field.options[0]]));
    expect(await readTypedFacts({ note: ROACH_NOTE, findingsType: 'cockroach', current }))
      .toMatchObject({ status: 'nothing_to_fill', type: 'cockroach', values: {}, unclearFields: [] });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    // One field still open is read for.
    dispatchWithFallback.mockResolvedValue(answer(fieldsOf('cockroach', {})));
    const { species, ...open } = current;
    expect(species).toBeTruthy();
    expect((await readTypedFacts({ note: ROACH_NOTE, findingsType: 'cockroach', current: open })).status).toBe('read');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });

  test('the schema is the form as served for the visit\'s service key, with the rating where the technician sets it', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ ...fieldsOf('rodent_trapping', {}), score: { said: false, value: 0, quote: '' } }));
    await readTypedFacts({ note: 'Checked the traps.', findingsType: 'rodent_trapping', serviceKey: 'rodent_trapping' });
    const { jsonSchema } = dispatchWithFallback.mock.calls[0][1];
    expect(jsonSchema.properties.fields.required).toEqual(voiceFieldsFor('rodent_trapping', { serviceKey: 'rodent_trapping' }).map((field) => field.key));
    expect(jsonSchema.required).toEqual(['fields', 'score']);
  });

  test('a form whose score the technician sets is read for it until they hold one, every field set or not', async () => {
    const fields = voiceFieldsFor('rodent_trapping', { serviceKey: 'rodent_trapping' });
    const current = Object.fromEntries(fields.map((field) => [field.key, field.type === 'count' ? '4' : field.options[1] || field.options[0]]));
    dispatchWithFallback.mockResolvedValue(answer({ ...fieldsOf('rodent_trapping', {}), score: { said: false, value: 0, quote: '' } }));
    expect((await readTypedFacts({ note: 'Checked the traps.', findingsType: 'rodent_trapping', serviceKey: 'rodent_trapping', current })).status).toBe('read');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(await readTypedFacts({ note: 'Checked the traps.', findingsType: 'rodent_trapping', serviceKey: 'rodent_trapping', current, scoreSet: true }))
      .toMatchObject({ status: 'nothing_to_fill' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
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
    mockProfile = { serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' };
    expect((await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE })).body).toEqual({ available: false });
    // New-construction pre-treat shares the termite treatment form and is out.
    mockProfile = { serviceKey: 'termite_pretreatment', findingsType: 'termite_treatment' };
    expect((await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE })).body).toEqual({ available: false });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('the form\'s present values judge the fill and are never answered back', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    mockProfile = { serviceKey: 'cockroach_control', findingsType: 'cockroach' };
    mockDbCurrent = serviceDb(SERVICE, []);
    dispatchWithFallback.mockResolvedValue(answer(fieldsOf('cockroach', {
      species: { value: 'German', quote: 'German roaches' },
      activity_level: { value: 'Heavy', quote: 'heavy' },
    })));
    const res = await invoke({ serviceId: 'svc-1' }, { note: ROACH_NOTE, current: { species: 'American' } });
    expect(res.body).toMatchObject({ available: true, status: 'read', values: { activity_level: 'Heavy' } });
    expect(res.body.values).not.toHaveProperty('species');
    expect(JSON.stringify(res.body)).not.toContain('American');
  });

  test('the route reads the form as served for the visit\'s own service key and passes whether the client holds a score', async () => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    mockProfile = { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' };
    mockDbCurrent = serviceDb(SERVICE, []);
    const fields = voiceFieldsFor('rodent_trapping', { serviceKey: 'rodent_trapping' });
    dispatchWithFallback.mockResolvedValue(answer({ ...fieldsOf('rodent_trapping', {}), score: { said: false, value: 0, quote: '' } }));
    await invoke({ serviceId: 'svc-1' }, { note: 'Checked the traps.' });
    expect(dispatchWithFallback.mock.calls[0][1].jsonSchema.properties.fields.required).toEqual(fields.map((field) => field.key));
    const current = Object.fromEntries(fields.map((field) => [field.key, field.type === 'count' ? '4' : field.options[1] || field.options[0]]));
    const res = await invoke({ serviceId: 'svc-1' }, { note: 'Checked the traps.', current, scoreSet: true });
    expect(res.body).toMatchObject({ available: true, status: 'nothing_to_fill' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
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
