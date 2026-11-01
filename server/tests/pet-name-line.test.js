/**
 * WaveGuard pet line in the completion text (GATE_PET_NAME_TEXT, services/pet-name-line.js): which
 * pets it names, which fixed sentence each report re-entry decision gets, and that it never says
 * more than the report or throws into the closeout.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/reentry', () => ({ buildReentryContext: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { buildReentryContext } = require('../services/service-report/reentry');
const { petLine, petLineForCompletion, yardPets, LINE_ENDINGS } = require('../services/pet-name-line');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { SERVICE_LINE_CONFIGS } = require('../services/service-report/service-line-configs');

const SPRAY = 'Keep people and pets off treated areas until sprays have dried.';
const outside = (petAdvisory = SPRAY) => ({ targets: [{ key: 'exterior' }], petAdvisory });
const inside = () => ({ targets: [{ key: 'interior' }], petAdvisory: SPRAY });
const insideAndOut = () => ({ targets: [{ key: 'exterior' }, { key: 'interior' }], petAdvisory: SPRAY });
const lawnCondition = (rule) => ({ targets: [], condition: { rule }, petAdvisory: 'Keep people and pets off the lawn until then.' });
const dog = (name, extra = {}) => ({ name, type: 'Dog', ...extra });

describe('which pets the line names', () => {
  test('dogs, cats and pets with no type, in the customer\'s order; a pet marked Other is left out', () => {
    expect(yardPets([dog('Biscuit'), { name: 'Nemo', type: 'Other' }, { name: 'Luna', type: 'Cat' }, { name: 'Max' }]).map((p) => p.name))
      .toEqual(['Biscuit', 'Luna', 'Max']);
  });

  test('older onboarding rows say species instead of type', () => {
    expect(yardPets([{ name: 'Rex', species: 'dog' }, { name: 'Polly', species: 'parrot' }]).map((p) => p.name)).toEqual(['Rex']);
  });

  test('a stored JSON string reads the same as an array; anything unreadable is no pets', () => {
    expect(yardPets(JSON.stringify([dog('Biscuit')])).map((p) => p.name)).toEqual(['Biscuit']);
    expect(yardPets('not json')).toEqual([]);
    expect(yardPets(null)).toEqual([]);
    expect(yardPets({ name: 'Biscuit' })).toEqual([]);
  });

  test('names are written the way a person would; mixed case stays as typed', () => {
    expect(yardPets([dog('biscuit'), dog('LUNA'), dog('o\'malley'), dog('McFly'), dog('  mr.   whiskers ')]).map((p) => p.name))
      .toEqual(['Biscuit', 'Luna', 'O\'Malley', 'McFly', 'Mr. Whiskers']);
  });

  test('a description, a number, a long entry or a repeat is not a name', () => {
    const pets = [dog('dog'), dog('N/A'), dog('none'), dog('Rex 2'), dog('Sir Barksalot the Third of Lakewood'), dog('<b>Rex</b>'), dog('Biscuit'), dog('BISCUIT'), dog('')];
    expect(yardPets(pets).map((p) => p.name)).toEqual(['Biscuit']);
  });
});

describe('the sentence for each report re-entry decision', () => {
  test('a spray visit outside, inside, and both', () => {
    expect(petLine([dog('Biscuit')], outside())).toBe('Biscuit can go back out once the spray has dried.');
    expect(petLine([dog('Biscuit')], inside())).toBe('Biscuit can go back into the treated rooms once the spray has dried.');
    expect(petLine([dog('Biscuit')], insideAndOut())).toBe('Biscuit can go back inside and out once the spray has dried.');
  });

  test('records that still carry the older pest advisory read the same', () => {
    expect(petLine([dog('Biscuit')], outside('Keep pets off treated zones until dry.'))).toBe('Biscuit can go back out once the spray has dried.');
  });

  test('a frozen lawn condition: dry, and watered in and dry', () => {
    expect(petLine([dog('Biscuit')], lawnCondition('dry'))).toBe('Biscuit can go back on the lawn once the application has dried.');
    expect(petLine([dog('Biscuit')], lawnCondition('watered_in_and_dry')))
      .toBe('Biscuit can go back on the lawn once you have watered it in and the grass is dry again.');
  });

  test('lawn, tree and shrub, and palm advisories on the clock path', () => {
    expect(petLine([dog('Biscuit')], outside('Keep pets off treated turf until dry.'))).toBe('Biscuit can go back on the lawn once it is dry.');
    expect(petLine([dog('Biscuit')], outside('Keep pets off treated beds and foliage until dry.'))).toBe('Biscuit can go back near the treated beds once they are dry.');
    expect(petLine([dog('Biscuit')], outside('Keep pets away from treated palms and surrounding beds until dry.')))
      .toBe('Biscuit can go back near the palms once the beds around them are dry.');
  });

  test('two and three names; none or four is no line', () => {
    expect(petLine([dog('Biscuit'), dog('Luna')], outside())).toBe('Biscuit and Luna can go back out once the spray has dried.');
    expect(petLine([dog('Biscuit'), dog('Luna'), dog('Max')], outside())).toBe('Biscuit, Luna and Max can go back out once the spray has dried.');
    expect(petLine([], outside())).toBe('');
    expect(petLine([dog('Biscuit'), dog('Luna'), dog('Max'), dog('Rex')], outside())).toBe('');
  });

  test('an indoor pet is not told to go back out, an outdoor pet not to go back inside', () => {
    const pets = [dog('Biscuit', { indoor: 'Outdoor' }), { name: 'Luna', type: 'Cat', indoor: 'Indoor' }, dog('Max', { indoor: 'Both' })];
    expect(petLine(pets, outside())).toBe('Biscuit and Max can go back out once the spray has dried.');
    expect(petLine(pets, inside())).toBe('Luna and Max can go back into the treated rooms once the spray has dried.');
    expect(petLine(pets, insideAndOut())).toBe('Biscuit, Luna and Max can go back inside and out once the spray has dried.');
    expect(petLine([{ name: 'Luna', type: 'Cat', indoor: 'Indoor' }], outside())).toBe('');
  });

  test('no line for bait or station work, no re-entry, a default lawn rule, or an advisory not in the table', () => {
    expect(petLine([dog('Biscuit')], undefined)).toBe('');
    expect(petLine([dog('Biscuit')], { targets: [], petAdvisory: SPRAY })).toBe('');
    expect(petLine([dog('Biscuit')], outside('Keep pets away from bait stations and exclusion work areas.'))).toBe('');
    expect(petLine([dog('Biscuit')], outside('Keep pets away from any open station work until closed.'))).toBe('');
    expect(petLine([dog('Biscuit')], outside('Keep pets indoors for 4 hours.'))).toBe('');
    expect(petLine([dog('Biscuit')], lawnCondition('default'))).toBe('');
    expect(petLine([dog('Biscuit')], { targets: [{ key: 'interior' }], petAdvisory: 'Keep pets off treated turf until dry.' })).toBe('');
  });

  test('every sentence passes the report-copy screen and carries no time figure and no "safe"', () => {
    for (const ending of Object.values(LINE_ENDINGS)) {
      const line = `Biscuit, Luna and Max ${ending}`;
      expect(customerCopyViolations(line)).toEqual([]);
      expect(line).not.toMatch(/\d|safe|minute|hour/i);
    }
  });

  test('a name the copy screen rejects drops the whole line', () => {
    expect(petLine([dog('Toxic')], outside())).toBe('');
  });

  test('every until-dry advisory the report stores today has a sentence; station advisories have none', () => {
    const advisories = Object.fromEntries(Object.entries(SERVICE_LINE_CONFIGS).map(([line, cfg]) => [line, cfg.advisoryDefaults?.pet_advisory]));
    for (const line of ['pest', 'mosquito', 'lawn', 'tree_shrub', 'palm']) {
      expect([line, petLine([dog('Biscuit')], outside(advisories[line]))]).not.toEqual([line, '']);
    }
    for (const line of ['termite', 'rodent']) expect(petLine([dog('Biscuit')], outside(advisories[line]))).toBe('');
  });
});

describe('petLineForCompletion', () => {
  const ORIGINAL = process.env.GATE_PET_NAME_TEXT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_PET_NAME_TEXT;
    else process.env.GATE_PET_NAME_TEXT = ORIGINAL;
    buildReentryContext.mockReset();
  });

  // The visit row: the visit joined to its customer (membership facts, home address, the visit's stamped address).
  const HOME = { address_line1: '100 Fixture Street', address_line2: 'Apt 3', city: 'Fixture City', zip: '34201' };
  const MEMBER_AT_HOME = { waveguard_tier: 'Gold', monthly_rate: 0, ...HOME };
  function fakeKnex({ prefs, record, visit = MEMBER_AT_HOME, fail } = {}) {
    const reads = [];
    const knex = (table) => {
      const chain = {
        join: () => chain,
        where: (where) => Object.assign(chain, { lastWhere: where }),
        first: async () => {
          reads.push(table);
          if (fail === table) throw new Error('read failed');
          if (table === 'property_preferences') return prefs;
          if (table === 'service_records') return record ? { scheduled_service_id: 'svc1', ...record, ...chain.lastWhere } : undefined;
          if (table === 'scheduled_services as ss') return visit;
          return undefined;
        },
      };
      return chain;
    };
    knex.raw = (sql) => sql;
    return { knex, reads };
  }

  test('gate off (unset or anything but exactly "true"): no read at all', async () => {
    for (const value of [undefined, '1', 'TRUE', 'on']) {
      if (value === undefined) delete process.env.GATE_PET_NAME_TEXT;
      else process.env.GATE_PET_NAME_TEXT = value;
      const { knex, reads } = fakeKnex({ prefs: { pets_structured: [dog('Biscuit')] }, record: {} });
      expect(await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex })).toBe('');
      expect(reads).toEqual([]);
    }
  });

  test('gate on: the line from the customer\'s pets and the record\'s report re-entry', async () => {
    process.env.GATE_PET_NAME_TEXT = 'true';
    buildReentryContext.mockResolvedValue(outside());
    const { knex } = fakeKnex({ prefs: { pets_structured: [dog('Biscuit')] }, record: { advisory: {} } });
    expect(await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex })).toBe('Biscuit can go back out once the spray has dried.');
    expect(buildReentryContext).toHaveBeenCalledWith({ record: expect.objectContaining({ id: 'r1' }), knex });
  });

  test('a member perk at the member\'s home: a non-member, a visit at another address or unit, or no linked visit gets no line', async () => {
    process.env.GATE_PET_NAME_TEXT = 'true';
    buildReentryContext.mockResolvedValue(outside());
    const prefs = { pets_structured: [dog('Biscuit')] };
    for (const visit of [
      { ...MEMBER_AT_HOME, waveguard_tier: null, monthly_rate: 0 },
      { ...MEMBER_AT_HOME, waveguard_tier: '', monthly_rate: null },
      { ...MEMBER_AT_HOME, service_address_line1: '200 Other Road' },
      { ...MEMBER_AT_HOME, service_address_line1: '100 Fixture Street', service_address_line2: 'Apt 4' },
      null, // the linked visit row is gone
    ]) {
      const { knex } = fakeKnex({ prefs, record: { advisory: {} }, visit });
      expect([visit, await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex })]).toEqual([visit, '']);
    }
    const unlinked = fakeKnex({ prefs, record: { advisory: {}, scheduled_service_id: null } });
    expect(await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex: unlinked.knex })).toBe('');
    expect(unlinked.reads).toEqual(['property_preferences', 'service_records']);
    // A legacy member (monthly rate, no tier) is a member.
    const legacy = fakeKnex({ prefs, record: { advisory: {} }, visit: { ...MEMBER_AT_HOME, waveguard_tier: null, monthly_rate: 49 } });
    expect(await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex: legacy.knex })).toBe('Biscuit can go back out once the spray has dried.');
    // The home's own address typed on the visit, unit omitted, is still the home.
    const typed = fakeKnex({ prefs, record: { advisory: {} }, visit: { ...MEMBER_AT_HOME, service_address_line1: '100 Fixture St' } });
    expect(await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex: typed.knex })).toBe('Biscuit can go back out once the spray has dried.');
  });

  test('no named pet: the record is never read', async () => {
    process.env.GATE_PET_NAME_TEXT = 'true';
    const { knex, reads } = fakeKnex({ prefs: { pets_structured: [{ name: '', type: 'Dog' }] }, record: {} });
    expect(await petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex })).toBe('');
    expect(reads).toEqual(['property_preferences']);
    expect(buildReentryContext).not.toHaveBeenCalled();
  });

  test('a failed read or re-entry build costs only the line, never throws', async () => {
    process.env.GATE_PET_NAME_TEXT = 'true';
    const failing = fakeKnex({ prefs: { pets_structured: [dog('Biscuit')] }, record: {}, fail: 'service_records' });
    await expect(petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex: failing.knex })).resolves.toBe('');
    buildReentryContext.mockRejectedValue(new Error('boom'));
    const ok = fakeKnex({ prefs: { pets_structured: [dog('Biscuit')] }, record: {} });
    await expect(petLineForCompletion({ customerId: 'c1', recordId: 'r1', knex: ok.knex })).resolves.toBe('');
  });
});

describe('complete-scheduled-service wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('the pet line is its own paragraph after the body and before the review line, in every template branch', () => {
    expect(source).toMatch(/const petSuffix = completionPetLine \? `\\n\\n\$\{completionPetLine\}` : '';/);
    expect(source.match(/sentSmsBody = `\$\{body\}\$\{petSuffix\}\$\{reviewSuffix\}`\.trim\(\);/g)).toHaveLength(4);
    expect(source).toMatch(/suffix: `\$\{petSuffix\}\$\{reviewSuffix\}`,/);
    expect(source).not.toMatch(/sentSmsBody = `\$\{body\}\$\{reviewSuffix\}`/);
  });

  test('never on the fixed re-service text, and only for a performed visit', () => {
    expect(source).toMatch(/const completionPetLine = reserviceFixedRecap \|\| \['inspection_only', 'customer_declined', 'incomplete'\]\.includes\(visitOutcome\)\n\s+\? ''/);
  });
});
