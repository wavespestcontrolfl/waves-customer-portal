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
// What one reading says about one place, whatever else the note holds the
// sheet on: heard, unclear, or neither.
const placeIn = (facts, label) => {
  if (facts.areas.some((entry) => entry.area === label)) return 'heard';
  return facts.unclearAreas.includes(label) ? 'unclear' : 'none';
};

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
    // A place heard on a quote the note does not hold is unresolved (the
    // sheet holds), never recorded and never silently dropped; so is what the
    // note itself treats that the reading left out (outside, the ants, the
    // spray around the house).
    expect(facts).toEqual({ areas: [], unclearAreas: ['Outside', 'Garage'], pests: [], unclearPests: ['ants'], spray: null, unclearSpray: true, noSpray: false });
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

  test('a pest whose own quote says it was not there is dropped in code', () => {
    const note = 'No roaches were found under the sink. Treated for ants along the patio. Checked for spiders, none found.';
    const facts = validateVoiceFacts({
      areas: [],
      pests: [
        { name: 'roaches', quote: 'No roaches were found' },
        { name: 'ants', quote: 'Treated for ants along the patio' },
        { name: 'spiders', quote: 'Checked for spiders, none found' },
      ],
      spray: { method: 'not_said', quote: '' },
    }, note);
    expect(facts.pests.map((pest) => pest.name)).toEqual(['ants']);
  });

  test('an area whose own quote says no product went down there is dropped in code', () => {
    const note = 'Did not treat inside, customer asked us to skip it. Sprayed around the outside of the house.';
    const facts = validateVoiceFacts({
      areas: [
        { area: 'inside', quote: 'Did not treat inside' },
        { area: 'outside', quote: 'Sprayed around the outside of the house' },
      ],
      pests: [],
      spray: { method: 'perimeter', quote: 'Sprayed around the outside of the house' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside']);
    expect(facts.unclearAreas).toEqual(['Inside']);
  });

  test('a denial in the note stands even when the quote leaves it out', () => {
    const note = 'Did not treat inside. No roaches were found. Didn\'t spray around the outside. Checked for spiders, none found.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'treat inside' }, { area: 'outside', quote: 'spray around the outside' }],
      pests: [{ name: 'roaches', quote: 'roaches were found' }, { name: 'spiders', quote: 'Checked for spiders' }],
      spray: { method: 'perimeter', quote: 'spray around the outside' },
    }, note);
    // A denied area is never recorded and never silently dropped: the sheet
    // asks for it plainly.
    // The perimeter heard on a denied quote is unclear too: never a spot treatment.
    expect(facts).toEqual({ areas: [], unclearAreas: ['Inside', 'Outside'], pests: [], unclearPests: [], spray: null, unclearSpray: true, noSpray: false });
  });

  test('an inexact quote for a place never drops it silently', () => {
    const note = 'Baited the kitchen counter. Sprayed around the outside of the house.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'baited inside the kitchen' }, { area: 'outside', quote: 'Sprayed around the outside of the house' }],
      pests: [],
      spray: { method: 'perimeter', quote: 'Sprayed around the outside of the house' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside']);
    expect(facts.unclearAreas).toEqual(['Inside']);
  });

  test('a denial of something said before the treatment never denies it', () => {
    const note = 'No activity inside but sprayed the kitchen baseboards. Sprayed around the outside of the house.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'sprayed the kitchen baseboards' }, { area: 'outside', quote: 'Sprayed around the outside of the house' }],
      pests: [],
      spray: { method: 'perimeter', quote: 'Sprayed around the outside of the house' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Inside', 'Outside']);
    expect(facts.unclearAreas).toEqual([]);
  });

  test('a denial about something else in the sentence never drops a fact', () => {
    const note = 'No ants inside, sprayed around the outside of the house, no activity seen. Treated for ghost ants on the patio.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'sprayed around the outside of the house' }],
      pests: [{ name: 'ghost ants', quote: 'Treated for ghost ants on the patio' }],
      spray: { method: 'perimeter', quote: 'sprayed around the outside of the house' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside']);
    expect(facts.pests.map((pest) => pest.name)).toEqual(['ghost ants']);
    expect(facts.spray).toMatchObject({ method: 'perimeter' });
  });

  test('a negative after a fact is about something else (codex r3 on #5538)', () => {
    const note = 'Sprayed around the outside of the house with no issues. Baited inside, nothing found.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Sprayed around the outside of the house' }, { area: 'inside', quote: 'Baited inside' }],
      pests: [],
      spray: { method: 'perimeter', quote: 'Sprayed around the outside of the house' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Inside', 'Outside']);
    expect(facts.unclearAreas).toEqual([]);
    expect(facts.spray).toMatchObject({ method: 'perimeter' });
  });

  test('a negative inside the quote but after what it asserts is about something else too (codex r4 on #5538)', () => {
    const sentence = 'Sprayed around the outside of the house with no issues';
    const note = `${sentence}. Treated for roaches without any trouble. No roaches seen so treated the kitchen baseboards.`;
    const facts = validateVoiceFacts({
      areas: [{ area: 'outside', quote: sentence }, { area: 'inside', quote: 'treated the kitchen baseboards' }],
      pests: [{ name: 'roaches', quote: 'Treated for roaches without any trouble' }],
      spray: { method: 'perimeter', quote: sentence },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Inside', 'Outside']);
    expect(facts.unclearAreas).toEqual([]);
    expect(facts.pests.map((pest) => pest.name)).toEqual(['roaches']);
    expect(facts.spray).toMatchObject({ method: 'perimeter' });
  });

  test('a quote that starts with an earlier statement is judged at what it asserts (pre-push P1)', () => {
    const note = 'No activity inside but sprayed the kitchen baseboards. No ants out front but treated for roaches by the pool.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'No activity inside but sprayed the kitchen baseboards' }],
      pests: [{ name: 'roaches', quote: 'No ants out front but treated for roaches by the pool' }],
      spray: { method: 'spot', quote: 'No activity inside but sprayed the kitchen baseboards' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Inside']);
    expect(facts.unclearAreas).toEqual([]);
    expect(facts.pests.map((pest) => pest.name)).toEqual(['roaches']);
    expect(facts.spray).toMatchObject({ method: 'spot' });
  });

  test('a place quoted without the words that say product went down is unclear, never treated (Codex #5538)', () => {
    const note = 'Saw ants in the kitchen; treated the exterior.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'ants in the kitchen' }, { area: 'outside', quote: 'treated the exterior' }],
      pests: [],
      spray: { method: 'not_said', quote: '' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside']);
    expect(facts.unclearAreas).toEqual(['Inside']);
  });

  test('a short denial right after a fact denies it, comma or not, and a quote with no treatment word is read whole', () => {
    const note = 'Checked for spiders none found. Inside not treated. The garage was not needed. Nothing outside.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'Inside' }, { area: 'garage', quote: 'The garage' }, { area: 'outside', quote: 'Nothing outside' }],
      pests: [{ name: 'spiders', quote: 'Checked for spiders' }],
      spray: { method: 'not_said', quote: '' },
    }, note);
    expect(facts).toEqual({ areas: [], unclearAreas: ['Inside', 'Outside', 'Garage'], pests: [], unclearPests: [], spray: null, unclearSpray: false, noSpray: false });
  });

  test('a negative earlier in the sentence is about something else (codex r5 on #5538)', () => {
    const note = 'Customer was not home and I sprayed around the outside of the house. There were no issues so we also treated for ants.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Customer was not home and I sprayed around the outside of the house' }],
      pests: [{ name: 'ants', quote: 'There were no issues so we also treated for ants' }],
      spray: { method: 'perimeter', quote: 'sprayed around the outside of the house' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside']);
    expect(facts.unclearAreas).toEqual([]);
    expect(facts.pests.map((pest) => pest.name)).toEqual(['ants']);
    expect(facts.spray).toMatchObject({ method: 'perimeter' });
  });

  test('words that say a treatment was left out deny it (GitHub Codex P1 on #5538)', () => {
    const note = 'Skipped treating the garage; sprayed outside for ants. Avoided spraying inside because of the baby.';
    const facts = validateVoiceFacts({
      areas: [
        { area: 'garage', quote: 'Skipped treating the garage' },
        { area: 'outside', quote: 'sprayed outside for ants' },
        { area: 'inside', quote: 'spraying inside' },
      ],
      pests: [],
      spray: { method: 'not_said', quote: '' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside']);
    expect(facts.unclearAreas).toEqual(['Inside', 'Garage']);
  });

  test('a quote that calls its treatment undone, or denies its own place, is unclear (GitHub Codex P1 on #5538)', () => {
    const note = 'Left the garage untreated, sprayed outside. Sprayed outside but not the garage. Treated everything except inside.';
    const read = (area, quote) => validateVoiceFacts({ areas: [{ area, quote }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    expect(placeIn(read('garage', 'Left the garage untreated, sprayed outside'), 'Garage')).toBe('unclear');
    expect(placeIn(read('garage', 'Sprayed outside but not the garage'), 'Garage')).toBe('unclear');
    expect(placeIn(read('inside', 'Treated everything except inside'), 'Inside')).toBe('unclear');
    expect(read('outside', 'Sprayed outside but not the garage').areas.map((entry) => entry.area)).toEqual(['Outside']);
  });

  test('a spray its own words leave out is unclear, never a perimeter (GitHub Codex P1 on #5538)', () => {
    const note = 'Held off on spraying around the house because of rain. The perimeter was left untreated. Baited the kitchen.';
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note);
    expect(read({ method: 'perimeter', quote: 'spraying around the house' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'perimeter', quote: 'The perimeter was left untreated' })).toMatchObject({ spray: null, unclearSpray: true });
  });

  test('a refusal, an omission or a placement about something else never holds a place', () => {
    const note = 'Customer refused interior service, sprayed around the outside of the house. Left out a glue board in the garage and left it alone. Sprayed around the house except the lanai.';
    const facts = validateVoiceFacts({
      areas: [
        { area: 'outside', quote: 'sprayed around the outside of the house' },
        { area: 'garage', quote: 'Left out a glue board in the garage and left it alone' },
      ],
      pests: [],
      spray: { method: 'perimeter', quote: 'Sprayed around the house except the lanai' },
    }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Outside', 'Garage']);
    expect(facts.unclearAreas).toEqual([]);
    expect(facts.spray).toMatchObject({ method: 'perimeter' });
  });

  test('with more than one pest heard, only those tied to a treatment are targets (GitHub Codex P1 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('Saw ants inside; treated outside for spiders.', [
      { name: 'ants', quote: 'Saw ants inside' },
      { name: 'spiders', quote: 'treated outside for spiders' },
    ])).toEqual(['spiders']);
    expect(read('Treated for ants in the kitchen and sprayed the eaves for spiders.', [
      { name: 'ants', quote: 'Treated for ants in the kitchen' },
      { name: 'spiders', quote: 'sprayed the eaves for spiders' },
    ])).toEqual(['ants', 'spiders']);
    expect(read("Didn't treat for roaches; sprayed outside for ants.", [
      { name: 'roaches', quote: "Didn't treat for roaches" },
      { name: 'ants', quote: 'sprayed outside for ants' },
    ])).toEqual(['ants']);
  });

  test('a single pest heard stays the target, unless its own words deny the treatment', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('Ghost ants on the kitchen counter, light. Baited the counter edge.', [
      { name: 'ghost ants', quote: 'Ghost ants on the kitchen counter' },
    ])).toEqual(['ghost ants']);
    expect(read("Didn't treat for roaches today.", [{ name: 'roaches', quote: "Didn't treat for roaches" }])).toEqual([]);
  });

  test('a spray read as a method its own words do not support is unclear (GitHub Codex P1 on #5538)', () => {
    const note = 'Spot sprayed the garage door frames. Sprayed all the way around the house. Spot sprayed around the house where ants trailed.';
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note);
    expect(read({ method: 'perimeter', quote: 'Spot sprayed the garage door frames' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'spot', quote: 'Sprayed all the way around the house' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'perimeter', quote: 'Spot sprayed around the house where ants trailed' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'perimeter', quote: 'Sprayed all the way around the house' }).spray).toMatchObject({ method: 'perimeter' });
    expect(read({ method: 'spot', quote: 'Spot sprayed the garage door frames' }).spray).toMatchObject({ method: 'spot' });
    // "Spot" with where the spots were is a spot spray (pre-push P1), in a
    // note that sprays nowhere else around the house.
    expect(validateVoiceFacts({ areas: [], pests: [], spray: { method: 'spot', quote: 'Spot sprayed around the house where ants trailed' } }, 'Spot sprayed around the house where ants trailed.'))
      .toMatchObject({ spray: { method: 'spot' }, unclearSpray: false });
  });

  test('a pest named after its sentence\'s treatment shares it (codex local r18 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('Treated for ants outside and roaches inside.', [
      { name: 'ants', quote: 'Treated for ants outside' },
      { name: 'roaches', quote: 'roaches inside' },
    ])).toEqual(['ants', 'roaches']);
    expect(read('Saw ants inside, treated outside for spiders.', [
      { name: 'ants', quote: 'Saw ants inside' },
      { name: 'spiders', quote: 'treated outside for spiders' },
    ])).toEqual(['spiders']);
    expect(read("Didn't treat for ants or roaches. Sprayed for spiders.", [
      { name: 'roaches', quote: 'roaches' },
      { name: 'spiders', quote: 'Sprayed for spiders' },
    ])).toEqual(['spiders']);
  });

  test('a place is judged by the treatment that governs it, across "and" (codex local r19 on #5538)', () => {
    const note = 'Sprayed outside and did not treat inside.';
    const read = (area) => validateVoiceFacts({ areas: [{ area, quote: 'Sprayed outside and did not treat inside' }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    expect(placeIn(read('inside'), 'Inside')).toBe('unclear');
    expect(placeIn(read('outside'), 'Outside')).toBe('heard');
  });

  test('an observation between a treatment and a pest breaks the shared treatment (codex local r19 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('Treated for ants outside and saw roaches inside.', [
      { name: 'ants', quote: 'Treated for ants outside' },
      { name: 'roaches', quote: 'saw roaches inside' },
    ])).toEqual(['ants']);
    expect(read('Treated for ants outside and checked for roaches inside.', [
      { name: 'ants', quote: 'Treated for ants outside' },
      { name: 'roaches', quote: 'roaches inside' },
    ])).toEqual(['ants']);
  });

  test('pests named before their treatment share it, unless only seen (codex local r21 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('For ants and roaches I sprayed around the house.', [
      { name: 'ants', quote: 'ants' },
      { name: 'roaches', quote: 'roaches' },
    ])).toEqual(['ants', 'roaches']);
    expect(read('For ants and roaches, I sprayed around the house.', [
      { name: 'ants', quote: 'For ants' },
      { name: 'roaches', quote: 'roaches' },
    ])).toEqual(['ants', 'roaches']);
    expect(read('Ants seen in the kitchen, sprayed for roaches.', [
      { name: 'ants', quote: 'Ants seen in the kitchen' },
      { name: 'roaches', quote: 'sprayed for roaches' },
    ])).toEqual(['roaches']);
    expect(read("For roaches I didn't spray. Sprayed outside for ants.", [
      { name: 'roaches', quote: 'For roaches' },
      { name: 'ants', quote: 'Sprayed outside for ants' },
    ])).toEqual(['ants']);
    // The nearest treatment before a pest decides: a denied one is never
    // passed over for an earlier one.
    expect(read('Treated for ants, did not spray for roaches.', [
      { name: 'ants', quote: 'Treated for ants' },
      { name: 'roaches', quote: 'roaches' },
    ])).toEqual(['ants']);
  });

  test('a quote of the whole sentence never ties a pest only seen there (pre-push P1 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    const sentence = 'Treated for ants outside and saw roaches inside.';
    expect(read(sentence, [
      { name: 'ants', quote: sentence },
      { name: 'roaches', quote: sentence },
    ])).toEqual(['ants']);
    expect(read('Saw ants inside, treated outside for spiders.', [
      { name: 'ants', quote: 'Saw ants inside, treated outside for spiders' },
      { name: 'spiders', quote: 'Saw ants inside, treated outside for spiders' },
    ])).toEqual(['spiders']);
    // A treatment after an observation is the observed pest's, unless it
    // names another pest after it.
    expect(read('Found roaches under the sink and sprayed. Treated outside for ants.', [
      { name: 'roaches', quote: 'Found roaches under the sink and sprayed' },
      { name: 'ants', quote: 'Treated outside for ants' },
    ])).toEqual(['roaches', 'ants']);
    expect(read('Saw roaches inside and sprayed for ants.', [
      { name: 'roaches', quote: 'Saw roaches inside and sprayed for ants' },
      { name: 'ants', quote: 'sprayed for ants' },
    ])).toEqual(['ants']);
  });

  test('an undone place in another clause is that place\'s, never the fact\'s (codex local r21 on #5538)', () => {
    const note = 'Sprayed inside for ants, left the garage untreated. Sprayed around the house, garage untreated. The inside was left untreated, sprayed outside. The perimeter was left unsprayed, sprayed the kitchen.';
    const area = (name, quote) => validateVoiceFacts({ areas: [{ area: name, quote }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    const spray = (quote) => validateVoiceFacts({ areas: [], pests: [], spray: { method: 'perimeter', quote } }, note);
    expect(placeIn(area('inside', 'Sprayed inside for ants, left the garage untreated'), 'Inside')).toBe('heard');
    expect(placeIn(area('garage', 'Sprayed inside for ants, left the garage untreated'), 'Garage')).toBe('unclear');
    expect(spray('Sprayed around the house, garage untreated').spray).toMatchObject({ method: 'perimeter' });
    // The fact's own place, or way of spraying, undone in its own clause
    // still holds it.
    expect(placeIn(area('inside', 'The inside was left untreated, sprayed outside'), 'Inside')).toBe('unclear');
    expect(spray('The perimeter was left unsprayed, sprayed the kitchen')).toMatchObject({ spray: null, unclearSpray: true });
  });

  test('a treatment names only the pests up to the next treatment word (codex local r22 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('For ants I baited inside and sprayed outside for roaches.', [
      { name: 'ants', quote: 'ants' },
      { name: 'roaches', quote: 'roaches' },
    ])).toEqual(['ants', 'roaches']);
  });

  test('a sentence that only names the pests takes the treatment the note gives them (codex local r23 on #5538)', () => {
    const read = (note, names) => validateVoiceFacts({ areas: [], pests: names.map((name) => ({ name, quote: name })), spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('The target pests were ants and roaches. Applied bait inside the kitchen for those pests.', ['ants', 'roaches'])).toEqual(['ants', 'roaches']);
    expect(read('Sprayed the kitchen. Ants and roaches were the issue.', ['ants', 'roaches'])).toEqual(['ants', 'roaches']);
    // A treatment that names another pest is that pest's, across sentences
    // and through a phrase ("applied bait for roaches").
    expect(read('Sprayed for ants. Customer mentioned roaches.', ['ants', 'roaches'])).toEqual(['ants']);
    expect(read('The pests were ants and roaches. Applied bait for roaches.', ['ants', 'roaches'])).toEqual(['roaches']);
    // A denied treatment ties nothing.
    expect(read("Ants and roaches in the kitchen. Didn't spray today.", ['ants', 'roaches'])).toEqual([]);
  });

  test('an undone word is said of what it names, never of another place in its clause (codex local r22 on #5538)', () => {
    const note = 'Sprayed inside for ants and left the garage untreated. Sprayed outside and the inside was left untreated. Sprayed outside, left the garage and the shed untreated.';
    const area = (name, quote) => validateVoiceFacts({ areas: [{ area: name, quote }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    expect(placeIn(area('inside', 'Sprayed inside for ants and left the garage untreated'), 'Inside')).toBe('heard');
    expect(placeIn(area('garage', 'Sprayed inside for ants and left the garage untreated'), 'Garage')).toBe('unclear');
    expect(placeIn(area('outside', 'Sprayed outside and the inside was left untreated'), 'Outside')).toBe('heard');
    expect(placeIn(area('inside', 'Sprayed outside and the inside was left untreated'), 'Inside')).toBe('unclear');
    expect(placeIn(area('garage', 'Sprayed outside, left the garage and the shed untreated'), 'Garage')).toBe('unclear');
  });

  test('a place is judged by the treatment of its own clause (codex local r18 on #5538)', () => {
    const note = 'Did not treat inside but sprayed outside for ants.';
    const read = (area) => validateVoiceFacts({ areas: [{ area, quote: 'Did not treat inside but sprayed outside for ants' }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    expect(placeIn(read('outside'), 'Outside')).toBe('heard');
    expect(placeIn(read('inside'), 'Inside')).toBe('unclear');
  });

  test('a perimeter may name the house with ordinary words in between (codex local r18 on #5538)', () => {
    const note = "Sprayed around the entire house for ants. Sprayed around the customer's house too. Sprayed around the back of the house.";
    const read = (quote) => validateVoiceFacts({ areas: [], pests: [], spray: { method: 'perimeter', quote } }, note);
    expect(read('Sprayed around the entire house for ants').spray).toMatchObject({ method: 'perimeter' });
    expect(read("Sprayed around the customer's house too").spray).toMatchObject({ method: 'perimeter' });
    expect(read('Sprayed around the back of the house')).toMatchObject({ spray: null, unclearSpray: true });
  });

  test('a fact said twice stands when one saying is not denied', () => {
    const note = 'Did not treat inside yesterday. Today we treat inside the kitchen.';
    const facts = validateVoiceFacts({ areas: [{ area: 'inside', quote: 'treat inside' }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    expect(facts.areas.map((entry) => entry.area)).toEqual(['Inside']);
  });

  test('a perimeter spray the note does not hold up is unclear, never a spot treatment (GitHub Codex P1 on #5538)', () => {
    const note = 'Sprayed all the way around the house. Spot sprayed the garage door frames.';
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note);
    expect(read({ method: 'perimeter', quote: 'sprayed around the house' })).toMatchObject({ spray: null, unclearSpray: true, noSpray: false });
    expect(read({ method: 'perimeter', quote: 'Sprayed all the way around the house' })).toMatchObject({ spray: { method: 'perimeter' }, unclearSpray: false });
    // A spot reading of a note that sprayed all the way around the house left
    // the perimeter out: unclear (GitHub Codex on #5538).
    expect(read({ method: 'spot', quote: 'spot sprayed the frames' })).toMatchObject({ spray: null, unclearSpray: true, noSpray: false });
  });

  test('"didn\'t spray" in the note\'s own words is no spraying, and a spot spray its own words deny is unclear (GitHub Codex P1 on #5538)', () => {
    const note = "Didn't spray today; placed bait inside along the counter.";
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note);
    expect(read({ method: 'none', quote: "Didn't spray today" })).toMatchObject({ spray: null, unclearSpray: false, noSpray: true });
    // Never on words the note does not hold (that is unclear, so the sheet
    // asks), and "not said" of a note that says it did not spray is unclear
    // too, never a spot spray (GitHub Codex on #5538).
    expect(read({ method: 'none', quote: 'did not spray anything' })).toMatchObject({ noSpray: false, unclearSpray: true });
    expect(read({ method: 'not_said', quote: '' })).toMatchObject({ spray: null, unclearSpray: true, noSpray: false });
    expect(read({ method: 'spot', quote: "Didn't spray today" })).toMatchObject({ spray: null, unclearSpray: true, noSpray: false });
  });

  test('a pest denial is its own pest\'s, and work from another visit is not today\'s (codex local r25 on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note);
    // "ants, no roaches" denies the roaches, never the ants.
    expect(read('Sprayed outside for ants, no roaches. Baited inside for spiders.', [
      { name: 'ants', quote: 'Sprayed outside for ants' },
      { name: 'spiders', quote: 'Baited inside for spiders' },
    ]).pests.map((pest) => pest.name)).toEqual(['ants', 'spiders']);
    // What was done on an earlier visit holds nothing today, and is no target.
    const history = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Today I sprayed outside for ants' }],
      pests: [{ name: 'ants', quote: 'sprayed outside for ants' }, { name: 'roaches', quote: 'sprayed inside for roaches' }],
      spray: { method: 'not_said', quote: '' },
    }, 'Last visit we sprayed inside for roaches. Today I sprayed outside for ants. Sprayed the garage yesterday.');
    expect(history).toMatchObject({ unclearAreas: [], unclearPests: [], unclearSpray: false });
    expect(history.pests.map((pest) => pest.name)).toEqual(['ants']);
    // "Same as last time" compares; it says nothing about when.
    expect(placeIn(validateVoiceFacts({ areas: [{ area: 'inside', quote: 'Treated inside same as last time' }], pests: [], spray: { method: 'not_said', quote: '' } },
      'Treated inside same as last time.'), 'Inside')).toBe('heard');
  });

  test('a spray reading needs its own grounded quote that says it sprayed (pre-push P1 on #5538)', () => {
    const note = 'Did not spray today; placed bait inside for ants.';
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note);
    expect(read({ method: 'spot', quote: 'placed bait inside for ants' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'spot', quote: 'spot sprayed the kitchen' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'perimeter', quote: 'placed bait inside for ants' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'none', quote: 'Did not spray today' })).toMatchObject({ spray: null, unclearSpray: false, noSpray: true });
  });

  test('a spray reading is judged at its own spray word, never another treatment (codex local r26 on #5538)', () => {
    const note = 'Baited inside for ants and did not spray the perimeter. Sprayed around the house and did not bait the garage.';
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note);
    expect(read({ method: 'perimeter', quote: 'Baited inside for ants and did not spray the perimeter' })).toMatchObject({ spray: null, unclearSpray: true });
    expect(read({ method: 'perimeter', quote: 'Sprayed around the house and did not bait the garage' })).toMatchObject({ spray: { method: 'perimeter' }, unclearSpray: false });
  });

  test('"spot" qualifies only its own spray, so a mixed note never reads as spot alone (codex local r27 on #5538)', () => {
    const mixed = 'Sprayed the perimeter outside for ants and spot sprayed inside for roaches.';
    expect(validateVoiceFacts({ areas: [], pests: [], spray: { method: 'spot', quote: 'spot sprayed inside for roaches' } }, mixed))
      .toMatchObject({ unclearSpray: true });
    expect(validateVoiceFacts({ areas: [], pests: [], spray: { method: 'not_said', quote: '' } }, mixed))
      .toMatchObject({ unclearSpray: true });
    // An untreated place in the clause is that place's, never the perimeter's.
    expect(validateVoiceFacts({ areas: [], pests: [], spray: { method: 'spot', quote: 'spot sprayed the kitchen' } },
      'Sprayed around the house and left the garage untreated. Spot sprayed the kitchen.')).toMatchObject({ unclearSpray: true });
  });

  test('how the sprays went down stands only on a grounded quote that says it happened', () => {
    const note = 'Sprayed around the outside of the house. Didn\'t spray the garage door frames.';
    const read = (spray) => validateVoiceFacts({ areas: [], pests: [], spray }, note).spray;
    expect(read({ method: 'perimeter', quote: 'Sprayed around the outside of the house' }))
      .toEqual({ method: 'perimeter', quote: 'sprayed around the outside of the house' });
    expect(read({ method: 'spot', quote: "Didn't spray the garage door frames" })).toBeNull();
    expect(read({ method: 'perimeter', quote: 'sprayed the whole perimeter' })).toBeNull();
    expect(read({ method: 'not_said', quote: '' })).toBeNull();
    expect(read(undefined)).toBeNull();
  });

  test('a malformed answer is no facts', () => {
    const none = { areas: [], unclearAreas: [], pests: [], unclearPests: [], spray: null, unclearSpray: false, noSpray: false };
    const quietNote = 'Customer was not home; left a door hanger.';
    expect(validateVoiceFacts(null, quietNote)).toEqual(none);
    expect(validateVoiceFacts({ areas: 'inside', pests: {} }, quietNote)).toEqual(none);
  });

  test('a place, pest or spray the note treats that the reading left out holds the sheet (GitHub Codex on #5538)', () => {
    const facts = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Sprayed inside and outside' }],
      pests: [{ name: 'ants', quote: 'for ants' }],
      spray: { method: 'not_said', quote: '' },
    }, 'Sprayed inside and outside for ants and roaches. Sprayed all the way around the house.');
    expect(facts).toMatchObject({ unclearAreas: ['Inside'], unclearPests: ['roaches'], unclearSpray: true });
    // Nothing is held for a place only looked at, a pest not treated for, or a
    // spray the note denies at a place.
    const quiet = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Sprayed outside for ants' }],
      pests: [{ name: 'ants', quote: 'Sprayed outside for ants' }],
      spray: { method: 'spot', quote: 'Sprayed outside for ants' },
    }, "Checked the bait stations inside, no roaches seen. Sprayed outside for ants. Didn't spray the garage.");
    expect(quiet).toMatchObject({ areas: [{ area: 'Outside' }], unclearAreas: [], pests: [{ name: 'ants' }], unclearPests: [], unclearSpray: false });
  });

  test('work said for later, and a pest the note denies, never count as treated (codex local r24 on #5538)', () => {
    // A denied pest is never one the reading left out.
    expect(validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Sprayed outside for ants' }],
      pests: [{ name: 'ants', quote: 'Sprayed outside for ants' }],
      spray: { method: 'not_said', quote: '' },
    }, "Sprayed outside for ants, no roaches. Roaches weren't an issue.").unclearPests).toEqual([]);
    // Planned work is not a place, pest or spray treated today.
    const note = 'Sprayed outside for ants. Will spray inside next time. Need to treat for roaches next visit. Going to spray around the house next month.';
    const facts = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Sprayed outside for ants' }],
      pests: [{ name: 'ants', quote: 'Sprayed outside for ants' }, { name: 'roaches', quote: 'treat for roaches' }],
      spray: { method: 'not_said', quote: '' },
    }, note);
    expect(facts).toMatchObject({ unclearAreas: [], unclearPests: [], unclearSpray: false });
    expect(facts.pests.map((pest) => pest.name)).toEqual(['ants']);
    // Nor when the reading quotes the plan without its future words: the
    // note decides where the quote stands (pre-push P1 on #5538).
    const trimmed = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Treated outside for ants' }, { area: 'inside', quote: 'spray inside' }],
      pests: [{ name: 'ants', quote: 'Treated outside for ants' }],
      spray: { method: 'spot', quote: 'spray inside' },
    }, "Treated outside for ants. Will spray inside tomorrow. I'll treat the garage next time.");
    expect(placeIn(trimmed, 'Inside')).toBe('unclear');
    expect(placeIn(trimmed, 'Garage')).toBe('none');
    expect(trimmed).toMatchObject({ spray: null, unclearSpray: true });
    // A time said for later is its own action's, never another's in the
    // clause (pre-push P1 on #5538).
    const mixed = validateVoiceFacts({
      areas: [{ area: 'outside', quote: 'Sprayed outside for ants' }],
      pests: [{ name: 'ants', quote: 'Sprayed outside for ants' }],
      spray: { method: 'not_said', quote: '' },
    }, 'Sprayed outside for ants and will treat inside next visit.');
    expect(mixed).toMatchObject({ areas: [{ area: 'Outside' }], unclearAreas: [], pests: [{ name: 'ants' }], unclearPests: [], unclearSpray: false });
    // Nor when the reading itself quotes the plan.
    const planned = validateVoiceFacts({
      areas: [{ area: 'inside', quote: 'Will spray inside next time' }],
      pests: [],
      spray: { method: 'perimeter', quote: 'Going to spray around the house next month' },
    }, note);
    expect(placeIn(planned, 'Inside')).toBe('unclear');
    expect(planned).toMatchObject({ spray: null, unclearSpray: true });
  });

  test('a place only looked at, or a quote naming only another place, is unclear (GitHub Codex on #5538)', () => {
    const note = 'Checked the bait stations inside; treated outside for ants.';
    const read = (area, quote) => validateVoiceFacts({ areas: [{ area, quote }, { area: 'outside', quote: 'treated outside for ants' }], pests: [], spray: { method: 'not_said', quote: '' } }, note);
    expect(placeIn(read('inside', 'Checked the bait stations inside'), 'Inside')).toBe('unclear');
    expect(placeIn(read('inside', 'treated outside'), 'Inside')).toBe('unclear');
    expect(placeIn(read('outside', 'treated outside for ants'), 'Outside')).toBe('heard');
  });

  test('a pest only seen is no target, alone or after another pest\'s treatment (GitHub Codex on #5538)', () => {
    const read = (note, pests) => validateVoiceFacts({ areas: [], pests, spray: { method: 'not_said', quote: '' } }, note).pests.map((pest) => pest.name);
    expect(read('Saw spiders by the shed but did not treat them; baited inside.', [{ name: 'spiders', quote: 'Saw spiders by the shed' }])).toEqual([]);
    expect(read('Treated outside for spiders, and ants were seen in the kitchen.', [
      { name: 'spiders', quote: 'Treated outside for spiders' },
      { name: 'ants', quote: 'ants were seen in the kitchen' },
    ])).toEqual(['spiders']);
    // Seen, then treated in the next sentence, is a target.
    expect(read('Saw roaches under the sink. Sprayed under the sink.', [{ name: 'roaches', quote: 'Saw roaches under the sink' }])).toEqual(['roaches']);
  });
});

describe('readVoiceFacts', () => {
  test('reads the note through the fast structured lane and returns what the sheet records', async () => {
    dispatchWithFallback.mockResolvedValue(answer({
      areas: [{ area: 'inside', quote: 'Baited the counter edge' }, { area: 'outside', quote: 'sprayed around the outside of the house' }],
      pests: [{ name: 'ghost ants', quote: 'Ghost ants on the kitchen counter' }],
      spray: { method: 'perimeter', quote: 'sprayed around the outside of the house' },
    }));
    const facts = await readVoiceFacts(NOTE);
    expect(facts).toMatchObject({ status: 'read', areas: ['Inside', 'Outside'], unclearAreas: [], pests: ['ghost ants'], spray: 'perimeter' });
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

  test('a note past the cap is refused as too long, never cut short', async () => {
    const { MAX_NOTE_CHARS } = require('../services/visit-voice-facts');
    const long = `${'Sprayed around the outside of the house. '.repeat(Math.ceil(MAX_NOTE_CHARS / 40))}Baited the kitchen counter.`;
    expect(long.length).toBeGreaterThan(MAX_NOTE_CHARS);
    expect(await readVoiceFacts(long)).toMatchObject({ status: 'too_long', areas: [], pests: [] });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
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
