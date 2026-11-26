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

const { planStartBlocker, resolvedPropertyTypeBlocker, PLAN_START_BLOCKERS } = require('../services/plan-start-eligibility');

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
      // Types only the estimator's recognition of a typed premises knows.
      ['a hotel', { property_type: 'hotel' }],
      ['a motel in another case', { property_type: 'Motel' }],
      ['a church', { property_type: 'church' }],
      ['a resort', { property_type: 'resort' }],
      ['a flex space', { property_type: 'flex space' }],
      ['the grounds of an association', { property_type: 'neighborhood association' }],
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
      // A label with no such word that names a business premises, in the wording the lead intake reads.
      ['a service label on the account that names a business premises', { lead_service_interest: 'Pest control for a hotel' }],
    ])('%s: commercial, and no plan record is read', async (_label, customer) => {
      const reads = [];
      const db = world({ ...ONGOING_COLUMN, customer, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
      expect(await blocker(db)).toBe('commercial');
      expect(reads).toEqual([]);
    });

    test.each([['single_family'], ['condo_ground'], ['mobile_home'], ['duplex'], ['vacant_lot'], ['house'], ['unknown'], [null], ['']])('a property type of %j with no tier is not commercial', async (property_type) => {
      expect(await blocker(world({ customer: { property_type } }))).toBeNull();
    });

    // The estimator's rule for a typed premises reads the client too: a property manager on a condo is
    // commercial, and the owner of a condo is a home. The account's contact role covers the whole profile.
    describe('the account of a property manager', () => {
      test.each([['condo'], ['Condo'], ['condo_ground'], ['Condo Upper'], ['condominium']])('with the type %j on its own row: commercial, and no plan record is read', async (property_type) => {
        const reads = [];
        const db = world({ ...ONGOING_COLUMN, customer: { contact_role: 'property_manager', property_type }, visits: (calls) => { reads.push(calls); return [FLAGGED]; } });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      test.each([['Property_Manager'], [' property_manager ']])('the role in the spelling %j is a manager', async (contact_role) => {
        expect(await blocker(world({ customer: { contact_role, property_type: 'condo' } }))).toBe('commercial');
      });

      test.each([['owner'], ['tenant'], [null], [undefined], ['']])('a contact with the role %j and a condo is a home', async (contact_role) => {
        expect(await blocker(world({ customer: { contact_role, property_type: 'condo' } }))).toBeNull();
      });

      // The proof knows a manager by the exact word, and the estimator's resolver by a pattern (manager,
      // management). They must agree on every role the app can save: a role added later that the estimator
      // reads as a manager fails here until the proof reads it too.
      test('every contact role is a manager for the proof exactly where the estimator reads one', async () => {
        const { commercialCategoryConflict } = require('../services/estimator-engine/unit-scope-model');
        const { CONTACT_ROLES } = require('../constants/contact-roles');
        expect(CONTACT_ROLES).toContain('property_manager');
        const answers = [];
        const expected = [];
        for (const contact_role of CONTACT_ROLES) {
          const extraction = { caller: { relationship_to_property: contact_role }, property: { property_type: 'condo' } };
          expected.push([contact_role, commercialCategoryConflict({ extraction, intent: null }) ? 'commercial' : null]);
          answers.push([contact_role, await blocker(world({ customer: { contact_role, property_type: 'condo' } }))]);
        }
        expect(answers).toEqual(expected);
        expect(expected.map(([, answer]) => answer)).toContain('commercial');
      });

      // The rule is for a unit of a multi-unit building. A manager's single home is a home by the app's rule.
      test.each([['single_family'], ['townhome'], ['duplex'], ['mobile_home'], ['unknown'], [null]])('a property manager with the type %j, on the row and on a saved property, is not commercial', async (property_type) => {
        const db = world({ customer: { contact_role: 'property_manager', property_type }, tables: { customer_properties: [PROPERTY({ property_type, relationship: 'managed_for_client' })] } });
        expect(await blocker(db)).toBeNull();
      });
    });

    test.each([['Pest Control'], ['Quarterly Pest + Lawn'], ['Pest control for the home office'], ['Lawn care for my house'], [null], [undefined], ['']])('a service label of %j on the account is not commercial', async (lead_service_interest) => {
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
        // Types only the estimator's recognition knows, on an account whose own row carries no type.
        ['a hotel', [PROPERTY({ property_type: 'hotel' })]],
        ['a second property is a church and the primary one is a home', [PROPERTY(), PROPERTY({ id: 'prop-2', is_primary: false, property_type: 'Church' })]],
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

      test.each([['single_family'], ['townhome'], ['condo'], ['mobile_home'], ['duplex'], ['vacant_lot'], [null], ['']])('a saved property with the type %j is not commercial', async (property_type) => {
        expect(await blocker(world({ tables: { customer_properties: [PROPERTY({ property_type }), PROPERTY({ id: 'prop-2', is_primary: false, property_type })] } }))).toBeNull();
      });

      // A condo the customer manages for a client: by the property's own relationship, or by the account's
      // role. The account row carries no type here, so the saved property is the only mark.
      const MANAGED_CONDO = (change = {}) => PROPERTY({ property_type: 'condo', relationship: 'managed_for_client', occupancy_type: 'rental_investment', ...change });
      test.each([
        ['a condo managed for a client, on the account of a property manager, with a residential occupancy', { contact_role: 'property_manager' }, [MANAGED_CONDO({ occupancy_type: 'owner_occupied' })]],
        ['a condo managed for a client, on an account with no role', {}, [MANAGED_CONDO()]],
        ['a condo with no relationship, on the account of a property manager', { contact_role: 'property_manager' }, [MANAGED_CONDO({ relationship: null })]],
        // The role covers the whole profile: the app reads every property of a manager's profile as a client's.
        ['a condo recorded as an own home, on the account of a property manager', { contact_role: 'property_manager' }, [MANAGED_CONDO({ relationship: 'own_home', occupancy_type: 'owner_occupied' })]],
        ['a second property is a managed condo and the primary one is a home', {}, [PROPERTY(), MANAGED_CONDO({ id: 'prop-2', is_primary: false, property_type: 'condo_upper' })]],
        ['a removed property was a managed condo', {}, [PROPERTY(), MANAGED_CONDO({ id: 'prop-2', is_primary: false, active: false })]],
      ])('%s: commercial, and no plan record is read', async (_label, customer, properties) => {
        const reads = [];
        const db = world({
          ...ONGOING_COLUMN, customer: { property_type: null, ...customer }, visits: (calls) => { reads.push(calls); return [FLAGGED]; },
          tables: { customer_properties: properties },
        });
        expect(await blocker(db)).toBe('commercial');
        expect(reads).toEqual([]);
      });

      // Every other relationship the schema knows, and a property with none: the owner of a condo is a home.
      test.each([['own_home'], ['rental_owned'], ['family_home'], [null], [undefined]])('a condo with the relationship %j, on an account with no manager role, is a home', async (relationship) => {
        const condo = PROPERTY({ property_type: 'condo', relationship, occupancy_type: 'owner_occupied' });
        expect(await blocker(world({ customer: { property_type: 'condo' }, tables: { customer_properties: [condo, PROPERTY({ id: 'prop-2', is_primary: false, property_type: 'condo_ground', relationship })] } }))).toBeNull();
      });

      // The proof reads one relationship as a manager's. A relationship the app adds later fails here until
      // someone sorts it: a manager's, or the customer's own.
      test('every relationship of a saved property is sorted: managed for a client, or not', async () => {
        const { PROPERTY_RELATIONSHIPS } = require('../constants/property-relationships');
        expect([...PROPERTY_RELATIONSHIPS].sort()).toEqual(['family_home', 'managed_for_client', 'own_home', 'rental_owned']);
        const answers = [];
        for (const relationship of PROPERTY_RELATIONSHIPS) {
          answers.push([relationship, await blocker(world({ tables: { customer_properties: [PROPERTY({ property_type: 'condo', relationship })] } }))]);
        }
        expect(answers).toEqual(PROPERTY_RELATIONSHIPS.map((relationship) => [relationship, relationship === 'managed_for_client' ? 'commercial' : null]));
      });

      test.each([['single_family'], ['townhome'], ['duplex'], ['mobile_home'], [null]])('a property of the type %j that is managed for a client is not commercial', async (property_type) => {
        expect(await blocker(world({ tables: { customer_properties: [PROPERTY({ property_type, relationship: 'managed_for_client' })] } }))).toBeNull();
      });

      // One managed property does not make the customer's own condo a business: the relationship is the
      // property's own.
      test('a managed single home beside an own condo: homes', async () => {
        const properties = [PROPERTY({ property_type: 'condo', relationship: 'own_home' }), PROPERTY({ id: 'prop-2', is_primary: false, relationship: 'managed_for_client' })];
        expect(await blocker(world({ customer: { property_type: 'condo' }, tables: { customer_properties: properties } }))).toBeNull();
      });

      // Three owners each keep a rule for a commercial property type: the account rule
      // (self-booking-plan-sync.js), the pricing engine and the estimator (its rule for a typed premises). No
      // one of them holds the other two. All three are asked, for the account's type and for a saved
      // property's, so a type that any owner adds counts.
      test.each([
        ['the account rule', '../services/self-booking-plan-sync', 'isCommercialAccount'],
        ['the pricing engine', '../services/pricing-engine/commercial-helpers', 'isCommercialProperty'],
        ['the estimator', '../services/estimator-engine/unit-scope-model', 'commercialCategoryConflict'],
      ])('a type only %s calls commercial counts, on the account row and on a saved property', async (_label, modulePath, rule) => {
        const owner = require(modulePath);
        const real = owner[rule];
        const spy = jest.spyOn(owner, rule).mockImplementation((given, ...rest) => (
          given?.property_type === 'depot' || given?.propertyType === 'depot' || given?.extraction?.property?.property_type === 'depot' || real(given, ...rest)));
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
        // Types only the estimator's recognition of a typed premises knows, under either spelling of the name.
        ['a hotel in the form inputs, beside a toggle set to no', ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Hotel' } } })],
        ['a church in the saved spelling', ESTIMATE({ estimate_data: { snapshot: { property_type: 'church' } } })],
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
        // A label with no such word that names a business premises, in the wording the lead intake reads: in
        // the column, and in a copy the payload keeps beside a home plan line.
        ['a service label that names a business premises', ESTIMATE({ service_interest: 'Pest control for a hotel' })],
        ['a label copy that names a business premises, on an estimate with a home plan line', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family', leadServiceInterest: 'Lawn care at our office' },
          result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care' }] } },
        } })],
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
        // The listing is not read, and the scope staff decided beside it still is.
        ['one suite, as staff decided, beside the listing of the business', ESTIMATE({ estimate_data: PROFILE({
          serviceScopeDecision: 'commercial_suite', serviceScopeSuggestion: 'suite',
          businessIdentity: { name: 'Corner Cafe', type: 'restaurant_food_service', matchedBy: 'subpremise', tenantsAtNumber: 3, unitKey: 'business:place-1' },
        }) })],
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
          businessIdentity: { name: 'Corner Cafe', type: 'restaurant_food_service', matchedBy: 'street_number', tenantsAtNumber: 2, unitKey: 'business:place-1' },
        }) })],
        // The name of a listed business can carry the word, and a name is what the rule for a service line reads.
        // A listing only suggests, so the scan does not go into it: with the question open, after the answer
        // "not this business", and wherever the payload keeps the profile.
        ['a listing whose name carries the word, with the question still open', ESTIMATE({ estimate_data: PROFILE({
          serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: 'Are we treating just your space or the whole building?', serviceScopeSuggestion: 'suite', occupancyAnswer: null,
          businessIdentity: { name: 'Commercial Realty', type: 'office_retail', matchedBy: 'street_number', tenantsAtNumber: 1, unitKey: 'business:place-2' },
        }) })],
        ['such a listing after staff answered that the customer is not that business', ESTIMATE({ estimate_data: PROFILE({
          serviceScopeDecision: null, occupancyAnswer: 'none',
          businessIdentity: { name: 'Commercial Realty', type: 'office_retail', matchedBy: 'street_number', tenantsAtNumber: 1, unitKey: 'business:place-2' },
        }) })],
        ['such a listing far down in the payload', ESTIMATE({ estimate_data: farDown({ serviceScopeDecision: 'scope_unresolved', businessIdentity: { name: 'Commercial Realty', type: 'office_retail' } }) })],
        // Wording near the intake's rule that names a home, and home types by every rule for a type.
        ['service labels that name a home', ESTIMATE({ service_interest: 'Pest control for the home office', estimate_data: {
          inputs: { isCommercial: 'NO', leadServiceInterest: 'Lawn care for my house' }, engineInputs: { serviceInterest: 'Mosquito service for a townhome' },
        } })],
        ['home types under either spelling of the name', ESTIMATE({ estimate_data: { inputs: { propertyType: 'Mobile Home' }, engineInputs: { propertyType: 'house' }, snapshot: { property_type: 'vacant_lot' } } })],
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
        // A text is a key only where it is one word of a key's characters. A payload keeps contact details too.
        ['contact details that start with the prefix', ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, customer: { email: 'commercial_accounts@example.test' }, sentTo: [' Commercial_Billing@example.test '], site: 'commercial_pest.example.test/quote',
        } })],
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

      // The estimator form and the engine keep the occupancy of a bed bug job apart from the property type, and
      // the form saves a residential type by default. The engine reads the three occupancies that are not a
      // single-family home as an explicit commercial scope. A payload also keeps a property's own occupancy.
      test.each([
        ["a hotel as the estimator form's bed bug occupancy, beside the default property type", { inputs: { isCommercial: 'NO', propertyType: 'Single Family', bedbugOccupancyType: 'hotel' } }],
        ["a hotel on the engine's bed bug service", { engineRequest: { services: { bedBug: { rooms: 2, method: 'CHEMICAL', severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } } } }],
        ['student housing on a priced bed bug line', { engineResult: { lineItems: [{ service: 'bed_bug', rooms: 2, occupancyType: 'studentHousing' }] } }],
        ['an apartment in another spelling', { inputs: { isCommercial: 'NO', propertyType: 'Single Family', bedbugOccupancyType: ' Apartment ' } }],
        ['the commercial occupancy of a property row the payload keeps', { property: { occupancy_type: 'commercial', property_type: 'single_family' } }],
        ['the commercial occupancy in the other spelling, far down', farDown({ occupancyType: 'commercial' })],
        ['the commercial occupancy of an extra property', { additional_properties: [{ address_line1: '12 Example Test Way', occupancy: 'commercial', property_type: 'single_family' }] }],
        // The two fields of a call's property that say commercial beside a home type.
        ["the commercial occupancy of a call's main address, where a payload keeps the property", { property: { service_address_occupancy: 'commercial', property_type: 'single_family' } }],
        ['a service of the common areas of an association, beside a condo type', { call: { property: { hoa_common_area_service: true, property_type: 'condo' } } }],
      ])('%s: commercial', async (_label, estimate_data) => {
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data }), ESTIMATE()]))).toBe('commercial');
      });

      test.each([
        ["the estimator form's default bed bug occupancy", { inputs: { isCommercial: 'NO', propertyType: 'Single Family', bedbugOccupancyType: 'singleFamily' } }],
        ["a single-family home on the engine's bed bug service and on its priced line, with the occupancy multiplier", {
          engineRequest: { services: { bedBug: { rooms: 2, occupancyType: 'singleFamily' } } },
          engineResult: { lineItems: [{ service: 'bed_bug', occupancyType: 'singleFamily', multipliers: { occupancy: 1.3, severity: 1 } }] },
        }],
        ['the word residential as an occupancy', { engineRequest: { services: { bedBug: { occupancyType: 'residential' } } } }],
        ['the home occupancies of a property', { properties: [{ occupancy_type: 'owner_occupied' }, { occupancyType: 'rental_investment' }, { occupancy: 'unknown' }, { occupancy: null }, { occupancy_type: '' }] }],
        ['a hotel under a name that keeps no occupancy', { inputs: { isCommercial: 'NO', bedbugNote: 'hotel', stayedAt: 'hotel' } }],
        ["a home occupancy of a call's main address, with no common-area service, in an association", {
          property: { service_address_occupancy: 'owner_occupied', hoa_common_area_service: false, hoa_community_flag: true, property_type: 'single_family' },
          earlier: { property: { service_address_occupancy: null, hoa_common_area_service: null, property_type: 'condo' } },
        }],
      ])('%s is not commercial', async (_label, estimate_data) => {
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data }), ESTIMATE()]))).toBeNull();
      });

      // The marketing attribution of a web submission is not read, also where an estimate payload keeps a copy.
      test('the attribution of a web submission in an estimate payload is not read, and the same key as a picked service is a mark', async () => {
        const ad = { source: 'google', campaign: 'commercial_pest', label: 'Commercial Pest Control ad' };
        const intake = { attribution: { utm: ad, formId: 'commercial_quote_form' }, utm: ad, clickIds: { gclid: 'commercial_click' }, source_evidence: ad, referrer: 'commercial_pest', landing_url: 'commercial_pest' };
        const kept = (more) => ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, intake: { ...intake, ...more } } });
        expect(await blocker(withEstimates([kept({}), ESTIMATE({ estimate_data: farDown(intake) }), ESTIMATE()]))).toBeNull();
        expect(await blocker(withEstimates([ESTIMATE(), kept({ pickedServices: ['commercial_pest'] })]))).toBe('commercial');
      });

      // The reader of service lines looks for a RECURRING line before it sorts the notes. An estimate for a
      // one-time job keeps its priced line as a one-time item, under one of the six lists the reader takes such
      // lines from. Its notes are free text, and they are not sorted either.
      const HOUSE_NOTES = 'Pest treatment for the house. No commercial service.';
      const ONE_TIME = { service: 'pest_onetime', name: 'One-Time Pest Control', price: 150 };
      test.each([
        ['result.oneTime.items', { result: { oneTime: { items: [ONE_TIME] } } }],
        ['result.oneTime.specItems', { result: { oneTime: { specItems: [ONE_TIME] } } }],
        ['result.specItems', { result: { specItems: [ONE_TIME] } }],
        ['engineResult.oneTime.items', { engineResult: { oneTime: { items: [ONE_TIME] } } }],
        ['engineResult.oneTime.specItems', { engineResult: { oneTime: { specItems: [ONE_TIME] } } }],
        ['engineResult.specItems', { engineResult: { specItems: [ONE_TIME] } }],
      ])('the notes of an estimate with a one-time line under %s are not sorted: not commercial', async (_list, estimate_data) => {
        // The app's reader itself sorts these notes as a commercial line: the proof keeps them from it.
        const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
        expect(inferEstimateServiceLines({ notes: HOUSE_NOTES, estimate_data }).map((line) => line.key)).toContain('commercial_pest');
        expect(await blocker(withEstimates([ESTIMATE({ notes: HOUSE_NOTES, estimate_data }), ESTIMATE()]))).toBeNull();
      });

      // The one-time lines are looked for in the payload the rules read: a payload that came back as JSON text too.
      test('the notes of an estimate whose payload came back as JSON text, with a one-time line in it, are not sorted', async () => {
        const estimate_data = JSON.stringify({ result: { oneTime: { items: [ONE_TIME] } } });
        expect(await blocker(withEstimates([ESTIMATE({ notes: HOUSE_NOTES, estimate_data }), ESTIMATE()]))).toBeNull();
      });

      // The reader joins the notes to whatever else names a service: an area add-on, a pick of the form, the label.
      // The proof asks it without the notes first, and with them only where nothing of the estimate names a service.
      test.each([
        ['an area add-on of the form', { inputs: { areaAddOns: { fire_ant_yard: true } } }, {}],
        ['an area add-on of the engine', { engineInputs: { services: { areaAddOns: [{ key: 'web_sweep' }] } } }, {}],
        ['a one-time pick of the form', { inputs: { svcOnetimePest: true } }, {}],
        ['a label', {}, { service_interest: 'Pest Control' }],
        ['a copy of the label in the payload', { inputs: { leadServiceInterest: 'Lawn Care' } }, {}],
      ])('the notes of an estimate that names a service by %s are not sorted: not commercial', async (_what, estimate_data, columns) => {
        // The app's reader itself answers a commercial line with these notes, and a home line without them.
        const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
        expect(inferEstimateServiceLines({ ...columns, notes: HOUSE_NOTES, estimate_data }).map((line) => line.key)).toContain('commercial_pest');
        expect(inferEstimateServiceLines({ ...columns, notes: null, estimate_data }).map((line) => line.key)).not.toContain('unknown');
        expect(await blocker(withEstimates([ESTIMATE({ ...columns, notes: HOUSE_NOTES, estimate_data }), ESTIMATE()]))).toBeNull();
      });

      test('a commercial service the estimate names itself is a mark, with or without notes', async () => {
        const estimate = (notes) => ESTIMATE({ notes, service_interest: null, estimate_data: { engineInputs: { serviceInterest: 'Commercial Pest Control' } } });
        expect(await blocker(withEstimates([ESTIMATE(), estimate(null)]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), estimate('Ants in the kitchen.')]))).toBe('commercial');
      });

      // Any commercial key the reader answers is a mark, not the pest key alone. No other rule reads the notes.
      test.each([
        ['commercial_lawn', 'Quote the commercial lawn program for the plaza.'],
        ['commercial_mosquito', 'Commercial mosquito service for the patio.'],
        ['commercial_termite_bait', 'Commercial termite bait stations for the shop.'],
        ['commercial_rodent_bait', 'Commercial rodent bait stations for the bakery.'],
        ['commercial_tree_shrub', 'Commercial tree and shrub care for the plaza.'],
      ])('notes the reader sorts as the line %s, on an estimate with no line, are a mark', async (key, notes) => {
        const { inferEstimateServiceLines } = require('../services/estimate-service-lines');
        expect(inferEstimateServiceLines({ notes, estimate_data: {} }).map((line) => line.key)).toEqual([key]);
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ notes, estimate_data: {} })]))).toBe('commercial');
      });

      test('the same notes are sorted on an estimate with no line of either kind, and a commercial one-time line is a mark', async () => {
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ notes: HOUSE_NOTES, estimate_data: {} })]))).toBe('commercial');
        const commercialJob = { result: { oneTime: { items: [{ service: 'commercial_pest', name: 'One-Time Service', price: 150 }] } } };
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ notes: 'Ants in the kitchen.', estimate_data: commercialJob })]))).toBe('commercial');
      });

      // The payload is cut ONCE, before any rule reads it: the proof's own scan, the manager lookup and each of
      // the app's classifiers get it less the seven names no rule reads. The quote page saves the tags of a link
      // as the browser sent them, so a link can put any name there. Each mark below is one the save's scan
      // (isCommercialEstimateData) reads at any depth.
      const LINK_MARKS = Object.entries({ category: 'commercial', isCommercial: true, commercialEstimatedPricing: true, commercialSubtype: 'office', propertyType: 'commercial', service: 'commercial_pest' });
      const UNREAD = [['attribution'], ['utm'], ['clickIds'], ['source_evidence'], ['referrer'], ['landing_url'], ['businessIdentity']];
      test.each(UNREAD)("no mark of the save's scan under the name %s of an estimate payload is read, at the root, far down or in a list", async (name) => {
        const kept = (payload) => ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, ...payload } });
        const answers = [];
        for (const [mark, value] of LINK_MARKS) {
          const under = { [name]: { [mark]: value, deeper: [{ [mark]: value }] } };
          answers.push([mark, await blocker(withEstimates([kept(under), kept({ intake: [farDown(under)] }), ESTIMATE({ estimate_data: [under] }), ESTIMATE()]))]);
          // The same mark under another name counts.
          answers.push([`${mark} under another name`, await blocker(withEstimates([ESTIMATE(), kept({ intake: { [mark]: value } })]))]);
        }
        expect(answers).toEqual(LINK_MARKS.flatMap(([mark]) => [[mark, null], [`${mark} under another name`, 'commercial']]));
      });

      test('a manager named under a name no rule reads is no manager of the estimate', async () => {
        const condo = (more) => ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Condo' }, ...more } });
        const inLink = { utm: { customerRelationship: 'property_manager' }, attribution: { caller: { relationship_to_property: 'property_manager' } }, businessIdentity: { customerRelationship: 'property_manager' } };
        expect(await blocker(withEstimates([condo(inLink), ESTIMATE()]))).toBeNull();
        expect(await blocker(withEstimates([ESTIMATE(), condo({ unitScope: { customerRelationship: 'property_manager' } })]))).toBe('commercial');
      });

      test.each([['bedbugOccupancyType'], ['occupancyType'], ['occupancy_type'], ['occupancy'], ['service_address_occupancy']])('a hotel under the name %s is a mark, and a single-family home under it is none', async (name) => {
        const kept = (value) => ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, job: { [name]: value } } });
        expect(await blocker(withEstimates([ESTIMATE(), kept('hotel')]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), kept('singleFamily')]))).toBeNull();
      });

      // The engine's list of the occupancies it reads as a commercial scope is not exported, so the proof keeps
      // its own. An occupancy the engine adds later fails here until someone sorts it.
      test('every bed bug occupancy the engine prices is sorted: a single-family home, or a commercial scope', async () => {
        const occupancies = Object.keys(require('../services/pricing-engine/constants').BED_BUG.occupancyType);
        expect(occupancies).toContain('singleFamily');
        const answers = [];
        for (const occupancyType of occupancies) {
          answers.push([occupancyType, await blocker(withEstimates([ESTIMATE({ estimate_data: { engineRequest: { services: { bedBug: { occupancyType } } } } })]))]);
        }
        expect(answers).toEqual(occupancies.map((occupancyType) => [occupancyType, occupancyType === 'singleFamily' ? null : 'commercial']));
      });

      // The estimator's verdict on a draft it made: the call or the lookup typed the premises commercial while
      // the draft stayed residential. The draft keeps the verdict in its property facts, and it can be the only
      // record of that call on the account.
      const DRAFT = (categoryConflict, customerRelationship = 'unknown') => ESTIMATE({ estimate_data: {
        inputs: { isCommercial: 'NO', propertyType: 'Condo' },
        estimatorEngine: { version: 1, lane: 'red', laneReasons: [], propertyFacts: { unitScope: { propertyUse: 'condominium', serviceScope: 'residential_unit', customerRelationship }, categoryConflict } },
      } });
      test.each([['property_manager:condo'], ['owner:multi_family'], ['hotel'], ['hoa_common_area_service'], ['commercial_subtype:office'], ['lookup_category:commercial']])(
        "a draft that keeps the estimator's category conflict %j: commercial", async (categoryConflict) => {
          expect(await blocker(withEstimates([ESTIMATE(), DRAFT(categoryConflict), ESTIMATE()]))).toBe('commercial');
        });

      test.each([[null], [undefined], [''], ['  '], [false]])('a draft with a category conflict of %j (no conflict) is not commercial', async (categoryConflict) => {
        expect(await blocker(withEstimates([DRAFT(categoryConflict), ESTIMATE()]))).toBeNull();
      });

      // The estimator's rule reads the client too: the manager of a condo is commercial, and its owner is a
      // home. A type in a payload is asked with a manager where the account is one, or where the payload itself
      // names one (the relationship the estimator resolved, or the caller of a call the payload keeps).
      const MANAGER_ACCOUNT = { customer: { contact_role: 'property_manager' } };
      // A payload can keep the customer's other properties as a call described them (a lead does). An entry there
      // is asked by the call's rule for a property: a building of units is a business with a manager only.
      test("an estimate that keeps the list of a call's other properties reads each entry by the call's rule", async () => {
        const estimate = (property_type) => ESTIMATE({ estimate_data: { ...ESTIMATE().estimate_data, additional_properties: [{ address_line1: '12 Example Test Way', is_rental: true, occupancy: 'rental_investment', property_type }] } });
        expect(await blocker(withEstimates([ESTIMATE(), estimate('multi_family')]))).toBeNull();
        expect(await blocker(withEstimates([ESTIMATE(), estimate('multi_family')], MANAGER_ACCOUNT))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), estimate('commercial')]))).toBe('commercial');
      });
      test('a condo estimate on the account of a property manager, under either spelling of the type: commercial', async () => {
        expect(await blocker(withEstimates([ESTIMATE(), DRAFT(null)], MANAGER_ACCOUNT))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data: farDown({ property_type: 'condo_upper' }) })], MANAGER_ACCOUNT))).toBe('commercial');
      });

      test('a condo estimate that names a property manager itself: commercial', async () => {
        expect(await blocker(withEstimates([ESTIMATE(), DRAFT(null, 'property_manager')]))).toBe('commercial');
        const keptCall = ESTIMATE({ estimate_data: { snapshot: { property_type: 'condo' }, call: farDown({ caller: { relationship_to_property: ' Property_Manager ' } }) } });
        expect(await blocker(withEstimates([ESTIMATE(), keptCall]))).toBe('commercial');
      });

      test.each([['owner'], ['tenant'], ['unknown'], [null], [undefined]])('a condo estimate whose unit scope says %j is a home', async (customerRelationship) => {
        expect(await blocker(withEstimates([DRAFT(null, customerRelationship), ESTIMATE()]))).toBeNull();
      });

      test('a condo under either spelling of the type is a home where no record names a manager', async () => {
        const estimates = [
          ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Condo' } } }),
          ESTIMATE({ estimate_data: { snapshot: { property_type: 'condo' } } }),
          ESTIMATE({ estimate_data: { inputs: { propertyType: 'Condo Upper' }, snapshot: { property_type: 'condo_ground' } } }),
        ];
        expect(await blocker(withEstimates(estimates))).toBeNull();
      });

      test('a manager and no unit of a multi-unit building: a home', async () => {
        const home = ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family' },
          estimatorEngine: { version: 1, propertyFacts: { unitScope: { propertyUse: 'single_family', customerRelationship: 'property_manager' }, categoryConflict: null } },
        } });
        expect(await blocker(withEstimates([home, ESTIMATE()], MANAGER_ACCOUNT))).toBeNull();
      });

      // The manager an estimate names is the client of that estimate. It does not reach another estimate.
      test('a manager named in one estimate and a condo in another: homes', async () => {
        const managedHome = ESTIMATE({ estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family' },
          estimatorEngine: { version: 1, propertyFacts: { unitScope: { propertyUse: 'single_family', customerRelationship: 'property_manager' } } },
        } });
        expect(await blocker(withEstimates([managedHome, DRAFT(null)]))).toBeNull();
      });

      // The use of the building, in the unit scope a draft keeps. The estimator reads it from the type of the
      // record AND from the land use of the parcel, so it can be the only mark of a business on a draft: the type
      // beside it is generic and the scope stays a residential one. The fixture is the estimator's own model.
      const SCOPED = (unitScope) => ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO' }, estimatorEngine: { version: 1, lane: 'yellow', propertyFacts: { unitScope, categoryConflict: null } } } });
      test.each([
        ['an office', 'Other', 'OFFICE BUILDING ONE STORY', 'office'],
        ['a retail building', 'Unknown', 'STORES ONE STORY RETAIL', 'retail'],
        ['an industrial or flex building', null, 'WAREHOUSE STORAGE', 'industrial_flex'],
      ])('the land use of a parcel that says %s, beside a generic type, is the only mark of the draft: commercial', async (_what, propertyType, landUseDescription, propertyUse) => {
        const { resolveUnitScopeModel } = require('../services/estimator-engine/unit-scope-model');
        const unitScope = resolveUnitScopeModel({ propertyRecord: { propertyType, _parcel: { landUseDescription } }, extraction: null, intent: { is_commercial: false }, propertyFacts: {}, address: '12 Example Test Way' });
        expect(unitScope).toMatchObject({ propertyUse, serviceScope: 'entire_residential_structure', customerRelationship: 'unknown' });
        expect(await blocker(withEstimates([ESTIMATE(), SCOPED(unitScope), ESTIMATE()]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), SCOPED({ ...unitScope, propertyUse: 'unknown' }), ESTIMATE()]))).toBeNull();
      });

      // Every word of the estimator's vocabulary for the use, by the estimator's own rule for a typed premises:
      // a business building alone, a building of units with a manager (the tenant of one unit is a home), a
      // house never. The engine's rule for a type is not asked of a use: it reads any multifamily building as a
      // business. The lookup keeps its model's answer under the same name, in four words of its own, and its
      // rule for that answer reads a mixed use as a business.
      test.each([
        ['office', true, true], ['retail', true, true], ['industrial_flex', true, true],
        ['multifamily_rental', false, true], ['condominium', false, true],
        ['single_family', false, false], ['unknown', false, false], [null, false, false], [undefined, false, false], ['', false, false],
        ['COMMERCIAL', true, true], ['MIXED', true, true], [' mixed ', true, true], ['RESIDENTIAL', false, false], ['UNKNOWN', false, false],
      ])('the building use %j of a unit scope: commercial alone %j, with a manager %j', async (propertyUse, alone, withManager) => {
        const draft = (customerRelationship) => SCOPED({ propertyUse, serviceScope: 'entire_residential_structure', customerRelationship });
        expect(await blocker(withEstimates([ESTIMATE(), draft('unknown')]))).toBe(alone ? 'commercial' : null);
        expect(await blocker(withEstimates([ESTIMATE(), draft('tenant')]))).toBe(alone ? 'commercial' : null);
        expect(await blocker(withEstimates([ESTIMATE(), draft('property_manager')]))).toBe(withManager ? 'commercial' : null);
        expect(await blocker(withEstimates([ESTIMATE(), draft('unknown')], MANAGER_ACCOUNT))).toBe(withManager ? 'commercial' : null);
      });

      test('a building use is read on any object of the payload, at any depth', async () => {
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data: farDown({ propertyUse: 'office' }) })]))).toBe('commercial');
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data: farDown({ propertyUse: 'MIXED' }) })]))).toBe('commercial');
      });

      // The lookup's model answers a use type beside the use. The lookup's rule reads a type that is not one of
      // its nine words for "no" and that the pricing engine normalizes to commercial, or the word OTHER.
      test.each([
        ['OFFICE_RETAIL', true], ['WAREHOUSE_LIGHT', true], ['RESTAURANT_FOOD_SERVICE', true], ['MEDICAL_OFFICE', true], ['INDUSTRIAL', true], ['SCHOOL_DAYCARE', true],
        ['GOVERNMENT_MUNICIPAL', true], ['HOA_COMMON_AREA', true], ['MULTIFAMILY_COMMON_AREA', true], ['OTHER', true], [' office_retail ', true],
        ['NONE', false], ['UNKNOWN', false], ['RESIDENTIAL', false], ['NO', false], ['FALSE', false], ['N/A', false], ['NA', false], ['NOT_COMMERCIAL', false], ['NON_COMMERCIAL', false],
        ['SINGLE_FAMILY', false], ['YES', false], ['', false], [null, false], [undefined, false],
      ])("the use type %j of the lookup's model, beside a residential use: commercial %j", async (commercialUseType, expected) => {
        const analysis = ESTIMATE({ estimate_data: { inputs: { isCommercial: 'NO' }, lookup: { analysis: { propertyUse: 'RESIDENTIAL', commercialUseType } } } });
        expect(await blocker(withEstimates([ESTIMATE(), analysis]))).toBe(expected ? 'commercial' : null);
      });

      // The converter's two rules are rules for a SERVICE LINE: they read the word in a line's name, label or
      // display name. A payload keeps other objects with a name (a contact, a product, a summary), and none of
      // those is a line. A service line is an item of a list of service lines, or an object that names a service.
      const LINE_LISTS = ['services', 'lineItems', 'items', 'specItems', 'manualQuoteLines', 'commercialManualQuoteLines', 'quoteRequiredItems'];
      const SERVICE_FIELDS = ['service', 'serviceKey', 'service_key', 'key', 'serviceName', 'service_name'];
      const WORD_FIELDS = ['name', 'label', 'displayName'];
      test.each(WORD_FIELDS)('the word in the %s of an object that is no service line is no mark: not commercial', async (field) => {
        const estimate_data = {
          inputs: { isCommercial: 'NO', propertyType: 'Single Family' },
          customer: { [field]: 'Commercial Realty', email: 'accounts@example.test' },
          products: [{ [field]: 'Commercial Grade Granules', category: 'lawn_care' }],
          result: { summary: { [field]: 'Commercial Realty' } },
          // An object under the name of a list of lines is no item of a list. Nor is an object in it.
          services: { [field]: 'Commercial Realty', picked: { [field]: 'Commercial Realty' } },
          // A blank service field names no service.
          contact: { service: '', serviceKey: null, service_key: '  ', key: false, serviceName: undefined, service_name: 0, [field]: 'Commercial Realty' },
        };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data }), ESTIMATE()]))).toBeNull();
      });

      test.each(LINE_LISTS)('the same word on an item of the list %s is on a service line: commercial', async (list) => {
        for (const field of WORD_FIELDS) {
          const estimate_data = { inputs: { isCommercial: 'NO' }, breakdown: { [list]: [{ price: 150 }, { [field]: 'Commercial Realty', price: 150 }] } };
          expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data })]))).toBe('commercial');
        }
      });

      test('a list in a list of lines keeps the place, and an object under a name of a line starts again', async () => {
        const nested = { breakdown: { services: [[{ name: 'Commercial Realty' }]] } };
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data: nested })]))).toBe('commercial');
        const contactOfALine = { breakdown: { services: [{ price: 150, soldTo: { name: 'Commercial Realty' }, notes: [{ label: 'Commercial Realty' }] }] } };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: contactOfALine }), ESTIMATE()]))).toBeNull();
      });

      test.each(SERVICE_FIELDS)('an object that names a service under %s is a service line wherever it sits', async (field) => {
        // The service it names is a home service: the word in its label is the mark, and only a line's label is read.
        const labelled = { inputs: { isCommercial: 'NO' }, picked: { [field]: 'pest_control', label: 'Commercial Realty' } };
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data: labelled })]))).toBe('commercial');
        // The service it names is commercial itself.
        const named = { inputs: { isCommercial: 'NO' }, picked: { [field]: 'Commercial Pest Control' } };
        expect(await blocker(withEstimates([ESTIMATE(), ESTIMATE({ estimate_data: named })]))).toBe('commercial');
        const home = { inputs: { isCommercial: 'NO' }, picked: { [field]: 'pest_control', label: 'Quarterly Pest Control' } };
        expect(await blocker(withEstimates([ESTIMATE({ estimate_data: home }), ESTIMATE()]))).toBeNull();
      });

      // Each of these rules belongs to another module, and most real marks are read by two or three of them at
      // once. So each is proved with a mark that ONLY that rule reads: the proof must ask every one of them.
      test.each([
        ['the proposal rule', '../services/estimate-proposal', 'isCommercialProposalData', (given) => given],
        ['the payload scan of the save', '../services/estimate-delivery-options', 'isCommercialEstimateData', (given) => given],
        ['the classifier of the accept routes', '../services/estimate-commercial-identity', 'isCommercialAutoAcceptEstimate', (given) => given?.estimate_data],
        ["the pricing engine's rule for a profile", '../services/pricing-engine/commercial-helpers', 'isCommercialProperty', (given) => given],
        // The lookup's own rule, in the module the lookup route calls: the proof keeps no copy of it.
        ["the lookup's rule for its model's answer", '../services/property-lookup/commercial-ai-signal', 'hasStructuredCommercialAiSignal', (given) => given],
        // The converter's two rules are asked of a service line, so their mark sits on an item of a list of lines.
        ["the converter's rule for the names of a service line", '../services/estimate-converter', 'isCommercialRecurringLine', (given) => given, true, { services: [{ depot: true }] }],
        // This rule answers a key, not a yes.
        ["the converter's key for a service line", '../services/estimate-converter', 'recurringServiceKey', (given) => given, 'commercial_pest', { services: [{ depot: true }] }],
        // This one answers the estimate's service lines.
        ["the pipeline's reader of service lines", '../services/estimate-service-lines', 'inferEstimateServiceLines', (given) => given?.estimate_data, [{ key: 'commercial_pest' }]],
      ])('a mark only %s reads counts', async (_label, modulePath, rule, payloadOf, hit = true, estimate_data = { depot: true }) => {
        const owner = require(modulePath);
        const real = owner[rule];
        const spy = jest.spyOn(owner, rule).mockImplementation((given, ...rest) => (payloadOf(given)?.depot === true ? hit : real(given, ...rest)));
        const estimates = [ESTIMATE(), ESTIMATE({ estimate_data })];
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

      // The payload scan of the save belongs to another module, and a rule of the proof reads each mark it reads
      // today. The proof must still ask it: a mark the scan gains later counts on that day.
      test('a mark only the payload scan of the save reads counts on a lead', async () => {
        const owner = require('../services/estimate-delivery-options');
        const real = owner.isCommercialEstimateData;
        const spy = jest.spyOn(owner, 'isCommercialEstimateData').mockImplementation((given, ...rest) => (given?.depot === true ? true : real(given, ...rest)));
        const leads = [LEAD(), LEAD({ extracted_data: { depot: true } })];
        try {
          expect(await blocker(withLeads(leads))).toBe('commercial');
        } finally {
          spy.mockRestore();
        }
        expect(await blocker(withLeads(leads))).toBeNull();
      });

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
        // The mark of an auto-priced commercial quote.
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
        // A label with no such word that names a business premises, on a lead with the default flags: in the
        // column, and in the copy a web form keeps in the payload.
        ['a service label that names a business premises', LEAD({ service_interest: 'Pest control for a hotel' })],
        ['such a label in the payload, behind a home label in the column', LEAD({ extracted_data: { stage: 'lead_webhook_received', service_interest: 'Rodent control at the warehouse' } })],
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
        // The 'business' answer is an answer of a quiz. The same word under the same name in another object is not one.
        ["the word 'business' under `property` in an object that is not a quiz", LEAD({ extracted_data: { survey: { kind: 'pest', property: 'business' }, property: 'business' } })],
        ['a residential category beside a residential type', LEAD({ extracted_data: { enriched: { category: 'RESIDENTIAL', propertyType: 'single_family' }, quote: { commercialEstimatedPricing: false } } })],
        ['an open question about a business at the address, and the answer "not this business"', LEAD({ extracted_data: { enriched: { serviceScopeDecision: 'scope_unresolved', occupancyAnswer: 'none', commercialDetectionSource: null } } })],
        ['labels that name a home, in the column and in the payload', LEAD({ service_interest: 'Pest control for the home office', extracted_data: { stage: 'lead_webhook_received', service_interest: 'Lawn care for my house' } })],
        // A listing only suggests: the scan does not go into it, also where a lead keeps the profile.
        ['a listing whose name carries the word, with the question still open', LEAD({ extracted_data: { enriched: {
          serviceScopeDecision: 'scope_unresolved', occupancyAnswer: null, businessIdentity: { name: 'Commercial Realty', type: 'office_retail', matchedBy: 'street_number', tenantsAtNumber: 1, unitKey: null },
        } } })],
        // A home label in the payload, and the words of a call a payload can keep.
        ['a home service label and the words of a call in the payload', LEAD({ extracted_data: {
          stage: 'lead_webhook_received', service_interest: 'Pest Control', requested_service: 'Ant treatment', pain_points: ['The commercial spray from the store did not work'],
        } })],
      ])('%s is not commercial', async (_label, lead) => {
        expect(await blocker(withLeads([lead, LEAD()]))).toBeNull();
      });

      // The marketing attribution of a web submission says what the advertisement was, not what the premises is.
      // The scan does not go into the six names the intakes save it under. A text that starts with the prefix
      // and a label with the word are the two things a rule would read there.
      const AD = { source: 'google', medium: 'cpc', campaign: 'commercial_pest', content: 'commercial_pest_ad_2', term: 'commercial pest control' };
      test.each([['attribution'], ['utm'], ['clickIds'], ['source_evidence'], ['referrer'], ['landing_url']])('what the link of a visitor carried, under the name %s, is not read', async (name) => {
        const kept = (value) => LEAD({ extracted_data: { stage: 'lead_webhook_received', service_interest: 'Pest Control', [name]: value } });
        expect(await blocker(withLeads([kept('commercial_pest'), LEAD()]))).toBeNull();
        expect(await blocker(withLeads([kept({ ...AD, label: 'Commercial Pest Control ad', kind: 'commercial_campaign' }), LEAD()]))).toBeNull();
        expect(await blocker(withLeads([kept([{ deeper: [AD] }]), LEAD()]))).toBeNull();
      });

      test("a lead with the attribution a web form and the quote page save: not commercial, also far down in the payload", async () => {
        const form = {
          stage: 'lead_webhook_received',
          service_interest: 'Pest Control',
          attribution: {
            leadSource: { source: 'Google Ads', channel: 'paid', detail: 'commercial_pest', area: 'Parrish' },
            formId: 'commercial_quote_form',
            formName: 'Quote form',
            pageUrl: 'https://example.test/commercial-pest-control',
            landingUrl: 'https://example.test/commercial-pest-control',
            utm: AD,
            clickIds: { gclid: 'commercial_click', wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null },
          },
          source_evidence: { kind: 'paid_search', label: 'Commercial Pest Control ad', detail: 'commercial_pest', basis: 'utm' },
        };
        const quotePage = { utm: AD, clickIds: { gclid: 'commercial_click' }, referrer: 'commercial_pest', landing_url: 'https://example.test/commercial-pest-control', source_evidence: form.source_evidence };
        const farDown = Array.from({ length: 20 }).reduce((inner) => ({ next: [inner] }), form);
        expect(await blocker(withLeads([LEAD({ extracted_data: form }), LEAD({ extracted_data: quotePage }), LEAD({ extracted_data: farDown }), LEAD()]))).toBeNull();
      });

      test('the campaign text of an advertisement is a mark where a payload keeps it as a picked service key, and a mark beside an attribution counts', async () => {
        const attribution = { utm: AD };
        expect(await blocker(withLeads([LEAD({ extracted_data: { attribution } }), LEAD()]))).toBeNull();
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { attribution, selectedServices: [AD.campaign] } })]))).toBe('commercial');
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { attribution, picked: { key: AD.campaign } } })]))).toBe('commercial');
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { attribution, isCommercial: 'YES' } })]))).toBe('commercial');
      });

      // A call saves the second contact of a lead with a name, and a name can carry the word. The converter's rule
      // for the names of a service line is not asked of a contact. The same name on a service line is a mark.
      test('the name of a second contact with the word is no service line, and the same name on a service line is', async () => {
        const contact = { stage: 'call_processed', secondary_contact: { name: 'Commercial Realty', email: 'accounts@example.test', relationship: 'billing' } };
        expect(await blocker(withLeads([LEAD({ extracted_data: contact }), LEAD()]))).toBeNull();
        const line = { stage: 'call_processed', secondary_contact: { name: 'Synthetic Contact' }, services: [{ name: 'Commercial Realty' }] };
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: line })]))).toBe('commercial');
      });

      // The text rule reads a KEY: one word of letters, digits and '_', with ':'. A lead payload also keeps contact
      // details (a call saves the email of a second contact), and an email with the prefix is no key.
      test.each([
        ['the email of a second contact', { secondary_contact: { name: 'Synthetic Contact', email: 'commercial_accounts@example.test', relationship: 'billing' } }],
        ['an email in a list, in capitals and with spaces around it', { emails: [' Commercial_Billing@Example.Test '] }],
        ['a web address', { website: 'commercial_pest.example.test/quote' }],
        ['a sentence', { memo: 'commercial_pest was asked about, for a friend' }],
        ['a file name', { attachment: 'commercial_invoice.pdf' }],
        ['a path', { page: 'commercial_pest/quote' }],
      ])('%s that starts with the prefix is no key: not commercial', async (_what, more) => {
        expect(await blocker(withLeads([LEAD({ extracted_data: { stage: 'call_processed', ...more } }), LEAD()]))).toBeNull();
      });

      test.each([['commercial_pest'], [' Commercial_Pest '], ['commercial_risk_type_review'], ['commercial_subtype:office'], ['commercial_tier_2'], ['commercial_']])('the key %j under a name no rule knows is a mark', async (key) => {
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { stage: 'call_processed', secondary_contact: { email: 'accounts@example.test' }, picked: [{ code: key }] } })]))).toBe('commercial');
      });

      // The quote page saves the tags of a link as the browser sent them (attribution.utm, whole), so a link can
      // put any name there. The payload is cut once, before any rule reads it: the save's scan and the manager
      // lookup get no more of a link than the proof's own scan does. Each mark below is one the save's scan
      // (isCommercialEstimateData) reads at any depth.
      const LINK_MARKS = Object.entries({ category: 'commercial', isCommercial: true, commercialEstimatedPricing: true, commercialSubtype: 'office', propertyType: 'commercial', service: 'commercial_pest' });
      const UNREAD = [['attribution'], ['utm'], ['clickIds'], ['source_evidence'], ['referrer'], ['landing_url'], ['businessIdentity']];
      test.each(UNREAD)("no mark of the save's scan under the name %s of a lead payload is read, at the root, far down or in a list", async (name) => {
        const kept = (payload) => LEAD({ extracted_data: { stage: 'quote_calculated', service_interest: 'Pest Control', ...payload } });
        const deep = (mark) => Array.from({ length: 20 }).reduce((inner) => ({ next: [inner] }), mark);
        const answers = [];
        for (const [mark, value] of LINK_MARKS) {
          const under = { [name]: { [mark]: value, deeper: [{ [mark]: value }] } };
          answers.push([mark, await blocker(withLeads([kept(under), kept({ enriched: [deep(under)] }), LEAD({ extracted_data: [under] }), LEAD()]))]);
          // The same mark under another name counts.
          answers.push([`${mark} under another name`, await blocker(withLeads([LEAD(), kept({ enriched: { [mark]: value } })]))]);
        }
        expect(answers).toEqual(LINK_MARKS.flatMap(([mark]) => [[mark, null], [`${mark} under another name`, 'commercial']]));
      });

      test('a manager named in the tags of a link is no manager of the lead', async () => {
        const condo = (more) => LEAD({ extracted_data: { isCommercial: false, propertyType: 'Condo', ...more } });
        const inLink = { utm: { customerRelationship: 'property_manager' }, attribution: { caller: { relationship_to_property: 'property_manager' } }, businessIdentity: { customerRelationship: 'property_manager' } };
        expect(await blocker(withLeads([condo(inLink), LEAD()]))).toBeNull();
        expect(await blocker(withLeads([LEAD(), condo({ caller: { relationship_to_property: 'property_manager' } })]))).toBe('commercial');
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

      // A lead keeps each extra property the intake named, with its occupancy. And a type in the payload is asked
      // with a manager, as in an estimate.
      const EXTRA_PROPERTY = (change) => ({ additional_properties: [{ address_line1: '12 Example Test Way', city: 'Parrish', is_rental: false, property_type: 'single_family', occupancy: 'owner_occupied', ...change }] });
      test('a lead that keeps an extra property with the commercial occupancy: commercial', async () => {
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: EXTRA_PROPERTY({ occupancy: 'commercial' }) }), LEAD()]))).toBe('commercial');
      });

      test.each([['owner_occupied'], ['rental_investment'], ['seasonal'], ['vacant'], ['unknown'], [null]])('a lead that keeps an extra property with the occupancy %j is not commercial', async (occupancy) => {
        expect(await blocker(withLeads([LEAD({ extracted_data: EXTRA_PROPERTY({ occupancy }) }), LEAD()]))).toBeNull();
      });

      // An extra property on a lead is the copy of what a call (or a form) said about the customer's other
      // property. It is asked by the CALL's rule for a property, and by no mark of a payload: the pricing engine
      // reads a building of units as commercial for a quote, and the call's rule does so for a manager only.
      const RENTAL = (property_type, more = {}) => EXTRA_PROPERTY({ is_rental: true, occupancy: 'rental_investment', is_primary_residence: false, property_type, ...more });
      test.each([
        ['multi_family', null, 'commercial'], ['apartment', null, 'commercial'], ['Apartment complex', null, 'commercial'], ['condo', null, 'commercial'],
        ['commercial', 'commercial', 'commercial'], ['office', 'commercial', 'commercial'], ['hoa_common_area', 'commercial', 'commercial'],
        ['single_family', null, null], ['townhome', null, null], ['house', null, null], [null, null, null],
      ])('a lead that keeps an extra property of the type %j: alone %j, with a manager %j', async (property_type, alone, withManager) => {
        const lead = LEAD({ extracted_data: RENTAL(property_type) });
        expect(await blocker(withLeads([LEAD(), lead]))).toBe(alone);
        // The manager of the record: the account's role, or one the lead's own payload names.
        expect(await blocker(withLeads([LEAD(), lead], { customer: { contact_role: 'property_manager' } }))).toBe(withManager);
        const namesItsManager = LEAD({ extracted_data: { ...RENTAL(property_type), caller: { relationship_to_property: 'property_manager' } } });
        expect(await blocker(withLeads([namesItsManager, LEAD()]))).toBe(withManager);
      });

      test('the same building of units as a property of the payload itself is read by the rules for a payload: commercial', async () => {
        const entry = RENTAL('multi_family').additional_properties[0];
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { properties: [entry] } })]))).toBe('commercial');
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { property: entry } })]))).toBe('commercial');
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { additional_properties: [entry] } })]))).toBeNull();
      });

      test("no mark of the proof's own scan is read on an extra property: only the call's rule for a property", async () => {
        // Each of these is a mark of the proof's scan anywhere else in a payload. The call's rule reads none of
        // them on a property.
        for (const more of [{ propertyUse: 'MIXED' }, { commercialUseType: 'OFFICE_RETAIL' }, { propertyType: 'Multi-Family' }, { occupancyType: 'hotel' }, { categoryConflict: 'property_manager:condo' }, { notes: 'commercial_pest' }]) {
          expect(await blocker(withLeads([LEAD({ extracted_data: RENTAL('single_family', more) }), LEAD()]))).toBeNull();
          // Nor on the record of a manager: a manager's single home stays a home by the call's rule.
          expect(await blocker(withLeads([LEAD({ extracted_data: RENTAL('single_family', more) }), LEAD()], { customer: { contact_role: 'property_manager' } }))).toBeNull();
          expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { property: RENTAL('single_family', more).additional_properties[0] } })]))).toBe('commercial');
        }
        // The app's own classifier of a payload still gets the whole payload, as at a save, and its marks count
        // wherever it reads them (the intakes keep no such field on an entry).
        for (const more of [{ isCommercial: true }, { category: 'COMMERCIAL' }]) {
          expect(require('../services/estimate-delivery-options').isCommercialEstimateData(RENTAL('single_family', more))).toBe(true);
          expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: RENTAL('single_family', more) })]))).toBe('commercial');
        }
        // And each field the call's rule does read is a mark there, at any depth of the entry.
        for (const more of [{ occupancy: 'commercial' }, { service_address_occupancy: 'commercial' }, { hoa_common_area_service: true }, { commercial_subtype: 'office' }, { unit: { occupancy: 'commercial' } }]) {
          expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: RENTAL('single_family', more) })]))).toBe('commercial');
        }
      });

      test('an extra property that is no list of entries carries no mark, and one entry alone is read', async () => {
        for (const value of [null, 2, 'commercial_pest', [], [null, 'multi_family', 7]]) {
          expect(await blocker(withLeads([LEAD({ extracted_data: { additional_properties: value } }), LEAD()]))).toBeNull();
        }
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: { additional_properties: { property_type: 'commercial' } } })]))).toBe('commercial');
      });

      // The lead's merge keeps every field of a property entry, so a field of a call's property can sit there.
      test("a lead that keeps the commercial occupancy of a call's main address on a property: commercial, and a home occupancy is none", async () => {
        const occupancies = require('../schemas/call-extraction.persisted.schema.json').properties.property.properties.service_address_occupancy.enum;
        expect(occupancies).toContain('commercial');
        const answers = [];
        for (const service_address_occupancy of occupancies) {
          answers.push([service_address_occupancy, await blocker(withLeads([LEAD(), LEAD({ extracted_data: EXTRA_PROPERTY({ service_address_occupancy }) })]))]);
        }
        expect(answers).toEqual(occupancies.map((occupancy) => [occupancy, occupancy === 'commercial' ? 'commercial' : null]));
        // At the root of the payload too, where a lead keeps the main address.
        expect(await blocker(withLeads([LEAD({ extracted_data: { address_line1: '12 Example Test Way', property_type: 'single_family', service_address_occupancy: 'commercial' } })]))).toBe('commercial');
      });

      test('a lead that keeps a service of the common areas of an association on a property: commercial', async () => {
        expect(await blocker(withLeads([LEAD(), LEAD({ extracted_data: EXTRA_PROPERTY({ property_type: 'condo', hoa_common_area_service: true }) }), LEAD()]))).toBe('commercial');
      });

      test.each([[false], [null], [undefined]])('a lead that keeps the common-area flag as %j on a home in an association is not commercial', async (hoa_common_area_service) => {
        expect(await blocker(withLeads([LEAD({ extracted_data: EXTRA_PROPERTY({ hoa_common_area_service, hoa_community_flag: true }) }), LEAD()]))).toBeNull();
      });

      test('a lead about a condo: commercial on the account of a property manager or with a manager named in it, and a home with neither', async () => {
        const condo = LEAD({ extracted_data: { isCommercial: false, propertyType: 'Condo' } });
        const named = LEAD({ extracted_data: { ...EXTRA_PROPERTY({ property_type: 'condo' }), caller: { relationship_to_property: 'property_manager' } } });
        expect(await blocker(withLeads([LEAD(), condo], { customer: { contact_role: 'property_manager' } }))).toBe('commercial');
        expect(await blocker(withLeads([LEAD(), named]))).toBe('commercial');
        expect(await blocker(withLeads([LEAD(), condo, LEAD({ extracted_data: EXTRA_PROPERTY({ property_type: 'condo' }) })]))).toBeNull();
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
        v2_extraction_status: 'valid',
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
        ['the HOA flag in a list of another name of the routing decision', CALL({ ai_validation: { routing: { flags: [], demoted: ['hoa_common_area_requires_approval'] } } })],
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
        // A service the caller asked for that names a business premises, with no such word, in each format.
        ['a request that names a business premises in the first format', CALL({ ai_extraction: JSON.stringify({ requested_service: 'Ant treatment for a school' }) })],
        ['a service name that names a business premises in the extraction', CALL(extraction({ service_request: { primary_service_category: 'pest_general', specific_service_name: 'Pest control for our restaurant' } }))],
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
        // The engine's rule for a saved type reads any multi-family building as a business. A call is read by the
        // call system's rule, which knows the caller: with no owner and no manager named, the caller is a resident.
        ['a caller in a multi-family building, with no relationship named', CALL(extraction({ property: { property_type: 'multi_family' }, caller: { relationship_to_property: null } }))],
        ['a request that names a home, in both formats', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Pest control for the home office' }),
          ...extraction({ service_request: { primary_service_category: 'pest_general', specific_service_name: 'Lawn care for my house' } }),
        })],
        // The wording of a business premises in the words of the call is not read either.
        ['the wording of a business premises in the summary and the pain points', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Pest control', call_summary: 'Wants pest control for our restaurant next month.', pain_points: 'Roaches at our office.' }),
          ...extraction({ call_summary: 'Asked about pest control for a hotel where she works.' }),
        })],
        // The words of a call are not read: the caller can name a workplace and want service at home.
        ['the word in the summaries of the call', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Pest control at home', call_summary: 'Works at a commercial bakery. Wants service at home.' }),
          ...extraction({ call_summary: 'Mentioned the commercial bakery where he works.', triage_flags: ['commercial requires quote?'] }),
        })],
      ])('%s is not commercial', async (_label, call) => {
        expect(await blocker(withCalls([call, CALL()]))).toBeNull();
      });

      // The app's rule reads the caller for the main property of a call alone. A manager's other property is a
      // client's too, so every property of the call is asked with the manager of the call: its caller, or the
      // account's role.
      const MANAGER_CALLER = { caller: { relationship_to_property: 'property_manager' } };
      const SECOND = (property_type) => ({ property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: 'rental_investment', property_type }] });
      test.each([
        ['the main property is a condo', CALL(extraction({ ...MANAGER_CALLER, property: { property_type: 'condo' } }))],
        ['a second property is a condo', CALL(extraction({ ...MANAGER_CALLER, property: SECOND('condo') }))],
        ['a second property is a multi-family building', CALL(extraction({ ...MANAGER_CALLER, property: SECOND('multi_family') }))],
        ['a second property is a condo in the first format', CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', is_rental: true, occupancy: 'rental_investment', property_type: 'condo' }] }),
          ...extraction(MANAGER_CALLER),
        })],
      ])('the call of a property manager where %s: commercial', async (_label, call) => {
        expect(await blocker(withCalls([CALL(), call, CALL()]))).toBe('commercial');
      });

      // The call processor copies a call's other properties to its lead: mapAdditionalPropertiesToLegacy makes the
      // entries, mergeLeadExtractedData joins them to the lead's payload. The copy adds no evidence, so the account
      // reads the same before the lead keeps it and after.
      test.each([
        ['a tenant', 'tenant', 'multi_family', null], ['a tenant', 'tenant', 'apartment', null], ['an owner', 'owner', 'condo', null], ['a caller with no stated role', null, 'multi_family', null],
        ['a property manager', 'property_manager', 'multi_family', 'commercial'], ['a property manager', 'property_manager', 'condo', 'commercial'],
        ['a tenant', 'tenant', 'commercial', 'commercial'],
      ])('the call of %s (%j) about a second property of the type %j reads %j, before and after its lead keeps the copy', async (_who, relationship_to_property, property_type, expected) => {
        const { mapAdditionalPropertiesToLegacy } = require('../utils/extraction-compat');
        const { mergeLeadExtractedData } = require('../utils/lead-extracted-data-merge');
        const property = SECOND(property_type);
        const call = CALL(extraction({ caller: { relationship_to_property }, property }));
        const copied = mergeLeadExtractedData({ pain_points: 'Ants in the kitchen.' }, { additional_properties: mapAdditionalPropertiesToLegacy(property.additional_properties) });
        expect(copied.additional_properties).toEqual([expect.objectContaining({ address_line1: '12 Example Test Way', occupancy: 'rental_investment', property_type })]);
        const lead = { is_commercial: false, is_residential: true, service_interest: 'Pest Control', extracted_data: copied };
        expect(await blocker(withCalls([CALL(), call]))).toBe(expected);
        expect(await blocker(world({ tables: { call_log: [CALL(), call], leads: [lead] } }))).toBe(expected);
        // The lead alone says what the entry says, with no caller: a home, unless the entry is a business by itself.
        expect(await blocker(world({ tables: { leads: [lead] } }))).toBe(property_type === 'commercial' ? 'commercial' : null);
      });

      test.each([['owner'], ['tenant'], ['hoa_board_member'], ['real_estate_agent'], ['unknown'], [null]])('a second property that is a condo, on the call of a caller with the relationship %j, is a home', async (relationship_to_property) => {
        const call = CALL({
          ai_extraction: JSON.stringify({ requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', occupancy: 'rental_investment', property_type: 'condo' }] }),
          ...extraction({ caller: { relationship_to_property }, property: SECOND('condo') }),
        });
        expect(await blocker(withCalls([call, CALL()]))).toBeNull();
      });

      // The same agreement as for the account's role, on every relationship the call system can save.
      test('every relationship of the call schema is a manager for the proof exactly where the estimator reads one', async () => {
        const { commercialCategoryConflict } = require('../services/estimator-engine/unit-scope-model');
        const relationships = require('../schemas/call-extraction.persisted.schema.json').properties.caller.properties.relationship_to_property.enum;
        expect(relationships).toContain('property_manager');
        const answers = [];
        const expected = [];
        for (const relationship_to_property of relationships) {
          const caller = { relationship_to_property };
          expected.push([relationship_to_property, commercialCategoryConflict({ extraction: { caller, property: { property_type: 'condo' } }, intent: null }) ? 'commercial' : null]);
          answers.push([relationship_to_property, await blocker(withCalls([CALL(extraction({ caller, property: SECOND('condo') }))]))]);
        }
        expect(answers).toEqual(expected);
        expect(expected.map(([, answer]) => answer)).toContain('commercial');
      });

      // The class behind a lead's property entry: the lead's merge keeps every field of an entry, and an entry has
      // the shape of a call's property. One field of a call's property, alone beside a home type and with no
      // relationship stated: where the proof reads the CALL as commercial, it reads a lead that keeps the field on
      // a property entry as commercial too.
      test("every field of a call's property that makes a call commercial makes a lead that keeps it commercial", async () => {
        const fields = require('../schemas/call-extraction.persisted.schema.json').properties.property.properties;
        const caller = { relationship_to_property: 'unknown' };
        const leadWith = (entry) => world({ tables: { leads: [{ is_commercial: false, is_residential: true, extracted_data: { additional_properties: [{ address_line1: '12 Example Test Way', property_type: 'single_family', occupancy: 'owner_occupied', ...entry }] } }] } });
        const marks = [];
        const answers = [];
        for (const [name, field] of Object.entries(fields)) {
          const values = field.enum ? field.enum.filter((value) => value !== null) : [];
          if ([].concat(field.type).includes('boolean')) values.push(true);
          for (const value of values) {
            const property = { property_type: 'single_family', [name]: value };
            if (await blocker(withCalls([CALL(extraction({ caller, property }))])) !== 'commercial') continue;
            marks.push(`${name}=${value}`);
            answers.push([`${name}=${value}`, await blocker(leadWith({ [name]: value }))]);
          }
        }
        expect(marks).toEqual(expect.arrayContaining([
          'property_type=commercial', 'property_type=hoa_common_area', 'hoa_common_area_service=true', 'commercial_subtype=office', 'service_address_occupancy=commercial',
        ]));
        expect(answers).toEqual(marks.map((mark) => [mark, 'commercial']));
        expect(await blocker(leadWith({}))).toBeNull();
      });

      test('the call of a property manager about single homes only: homes', async () => {
        expect(await blocker(withCalls([CALL(extraction({ ...MANAGER_CALLER, property: SECOND('townhouse') })), CALL()]))).toBeNull();
      });

      // The manager of one call is the client of that call. The account's role covers every call.
      test('a condo in a call with no caller named: commercial on the account of a property manager, and a home on another account', async () => {
        const condo = CALL(extraction({ caller: { relationship_to_property: 'unknown' }, property: { property_type: 'condo' } }));
        const managedHome = CALL(extraction({ ...MANAGER_CALLER, property: { property_type: 'single_family' } }));
        expect(await blocker(withCalls([CALL(), condo], { customer: { contact_role: 'property_manager' } }))).toBe('commercial');
        expect(await blocker(withCalls([managedHome, condo]))).toBeNull();
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

      // The call processor keeps the output of a model that FAILED the extraction schema, for the audit of the
      // failure. The app's readers take an extraction at the status 'valid' alone, and so does the proof: every
      // mark of the extraction rule, in one extraction that is not valid, is no mark.
      const REJECTED = extraction({
        property: {
          property_type: 'commercial', commercial_subtype: 'office', service_address_occupancy: 'commercial', hoa_common_area_service: true,
          additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: 'commercial', property_type: 'commercial' }],
        },
        caller: { relationship_to_property: 'property_manager' },
        service_request: { primary_service_category: 'pest_general', specific_service_name: 'Commercial Pest Control' },
        commercial_signals: { business_name: 'Synthetic Bakery' },
        triage_flags: ['commercial_requires_quote', 'hoa_common_area_requires_approval'],
      });
      test.each([['schema_failed'], ['parse_failed'], ['Valid'], ['valid '], [''], [null], [undefined]])('an extraction at the status %j is not read: not commercial', async (v2_extraction_status) => {
        expect(await blocker(withCalls([CALL({ ...REJECTED, v2_extraction_status }), CALL()]))).toBeNull();
        // The same extraction at the status 'valid' is a mark.
        expect(await blocker(withCalls([CALL(), CALL({ ...REJECTED, v2_extraction_status: 'valid' })]))).toBe('commercial');
      });

      // The manager an extraction names counts for the other records of the call only where the extraction is
      // read: a condo in the first format, beside a rejected extraction that names a manager, stays a home.
      test('the manager a rejected extraction names is no manager of the call', async () => {
        const condoInFirstFormat = JSON.stringify({ requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', occupancy: 'rental_investment', property_type: 'condo' }] });
        const managed = (v2_extraction_status) => CALL({ ai_extraction: condoInFirstFormat, ...extraction({ caller: { relationship_to_property: 'property_manager' } }), v2_extraction_status });
        expect(await blocker(withCalls([managed('schema_failed'), CALL()]))).toBeNull();
        expect(await blocker(withCalls([CALL(), managed('valid')]))).toBe('commercial');
      });

      // The call's other three records do not hang on the status of the extraction.
      test.each([
        ['the first format', { ai_extraction: JSON.stringify({ requested_service: 'Commercial pest control' }) }],
        ["the triage's decision", { ai_validation: { extraction_status: 'schema_failed', routing: { flags: ['commercial_requires_quote'] } } }],
        ['the address check', { ai_address_validation: { status: 'validated_accept', addressUse: { business: true, residential: false } } }],
      ])('a mark in %s of a call whose extraction failed its schema: commercial', async (_what, change) => {
        const failed = { ai_extraction_enriched: HOME_EXTRACTION, v2_extraction_status: 'schema_failed' };
        expect(await blocker(withCalls([CALL(), CALL({ ...failed, ...change })]))).toBe('commercial');
        expect(await blocker(withCalls([CALL(failed), CALL()]))).toBeNull();
      });

      // A flag is read in a list of flags only. The validation also keeps the schema errors of an extraction, and
      // the error for a flag the schema does not know lists every flag it allows, the two commercial ones among
      // them. The errors below are the app's own validator's, for a model output with one unknown flag.
      test('the flags a schema error lists as allowed are no flag of the call', async () => {
        const { errors } = require('../schemas/validate-extraction').validateModelOutput({ triage_flags: ['made_up_flag'] });
        const allowed = errors.filter((error) => error.keyword === 'enum').flatMap((error) => error.params.allowedValues);
        expect(allowed).toEqual(expect.arrayContaining(['commercial_requires_quote', 'hoa_common_area_requires_approval']));
        // As the processor saves a call whose extraction failed its schema: no routing decision, and the errors.
        const failed = CALL({ v2_extraction_status: 'schema_failed', ai_address_validation: null, ai_validation: { extraction_status: 'schema_failed', routing: null, errors } });
        expect(await blocker(withCalls([failed, CALL()]))).toBeNull();
        // The same errors beside a routing decision that raised nothing, and beside one that raised the flag.
        const beside = (flags) => CALL({ ai_validation: { extraction_status: 'valid', routing: { allowed: true, reason: null, flags, appointment_blocking_flags: [] }, errors } });
        expect(await blocker(withCalls([beside(['quote_promised']), CALL()]))).toBeNull();
        expect(await blocker(withCalls([CALL(), beside(['commercial_requires_quote'])]))).toBe('commercial');
      });

      test.each([
        ['at the root of the validation', { ai_validation: { routing: { flags: [] }, note: 'commercial_requires_quote', gates: { demoted: ['hoa_common_area_requires_approval'] } } }],
        ["in the validation's verdict on the address on file", { ai_validation: { routing: { flags: [] }, on_file_address_validation: { status: 'validated_accept', flags: ['commercial_requires_quote'] } } }],
        ['in a validation that is a list', { ai_validation: ['commercial_requires_quote', { flags: ['hoa_common_area_requires_approval'] }] }],
        ["outside the extraction's own list of flags", extraction({ meta: { dropped_flags: ['commercial_requires_quote'] }, evidence: [{ field_path: '/triage_flags/0', quote: 'hoa_common_area_requires_approval' }] })],
      ])('a flag word %s is no flag of the call: not commercial', async (_where, change) => {
        expect(await blocker(withCalls([CALL(change), CALL()]))).toBeNull();
      });

      // The address check keeps what Google lists at the address at EVERY status, also at the candidate an
      // ambiguous or incomplete match found. Only a check that confirmed the address is read: the two statuses
      // the app's own readers take as a confirmed address. Each status of the validator is sorted here, so a
      // status it adds later fails until someone sorts it.
      test('a business use counts at the two statuses of a confirmed address, and at no other status of the validator', async () => {
        const { STATUSES } = require('../services/address-validation');
        const business = (status) => CALL({ ai_address_validation: { status, granularity: 'SUB_PREMISE', inServiceArea: true, hasUnconfirmed: false, addressUse: { business: true, residential: false, poBox: false } } });
        const answers = [];
        for (const status of Object.values(STATUSES)) answers.push([status, await blocker(withCalls([CALL(), business(status)]))]);
        expect(answers).toEqual([
          ['not_attempted', null], ['validated_accept', 'commercial'], ['corrected', 'commercial'], ['confirm_needed', null],
          ['missing_component', null], ['out_of_service_area', null], ['ambiguous', null], ['api_unavailable', null],
        ]);
      });

      test.each([[undefined], [null], [''], ['VALIDATED_ACCEPT'], ['validated_accept '], [true]])('a business use beside the status %j is not read: not commercial', async (status) => {
        const check = { status, granularity: 'PREMISE', addressUse: { business: true, residential: false } };
        expect(await blocker(withCalls([CALL({ ai_address_validation: check }), CALL()]))).toBeNull();
      });

      // A check the app waived the missing unit of keeps its own status in the saved row, with the waiver beside it.
      test('a business use on an ambiguous check with a waived unit is not read by the address rule', async () => {
        const waived = { status: 'ambiguous', granularity: 'PREMISE', missingComponents: ['subpremise'], wholeStructureUnitWaived: { originalStatus: 'ambiguous', reason: 'whole_structure' }, addressUse: { business: true, residential: false } };
        expect(await blocker(withCalls([CALL({ ai_address_validation: waived }), CALL()]))).toBeNull();
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

// A pricer resolves the property after the proof cleared the account. A lookup or an estimate seed can name a
// type that no saved record carries, so the type is asked here, by the rule for a type saved on the account.
describe('resolvedPropertyTypeBlocker', () => {
  const resolved = (customer, propertyType) => resolvedPropertyTypeBlocker(world({ customer }), 'cust-1', propertyType);
  const MANAGER = { contact_role: 'property_manager', property_type: null };
  const OWNER = { contact_role: 'owner', property_type: null };

  test('needs a database handle and a customer id', async () => {
    await expect(resolvedPropertyTypeBlocker(null, 'cust-1', 'condo')).rejects.toThrow('resolvedPropertyTypeBlocker needs');
    await expect(resolvedPropertyTypeBlocker(world(), null, 'condo')).rejects.toThrow('resolvedPropertyTypeBlocker needs');
  });

  test('an account that is gone is not live, and a failed read throws', async () => {
    expect(await resolvedPropertyTypeBlocker(world({ customer: null }), 'cust-1', 'condo')).toBe('not_live');
    const down = world({ tables: { customers: () => { throw new Error('customers read down'); } } });
    await expect(resolvedPropertyTypeBlocker(down, 'cust-1', 'condo')).rejects.toThrow('customers read down');
  });

  // The engine's rule reads each of these condo types as a home. The proof, with the account's manager role, does not.
  test.each(['condo', 'condo_ground', 'condo_upper'])("a property manager's %s is a business; the owner's is a home", async (propertyType) => {
    const { isCommercialProperty } = require('../services/pricing-engine/commercial-helpers');
    expect(isCommercialProperty({ propertyType })).toBe(false);
    expect(await resolved(MANAGER, propertyType)).toBe('commercial');
    expect(await resolved(OWNER, propertyType)).toBeNull();
  });

  test.each(['apartment', 'multi_family', 'commercial', 'office', 'warehouse', 'hoa'])('a %s is a business for any client', async (propertyType) => {
    expect(await resolved(OWNER, propertyType)).toBe('commercial');
    expect(await resolved(MANAGER, propertyType)).toBe('commercial');
  });

  test.each(['single_family', 'townhome_end', 'townhome_interior', 'duplex', '', null, undefined])('a %j is a home, also for a property manager', async (propertyType) => {
    expect(await resolved(MANAGER, propertyType)).toBeNull();
    expect(await resolved(OWNER, propertyType)).toBeNull();
  });

  // One rule for a type, saved or resolved: the proof answers the same for the type on the account's own row.
  test.each([
    ['condo', 'property_manager'], ['condo', 'owner'], ['condo_ground', 'property_manager'], ['apartment', 'owner'],
    ['single_family', 'property_manager'], ['townhome_end', 'tenant'],
  ])('a %s with the role %s reads the same resolved as saved on the account', async (propertyType, contact_role) => {
    const saved = await blocker(world({ customer: { contact_role, property_type: propertyType } }));
    expect(await resolved({ contact_role, property_type: null }, propertyType)).toBe(saved);
  });

  test('reads the account by its id', async () => {
    const reads = [];
    const db = world({ tables: { customers: (calls) => { reads.push(calls); return [CUSTOMER(MANAGER)]; } } });
    expect(await resolvedPropertyTypeBlocker(db, 'cust-1', 'condo')).toBe('commercial');
    expect(reads).toHaveLength(1);
    expect(whereHas(reads[0], (filter) => filter.id === 'cust-1')).toBe(true);
  });

  // The client is a manager also by a saved property of the account: one it manages for a client. The proof reads
  // a saved condo that way (hasCommercialProperty), so a condo the lookup names is read that way too.
  describe('an account with a saved property it manages for a client', () => {
    // Answers the managed row only to a read that asks for this account's managed properties.
    const managedOnly = (calls) => (whereHas(calls, (filter) => filter.customer_id === 'cust-1' && filter.relationship === 'managed_for_client')
      ? [PROPERTY({ property_type: null, relationship: 'managed_for_client' })]
      : []);
    const withManaged = (propertyType) => resolvedPropertyTypeBlocker(world({ customer: OWNER, tables: { customer_properties: managedOnly } }), 'cust-1', propertyType);

    test.each(['condo', 'condo_ground', 'condo_upper'])('a %s the lookup names is a business, though the contact role is not a manager', async (propertyType) => {
      expect(await withManaged(propertyType)).toBe('commercial');
    });

    test('a house stays a home', async () => {
      expect(await withManaged('single_family')).toBeNull();
    });

    test('a saved property with another relationship makes no manager', async () => {
      const owned = (calls) => (whereHas(calls, (filter) => filter.relationship === 'managed_for_client') ? [] : [PROPERTY({ relationship: 'owner' })]);
      expect(await resolvedPropertyTypeBlocker(world({ customer: OWNER, tables: { customer_properties: owned } }), 'cust-1', 'condo')).toBeNull();
    });

    test('a failed read of the saved properties throws', async () => {
      const down = world({ customer: OWNER, tables: { customer_properties: () => { throw new Error('properties read down'); } } });
      await expect(resolvedPropertyTypeBlocker(down, 'cust-1', 'condo')).rejects.toThrow('properties read down');
    });
  });
});
