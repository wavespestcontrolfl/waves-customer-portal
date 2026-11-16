// One-tap purchase end to end on real migrated PostgreSQL. The offer core,
// the pricing engine, the slot reservation and the estimate converter all run
// for real; only the slot LIST, the card lookup and the outbound sends (email,
// notifications, reminders, Auto Pay enrollment) are stubbed. Synthetic
// records, rolled back after every test. Runs in the DB-gated CI step.
//
// The unit suite (one-tap-purchase.test.js) mocks the converter, so it cannot
// see what a purchase BOOKS. This suite is the proof of two promises:
//   1. A purchase is a series. Lawn care booked ONE visit until 2026-11-12:
//      the engine's lawn line names its visit count only as a numeric
//      `frequency`, and the converter seeds a lawn series from an explicit
//      count alone.
//   2. The price of a current service the customer was shown is the price
//      the converter writes on its upcoming visits.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(120000);

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The picker's list is discovery over live routes. The test hands back one
// signed opening and lets reserve and commit judge it for real.
let mockSlots = { primary: [], expander: [], nearby: false };
jest.mock('../services/estimate-slot-availability', () => ({
  ...jest.requireActual('../services/estimate-slot-availability'),
  getAvailableSlots: jest.fn(async () => mockSlots),
  resolveEstimateCoords: async () => require('../services/route-optimizer').HQ,
}));
jest.mock('../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyTechVisitChange: async () => {}, notifyAssignmentChange: async () => {},
}));
let mockCardId = null;
jest.mock('../services/payment-method-consents', () => ({
  ...jest.requireActual('../services/payment-method-consents'),
  findConsentedChargeableCard: jest.fn(async () => (mockCardId ? { id: mockCardId } : null)),
}));
// Nothing may reach a customer or the office from a test. Each module keeps
// its real exports (the booking code reads classifiers and helpers off them);
// only the sending entry points are replaced.
function mockSending(path, names, result = {}) {
  const actual = jest.requireActual(path);
  for (const name of names) actual[name] = jest.fn(async () => result);
  return actual;
}
jest.mock('../services/notification-service', () => mockSending('../services/notification-service', ['notifyAdmin', 'notifyCustomer']));
jest.mock('../services/notification-triggers', () => mockSending('../services/notification-triggers', ['triggerNotification']));
jest.mock('../services/estimate-accepted-email', () => mockSending('../services/estimate-accepted-email', ['sendEstimateAcceptedOnboarding']));
jest.mock('../services/account-membership-email', () => mockSending('../services/account-membership-email', ['sendMembershipStarted']));
jest.mock('../services/appointment-reminders', () => mockSending('../services/appointment-reminders', ['registerAppointment']));
jest.mock('../services/appointment-tagger', () => mockSending('../services/appointment-tagger', ['onServiceScheduled']));
jest.mock('../services/autopay-enrollment', () => mockSending('../services/autopay-enrollment', ['enrollConsentedMethod'], { enrolled: true }));
jest.mock('../services/messaging/send-customer-message', () => mockSending('../services/messaging/send-customer-message', ['sendCustomerMessage']));

const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { signSlotOffer, appendOfferToSlotId } = require('../utils/slot-offer-token');
const { gates } = require('../config/feature-gates');
const { PURCHASE_FAMILIES } = require('../services/service-report/cross-sell');
const oneTap = require('../services/one-tap-purchase');

postgres('one-tap purchase against migrated PostgreSQL', () => {
  let database;
  let trx;
  const ids = {};
  const HQ = require('../services/route-optimizer').HQ;
  const day = (n) => etDateString(addETDays(new Date(), n));
  // The first Monday-to-Friday date n or more days out. The migrated database
  // takes Saturday and Sunday off (schedule_weekly_days_off = [0, 6]), and the
  // reserve step refuses a closed day: with a plain day(14) every purchase in
  // this suite failed on each Saturday and Sunday ("That time was just taken").
  const openDay = (n) => {
    let at = addETDays(new Date(), n);
    while ([0, 6].includes(etParts(at).dayOfWeek)) at = addETDays(at, 1);
    return etDateString(at);
  };
  const money = (rows) => rows.map((row) => Number(row.estimated_price));

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  // A WaveGuard Bronze member billed per application, with a card on file.
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    gates.waveguardExtendExisting = true;
    Object.assign(ids, { customer: randomUUID(), technician: randomUUID(), ownedEstimates: [], card: randomUUID() });
    mockCardId = ids.card;
    await trx('technicians').insert({ id: ids.technician, name: 'Fixture technician', role: 'technician',
      active: true, employment_status: 'active', field_dispatchable: true });
    await trx('customers').insert({ id: ids.customer, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${ids.customer}@example.invalid`, phone: `fx-${ids.customer.slice(0, 12)}`,
      address_line1: '100 Test Lane', city: 'Bradenton', state: 'FL', zip: '34205',
      latitude: HQ.lat, longitude: HQ.lng,
      active: true, pipeline_stage: 'active_customer', billing_mode: 'per_application',
      waveguard_tier: 'Bronze' });
    await trx('payment_methods').insert({ id: ids.card, customer_id: ids.customer });
  });

  afterEach(async () => {
    gates.waveguardExtendExisting = false;
    if (trx) await trx.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  // A recurring service the member already has: the accepted estimate that
  // sold it (its saved inputs are the property evidence the offer prices the
  // next service from) and two upcoming visits at $119.
  const OWNED = {
    pest_control: { catalogKey: 'pest_general_quarterly', label: 'Quarterly Pest Control Service', pattern: 'quarterly',
      gapDays: 91, line: { service: 'pest_control', name: 'Pest Control', frequency: 'quarterly', visitsPerYear: 4 } },
    lawn_care: { catalogKey: 'lawn_care_6week', label: 'Every 6 Weeks Lawn Care Service', pattern: 'every_6_weeks',
      gapDays: 42, line: { service: 'lawn_care', name: 'Lawn Care', frequency: 'every_6_weeks', visitsPerYear: 9 } },
  };
  async function seedOwnedService(owned) {
    const plan = OWNED[owned];
    const estimateId = randomUUID();
    ids.ownedEstimates.push(estimateId);
    await trx('estimates').insert({ id: estimateId, customer_id: ids.customer, status: 'accepted',
      accepted_at: new Date(), address: '100 Test Lane, Bradenton, FL 34205',
      monthly_total: 39.67, annual_total: 476,
      estimate_data: { engineInputs: {
        homeSqFt: 2200, lotSqFt: 9800, lawnSqFt: 4800, bedArea: 650, stories: 1,
        storiesSource: 'lookup', propertyType: 'single_family',
      }, result: { recurring: { services: [plan.line] } } } });
    const catalog = await trx('services').where({ service_key: plan.catalogKey }).first('id');
    const parent = randomUUID();
    const visit = (id, daysOut, extra) => ({ id, customer_id: ids.customer, technician_id: ids.technician,
      service_id: catalog.id, service_type: plan.label, scheduled_date: day(daysOut), window_start: '09:00',
      window_end: '10:00', is_recurring: true, recurring_pattern: plan.pattern, estimated_price: 119,
      source_estimate_id: estimateId, ...extra });
    await trx('scheduled_services').insert([
      visit(parent, 20, { status: 'confirmed' }),
      visit(randomUUID(), 20 + plan.gapDays, { status: 'pending', recurring_parent_id: parent }),
    ]);
  }
  const ownedVisits = () => trx('scheduled_services').whereIn('source_estimate_id', ids.ownedEstimates);

  // One signed opening for the purchase's draft estimate, minted the way the
  // slot generator mints it (profile-resolved duration, estimate-scoped).
  async function offerOpening(estimateId) {
    const availability = jest.requireActual('../services/estimate-slot-availability');
    const estimate = await trx('estimates').where({ id: estimateId }).first();
    const profile = await availability.resolveCatalogSlotProfile(estimate, { serviceMode: 'recurring' }, trx);
    const date = openDay(14);
    const slotId = appendOfferToSlotId(`${date}_10-00_${ids.technician}`,
      signSlotOffer({ surface: 'estimate', scopeId: estimateId, date, startMinutes: 600,
        technicianId: ids.technician, durationMinutes: profile.durationMinutes }));
    mockSlots = { primary: [{ slotId, date, windowStart: '10:00', windowEnd: '12:00', techFirstName: 'Fixture' }],
      expander: [], nearby: false };
    return slotId;
  }

  // The whole flow a customer walks: tap a service in the My Plan list, pick
  // a time, confirm.
  async function buy(serviceKey) {
    const { offers } = await oneTap.listOffers({ customerId: ids.customer });
    const offer = offers.find((candidate) => candidate.serviceKey === serviceKey);
    expect(offer).toMatchObject({ serviceKey, mode: 'priced' });
    // The four fields the buy button posts (routes/one-tap-purchase.js).
    const init = await oneTap.initPurchase({ customerId: ids.customer, clicked: {
      fingerprint: offer.fingerprint, serviceKey: offer.serviceKey,
      optionId: offer.option.id, perApplication: offer.option.perVisit,
    } });
    const slotId = await offerOpening(init.estimateId);
    await oneTap.reserve({ customerId: ids.customer, purchaseId: init.purchaseId, slotId });
    const done = await oneTap.confirm({ customerId: ids.customer, purchaseId: init.purchaseId,
      termsAccepted: true, ip: '203.0.113.9', userAgent: 'fixture' });
    return { init, done };
  }

  // What the nightly accepted-plan audit says about one purchase, judged now
  // instead of a day after the accept.
  const scheduleAudit = (estimateId) => require('../services/recurring-schedule-audit')
    .acceptedRecurringScheduleGaps(trx, {
      now: new Date(), cutoff: new Date(Date.now() + 60000), estimateIds: [estimateId], coverage: new Map(),
    });

  // Every family the My Plan list can sell, bought by a member who has one
  // other service. A family added to PURCHASE_FAMILIES is proven here or
  // fails here.
  test.each(PURCHASE_FAMILIES)('buying %s books a year of visits at the price shown, and reprices the current service to the price shown', async (family) => {
    await seedOwnedService(family === 'pest_control' ? 'lawn_care' : 'pest_control');
    const { init, done } = await buy(family);

    expect(done).toMatchObject({ success: true, perVisit: init.perVisit });
    expect(await trx('one_tap_purchases').where({ id: init.purchaseId }).first('status')).toEqual({ status: 'completed' });

    // The series: one visit for each application the customer agreed to,
    // every one recurring and at the per-application price they agreed to.
    const series = await trx('scheduled_services').where({ source_estimate_id: init.estimateId });
    expect(series).toHaveLength(init.visitsPerYear);
    expect(series.every((row) => row.is_recurring === true)).toBe(true);
    expect(series.filter((row) => !row.recurring_parent_id)).toHaveLength(1);
    expect(money(series)).toEqual(series.map(() => init.perVisit));
    expect(await scheduleAudit(init.estimateId)).toEqual([]);

    // Nothing is charged at confirm, and no setup fee is billed.
    expect(await trx('invoices').where({ customer_id: ids.customer })).toHaveLength(0);

    // The current service: the new price on the screen is the price on its
    // upcoming visits, and the done screen reports it as applied.
    const [shown] = init.pricing.existingServices;
    expect(shown.currentPerVisit).toBe(119);
    expect(shown.newPerVisit).toBeLessThan(119);
    expect(money(await ownedVisits())).toEqual([shown.newPerVisit, shown.newPerVisit]);
    expect(done.pricing.existingServices).toEqual([expect.objectContaining({ newPerVisit: shown.newPerVisit })]);
    expect(done.pricing.existingPending).toBe(false);
  });

  // Owner 2026-10-30: above Bronze, repricing current services is the office's
  // pick, never automatic. The screens must not show what will not happen.
  test('a member with two services buys the third: the new series is discounted, no current-service price is shown and none changes', async () => {
    await trx('customers').where({ id: ids.customer }).update({ waveguard_tier: 'Silver' });
    await seedOwnedService('pest_control');
    await seedOwnedService('lawn_care');
    const { init, done } = await buy('tree_shrub');

    expect(init.pricing).toMatchObject({ tierLabel: 'Gold', existingServices: [] });
    expect(init.pricing.newService.discountPct).toBeGreaterThan(0);
    expect(done.pricing).toMatchObject({ existingServices: [], existingPending: false });
    expect(money(await ownedVisits())).toEqual([119, 119, 119, 119]);
    const series = await trx('scheduled_services').where({ source_estimate_id: init.estimateId });
    expect(series).toHaveLength(init.visitsPerYear);
    expect(money(series)).toEqual(series.map(() => init.perVisit));
  });

  // The live check behind promise 1: the schedule-integrity watchdog raises
  // "Accepted recurring plan needs schedule review" from this audit. It judges
  // a purchase only when the stored line resolves a cadence, which is why it
  // never saw the one-visit lawn purchases.
  test('the nightly schedule audit reports a purchase that is missing visits', async () => {
    await seedOwnedService('pest_control');
    const { init } = await buy('lawn_care');
    await trx('scheduled_services').where({ source_estimate_id: init.estimateId }).whereNotNull('recurring_parent_id').del();

    expect(await scheduleAudit(init.estimateId)).toEqual([expect.objectContaining({
      estimateId: init.estimateId, serviceFamily: 'lawn_care', issues: ['missing_applications'],
      expectedVisits: init.visitsPerYear, recordedVisits: 1,
    })]);
  });

  test('with GATE_WAVEGUARD_EXTEND_EXISTING off, no current-service price is shown and none changes', async () => {
    gates.waveguardExtendExisting = false;
    await seedOwnedService('pest_control');
    const { init, done } = await buy('lawn_care');

    expect(init.pricing.existingServices).toEqual([]);
    expect(done.pricing.existingServices).toEqual([]);
    expect(money(await ownedVisits())).toEqual([119, 119]);
    // The new service is still a full series at its own discounted price.
    expect(init.pricing.newService.discountPct).toBeGreaterThan(0);
    expect(await trx('scheduled_services').where({ source_estimate_id: init.estimateId })).toHaveLength(init.visitsPerYear);
  });
});
