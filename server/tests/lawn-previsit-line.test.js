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
const BEFORE = (who) => `Please keep sprinklers off tomorrow morning, unlock the gate, and keep ${who} inside while we treat.`;
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

  test('the day before the visit is the watering day: the morning-only sentence', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [dog('Biscuit')], wateringDayBefore: true })).toBe(BEFORE('Biscuit'));
    expect(buildLawnPrevisitLine({ petsStructured: [], wateringDayBefore: true, emailLinks: true }))
      .toBe(`${BEFORE('pets')}\n\nHave pets? Add them here: https://portal.wavespestcontrol.com/?tab=property#pets`);
    expect(buildLawnPrevisitLine({ petsStructured: [], wateringDayBefore: true })).toBe(`${BEFORE('pets')}\n\n${LINK_LINE}`);
  });

  test('exactly one sentence: the visit-day row wins when both flags are set', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [dog('Biscuit')], wateringDayClash: true, wateringDayBefore: true })).toBe(DAY('Biscuit'));
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

  test('emailLinks: the same words, the pets link with its full https address; the text form is unchanged', () => {
    expect(buildLawnPrevisitLine({ petsStructured: [], emailLinks: true })).toBe(`${NORMAL('pets')}\n\nHave pets? Add them here: https://portal.wavespestcontrol.com/?tab=property#pets`);
    expect(buildLawnPrevisitLine({ petsStructured: [dog('Biscuit')], emailLinks: true })).toBe(NORMAL('Biscuit'));
    expect(buildLawnPrevisitLine({ petsStructured: [], emailLinks: false })).toBe(`${NORMAL('pets')}\n\n${LINK_LINE}`);
  });

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
      buildLawnPrevisitLine({ petsStructured: [], wateringDayBefore: true }),
      buildLawnPrevisitLine({ petsStructured: [dog('Biscuit'), dog('Mochi'), dog('Rex')] }),
      buildLawnPrevisitLine({ petsStructured: [dog('Biscuit'), dog('Mochi'), dog('Rex')], wateringDayBefore: true }),
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

  describe('the day before the visit is the home\'s watering day', () => {
    // 1201 ends in 1: Monday. Tuesday 2026-11-17 9:00 AM ET is the day after.
    const MONDAY_HOME = { ...HOME, address_line1: '1201 Example Loop' };
    const withPolicy = (changes) => { process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ ...JSON.parse(ONE_DAY_POLICY), ...changes }); };

    test('the morning-only sentence, in the text form and the email form', async () => {
      expect(await ask(fakeKnex({ visit: MONDAY_HOME }))).toBe(BEFORE('Biscuit'));
      expect(await ask(fakeKnex({ visit: MONDAY_HOME, prefs: { pets_structured: [] } }), { emailLinks: true }))
        .toBe(`${BEFORE('pets')}\n\nHave pets? Add them here: https://portal.wavespestcontrol.com/?tab=property#pets`);
      expect(await ask(fakeKnex({ visit: MONDAY_HOME, prefs: { pets_structured: [] } }))).toBe(`${BEFORE('pets')}\n\n${LINK_LINE}`);
    });

    test('the visit day is the watering day: unchanged. Neither day: the normal sentence', async () => {
      expect(await ask(fakeKnex())).toBe(DAY('Biscuit'));
      expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: '1204 Example Loop' } }))).toBe(NORMAL('Biscuit'));
      expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: '1205 Example Loop' } }))).toBe(NORMAL('Biscuit')); // Wednesday home, Tuesday visit
    });

    test.each([
      ['a two-day policy', { maxDaysPerWeek: 2 }],
      ['a policy that does not cover the county', { coverage: { counties: ['Sarasota'], partial: [] } }],
      ['a policy that expired before the day before', { expiresOn: '2026-11-15' }],
      ['a policy not yet in force on the day before', { effectiveFrom: '2026-11-17' }],
    ])('%s: the normal sentence', async (_label, changes) => {
      withPolicy(changes);
      expect(await ask(fakeKnex({ visit: MONDAY_HOME }))).toBe(NORMAL('Biscuit'));
    });

    test('no policy in force: the normal sentence', async () => {
      withPolicy({ expiresOn: '2026-10-01' });
      expect(await ask(fakeKnex({ visit: MONDAY_HOME }))).toBe(NORMAL('Biscuit'));
    });

    test('a Monday visit: the day before is Sunday, never a watering day', async () => {
      const monday = new Date('2026-11-16T14:00:00.000Z');
      for (const line1 of ['1201 Example Loop', '1205 Example Loop', '1209 Example Loop']) {
        expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: line1 } }), { apptTime: monday })).not.toBe(BEFORE('Biscuit'));
      }
      expect(await ask(fakeKnex({ visit: MONDAY_HOME }), { apptTime: monday })).toBe(DAY('Biscuit'));
      expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: '1202 Example Loop' } }), { apptTime: monday })).toBe(NORMAL('Biscuit'));
    });

    test.each([
      ['Tuesday after the fall-back Sunday, 12:30 AM EST', '2026-11-03T05:30:00.000Z'],
      ['Tuesday after the fall-back Sunday, 11:30 PM EST', '2026-11-04T04:30:00.000Z'],
      ['Tuesday after the spring-forward week, 12:30 AM EDT', '2027-03-16T04:30:00.000Z'],
      ['Tuesday after the spring-forward week, 11:30 PM EDT', '2027-03-17T03:30:00.000Z'],
    ])('across a DST change the right day is picked: %s', async (_label, iso) => {
      withPolicy({ effectiveFrom: '2026-01-01', expiresOn: '2030-01-01' });
      expect(await ask(fakeKnex({ visit: MONDAY_HOME }), { apptTime: new Date(iso) })).toBe(BEFORE('Biscuit'));
      expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: '1202 Example Loop' } }), { apptTime: new Date(iso) })).toBe(DAY('Biscuit'));
      expect(await ask(fakeKnex({ visit: { ...HOME, address_line1: '1204 Example Loop' } }), { apptTime: new Date(iso) })).toBe(NORMAL('Biscuit'));
    });

    test('a failed read of the day before gives the normal sentence', async () => {
      jest.resetModules();
      jest.doMock('../utils/datetime-et', () => ({ ...jest.requireActual('../utils/datetime-et'), addETDays: () => { throw new Error('clock down'); } }));
      const isolated = require('../services/lawn-previsit-line');
      const line = await isolated.lawnPrevisitLineForVisit({ scheduledServiceId: 'svc-1', customerId: 'cust-1', apptTime: TUESDAY, knex: fakeKnex({ visit: MONDAY_HOME }) });
      jest.dontMock('../utils/datetime-et');
      expect(line).toBe(NORMAL('Biscuit'));
    });
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

  test('emailLinks reaches the visit reader: the link keeps its https scheme', async () => {
    const line = await ask(fakeKnex({ prefs: { pets_structured: [] } }), { emailLinks: true });
    expect(line).toBe(`${DAY('pets')}\n\nHave pets? Add them here: https://portal.wavespestcontrol.com/?tab=property#pets`);
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
