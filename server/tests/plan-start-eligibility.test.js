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
      whereIn: filter('whereIn'),
      whereNotIn: filter('whereNotIn'),
      whereNull: filter('whereNull'),
      whereNotNull: filter('whereNotNull'),
      orWhereNull: filter('orWhereNull'),
      // The annual-prepay coverage read (coveredTermsAsOf) filters with raw SQL; this fake answers by table.
      whereRaw: filter('whereRaw'),
      join() { return q; },
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
      // The service label the intake saved on the account itself, by the rule for the label of a lead.
      ['a commercial service label on the account', { lead_service_interest: 'Commercial Pest Control' }],
      ['a commercial service label on the account in another spelling', { lead_service_interest: 'pest (COMMERCIAL)' }],
    ])('%s: commercial, and no plan record is read', async (_label, customer) => {
      const reads = [];
      const db = world({ ...ONGOING_COLUMN, customer, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
      expect(await blocker(db)).toBe('commercial');
      expect(reads).toEqual([]);
    });

    test.each([['single_family'], ['condo_ground'], ['unknown'], [null], ['']])('a property type of %j with no tier is not commercial', async (property_type) => {
      expect(await blocker(world({ customer: { property_type } }))).toBeNull();
    });

    test.each([['Pest Control'], ['Quarterly Pest + Lawn'], [null], [undefined], ['']])('a service label of %j on the account is not commercial', async (lead_service_interest) => {
      expect(await blocker(world({ customer: { lead_service_interest } }))).toBeNull();
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

    // A jsonb column cannot hold a text that is "not JSON": a text from it is a JSON string, a valid value with
    // no key. It is never a failed read: a throw would stop this account on every run.
    test.each([['{"commercial_interior_scope":'], ['none']])('service preferences that are the text %j carry no key: not commercial', async (service_preferences) => {
      expect(await blocker(world({ customer: { service_preferences } }))).toBeNull();
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
      // The property facts the estimator keeps with a draft, and its vocabulary of service scopes as this proof
      // sorts it.
      const FACTS = (facts) => ({ estimatorEngine: { propertyFactsV2: { version: 2, shadow: true, facts: { propertySubtype: 'single_family', ...facts } } } });
      const COMMERCIAL_SCOPES = ['commercial_suite', 'entire_commercial_building', 'multi_building_commercial_parcel', 'association_common_area'];
      const HOME_SCOPES = ['residential_unit', 'entire_residential_structure', 'entire_parcel', 'unknown'];
      // The profile of a home, as the lookup writes one and the estimator saves it with the estimate.
      const PROFILE = (change = {}) => ({ engineRequest: { profile: {
        category: 'RESIDENTIAL', propertyType: 'Single Family', isCommercial: false, commercialSubtype: null, commercialDetectionSource: null, ...change,
      } } });

      // The estimator's rule for a commercial scope is not exported, so the proof keeps its own list. A scope
      // the estimator adds later fails here until someone sorts it.
      test("every service scope of the estimator's vocabulary is sorted: commercial or not", () => {
        const { SERVICE_SCOPES } = require('../services/property-lookup/property-facts-v2');
        expect([...COMMERCIAL_SCOPES, ...HOME_SCOPES].sort()).toEqual([...SERVICE_SCOPES].sort());
      });
      // A mark 20 levels down: below the 12 levels the payload scan of the save reads.
      const farDown = (mark) => Array.from({ length: 20 }).reduce((inner) => ({ next: [inner] }), mark);

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
        // The estimate's own service label. A quote request and the office save it apart from the payload.
        ['the service label of the estimate, over an empty payload', ESTIMATE({ service_interest: 'Commercial Pest Control', estimate_data: null })],
        ['the service label beside home service lines', ESTIMATE({ service_interest: 'Lawn Care (commercial)' })],
        // Marks only the pipeline's reader of service lines reads, on an estimate with no service line.
        ["a copy of the service label in the form's inputs", ESTIMATE({ estimate_data: { inputs: { leadServiceInterest: 'Commercial Lawn Care' } } })],
        ['notes the app sorts as a commercial line', ESTIMATE({ notes: 'Quote the commercial pest program for the bakery.', estimate_data: {} })],
        // A category or a subtype beside a field that reads residential. The engine's rule lets the residential field
        // win, and the scan of the save does not reach this depth: the mark is read alone.
        ['a commercial category beside a residential type, far down', ESTIMATE({ estimate_data: farDown({ category: 'COMMERCIAL', propertyType: 'single_family' }) })],
        ['a commercial category in another spelling, far down', ESTIMATE({ estimate_data: farDown({ category: ' commercial ', isCommercial: false }) })],
        ['a commercial subtype beside a toggle set to no, far down', ESTIMATE({ estimate_data: farDown({ isCommercial: 'NO', commercialSubtype: 'office' }) })],
        // The estimator's own verdict on the premises, kept with a draft (estimatorEngine.propertyFactsV2).
        ['a commercial occupancy class in the saved property facts', ESTIMATE({ estimate_data: FACTS({ occupancyClass: 'commercial', serviceScope: 'unknown' }) })],
        ...COMMERCIAL_SCOPES.map((serviceScope) => [`the service scope ${serviceScope} in the saved property facts`, ESTIMATE({ estimate_data: FACTS({ occupancyClass: 'unknown', serviceScope }) })]),
        // What the lookup keeps on a profile about a business at the address, on a profile that reads residential
        // in every other field: the scope staff decided, their answer, the source of a commercial verdict.
        ['the whole building, as staff decided for a business at the address', ESTIMATE({ estimate_data: PROFILE({ serviceScopeDecision: 'entire_commercial_building' }) })],
        ["staff's answer that the customer has the whole building", ESTIMATE({ estimate_data: PROFILE({ occupancyAnswer: 'building' }) })],
        ["staff's answer that the customer has one suite, on a question still marked open", ESTIMATE({ estimate_data: PROFILE({ serviceScopeDecision: 'scope_unresolved', occupancyAnswer: 'suite' }) })],
        ['the source of a commercial verdict of the lookup', ESTIMATE({ estimate_data: PROFILE({ commercialDetectionSource: 'property_record_property_type' }) })],
        // Two marks of the scan of the save that no other rule holds, below the 12 levels that scan reads.
        ['the mark of an auto-priced commercial quote, far down', ESTIMATE({ estimate_data: farDown({ commercialEstimatedPricing: true }) })],
        ["the word none as a subtype in the form's spelling, beside a toggle set to no, far down", ESTIMATE({ estimate_data: farDown({ category: 'RESIDENTIAL', isCommercial: 'NO', commercialSubtype: 'none' }) })],
        // The estimator engine's mark on a draft it made as a commercial proposal, where the engine keeps it.
        ["the engine's mark on a draft it made as a commercial proposal", ESTIMATE({ estimate_data: { estimatorEngine: { version: 1, lane: 'red', laneReasons: [], commercialProposal: true } } })],
        // A manual commercial quote line, under the name the reader of service lines takes such lines from.
        ['a manual commercial quote line', ESTIMATE({ estimate_data: { commercialManualQuoteLines: [{ service: 'commercial_pest', quoteRequired: true }] } })],
        // The quiz of the lead an estimate was drafted from, where the payload keeps it.
        ["the 'business' answer of a quiz page, kept in the payload", ESTIMATE({ estimate_data: { lead: { quiz: { kind: 'lawn', property: 'business' } } } })],
        // The payload scan reads the toggle only as a boolean, and never the engine's spelling.
        ["the form's toggle as text", ESTIMATE({ estimate_data: { inputs: { isCommercial: 'YES' } } })],
        ["the form's toggle in another spelling, in another generation of the payload", ESTIMATE({ estimate_data: { engineInputs: { isCommercial: ' yes ' } } })],
        ["the engine's flag", ESTIMATE({ estimate_data: { engine: { intent: { is_commercial: true } } } })],
        ["the engine's flag as text, inside a list", ESTIMATE({ estimate_data: { revisions: [{ intent: { is_commercial: 'true' } }] } })],
        ['a payload saved as JSON text', ESTIMATE({ estimate_data: JSON.stringify({ proposal: { enabled: true } }) })],
        // A copy of the service label in the payload. The reader of service lines answers with the lines first,
        // so on an estimate with a home plan line only the rule for a label reads the copy.
        ["the lead's interest the form keeps, on an estimate with a home plan line", ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family', leadServiceInterest: 'Commercial Lawn Care' },
          result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care' }] } },
        } })],
        ['the interest the engine was given, on an estimate with a home plan line', ESTIMATE({ estimate_data: {
          engineInputs: { isCommercial: false, serviceInterest: 'Commercial Lawn Care' },
          engineResult: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care' }] } },
        } })],
        ['a label copy far down in the payload', ESTIMATE({ estimate_data: farDown({ serviceInterest: 'Monthly COMMERCIAL pest program' }) })],
        ['a label copy that is a list of labels', ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', leadServiceInterest: ['Pest Control', 'Commercial Lawn Care'] } } })],
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
        ['a residential category and an empty subtype, far down', ESTIMATE({ estimate_data: farDown({ category: 'RESIDENTIAL', commercial_subtype: 'none', commercialSubtype: '', isCommercial: 'NO' }) })],
        // The lookup's profile of a home, and the three states of it that confirm no business: an open question,
        // the answer "not this business", and a listing staff did not confirm.
        ['the lookup profile of a home', ESTIMATE({ estimate_data: PROFILE() })],
        ['an open question about a business at the address', ESTIMATE({ estimate_data: PROFILE({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: 'Are we treating just your space or the whole building?', occupancyAnswer: null }) })],
        ["staff's answer that the customer is not the listed business", ESTIMATE({ estimate_data: PROFILE({ serviceScopeDecision: null, occupancyAnswer: 'none' }) })],
        ['a listing at the address that staff did not confirm', ESTIMATE({ estimate_data: PROFILE({
          serviceScopeDecision: 'scope_unresolved', serviceScopeSuggestion: 'building',
          businessIdentity: { name: 'Corner Cafe', type: 'restaurant', matchedBy: 'street_number', tenantsAtNumber: 2, unitKey: 'business:place-1' },
        }) })],
        ['a quote that is not auto-priced as commercial', ESTIMATE({ estimate_data: { quote: { commercialEstimatedPricing: false, commercialDisclaimer: null }, deep: farDown({ commercialEstimatedPricing: false }) } })],
        // Parameters of a commercial price are not verdicts: the form keeps a pricing mode on every estimate, and
        // a tool can set the interior service on any estimate.
        ['parameters of a commercial price beside a toggle set to no', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', commercialPricingMode: 'estimated', commercialPestCadence: 'monthly', commercialLawnCadence: 'six', commercialInteriorService: 'included' },
          engineRequest: { options: { commercialPricingMode: 'estimated', commercialInteriorService: 'excluded' } },
        } })],
        // The price card keeps the lawn area of ANY lawn quote under both lawn names. A name is not a mark.
        ['the lawn area of a home lawn quote, kept under both lawn names', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family' },
          measuredBasisAnchor: {
            lawn_care: { label: 'Treatable lawn', value: '4,000 sq ft', source: 'Estimated from the lot' },
            commercial_lawn: { label: 'Treatable lawn', value: '4,000 sq ft', source: 'Estimated from the lot' },
          },
        } })],
        ['a category of another vocabulary', ESTIMATE({ estimate_data: { products: [{ category: 'pest_control' }, { category: 'lawn_care' }] } })],
        ...HOME_SCOPES.map((serviceScope) => [`a residential occupancy class and the service scope ${serviceScope}`, ESTIMATE({ estimate_data: FACTS({ occupancyClass: 'residential', serviceScope }) })]),
        ['a home tier on the estimate', ESTIMATE({ waveguard_tier: 'Bronze' })],
        ['no tier on the estimate', ESTIMATE({ waveguard_tier: null })],
        ['a home service label and home notes', ESTIMATE({ service_interest: 'Quarterly Pest Control', notes: 'Ants in the kitchen. Side gate is open.', estimate_data: {} })],
        ['no service label and no notes', ESTIMATE({ service_interest: null, notes: null })],
        // The app's reader sorts the notes only when the estimate has no service line: the lines answer first.
        ['notes with the word on an estimate that has home service lines', ESTIMATE({ notes: 'Pest plan for the house. Not a commercial account.' })],
        // Home services under the names that keep a service label, and the word under a name that keeps none.
        ['home service labels in the payload', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', leadServiceInterest: 'Quarterly Pest Control' }, engineInputs: { serviceInterest: 'Pest Control + Lawn Care' },
          call: { requested_service: 'Ant treatment', matched_service: 'Pest Control', specific_service_name: null, serviceType: 'recurring' },
        } })],
        ['the word under a name that keeps no service label', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', interestNote: 'Asked if we also do commercial work.' }, reviewNotes: ['Not a commercial property.'],
        } })],
      ])('%s is not commercial', async (_label, estimate) => {
        expect(await blocker(withEstimates([estimate, ESTIMATE()]))).toBeNull();
      });

      // Every name the app keeps a service label or a service name under, on an object the reader of service
      // lines does not look at, beside a home plan line.
      test.each([
        ['serviceInterest'], ['service_interest'], ['leadServiceInterest'], ['lead_service_interest'],
        ['requested_service'], ['matched_service'], ['specific_service_name'], ['serviceType'], ['service_type'],
      ])('a commercial service under the name %s is a mark, and a home service under it is none', async (name) => {
        const kept = (label) => ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, source: { [name]: label },
          result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } },
        } });
        expect(await blocker(withEstimates([ESTIMATE(), kept('Commercial Pest Control')]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), kept('Quarterly Pest Control')]))).toBeNull();
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

      // In the form's spelling the payload scan of the save takes ANY text as a subtype, these words too. So does
      // the proof, at the top and far down: a mark must not change its meaning with its depth.
      test.each([['none'], ['null'], [' None '], ['office']])("the word %j is a subtype in the form's spelling, at the top and far down", async (word) => {
        const mark = { category: 'RESIDENTIAL', isCommercial: 'NO', commercialSubtype: word };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { inputs: mark } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: farDown(mark) })]))).toBe('commercial');
      });

      test.each([[''], ['   '], [null], [undefined], [false], [0]])("a subtype of %j in the form's spelling is not set", async (value) => {
        const mark = { category: 'RESIDENTIAL', isCommercial: 'NO', commercialSubtype: value };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { inputs: mark, deep: farDown(mark) } })]))).toBeNull();
      });

      // The scan of the save reads six marks on an object, 12 levels down and no further. Each one is a mark at
      // any depth here, also beside a toggle set to no. The first two lines pin the list to the scan itself.
      const SCAN_MARKS = [
        ['the mark of an auto-priced commercial quote', { commercialEstimatedPricing: true }],
        ['the toggle', { isCommercial: true }],
        ['the commercial property type', { isCommercial: false, propertyType: 'Commercial' }],
        ['the commercial category', { isCommercial: false, category: 'commercial' }],
        ['a subtype that is any text', { isCommercial: false, commercialSubtype: 'none' }],
        ['a commercial service', { isCommercial: false, service: 'commercial_pest' }],
      ];
      test.each(SCAN_MARKS)('%s, a mark of the scan of the save, is read below the reach of that scan', async (_label, mark) => {
        const { isCommercialEstimateData } = require('../services/estimate-delivery-options');
        expect(isCommercialEstimateData(mark)).toBe(true);
        expect(isCommercialEstimateData(farDown(mark))).toBe(false);
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: farDown(mark) })]))).toBe('commercial');
        expect(await blocker(world({ tables: { leads: [{ is_commercial: false, is_residential: true, extracted_data: farDown(mark) }] } }))).toBe('commercial');
      });

      // The mark of an auto-priced commercial quote is read as the toggle is read. The scan of the save reads
      // only the boolean.
      test.each([[true], ['true'], [' YES '], [1]])('a quote mark of %j is a yes', async (flag) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { quote: { commercialEstimatedPricing: flag } } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: farDown({ commercialEstimatedPricing: flag }) })]))).toBe('commercial');
      });

      test.each([[false], ['false'], ['no'], [0], [null], [''], [undefined]])('a quote mark of %j is not a yes', async (flag) => {
        const data = { commercialEstimatedPricing: flag, quote: { commercialEstimatedPricing: flag }, deep: farDown({ commercialEstimatedPricing: flag }) };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: data })]))).toBeNull();
      });

      // The estimator engine's mark on a draft it made as a commercial proposal (estimatorEngine.commercialProposal).
      // The engine writes and reads the boolean. Here it is read as the toggle is read, at any depth.
      test.each([[true], ['true'], [' YES '], [1]])("the engine's proposal mark of %j is a yes", async (flag) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: { estimatorEngine: { version: 1, lane: 'red', commercialProposal: flag } } })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: farDown({ commercialProposal: flag }) })]))).toBe('commercial');
      });

      test.each([[false], ['false'], ['no'], [0], [null], [''], [undefined]])("the engine's proposal mark of %j is not a yes", async (flag) => {
        const data = { estimatorEngine: { version: 1, lane: 'yellow', commercialProposal: flag }, deep: farDown({ commercialProposal: flag }) };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: data })]))).toBeNull();
      });

      // The scope staff decided for a business at the address. Every scope the lookup can decide is a mark, and
      // the open question is none. A scope the lookup adds later fails the first line until someone sorts it.
      test('every scope the lookup can decide is a mark, and the open question is none', async () => {
        const { SCOPE } = require('../services/property-lookup/business-scope');
        const decided = (serviceScopeDecision) => blocker(withEstimates([ESTIMATE({ estimate_data: PROFILE({ serviceScopeDecision }) })]));
        expect(Object.values(SCOPE).sort()).toEqual(['commercial_suite', 'entire_commercial_building', 'scope_unresolved']);
        expect(await decided(SCOPE.SUITE)).toBe('commercial');
        expect(await decided(SCOPE.BUILDING)).toBe('commercial');
        expect(await decided('whole_parcel')).toBe('commercial');
        expect(await decided(SCOPE.UNRESOLVED)).toBeNull();
      });

      test.each([[''], ['   '], [null], [undefined], [false]])('a scope decision of %j is not set', async (serviceScopeDecision) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: PROFILE({ serviceScopeDecision }) })]))).toBeNull();
      });

      // The answer itself, as the lookup's own reader of an answer takes it.
      test.each([['suite'], ['building'], [' Building '], ['SUITE']])("staff's answer %j confirms the business", async (occupancyAnswer) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: PROFILE({ occupancyAnswer }) })]))).toBe('commercial');
      });

      test.each([['none'], [' None '], [''], [null], [undefined], ['maybe'], [true]])("staff's answer %j confirms nothing", async (occupancyAnswer) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: PROFILE({ occupancyAnswer }) })]))).toBeNull();
      });

      // The lookup's reader of an answer belongs to the lookup. The proof asks it, so a new answer is followed.
      test("an answer only the lookup's own reader takes counts", async () => {
        const owner = require('../services/property-lookup/business-scope');
        const real = owner.normalizeOccupancyAnswer;
        const spy = jest.spyOn(owner, 'normalizeOccupancyAnswer').mockImplementation((value) => (value === 'depot' ? 'parcel' : real(value)));
        const estimates = [ESTIMATE(), ESTIMATE({ estimate_data: PROFILE({ occupancyAnswer: 'depot' }) })];
        try {
          expect(await blocker(withEstimates(estimates))).toBe('commercial');
        } finally {
          spy.mockRestore();
        }
        expect(await blocker(withEstimates(estimates))).toBeNull();
      });

      // The source of a commercial verdict. The lookup writes one only on a commercial profile.
      test.each([['staff_confirmed_business'], ['property_record_property_type'], ['property_record_unit_count'], ['satellite_ai_property_use']])('a detection source of %j is set', async (commercialDetectionSource) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: PROFILE({ commercialDetectionSource }) })]))).toBe('commercial');
      });

      test.each([[''], ['   '], [null], [undefined], [false]])('a detection source of %j is not set', async (commercialDetectionSource) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: PROFILE({ commercialDetectionSource }) })]))).toBeNull();
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
        // This one answers the estimate's service lines.
        ["the pipeline's reader of service lines", '../services/estimate-service-lines', 'inferEstimateServiceLines', (given) => given?.estimate_data, [{ key: 'commercial_pest' }]],
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

      // The payload is a jsonb column, so what comes back is always a valid value. A payload that is not an
      // object or a list carries no structured mark. It is never a failed read: a throw would stop this account
      // on every run.
      test.each([
        ['a text', 'asked about pest control'],
        ['a number', 7],
        ['JSON text of a number', '7'],
        ['an empty text', ''],
        ['a bare false', false],
      ])('a payload of %s carries no mark: not commercial', async (_label, estimate_data) => {
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data })]))).toBeNull();
      });

      test.each([
        ['the category column', { category: 'COMMERCIAL' }],
        ['the service label', { service_interest: 'Commercial Pest Control' }],
        ['the notes, through the reader of service lines', { notes: 'Commercial pest control for the bakery' }],
      ])('%s answers for an estimate whose payload is a text', async (_label, change) => {
        expect(await blocker(withEstimates([ESTIMATE({ ...change, estimate_data: 'asked about pest control' })]))).toBe('commercial');
      });

      test('a payload that is one text is read by the rule for a text', async () => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: ' Commercial_Pest ' })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: 'pest for a commercial_kitchen' })]))).toBeNull();
      });

      // The mark here is one only this proof's own rule for an object reads: no reader of the app parses the
      // text for it.
      test('a payload that was serialized twice is read as what it holds', async () => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: JSON.stringify(FACTS({ occupancyClass: 'commercial' })) })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: JSON.stringify(FACTS({ occupancyClass: 'residential' })) })]))).toBeNull();
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

    // A lead keeps what the intake knew, each fact in its own column, and no writer keeps the columns in step.
    describe('a lead of the account', () => {
      // A home lead, as the intake saves it.
      const LEAD = (change = {}) => ({
        is_commercial: false, is_residential: true, service_interest: 'Pest Control', service_key: 'pest_general_quarterly', waveguard_tier: 'Bronze',
        extracted_data: { isCommercial: false, commercialSubtype: null, commercialDetectionSource: null, propertyType: 'Single Family' },
        ...change,
      });
      const withLeads = (leads, given = {}) => world({ ...given, tables: { leads } });

      // Each case carries ONE mark, between two home leads.
      test.each([
        ['the commercial flag', LEAD({ is_commercial: true })],
        ['the residential flag set to no, with the commercial flag off', LEAD({ is_residential: false })],
        ['a commercial service label, with the commercial flag off', LEAD({ service_interest: 'Commercial Pest Control' })],
        ['a commercial catalog key', LEAD({ service_key: 'commercial_pest' })],
        ['the commercial tier', LEAD({ waveguard_tier: 'Commercial' })],
        ["the commercial toggle in the intake's payload", LEAD({ extracted_data: { isCommercial: 'YES' } })],
        ['a business property type in the payload', LEAD({ extracted_data: { quiz: { propertyType: 'Restaurant' } } })],
        ['a commercial key in the payload', LEAD({ extracted_data: { classification: { intent: 'commercial_inquiry' } } })],
        ['a payload saved as JSON text', LEAD({ extracted_data: JSON.stringify({ engine: { is_commercial: true } }) })],
        // Marks beside a field that reads residential: one mark is enough.
        ['a commercial category beside a residential type in one object of the payload', LEAD({ extracted_data: { enriched: { category: 'COMMERCIAL', propertyType: 'single_family' } } })],
        ['a commercial subtype beside a toggle set to no', LEAD({ extracted_data: { isCommercial: 'NO', commercialSubtype: 'office' } })],
        // A mark only the payload scan of the save reads.
        ['the mark of commercial estimated pricing', LEAD({ extracted_data: { quote: { commercialEstimatedPricing: true } } })],
        // What the lookup keeps on a profile about a business at the address, where a lead keeps the profile.
        ["staff's answer about a business at the address", LEAD({ extracted_data: { enriched: { category: 'RESIDENTIAL', isCommercial: false, occupancyAnswer: 'building' } } })],
        ['the scope staff decided for a business at the address', LEAD({ extracted_data: { enriched: { category: 'RESIDENTIAL', isCommercial: false, serviceScopeDecision: 'entire_commercial_building' } } })],
        ['the source of a commercial verdict of the lookup', LEAD({ extracted_data: { isCommercial: false, commercialSubtype: null, commercialDetectionSource: 'satellite_ai_property_use' } })],
        // A quiz page's property question. The lead keeps the quiz object as the visitor answered it.
        ["the 'business' answer of a quiz page", LEAD({ extracted_data: { attribution: {}, quiz: { kind: 'pest', seeing: 'ants', property: 'business' } } })],
        // A web form keeps the service label in the payload too, and the column can hold another label.
        ['a commercial service label in the payload, behind a home label in the column', LEAD({ extracted_data: { stage: 'lead_webhook_received', service_interest: 'Commercial Pest Control' } })],
        ['a commercial request a call left in the payload', LEAD({ extracted_data: { requested_service: 'Pest control for a commercial kitchen', matched_service: 'Pest Control' } })],
      ])('%s: commercial, and no plan record is read', async (_label, lead) => {
        const reads = [];
        const db = withLeads([LEAD(), lead, LEAD()], { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test.each([
        ['a home lead', LEAD()],
        ['flags that were never set', LEAD({ is_commercial: null, is_residential: null })],
        ['a lead with no label, no key, no tier and no payload', LEAD({ service_interest: null, service_key: null, waveguard_tier: null, extracted_data: null })],
        ['a blank payload text', LEAD({ extracted_data: '  ' })],
        ['a payload with the commercial fields empty', LEAD({ extracted_data: { isCommercial: 'NO', commercialSubtype: '', commercialRiskType: null, commercialPricingMode: 'manual_quote' } })],
        ['a payload that is a bare text', LEAD({ extracted_data: JSON.stringify('asked about pest control') })],
        ['a quiz answered for a house, a townhome or a condo', LEAD({ extracted_data: { quiz: { kind: 'pest', property: 'house' }, earlier: [{ quiz: { kind: 'lawn', property: 'townhome' } }, { quiz: { kind: 'pest', property: 'condo' } }] } })],
        ['a quiz with no property answer', LEAD({ extracted_data: { quiz: { kind: 'lawn', seeing: 'brown_patches' } } })],
        ['a residential category beside a residential type', LEAD({ extracted_data: { enriched: { category: 'RESIDENTIAL', propertyType: 'single_family' }, quote: { commercialEstimatedPricing: false } } })],
        ['an open question about a business at the address, and the answer "not this business"', LEAD({ extracted_data: { enriched: { serviceScopeDecision: 'scope_unresolved', occupancyAnswer: 'none', commercialDetectionSource: null } } })],
        // A home label in the payload, and the words of a call a payload can keep.
        ['a home service label and the words of a call in the payload', LEAD({ extracted_data: {
          stage: 'lead_webhook_received', service_interest: 'Pest Control', requested_service: 'Ant treatment', pain_points: ['The commercial spray from the store did not work'],
        } })],
      ])('%s is not commercial', async (_label, lead) => {
        expect(await blocker(withLeads([lead, LEAD()]))).toBeNull();
      });

      // The rule belongs to the quiz module. The proof asks it, so a new answer that means a business is followed.
      test("a mark only the quiz's own rule reads counts", async () => {
        const owner = require('../services/lead-quiz');
        const real = owner.quizIsCommercial;
        const spy = jest.spyOn(owner, 'quizIsCommercial').mockImplementation((quiz, ...rest) => (quiz?.depot === true ? true : real(quiz, ...rest)));
        const leads = [LEAD(), LEAD({ extracted_data: { quiz: { kind: 'pest', depot: true } } })];
        try {
          expect(await blocker(withLeads(leads))).toBe('commercial');
        } finally {
          spy.mockRestore();
        }
        expect(await blocker(withLeads(leads))).toBeNull();
      });

      // The payload is a jsonb column. A text in it is a valid value with no structured mark, never a failed
      // read: PostgreSQL returns a JSON string as the text itself.
      test.each([['asked about pest control'], [''], ['7']])('a lead payload that is the text %j carries no mark: not commercial', async (extracted_data) => {
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data })]))).toBeNull();
      });

      test('a lead payload that is one text is read by the rule for a text', async () => {
        expect(await blocker(withLeads([LEAD({ extracted_data: 'commercial_pest' })]))).toBe('commercial');
      });

      test('a commercial flag answers for a lead whose payload is a text', async () => {
        expect(await blocker(withLeads([LEAD({ is_commercial: true, extracted_data: 'asked about pest control' })]))).toBe('commercial');
      });

      // The fake applies no filter, so this pins the filter itself: every lead of this customer, with no flag
      // and no deleted-at in it. PostgreSQL proves a deleted lead and another customer's lead.
      test('the read asks for every lead of this customer', async () => {
        const reads = [];
        await blocker(world({ tables: { leads: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1' }]]]);
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

    // An add-on is a second service on a visit, with an identity of its own: its saved name, the catalog key it
    // was booked under, and its catalog row. The read returns them in fields the service-row rule reads.
    describe('an add-on of a visit of the account', () => {
      const HOME_ADDON = { service_name: 'Mosquito Add-On', serviceKey: 'mosquito_monthly', service_key: 'mosquito_monthly', name: 'Monthly Mosquito' };
      const withAddons = (addons, given = {}) => world({ ...given, tables: { 'scheduled_service_addons as addon': addons } });

      test.each([
        ["a commercial service in the add-on's saved name", { service_name: 'Commercial Mosquito Service', serviceKey: null, service_key: null, name: null }],
        ['a commercial key the add-on was booked under, with no catalog row', { service_name: 'Mosquito Add-On', serviceKey: 'commercial_mosquito', service_key: null, name: null }],
        ['a commercial catalog key behind a generic name', { service_name: 'Mosquito Add-On', serviceKey: null, service_key: 'commercial_mosquito_monthly', name: 'Monthly Mosquito' }],
        ['a commercial catalog name behind a generic name', { service_name: 'Mosquito Add-On', serviceKey: null, service_key: 'mosquito_monthly_b', name: 'Commercial Monthly Mosquito' }],
      ])('%s: commercial, and no plan record is read', async (_label, addon) => {
        const reads = [];
        const db = withAddons([HOME_ADDON, addon, HOME_ADDON], { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test('home add-ons only are not commercial', async () => {
        expect(await blocker(withAddons([HOME_ADDON, { service_name: 'Fire Ant Treatment', serviceKey: null, service_key: null, name: null }]))).toBeNull();
      });

      // The fake applies no filter and no join, so this pins the filter: every add-on of a visit of this
      // customer, whatever the visit's status. PostgreSQL proves the join and another customer's add-on.
      test("the read asks for the add-ons of this customer's visits", async () => {
        const reads = [];
        await blocker(withAddons((calls) => { reads.push(calls.map((call) => [...call])); return []; }));
        expect(reads).toEqual([[['where', { 'visit.customer_id': 'cust-1' }]]]);
      });
    });

    // An edit of "this visit and the ones after it" leaves the first visit as it was done and saves the new
    // service on the series root, apart from the root's own columns. The read of the visits cannot see it.
    describe('the service a series of the account goes on with', () => {
      const CATALOG_ID = '0b9f5c1e-6f0a-4c3e-9d2b-5a7e8c4d1f20';
      const OTHER_CATALOG_ID = '7d3a2b1c-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
      const PRICE_ONLY = { estimated_price: 55, primary_line_price: 55, discount_type: null };
      const HOME_SERVICE = { service_key: 'pest_quarterly', name: 'Quarterly Pest Control' };
      const withTemplates = (templates, { services = [], ...given } = {}) => world({
        ...given,
        tables: { 'scheduled_services as series': templates.map((value) => ({ recurring_template_overrides: value })), services },
      });

      test.each([
        ['a commercial service text', [{ service_type: 'Commercial Pest Control' }], []],
        ['a commercial catalog key that was saved with the edit, behind a generic text', [{ service_type: 'Pest Control', service_key_snapshot: 'commercial_pest_monthly' }], []],
        ['a commercial service beside a new price, on the second series', [PRICE_ONLY, { ...PRICE_ONLY, service_type: 'Commercial Lawn Care' }], []],
        ['a template that came back as JSON text', [JSON.stringify({ service_type: 'Commercial Pest Control' })], []],
        ['a catalog link to a service with a commercial key', [{ service_type: 'Pest Control', service_id: CATALOG_ID }], [HOME_SERVICE, { service_key: 'commercial_pest_monthly', name: 'Monthly Pest Service' }]],
        ['a catalog link to a service with a commercial name', [{ service_id: CATALOG_ID }], [{ service_key: 'pest_monthly_b', name: 'Commercial Monthly Pest' }]],
      ])('%s: commercial, and no plan record is read', async (_label, templates, services) => {
        const reads = [];
        const db = withTemplates(templates, { services, ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test.each([
        ['a new price only', [PRICE_ONLY]],
        ['a home service with its catalog row', [{ service_type: 'Quarterly Pest Control', service_key_snapshot: 'pest_quarterly', service_id: CATALOG_ID }]],
        // What the seeder keeps beside an edit: a price split and the address of the visits. Not a service.
        ['the keys the seeder keeps, with a street name that holds the word', [{ anchored_split_per_visit: 45, appointment_address: { address_line1: '100 Commercial Way' } }]],
        ['a cleared catalog link', [{ service_type: 'Pest Control', service_id: null, service_key_snapshot: null }]],
        ['a value that is a text', ['none']],
        ['a value that is a number', [7]],
        ['an empty object', [{}]],
      ])('%s is not commercial', async (_label, templates) => {
        expect(await blocker(withTemplates(templates, { services: [HOME_SERVICE] }))).toBeNull();
      });

      // A gate decides whether the scheduler uses a saved template (the app reads it once, at load, into the
      // gates object). The proof reads the template either way.
      test.each([['off', false], ['on', true]])('a saved commercial template counts with the edit gate %s', async (_label, value) => {
        const { gates, isEnabled } = require('../config/feature-gates');
        const saved = gates.editApptPriceServiceScope;
        gates.editApptPriceServiceScope = value;
        try {
          expect(isEnabled('editApptPriceServiceScope')).toBe(value);
          expect(await blocker(withTemplates([{ service_type: 'Commercial Pest Control' }]))).toBe('commercial');
        } finally {
          gates.editApptPriceServiceScope = saved;
        }
      });

      // The fake applies no filter, so this pins the filter: every visit row of this customer that keeps a
      // template, whatever its status. PostgreSQL proves a completed root and another customer's root.
      test('the read asks for every saved template of this customer', async () => {
        const reads = [];
        await blocker(world({ tables: { 'scheduled_services as series': (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { 'series.customer_id': 'cust-1' }], ['whereNotNull', 'series.recurring_template_overrides']]]);
      });

      test('the catalog is asked once for each linked service, and only for a link that is a catalog id', async () => {
        const reads = [];
        const templates = [{ service_id: CATALOG_ID }, { service_id: OTHER_CATALOG_ID }, { service_id: CATALOG_ID }, { service_id: 'not-an-id' }, { service_id: 12 }, PRICE_ONLY];
        const db = world({ tables: {
          'scheduled_services as series': templates.map((value) => ({ recurring_template_overrides: value })),
          services: (calls) => { reads.push(calls.map((call) => [...call])); return [HOME_SERVICE]; },
        } });
        expect(await blocker(db)).toBeNull();
        expect(reads).toEqual([[['whereIn', 'id', [CATALOG_ID, OTHER_CATALOG_ID]]]]);
      });

      test.each([
        ['no template links a catalog service', [PRICE_ONLY, { service_type: 'Pest Control' }]],
        ['no link is a catalog id', [{ service_id: 'not-an-id' }, { service_id: '' }, { service_id: null }]],
        ['no visit keeps a template', []],
      ])('the catalog is not read when %s', async (_label, templates) => {
        const reads = [];
        const db = world({ tables: {
          'scheduled_services as series': templates.map((value) => ({ recurring_template_overrides: value })),
          services: (calls) => { reads.push(calls); return [{ service_key: 'commercial_pest_monthly', name: 'Commercial Monthly Pest' }]; },
        } });
        expect(await blocker(db)).toBeNull();
        expect(reads).toEqual([]);
      });
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

    // The call system's own saved verdict on a call: what the extraction said about the premises and the request,
    // and what the triage decided. Never the words of the call.
    describe('a call of the account', () => {
      // A call about a home, as the call system saves it.
      const HOME_EXTRACTION = {
        property: { property_type: 'single_family', commercial_subtype: null, service_address_occupancy: 'owner_occupied', hoa_common_area_service: false },
        caller: { relationship_to_property: 'owner' },
        service_request: { primary_service_category: 'pest_general', specific_service_name: 'Quarterly Pest Control' },
        commercial_signals: null,
        call_summary: 'Asked about ants in the kitchen.',
        triage_flags: ['quote_promised'],
      };
      const CALL = (change = {}) => ({
        ai_extraction: JSON.stringify({ requested_service: 'Quarterly pest control', call_summary: 'Asked about ants in the kitchen.' }),
        ai_extraction_enriched: HOME_EXTRACTION,
        ai_validation: { routing: { flags: ['quote_promised'], appointment_blocking_flags: [] } },
        ai_address_validation: { status: 'validated_accept', granularity: 'PREMISE', addressUse: { business: false, residential: true, poBox: false } },
        ...change,
      });
      const extraction = (change) => ({ ai_extraction_enriched: { ...HOME_EXTRACTION, ...change } });
      const addressUse = (use) => ({ ai_address_validation: { status: 'validated_accept', granularity: 'PREMISE', addressUse: use } });
      const withCalls = (calls, given = {}) => world({ ...given, tables: { call_log: calls } });

      // Each case carries ONE mark, between two calls about a home.
      test.each([
        // The app's rule for an extraction that typed the premises commercial.
        ['a commercial property type', CALL(extraction({ property: { property_type: 'commercial' } }))],
        ['a commercial subtype on a type that reads as a home', CALL(extraction({ property: { property_type: 'unknown', commercial_subtype: 'other' } }))],
        ['an HOA common area service at a condo', CALL(extraction({ property: { property_type: 'condo', hoa_common_area_service: true } }))],
        ['the owner of a multi-unit building', CALL(extraction({ property: { property_type: 'multi_family' }, caller: { relationship_to_property: 'owner' } }))],
        ['a commercial occupancy of the service address', CALL(extraction({ property: { property_type: 'unknown', service_address_occupancy: 'commercial' } }))],
        // The first format keeps the occupancy at its root, and both formats keep the other properties of the call.
        ['a commercial occupancy of the service address in the first format', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Pest control', service_address_occupancy: 'commercial' }) })],
        ['an additional property with a commercial occupancy', CALL(extraction({ property: { property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: 'commercial', property_type: null }] } }))],
        ['an additional property of a commercial type', CALL(extraction({ property: { property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: null, property_type: 'commercial' }] } }))],
        ['an additional property with a commercial occupancy in the first format', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', is_rental: false, occupancy: 'commercial', property_type: null }] }) })],
        ['an additional property that is an HOA common area in the first format', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', occupancy: null, property_type: 'hoa_common_area' }] }) })],
        // The commercial-signals block: the extraction leaves it null for a home.
        ['a business name in the commercial-signals block', CALL(extraction({ commercial_signals: { business_name: 'Synthetic Bakery', annual_contract_interest: false } }))],
        ['a compliance need in the commercial-signals block', CALL(extraction({ commercial_signals: { business_name: null, insurance_or_compliance_requirements: ['certificate of insurance'] } }))],
        ['a confirmed decision authority in the commercial-signals block', CALL(extraction({ commercial_signals: { decision_authority_confirmed: true } }))],
        // The two flags of the triage, wherever a verdict keeps them.
        ["the commercial flag among the extraction's own flags", CALL(extraction({ triage_flags: ['quote_promised', 'commercial_requires_quote'] }))],
        ['the commercial flag among the routing flags', CALL({ ai_validation: { routing: { flags: ['commercial_requires_quote'] } } })],
        ['the commercial flag among the flags that hold a booking', CALL({ ai_validation: { routing: { flags: [], appointment_blocking_flags: ['commercial_requires_quote'] } } })],
        ['the HOA flag in a list of another name', CALL({ ai_validation: { routing: { flags: [] }, gates: { demoted: ['hoa_common_area_requires_approval'] } } })],
        ['a validation saved as JSON text', CALL({ ai_validation: JSON.stringify({ routing: { flags: ['commercial_requires_quote'] } }) })],
        ['an extraction saved as JSON text', CALL({ ai_extraction_enriched: JSON.stringify({ property: { property_type: 'commercial' } }) })],
        // The first format of the extraction: the service the caller asked for.
        ['a commercial service in the first format', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Commercial pest control' }) })],
        ["a commercial service inside the first format's object", CALL({ ai_extraction: JSON.stringify({ requested_service: { primary: 'Pest control', also: ['Monthly COMMERCIAL kitchen service'] } }) })],
        // The extraction names the service in its own field. A first format built from an extraction keeps the
        // service category in requested_service, so the name is in the extraction only.
        ['a commercial service name in the extraction, behind a generic first format', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'pest_general' }),
          ...extraction({ service_request: { primary_service_category: 'pest_general', specific_service_name: 'Commercial Pest Control' } }),
        })],
        // The first format keeps the service under two more names: the catalog match and the catalog name.
        ['a commercial catalog match in the first format, behind a home request', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Pest control', matched_service: 'Commercial Pest Control' }) })],
        ['a commercial catalog name in the first format', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Pest control', matched_service: 'Pest Control', specific_service_name: 'Commercial Pest Control' }) })],
        // What an adoption replaced in the first format is kept there in a record of its own.
        ['a commercial catalog match that an adoption replaced in the first format', CALL({ ai_extraction: JSON.stringify({
          requested_service: 'pest_general', matched_service: 'Pest Control',
          pre_adoption_service_fields: { matched_service: 'Commercial Pest Control', requested_service: null, specific_service_name: null },
        }) })],
        ['a commercial request that an adoption replaced in the first format', CALL({ ai_extraction: JSON.stringify({
          requested_service: 'pest_general', pre_adoption_service_fields: { requested_service: 'Pest service for a commercial kitchen' },
        }) })],
        // The three names are read on every object of the extraction too.
        ['a service name on another object of the extraction', CALL(extraction({ adopted: { matched_service: 'Commercial Lawn Care' } }))],
        // The address check: Google reads the service address as a business and not as a home.
        ['an address the check reads as a business and not as a home', CALL(addressUse({ business: true, residential: false, poBox: false }))],
        ['an address check saved as JSON text', CALL({ ai_address_validation: JSON.stringify({ status: 'corrected', addressUse: { business: true, residential: false } }) })],
      ])('%s: commercial, and no plan record is read', async (_label, call) => {
        const reads = [];
        const db = withCalls([CALL(), call, CALL()], { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test.each([
        ['a call about a home', CALL()],
        ['the tenant of an apartment', CALL(extraction({ property: { property_type: 'multi_family' }, caller: { relationship_to_property: 'tenant' } }))],
        ['the owner of a condo', CALL(extraction({ property: { property_type: 'condo' }, caller: { relationship_to_property: 'owner' } }))],
        ['a commercial-signals block with nothing set', CALL(extraction({
          commercial_signals: { business_name: null, budget_signal: '  ', decision_authority_confirmed: false, annual_contract_interest: null, insurance_or_compliance_requirements: [] },
        }))],
        ['a call with no extraction and no validation', CALL({ ai_extraction: null, ai_extraction_enriched: null, ai_validation: null })],
        ['a blank first format', CALL({ ai_extraction: '  ' })],
        ['a first format with no requested service', CALL({ ai_extraction: JSON.stringify({ call_summary: 'Voicemail, no request.' }) })],
        // The first format is a TEXT column: an empty text is "no extraction", not a failed read.
        ['a first format that is an empty text', CALL({ ai_extraction: '  ' })],
        ['an extraction with no service name', CALL(extraction({ service_request: { primary_service_category: 'other', specific_service_name: null } }))],
        // Only the service name counts in the service request: a price quote is the words of the call.
        ['the word in another field of the service request', CALL(extraction({
          service_request: { specific_service_name: 'Pest control', price: { evidence_quote: 'The commercial rate is higher than the home rate.' } },
        }))],
        ['other flags', CALL({ ai_validation: { routing: { flags: ['quote_promised', 'out_of_service_area'], appointment_blocking_flags: ['caller_not_authorized'] } } })],
        // Both halves of the address use must be affirmative.
        ['an address the check reads as a business and as a home', CALL(addressUse({ business: true, residential: true }))],
        ['a business address whose residential half is unknown', CALL(addressUse({ business: true, residential: null }))],
        ['an address that is neither, by the check', CALL(addressUse({ business: false, residential: false }))],
        ['an address use the check did not get', CALL(addressUse(null))],
        ['a call with no address check', CALL({ ai_address_validation: null })],
        // Other properties of the call that are homes, in both formats.
        ['a second home and a rental among the properties of the call', CALL({
          ai_extraction: JSON.stringify({
            requested_service: 'Pest control', service_address_occupancy: 'owner_occupied',
            additional_properties: [{ address_line1: '12 Example Test Way', is_rental: true, occupancy: 'rental_investment', property_type: 'multi_family' }],
          }),
          ...extraction({ property: { property_type: 'single_family', service_address_occupancy: 'seasonal', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: 'rental_investment', property_type: 'condo' }] } }),
        })],
        // Home services under all three names, in both formats.
        ['home services under every name of a service, in both formats', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Lawn care', matched_service: 'Lawn Care', specific_service_name: 'Monthly Lawn Care' }),
          ...extraction({ service_request: { primary_service_category: 'lawn_care', secondary_categories: ['pest_general'], specific_service_name: 'Monthly Lawn Care' } }),
        })],
        // The other two service fields of the first format are the words of the call, at its root and in the
        // record of what an adoption replaced.
        ['the word in the pain points, and in the summary an adoption replaced', CALL({ ai_extraction: JSON.stringify({
          requested_service: 'Pest control', matched_service: 'Pest Control', specific_service_name: 'Quarterly Pest Control',
          pain_points: ['The commercial spray from the store did not work'],
          pre_adoption_service_fields: { call_summary: 'Works at a commercial bakery. Wants service at home.', pain_points: ['Tried a commercial product'], matched_service: 'Pest Control' },
        }) })],
        // The words of a call are not read: the caller can name a workplace and want service at home.
        ['the word in the summaries of the call', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Pest control at home', call_summary: 'Works at a commercial bakery. Wants service at home.' }),
          ...extraction({ call_summary: 'Mentioned the commercial bakery where he works.', triage_flags: ['commercial requires quote?'] }),
        })],
      ])('%s is not commercial', async (_label, call) => {
        expect(await blocker(withCalls([call, CALL()]))).toBeNull();
      });

      // The extraction, the validation and the address check are jsonb columns: a text there is a valid value
      // with no mark, never a failed read.
      test.each([
        ["a call's extraction", { ai_extraction_enriched: 'asked about pest control' }],
        ["a call's validation", { ai_validation: '{"routing":' }],
        ["a call's address check", { ai_address_validation: 'not checked' }],
      ])('%s that is one text carries no mark: not commercial', async (_what, change) => {
        expect(await blocker(withCalls([CALL(), CALL(change)]))).toBeNull();
      });

      // The first format is serialized JSON in a TEXT column. A text there that is not JSON is a failed read,
      // as a failed query is: never "a home".
      test("a call's first extraction that is text and not JSON is a failed read", async () => {
        await expect(blocker(withCalls([CALL(), CALL({ ai_extraction: 'extraction failed' })]))).rejects.toThrow("could not read a call's first extraction");
      });

      // The rule belongs to the estimator engine. A mark only that rule reads must count: the proof asks it.
      test("a mark only the app's rule for a call extraction reads counts", async () => {
        const owner = require('../services/estimator-engine/unit-scope-model');
        const real = owner.commercialCategoryConflict;
        const spy = jest.spyOn(owner, 'commercialCategoryConflict')
          .mockImplementation((given, ...rest) => (given?.extraction?.depot === true ? 'depot' : real(given, ...rest)));
        const calls = [CALL(), CALL(extraction({ depot: true }))];
        try {
          expect(await blocker(withCalls(calls))).toBe('commercial');
        } finally {
          spy.mockRestore();
        }
        expect(await blocker(withCalls(calls))).toBeNull();
      });

      // The triage writes the two flags the rule reads (call-triage-flags.js). A rename there fails here.
      test('the triage still raises the two flags by these names', () => {
        const { computeDeterministicTriageFlags } = require('../services/call-triage-flags');
        expect(computeDeterministicTriageFlags({ meta: {}, property: { property_type: 'commercial' } })).toContain('commercial_requires_quote');
        expect(computeDeterministicTriageFlags({ meta: {}, property: { hoa_common_area_service: true } })).toContain('hoa_common_area_requires_approval');
        expect(computeDeterministicTriageFlags({ meta: {}, property: { property_type: 'single_family' } }))
          .toEqual(expect.not.arrayContaining(['commercial_requires_quote', 'hoa_common_area_requires_approval']));
      });

      test('home calls only, and a plan record: the plan is the answer', async () => {
        const db = withCalls([CALL(), CALL()], { visits: onlyFor(isCalendarRead, [FLAGGED]) });
        expect(await blocker(db)).toBe('has_plan');
      });

      test('the read asks for every call of this customer, whatever its age or direction', async () => {
        const reads = [];
        await blocker(world({ tables: { call_log: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1' }]]]);
      });
    });

    // The judge of a day agreement reads a call or a text thread, and the app saves its blockers with the decision.
    describe('a day-agreement decision of the account', () => {
      const withDecisions = (judgedList, given = {}) => world({ ...given, tables: { day_agreement_decisions: judgedList.map((judged) => ({ judged })) } });

      test.each([
        ['the commercial blocker', [{ act: false, blockers: ['commercial'] }]],
        ['the commercial blocker among others, beside a clean decision', [{ act: true, blockers: [] }, { act: false, blockers: ['vague_day', 'commercial'] }]],
        ['a decision saved as JSON text', [JSON.stringify({ act: false, blockers: ['commercial'] })]],
        ['the blocker as a bare word, not a list', [{ act: false, blockers: 'commercial' }]],
      ])('%s: commercial, and no plan record is read', async (_label, judgedList) => {
        const reads = [];
        const db = withDecisions(judgedList, { ...ONGOING_COLUMN, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test.each([
        ['other blockers', [{ act: false, blockers: ['complaint', 'other'] }]],
        ['no blockers', [{ act: true, blockers: [] }]],
        ['a source that was never judged', [null]],
        ['a blocker that only holds the word', [{ act: false, blockers: ['not_commercial', 'commercial work?'] }]],
        ['the word in the reason of the judge, which is not read', [{ act: true, blockers: [], reason: 'commercial' }]],
      ])('%s is not commercial', async (_label, judgedList) => {
        expect(await blocker(withDecisions(judgedList))).toBeNull();
      });

      test("the judge's vocabulary names the blocker the rule reads", () => {
        expect(require('../services/prompts/day-agreement-v1').BLOCKERS).toContain('commercial');
      });

      // A jsonb column: a text in it is a valid value with no blocker, never a failed read.
      test('a decision that is one text carries no blocker: not commercial', async () => {
        expect(await blocker(withDecisions(['not judged', '']))).toBeNull();
      });

      test('the read asks for every decision of this customer', async () => {
        const reads = [];
        await blocker(world({ tables: { day_agreement_decisions: (calls) => { reads.push(calls.map((call) => [...call])); return []; } } }));
        expect(reads).toEqual([[['where', { customer_id: 'cust-1' }]]]);
      });
    });

    test('an account that is commercial by its own row is answered with no read of any other record', async () => {
      const reads = [];
      const record = (name) => (calls) => { reads.push([name, calls]); return []; };
      const db = world({
        customer: { building_use: 'residential' },
        tables: {
          estimates: record('estimates'), leads: record('leads'), 'scheduled_services as record': record('visits'),
          'scheduled_service_addons as addon': record('add-ons'),
          'scheduled_services as series': record('series templates'), services: record('catalog'),
          'service_records as record': record('reports'), customer_contracts: record('contracts'),
          call_log: record('calls'), day_agreement_decisions: record('day agreements'),
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
      ['the read of the visit add-ons', { tables: { 'scheduled_service_addons as addon': failing('add-on read down') } }, 'add-on read down'],
      ['the read of the series templates', { tables: { 'scheduled_services as series': failing('series template read down') } }, 'series template read down'],
      ['the catalog read of a series template', { tables: { 'scheduled_services as series': [{ recurring_template_overrides: { service_id: '0b9f5c1e-6f0a-4c3e-9d2b-5a7e8c4d1f20' } }], services: failing('catalog read down') } }, 'catalog read down'],
      ['the read of the service report services', { tables: { 'service_records as record': failing('report service read down') } }, 'report service read down'],
      ['the read of the contracts', { tables: { customer_contracts: failing('contract read down') } }, 'contract read down'],
      ['the read of the calls', { tables: { call_log: failing('call read down') } }, 'call read down'],
      ['the read of the day-agreement decisions', { tables: { day_agreement_decisions: failing('decision read down') } }, 'decision read down'],
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
