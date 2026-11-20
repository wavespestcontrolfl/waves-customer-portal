// planStartBlocker: may the app price, or offer, a NEW residential plan for this customer with nobody watching?
//
// The REAL readers of every plan record, each in the module that owns it, on a fake database that applies no
// filter. A table answers a list of rows, or a function of the filters one read used ([name, ...args] in call
// order). So a case below gives its row ONLY to the read that asks for that shape, as the database would, and
// cannot pass on another read. The SQL itself is proved on real PostgreSQL
// (plan-start-eligibility-postgres.test.js).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Every read must run on the handle the caller gives: a caller inside a transaction sees its own writes, and no
// read leaves on another connection. So the app's own connection refuses every use in this suite.
jest.mock('../models/db', () => {
  const refuse = () => { throw new Error('a read used the app connection, not the handle the caller gave'); };
  return new Proxy(refuse, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' || key === '__esModule' ? undefined : refuse) });
});

const { planStartBlocker, PLAN_START_BLOCKERS } = require('../services/plan-start-eligibility');

const FUTURE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const PAST = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);

function fakeDb(tables = {}, { scheduledColumns = {}, tableProbe = null } = {}) {
  const db = (table) => {
    const source = tables[table];
    const calls = [];
    const answer = () => (typeof source === 'function' ? source(calls) : source || []);
    const filter = (name) => (...args) => { calls.push([name, ...args]); return q; };
    const q = {
      where: filter('where'),
      whereNotIn: filter('whereNotIn'),
      whereNull: filter('whereNull'),
      whereNotNull: filter('whereNotNull'),
      orWhereNull: filter('orWhereNull'),
      // The annual-prepay coverage read (coveredTermsAsOf) filters with raw SQL; this fake answers by table.
      whereRaw: filter('whereRaw'),
      leftJoin() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      select() { return answer(); },
      first() { return answer()[0] || null; },
      distinct() { return answer(); },
      pluck(column) { return answer().map((row) => row[column]); },
      columnInfo() {
        // The columns the calendar read asks for. recurring_ongoing is one a test adds: the ongoing-series read
        // asks for it only where it exists.
        return table === 'scheduled_services'
          ? { is_recurring: {}, is_callback: {}, source: {}, followup_included: {}, ...scheduledColumns }
          : {};
      },
    };
    return q;
  };
  db.schema = {
    hasTable: async (name) => (tableProbe ? tableProbe(name) : Object.prototype.hasOwnProperty.call(tables, name)),
  };
  return db;
}

// A live residential account with no plan record of any kind.
const CUSTOMER = (change = {}) => ({
  id: 'cust-1', active: true, deleted_at: null, waveguard_tier: null, monthly_rate: null, property_type: 'single_family', ...change,
});
// `visits`: what the reads of scheduled_services answer (a list, or a function of the filters of one read).
function world({ customer = {}, visits = [], planRates = [], tables = {}, ...options } = {}) {
  return fakeDb({
    customers: customer === null ? [] : [CUSTOMER(customer)],
    scheduled_services: typeof visits === 'function' ? visits : () => visits,
    // The catalog join of the calendar read: no catalog identity here, so a row keeps its own service_type.
    'scheduled_services as s': [],
    customer_plan_rates: planRates,
    ...tables,
  }, options);
}
const blocker = (db) => planStartBlocker(db, 'cust-1');

// Which read of scheduled_services is this? By the filters only that read uses.
const whereHas = (calls, test) => calls.some(([name, filter]) => name === 'where' && filter && typeof filter === 'object' && test(filter));
// The read of the visits with the recurring flag and NO status: the calendar read drops those in SQL.
const isNoStatusRead = (calls) => calls.some(([name, column]) => name === 'whereNull' && column === 'status');
const isCalendarRead = (calls) => whereHas(calls, (f) => f.is_recurring === true && !('recurring_ongoing' in f)) && !isNoStatusRead(calls);
const isSeriesRead = (calls) => whereHas(calls, (f) => f.recurring_ongoing === true);
const isLegacyRead = (calls) => calls.some(([name, column]) => name === 'whereNull' && column === 'is_recurring');
const onlyFor = (isRead, rows) => (calls) => (isRead(calls) ? rows : []);

const FLAGGED = { id: 'svc-1', service_type: 'Quarterly Pest Control', is_recurring: true, status: 'scheduled', scheduled_date: FUTURE };
const LEGACY = { id: 'legacy-1', is_recurring: null, recurring_parent_id: 'root-1', status: 'confirmed', scheduled_date: FUTURE };
const ROOT = { id: 'root-1', is_recurring: true, recurring_ongoing: true, recurring_parent_id: null, status: 'completed', scheduled_date: PAST };
const ONGOING_COLUMN = { scheduledColumns: { recurring_ongoing: {} } };
// A saved property of the account (customer_properties): a home, the primary one.
const PROPERTY = (change = {}) => ({
  id: 'prop-1', customer_id: 'cust-1', active: true, is_primary: true, occupancy_type: 'owner_occupied', property_type: 'single_family', ...change,
});
const PREPAY_INVOICE = (status) => ({
  annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-1' }], invoices: [{ id: 'inv-1', status }],
});

describe('planStartBlocker', () => {
  test('a live residential account with no plan record: nothing stands against a new plan', async () => {
    expect(await blocker(world())).toBeNull();
    // Also with the ongoing column in the schema and every table there: each read runs and finds nothing.
    expect(await blocker(world({ ...ONGOING_COLUMN, tables: { 'annual_prepay_terms as t': [], annual_prepay_terms: [], invoices: [] } }))).toBeNull();
  });

  test('the reasons it can give, in the order it checks them', () => {
    expect(PLAN_START_BLOCKERS).toEqual(['not_live', 'commercial', 'has_plan']);
  });

  test('a database handle and a customer id are required', async () => {
    await expect(planStartBlocker(null, 'cust-1')).rejects.toThrow('planStartBlocker needs');
    await expect(planStartBlocker(world(), null)).rejects.toThrow('planStartBlocker needs');
  });

  // The plan check cannot answer for these accounts (the calendar read returns no row for an inactive one), so
  // the account itself is the reason, whatever plan record it carries.
  describe('an account that is not live', () => {
    test.each([
      ['no such customer', { customer: null }],
      ['an inactive account', { customer: { active: false } }],
      ['a deleted account', { customer: { deleted_at: '2026-10-01T12:00:00Z' } }],
      ['an inactive member', { customer: { active: false, waveguard_tier: 'Gold' } }],
      ['a deleted account with a plan visit on the calendar', { customer: { deleted_at: '2026-10-01T12:00:00Z' }, visits: [FLAGGED] }],
      ['an inactive commercial account', { customer: { active: false, waveguard_tier: 'Commercial' } }],
      ['an inactive account with a commercial saved property', { customer: { active: false }, tables: { customer_properties: [PROPERTY({ occupancy_type: 'commercial' })] } }],
      ['a deleted account with a commercial estimate', { customer: { deleted_at: '2026-10-01T12:00:00Z' }, tables: { estimates: [{ category: 'COMMERCIAL', estimate_data: null }] } }],
    ])('%s: not_live', async (_label, given) => {
      expect(await blocker(world(given))).toBe('not_live');
    });

    test('only active = false is inactive: an account with no active value is live, as the calendar read takes it', async () => {
      expect(await blocker(world({ customer: { active: null } }))).toBeNull();
      expect(await blocker(world({ customer: { active: null }, visits: onlyFor(isCalendarRead, [FLAGGED]) }))).toBe('has_plan');
    });
  });

  // The account-level rule (the 'commercial' tier, or a commercial or business property type) and the pricing
  // engine's own rule for a property type. The membership predicate reads the Commercial tier as "no plan":
  // without this rule a commercial account between visits would read as a home with no plan.
  // Then every record that carries the account's id and that the app can read as commercial: a saved property,
  // an estimate, a lead, a visit, a service report. One mark is enough, whatever its age or status.
  describe('a commercial account or record', () => {
    test.each([
      ['the Commercial tier and no property type', { waveguard_tier: 'Commercial', property_type: null }],
      ['the commercial tier in another spelling, with a residential property type', { waveguard_tier: ' commercial ', property_type: 'single_family' }],
      ['a business property type', { property_type: 'Business' }],
      ['a commercial property type', { property_type: 'commercial' }],
      // Types only the engine's rule knows.
      ['an office', { property_type: 'office' }],
      ['an apartment complex', { property_type: 'multi_family' }],
      ['a commercial account that also carries a monthly rate', { waveguard_tier: 'Commercial', monthly_rate: 120 }],
      // A building use: only a won commercial proposal writes one. It marks the account commercial only when
      // the proposal has taxable lines, so a residential community or a builder keeps a residential row.
      ['the building use of a business building', { building_use: 'nonresidential' }],
      ['the building use of a residential community, with a residential property type', { building_use: 'residential', property_type: 'single_family' }],
      // A sold commercial scope in the service preferences: only the accept of a commercial pest estimate
      // writes the key, with either value.
      ['a sold commercial scope with the interior excluded', { service_preferences: { exterior_sweep: true, interior_spray: false, commercial_interior_scope: 'excluded' } }],
      ['a sold commercial scope with the interior included', { service_preferences: { exterior_sweep: true, interior_spray: true, commercial_interior_scope: 'included' } }],
      ['a sold commercial scope in preferences that came back as JSON text', { service_preferences: JSON.stringify({ commercial_interior_scope: 'excluded' }) }],
    ])('%s: commercial, and no plan record is read', async (_label, customer) => {
      const reads = [];
      const db = world({ ...ONGOING_COLUMN, customer, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
      expect(await blocker(db)).toBe('commercial');
      expect(reads).toEqual([]);
    });

    test.each([['single_family'], ['condo_ground'], ['unknown'], [null], ['']])('a property type of %j with no tier is not commercial', async (property_type) => {
      expect(await blocker(world({ customer: { property_type } }))).toBeNull();
    });

    test.each([[null], [undefined], ['']])('a building use of %j (no commercial proposal was won) is not commercial', async (building_use) => {
      expect(await blocker(world({ customer: { building_use } }))).toBeNull();
    });

    test.each([
      ['the default preferences', { exterior_sweep: true, interior_spray: true }],
      // Any customer may decline the inside service. That is a preference, not a sold commercial scope.
      ['a home that declined the inside service', { exterior_sweep: true, interior_spray: false }],
      ['empty preferences', {}],
      ['no preferences', null],
      ['preferences that are not there', undefined],
      ['an empty text', ''],
      ['JSON text of home preferences', '{"interior_spray":false}'],
      ['a blank scope', { commercial_interior_scope: '  ' }],
      ['a scope of null', { commercial_interior_scope: null }],
      // The route reads a value that is not an object as "no key".
      ['a list', ['commercial_interior_scope']],
      ['a number', 7],
      ['JSON text of null', 'null'],
    ])('service preferences with no sold commercial scope (%s) are not commercial', async (_label, service_preferences) => {
      expect(await blocker(world({ customer: { service_preferences } }))).toBeNull();
    });

    // Never "a home": a value the proof cannot read is a failed read.
    test('service preferences that are text and not JSON throw', async () => {
      await expect(blocker(world({ customer: { service_preferences: '{"commercial_interior_scope":' } }))).rejects.toThrow();
    });

    // The account row carries only a mirror of the primary property's TYPE, and nothing on it mirrors a
    // property's occupancy. So an account that reads residential by its own row can have a saved property that
    // says commercial. Every saved property of the account counts (the proof gets no property to answer for),
    // also one that was removed: the removal of a business address does not make the account a home.
    describe('a saved property of the account', () => {
      test.each([
        ['the primary property has the commercial occupancy', [PROPERTY({ occupancy_type: 'commercial' })]],
        ['the commercial occupancy, with no property type', [PROPERTY({ occupancy_type: 'commercial', property_type: null })]],
        ['the primary property has a commercial type the account row does not carry', [PROPERTY({ property_type: 'commercial' })]],
        ['a business type in another case', [PROPERTY({ property_type: 'Business' })]],
        // A type only the engine's rule knows.
        ['an office', [PROPERTY({ property_type: 'office' })]],
        ['a second property is commercial and the primary one is a home', [PROPERTY(), PROPERTY({ id: 'prop-2', is_primary: false, occupancy_type: 'commercial' })]],
        ['a second property has a commercial type and the primary one is a home', [PROPERTY(), PROPERTY({ id: 'prop-2', is_primary: false, property_type: 'commercial' })]],
        ['a removed property was commercial and the primary one is a home', [PROPERTY(), PROPERTY({ id: 'prop-2', is_primary: false, active: false, occupancy_type: 'commercial' })]],
      ])('%s: commercial, and no plan record is read', async (_label, properties) => {
        const reads = [];
        const db = world({
          ...ONGOING_COLUMN, customer: { property_type: null }, visits: (calls) => { reads.push(calls); return [FLAGGED]; },
          tables: { customer_properties: properties },
        });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      // Every occupancy the schema knows beside commercial, and a property with none.
      test.each([['owner_occupied'], ['family_occupied'], ['rental_investment'], ['seasonal'], ['vacant'], ['unknown'], [null]])(
        'a home with the occupancy %j is not commercial', async (occupancy_type) => {
          expect(await blocker(world({ tables: { customer_properties: [PROPERTY({ occupancy_type })] } }))).toBeNull();
        });

      test.each([['single_family'], ['townhome'], ['condo'], [null], ['']])('a saved property with the type %j is not commercial', async (property_type) => {
        expect(await blocker(world({ tables: { customer_properties: [PROPERTY({ property_type }), PROPERTY({ id: 'prop-2', is_primary: false, property_type })] } }))).toBeNull();
      });

      // Two owners each keep a list of commercial property types: the account rule (self-booking-plan-sync.js)
      // and the pricing engine. Today the engine's list holds every type of the other one. Both are asked, for
      // the account's type and for a saved property's, so a type that either owner adds counts.
      test.each([
        ['the account rule', '../services/self-booking-plan-sync', 'isCommercialAccount'],
        ['the pricing engine', '../services/pricing-engine/commercial-helpers', 'isCommercialProperty'],
      ])('a type only %s calls commercial counts, on the account row and on a saved property', async (_label, modulePath, rule) => {
        const owner = require(modulePath);
        const real = owner[rule];
        const spy = jest.spyOn(owner, rule).mockImplementation((given, ...rest) => (
          given?.property_type === 'depot' || given?.propertyType === 'depot' || real(given, ...rest)));
        try {
          expect(await blocker(world({ customer: { property_type: 'depot' } }))).toBe('commercial');
          expect(await blocker(world({ tables: { customer_properties: [PROPERTY({ property_type: 'depot' })] } }))).toBe('commercial');
        } finally {
          spy.mockRestore();
        }
        expect(await blocker(world({ tables: { customer_properties: [PROPERTY({ property_type: 'depot' })] } }))).toBeNull();
      });

      test('homes only, and a plan record: the plan is the answer', async () => {
        const db = world({ visits: onlyFor(isCalendarRead, [FLAGGED]), tables: { customer_properties: [PROPERTY(), PROPERTY({ id: 'prop-2', is_primary: false, occupancy_type: 'rental_investment' })] } });
        expect(await blocker(db)).toBe('has_plan');
      });

      // The fake applies no filter, so this pins the filter itself: every saved property of this customer, with
      // no "active" in it (a removed address counts). PostgreSQL proves both.
      test('the read asks for every saved property of this customer, removed ones too', async () => {
        const reads = [];
        await blocker(world({ tables: { customer_properties: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1' }]]]);
      });

      test('an account that is commercial by its own row is answered with no property read', async () => {
        const reads = [];
        const db = world({ customer: { waveguard_tier: 'Commercial' }, tables: { customer_properties: (calls) => { reads.push(calls); return []; } } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });
    });

    // The app has several rules for "this estimate is commercial", each made for its own flow. Any one of them is
    // enough, on an estimate of any status: the account row of a won commercial proposal can carry no mark at
    // all (a proposal with no taxable lines, won before the building use existed).
    describe('an estimate of the account', () => {
      // A home estimate, as the estimator form saves it.
      const ESTIMATE = (change = {}) => ({
        category: 'RESIDENTIAL',
        estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } } },
        ...change,
      });
      const withEstimates = (estimates, given = {}) => world({ ...given, tables: { estimates } });

      // Each case carries ONE mark, so each rule is proved alone. The commercial estimate stands between two home
      // estimates: one mark on one estimate is enough.
      test.each([
        ['the category column, with no payload', ESTIMATE({ category: 'COMMERCIAL', estimate_data: null })],
        ['the category in another spelling', ESTIMATE({ category: ' commercial ' })],
        ['an authored commercial proposal under the default category', ESTIMATE({ estimate_data: { proposal: { enabled: true } } })],
        ['a scaffolded commercial proposal', ESTIMATE({ estimate_data: { proposal: { enabled: false, scaffold: true } } })],
        ['a commercial property type in the form inputs', ESTIMATE({ estimate_data: { inputs: { propertyType: 'Commercial' } } })],
        ['a commercial subtype in the engine request', ESTIMATE({ estimate_data: { engineRequest: { profile: { commercialSubtype: 'office' } } } })],
        ['a commercial service line', ESTIMATE({ estimate_data: { engineResult: { lineItems: [{ service: 'commercial_pest' }] } } })],
        ['a commercial service row the accept routes know by its key', ESTIMATE({ estimate_data: { result: { recurring: { services: [{ serviceKey: 'commercial_lawn_monthly' }] } } } })],
        // A service line the converter reads as commercial by its label, behind a home service key.
        ['a service line whose label says commercial', ESTIMATE({ estimate_data: { result: { recurring: { services: [{ service: 'pest_control', label: 'Commercial Pest Control' }] } } } })],
        // Marks only the pricing engine's rule for a profile reads: a type by its list, a commercial service pick.
        ['an office in the form inputs, under the default category', ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Office' } } })],
        ['a restaurant in the engine request', ESTIMATE({ estimate_data: { engineRequest: { profile: { propertyType: 'Restaurant' } } } })],
        ['a commercial service pick in the engine inputs', ESTIMATE({ estimate_data: { engineInputs: { services: { commercialPest: { selected: true } } } } })],
        // The saved spelling of the type, and the engine's other spelling of the subtype.
        ['a business type in the saved spelling', ESTIMATE({ estimate_data: { snapshot: { property_type: 'Business' } } })],
        ["a commercial subtype in the engine's intent", ESTIMATE({ estimate_data: { engine: { intent: { is_commercial: false, commercial_subtype: 'restaurant' } } } })],
        // A risk type is the business-type bucket of a commercial program. One that names no bucket counts too.
        ['a commercial risk type in the engine request, under the default category', ESTIMATE({ estimate_data: { engineRequest: { profile: { commercialRiskType: 'food' } } } })],
        ["a commercial risk type in the engine's intent", ESTIMATE({ estimate_data: { engine: { intent: { commercial_risk_type: 'office_low' } } } })],
        ["the estimate's own tier column, with no payload", ESTIMATE({ waveguard_tier: 'Commercial', estimate_data: null })],
        ["the estimate's tier in another spelling", ESTIMATE({ waveguard_tier: ' commercial ' })],
        // The converter keys a line from its `key` too. No other rule reads that field.
        ['a service line that carries its commercial key under `key`', ESTIMATE({ estimate_data: { result: { recurring: { services: [{ key: 'commercial_pest', name: 'Monthly Service' }] } } } })],
        ['a line whose key the converter builds from a commercial name', ESTIMATE({ estimate_data: { lines: [{ key: 'Commercial Turf Program' }] } })],
        // A text that starts with the prefix of the app's commercial keys, where no rule for a field looks.
        ['a commercial service key in a list of picked keys', ESTIMATE({ estimate_data: { selectedServiceKeys: ['pest_quarterly', 'commercial_pest'] } })],
        ['a commercial key under a field no rule names, in another spelling', ESTIMATE({ estimate_data: { pricing: { program: ' Commercial_Lawn ' } } })],
        ['a commercial review reason', ESTIMATE({ estimate_data: { automation: { review: [['commercial_signal_on_residential_intake']] } } })],
        // The payload scan reads the toggle only as a boolean, and never the engine's spelling.
        ["the form's toggle as text", ESTIMATE({ estimate_data: { inputs: { isCommercial: 'YES' } } })],
        ["the form's toggle in another spelling, in another generation of the payload", ESTIMATE({ estimate_data: { engineInputs: { isCommercial: ' yes ' } } })],
        ["the engine's flag", ESTIMATE({ estimate_data: { engine: { intent: { is_commercial: true } } } })],
        ["the engine's flag as text, inside a list", ESTIMATE({ estimate_data: { revisions: [{ intent: { is_commercial: 'true' } }] } })],
        ['a payload saved as JSON text', ESTIMATE({ estimate_data: JSON.stringify({ proposal: { enabled: true } }) })],
      ])('%s: commercial, and no plan record is read', async (_label, estimate) => {
        const reads = [];
        const db = withEstimates([ESTIMATE(), estimate, ESTIMATE()], { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test.each([
        ['a home estimate', ESTIMATE()],
        ['an estimate with no payload', ESTIMATE({ estimate_data: null })],
        ['an estimate with an empty payload', ESTIMATE({ estimate_data: {} })],
        ['an estimate with no category', ESTIMATE({ category: null })],
        ['a proposal that is neither authored nor scaffolded', ESTIMATE({ estimate_data: { proposal: { enabled: false } } })],
        ["the form's toggle and the engine's flag set to no", ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO' }, engineInputs: { isCommercial: false, is_commercial: 'no' }, engine: { intent: { is_commercial: false, category: 'RESIDENTIAL' } } } })],
        ['a home estimate saved as JSON text', ESTIMATE({ estimate_data: JSON.stringify({ inputs: { isCommercial: 'NO' } }) })],
        // A condo is a home, with the empty commercial fields and the pricing mode every home estimate carries.
        ['a condo', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Condo', commercialSubtype: '', commercialRiskType: '', commercialPricingMode: 'manual_quote' },
          engineRequest: { profile: { isCommercial: false, propertyType: 'condo_ground', commercialSubtype: null, commercialRiskType: null }, options: { commercialPricingMode: 'manual_quote' } },
          engine: { intent: { is_commercial: false, commercial_subtype: null, commercial_risk_type: null, category: 'RESIDENTIAL' } },
        } })],
        // The termite agreement parks these as multi-unit. They are homes.
        ['a townhome and a duplex', ESTIMATE({ estimate_data: { inputs: { propertyType: 'Townhome' }, engineInputs: { propertyType: 'duplex' }, snapshot: { property_type: 'townhome_end' } } })],
        ['commercial service picks that are not selected', ESTIMATE({ estimate_data: { engineInputs: { services: { commercialPest: { selected: false }, commercialLawn: false, commercial_lawn: { selected: false } } } } })],
        ['a home service line', ESTIMATE({ estimate_data: { result: { recurring: { services: [{ service: 'pest_control', serviceKey: 'pest_quarterly', key: 'pest_quarterly', name: 'Quarterly Pest Control', label: 'Pest Control' }] } } } })],
        ['a home line that carries its key under `key` alone', ESTIMATE({ estimate_data: { result: { recurring: { services: [{ key: 'lawn_care_monthly' }, { key: 'pest_quarterly' }] } } } })],
        // The prefix inside a text, and a NAME with the prefix (a service pick that was not taken), say nothing.
        ['a text that holds the prefix and does not start with it', ESTIMATE({ estimate_data: {
          notes: 'Asked about commercial_pest for a friend.', mode: 'small_commercial_pilot', tags: ['non_commercial_account', 'pest'],
        } })],
        ['a field whose NAME starts with the prefix', ESTIMATE({ estimate_data: { commercial_lawn: { selected: false }, commercial_notes: 'none' } })],
        ['a home tier on the estimate', ESTIMATE({ waveguard_tier: 'Bronze' })],
        ['no tier on the estimate', ESTIMATE({ waveguard_tier: null })],
      ])('%s is not commercial', async (_label, estimate) => {
        expect(await blocker(withEstimates([estimate, ESTIMATE()]))).toBeNull();
      });

      // The toggle's value, under either spelling of its name: the words the lead form and the termite
      // agreement take as a yes, a true and a 1.
      test.each([['YES'], [' Yes '], ['y'], ['true'], [true], ['1'], [1], ['on'], ['Commercial']])('a commercial toggle of %j is a yes', async (flag) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { inputs: { isCommercial: flag } } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { engine: { intent: { is_commercial: flag } } } })]))).toBe('commercial');
      });

      test.each([['NO'], ['n'], ['false'], [false], ['0'], [0], ['off'], [''], [null], ['residential'], ['yes please']])('a commercial toggle of %j is not a yes', async (flag) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { inputs: { isCommercial: flag }, engine: { intent: { is_commercial: flag } } } })]))).toBeNull();
      });

      // A subtype or a risk type that is SET counts, whatever it names. An empty one is what a home estimate
      // carries. Only the proof's own scan reads these three fields.
      test.each([['food'], [' office_low '], [true], [3]])('a risk type or a subtype of %j is set', async (value) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { profile: { commercialRiskType: value } } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { intent: { commercial_risk_type: value } } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { intent: { commercial_subtype: value } } })]))).toBe('commercial');
      });

      test.each([[''], ['   '], [null], [undefined], [false], [0]])('a risk type or a subtype of %j is not set', async (value) => {
        const data = { profile: { commercialRiskType: value }, intent: { commercial_risk_type: value, commercial_subtype: value } };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: data })]))).toBeNull();
      });

      // A model writes the engine's intent, and it can spell "no subtype" as a word. The app's two readers of
      // that spelling take 'none' and 'null' as empty. As a risk type the same word is a value that is set.
      test.each([['none'], ['null'], [' None '], ['NULL']])("the word %j is no subtype in the engine's spelling, and it is a risk type", async (word) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { intent: { is_commercial: false, commercial_subtype: word } } })]))).toBeNull();
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { intent: { commercial_risk_type: word } } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { profile: { commercialRiskType: word } } })]))).toBe('commercial');
      });

      test.each([['nonesuch'], ['nullable'], ['restaurant']])('the subtype %j is a subtype', async (word) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { intent: { commercial_subtype: word } } })]))).toBe('commercial');
      });

      // The app's own scan stops 12 levels down. A mark below that would read as a home.
      test('a mark far down in the payload counts: the scan has no depth limit', async () => {
        let deep = { commercialRiskType: 'office_low' };
        for (let level = 0; level < 20; level += 1) deep = { next: [deep] };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: deep })]))).toBe('commercial');
      });

      // Each of these rules belongs to another module, and most real marks are read by two or three of them at
      // once. So each is proved with a mark that ONLY that rule reads: the proof must ask every one of them.
      test.each([
        ['the proposal rule', '../services/estimate-proposal', 'isCommercialProposalData', (given) => given],
        ['the payload scan of the save', '../services/estimate-delivery-options', 'isCommercialEstimateData', (given) => given],
        ['the classifier of the accept routes', '../services/estimate-commercial-identity', 'isCommercialAutoAcceptEstimate', (given) => given?.estimate_data],
        ["the pricing engine's rule for a profile", '../services/pricing-engine/commercial-helpers', 'isCommercialProperty', (given) => given],
        ["the converter's rule for the names of a service line", '../services/estimate-converter', 'isCommercialRecurringLine', (given) => given],
        // This rule answers a key, not a yes.
        ["the converter's key for a service line", '../services/estimate-converter', 'recurringServiceKey', (given) => given, 'commercial_pest'],
      ])('a mark only %s reads counts', async (_label, modulePath, rule, payloadOf, hit = true) => {
        const owner = require(modulePath);
        const real = owner[rule];
        const spy = jest.spyOn(owner, rule).mockImplementation((given, ...rest) => (payloadOf(given)?.depot === true ? hit : real(given, ...rest)));
        const estimates = [ESTIMATE(), ESTIMATE({ estimate_data: { depot: true } })];
        try {
          expect(await blocker(withEstimates(estimates))).toBe('commercial');
        } finally {
          spy.mockRestore();
        }
        expect(await blocker(withEstimates(estimates))).toBeNull();
      });

      // An estimate the proof cannot read is a failed read, as a failed query is: never "a home".
      test.each([
        ['text that is not JSON', 'not json'],
        ['a number', 7],
        ['JSON text of a number', '7'],
        ['an empty text', ''],
        ['a bare false', false],
      ])('a payload of %s is a failed read', async (_label, estimate_data) => {
        await expect(blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data })]))).rejects.toThrow('could not read an estimate payload');
      });

      test('the category column answers for an estimate whose payload cannot be read', async () => {
        expect(await blocker(withEstimates([ESTIMATE({ category: 'COMMERCIAL', estimate_data: 'not json' })]))).toBe('commercial');
      });

      test('home estimates only, and a plan record: the plan is the answer', async () => {
        const db = withEstimates([ESTIMATE(), ESTIMATE()], { visits: onlyFor(isCalendarRead, [FLAGGED]) });
        expect(await blocker(db)).toBe('has_plan');
      });

      // The fake applies no filter, so this pins the filter itself: every estimate of this customer, with no
      // status in it (a won, an open and an old estimate all count). PostgreSQL proves each status.
      test('the read asks for every estimate of this customer, whatever its status', async () => {
        const reads = [];
        await blocker(withEstimates((calls) => { reads.push(calls.map((call) => [...call])); return []; }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1' }]]]);
      });
    });

    // The intake marks a commercial lead (leads.is_commercial), and the booking-link rule refuses on that flag.
    describe('a lead of the account', () => {
      // The fake applies no filter: this table answers a row only to a read that asks for the commercial flag.
      const commercialLeadOnly = (calls) => (whereHas(calls, (f) => f.is_commercial === true) ? [{ id: 'lead-1' }] : []);

      test('a lead the intake marked commercial: commercial, and no plan record is read', async () => {
        const reads = [];
        const db = world({ ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; }, tables: { leads: commercialLeadOnly } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      // PostgreSQL proves that a home lead, and another customer's commercial lead, say nothing.
      test("the read asks for this customer's commercial leads", async () => {
        const reads = [];
        await blocker(world({ tables: { leads: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1', is_commercial: true }]]]);
      });
    });

    // The rule the calendar and tier readers apply to a row joined to its catalog row (isCommercialServiceRow):
    // the row's own service text, the catalog key, the catalog name. The proof asks it of every visit and of
    // every service report of the account.
    describe.each([
      ['a visit', 'scheduled_services as record'],
      ['a service report', 'service_records as record'],
    ])('%s of the account', (_kind, table) => {
      const HOME_KIND = { service_type: 'Quarterly Pest Control', service_key: 'pest_quarterly', service_name: 'Quarterly Pest Control' };
      const withKinds = (kinds, given = {}) => world({ ...given, tables: { [table]: kinds } });

      test.each([
        ["a commercial service in the row's own text", { service_type: 'Commercial Pest Control', service_key: null, service_name: null }],
        ['a commercial catalog key behind a generic text', { service_type: 'Pest Control', service_key: 'commercial_pest_monthly', service_name: 'Monthly Pest Service' }],
        ['a commercial catalog name behind a generic text', { service_type: 'Pest Control', service_key: 'pest_monthly_b', service_name: 'Commercial Monthly Pest' }],
      ])('%s: commercial, and no plan record is read', async (_label, kind) => {
        const reads = [];
        const db = withKinds([HOME_KIND, kind, HOME_KIND], { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test('home services only are not commercial', async () => {
        expect(await blocker(withKinds([HOME_KIND, { service_type: 'One-Time Roach Treatment', service_key: null, service_name: null }]))).toBeNull();
      });

      test('the read asks for every row of this customer, whatever its status', async () => {
        const reads = [];
        await blocker(withKinds((calls) => { reads.push(calls.map((call) => [...call])); return []; }));
        expect(reads).toEqual([[['where', { 'record.customer_id': 'cust-1' }]]]);
      });
    });

    // A visit keeps the catalog key it was booked under (service_key_snapshot), also when its link to the
    // catalog is gone. The read returns it as `serviceKey`, a field the service-row rule reads.
    test("a visit's saved catalog key behind a generic text and no catalog row: commercial", async () => {
      const kind = { service_type: 'Pest Control', serviceKey: 'commercial_pest', service_key: null, service_name: null };
      expect(await blocker(world({ tables: { 'scheduled_services as record': [kind] } }))).toBe('commercial');
      expect(await blocker(world({ tables: { 'scheduled_services as record': [{ ...kind, serviceKey: 'pest_quarterly' }] } }))).toBeNull();
    });

    // The app knows the commercial agreement by its template key. A contract from it counts at any status.
    describe('a contract of the account', () => {
      const withContracts = (templates, given = {}) => world({ ...given, tables: { customer_contracts: templates.map((key) => ({ document_template_key: key })) } });

      test.each([
        ["the app's commercial agreement template", [require('../services/commercial-proposal-agreement').TEMPLATE_KEY]],
        ['the same key as the renewal reminder knows it', [require('../services/warranty-renewal-reminder').COMMERCIAL_AGREEMENT_KEY]],
        ['a commercial template beside a home one', ['service_agreement.termite_program', 'service_agreement.commercial_pest']],
        ['a commercial template of tomorrow', ['Service_Agreement.Commercial_Lawn']],
      ])('%s: commercial, and no plan record is read', async (_label, templates) => {
        const reads = [];
        const db = withContracts(templates, { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test("the app's commercial agreement key carries the word the rule reads", () => {
        expect(require('../services/commercial-proposal-agreement').TEMPLATE_KEY).toMatch(/commercial/);
        expect(require('../services/warranty-renewal-reminder').COMMERCIAL_AGREEMENT_KEY).toMatch(/commercial/);
      });

      test('home contracts only (a termite agreement, an autopay form with no template) are not commercial', async () => {
        expect(await blocker(withContracts(['service_agreement.termite_program', null, '']))).toBeNull();
      });

      test('the read asks for every contract of this customer, whatever its status', async () => {
        const reads = [];
        await blocker(world({ tables: { customer_contracts: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1' }]]]);
      });
    });

    test('an account that is commercial by its own row is answered with no read of its estimates, leads, visits, service reports or contracts', async () => {
      const reads = [];
      const record = (name) => (calls) => { reads.push([name, calls]); return []; };
      const db = world({
        customer: { building_use: 'residential' },
        tables: {
          estimates: record('estimates'), leads: record('leads'), 'scheduled_services as record': record('visits'),
          'service_records as record': record('reports'), customer_contracts: record('contracts'),
        },
      });
      expect(await blocker(db)).toBe('commercial');
      expect(reads).toEqual([]);
    });
  });

  // A plan has several records, and one alone is enough: a member can have no recurring visit on the calendar
  // and no named ledger component, and a plan can be a service no offer family names.
  describe('each record of a plan is enough alone', () => {
    test.each([
      ['a tier on the account', { customer: { waveguard_tier: 'Gold' } }],
      ['a legacy monthly rate with no tier', { customer: { monthly_rate: 45 } }],
      ['a monthly rate saved as text', { customer: { monthly_rate: '45.00' } }],
      // The membership predicate reads these tier values as "no plan" and then ignores the rate.
      ['a monthly rate beside the tier value None', { customer: { waveguard_tier: 'None', monthly_rate: 45 } }],
      ['a monthly rate beside the tier value One-Time', { customer: { waveguard_tier: 'One-Time', monthly_rate: 45 } }],
      // A billing lane only a plan has, on an account with no tier and no rate.
      ['the per-application lane on the account', { customer: { billing_mode: 'per_application' } }],
      ['the annual prepay lane on the account', { customer: { billing_mode: 'annual_prepay' } }],
      ['the monthly dues lane on the account', { customer: { billing_mode: 'monthly_membership' } }],
      ['a pest visit that carries the recurring flag', { visits: onlyFor(isCalendarRead, [FLAGGED]) }],
      ['a recurring lawn visit', { visits: onlyFor(isCalendarRead, [{ ...FLAGGED, service_type: 'Lawn Care Program' }]) }],
      // Palm injection maps to no service family. The live recurring row is the plan.
      ['a recurring visit that maps to no service family', { visits: onlyFor(isCalendarRead, [{ ...FLAGGED, service_type: 'Palm Injection' }]) }],
      ['a legacy plan visit (no recurring flag, a recurring parent)', { visits: onlyFor(isLegacyRead, [LEGACY]) }],
      // The status column takes a NULL, and the calendar read drops such a visit in SQL.
      ['a legacy plan visit with no status', { visits: onlyFor(isLegacyRead, [{ ...LEGACY, status: null }]) }],
      ['a visit with the recurring flag and no status', { visits: onlyFor(isNoStatusRead, [{ ...FLAGGED, status: null }]) }],
      ['an ongoing series with no visit on the calendar', { ...ONGOING_COLUMN, visits: onlyFor(isSeriesRead, [ROOT]) }],
      ['a billed plan rate of a named family', { planRates: [{ family_key: 'lawn_care', monthly_rate: 55 }] }],
      ['a billed plan rate the ledger could not name', { planRates: [{ family_key: 'unattributed', monthly_rate: 45 }] }],
      ['a billed plan rate saved as text', { planRates: [{ family_key: 'pest_control', monthly_rate: '45.00' }] }],
      // The hold flow sets the family's ledger component and the account's rate to 0 until the return date.
      ['an active plan hold, beside a ledger component the hold set to 0', { planRates: [{ family_key: 'lawn_care', monthly_rate: 0 }], tables: { plan_holds: [{ id: 'hold-1' }] } }],
      ['an annual prepay whose paid coverage is live', { tables: { 'annual_prepay_terms as t': [{ id: 'term-1' }] } }],
      ['an annual prepay invoice that is still payable', { tables: PREPAY_INVOICE('sent') }],
    ])('%s: has_plan', async (_label, given) => {
      expect(await blocker(world(given))).toBe('has_plan');
    });

    test.each([
      ['a tier value that names no plan', { customer: { waveguard_tier: 'One-Time' } }],
      ['a monthly rate of zero', { customer: { monthly_rate: 0 } }],
      ['the per-visit lane on the account', { customer: { billing_mode: 'per_visit' } }],
      ['the one-time lane on the account', { customer: { billing_mode: 'one_time' } }],
      ['a lane value the app does not know', { customer: { billing_mode: 'weekly' } }],
      ['a plan rate of zero', { planRates: [{ family_key: 'unattributed', monthly_rate: 0 }] }],
      ['an annual prepay invoice that was voided', { tables: PREPAY_INVOICE('void') }],
      ['a pending annual prepay term with no invoice row', { tables: { annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-9' }], invoices: [] } }],
    ])('%s is not a plan record', async (_label, given) => {
      expect(await blocker(world(given))).toBeNull();
    });
  });

  // The fake applies no filter, so this pins the filter itself: this customer's holds, and only the active ones
  // (a resumed or a cancelled hold is over). PostgreSQL proves the statuses.
  test("the hold read asks for this customer's active holds", async () => {
    const reads = [];
    await blocker(world({ tables: { plan_holds: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
    expect(reads).toEqual([[['where', { customer_id: 'cust-1', status: 'active' }]]]);
  });

  // The calendar read answers the rows that carry the recurring flag. One row rule (isLiveObligationRow) decides
  // which of them is a live plan visit.
  describe('a visit that carries the recurring flag', () => {
    const calendar = (row) => world({ visits: onlyFor(isCalendarRead, [row]) });

    test.each([
      ['dated today or later', {}],
      ['in progress now, with a date before today', { status: 'on_site', scheduled_date: PAST }],
      ['on the way now, with a date before today', { status: 'en_route', scheduled_date: PAST }],
    ])('%s is a live plan visit', async (_label, change) => {
      expect(await blocker(calendar({ ...FLAGGED, ...change }))).toBe('has_plan');
    });

    // An included follow-up is the $0 second visit of a one-time job. It rides the job, never a plan, whatever
    // its recurring flag says.
    test.each([
      ['an included follow-up', { followup_included: true }],
      ['an included follow-up in progress now', { followup_included: true, status: 'on_site' }],
      ['a free re-service callback', { is_callback: true }],
      ['a callback on the way now', { is_callback: true, status: 'en_route', scheduled_date: PAST }],
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
      ['a visit dated before today and not started', { scheduled_date: PAST }],
      ['a cancelled visit dated after today', { status: 'cancelled' }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blocker(calendar({ ...FLAGGED, ...change }))).toBeNull();
    });
  });

  // A legacy plan visit carries no recurring flag (NULL) and a recurring parent. The calendar read asks for
  // is_recurring = true, so it never returns that row: without a second read, a customer whose only live plan
  // record is that visit would read as a home with no plan.
  describe('a legacy plan visit (no recurring flag, a recurring parent)', () => {
    const legacy = (row) => world({ visits: onlyFor(isLegacyRead, [row]) });

    test('a visit in progress now counts, also when its date is before today', async () => {
      expect(await blocker(legacy({ ...LEGACY, status: 'on_site', scheduled_date: PAST }))).toBe('has_plan');
    });

    test.each([
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['a visit dated before today', { scheduled_date: PAST }],
      ['a visit with no date', { scheduled_date: null }],
      // The calendar read's own exclusions: a visit booked as one-time is not a plan, also while in progress.
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
      ['a one-time booking in progress now', { source: 'quote-wizard-onetime', status: 'on_site' }],
      ['a callback in progress now', { is_callback: true, status: 'en_route' }],
      ['a cancelled visit dated after today', { status: 'cancelled' }],
      // Rows the read does not ask for. The rule is applied to whatever the read returns.
      ['a row flagged not recurring (a booster)', { is_recurring: false }],
      ['a row with no recurring parent', { recurring_parent_id: null }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blocker(legacy({ ...LEGACY, ...change }))).toBeNull();
    });

    // No status filter in SQL: the row rule judges the status, and NOT IN would lose a visit with no status.
    test("the read asks for the legacy shape among this customer's visits, with no status filter", async () => {
      const reads = [];
      await blocker(world({ visits: (calls) => { reads.push(calls.map((call) => [...call])); return []; } }));
      expect(reads.find(isLegacyRead)).toEqual([
        ['where', { customer_id: 'cust-1' }],
        ['whereNull', 'is_recurring'],
        ['whereNotNull', 'recurring_parent_id'],
      ]);
    });
  });

  // The status column takes a NULL. The calendar read drops the visits that are over with NOT IN, and in SQL a
  // NULL fails NOT IN, so that read never returns a visit with no status. The row rule reads such a visit as open.
  describe('a visit with the recurring flag and no status', () => {
    const NO_STATUS = { ...FLAGGED, status: null };
    const noStatus = (row) => world({ visits: onlyFor(isNoStatusRead, [row]) });

    test('dated today or later: a live plan visit', async () => {
      expect(await blocker(noStatus(NO_STATUS))).toBe('has_plan');
    });

    test.each([
      ['a visit dated before today', { scheduled_date: PAST }],
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['a visit booked from a one-time source', { source: 'estimate-accept' }],
      // A row the read does not ask for. The rule is applied to whatever the read returns.
      ['a one-time visit (flagged not recurring, no parent)', { is_recurring: false }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blocker(noStatus({ ...NO_STATUS, ...change }))).toBeNull();
    });

    test("the read asks for this customer's flagged visits with no status, and for nothing more", async () => {
      const reads = [];
      await blocker(world({ visits: (calls) => { reads.push(calls.map((call) => [...call])); return []; } }));
      expect(reads.find(isNoStatusRead)).toEqual([
        ['where', { customer_id: 'cust-1', is_recurring: true }],
        ['whereNull', 'status'],
      ]);
    });
  });

  // An ongoing series BETWEEN visits. Its root says the plan goes on, also on a day with no visit of it on the
  // calendar: the last visit is completed and the next one is not minted yet. Both calendar reads see no live
  // visit then, so the proof also reads the nightly top-up's own selector.
  describe('an ongoing recurring series with no visit on the calendar', () => {
    const ongoingRoots = (rows) => rows.filter((row) => row.is_recurring === true && row.recurring_ongoing === true && row.recurring_parent_id == null);
    const series = (rows, options = ONGOING_COLUMN) => world({ ...options, visits: (calls) => (isSeriesRead(calls) ? ongoingRoots(rows) : []) });

    test.each([
      ['a completed root, no later visit', {}],
      ['a root whose own visit was cancelled while the series goes on', { status: 'cancelled' }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blocker(series([{ ...ROOT, ...change }]))).toBe('has_plan');
    });

    // A finite series that ran out, and a series a cancel ended, keep no ongoing root.
    test.each([
      ['a completed finite series (the root was never ongoing)', { recurring_ongoing: false }],
      ['a cancelled series (the cancel cleared the flag)', { recurring_ongoing: false, status: 'cancelled' }],
      ['a completed visit of a series that is not its root', { recurring_parent_id: 'root-0' }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await blocker(series([{ ...ROOT, ...change }]))).toBeNull();
    });

    test("the read is the nightly top-up's own selector, for this customer only", async () => {
      const reads = [];
      await blocker(world({ ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls.map((call) => [...call])); return []; } }));
      expect(reads.find(isSeriesRead)).toEqual([
        ['where', { is_recurring: true, recurring_ongoing: true }],
        ['whereNull', 'recurring_parent_id'],
        ['where', 'customer_id', 'cust-1'],
      ]);
    });

    test('a schema without the column has no ongoing series to read', async () => {
      const reads = [];
      const db = world({ visits: (calls) => { reads.push(calls); return []; } });
      expect(await blocker(db)).toBeNull();
      expect(reads.some(isSeriesRead)).toBe(false);
    });
  });

  // An outage is never "no plan". Each read fails ALONE here, with every other read answering "nothing".
  describe('a failed read throws', () => {
    const failing = (message) => () => { throw new Error(message); };
    const failFor = (isRead, message) => (calls) => { if (isRead(calls)) throw new Error(message); return []; };
    // The nth read of the customers table: the proof's own (1), then the calendar read's (2).
    const customersFailingAt = (n, message) => { let seen = 0; return () => { seen += 1; if (seen === n) throw new Error(message); return [CUSTOMER()]; }; };

    test.each([
      ['the account read', { tables: { customers: customersFailingAt(1, 'account read down') } }, 'account read down'],
      ['the saved property read', { tables: { customer_properties: failing('property read down') } }, 'property read down'],
      ['the estimate read', { tables: { estimates: failing('estimate read down') } }, 'estimate read down'],
      ['the lead read', { tables: { leads: failing('lead read down') } }, 'lead read down'],
      ['the read of the visit services', { tables: { 'scheduled_services as record': failing('visit service read down') } }, 'visit service read down'],
      ['the read of the service report services', { tables: { 'service_records as record': failing('report service read down') } }, 'report service read down'],
      ['the read of the contracts', { tables: { customer_contracts: failing('contract read down') } }, 'contract read down'],
      ['the account read of the calendar reader', { tables: { customers: customersFailingAt(2, 'calendar account read down') } }, 'calendar account read down'],
      ['the calendar read', { visits: failFor(isCalendarRead, 'calendar read down') }, 'calendar read down'],
      ['the catalog join of the calendar read', { tables: { 'scheduled_services as s': failing('catalog join down') } }, 'ownership catalog join failed'],
      ['the legacy visit read', { visits: failFor(isLegacyRead, 'legacy read down') }, 'legacy read down'],
      ['the read of the visits with no status', { visits: failFor(isNoStatusRead, 'no-status read down') }, 'no-status read down'],
      ['the ongoing series read', { ...ONGOING_COLUMN, visits: failFor(isSeriesRead, 'series read down') }, 'series read down'],
      ['the plan-rate ledger read', { planRates: failing('ledger read down') }, 'ledger read down'],
      ['the plan hold read', { tables: { plan_holds: failing('hold read down') } }, 'hold read down'],
      ['the annual prepay coverage read', { tables: { 'annual_prepay_terms as t': failing('coverage read down') } }, 'coverage read down'],
      ['the pending annual prepay read', { tables: { annual_prepay_terms: failing('pending prepay read down') } }, 'pending prepay read down'],
      ['the invoice read of a pending annual prepay', { tables: { annual_prepay_terms: [{ id: 'term-1', prepay_invoice_id: 'inv-1' }], invoices: failing('invoice read down') } }, 'invoice read down'],
    ])('%s', async (_label, given, message) => {
      await expect(blocker(world(given))).rejects.toThrow(message);
    });

    // With GATE_PLAN_RATE_LEDGER off the ledger answers a failed table probe as "no ledger". A billed rate is
    // evidence of a plan in either mode, so this proof asks for the failure.
    test.each([['off', undefined], ['on', 'true']])('a failed probe of the plan-rate ledger table, with the ledger gate %s', async (_label, gate) => {
      const saved = process.env.GATE_PLAN_RATE_LEDGER;
      if (gate === undefined) delete process.env.GATE_PLAN_RATE_LEDGER; else process.env.GATE_PLAN_RATE_LEDGER = gate;
      try {
        const probe = (name) => { if (name === 'customer_plan_rates') throw new Error('metadata query timeout'); return true; };
        await expect(blocker(world({ tableProbe: probe }))).rejects.toThrow('metadata query timeout');
      } finally {
        if (saved === undefined) delete process.env.GATE_PLAN_RATE_LEDGER; else process.env.GATE_PLAN_RATE_LEDGER = saved;
      }
    });

    test('with the ledger gate off, a database with no ledger table is not a failure', async () => {
      const saved = process.env.GATE_PLAN_RATE_LEDGER;
      delete process.env.GATE_PLAN_RATE_LEDGER;
      try {
        expect(await blocker(world({ tableProbe: (name) => name !== 'customer_plan_rates' }))).toBeNull();
      } finally {
        if (saved !== undefined) process.env.GATE_PLAN_RATE_LEDGER = saved;
      }
    });
  });
});
