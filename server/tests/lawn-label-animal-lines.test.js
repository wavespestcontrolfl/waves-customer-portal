// Label warning lines for a technician's lawn visit (services/lawn-label-animal-lines.js, wired into
// previsit-brief.deterministicVisitFacts as facts.labelAnimalWarnings). No gate. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const logger = require('../services/logger');
const { labelAnimalWarnings, labelAnimalWarningsForVisit, KINDS } = require('../services/lawn-label-animal-lines');
const { deterministicVisitFacts } = require('../services/previsit-brief');
const { yardPets } = require('../services/pet-name-line');
const { buildLawnPrevisitLine } = require('../services/lawn-previsit-line');

const GRAZING_START = 'Labels say no grazing on the treated lawn and no clippings as feed: Stonewall, Prodiamine 65 WG, Merit 2F, Advion';

describe('labelAnimalWarnings: which lines each kind gets', () => {
  test('grass eater: the grazing line, with the names on file', () => {
    const [w] = labelAnimalWarnings([{ name: 'Shelly', type: 'Grass eater' }, { name: 'Tort', type: 'Grass eater' }]);
    expect(w).toMatchObject({ kind: 'grass_eater', label: 'Animals that eat grass', names: ['Shelly', 'Tort'] });
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain(GRAZING_START);
    expect(w.lines[0]).toContain('T-Storm Flowable, T-Storm 2G. T-Storm names poultry.');
    expect(w.lines[0]).not.toMatch(/waiting/i);
  });

  test('birds: the grazing line (chickens graze) and the bird line', () => {
    const [w] = labelAnimalWarnings([{ name: 'Henny', type: 'Birds' }]);
    expect(w.kind).toBe('birds');
    expect(w.lines).toHaveLength(2);
    expect(w.lines[0]).toContain(GRAZING_START);
    expect(w.lines[1]).toBe('Toxic to birds: Topchoice (spread evenly to reduce the risk to birds) and Dylox.');
  });

  test('fish pond: toxic-to-fish products, the two lawn distances and the Talstar P pond line', () => {
    const [w] = labelAnimalWarnings([{ name: 'Koi', type: 'Fish pond' }]);
    expect(w.kind).toBe('fish_pond');
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain('Toxic to fish: Dimension, Talstar P, Talak, LESCO Crosscheck Plus, Advion, Topchoice, Dylox, Artavia, Heritage G, Heritage WDG, Headway, Headway G, Velista.');
    expect(w.lines[0]).toContain('Topchoice 15 ft (fresh water) or 60 ft (estuarine water), Tetrino 25 ft, LESCO Crosscheck Plus 25 ft');
    // LESCO Crosscheck Plus label page 7: no ground application within 25 feet of these waters, and never into fish pools or ponds.
    expect(w.lines[0]).toContain('LESCO Crosscheck Plus 25 ft (lakes, reservoirs, rivers, permanent streams, marshes, natural ponds, estuaries and commercial fish farm ponds; never spray it into fish pools, ponds, streams or lakes).');
    expect(w.lines[0]).toContain('Talstar P and LESCO Crosscheck Plus: avoid fish and reptile pets in ornamental ponds.');
  });

  test('beehives: the label bee lines, with Tetrino worded as its label words it', () => {
    const [w] = labelAnimalWarnings([{ name: '', type: 'Beehives' }]);
    expect(w.kind).toBe('beehives');
    expect(w.names).toEqual(['no name']);
    expect(w.lines[0]).toBe('Toxic to bees: Talstar P, Talak, LESCO Crosscheck Plus, Arena, Merit 2F, Alpine, Tetrino. No contact with blooming plants while bees forage: Arena, Merit 2F. Tetrino: no contact with blooming plants; manage flowering weeds for 10 days; keep a 10 ft downwind buffer when blooming plants are within 10 ft of the downwind edge.');
  });

  test('dogs, cats, Other, blank and unknown kinds get no warning', () => {
    expect(labelAnimalWarnings([
      { name: 'Biscuit', type: 'Dog' }, { name: 'Luna', type: 'Cat' }, { name: 'Nemo', type: 'Other' },
      { name: 'Max', type: '' }, { name: 'Zed', type: 'Llama' }, { name: 'NoType' },
    ])).toEqual([]);
  });

  test('stored values match without case; an older row says species', () => {
    expect(labelAnimalWarnings([{ name: 'A', type: 'BIRDS' }, { name: 'B', species: 'fish pond' }]).map((w) => w.kind)).toEqual(['birds', 'fish_pond']);
  });

  test('warnings follow the table order, not the customer\'s; names repeat once; a line shown already is not repeated', () => {
    const out = labelAnimalWarnings([
      { name: 'Hive', type: 'Beehives' }, { name: 'Henny', type: 'Birds' }, { name: 'Shelly', type: 'Grass eater' },
      { name: 'shelly', type: 'Grass eater' }, { name: '  ', type: 'Grass eater' },
    ]);
    expect(out.map((w) => w.kind)).toEqual(['grass_eater', 'birds', 'beehives']);
    expect(out[0].names).toEqual(['Shelly', 'no name']);
    expect(out[0].lines).toHaveLength(1);
    expect(out[1].lines).toEqual([KINDS.find((k) => k.kind === 'birds').lines[1]]);
  });

  test('a JSON string reads like an array; anything unreadable is no warnings', () => {
    expect(labelAnimalWarnings(JSON.stringify([{ name: 'Koi', type: 'Fish pond' }]))).toHaveLength(1);
    for (const bad of [null, undefined, '', '{not json', 'none', { name: 'x' }, ['x', null, 5]]) expect(labelAnimalWarnings(bad)).toEqual([]);
  });
});

const PETS = [{ name: 'Shelly', type: 'Grass eater' }];
const LAWN_SVC = { id: 'svc-1', customer_id: 'cust-1', service_type: 'Lawn Care Treatment', scheduled_date: '2026-11-16', notes: null };

describe('labelAnimalWarningsForVisit: lawn treatment visits only', () => {
  const dbh = (home) => () => ({ where: () => ({ first: async () => home }) });

  test('a lawn treatment visit gets the warnings', async () => {
    expect(await labelAnimalWarningsForVisit(LAWN_SVC, { pets_structured: PETS }, dbh(null))).toHaveLength(1);
  });

  test.each(['Quarterly Pest Control', 'Mosquito Control', 'Lawn Dethatching', 'Tree & Shrub Care', '', null])('%s: none', async (serviceType) => {
    expect(await labelAnimalWarningsForVisit({ ...LAWN_SVC, service_type: serviceType }, { pets_structured: PETS }, dbh(null))).toEqual([]);
  });

  test('a visit stamped at another address: none (the pets are the home\'s); a stamp equal to the home keeps them', async () => {
    const home = { address_line1: '100 Palm Ave', address_line2: null, city: 'Bradenton', zip: '34205' };
    const other = { ...LAWN_SVC, service_address_line1: '900 Oak St', service_address_city: 'Sarasota', service_address_zip: '34236' };
    expect(await labelAnimalWarningsForVisit(other, { pets_structured: PETS }, dbh(home))).toEqual([]);
    const same = { ...LAWN_SVC, service_address_line1: '100 Palm Ave', service_address_city: 'Bradenton', service_address_zip: '34205' };
    expect(await labelAnimalWarningsForVisit(same, { pets_structured: PETS }, dbh(home))).toHaveLength(1);
  });

  test('a read failure drops the warnings and logs; it never throws', async () => {
    const throwing = () => { throw new Error('db down'); };
    const stamped = { ...LAWN_SVC, service_address_line1: '900 Oak St' };
    expect(await labelAnimalWarningsForVisit(stamped, { pets_structured: PETS }, throwing)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
    expect(await labelAnimalWarningsForVisit(LAWN_SVC, null, dbh(null))).toEqual([]);
  });
});

// Chainable knex stub like previsit-brief-visit-facts.test.js: reads resolve from per-table fixtures.
function fakeDbh({ prefs, throws = {} }) {
  return (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'orderBy', 'offset', 'limit', 'leftJoin', 'modify']) q[m] = () => q;
    q.select = async () => [];
    q.first = async () => {
      if (throws[table]) throw new Error(`${table} outage`);
      return table === 'property_preferences' ? prefs : undefined;
    };
    return q;
  };
}

describe('the facts payload: additive field', () => {
  const prefs = (pets) => ({ customer_id: 'cust-1', pet_count: 1, pet_details: 'One pet', pets_structured: pets });

  test('a lawn visit with a new kind on file carries labelAnimalWarnings; the rest of the facts are unchanged', async () => {
    const withPets = await deterministicVisitFacts(LAWN_SVC, fakeDbh({ prefs: prefs([{ name: 'Shelly', type: 'Grass eater' }, { name: 'Biscuit', type: 'Dog' }]) }));
    expect(withPets.labelAnimalWarnings).toHaveLength(1);
    expect(withPets.labelAnimalWarnings[0]).toMatchObject({ kind: 'grass_eater', names: ['Shelly'] });
    const without = await deterministicVisitFacts(LAWN_SVC, fakeDbh({ prefs: prefs([{ name: 'Biscuit', type: 'Dog' }]) }));
    expect(Object.keys(without)).not.toContain('labelAnimalWarnings');
    const { labelAnimalWarnings: _drop, ...rest } = withPets;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(without).sort());
  });

  test('a pest visit with the same pets carries no field', async () => {
    const facts = await deterministicVisitFacts({ ...LAWN_SVC, service_type: 'Quarterly Pest Control' }, fakeDbh({ prefs: prefs([{ name: 'Shelly', type: 'Grass eater' }]) }));
    expect(Object.keys(facts)).not.toContain('labelAnimalWarnings');
  });

  test('bad pets JSON drops the warnings, never the facts', async () => {
    const facts = await deterministicVisitFacts(LAWN_SVC, fakeDbh({ prefs: prefs('{broken') }));
    expect(facts.access).toBeTruthy();
    expect(Object.keys(facts)).not.toContain('labelAnimalWarnings');
  });

  test('a property preferences outage: access null, no warnings', async () => {
    const facts = await deterministicVisitFacts(LAWN_SVC, fakeDbh({ prefs: null, throws: { property_preferences: true } }));
    expect(facts.access).toBeNull();
    expect(Object.keys(facts)).not.toContain('labelAnimalWarnings');
  });
});

describe('customer words are unchanged by the new kinds', () => {
  const NEW_KINDS = [
    { name: 'Henny', type: 'Birds' }, { name: 'Shelly', type: 'Grass eater' },
    { name: 'Koi', type: 'Fish pond' }, { name: 'Hive', type: 'Beehives' },
  ];

  test('yardPets keeps naming only dogs and cats', () => {
    expect(yardPets(NEW_KINDS)).toEqual([]);
    expect(yardPets([...NEW_KINDS, { name: 'Biscuit', type: 'Dog' }, { name: 'Luna', type: 'Cat' }]).map((p) => p.name)).toEqual(['Biscuit', 'Luna']);
  });

  test('the lawn pre-visit line: the same words with or without the new kinds, and no pets link once any pet is on file', () => {
    const dogs = [{ name: 'Biscuit', type: 'Dog' }];
    expect(buildLawnPrevisitLine({ petsStructured: [...dogs, ...NEW_KINDS] })).toBe(buildLawnPrevisitLine({ petsStructured: dogs }));
    const only = buildLawnPrevisitLine({ petsStructured: NEW_KINDS });
    expect(only).toBe('Please keep sprinklers off tonight and tomorrow morning, unlock the gate, and keep pets inside while we treat.');
    expect(only).not.toContain('Have pets?');
  });
});
