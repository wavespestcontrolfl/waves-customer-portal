// The lawn pre-visit lines of the 24-hour reminder (GATE_LAWN_PREVISIT_LINE): the sentence table, the watering-day helper, and the
// visit reader with a table-driven fake knex. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const logger = require('../services/logger');
const { buildLawnPrevisitLine, lawnPrevisitLineForVisit } = require('../services/lawn-previsit-line');
const { wateringWeekdayForAddress } = require('../config/irrigation-restrictions');
const { countSegments } = require('../services/messaging/segment-counter');

const dog = (name) => ({ name, type: 'dog' });
const NORMAL = (who) => `Please keep sprinklers off tonight and tomorrow morning, unlock the gate, and keep ${who} inside while we treat.`;
const DAY = (who) => `Please unlock the gate and keep ${who} inside while we treat.`;
const LINK_LINE = 'Have pets? Add them here: portal.wavespestcontrol.com/?tab=property#pets';

describe('the sentence table', () => {
  test.each([
    ['one name', [dog('biscuit')], 'Biscuit'],
    ['two names', [dog('Biscuit'), { name: 'Mochi', species: 'cat' }], 'Biscuit and Mochi'],
    ['three names', [dog('Biscuit'), dog('Mochi'), dog('Rex')], 'Biscuit, Mochi and Rex'],
    ['four names', [dog('Biscuit'), dog('Mochi'), dog('Rex'), dog('Duke')], 'pets'],
    ['a pet with no usable name', [dog('1234')], 'pets'],
    ['a pet that is not a dog or cat', [{ name: 'Goldie', type: 'fish' }], 'pets'],
  ])('%s, normal day', (_label, pets, who) => {
    expect(buildLawnPrevisitLine({ petsStructured: pets })).toBe(NORMAL(who));
  });

  test('the home\'s watering day drops the sprinkler words', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [dog('Biscuit')], wateringDayClash: true })).toBe(DAY('Biscuit'));
  });

  test('a pet of any where is named, indoor or outdoor', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [{ ...dog('Biscuit'), indoor: 'indoor' }] })).toBe(NORMAL('Biscuit'));
  });

  test.each([['empty array', []], ['null', null], ['not an array', { name: 'Biscuit' }], ['a string that is not JSON', 'none'], ['entries that are not objects', ['x']]])(
    'no pet on file (%s): the pet link paragraph follows a blank line, and the sentence says pets',
    (_label, value) => {
      expect(buildLawnPrevisitLine({ petsStructured: value })).toBe(`${NORMAL('pets')}\n\n${LINK_LINE}`);
      expect(buildLawnPrevisitLine({ petsStructured: value, wateringDayClash: true })).toBe(`${DAY('pets')}\n\n${LINK_LINE}`);
    },
  );

  test('a pet on file, even one that is not named, gets no link paragraph; a JSON string is read like an array', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [{ name: 'Goldie', type: 'fish' }] })).not.toContain('Have pets?');
    expect(buildLawnPrevisitLine({ petsStructured: JSON.stringify([dog('Biscuit')]) })).toBe(NORMAL('Biscuit'));
  });

  test('a name that fails the copy screen falls back to the word pets', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [dog('Safe')] })).toBe(NORMAL('pets'));
  });

  test('copy rules: no "safe", no time or minute figure, no long brand name, GSM-7, three segments at most', () => {
    const texts = [
      buildLawnPrevisitLine({ petsStructured: [] }),
      buildLawnPrevisitLine({ petsStructured: [], wateringDayClash: true }),
      buildLawnPrevisitLine({ petsStructured: [dog('Biscuit'), dog('Mochi'), dog('Rex')] }),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/safe/i);
      expect(text).not.toMatch(/Waves Pest Control/);
      expect(text).not.toMatch(/\bminutes?\b|\bhours?\b|\d+\s*(am|pm)/i);
      expect(text).not.toMatch(/[^\x00-\x7F]/);
      expect(countSegments(text).segmentCount).toBeLessThanOrEqual(3);
    }
  });
});

describe('wateringWeekdayForAddress', () => {
  test.each([
    ['100 Example St', 1], ['101 Example St', 1], ['2 Example St', 2], ['13 Example St', 2], ['4 Example St', 3], ['5 Example St', 3],
    ['6 Example St', 4], ['7 Example St', 4], ['8 Example St', 5], ['9 Example St', 5], ['  1209 Example Loop', 5],
  ])('%s is weekday %i', (line, weekday) => {
    expect(wateringWeekdayForAddress(line)).toBe(weekday);
  });

  test('no house number: null', () => {
    expect(wateringWeekdayForAddress('Example Loop')).toBeNull();
    expect(wateringWeekdayForAddress('')).toBeNull();
    expect(wateringWeekdayForAddress(null)).toBeNull();
  });
});

describe('lawnPrevisitLineForVisit', () => {
  const OLD = { gate: process.env.GATE_LAWN_PREVISIT_LINE, policy: process.env.IRRIGATION_RESTRICTION_POLICY };
  const ONE_DAY_POLICY = JSON.stringify({
    maxDaysPerWeek: 1, effectiveFrom: '2026-01-01', expiresOn: '2030-01-01', label: 'Test order', hoursNote: 'in allowed hours',
    coverage: { counties: ['Manatee'], partial: ['Charlotte'] },
  });
  // 2026-11-17 9:00 AM ET is a Tuesday: a house number ending 2 or 3 waters that day.
  const TUESDAY = new Date('2026-11-17T14:00:00.000Z');
  const HOME = { service_type: 'Every 6 Weeks Lawn Care Service', visit_id: null, address_line1: '1203 Example Loop', city: 'Bradenton', zip: '34202' };

  // Table-driven fake knex: the visit read (`first` on the join), the member read (`select`), prefs and turf `first`.
  function fakeKnex({ visit = HOME, members = [], prefs = { pets_structured: [dog('Biscuit')] }, turf = { county: 'Manatee' } } = {}) {
    const reads = [];
    const knex = (table) => {
      reads.push(table);
      const c = {
        join: () => c, where: () => c, whereIn: () => c,
        first: async () => ({ 'scheduled_services as ss': visit, property_preferences: prefs, customer_turf_profiles: turf }[table]),
        select: async () => members,
      };
      return c;
    };
    knex.reads = reads;
    return knex;
  }
  const ask = (knex, extra = {}) => lawnPrevisitLineForVisit({ scheduledServiceId: 'svc-1', customerId: 'cust-1', apptTime: TUESDAY, knex, ...extra });

  beforeEach(() => {
    process.env.GATE_LAWN_PREVISIT_LINE = 'true';
    process.env.IRRIGATION_RESTRICTION_POLICY = ONE_DAY_POLICY;
    logger.warn.mockClear();
  });
  afterEach(() => {
    for (const [key, value] of [['GATE_LAWN_PREVISIT_LINE', OLD.gate], ['IRRIGATION_RESTRICTION_POLICY', OLD.policy]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test('a lawn visit at home on its watering day: the day sentence, naming the pets', async () => {
    expect(await ask(fakeKnex())).toBe(DAY('Biscuit'));
  });

  test('a lawn visit at home on another weekday: the normal sentence', async () => {
    expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: '1204 Example Loop' } }))).toBe(NORMAL('Biscuit'));
  });

  test.each([
    ['no policy in force', { policy: JSON.stringify({ ...JSON.parse(ONE_DAY_POLICY), expiresOn: '2026-10-01' }) }],
    ['a two-day policy', { policy: JSON.stringify({ ...JSON.parse(ONE_DAY_POLICY), maxDaysPerWeek: 2 }) }],
    ['a policy that does not cover the county', { policy: JSON.stringify({ ...JSON.parse(ONE_DAY_POLICY), coverage: { counties: ['Sarasota'], partial: [] } }) }],
  ])('%s: the normal sentence', async (_label, { policy }) => {
    process.env.IRRIGATION_RESTRICTION_POLICY = policy;
    expect(await ask(fakeKnex())).toBe(NORMAL('Biscuit'));
  });

  test('no house number: the normal sentence', async () => {
    expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: 'Example Loop' } }))).toBe(NORMAL('Biscuit'));
  });

  test('gate off: empty, with no read at all', async () => {
    process.env.GATE_LAWN_PREVISIT_LINE = 'false';
    const knex = fakeKnex();
    expect(await ask(knex)).toBe('');
    expect(knex.reads).toEqual([]);
  });

  test('not a lawn treatment visit: empty', async () => {
    expect(await ask(fakeKnex({ visit: { ...HOME, service_type: 'Quarterly Pest Control Service' } }))).toBe('');
  });

  test('a grouped stop is judged by each member\'s own service type, not the combined label', async () => {
    const visit = { ...HOME, service_type: 'Quarterly Pest Control Service', visit_id: 'visit-1' };
    const members = [{ service_type: 'Quarterly Pest Control Service' }, { service_type: 'Every 6 Weeks Lawn Care Service' }];
    expect(await ask(fakeKnex({ visit, members }))).toBe(DAY('Biscuit'));
    expect(await ask(fakeKnex({ visit, members: [{ service_type: 'Quarterly Pest Control Service' }] }))).toBe('');
  });

  test('a visit stamped at another address: empty', async () => {
    const visit = { ...HOME, service_address_line1: '77 Other Street', service_address_zip: '34202', service_address_city: 'Bradenton' };
    expect(await ask(fakeKnex({ visit }))).toBe('');
  });

  test('a customer with no pet on file gets the link paragraph', async () => {
    expect(await ask(fakeKnex({ prefs: { pets_structured: [] } }))).toBe(`${DAY('pets')}\n\n${LINK_LINE}`);
    expect(await ask(fakeKnex({ prefs: null }))).toBe(`${DAY('pets')}\n\n${LINK_LINE}`);
  });

  test('a failed read returns empty and logs a warning, never throws', async () => {
    const knex = () => { throw new Error('db down'); };
    expect(await ask(knex)).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lawn line skipped for visit svc-1'));
  });

  test('missing inputs: empty', async () => {
    expect(await lawnPrevisitLineForVisit({})).toBe('');
    expect(await ask(fakeKnex(), { apptTime: null })).toBe('');
  });
});
