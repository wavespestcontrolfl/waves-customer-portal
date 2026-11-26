/**
 * The visit history behind the returning-customer setup fee rule (services/returning-setup-fee-waiver.js
 * loadReturningVisitHistory), against real Postgres. Real Postgres, because the parts that can be wrong are SQL:
 * the newest-closeout subselects (outcome, performed day, frozen identity), a frozen JSON null key that must read
 * as "frozen, no catalog service" and not as "nothing frozen", and the jsonb add-on list. The decision made on
 * this history is unit-tested in returning-setup-fee-waiver.test.js.
 * Runs in CI's DB-gated step or this worktree's private QA database; every test runs in one transaction that is
 * rolled back, so no row stays. Synthetic rows only.
 */
jest.setTimeout(60000);

// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  // A writer's own transaction is a savepoint of the test's transaction, so its rows roll back with the test.
  db.transaction = (...args) => db.connection.transaction(...args);
  return db;
});

const { randomUUID } = require('crypto');

postgres('returning customer setup fee: the visit history (real Postgres)', () => {
  const db = require('../models/db');
  const { loadReturningVisitHistory, frozenPlanSeriesForCompletion } = require('../services/returning-setup-fee-waiver');
  const { frozenAddonLinesForCompletion } = require('../services/service-report/trace-eligibility');
  let database;
  const NOW = new Date('2026-11-24T17:00:00Z');

  async function customer() {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Synthetic', last_name: 'Fixture', phone: `fixture-${id.slice(0, 8)}` });
    return id;
  }
  // One catalog service made in this test's transaction. The name carries the plan family, as catalog names do.
  async function catalogService(name, billingType = 'recurring') {
    const service = { id: randomUUID(), service_key: `fixture_${randomUUID().replaceAll('-', '').slice(0, 20)}`, name, billing_type: billingType };
    await db('services').insert(service);
    return service;
  }
  // A completed recurring visit as the schedule holds it NOW (the row and its lines can be edited after the visit).
  async function visit(customerId, over = {}) {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: '2026-08-18', service_type: 'Pest Control Service', status: 'completed',
      is_recurring: true, recurring_pattern: 'quarterly', ...over,
    });
    return id;
  }
  // A closeout of a visit: what the completion froze goes in service_data.
  const closeout = (customerId, visitId, serviceData, over = {}) => db('service_records').insert({
    id: randomUUID(), customer_id: customerId, scheduled_service_id: visitId, service_date: '2026-08-21',
    service_type: 'Fixture closeout', status: 'completed', service_data: JSON.stringify(serviceData), ...over,
  });
  const scheduleLine = (visitId, service, over = {}) => db('scheduled_service_addons').insert({
    scheduled_service_id: visitId, service_id: service.id, service_name: service.name, ...over,
  });
  const history = async (customerId) => (await loadReturningVisitHistory(db, { customerId, now: NOW })).lastByFamily;

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId)
      && target.pathname === `/waves_qa_${worktreeId}`;
    if (!ci && !ownedQA) throw new Error('Use the isolated CI database or this worktree\'s private QA database');
    // The driver copies every query parameter of a connection string into its
    // settings, so the pool gets the parts checked above, never the URL text.
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
  });

  beforeEach(async () => {
    process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
    db.connection = await database.transaction();
  });
  afterEach(async () => {
    delete process.env.GATE_RETURNING_SETUP_FEE_GAP;
    await db.connection?.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  test('a completed visit is read by the service its closeout froze, on the day the closeout names, not by the schedule row of today', async () => {
    const pest = await catalogService('Quarterly Pest Control');
    const lawn = await catalogService('Monthly Lawn Care');
    // Completed as pest, the schedule row pointed at lawn afterwards: still a pest visit, of the closeout's day.
    const wasPest = await customer();
    await closeout(wasPest, await visit(wasPest, { service_id: lawn.id, service_type: 'Lawn Care' }),
      { completedServiceKey: pest.service_key, completedServiceName: 'Pest Control Service', completedAddonLines: [] });
    expect(await history(wasPest)).toEqual({ pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } });
    // Completed as lawn, pointed at pest afterwards: never pest evidence.
    const wasLawn = await customer();
    await closeout(wasLawn, await visit(wasLawn, { service_id: pest.id }),
      { completedServiceKey: lawn.service_key, completedServiceName: 'Lawn Care', completedAddonLines: [] });
    expect(Object.keys(await history(wasLawn))).toEqual(['lawn_care']);
    // The frozen key brings its own catalog facts: a one-time catalog service is one application, not a plan.
    const oneTime = await catalogService('One-Time Pest Control', 'one_time');
    const wasOneTime = await customer();
    await closeout(wasOneTime, await visit(wasOneTime, { service_id: pest.id }),
      { completedServiceKey: oneTime.service_key, completedServiceName: 'Pest Control Service', completedAddonLines: [] });
    expect(await history(wasOneTime)).toEqual({});
  });

  test('a frozen null key is a frozen visit with no catalog service (its label decides); a closeout that froze no service reads the schedule row', async () => {
    const lawn = await catalogService('Monthly Lawn Care');
    const labelOnly = await customer();
    await closeout(labelOnly, await visit(labelOnly, { service_id: lawn.id, service_type: 'Lawn Care' }),
      { completedServiceKey: null, completedServiceName: 'Pest Control Service' });
    expect(Object.keys(await history(labelOnly))).toEqual(['pest_control']);
    const older = await customer();
    await closeout(older, await visit(older, { service_id: lawn.id, service_type: 'Lawn Care' }), {});
    expect(Object.keys(await history(older))).toEqual(['lawn_care']);
    // No closeout at all: the schedule row and its scheduled day.
    const bare = await customer();
    await visit(bare);
    expect(await history(bare)).toEqual({ pest_control: { lastVisitKey: '2026-08-18', cycleDays: 91 } });
  });

  test('the newest closeout of a visit decides its outcome, its day and its frozen service', async () => {
    const pest = await catalogService('Quarterly Pest Control');
    const frozenPest = { completedServiceKey: pest.service_key, completedServiceName: 'Pest Control Service', completedAddonLines: [] };
    // Performed, then reopened and closed as declined: no application.
    const declined = await customer();
    const declinedVisit = await visit(declined);
    await closeout(declined, declinedVisit, frozenPest, { created_at: '2026-08-21T15:00:00Z' });
    await closeout(declined, declinedVisit, frozenPest, { created_at: '2026-08-22T15:00:00Z', structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }) });
    expect(await history(declined)).toEqual({});
    // Declined, then performed three days later: an application on the later closeout's day, of the service that
    // closeout froze (the schedule row was pointed at lawn afterwards).
    const lawn = await catalogService('Monthly Lawn Care');
    const performed = await customer();
    const performedVisit = await visit(performed, { service_id: lawn.id, service_type: 'Lawn Care' });
    await closeout(performed, performedVisit, {}, { created_at: '2026-08-21T15:00:00Z', structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }) });
    await closeout(performed, performedVisit, frozenPest, { created_at: '2026-08-24T15:00:00Z', service_date: '2026-08-24' });
    expect(await history(performed)).toEqual({ pest_control: { lastVisitKey: '2026-08-24', cycleDays: 91 } });
  });

  test('the plan series of a completed visit is the one its closeout froze: a later frequency change never moves the window', async () => {
    // What a completion freezes, read by the completion's own query in its transaction.
    const freeze = async (visitId) => (await frozenPlanSeriesForCompletion(visitId, db.connection)).series;
    // The first visit of a quarterly series completes; the series is changed to monthly afterwards.
    const changed = await customer();
    const root = await visit(changed);
    await closeout(changed, root, { completedSeries: await freeze(root) });
    await db('scheduled_services').where({ id: root }).update({ recurring_pattern: 'monthly' });
    expect(await history(changed)).toEqual({ pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } });
    // A closeout from before the freeze reads the schedule row of today.
    const legacy = await customer();
    await closeout(legacy, await visit(legacy, { recurring_pattern: 'monthly' }), {});
    expect(await history(legacy)).toEqual({ pest_control: { lastVisitKey: '2026-08-21', cycleDays: 30 } });
    // A child with no pattern of its own froze its parent series' cadence; the parent changes afterwards.
    const inherits = await customer();
    const parent = await visit(inherits, { scheduled_date: '2026-05-18' });
    const child = await visit(inherits, { recurring_parent_id: parent, is_recurring: null, recurring_pattern: null });
    await closeout(inherits, child, { completedSeries: await freeze(child) });
    await db('scheduled_services').where({ id: parent }).update({ recurring_pattern: 'monthly' });
    expect(await history(inherits)).toEqual({ pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } });
    // Completed as a one-time visit, linked to a series afterwards: never a plan application.
    const oneTime = await customer();
    const single = await visit(oneTime, { is_recurring: false, recurring_pattern: null });
    await closeout(oneTime, single, { completedSeries: await freeze(single) });
    await db('scheduled_services').where({ id: single }).update({ is_recurring: true, recurring_pattern: 'quarterly' });
    expect(await history(oneTime)).toEqual({});
    // An add-on line that rode the visit takes the frozen cycle, from the frozen list or from the schedule line.
    const lawn = await catalogService('Monthly Lawn Care');
    const mosquito = await catalogService('Mosquito Control');
    for (const lines of [[{ serviceId: mosquito.id, serviceName: 'Mosquito Control', recurrence: { pattern: null } }], undefined]) {
      const rides = await customer();
      const lawnVisit = await visit(rides, { service_id: lawn.id, service_type: 'Lawn Care' });
      await closeout(rides, lawnVisit, { completedSeries: await freeze(lawnVisit), ...(lines ? { completedAddonLines: lines } : {}) });
      await scheduleLine(lawnVisit, mosquito);
      await db('scheduled_services').where({ id: lawnVisit }).update({ recurring_pattern: 'monthly' });
      expect((await history(rides)).mosquito).toEqual({ lastVisitKey: '2026-08-21', cycleDays: 91 });
    }
  });

  test('an add-on line typed with no catalog service, on a visit performed a month after its slot: read by its name, at its slot\'s cycle', async () => {
    const lawn = await catalogService('Monthly Lawn Care');
    const account = await customer();
    // A monthly lawn visit moved from its Sep 15 slot to Oct 14, with a seasonal mosquito line typed by the office.
    const moved = await visit(account, {
      service_id: lawn.id, service_type: 'Lawn Care', recurring_pattern: 'monthly',
      scheduled_date: '2026-10-14', date_exception: true, date_exception_cadence_date: '2026-09-15',
    });
    await db('scheduled_service_addons').insert({ scheduled_service_id: moved, service_name: 'Mosquito Control', recurring_pattern: 'seasonal_feb_oct' });
    // The completion's two freezers, on its own connection.
    const frozen = await frozenPlanSeriesForCompletion(moved, db.connection, await frozenAddonLinesForCompletion(moved, db.connection));
    expect(frozen.addonLines).toEqual([expect.objectContaining({
      serviceId: null, serviceName: 'Mosquito Control', recurrence: expect.objectContaining({ pattern: 'seasonal_feb_oct', cycleDays: 35 }),
    })]);
    await closeout(account, moved, { completedSeries: frozen.series, completedAddonLines: frozen.addonLines }, { service_date: '2026-10-14' });
    // The schedule is edited afterwards: the line is removed and the visit loses its slot.
    await db('scheduled_service_addons').where({ scheduled_service_id: moved }).del();
    await db('scheduled_services').where({ id: moved }).update({ date_exception: false, date_exception_cadence_date: null });
    // September to October (35 days), never October to February.
    expect((await history(account)).mosquito).toEqual({ lastVisitKey: '2026-10-14', cycleDays: 35 });
  });

  // The call and text drafter stores its own row (estimator-engine createDraftEstimate), and that row goes out
  // with one click and no staff save. The rule's answer has to be on it in the shape the readers already read.
  test('a call draft decided inside the window is stored with the waiver: the page maps no fee and the accept bills none', async () => {
    const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const Returning = require('../services/returning-setup-fee-waiver');
    const { createDraftEstimate, deriveTotals } = require('../services/estimator-engine/draft-builder');
    const { setupFeeApplies } = require('../services/estimate-accept-effects');
    const pest = await catalogService('Quarterly Pest Control');
    const engineInput = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family', services: { pest: { frequency: 'quarterly' } } };
    // One draft for one caller, as the pipeline makes it: price, decide on the linked customer's visits, insert.
    const draftFor = async (customerId, phone) => {
      const engineResult = generateEstimate(engineInput);
      const visits = await loadReturningVisitHistory(db, { customerId, now: NOW });
      const { waiver } = Returning.mapWithReturningWaiver(engineResult, mapV1ToLegacyShape, { history: visits });
      const draft = await createDraftEstimate({
        intent: {
          address: `${phone.slice(-4)} Example St, Testville, FL 34200`, customer_name: 'Synthetic Fixture', customer_phone: phone,
          category: 'RESIDENTIAL', services: { pest: { frequency: 'quarterly' } }, service_interest_label: 'Pest Control',
          evidence: [], constraint_flags: [], confidence: 'high',
        },
        engineInput, engineResult, totals: deriveTotals(engineResult), lane: 'green', laneReasons: [], propertyFacts: {},
        comps: null, calibration: [], model: 'fixture', call: null,
        context: { phone, customer: { id: customerId }, customerPhoneAmbiguous: false },
        returningSetupFeeWaiver: waiver,
      });
      const row = await db('estimates').where({ id: draft.estimate.id }).first('customer_id', 'source', 'estimate_data');
      return { waiver, row, data: typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data };
    };
    // Back 54 days after a quarterly pest visit (Oct 1 to Nov 24): inside 91 + 30.
    const returning = await customer();
    await closeout(returning, await visit(returning, { service_id: pest.id, scheduled_date: '2026-10-01' }),
      { completedServiceKey: pest.service_key, completedServiceName: 'Pest Control Service', completedAddonLines: [] }, { service_date: '2026-10-01' });
    const waived = await draftFor(returning, '+19415550101');
    expect(waived.waiver).toEqual(expect.objectContaining({ rule: 'returning_customer_gap', family: 'pest_control', gapDays: 54, windowDays: 121 }));
    expect(waived.row).toEqual(expect.objectContaining({ customer_id: returning, source: 'estimator_engine' }));
    // Stored as a staff save stores it, so a later save or service change finds and re-decides it.
    expect(Returning.returningSetupFeeWaiverOf(waived.data)).toEqual(waived.waiver);
    expect(waived.data.operatorPriceAdjustment.waiveSetupFee).toBe(true);
    // The page maps the stored engine result; the accept reads the stored waiver (its own reader).
    expect(mapV1ToLegacyShape(waived.data.engineResult).oneTime.membershipFee).toBe(0);
    expect(setupFeeApplies(waived.data, 'monthly')).toBe(false);
    expect(waived.data.estimatorEngine.reviewNotes).toContain('Setup fee: waived, returning customer (last plan visit 2026-10-01, 54 days ago; window 121 days).');
    // The same caller with no plan visit on file: the fee is on the page and on the bill.
    const fresh = await draftFor(await customer(), '+19415550102');
    expect(fresh.waiver).toBeNull();
    expect(fresh.data.operatorPriceAdjustment).toBeUndefined();
    expect(mapV1ToLegacyShape(fresh.data.engineResult).oneTime.membershipFee).toBeGreaterThan(0);
    expect(setupFeeApplies(fresh.data, 'monthly')).toBe(true);
  });

  test('an account with an active plan is never under the rule; the cancelled account is', async () => {
    const account = await customer();
    await visit(account);
    await db('customers').where({ id: account }).update({ waveguard_tier: 'Silver', monthly_rate: 45 });
    expect(await loadReturningVisitHistory(db, { customerId: account, now: NOW })).toBeNull();
    // What a cancellation writes (customer-offboarding.js): tier and rate cleared.
    await db('customers').where({ id: account }).update({ waveguard_tier: null, monthly_rate: null });
    expect(await history(account)).toEqual({ pest_control: { lastVisitKey: '2026-08-18', cycleDays: 91 } });
  });

  test('add-on lines come from the list the closeout froze, with the cadence it froze; an older closeout takes the schedule line\'s', async () => {
    const lawn = await catalogService('Monthly Lawn Care');
    const mosquito = await catalogService('Mosquito Control');
    const lawnVisit = (customerId) => visit(customerId, { service_id: lawn.id, service_type: 'Lawn Care', recurring_pattern: 'quarterly' });
    const frozenWith = (lines) => ({ completedServiceKey: lawn.service_key, completedServiceName: 'Lawn Care', completedAddonLines: lines });
    const line = (over = {}) => ({ serviceId: mosquito.id, serviceName: 'Mosquito Control', serviceKey: mosquito.service_key, ...over });
    const mosquitoOf = async (customerId) => (await history(customerId)).mosquito;

    // A frozen plan line counts after its schedule line was removed: its own cadence, or the visit's when it had none.
    const removed = await customer();
    await closeout(removed, await lawnVisit(removed), frozenWith([line({ recurrence: { pattern: 'monthly', intervalDays: null, nth: null, weekday: null } })]));
    expect(await mosquitoOf(removed)).toEqual({ lastVisitKey: '2026-08-21', cycleDays: 30 });
    const rides = await customer();
    await closeout(rides, await lawnVisit(rides), frozenWith([{ serviceId: mosquito.id, serviceName: 'Typed by the office', recurrence: { pattern: null } }]));
    expect(await mosquitoOf(rides)).toEqual({ lastVisitKey: '2026-08-21', cycleDays: 91 });

    // A frozen one_time line is one application, also when its schedule line now carries a plan cadence.
    const oneTime = await customer();
    const oneTimeVisit = await lawnVisit(oneTime);
    await closeout(oneTime, oneTimeVisit, frozenWith([line({ recurrence: { pattern: 'one_time' } })]));
    await scheduleLine(oneTimeVisit, mosquito, { recurring_pattern: 'monthly' });
    expect(await mosquitoOf(oneTime)).toBeUndefined();

    // A schedule line added after the visit is not in the frozen list.
    const added = await customer();
    const addedVisit = await lawnVisit(added);
    await closeout(added, addedVisit, frozenWith([]));
    await scheduleLine(addedVisit, mosquito, { recurring_pattern: 'monthly' });
    expect(await mosquitoOf(added)).toBeUndefined();

    // An older closeout froze no cadence: the schedule line of the same service gives it; with no such line, no evidence.
    const older = await customer();
    const olderVisit = await lawnVisit(older);
    await closeout(older, olderVisit, frozenWith([line()]));
    expect(await mosquitoOf(older)).toBeUndefined();
    await scheduleLine(olderVisit, mosquito, { recurring_pattern: 'monthly' });
    expect(await mosquitoOf(older)).toEqual({ lastVisitKey: '2026-08-21', cycleDays: 30 });

    // A closeout from before the frozen list reads the schedule lines; an explicit one_time line never counts.
    const legacy = await customer();
    const legacyVisit = await lawnVisit(legacy);
    await closeout(legacy, legacyVisit, {});
    await scheduleLine(legacyVisit, mosquito, { recurring_pattern: 'one_time' });
    expect(await mosquitoOf(legacy)).toBeUndefined();
    await scheduleLine(legacyVisit, mosquito, { recurring_pattern: 'monthly' });
    expect(await mosquitoOf(legacy)).toEqual({ lastVisitKey: '2026-08-21', cycleDays: 30 });

    // A list that is not a list, and entries that are not lines, change nothing and never fail the read.
    const junk = await customer();
    await closeout(junk, await lawnVisit(junk), frozenWith(['text', 7, null, { serviceId: 'not-a-catalog-id', serviceName: 'Mosquito Control' }]));
    expect(Object.keys(await history(junk))).toEqual(['lawn_care']);
    const notAList = await customer();
    await closeout(notAList, await lawnVisit(notAList), frozenWith('none'));
    expect(Object.keys(await history(notAList))).toEqual(['lawn_care']);
  });
});
