// planStartBlocker against real PostgreSQL (one rolled-back transaction per test). The unit suite
// (plan-start-eligibility.test.js) pins the decisions on a fake that applies no filter. This one proves what only
// a database can: the SQL of each read on the real tables (the saved properties, the estimates, the leads, the
// services of the visits and of the service reports with their catalog join, the contracts, the calendar read, the legacy plan
// visit, the visit with no status, the ongoing series root, the billed plan rate, the plan hold, the two annual
// prepay reads), that a JSONB estimate payload comes back in a form the estimate rules read, and that the
// account and property values the rules name are values the schema accepts, and that each read has an index
// (two of them from this proof's own migration). No network, no spend. All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// Every read must run on the handle the caller gives (here: the test's transaction). A caller inside a
// transaction sees its own writes, and no read leaves on another connection. So the app's own connection
// refuses every use in this suite.
jest.mock('../models/db', () => {
  const refuse = () => { throw new Error('a read used the app connection, not the handle the caller gave'); };
  return new Proxy(refuse, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' || key === '__esModule' ? undefined : refuse) });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const NOW = new Date();
const PLAN_SERVICE = 'Quarterly Pest Control Service';
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// The ET calendar day n days from today: the proof's own "today".
const day = (n) => etDateString(addETDays(NOW, n));

postgres('planStartBlocker (live Postgres)', () => {
  jest.setTimeout(90000);
  let database;
  let trx;
  let planStartBlocker;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's: the managed runner sets both marks and names
    // the database after the worktree id (scripts/dev/context.js, scripts/qa/server.js). Or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its settings, so ?host=, ?port= or
    // ?connectionString= would name another server than the one checked above. A URL with a query is refused,
    // and the pool gets the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
    ({ planStartBlocker } = require('../services/plan-start-eligibility'));
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    trx = await database.transaction();
  });

  afterEach(async () => {
    await trx.rollback();
  });

  // ---- Fixtures: the least each table needs. ----

  // A one-time customer: live, residential, no tier, no plan rate.
  async function seedCustomer(change = {}) {
    const tag = hex(4);
    const [row] = await trx('customers').insert({
      first_name: 'Jordan', last_name: 'Example', email: `jordan.${tag}@example.test`,
      phone: `+1941${String(parseInt(tag, 16) % 10000000).padStart(7, '0')}`,
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
      active: true, pipeline_stage: 'won', ...change,
    }).returning('*');
    return row;
  }

  // A saved property of the account: by default the primary one, a home the owner lives in. The customers row
  // carries only a mirror of the primary property's type, and seedCustomer leaves that mirror empty.
  async function seedProperty(customer, change = {}) {
    const tag = hex(4);
    const [row] = await trx('customer_properties').insert({
      customer_id: customer.id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true, property_type: 'single_family',
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ct`, city: 'Parrish', state: 'FL', zip: '34219',
      address_key: `synthetic-${tag}`, source: 'manual', active: true, ...change,
    }).returning('*');
    return row;
  }

  // An estimate of the account: by default a home estimate that was sent, under the column's default category.
  // `customer` null: an estimate with no customer on it.
  const HOME_ESTIMATE = { inputs: { isCommercial: 'NO', propertyType: 'Single Family' }, result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } } };
  async function seedEstimate(customer, { estimate_data = HOME_ESTIMATE, ...change } = {}) {
    const [row] = await trx('estimates').insert({
      customer_id: customer ? customer.id : null, token: `test-${hex(16)}`, status: 'sent',
      estimate_data: estimate_data === null ? null : JSON.stringify(estimate_data), ...change,
    }).returning('*');
    return row;
  }

  // A mark 20 levels down in a payload: below the 12 levels the payload scan of the save reads.
  const farDown = (mark) => Array.from({ length: 20 }).reduce((inner) => ({ next: [inner] }), mark);

  // A lead: by default with the flags the columns default to (a home lead). `customer` null: no customer on it.
  async function seedLead(customer, change = {}) {
    const [row] = await trx('leads').insert({ customer_id: customer ? customer.id : null, ...change }).returning('*');
    return row;
  }

  // A one-time visit that is done: no plan record.
  async function seedVisit(customer, change = {}) {
    const [row] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-20), service_type: 'One-Time Pest Control', status: 'completed', ...change,
    }).returning('*');
    return row;
  }

  // A service report of a done one-time job (service_records). It keeps its own service text.
  async function seedServiceReport(customer, change = {}) {
    const [row] = await trx('service_records').insert({
      customer_id: customer.id, service_date: day(-20), service_type: 'One-Time Pest Control', ...change,
    }).returning('*');
    return row;
  }

  // A contract of the account (customer_contracts): by default a home agreement made from a document template.
  async function seedContract(customer, change = {}) {
    const [row] = await trx('customer_contracts').insert({
      customer_id: customer.id, contract_type: 'document_template', title: 'Synthetic agreement',
      document_template_key: 'service_agreement.termite_program', ...change,
    }).returning('*');
    return row;
  }

  // A call of the account (call_log): by default a call about a home, as the call system saves it. The first
  // format of the extraction is JSON text in a text column; the other verdicts and the address check are jsonb.
  // The extraction passed its schema (v2_extraction_status 'valid'), as the app's readers require.
  // `customer` null: a call no account was matched to.
  const HOME_CALL = {
    v2_extraction_status: 'valid',
    ai_extraction: { requested_service: 'Quarterly pest control', call_summary: 'Asked about ants in the kitchen.' },
    ai_extraction_enriched: {
      property: { property_type: 'single_family', commercial_subtype: null, service_address_occupancy: 'owner_occupied', hoa_common_area_service: false },
      caller: { relationship_to_property: 'owner' },
      service_request: { primary_service_category: 'pest_general', specific_service_name: 'Quarterly Pest Control' },
      commercial_signals: null,
      triage_flags: ['quote_promised'],
    },
    ai_validation: { routing: { flags: ['quote_promised'], appointment_blocking_flags: [] } },
    ai_address_validation: { status: 'validated_accept', granularity: 'PREMISE', addressUse: { business: false, residential: true, poBox: false } },
  };
  async function seedCall(customer, change = {}) {
    const call = { ...HOME_CALL, ...change };
    const json = (value) => (value === null ? null : JSON.stringify(value));
    const [row] = await trx('call_log').insert({
      customer_id: customer ? customer.id : null, ai_extraction: json(call.ai_extraction),
      ai_extraction_enriched: json(call.ai_extraction_enriched), ai_validation: json(call.ai_validation),
      ai_address_validation: json(call.ai_address_validation), v2_extraction_status: call.v2_extraction_status,
    }).returning('*');
    return row;
  }

  // A day-agreement decision of the account: by default one the judge let through. A skipped one needs a skip
  // reason (the table's own check).
  const SKIPPED = { verdict: 'skip', skip_reason: 'model_blocker' };
  async function seedDecision(customer, { judged = { act: true, blockers: [] }, ...change } = {}) {
    const [row] = await trx('day_agreement_decisions').insert({
      customer_id: customer ? customer.id : null, source_kind: 'call', source_key: `synthetic-${hex(8)}`, verdict: 'would_book',
      judged: judged === null ? null : JSON.stringify(judged), ...change,
    }).returning('*');
    return row;
  }

  // An add-on of a visit: a second service on it. By default a home service with no catalog link.
  async function seedAddon(visit, change = {}) {
    const [row] = await trx('scheduled_service_addons').insert({ scheduled_service_id: visit.id, service_name: 'Mosquito Add-On', ...change }).returning('*');
    return row;
  }

  // A row of the service catalog (synthetic key and name).
  async function seedCatalogService(change = {}) {
    const [row] = await trx('services').insert({ service_key: `synthetic_${hex(6)}`, name: 'Synthetic Home Service', ...change }).returning('*');
    return row;
  }

  // A legacy plan visit: a child of a recurring root, saved with NO recurring flag. The root's own visit is over
  // (completed), so the calendar read (is_recurring = true, not over) finds nothing for this customer.
  async function seedLegacyVisit(customer, change = {}) {
    const [root] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-80), service_type: PLAN_SERVICE, status: 'completed', is_recurring: true,
    }).returning('id');
    const [visit] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(10), service_type: PLAN_SERVICE, status: 'confirmed',
      is_recurring: null, recurring_parent_id: root.id, ...change,
    }).returning('*');
    return visit;
  }

  // A visit that carries the recurring flag: the shape the calendar read asks for.
  async function seedFlaggedVisit(customer, change = {}) {
    const [visit] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(10), service_type: PLAN_SERVICE, status: 'confirmed', is_recurring: true, ...change,
    }).returning('*');
    return visit;
  }

  // The root of a recurring series with NO other visit: its own visit is over, and no later visit is on the
  // calendar. recurring_ongoing says whether the plan goes on (the nightly top-up extends such a series).
  async function seedSeriesRoot(customer, change = {}) {
    const [root] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-80), service_type: PLAN_SERVICE, status: 'completed',
      is_recurring: true, recurring_ongoing: true, ...change,
    }).returning('*');
    return root;
  }

  // An annual prepay term, with its invoice when `invoiceStatus` is given.
  async function seedPrepayTerm(customer, { invoiceStatus = null, ...change } = {}) {
    let invoiceId = null;
    if (invoiceStatus) {
      invoiceId = crypto.randomUUID();
      await trx('invoices').insert({
        id: invoiceId, customer_id: customer.id, status: invoiceStatus, subtotal: 480, total: 480,
        line_items: '[]', invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: crypto.randomUUID(),
      });
    }
    await trx('annual_prepay_terms').insert({
      id: crypto.randomUUID(), customer_id: customer.id, status: 'active', term_start: day(-30), term_end: day(335),
      prepay_amount: 480, plan_label: 'Synthetic Annual', prepay_invoice_id: invoiceId, ...change,
    });
  }

  const blockerFor = async (seed) => {
    const customer = await seedCustomer();
    await seed(customer);
    return planStartBlocker(trx, customer.id);
  };

  test('a live residential customer with no plan record: nothing stands against a new plan', async () => {
    expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
  });

  describe('the account', () => {
    test.each([
      ['an inactive account', { active: false }],
      ['a deleted account', { deleted_at: new Date() }],
      ['an inactive member', { active: false, waveguard_tier: 'Gold' }],
    ])('%s: not_live', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBe('not_live');
    });

    test('an id that names no customer: not_live', async () => {
      expect(await planStartBlocker(trx, crypto.randomUUID())).toBe('not_live');
    });

    // The estimator's rule for a typed premises reads the client too: the manager of a condo is commercial, and
    // its owner is a home. The role is a value the account's column takes.
    test.each([['condo'], ['condo_ground']])('the account of a property manager with the type %s on its own row: commercial', async (property_type) => {
      const customer = await seedCustomer({ contact_role: 'property_manager', property_type });
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    test.each([['owner'], ['tenant'], [null]])('a contact with the role %s and a condo on its own row is not commercial', async (contact_role) => {
      const customer = await seedCustomer({ contact_role, property_type: 'condo' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    test('a property manager with a single home on its own row is not commercial', async () => {
      const customer = await seedCustomer({ contact_role: 'property_manager', property_type: 'single_family' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    // The tier column accepts 'Commercial' (its check constraint), and the membership predicate reads that tier
    // as "no plan": without the rule this account would read as a home with no plan.
    test.each([
      ['the Commercial tier and no property type', { waveguard_tier: 'Commercial' }],
      ['the Commercial tier and a residential property type', { waveguard_tier: 'Commercial', property_type: 'single_family' }],
      ['a business property type', { property_type: 'business' }],
      ['a commercial property type', { property_type: 'commercial' }],
      ['an office', { property_type: 'office' }],
      // The two values the building-use check constraint takes. Only a won commercial proposal writes one.
      ['the building use of a business building', { building_use: 'nonresidential' }],
      ['the building use of a residential community', { building_use: 'residential', property_type: 'single_family' }],
      // The key only the accept of a commercial pest estimate writes, with either of its two values (JSONB).
      ['a sold commercial scope with the interior excluded', { service_preferences: JSON.stringify({ exterior_sweep: true, interior_spray: false, commercial_interior_scope: 'excluded' }) }],
      ['a sold commercial scope with the interior included', { service_preferences: JSON.stringify({ exterior_sweep: true, interior_spray: true, commercial_interior_scope: 'included' }) }],
      // The service label the intake saved on the account itself (lead_service_interest), with no lead and no
      // estimate that carries it.
      ['a commercial service label on the account', { lead_service_interest: 'Commercial Pest Control' }],
      // A property type only the estimator's recognition of a typed premises knows, and a label with no such
      // word that names a business premises in the wording the lead intake reads.
      ['a hotel as the property type', { property_type: 'hotel' }],
      ['a service label on the account that names a business premises', { lead_service_interest: 'Pest control for a hotel' }],
    ])('%s: commercial', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBe('commercial');
    });

    test('the fixture: an account is saved with the default service preferences, as an object with no sold scope', async () => {
      const customer = await seedCustomer();
      expect(customer.service_preferences).toEqual({ exterior_sweep: true, interior_spray: true });
    });

    test.each([
      ['a home that declined the inside service', { exterior_sweep: true, interior_spray: false }],
      ['empty preferences', {}],
      ['a JSON null', null],
      ['a list', ['commercial_interior_scope']],
      // A JSON text is a valid jsonb value. The driver returns it as the text itself, not as JSON to parse.
      ['a JSON text', 'none'],
    ])('service preferences with no sold commercial scope (%s) are not commercial', async (_label, preferences) => {
      expect(await planStartBlocker(trx, (await seedCustomer({ service_preferences: JSON.stringify(preferences) })).id)).toBeNull();
    });

    test.each([['Pest Control'], ['Pest control for the home office']])('the home service label %j on the account is not commercial', async (lead_service_interest) => {
      expect(await planStartBlocker(trx, (await seedCustomer({ lead_service_interest })).id)).toBeNull();
    });

    test.each([
      ['a tier', { waveguard_tier: 'Gold' }],
      ['a legacy monthly rate and no tier', { monthly_rate: 45 }],
      // The membership predicate reads the One-Time tier as "no plan" and then ignores the rate.
      ['a monthly rate beside the One-Time tier', { waveguard_tier: 'One-Time', monthly_rate: 45 }],
      // A billing lane only a plan has. The column's check constraint takes these values.
      ['the per-application lane, with no tier and no rate,', { billing_mode: 'per_application' }],
      ['the annual prepay lane, with no tier and no rate,', { billing_mode: 'annual_prepay' }],
      ['the monthly dues lane, with no tier and no rate,', { billing_mode: 'monthly_membership' }],
    ])('%s on the account: has_plan', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBe('has_plan');
    });

    test.each([
      ['the One-Time tier', { waveguard_tier: 'One-Time' }],
      ['a monthly rate of zero', { monthly_rate: 0 }],
      ['the per-visit lane', { billing_mode: 'per_visit' }],
      ['the one-time lane', { billing_mode: 'one_time' }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await planStartBlocker(trx, (await seedCustomer(change)).id)).toBeNull();
    });
  });

  // The customers row mirrors only the TYPE of the primary property, and the mirror can be behind. A property's
  // occupancy is saved on the property alone. Every saved property of the account counts, also a removed one.
  describe('a saved property of the account', () => {
    const SECOND = { is_primary: false };

    test.each([
      ['the primary property has the commercial occupancy', [{ occupancy_type: 'commercial' }]],
      ['the commercial occupancy, with no property type', [{ occupancy_type: 'commercial', property_type: null }]],
      ['the primary property has a commercial type', [{ property_type: 'commercial' }]],
      ['the primary property has a business type', [{ property_type: 'business' }]],
      // A type only the estimator's recognition of a typed premises knows.
      ['the only property is a hotel', [{ property_type: 'hotel' }]],
      ['a second property is a church, beside a home', [{}, { ...SECOND, property_type: 'church' }]],
      ['a second property has the commercial occupancy, beside a home', [{}, { ...SECOND, occupancy_type: 'commercial' }]],
      ['a second property has a commercial type, beside a home', [{}, { ...SECOND, property_type: 'commercial' }]],
    ])('%s, on an account whose own row says nothing: commercial', async (_label, properties) => {
      const customer = await seedCustomer();
      for (const property of properties) await seedProperty(customer, property);
      expect(customer.property_type).toBeNull();
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    // Every occupancy the column's check constraint takes beside commercial.
    test.each([['owner_occupied'], ['family_occupied'], ['rental_investment'], ['seasonal'], ['vacant'], ['unknown']])(
      'a home with the occupancy %s is not commercial', async (occupancy_type) => {
        expect(await blockerFor((customer) => seedProperty(customer, { occupancy_type }))).toBeNull();
      });

    test.each([['mobile_home'], ['duplex'], ['vacant_lot']])('a saved property with the home type %s is not commercial', async (property_type) => {
      expect(await blockerFor((customer) => seedProperty(customer, { property_type }))).toBeNull();
    });

    test('two homes on one account are not commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedProperty(customer);
        await seedProperty(customer, { ...SECOND, occupancy_type: 'rental_investment', property_type: 'townhome' });
      })).toBeNull();
    });

    // A condo the customer manages for a client: by the property's own relationship (the proof reads the
    // column), or by the account's role. Each relationship is a value the column's check constraint takes.
    const MANAGED = { relationship: 'managed_for_client' };
    test.each([
      ['a condo managed for a client, on the account of a property manager, with a residential occupancy', { contact_role: 'property_manager' }, [{ ...MANAGED, property_type: 'condo' }]],
      ['a condo managed for a client, on an account with no role', {}, [{ ...MANAGED, property_type: 'condo', occupancy_type: 'rental_investment' }]],
      ['a condo with no relationship, on the account of a property manager', { contact_role: 'property_manager' }, [{ property_type: 'condo_upper' }]],
      ['a condo recorded as an own home, on the account of a property manager', { contact_role: 'property_manager' }, [{ property_type: 'condo', relationship: 'own_home' }]],
      ['a second property is a managed condo, beside a home', {}, [{}, { ...SECOND, ...MANAGED, property_type: 'condo' }]],
      ['a removed property was a managed condo, beside a home', {}, [{}, { ...SECOND, ...MANAGED, active: false, property_type: 'condo' }]],
    ])('%s: commercial', async (_label, account, properties) => {
      const customer = await seedCustomer(account);
      for (const property of properties) await seedProperty(customer, property);
      expect(customer.property_type).toBeNull();
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    test.each([['own_home'], ['rental_owned'], ['family_home'], [null]])('a condo with the relationship %s, on an account with no manager role, is not commercial', async (relationship) => {
      expect(await blockerFor((customer) => seedProperty(customer, { property_type: 'condo', relationship }))).toBeNull();
    });

    test('single homes that are managed for a client, on the account of a property manager, are not commercial', async () => {
      const customer = await seedCustomer({ contact_role: 'property_manager' });
      await seedProperty(customer, { ...MANAGED, occupancy_type: 'rental_investment' });
      await seedProperty(customer, { ...SECOND, ...MANAGED, property_type: 'townhome' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    test("another customer's managed condo says nothing about this customer", async () => {
      const customer = await seedCustomer();
      await seedProperty(customer, { property_type: 'condo', relationship: 'own_home' });
      await seedProperty(await seedCustomer({ contact_role: 'property_manager' }), { ...MANAGED, property_type: 'condo' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    // One mark is enough, whatever its age: the removal of a business address does not make the account a home.
    test.each([
      ['the commercial occupancy', { occupancy_type: 'commercial' }],
      ['a commercial type', { property_type: 'commercial' }],
    ])('a property with %s that was removed from the account (not active), beside a home: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedProperty(customer);
        await seedProperty(customer, { ...SECOND, active: false, ...change });
      })).toBe('commercial');
    });

    test('a home that was removed from the account is not commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedProperty(customer);
        await seedProperty(customer, { ...SECOND, active: false, occupancy_type: 'rental_investment', property_type: 'condo' });
      })).toBeNull();
    });

    test("another customer's commercial property says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedProperty(customer);
      await seedProperty(other, { occupancy_type: 'commercial' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });

    test('a commercial property is the answer also for an account that holds a plan', async () => {
      const customer = await seedCustomer({ waveguard_tier: 'Gold' });
      await seedProperty(customer, { occupancy_type: 'commercial' });
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    test('an inactive account with a commercial property is not live', async () => {
      const customer = await seedCustomer({ active: false });
      await seedProperty(customer, { occupancy_type: 'commercial' });
      expect(await planStartBlocker(trx, customer.id)).toBe('not_live');
    });
  });

  // The account row of a won commercial proposal can carry no mark (a proposal with no taxable lines, won before
  // the building use existed). The estimate itself is the record. Any one of the app's rules for a commercial
  // estimate is enough, on an estimate of any status.
  describe('an estimate of the account', () => {
    test('the fixture: a home estimate gets the default category, and its payload comes back as an object', async () => {
      const estimate = await seedEstimate(await seedCustomer());
      expect(estimate.category).toBe('RESIDENTIAL');
      expect(estimate.estimate_data).toEqual(HOME_ESTIMATE);
    });

    test.each([
      ['the commercial category', { category: 'COMMERCIAL' }],
      ['the commercial category with no payload', { category: 'COMMERCIAL', estimate_data: null }],
      ['an authored commercial proposal under the default category', { estimate_data: { proposal: { enabled: true } } }],
      ['a scaffolded commercial proposal', { estimate_data: { proposal: { enabled: false, scaffold: true } } }],
      ['a commercial property type in the form inputs', { estimate_data: { inputs: { propertyType: 'Commercial' } } }],
      ['a commercial service row the accept routes know by its key', { estimate_data: { result: { recurring: { services: [{ serviceKey: 'commercial_lawn_monthly' }] } } } }],
      ["the form's toggle as text", { estimate_data: { inputs: { isCommercial: 'YES' } } }],
      ["the engine's flag", { estimate_data: { engine: { intent: { is_commercial: true } } } }],
      // Under the default category, with one mark only.
      ['an office in the form inputs', { estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Office' } } }],
      ['a commercial risk type in the engine request', { estimate_data: { engineRequest: { profile: { commercialRiskType: 'food' } } } }],
      ["a commercial risk type in the engine's intent", { estimate_data: { engine: { intent: { commercial_risk_type: 'office_low' } } } }],
      ["a commercial subtype in the engine's intent", { estimate_data: { engine: { intent: { commercial_subtype: 'restaurant' } } } }],
      ['a commercial service pick in the engine inputs', { estimate_data: { engineInputs: { services: { commercialPest: { selected: true } } } } }],
      ['a service line whose label says commercial', { estimate_data: { result: { recurring: { services: [{ service: 'pest_control', label: 'Commercial Pest Control' }] } } } }],
      ["the commercial tier in the estimate's own tier column", { waveguard_tier: 'Commercial' }],
      ['a service line that carries its commercial key under `key`', { estimate_data: { result: { recurring: { services: [{ key: 'commercial_pest', name: 'Monthly Service' }] } } } }],
      ['a commercial service key in a list of picked keys', { estimate_data: { selectedServiceKeys: ['pest_quarterly', 'commercial_pest'] } }],
      // The estimate's own service label and notes: columns of the row, apart from the payload.
      ['the service label of the estimate, with no payload', { service_interest: 'Commercial Pest Control', estimate_data: null }],
      ['the service label beside home service lines', { service_interest: 'Lawn Care (commercial)' }],
      ['notes the app sorts as a commercial line, on an estimate with no service line', { notes: 'Quote the commercial pest program for the bakery.', estimate_data: {} }],
      ["a copy of the service label in the form's inputs", { estimate_data: { inputs: { leadServiceInterest: 'Commercial Lawn Care' } } }],
    ])('%s, beside a home estimate, on an account whose own row says nothing: commercial', async (_label, change) => {
      const customer = await seedCustomer();
      await seedEstimate(customer);
      await seedEstimate(customer, change);
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    // Every status the column's check constraint takes: a won estimate, an open one and an old one all count.
    test.each([['draft'], ['scheduled'], ['sending'], ['send_failed'], ['sent'], ['viewed'], ['accepted'], ['declined'], ['expired']])(
      'a commercial proposal with the status %s: commercial', async (status) => {
        expect(await blockerFor((customer) => seedEstimate(customer, { status, estimate_data: { proposal: { enabled: true } } }))).toBe('commercial');
      });

    test('an archived commercial estimate: commercial', async () => {
      expect(await blockerFor((customer) => seedEstimate(customer, { category: 'COMMERCIAL', archived_at: new Date() }))).toBe('commercial');
    });

    test('home estimates only, one of them won, are not commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        await seedEstimate(customer, { status: 'accepted', accepted_at: new Date() });
        await seedEstimate(customer, { estimate_data: null });
      })).toBeNull();
    });

    // A condo is a home. This is the estimate of a condo as the estimator saves one: a home tier, the empty
    // commercial fields and the pricing mode that every home estimate carries.
    // The reader of service lines reads four columns of the row. The proof hands it all four, as the pipeline does.
    test("the reader of service lines gets the row's label, notes, pricing authority and payload", async () => {
      const owner = require('../services/estimate-service-lines');
      const spy = jest.spyOn(owner, 'inferEstimateServiceLines');
      try {
        expect(await blockerFor((customer) => seedEstimate(customer, {
          service_interest: 'Pest Control', notes: 'Side gate is open.', pricing_authority: 'SERVER',
        }))).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
          service_interest: 'Pest Control', notes: 'Side gate is open.', pricing_authority: 'SERVER', estimate_data: HOME_ESTIMATE,
        }));
      } finally {
        spy.mockRestore();
      }
    });

    test('a home service label and home notes are not commercial, with or without service lines', async () => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer, { service_interest: 'Quarterly Pest Control', notes: 'Ants in the kitchen. Side gate is open.', estimate_data: {} });
        await seedEstimate(customer, { service_interest: 'Pest Control', notes: 'Pest plan for the house. Not a commercial account.' });
      })).toBeNull();
    });

    // The estimator keeps its own verdict on the premises with a draft (estimatorEngine.propertyFactsV2). The
    // category column keeps its default, and nothing else in the payload says commercial.
    const FACTS = (facts) => ({ estimatorEngine: { propertyFactsV2: { version: 2, shadow: true, facts: { propertySubtype: 'single_family', ...facts } } } });
    test.each([
      ['the commercial occupancy class', { occupancyClass: 'commercial', serviceScope: 'unknown' }],
      ['the scope of a whole commercial building', { occupancyClass: 'unknown', serviceScope: 'entire_commercial_building' }],
      ['the scope of a commercial parcel with several buildings', { occupancyClass: 'unknown', serviceScope: 'multi_building_commercial_parcel' }],
      ['the scope of the common area of an association', { occupancyClass: 'unknown', serviceScope: 'association_common_area' }],
    ])("%s in the estimator's saved property facts, under the default category: commercial", async (_label, facts) => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        const estimate = await seedEstimate(customer, { estimate_data: FACTS(facts) });
        expect(estimate.category).toBe('RESIDENTIAL');
      })).toBe('commercial');
    });

    test.each([
      ['a whole home', { occupancyClass: 'residential', serviceScope: 'entire_residential_structure' }],
      ['one unit of a residential building', { occupancyClass: 'residential', serviceScope: 'residential_unit' }],
      ['a scope the estimator could not resolve', { occupancyClass: 'residential', serviceScope: 'unknown' }],
    ])("the estimator's saved property facts of %s are not commercial", async (_label, facts) => {
      expect(await blockerFor((customer) => seedEstimate(customer, { estimate_data: FACTS(facts) }))).toBeNull();
    });

    // What the lookup keeps on a profile about a business at the address. The estimator saves the profile with
    // the estimate. Every other field of the profile reads residential, and the category column keeps its default.
    const PROFILE = (change = {}) => ({ engineRequest: { profile: {
      category: 'RESIDENTIAL', propertyType: 'Single Family', isCommercial: false, commercialSubtype: null, commercialDetectionSource: null, ...change,
    } } });
    test.each([
      ['the whole building, as staff decided for a business at the address', { serviceScopeDecision: 'entire_commercial_building' }],
      ["staff's answer that the customer has the whole building", { occupancyAnswer: 'building' }],
      ['the source of a commercial verdict of the lookup', { commercialDetectionSource: 'property_record_property_type' }],
      // The listing is not read, and the scope staff decided beside it still is.
      ['one suite, as staff decided, beside the listing of the business', {
        serviceScopeDecision: 'commercial_suite', serviceScopeSuggestion: 'suite',
        businessIdentity: { name: 'Corner Cafe', type: 'restaurant_food_service', matchedBy: 'subpremise', tenantsAtNumber: 3, unitKey: 'business:place-1' },
      }],
    ])("%s, in an estimate's saved lookup profile: commercial", async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        const estimate = await seedEstimate(customer, { estimate_data: PROFILE(change) });
        expect(estimate.category).toBe('RESIDENTIAL');
      })).toBe('commercial');
    });

    test.each([
      ['a home', {}],
      ['an open question about a business at the address', { serviceScopeDecision: 'scope_unresolved', occupancyAnswer: null }],
      ["staff's answer that the customer is not the listed business", { serviceScopeDecision: null, occupancyAnswer: 'none' }],
      // A listing only suggests, so the scan does not go into it: the name of the listed business can carry the word.
      ['an open question beside a listing whose name carries the word', {
        serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: 'Are we treating just your space or the whole building?', serviceScopeSuggestion: 'suite', occupancyAnswer: null,
        businessIdentity: { name: 'Commercial Realty', type: 'office_retail', matchedBy: 'street_number', tenantsAtNumber: 1, unitKey: 'business:place-2' },
      }],
    ])('the saved lookup profile of %s is not commercial', async (_label, change) => {
      expect(await blockerFor((customer) => seedEstimate(customer, { estimate_data: PROFILE(change) }))).toBeNull();
    });

    // Two marks of the payload scan of the save that no other rule holds, below the reach of that scan.
    test.each([
      ['the mark of an auto-priced commercial quote', { commercialEstimatedPricing: true }],
      ["the word none as a subtype in the form's spelling, beside a toggle set to no", { isCommercial: 'NO', commercialSubtype: 'none' }],
    ])('%s, 20 levels down in an estimate payload: commercial', async (_label, mark) => {
      expect(await blockerFor(async (customer) => {
        const estimate = await seedEstimate(customer, { estimate_data: farDown(mark) });
        expect(estimate.category).toBe('RESIDENTIAL');
      })).toBe('commercial');
    });

    // The estimator engine's mark on a draft it made as a commercial proposal, where the engine keeps it.
    test("the engine's mark of a commercial proposal draft, in an estimate payload: commercial", async () => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        const estimate = await seedEstimate(customer, { estimate_data: { estimatorEngine: { version: 1, lane: 'red', commercialProposal: true } } });
        expect(estimate.category).toBe('RESIDENTIAL');
      })).toBe('commercial');
    });

    // A copy of the service label in the payload, on an estimate with a home plan line and no label in its
    // own column. The reader of service lines answers with the line, so only the rule for a label reads it.
    test.each([
      ["the lead's interest the estimator form keeps", { inputs: { isCommercial: 'NO', propertyType: 'Single Family', leadServiceInterest: 'Commercial Lawn Care' } }],
      ['the interest the engine was given', { engineInputs: { isCommercial: false, serviceInterest: 'Commercial Lawn Care' } }],
      ['the service a call asked for, kept with a draft', { estimatorEngine: { version: 1, call: { requested_service: 'Lawn care for a commercial plaza', matched_service: 'Lawn Care' } } }],
      // A copy with no such word that names a business premises, in the wording the lead intake reads.
      ['a copy of the label that names a business premises', { inputs: { isCommercial: 'NO', propertyType: 'Single Family', leadServiceInterest: 'Lawn care at our office' } }],
    ])('%s, in an estimate payload with a home plan line: commercial', async (_label, labels) => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        const estimate = await seedEstimate(customer, { estimate_data: { ...labels, result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care' }] } } } });
        expect([estimate.category, estimate.service_interest]).toEqual(['RESIDENTIAL', null]);
      })).toBe('commercial');
    });

    // The estimate's own label, and a type only the estimator's recognition knows under either spelling of the
    // name: each on an estimate that the save left residential.
    test.each([
      ['its own service label names a business premises', { service_interest: 'Pest control for a hotel' }],
      ['a hotel in the form inputs, beside a toggle set to no', { estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Hotel' } } }],
      ['a church in the saved spelling of the type', { estimate_data: { snapshot: { property_type: 'church' } } }],
    ])('an estimate where %s: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        const estimate = await seedEstimate(customer, change);
        expect(estimate.category).toBe('RESIDENTIAL');
      })).toBe('commercial');
    });

    test('service labels that name a home, on an estimate and in its payload, are not commercial', async () => {
      expect(await blockerFor((customer) => seedEstimate(customer, { service_interest: 'Pest control for the home office', estimate_data: {
        inputs: { isCommercial: 'NO', propertyType: 'Mobile Home', leadServiceInterest: 'Lawn care for my house' },
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } },
      } }))).toBeNull();
    });

    test('home service labels in an estimate payload are not commercial', async () => {
      expect(await blockerFor((customer) => seedEstimate(customer, { estimate_data: {
        inputs: { isCommercial: 'NO', leadServiceInterest: 'Quarterly Pest Control', interestNote: 'Asked if we also do commercial work.' },
        engineInputs: { serviceInterest: 'Pest Control + Lawn Care' },
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } },
      } }))).toBeNull();
    });

    test('a quote that is not auto-priced as commercial, 20 levels down in an estimate payload, is not commercial', async () => {
      const mark = { commercialEstimatedPricing: false, isCommercial: 'NO', commercialSubtype: '', commercialDetectionSource: null };
      expect(await blockerFor((customer) => seedEstimate(customer, { estimate_data: farDown(mark) }))).toBeNull();
    });

    // A JSON text is a valid jsonb value, and the driver returns it as the text itself: not as JSON to parse.
    // It carries no structured mark, and it is never a failed read.
    test('the fixture: a payload that is a JSON text comes back as that text', async () => {
      const estimate = await seedEstimate(await seedCustomer(), { estimate_data: 'asked about pest control' });
      expect(estimate.estimate_data).toBe('asked about pest control');
    });

    test.each([
      ['a JSON text', 'asked about pest control'],
      ['an empty JSON text', ''],
      ['a JSON number', 7],
      ['a JSON false', false],
    ])('an estimate whose payload is %s carries no mark: not commercial', async (_label, estimate_data) => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        await seedEstimate(customer, { estimate_data });
      })).toBeNull();
    });

    test.each([
      ['its category column', { category: 'COMMERCIAL' }],
      ['its service label', { service_interest: 'Commercial Pest Control' }],
      ['the text itself, where it is a commercial service key', { estimate_data: 'commercial_pest' }],
    ])('an estimate whose payload is a JSON text is commercial by %s', async (_label, change) => {
      expect(await blockerFor((customer) => seedEstimate(customer, { estimate_data: 'asked about pest control', ...change }))).toBe('commercial');
    });

    test('the estimate of a condo is not commercial', async () => {
      expect(await blockerFor((customer) => seedEstimate(customer, {
        waveguard_tier: 'Bronze',
        estimate_data: {
          inputs: { isCommercial: 'NO', propertyType: 'Condo', commercialSubtype: '', commercialRiskType: '', commercialPricingMode: 'manual_quote' },
          engineRequest: { profile: { isCommercial: false, propertyType: 'condo_ground', commercialSubtype: null, commercialRiskType: null }, options: { commercialPricingMode: 'manual_quote' } },
          engine: { intent: { is_commercial: false, commercial_subtype: null, commercial_risk_type: null, category: 'RESIDENTIAL' } },
          result: { recurring: { services: [{ service: 'pest_control', serviceKey: 'pest_quarterly', name: 'Quarterly Pest Control' }] } },
          // A service pick that was not taken, and the prefix inside a text.
          commercial_lawn: { selected: false }, notes: 'Asked about commercial_pest for a friend.', selectedServiceKeys: ['pest_quarterly'],
        },
      }))).toBeNull();
    });

    // The kind of premises an estimate payload names apart from the property type: the occupancy of a bed bug
    // job (the estimator form saves it beside a residential default type), a property's own occupancy, and the
    // estimator's verdict on a draft it made. And a condo whose payload names a property manager.
    test.each([
      ["a hotel as the form's bed bug occupancy, beside the default property type", { inputs: { isCommercial: 'NO', propertyType: 'Single Family', bedbugOccupancyType: 'hotel' } }],
      ["student housing on the engine's bed bug service, 20 levels down", farDown({ bedBug: { rooms: 2, occupancyType: 'studentHousing' } })],
      ['an apartment on a priced bed bug line', { engineResult: { lineItems: [{ service: 'bed_bug', rooms: 1, occupancyType: 'apartment' }] } }],
      ['the commercial occupancy of an extra property', { additional_properties: [{ address_line1: '12 Example Test Way', occupancy: 'commercial' }] }],
      ["the estimator's category conflict on a draft it made", { inputs: { isCommercial: 'NO', propertyType: 'Condo' }, estimatorEngine: { version: 1, lane: 'red', propertyFacts: { categoryConflict: 'property_manager:condo' } } }],
      ['a condo and a unit scope that names a property manager', { inputs: { isCommercial: 'NO', propertyType: 'Condo' }, estimatorEngine: { version: 1, propertyFacts: { unitScope: { customerRelationship: 'property_manager' }, categoryConflict: null } } }],
    ])('an estimate with %s: commercial', async (_label, estimate_data) => {
      expect(await blockerFor(async (customer) => {
        await seedEstimate(customer);
        await seedEstimate(customer, { estimate_data });
      })).toBe('commercial');
    });

    test("an estimate of a condo with the form's default bed bug occupancy, no category conflict and an owner in its unit scope is not commercial", async () => {
      expect(await blockerFor((customer) => seedEstimate(customer, { estimate_data: {
        inputs: { isCommercial: 'NO', propertyType: 'Condo', bedbugOccupancyType: 'singleFamily' },
        engineResult: { lineItems: [{ service: 'bed_bug', occupancyType: 'singleFamily', multipliers: { occupancy: 1 } }] },
        estimatorEngine: { version: 1, propertyFacts: { unitScope: { propertyUse: 'condominium', customerRelationship: 'owner' }, categoryConflict: null } },
      } }))).toBeNull();
    });

    test('the estimate of a condo on the account of a property manager: commercial', async () => {
      const customer = await seedCustomer({ contact_role: 'property_manager' });
      await seedEstimate(customer, { estimate_data: { inputs: { isCommercial: 'NO', propertyType: 'Condo' } } });
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    test("another customer's commercial estimate, and one with no customer on it, say nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedEstimate(customer);
      await seedEstimate(other, { category: 'COMMERCIAL' });
      await seedEstimate(null, { category: 'COMMERCIAL', estimate_data: { proposal: { enabled: true } } });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });

    test('a commercial estimate is the answer also for an account that holds a plan', async () => {
      const customer = await seedCustomer({ waveguard_tier: 'Gold' });
      await seedEstimate(customer, { estimate_data: { proposal: { enabled: true } } });
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    test('an inactive account with a commercial estimate is not live', async () => {
      const customer = await seedCustomer({ active: false });
      await seedEstimate(customer, { category: 'COMMERCIAL' });
      expect(await planStartBlocker(trx, customer.id)).toBe('not_live');
    });
  });

  describe('a lead of the account', () => {
    test('the fixture: a lead gets the home flags by default', async () => {
      const lead = await seedLead(await seedCustomer());
      expect([lead.is_commercial, lead.is_residential]).toEqual([false, true]);
    });

    test.each([
      ['a lead the intake marked commercial', { is_commercial: true }],
      ['a commercial lead that also keeps the residential flag', { is_commercial: true, is_residential: true }],
      ['a commercial lead that was deleted', { is_commercial: true, deleted_at: new Date() }],
      // The commercial flag is off (the column default) on each lead below: one other column carries the mark.
      ['a lead with the residential flag set to no', { is_residential: false }],
      ['a lead that asked for a commercial service, by its label', { service_interest: 'Commercial Pest Control' }],
      ['a lead that asked for a commercial service, by its catalog key', { service_key: 'commercial_pest' }],
      ['a lead with the commercial tier', { waveguard_tier: 'Commercial' }],
      ["a lead with the commercial toggle in the intake's payload", { extracted_data: JSON.stringify({ isCommercial: 'YES' }) }],
      ['a deleted lead with a commercial key in its payload', { extracted_data: JSON.stringify({ classification: { intent: 'commercial_inquiry' } }), deleted_at: new Date() }],
      ["a quiz lead that answered 'business'", { extracted_data: JSON.stringify({ quiz: { kind: 'pest', seeing: 'ants', property: 'business' } }) }],
      ['a lead whose payload has a commercial category beside a residential type', { extracted_data: JSON.stringify({ enriched: { category: 'COMMERCIAL', propertyType: 'single_family' } }) }],
      ["a lead whose payload keeps staff's answer about a business at the address", { extracted_data: JSON.stringify({ enriched: { category: 'RESIDENTIAL', isCommercial: false, occupancyAnswer: 'building' } }) }],
      ['a lead with the mark of an auto-priced commercial quote 20 levels down in its payload', { extracted_data: JSON.stringify(farDown({ commercialEstimatedPricing: true })) }],
      // A web form keeps the service label in the payload too.
      ['a lead with a commercial service label in its payload, behind a home label in its column', {
        service_interest: 'Pest Control', extracted_data: JSON.stringify({ stage: 'lead_webhook_received', service_interest: 'Commercial Pest Control' }),
      }],
      // A label with no such word that names a business premises, on a lead with the default flags.
      ['a lead whose service label names a business premises', { service_interest: 'Pest control for a hotel' }],
      ['a lead whose payload keeps such a label, behind a home label in its column', {
        service_interest: 'Pest Control', extracted_data: JSON.stringify({ stage: 'lead_webhook_received', service_interest: 'Rodent control at the warehouse' }),
      }],
      // A property entry of a lead has the shape of a call's property, and the merge keeps every field of it.
      ["a lead that keeps the commercial occupancy of a call's main address on a property", {
        extracted_data: JSON.stringify({ additional_properties: [{ address_line1: '12 Example Test Way', property_type: 'single_family', service_address_occupancy: 'commercial' }] }),
      }],
      ['a lead that keeps a service of the common areas of an association on a property', {
        extracted_data: JSON.stringify({ additional_properties: [{ address_line1: '12 Example Test Way', property_type: 'condo', hoa_common_area_service: true }] }),
      }],
      // The campaign text of an advertisement, kept as a picked service key beside the attribution.
      ['a lead that keeps a commercial key as a picked service, beside the attribution of an advertisement', {
        extracted_data: JSON.stringify({ attribution: { utm: { source: 'google', campaign: 'commercial_pest' } }, selectedServices: ['commercial_pest'] }),
      }],
    ])('%s, beside a home lead: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedLead(customer);
        await seedLead(customer, change);
      })).toBe('commercial');
    });

    test.each([
      ['a home lead', {}],
      ['a lead with no commercial flag at all', { is_commercial: null }],
      ['a lead with no residential flag at all', { is_residential: null }],
      ['a home lead with a label, a key, a tier and a payload', {
        service_interest: 'Pest Control', service_key: 'pest_general_quarterly', waveguard_tier: 'Bronze',
        extracted_data: JSON.stringify({ isCommercial: false, commercialSubtype: null, commercialDetectionSource: null, propertyType: 'Single Family' }),
      }],
      ["a quiz lead that answered 'house'", { extracted_data: JSON.stringify({ quiz: { kind: 'pest', seeing: 'ants', property: 'house' } }) }],
      ['a lead whose payload has a residential category', { extracted_data: JSON.stringify({ enriched: { category: 'RESIDENTIAL', propertyType: 'single_family' } }) }],
      ['a lead whose label names a home', { service_interest: 'Pest control for the home office' }],
      ['a lead with a home service label and the words of a call in its payload', {
        extracted_data: JSON.stringify({ stage: 'lead_webhook_received', service_interest: 'Pest Control', pain_points: ['The commercial spray from the store did not work'] }),
      }],
      // What the link of the visitor carried names the advertisement, not the premises: the scan does not go into it.
      ['a lead that came by an advertisement named for commercial pest control, with the attribution a web form and the quote page save', {
        extracted_data: JSON.stringify({
          stage: 'lead_webhook_received',
          service_interest: 'Pest Control',
          attribution: { formId: 'commercial_quote_form', landingUrl: 'https://example.test/commercial-pest-control', utm: { source: 'google', medium: 'cpc', campaign: 'commercial_pest' }, clickIds: { gclid: 'commercial_click' } },
          source_evidence: { kind: 'paid_search', label: 'Commercial Pest Control ad', detail: 'commercial_pest', basis: 'utm' },
          utm: { campaign: 'commercial_pest' },
          clickIds: { gclid: 'commercial_click' },
          referrer: 'commercial_pest',
          landing_url: 'commercial_pest',
        }),
      }],
      ['a lead that keeps a home occupancy of a main address on a property in an association', {
        extracted_data: JSON.stringify({ additional_properties: [{ address_line1: '12 Example Test Way', property_type: 'single_family', service_address_occupancy: 'seasonal', hoa_common_area_service: false, hoa_community_flag: true }] }),
      }],
    ])('%s is not commercial', async (_label, change) => {
      expect(await blockerFor((customer) => seedLead(customer, change))).toBeNull();
    });

    test('the fixture: a lead payload comes back as an object', async () => {
      const lead = await seedLead(await seedCustomer(), { extracted_data: JSON.stringify({ isCommercial: false }) });
      expect(lead.extracted_data).toEqual({ isCommercial: false });
    });

    // A JSON text is a valid jsonb value. The driver returns it as the text itself: a second parse would fail.
    test('a lead whose payload is a JSON text: the text comes back as it is, and it is not a failed read', async () => {
      const customer = await seedCustomer();
      await seedLead(customer);
      const lead = await seedLead(customer, { extracted_data: JSON.stringify('asked about pest control') });
      expect(lead.extracted_data).toBe('asked about pest control');
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    test.each([
      ['the text itself, where it is a commercial service key', { extracted_data: JSON.stringify('commercial_pest') }],
      ['its commercial flag', { extracted_data: JSON.stringify('asked about pest control'), is_commercial: true }],
    ])('a lead whose payload is a JSON text is commercial by %s', async (_label, change) => {
      expect(await blockerFor((customer) => seedLead(customer, change))).toBe('commercial');
    });

    test('a lead that keeps an extra property: commercial with the commercial occupancy, and not with a home occupancy', async () => {
      const extra = (occupancy) => ({ extracted_data: JSON.stringify({ additional_properties: [{ address_line1: '12 Example Test Way', property_type: 'single_family', occupancy }] }) });
      expect(await blockerFor((customer) => seedLead(customer, extra('commercial')))).toBe('commercial');
      expect(await blockerFor((customer) => seedLead(customer, extra('rental_investment')))).toBeNull();
    });

    test('a lead about a condo: commercial on the account of a property manager, and not on another account', async () => {
      const condo = { extracted_data: JSON.stringify({ isCommercial: false, propertyType: 'Condo' }) };
      const manager = await seedCustomer({ contact_role: 'property_manager' });
      await seedLead(manager, condo);
      expect(await planStartBlocker(trx, manager.id)).toBe('commercial');
      expect(await blockerFor((customer) => seedLead(customer, condo))).toBeNull();
    });

    test("another customer's commercial lead, and one with no customer on it, say nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedLead(customer);
      await seedLead(other, { is_commercial: true });
      await seedLead(null, { is_commercial: true });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });

    test("another customer's lead for a commercial service, and one with no customer on it, say nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedLead(customer, { service_interest: 'Pest Control' });
      await seedLead(other, { service_interest: 'Commercial Pest Control' });
      await seedLead(null, { service_key: 'commercial_pest', is_residential: false });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });
  });

  // The call system's saved verdict on a call: the extraction and the triage. The words of the call are not read.
  describe('a call of the account', () => {
    const enriched = (change) => ({ ai_extraction_enriched: { ...HOME_CALL.ai_extraction_enriched, ...change } });

    test('the fixture: a call keeps its first format as JSON text, and its verdicts and address check as objects', async () => {
      const call = await seedCall(await seedCustomer());
      expect(JSON.parse(call.ai_extraction)).toEqual(HOME_CALL.ai_extraction);
      expect(call.ai_extraction_enriched).toEqual(HOME_CALL.ai_extraction_enriched);
      expect(call.ai_validation).toEqual(HOME_CALL.ai_validation);
      expect(call.ai_address_validation).toEqual(HOME_CALL.ai_address_validation);
      expect(call.v2_extraction_status).toBe('valid');
    });

    // The call processor keeps the output of a model that failed the extraction schema, for the audit of the
    // failure, and the column takes a NULL. The read carries the status, and an extraction that is not 'valid'
    // is not read. The call's other records are.
    test.each([['schema_failed'], ['parse_failed'], [null]])('a commercial extraction at the status %j, beside a call about a home: not commercial', async (v2_extraction_status) => {
      const rejected = { ...enriched({ property: { property_type: 'commercial', commercial_subtype: 'office' }, commercial_signals: { business_name: 'Synthetic Bakery' } }), v2_extraction_status };
      expect(await blockerFor(async (customer) => {
        await seedCall(customer, rejected);
        await seedCall(customer);
      })).toBeNull();
      expect(await blockerFor(async (customer) => {
        await seedCall(customer);
        await seedCall(customer, { ...rejected, v2_extraction_status: 'valid' });
      })).toBe('commercial');
    });

    test('a commercial service in the first format of a call whose extraction failed its schema: commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedCall(customer);
        await seedCall(customer, { v2_extraction_status: 'schema_failed', ai_extraction: { requested_service: 'Commercial pest control' } });
      })).toBe('commercial');
    });

    test.each([
      ['a commercial property type', enriched({ property: { property_type: 'commercial' } })],
      ['a commercial subtype on a type that reads as a home', enriched({ property: { property_type: 'unknown', commercial_subtype: 'other' } })],
      ['an HOA common area service at a condo', enriched({ property: { property_type: 'condo', hoa_common_area_service: true } })],
      ['the owner of a multi-unit building', enriched({ property: { property_type: 'multi_family' }, caller: { relationship_to_property: 'owner' } })],
      ['a commercial occupancy of the service address', enriched({ property: { property_type: 'unknown', service_address_occupancy: 'commercial' } })],
      ['a commercial occupancy of the service address in the first format, with no other verdict', {
        ai_extraction: { requested_service: 'Pest control', service_address_occupancy: 'commercial' }, ai_extraction_enriched: null, ai_validation: null,
      }],
      ['an additional property of a commercial type', enriched({ property: { property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: null, property_type: 'commercial' }] } })],
      ['an additional property with a commercial occupancy in the first format', {
        ai_extraction: { requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', is_rental: false, occupancy: 'commercial' }] },
      }],
      ['a business name in the commercial-signals block', enriched({ commercial_signals: { business_name: 'Synthetic Bakery', annual_contract_interest: false } })],
      ["the commercial flag among the extraction's own flags", enriched({ triage_flags: ['quote_promised', 'commercial_requires_quote'] })],
      ['the commercial flag among the routing flags', { ai_validation: { routing: { flags: ['commercial_requires_quote'], appointment_blocking_flags: [] } } }],
      ['the HOA flag among the flags that hold a booking', { ai_validation: { routing: { flags: [], appointment_blocking_flags: ['hoa_common_area_requires_approval'] } } }],
      ['a commercial service in the first format, with no other verdict', { ai_extraction: { requested_service: 'Commercial pest control' }, ai_extraction_enriched: null, ai_validation: null }],
      ['a commercial service name in the extraction, behind a generic first format', {
        ai_extraction: { requested_service: 'pest_general' },
        ...enriched({ service_request: { primary_service_category: 'pest_general', specific_service_name: 'Commercial Pest Control' } }),
      }],
      ['an address the check reads as a business and not as a home', { ai_address_validation: { status: 'validated_accept', addressUse: { business: true, residential: false, poBox: false } } }],
      // The first format keeps the service under two more names, and again in the record of what an adoption replaced.
      ['a commercial catalog match in the first format, behind a home request and with no other verdict', {
        ai_extraction: { requested_service: 'Pest control', matched_service: 'Commercial Pest Control' }, ai_extraction_enriched: null, ai_validation: null,
      }],
      ['a commercial catalog name in the first format, with no other verdict', {
        ai_extraction: { requested_service: 'Pest control', matched_service: 'Pest Control', specific_service_name: 'Commercial Pest Control' }, ai_extraction_enriched: null, ai_validation: null,
      }],
      ['a commercial catalog match that an adoption replaced in the first format', {
        ai_extraction: { requested_service: 'pest_general', matched_service: 'Pest Control', pre_adoption_service_fields: { matched_service: 'Commercial Pest Control', requested_service: null } },
      }],
      // A request with no such word that names a business premises, in the wording the lead intake reads.
      ['a request that names a business premises in the first format, with no other verdict', {
        ai_extraction: { requested_service: 'Ant treatment for a school' }, ai_extraction_enriched: null, ai_validation: null,
      }],
    ])('%s, beside a call about a home: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedCall(customer);
        await seedCall(customer, change);
      })).toBe('commercial');
    });

    test.each([
      ['calls about a home only', {}],
      ['a call with no extraction, no validation and no address check', { ai_extraction: null, ai_extraction_enriched: null, ai_validation: null, ai_address_validation: null }],
      ['a rental among the properties of the call', enriched({ property: { property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: 'rental_investment', property_type: 'condo' }] } })],
      ['an address the check reads as a business and as a home', { ai_address_validation: { status: 'validated_accept', addressUse: { business: true, residential: true, poBox: false } } }],
      ['a business candidate of an address check that did not confirm the address', { ai_address_validation: { status: 'ambiguous', granularity: 'SUB_PREMISE', addressUse: { business: true, residential: false, poBox: false } } }],
      ['a flag word in the schema errors a validation keeps', { ai_validation: { routing: null, errors: [{ keyword: 'enum', params: { allowedValues: ['commercial_requires_quote', 'hoa_common_area_requires_approval'] } }] } }],
      ['the tenant of an apartment', enriched({ property: { property_type: 'multi_family' }, caller: { relationship_to_property: 'tenant' } })],
      ['a caller in a multi-family building, with no relationship named', enriched({ property: { property_type: 'multi_family' }, caller: { relationship_to_property: null } })],
      ['the wording of a business premises in the summary of the call', { ai_extraction: { requested_service: 'Pest control', call_summary: 'Wants pest control for our restaurant next month.' } }],
      ['a commercial-signals block with nothing set', enriched({ commercial_signals: { business_name: null, decision_authority_confirmed: false, insurance_or_compliance_requirements: [] } })],
      ['the word in the summary of the call', { ai_extraction: { requested_service: 'Pest control at home', call_summary: 'Works at a commercial bakery. Wants service at home.' } }],
      ['the word in a price quote of the service request', enriched({ service_request: { specific_service_name: 'Pest control', price: { evidence_quote: 'The commercial rate is higher.' } } })],
      ['the word in the pain points, and in the summary an adoption replaced', { ai_extraction: {
        requested_service: 'Pest control', matched_service: 'Pest Control', specific_service_name: 'Quarterly Pest Control', pain_points: ['The commercial spray from the store did not work'],
        pre_adoption_service_fields: { call_summary: 'Works at a commercial bakery. Wants service at home.', pain_points: ['Tried a commercial product'], matched_service: 'Pest Control' },
      } }],
    ])('%s: not commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedCall(customer);
        await seedCall(customer, change);
      })).toBeNull();
    });

    // The app's rule reads the caller for the main property alone. Every property of a manager's call is asked
    // with the manager, in both formats.
    const MANAGER_CALLER = { caller: { relationship_to_property: 'property_manager' } };
    test.each([
      ['a second property is a condo', enriched({ ...MANAGER_CALLER, property: { property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', occupancy: 'rental_investment', property_type: 'condo' }] } })],
      ['a second property is a condo in the first format', {
        ai_extraction: { requested_service: 'Pest control', additional_properties: [{ address_line1: '12 Example Test Way', is_rental: true, property_type: 'condo' }] },
        ...enriched(MANAGER_CALLER),
      }],
    ])('the call of a property manager where %s: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedCall(customer);
        await seedCall(customer, change);
      })).toBe('commercial');
    });

    test('the call of a property manager about single homes only is not commercial', async () => {
      expect(await blockerFor((customer) => seedCall(customer, enriched({ ...MANAGER_CALLER, property: { property_type: 'single_family', additional_properties: [{ street_line_1: '12 Example Test Way', property_type: 'townhouse' }] } })))).toBeNull();
    });

    test('a condo in a call with no caller named: commercial on the account of a property manager', async () => {
      const condo = enriched({ caller: { relationship_to_property: 'unknown' }, property: { property_type: 'condo' } });
      const manager = await seedCustomer({ contact_role: 'property_manager' });
      await seedCall(manager, condo);
      expect(await planStartBlocker(trx, manager.id)).toBe('commercial');
      expect(await blockerFor((customer) => seedCall(customer, condo))).toBeNull();
    });

    test("another customer's commercial call, and one no account was matched to, say nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedCall(customer);
      await seedCall(other, enriched({ property: { property_type: 'commercial' } }));
      await seedCall(null, { ai_validation: { routing: { flags: ['commercial_requires_quote'] } } });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });

    test('a commercial call is the answer also for an account that holds a plan', async () => {
      const customer = await seedCustomer();
      await seedFlaggedVisit(customer);
      expect(await planStartBlocker(trx, customer.id)).toBe('has_plan');
      await seedCall(customer, enriched({ property: { property_type: 'commercial' } }));
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });

    // The extraction, the validation and the address check are jsonb columns. A JSON text in one of them is a
    // valid value, and the driver returns it as the text itself: no mark, and never a failed read.
    test('a call whose verdicts and address check are JSON texts: not commercial, and not a failed read', async () => {
      const customer = await seedCustomer();
      await seedCall(customer);
      const call = await seedCall(customer, { ai_extraction_enriched: 'asked about pest control', ai_validation: 'not validated', ai_address_validation: 'not checked' });
      expect([call.ai_extraction_enriched, call.ai_validation, call.ai_address_validation]).toEqual(['asked about pest control', 'not validated', 'not checked']);
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    // The first format is serialized JSON in a TEXT column. A text there that is not JSON is a saved verdict
    // the proof cannot read: a failed read, never "a home".
    test("a call whose first format is text and not JSON: a failed read", async () => {
      const customer = await seedCustomer();
      const [call] = await trx('call_log').insert({ customer_id: customer.id, ai_extraction: 'extraction failed' }).returning('*');
      expect(call.ai_extraction).toBe('extraction failed');
      await expect(planStartBlocker(trx, customer.id)).rejects.toThrow("could not read a call's first extraction");
    });
  });

  // The judge of a day agreement reads a call or a text thread. The app saves its blockers with the decision.
  describe('a day-agreement decision of the account', () => {
    test('the fixture: a decision comes back with its blockers as a list', async () => {
      const decision = await seedDecision(await seedCustomer(), { judged: { act: false, blockers: ['commercial'] }, ...SKIPPED });
      expect(decision.judged).toEqual({ act: false, blockers: ['commercial'] });
    });

    test.each([
      ['a skipped call decision with the commercial blocker', { judged: { act: false, blockers: ['commercial'] }, ...SKIPPED }],
      ['a text-thread decision with the commercial blocker among others', { judged: { act: false, blockers: ['vague_day', 'commercial'] }, ...SKIPPED, source_kind: 'sms' }],
    ])('%s, beside a clean decision: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedDecision(customer);
        await seedDecision(customer, change);
      })).toBe('commercial');
    });

    test.each([
      ['clean decisions only', {}],
      ['a decision with other blockers', { judged: { act: false, blockers: ['complaint', 'other'] }, ...SKIPPED }],
      ['a source that was never judged', { judged: null, verdict: 'skip', skip_reason: 'call_too_long' }],
    ])('%s: not commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedDecision(customer);
        await seedDecision(customer, change);
      })).toBeNull();
    });

    test('a decision whose saved verdict is a JSON text: not commercial, and not a failed read', async () => {
      const customer = await seedCustomer();
      const decision = await seedDecision(customer, { judged: 'not judged', ...SKIPPED });
      expect(decision.judged).toBe('not judged');
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    test("another customer's commercial decision, and one with no customer on it, say nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedDecision(customer);
      await seedDecision(other, { judged: { act: false, blockers: ['commercial'] }, ...SKIPPED });
      await seedDecision(null, { judged: { act: false, blockers: ['commercial'] }, ...SKIPPED });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });
  });

  // The rule the calendar and tier readers apply to a row joined to its catalog row: the row's own service text,
  // the catalog key, the catalog name. The proof asks it of every visit and of every service report.
  describe('a visit of the account', () => {
    test.each([
      ['a done visit', { status: 'completed' }],
      ['a cancelled visit', { status: 'cancelled' }],
      ['a visit still to come', { status: 'confirmed', scheduled_date: day(10) }],
      ['a visit with no status', { status: null }],
    ])('a commercial service in the text of %s, beside a home visit: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        await seedVisit(customer);
        await seedVisit(customer, { service_type: 'Commercial Pest Control', ...change });
      })).toBe('commercial');
    });
  });

  // A visit keeps the catalog key it was booked under, also with no link to the catalog.
  describe("a visit's saved catalog key (service_key_snapshot)", () => {
    test('a commercial saved key behind a generic text and no catalog link, beside a home visit: commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedVisit(customer, { service_key_snapshot: 'pest_quarterly' });
        const visit = await seedVisit(customer, { service_type: 'Pest Control', service_key_snapshot: 'commercial_pest', status: 'cancelled' });
        expect(visit.service_id).toBeNull();
      })).toBe('commercial');
    });

    test('home saved keys only are not commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedVisit(customer, { service_type: 'Pest Control', service_key_snapshot: 'pest_quarterly' });
        await seedVisit(customer, { service_type: 'Lawn Care', service_key_snapshot: 'lawn_care_monthly' });
      })).toBeNull();
    });

    test("another customer's commercial saved key says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedVisit(customer, { service_key_snapshot: 'pest_quarterly' });
      await seedVisit(other, { service_type: 'Pest Control', service_key_snapshot: 'commercial_pest' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });
  });

  // An add-on is a second service on a visit, with an identity of its own: the name it was saved under, the
  // catalog key it was booked under, and its catalog row.
  describe('an add-on of a visit of the account', () => {
    test.each([
      ['its saved name', { service_name: 'Commercial Mosquito Service' }],
      ['the catalog key it was booked under, with no catalog link', { service_key_snapshot: 'commercial_mosquito' }],
    ])('a commercial add-on by %s, on a done visit with a home service: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => {
        const visit = await seedVisit(customer);
        await seedAddon(visit, { service_key_snapshot: 'mosquito_monthly' });
        const addon = await seedAddon(visit, change);
        expect(addon.service_id).toBeNull();
      })).toBe('commercial');
    });

    test.each([
      ['key', { service_key: `commercial_synthetic_${hex(6)}` }],
      ['name', { name: 'Synthetic Commercial Service' }],
    ])('a commercial catalog %s behind a generic add-on name: commercial', async (_label, catalog) => {
      const service = await seedCatalogService(catalog);
      expect(await blockerFor(async (customer) => seedAddon(await seedVisit(customer), { service_id: service.id }))).toBe('commercial');
    });

    test.each([
      ['a cancelled visit', { status: 'cancelled' }],
      ['a visit still to come', { status: 'confirmed', scheduled_date: day(10) }],
    ])('a commercial add-on of %s: commercial', async (_label, change) => {
      expect(await blockerFor(async (customer) => seedAddon(await seedVisit(customer, change), { service_name: 'Commercial Mosquito Service' }))).toBe('commercial');
    });

    test('home add-ons only, one of them linked to a home catalog service, are not commercial', async () => {
      const service = await seedCatalogService();
      expect(await blockerFor(async (customer) => {
        const visit = await seedVisit(customer);
        await seedAddon(visit);
        await seedAddon(visit, { service_id: service.id, service_key_snapshot: 'mosquito_monthly' });
        await seedAddon(await seedVisit(customer, { status: 'cancelled' }), { service_name: 'Fire Ant Treatment' });
      })).toBeNull();
    });

    test("another customer's commercial add-on says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedAddon(await seedVisit(customer));
      await seedAddon(await seedVisit(other), { service_key_snapshot: 'commercial_mosquito' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });
  });

  // An edit of "this visit and the ones after it" leaves the first visit as it was done and saves the new
  // service on the series root, apart from the root's own columns (recurring_template_overrides, jsonb). The
  // series below is over: the root is done, the plan does not go on, and no later visit carries the new service.
  describe('the service a series of the account goes on with', () => {
    const seedEndedRoot = (customer, template, change = {}) => seedSeriesRoot(customer, {
      recurring_ongoing: false, recurring_template_overrides: JSON.stringify(template), ...change,
    });
    const NEW_PRICE = { estimated_price: 55, primary_line_price: 55 };

    test('the fixture: an ended series with a new price only is no plan record, and its template comes back as an object', async () => {
      const customer = await seedCustomer();
      const root = await seedEndedRoot(customer, NEW_PRICE);
      expect(root.recurring_template_overrides).toEqual(NEW_PRICE);
      expect(root.service_type).toBe(PLAN_SERVICE);
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
    });

    test.each([
      ['a commercial service text', { service_type: 'Commercial Pest Control' }],
      ['a commercial catalog key that was saved with the edit, behind a generic text', { service_type: 'Pest Control', service_key_snapshot: 'commercial_pest_monthly' }],
    ])('%s in the template of a root that keeps its home service: commercial', async (_label, service) => {
      expect(await blockerFor((customer) => seedEndedRoot(customer, { ...NEW_PRICE, ...service }))).toBe('commercial');
    });

    test.each([
      ['key', { service_key: `commercial_synthetic_${hex(6)}` }],
      ['name', { name: 'Synthetic Commercial Service' }],
    ])('a template that links a catalog service with a commercial %s: commercial', async (_label, catalog) => {
      const service = await seedCatalogService(catalog);
      const home = await seedCatalogService();
      expect(await blockerFor(async (customer) => {
        await seedEndedRoot(customer, { service_id: home.id });
        await seedEndedRoot(customer, { service_type: 'Pest Control', service_id: service.id });
      })).toBe('commercial');
    });

    test('a commercial template counts on a cancelled root too', async () => {
      expect(await blockerFor((customer) => seedEndedRoot(customer, { service_type: 'Commercial Pest Control' }, { status: 'cancelled' }))).toBe('commercial');
    });

    test.each([
      ['a home service with its catalog row', async () => ({ service_type: 'Quarterly Pest Control', service_key_snapshot: 'pest_quarterly', service_id: (await seedCatalogService()).id })],
      ['a link to a catalog row that is not there', async () => ({ service_id: crypto.randomUUID() })],
      // The catalog id is a uuid. A link of another kind names no catalog row, and the read does not fail on it.
      ['a link that is not a catalog id', async () => ({ service_id: 'not-an-id' })],
      ['a cleared link', async () => ({ service_type: 'Pest Control', service_id: null, service_key_snapshot: null })],
      ['the keys the seeder keeps, with a street name that holds the word', async () => ({ anchored_split_per_visit: 45, appointment_address: { address_line1: '100 Commercial Way' } })],
      // A JSON text is a valid jsonb value: no template, and never a failed read.
      ['a JSON text', async () => 'none'],
    ])('a template of %s is not commercial', async (_label, template) => {
      expect(await blockerFor(async (customer) => seedEndedRoot(customer, await template()))).toBeNull();
    });

    test("another customer's commercial template says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedEndedRoot(customer, NEW_PRICE);
      await seedEndedRoot(other, { service_type: 'Commercial Pest Control' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });

    test('a commercial template is the answer also for a series that goes on', async () => {
      const customer = await seedCustomer();
      const root = await seedSeriesRoot(customer);
      expect(await planStartBlocker(trx, customer.id)).toBe('has_plan');
      await trx('scheduled_services').where({ id: root.id }).update({ recurring_template_overrides: JSON.stringify({ service_type: 'Commercial Pest Control' }) });
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });
  });

  // The app knows the commercial agreement by its template key.
  describe('a contract of the account', () => {
    const { TEMPLATE_KEY } = require('../services/commercial-proposal-agreement');

    // Every status the app gives a contract: the draft, sent, viewed, signed, cancelled.
    test.each([['draft'], ['sent'], ['viewed'], ['signed'], ['cancelled']])(
      'a contract from the commercial agreement template with the status %s, beside a home contract: commercial', async (status) => {
        expect(await blockerFor(async (customer) => {
          await seedContract(customer);
          await seedContract(customer, { document_template_key: TEMPLATE_KEY, status });
        })).toBe('commercial');
      });

    test('home contracts only (a termite agreement, an autopay form with no template) are not commercial', async () => {
      expect(await blockerFor(async (customer) => {
        await seedContract(customer, { status: 'signed' });
        await seedContract(customer, { contract_type: 'autopay_authorization', document_template_key: null });
      })).toBeNull();
    });

    test("another customer's commercial contract says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedContract(customer);
      await seedContract(other, { document_template_key: TEMPLATE_KEY, status: 'signed' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });
  });

  describe('a service report of the account', () => {
    // Every status the column's check constraint takes.
    test.each([['scheduled'], ['in_progress'], ['completed'], ['cancelled'], ['incomplete']])(
      'a commercial service in the text of a report with the status %s, beside a home report: commercial', async (status) => {
        expect(await blockerFor(async (customer) => {
          await seedServiceReport(customer);
          await seedServiceReport(customer, { service_type: 'Commercial Pest Control', status });
        })).toBe('commercial');
      });

    test('a report with no visit behind it, on an account with no visit at all: commercial', async () => {
      const customer = await seedCustomer();
      const report = await seedServiceReport(customer, { service_type: 'Commercial Pest Control' });
      expect(report.scheduled_service_id).toBeNull();
      expect(await planStartBlocker(trx, customer.id)).toBe('commercial');
    });
  });

  describe.each([
    ['a visit', (customer, change) => seedVisit(customer, change)],
    ['a service report', (customer, change) => seedServiceReport(customer, change)],
  ])('the service of %s', (_kind, seedRecord) => {
    test.each([
      ['key', { service_key: `commercial_synthetic_${hex(6)}` }],
      ['name', { name: 'Synthetic Commercial Service' }],
    ])('a commercial catalog %s behind a generic service text: commercial', async (_label, catalog) => {
      const service = await seedCatalogService(catalog);
      expect(await blockerFor((customer) => seedRecord(customer, { service_type: 'Pest Control', service_id: service.id }))).toBe('commercial');
    });

    test('home services only, one of them linked to a home catalog service, are not commercial', async () => {
      const service = await seedCatalogService();
      expect(await blockerFor(async (customer) => {
        await seedRecord(customer);
        await seedRecord(customer, { service_type: 'Pest Control', service_id: service.id });
        await seedRecord(customer, { status: 'cancelled', service_type: 'One-Time Roach Treatment' });
      })).toBeNull();
    });

    test("another customer's commercial service says nothing about this customer", async () => {
      const customer = await seedCustomer();
      const other = await seedCustomer();
      await seedRecord(customer);
      await seedRecord(other, { service_type: 'Commercial Pest Control' });
      expect(await planStartBlocker(trx, customer.id)).toBeNull();
      expect(await planStartBlocker(trx, other.id)).toBe('commercial');
    });
  });

  describe('a visit that carries the recurring flag', () => {
    test.each([
      ['dated after today', {}],
      ['dated today', { scheduled_date: day(0) }],
      ['in progress now, with a date before today', { status: 'on_site', scheduled_date: day(-1) }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedFlaggedVisit(customer, change))).toBe('has_plan');
    });

    test.each([
      // The $0 second visit of a one-time job rides the job, never a plan. No writer saves it with the flag.
      ['an included follow-up', { followup_included: true }],
      ['a free re-service callback', { is_callback: true }],
      ['booked from a one-time source', { source: 'estimate-accept' }],
      ['dated before today and not started', { scheduled_date: day(-1) }],
      ['cancelled', { status: 'cancelled' }],
      ['completed', { status: 'completed', scheduled_date: day(-1) }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blockerFor((customer) => seedFlaggedVisit(customer, change))).toBeNull();
    });
  });

  // The status column takes a NULL (its default is 'pending'). The calendar read drops the visits that are over
  // with NOT IN, and in SQL a NULL fails NOT IN: that read never returns a visit with no status. So the proof
  // reads this shape itself, and the row rule reads no status as open.
  describe('a visit that carries the recurring flag and no status', () => {
    test('the fixture: a visit can be saved with no status', async () => {
      const visit = await seedFlaggedVisit(await seedCustomer(), { status: null });
      expect(visit.status).toBeNull();
    });

    test.each([
      ['dated after today', {}],
      ['dated today', { scheduled_date: day(0) }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedFlaggedVisit(customer, { status: null, ...change }))).toBe('has_plan');
    });

    test.each([
      ['dated before today', { scheduled_date: day(-1) }],
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['booked from a one-time source', { source: 'estimate-accept' }],
    ])('%s is not a live plan visit', async (_label, change) => {
      expect(await blockerFor((customer) => seedFlaggedVisit(customer, { status: null, ...change }))).toBeNull();
    });

    test('a one-time visit with no status, still to come, is not a plan visit', async () => {
      expect(await blockerFor((customer) => seedVisit(customer, { status: null, scheduled_date: day(10) }))).toBeNull();
    });

    test("another customer's visit with no status does not count", async () => {
      await seedFlaggedVisit(await seedCustomer(), { status: null });
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  describe('a legacy plan visit (no recurring flag, a recurring parent)', () => {
    test('the fixture alone is not a plan: a completed root with a cancelled child', async () => {
      expect(await blockerFor((customer) => seedLegacyVisit(customer, { status: 'cancelled' }))).toBeNull();
    });

    test.each([
      ['dated after today', {}],
      ['dated today', { scheduled_date: day(0) }],
      ['still pending', { status: 'pending' }],
      // A NULL status: a status filter with NOT IN would lose this visit.
      ['saved with no status', { status: null }],
      ['in progress now, with a date before today', { status: 'on_site', scheduled_date: day(-1) }],
      ['on the way now, with a date before today', { status: 'en_route', scheduled_date: day(-1) }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedLegacyVisit(customer, change))).toBe('has_plan');
    });

    test.each([
      ['a free re-service callback', { is_callback: true }],
      ['an included follow-up', { followup_included: true }],
      ['dated before today and not started', { scheduled_date: day(-1) }],
      ['completed', { status: 'completed' }],
      ['skipped', { status: 'skipped' }],
      ['a no-show', { status: 'no_show' }],
      ['rescheduled away', { status: 'rescheduled' }],
      // An explicit booster rides a recurring root and is not a plan visit (isPlanSeriesRow).
      ['flagged not recurring (a booster)', { is_recurring: false }],
      ['booked from a one-time source', { source: 'estimate-accept' }],
      ['a one-time booking in progress now', { source: 'quote-wizard-onetime', status: 'on_site', scheduled_date: day(-1) }],
      ['a callback on the way now', { is_callback: true, status: 'en_route', scheduled_date: day(-1) }],
    ])('a child visit that is %s is not a live plan visit', async (_label, change) => {
      expect(await blockerFor((customer) => seedLegacyVisit(customer, change))).toBeNull();
    });

    test('a visit with no recurring flag and no recurring parent is not a plan visit', async () => {
      expect(await blockerFor((customer) => trx('scheduled_services').insert({
        customer_id: customer.id, scheduled_date: day(10), service_type: 'One-Time Pest Control', status: 'confirmed', is_recurring: null,
      }))).toBeNull();
    });

    test("another customer's legacy plan visit does not count", async () => {
      await seedLegacyVisit(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // An ongoing series BETWEEN visits: no live visit for the two calendar reads to find, and no tier, rate or
  // prepay on the account. The root alone says the plan goes on.
  describe('an ongoing recurring series with no visit on the calendar', () => {
    test.each([
      ['whose last visit is completed', {}],
      // Fail closed: a root that still says "ongoing" is a plan record whatever its own visit's status. Four
      // such roots of fully cancelled series were live on 2026-11-20 (the flag was never cleared).
      ['whose own visit was cancelled', { status: 'cancelled' }],
    ])('a series %s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedSeriesRoot(customer, change))).toBe('has_plan');
    });

    test.each([
      ['a completed finite series (never ongoing)', { recurring_ongoing: false }],
      ['a series that a cancel ended (the flag is cleared)', { recurring_ongoing: false, status: 'cancelled' }],
      ['a series saved with no ongoing flag (NULL)', { recurring_ongoing: null }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await blockerFor((customer) => seedSeriesRoot(customer, change))).toBeNull();
    });

    test("another customer's ongoing series does not count", async () => {
      await seedSeriesRoot(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });

    test('the rows are the ones the nightly top-up would extend (its own selector)', async () => {
      const customer = await seedCustomer();
      const root = await seedSeriesRoot(customer);
      await seedSeriesRoot(customer, { recurring_ongoing: false });
      const { eligibleSeriesParentIds } = require('../services/recurring-series-topup');
      expect(await eligibleSeriesParentIds(trx, { customerId: customer.id })).toEqual([root.id]);
    });
  });

  describe('a billed plan rate (the plan-rate ledger)', () => {
    const rate = (customer, change = {}) => trx('customer_plan_rates').insert({
      customer_id: customer.id, family_key: 'lawn_care', monthly_rate: 55, source: 'estimate_accept', ...change,
    });

    test.each([
      ['of a named family', {}],
      ['the ledger could not name', { family_key: 'unattributed' }],
    ])('a rate %s, with no visit on the calendar: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => rate(customer, change))).toBe('has_plan');
    });

    test('a rate of zero is not a plan record', async () => {
      expect(await blockerFor((customer) => rate(customer, { monthly_rate: 0 }))).toBeNull();
    });

    test("another customer's rate does not count", async () => {
      await rate(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // A hold pauses a lawn, mosquito or tree and shrub plan (cancellation-resolution/holds.js). It sets the family's
  // ledger component and the account's monthly rate to 0 until the return date and skips the visits inside the
  // pause. So on some days the hold is the only record that says the plan goes on.
  describe('a plan hold', () => {
    const hold = (customer, change = {}) => trx('plan_holds').insert({
      customer_id: customer.id, family_key: 'lawn_care', starts_on: day(-5), resume_on: day(40), held_monthly_rate: 55, status: 'active', ...change,
    });

    test('an active hold, as the hold flow leaves the account (the ledger component at 0, no rate on the account): has_plan', async () => {
      expect(await blockerFor(async (customer) => {
        await trx('customer_plan_rates').insert({ customer_id: customer.id, family_key: 'lawn_care', monthly_rate: 0, source: 'plan_hold' });
        await hold(customer);
      })).toBe('has_plan');
    });

    test('an active hold whose return date has passed (not resumed yet): has_plan', async () => {
      expect(await blockerFor((customer) => hold(customer, { starts_on: day(-60), resume_on: day(-1) }))).toBe('has_plan');
    });

    // The three statuses the table's check constraint takes: active, resumed, cancelled.
    test.each([['resumed'], ['cancelled']])('a %s hold is over, and is not a plan record', async (status) => {
      expect(await blockerFor((customer) => hold(customer, { status }))).toBeNull();
    });

    test("another customer's hold does not count", async () => {
      await hold(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // The two annual prepay reads are the lifecycle guard's own (findActivePrepayTerm, findPendingPrepayInvoice).
  // Their rules have their own suites. Here: the proof calls each on the caller's connection, for this customer.
  describe('an annual prepay', () => {
    test.each([
      ['an active term that covers today', {}],
      ['a term waiting for payment whose invoice is still payable', { status: 'payment_pending', invoiceStatus: 'sent' }],
    ])('%s: has_plan', async (_label, change) => {
      expect(await blockerFor((customer) => seedPrepayTerm(customer, change))).toBe('has_plan');
    });

    test.each([
      ['an active term that ended', { term_start: day(-400), term_end: day(-35) }],
      ['a term waiting for payment whose invoice was voided', { status: 'payment_pending', invoiceStatus: 'void' }],
    ])('%s is not a plan record', async (_label, change) => {
      expect(await blockerFor((customer) => seedPrepayTerm(customer, change))).toBeNull();
    });

    test("another customer's term does not count", async () => {
      await seedPrepayTerm(await seedCustomer());
      expect(await planStartBlocker(trx, (await seedCustomer()).id)).toBeNull();
    });
  });

  // The proof asks each table for the rows of ONE account, once for each account a caller asks about. So the
  // column each read filters by leads a whole index (one with no WHERE of its own), and no read scans a
  // table. Two of the indexes are the proof's own (migration 20261120200000): the table of day-agreement
  // decisions had none on its customer, and the table of add-ons had none on its visit.
  describe('the index behind each read', () => {
    const leadsAnIndex = async (table, column) => (await trx.raw(
      `select 1 from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
        where c.relnamespace = (select oid from pg_namespace where nspname = current_schema())
          and c.relname = ? and a.attname = ? and i.indpred is null and i.indisvalid`,
      [table, column],
    )).rows.length > 0;

    test.each([
      ['customer_properties', 'customer_id'], ['estimates', 'customer_id'], ['leads', 'customer_id'],
      ['scheduled_services', 'customer_id'], ['scheduled_service_addons', 'scheduled_service_id'],
      ['service_records', 'customer_id'], ['customer_contracts', 'customer_id'], ['call_log', 'customer_id'],
      ['day_agreement_decisions', 'customer_id'], ['plan_holds', 'customer_id'], ['customer_plan_rates', 'customer_id'],
      ['annual_prepay_terms', 'customer_id'],
    ])('%s has a whole index that starts with %s', async (table, column) => {
      expect(await leadsAnIndex(table, column)).toBe(true);
    });

    test('the check itself tells an indexed column from one with no index', async () => {
      expect(await leadsAnIndex('day_agreement_decisions', 'customer_id')).toBe(true);
      expect(await leadsAnIndex('day_agreement_decisions', 'verdict')).toBe(false);
    });

    // The migration itself, on tables of its own in a schema of its own. All of it is inside this test's
    // transaction, so nothing stays. Up makes both indexes and can run twice; down removes both and can run
    // twice; a schema with neither table is left alone.
    test('the index migration goes up and down, and each direction can run twice', async () => {
      const migration = require('../models/migrations/20261120200000_plan_start_proof_lookup_indexes');
      const schema = `plan_start_idx_${hex(8)}`;
      await trx.raw('CREATE SCHEMA ??', [schema]);
      await trx.raw('SET LOCAL search_path TO ??', [schema]);
      const indexes = async () => (await trx.raw(
        "select indexname from pg_indexes where schemaname = ? and indexname not like '%_pkey' order by indexname", [schema],
      )).rows.map((row) => row.indexname);
      await migration.up(trx);
      expect(await indexes()).toEqual([]);
      await trx.schema.createTable('day_agreement_decisions', (table) => { table.uuid('id').primary(); table.uuid('customer_id'); });
      await trx.schema.createTable('scheduled_service_addons', (table) => { table.uuid('id').primary(); table.uuid('scheduled_service_id'); });
      await migration.up(trx);
      await migration.up(trx);
      expect(await indexes()).toEqual(['day_agreement_decisions_customer_id_index', 'scheduled_service_addons_scheduled_service_id_index']);
      expect(await leadsAnIndex('day_agreement_decisions', 'customer_id')).toBe(true);
      expect(await leadsAnIndex('scheduled_service_addons', 'scheduled_service_id')).toBe(true);
      await migration.down(trx);
      await migration.down(trx);
      expect(await indexes()).toEqual([]);
    });
  });
});
