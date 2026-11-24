/**
 * book_plan_visits (owner 2026-11-24, "book a recurring plan from the bar"): the Intelligence Bar books a recurring
 * visit series for ONE existing customer who already has (or had) a plan for the same service, through the
 * Schedule screen's own create handler (createScheduleBooking). The narrow re-cut of the closed start_program card:
 * visits only, no bill, no welcome text.
 *
 * Scenario: a quarterly pest customer whose series ran out (a completed parent row) is booked back onto quarterly
 * visits from 2099-03-02 at 9:00 AM. The card lists every date, the first visit sends its confirmation text, and
 * Confirm makes exactly one createScheduleBooking call with the pinned body. Synthetic names only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(30000);

const tables = {};
const writes = [];

// Table-aware fake: where/first/select return the seeded rows for that table; any write is recorded so the suite can
// prove the preview never writes.
jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = {};
    for (const m of ['whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'whereIn', 'andWhere', 'orderBy', 'orWhereNot', 'limit', 'whereRaw', 'leftJoin', 'forUpdate', 'forShare', 'modify']) q[m] = () => q;
    q.where = () => q;
    q.first = () => Promise.resolve((tables[table] || [])[0]);
    q.select = () => q;
    q.columnInfo = () => Promise.resolve({});
    q.then = (resolve, reject) => Promise.resolve(tables[table] || []).then(resolve, reject);
    for (const m of ['insert', 'update', 'del', 'delete']) q[m] = (...args) => { writes.push({ table, op: m, args }); return q; };
    return q;
  };
  const db = jest.fn((table) => builder(table));
  db.schema = { hasTable: async () => true };
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  db.transaction = jest.fn(async (cb) => cb(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const AdminSchedule = require('../routes/admin-schedule');
const Seeder = require('../services/recurring-appointment-seeder');
const PlanSync = require('../services/self-booking-plan-sync');
const ServiceLibrary = require('../services/service-library');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const SecurePlans = require('../services/secure-appointment-plans');
const Tools = require('../services/intelligence-bar/tools');
const InspectionCredit = require('../services/inspection-credit');
const WindowRules = require('../services/scheduling/window-rules');
const { executeBookPlanVisitsTool, BOOK_PLAN_VISITS_TOOLS } = require('../services/intelligence-bar/book-plan-visits-tools');
const AuthorizationContract = require('../services/intelligence-bar/authorization-contract');
const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
const ActionRegistry = require('../services/intelligence-bar/action-registry');

const CUSTOMER_ID = '00000000-0000-0000-0000-0000000bc001';
const PROPERTY_ID = '00000000-0000-0000-0000-0000000bc002';
const TECH_ID = '00000000-0000-0000-0000-0000000bc003';
const SERVICE_ID = '00000000-0000-0000-0000-0000000bc004';
const INPUT = { customer_id: CUSTOMER_ID, service_type: 'Quarterly Pest Control Service', scheduled_date: '2099-03-02', time_window: '9:00 AM' };
// The Schedule create's own plan keeps a month cadence on the first visit's nth weekday (the 1st Monday here).
const QUARTERLY_DATES = ['2099-03-02', '2099-06-01', '2099-09-07', '2099-12-07'];

const confirmedInput = (card, input = INPUT) => ({ ...input, confirmed: true, _verified_book_plan_version: card._version });

let schedule;
let pricing;
let syncVerdict;
let openSeries;
let bookingReply;
let refreshableTerms;
let setupOwed;
let creditOpen;
let slotClash;

function seed(overrides = {}) {
  tables.customers = [{
    id: CUSTOMER_ID, first_name: 'Robin', last_name: 'Sample', active: true, deleted_at: null, billing_mode: 'per_visit', payer_id: null,
    monthly_rate: null, waveguard_tier: null, address_line1: '1 Example Way', city: 'Bradenton', state: 'FL', zip: '34205', ...overrides.customer,
  }];
  tables.services = overrides.services || [{
    id: SERVICE_ID, name: 'Quarterly Pest Control Service', service_key: 'pest_quarterly', category: 'pest_control', billing_type: 'recurring',
    frequency: 'quarterly', base_price: 89, is_active: true,
  }];
  // The earlier series: a finished parent for the same service.
  tables.scheduled_services = overrides.series || [{
    id: 'old-parent', customer_id: CUSTOMER_ID, is_recurring: true, recurring_parent_id: null, service_id: SERVICE_ID,
    service_type: 'Quarterly Pest Control Service', property_id: PROPERTY_ID, status: 'completed',
  }];
  tables.customer_properties = overrides.properties || [{
    id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: true,
    address_line1: '1 Example Way', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205',
  }];
  tables.annual_prepay_terms = overrides.terms || [];
  tables.technicians = overrides.technicians || [];
}

beforeEach(() => {
  jest.restoreAllMocks();
  writes.length = 0;
  process.env.GATE_IB_BOOK_PLAN_VISITS = 'true';
  seed();
  pricing = { finalPrice: 89, primaryBase: 89, primaryDiscount: null, appointmentDiscount: null, addonLines: [] };
  syncVerdict = { writes: false, reason: 'no_change' };
  openSeries = [];
  schedule = jest.spyOn(AdminSchedule, 'planCreateSeriesDates');
  jest.spyOn(AdminSchedule, 'buildAppointmentPricing').mockImplementation(async () => pricing);
  jest.spyOn(Seeder, 'findActiveRecurringSeries').mockImplementation(async () => openSeries);
  jest.spyOn(PlanSync, 'bookingWouldChangeCustomerPlan').mockImplementation(async () => syncVerdict);
  jest.spyOn(ServiceLibrary, 'retiredServicesNotHeldBy').mockResolvedValue([]);
  refreshableTerms = [];
  setupOwed = 0;
  creditOpen = 0;
  slotClash = [];
  jest.spyOn(AnnualPrepayRenewals, 'refreshableTermsForCustomer').mockImplementation(async () => refreshableTerms);
  jest.spyOn(SecurePlans, 'directRodentSetupForRow').mockImplementation(async () => setupOwed);
  jest.spyOn(InspectionCredit, 'projectRedeemableOfferAmount').mockImplementation(async () => creditOpen);
  jest.spyOn(WindowRules, 'probeSlotOverlap').mockImplementation(async () => slotClash);
  bookingReply = {
    status: 201,
    json: { id: 'visit-1', recurringCreated: 4, appointments: QUARTERLY_DATES.map((date, i) => ({ id: `visit-${i + 1}`, date })), warnings: [] },
  };
  jest.spyOn(AdminSchedule, 'createScheduleBooking').mockImplementation(async () => bookingReply);
});

afterEach(() => { delete process.env.GATE_IB_BOOK_PLAN_VISITS; });

const propose = (input = INPUT, ctx) => executeBookPlanVisitsTool('book_plan_visits', input, ctx);

describe('the card', () => {
  test('lists every planned visit date, who, where, what it costs and that the confirmation text goes; writes nothing', async () => {
    const card = await propose();
    expect(card.error).toBeUndefined();
    expect(card).toMatchObject({
      preview: true, customer_name: 'Robin S.', address: '1 Example Way, Bradenton, FL 34205',
      service: 'Quarterly Pest Control Service', cadence: 'quarterly', ongoing: true, technician: null,
      price_per_visit: '$89.00', send_texts: true, notifies_customer: true,
    });
    // The implicit (only) property is resolved, stamped on the body and pinned for the handler's transaction.
    expect(card._body.propertyId).toBe(PROPERTY_ID);
    expect(card._approved).toMatchObject({ propertyId: PROPERTY_ID, address: { line1: '1 Example Way', city: 'Bradenton', state: 'FL', zip: '34205' } });
    expect(card.visits.map((v) => v.date)).toEqual(QUARTERLY_DATES);
    expect(card.visits.every((v) => v.window === '9:00 AM')).toBe(true);
    expect(writes).toEqual([]);
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the dates come from the Schedule create\'s own planner, run once with the same body the booking will carry', async () => {
    const card = await propose();
    expect(schedule).toHaveBeenCalledTimes(1);
    const [, opts] = schedule.mock.calls[0];
    expect(opts).toMatchObject({ customerId: CUSTOMER_ID, scheduledDate: '2099-03-02', isRecurring: true, recurringPattern: 'quarterly', recurringOngoing: true });
    expect(card._body).toMatchObject({ recurringPattern: 'quarterly', recurringOngoing: true });
  });

  test('a fixed visit count books exactly that many visits', async () => {
    const card = await propose({ ...INPUT, visit_count: 3 });
    expect(card.ongoing).toBe(false);
    expect(card.visits).toHaveLength(3);
    expect(card._body).toMatchObject({ recurringCount: 3, recurringOngoing: false });
  });

  test('names the picked technician and the picked property\'s address', async () => {
    tables.technicians = [{ id: TECH_ID, name: 'Jo Tech' }];
    tables.customer_properties = [
      { id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: true },
      { id: '00000000-0000-0000-0000-0000000bc009', customer_id: CUSTOMER_ID, active: true },
    ];
    const CustomerProperties = require('../services/customer-properties');
    jest.spyOn(CustomerProperties, 'bookingPropertyStamp').mockResolvedValue({
      property_id: PROPERTY_ID, service_address_line1: '9 Rental Row', service_address_line2: null, service_address_city: 'Venice',
      service_address_state: 'FL', service_address_zip: '34285', lat: null, lng: null,
    });
    jest.spyOn(require('../services/estimate-converter'), 'buildSeriesAddressScope').mockResolvedValue(null);
    jest.spyOn(Tools, 'resolveActiveTechnicianById').mockResolvedValue({ id: TECH_ID, name: 'Jo Tech' });
    const card = await propose({ ...INPUT, property_id: PROPERTY_ID, technician_id: TECH_ID });
    expect(card.error).toBeUndefined();
    expect(card.address).toBe('9 Rental Row, Venice, FL 34285');
    expect(card.technician).toBe('Jo Tech');
    expect(card._body).toMatchObject({ propertyId: PROPERTY_ID, technicianId: TECH_ID });
  });

  test('the card lines (the contract) show every date, the price and the text; it is a confirm card that contacts the customer', async () => {
    const card = await propose();
    const contract = AuthorizationContract.buildContract({ toolName: 'book_plan_visits', params: INPUT, preview: card });
    expect(contract.tier).toBe('yellow');
    expect(contract.notifies_customer).toBe(true);
    expect(contract.irreversible).toBe(true);
    const text = contract.effects.map((e) => e.label).join('\n');
    for (const date of QUARTERLY_DATES) expect(text).toContain(date);
    expect(text).toContain('Robin S.');
    expect(text).toContain('Price per visit: $89.00');
    expect(text).toContain('booking confirmation');
    expect(text).toContain('No welcome text and no invoice');
    expect(require('../services/intelligence-bar/action-policy.json').book_plan_visits).toMatchObject({ kind: 'external_action', approval: 'ui_confirm', role: 'admin' });
  });

  test('send_texts false shows no confirmation text and does not contact the customer', async () => {
    const card = await propose({ ...INPUT, send_texts: false });
    expect(card).toMatchObject({ send_texts: false, notifies_customer: false });
    expect(card._body.sendConfirmationSms).toBe(false);
    const contract = AuthorizationContract.buildContract({ toolName: 'book_plan_visits', params: { ...INPUT, send_texts: false }, preview: card });
    expect(contract.notifies_customer).toBe(false);
    expect(contract.effects.map((e) => e.label).join('\n')).toContain('No booking confirmation text goes, as asked.');
  });

  test('a dues-covered member\'s series shows no per-visit price', async () => {
    seed({ customer: { billing_mode: 'monthly_membership', monthly_rate: 59, waveguard_tier: 'Gold' } });
    const card = await propose();
    expect(card.price_per_visit).toBeNull();
    expect(card.price_note).toMatch(/monthly dues/);
  });
});

describe('refusals (nothing is booked, nothing is carded)', () => {
  const refused = async (input, code) => {
    const result = await propose(input);
    expect(result.code).toBe(code);
    expect(result.error).toMatch(/Nothing was booked\./);
    expect(result.preview).toBeUndefined();
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    return result;
  };

  test('gate off', async () => {
    delete process.env.GATE_IB_BOOK_PLAN_VISITS;
    await refused(INPUT, 'book_plan_visits_not_enabled');
  });

  test('the tool is offered only while the gate is on', () => {
    const action = ActionRegistry.actions.get('book_plan_visits');
    expect(ActionRegistry.allowed(action, { role: 'admin', context: 'customers' })).toBe(true);
    delete process.env.GATE_IB_BOOK_PLAN_VISITS;
    expect(ActionRegistry.allowed(action, { role: 'admin', context: 'customers' })).toBe(false);
    process.env.GATE_IB_BOOK_PLAN_VISITS = 'true';
    expect(ActionRegistry.allowed(action, { role: 'technician', context: 'tech' })).toBe(false);
    expect(WRITE_TWO_STEP_TOOL_NAMES.has('book_plan_visits')).toBe(true);
    for (const context of ['customers', 'dashboard']) {
      expect(ActionRegistry.initialTools(context, { role: 'admin' }).map((t) => t.name)).toContain('book_plan_visits');
    }
  });

  test('a technician login', async () => {
    const result = await propose(INPUT, { isAdmin: false });
    expect(result.code).toBe('permission_denied');
  });

  test('a brand-new program (no earlier series for the service) points at accept_estimate', async () => {
    seed({ series: [{ id: 'other', customer_id: CUSTOMER_ID, is_recurring: true, recurring_parent_id: null, service_id: 'svc-lawn', service_type: 'Bi-Monthly Lawn Care Service', property_id: null, status: 'completed' }] });
    const result = await refused(INPUT, 'new_program');
    expect(result.error).toMatch(/accept_estimate/);
  });

  test('a customer with no series at all', async () => {
    seed({ series: [] });
    await refused(INPUT, 'new_program');
  });

  test('an open series for the service (the duplicate-series guard)', async () => {
    openSeries = [{ id: 'open-parent', next_upcoming_date: '2099-02-10' }];
    const result = await refused(INPUT, 'duplicate_series');
    expect(result.error).toMatch(/2099-02-10/);
  });

  test('an inactive customer', async () => {
    seed({ customer: { active: false } });
    await refused(INPUT, 'customer_not_active');
  });

  test('a deleted customer', async () => {
    seed({ customer: { deleted_at: new Date() } });
    await refused(INPUT, 'customer_not_live');
  });

  test('a service that is not in the catalog', async () => {
    await refused({ ...INPUT, service_type: 'Unicorn Control' }, 'service_not_in_catalog');
  });

  test('a catalog service that is not a recurring plan service', async () => {
    seed({ services: [{ id: SERVICE_ID, name: 'Quarterly Pest Control Service', service_key: 'pest_quarterly', billing_type: 'one_time', frequency: 'quarterly', base_price: 89, is_active: true }] });
    await refused(INPUT, 'not_a_plan_service');
  });

  test('an add-on treatment', async () => {
    seed({ services: [{ id: SERVICE_ID, name: 'Quarterly Pest Control Service', service_key: 'area_addon_attic', billing_type: 'recurring', frequency: 'quarterly', base_price: 89, is_active: true }] });
    await refused(INPUT, 'addon_by_name_unsupported');
  });

  test('a cadence other than the catalog\'s', async () => {
    await refused({ ...INPUT, recurring_pattern: 'monthly' }, 'cadence_not_in_catalog');
  });

  test('a customer on annual prepay, or with a live prepay term', async () => {
    seed({ customer: { billing_mode: 'annual_prepay' } });
    await refused(INPUT, 'annual_prepay_customer');
    seed();
    refreshableTerms = [{ id: 'term-1', status: 'cancelled', cancel_disposition: 'end_at_term' }];
    await refused(INPUT, 'annual_prepay_term');
  });

  test('a booking whose tier or monthly-rate sync would write the customer row', async () => {
    syncVerdict = { writes: true, reason: 'member_alignment', fields: ['monthly_rate'] };
    const result = await refused(INPUT, 'billing_would_change');
    expect(result.error).toMatch(/tier or monthly rate/);
  });

  test('a price that would carry a discount or an add-on line', async () => {
    pricing = { ...pricing, primaryDiscount: { discountId: 'd1', discountDollars: 10 } };
    await refused(INPUT, 'price_would_change');
    pricing = { ...pricing, primaryDiscount: null, addonLines: [{ name: 'Add-on' }] };
    await refused(INPUT, 'price_would_change');
  });

  test('a customer with several active properties and no property_id lists them', async () => {
    seed({ properties: [
      { id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: true, address_line1: '1 Example Way', city: 'Bradenton', state: 'FL', zip: '34205' },
      { id: '00000000-0000-0000-0000-0000000bc009', customer_id: CUSTOMER_ID, active: true, address_line1: '9 Rental Row', city: 'Venice', state: 'FL', zip: '34285' },
    ] });
    const result = await refused(INPUT, 'property_choice_required');
    expect(result.properties).toHaveLength(2);
  });

  test('a retired service the customer does not hold', async () => {
    ServiceLibrary.retiredServicesNotHeldBy.mockResolvedValue([{ name: 'Quarterly Tree & Shrub Care' }]);
    await refused(INPUT, 'retired_service');
  });

  test('a missing or off-the-hour time, and a past date', async () => {
    await refused({ ...INPUT, time_window: '' }, 'time_window_required');
    const offHour = await propose({ ...INPUT, time_window: '9:30 AM' });
    expect(offHour.code).toBe('window_not_on_the_hour');
    await refused({ ...INPUT, scheduled_date: '2020-01-01' }, 'invalid_date');
  });

  test('no technician match', async () => {
    jest.spyOn(Tools, 'resolveTechnicianByName').mockResolvedValue(null);
    await refused({ ...INPUT, technician_name: 'Nobody' }, 'technician_not_found');
  });

  test('no catalog price is refused (a per-application customer would be billed a fee the card does not show), dues cover aside', async () => {
    pricing = { ...pricing, finalPrice: null, primaryBase: null };
    seed({ customer: { billing_mode: 'per_application', per_application_fee: 45 } });
    const result = await refused(INPUT, 'no_catalog_price');
    expect(result.error).toMatch(/per-application fee/);
    // A dues-covered member's series carries no per-visit price by design, so it still gets a card.
    seed({ customer: { billing_mode: 'monthly_membership', monthly_rate: 59, waveguard_tier: 'Gold' } });
    expect((await propose()).preview).toBe(true);
  });
});

describe('refusals that read the handler\'s own helpers', () => {
  const refused = async (input, code) => {
    const result = await propose(input);
    expect(result.code).toBe(code);
    expect(result.preview).toBeUndefined();
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
    return result;
  };

  test('a restart that would owe a bait-station setup fee is refused (the handler\'s direct rodent setup resolver)', async () => {
    setupOwed = 99;
    const result = await refused(INPUT, 'setup_fee_owed');
    expect(result.error).toMatch(/\$99\.00/);
    expect(SecurePlans.directRodentSetupForRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customer_id: CUSTOMER_ID, service_id: SERVICE_ID }));
  });

  test('any term the post-commit prepay refresh would touch refuses (refreshableTermsForCustomer, not a date filter)', async () => {
    refreshableTerms = [{ id: 'term-early', status: 'active', term_end: '2099-02-01' }];
    await refused(INPUT, 'annual_prepay_term');
    expect(AnnualPrepayRenewals.refreshableTermsForCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
  });

  describe('the earlier series must have run at the booking property (its stamped property id)', () => {
    const PROP_B = '00000000-0000-0000-0000-0000000bc009';
    const twoProps = [
      { id: PROPERTY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: true, address_line1: '1 Example Way', city: 'Bradenton', state: 'FL', zip: '34205' },
      { id: PROP_B, customer_id: CUSTOMER_ID, active: true, is_primary: false, address_line1: '9 Rental Row', city: 'Venice', state: 'FL', zip: '34285' },
    ];
    const parent = (extra = {}) => ({
      id: 'old', customer_id: CUSTOMER_ID, is_recurring: true, recurring_parent_id: null, service_id: SERVICE_ID,
      service_type: 'Quarterly Pest Control Service', property_id: PROPERTY_ID, status: 'completed', ...extra,
    });
    beforeEach(() => {
      const CustomerProperties = require('../services/customer-properties');
      jest.spyOn(CustomerProperties, 'bookingPropertyStamp').mockImplementation(async ({ propertyId }) => {
        const row = twoProps.find((p) => p.id === propertyId);
        return row ? { property_id: row.id, service_address_line1: row.address_line1, service_address_line2: '', service_address_city: row.city, service_address_state: row.state, service_address_zip: row.zip, lat: null, lng: null } : null;
      });
      jest.spyOn(require('../services/estimate-converter'), 'buildSeriesAddressScope').mockResolvedValue(null);
    });

    test('a series stamped at the primary does not authorize a plan at the rental', async () => {
      seed({ properties: twoProps, series: [parent()] });
      const rental = await refused({ ...INPUT, property_id: PROP_B }, 'new_program');
      expect(rental.error).toMatch(/brand-new program/);
      expect((await propose({ ...INPUT, property_id: PROPERTY_ID })).preview).toBe(true);
    });

    test('a legacy row with no property stamp qualifies for no property (even with only one active property)', async () => {
      seed({ series: [parent({ property_id: null })] });
      await refused(INPUT, 'new_program');
      seed({ properties: twoProps, series: [parent({ property_id: null })] });
      await refused({ ...INPUT, property_id: PROPERTY_ID }, 'new_program');
    });

    test('a plan at a former, now-inactive property does not authorize a plan at the current only property', async () => {
      seed({ series: [parent({ property_id: '00000000-0000-0000-0000-0000000bc0aa' })] });
      await refused(INPUT, 'new_program');
    });

    test('a customer with no saved active property is sent to the estimate', async () => {
      seed({ properties: [] });
      const result = await refused(INPUT, 'no_saved_property');
      expect(result.error).toMatch(/accept_estimate/);
    });
  });

  test('today\'s first visit whose window is already over is refused, at the card and at Confirm', async () => {
    jest.useFakeTimers({ now: new Date('2099-03-02T20:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      await refused(INPUT, 'window_elapsed');
      const card = await propose({ ...INPUT, time_window: '5:00 PM' });
      expect(card.preview).toBe(true);
      jest.setSystemTime(new Date('2099-03-02T23:30:00Z'));
      const result = await propose(confirmedInput(card, { ...INPUT, time_window: '5:00 PM' }));
      expect(result.code).toBe('window_elapsed');
      expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('overlaps, credit and the same-slot rules', () => {
  test('any other visit in a planned slot refuses, probed at the service\'s real duration and tech-blind', async () => {
    tables.services[0].default_duration_minutes = 90;
    slotClash = [{ id: 'v-9', scheduled_date: '2099-06-01', window_start: '10:00:00', window_end: '11:00:00' }];
    const result = await propose();
    expect(result).toMatchObject({ code: 'slot_overlap' });
    expect(result.error).toMatch(/Nothing was booked/);
    expect(WindowRules.probeSlotOverlap).toHaveBeenCalledWith(expect.objectContaining({ date: '2099-03-02', windowStart: '09:00', windowEnd: '10:30', technicianId: null }));
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('no overlap: every planned date is probed and the card is made', async () => {
    const card = await propose();
    expect(card.preview).toBe(true);
    expect(WindowRules.probeSlotOverlap.mock.calls.map((c) => c[0].date)).toEqual(QUARTERLY_DATES);
    expect(WindowRules.probeSlotOverlap.mock.calls[0][0]).toMatchObject({ windowEnd: '10:00' });
  });

  test('a conflict that appears before Confirm refuses at Confirm', async () => {
    const card = await propose();
    slotClash = [{ id: 'v-10' }];
    const result = await propose(confirmedInput(card));
    expect(result.code).toBe('slot_overlap');
    expect(result.preview_changed).toBe(true);
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('any open inspection-credit offer (paused ones included) refuses; the card reads the complete offer set', async () => {
    creditOpen = 35;
    const result = await propose();
    expect(result).toMatchObject({ code: 'booking_with_credit_unsupported' });
    expect(result.error).toMatch(/\$35\.00/);
    expect(InspectionCredit.projectRedeemableOfferAmount).toHaveBeenCalledWith(CUSTOMER_ID, { includePaused: true });
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('an offer that opens between the card and Confirm refuses at Confirm', async () => {
    const card = await propose();
    creditOpen = 35;
    const result = await propose(confirmedInput(card));
    expect(result).toMatchObject({ code: 'booking_with_credit_unsupported', preview_changed: true });
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });
});

describe('the lawn cadence the plan really follows', () => {
  test('a residential six-week lawn service shows and pins the nine lawn rounds, not "every 6 weeks"', async () => {
    seed({ services: [{ id: SERVICE_ID, name: '6-Week Lawn Care Service', service_key: 'lawn_care', category: 'lawn', billing_type: 'recurring', frequency: 'every_6_weeks', base_price: 55, is_active: true }],
      series: [{ id: 'old-lawn', customer_id: CUSTOMER_ID, is_recurring: true, recurring_parent_id: null, service_id: SERVICE_ID, service_type: '6-Week Lawn Care Service', property_id: PROPERTY_ID, status: 'completed' }] });
    jest.spyOn(AdminSchedule, 'lawnRoundsSeriesForBooking').mockResolvedValue({ pattern: 'lawn_rounds_9', intervalDays: undefined });
    const card = await propose({ ...INPUT, service_type: '6-Week Lawn Care Service' });
    expect(card.error).toBeUndefined();
    expect(card).toMatchObject({ cadence: 'nine lawn rounds a year', cadence_pattern: 'lawn_rounds_9' });
    expect(schedule.mock.calls.at(-1)[1].recurringPattern).toBe('lawn_rounds_9');
    const contract = AuthorizationContract.buildContract({ toolName: 'book_plan_visits', params: INPUT, preview: card });
    const text = contract.effects.map((e) => e.label).join('\n');
    expect(text).toContain('nine lawn rounds a year');
    expect(text).toContain('the nine fixed lawn rounds');
    expect(text).not.toMatch(/every 6 weeks/);
    // The effective pattern is pinned: a change of pattern is a stale card.
    AdminSchedule.lawnRoundsSeriesForBooking.mockResolvedValue({ pattern: 'custom', intervalDays: 42 });
    const stale = await propose(confirmedInput(card, { ...INPUT, service_type: '6-Week Lawn Care Service' }));
    expect(stale.preview_changed).toBe(true);
  });
});

describe('Confirm', () => {
  test('makes exactly one createScheduleBooking call with exactly the pinned body, as the confirming admin', async () => {
    tables.technicians = [{ id: 'staff-1', name: 'Test Admin' }];
    const card = await propose();
    const result = await propose(confirmedInput(card), { technicianId: 'staff-1' });
    expect(AdminSchedule.createScheduleBooking).toHaveBeenCalledTimes(1);
    const arg = AdminSchedule.createScheduleBooking.mock.calls[0][0];
    expect(arg.body).toEqual(card._body);
    // What the handler asserts inside its transaction before commit.
    expect(arg.approvedBooking).toEqual({
      dates: QUARTERLY_DATES, price: 89, propertyId: PROPERTY_ID, technicianId: null,
      address: { line1: '1 Example Way', line2: '', city: 'Bradenton', state: 'FL', zip: '34205' },
      // The eligibility facts the handler compares with the locked customer row.
      customer: { id: CUSTOMER_ID, active: true, billing_mode: 'per_visit', payer_id: null, monthly_rate: null, waveguard_tier: null },
    });
    expect(arg.actor).toEqual({ technicianId: 'staff-1', technicianName: 'Test Admin' });
    expect(arg.body).toEqual({
      customerId: CUSTOMER_ID, scheduledDate: '2099-03-02', serviceType: 'Quarterly Pest Control Service', serviceId: SERVICE_ID,
      propertyId: PROPERTY_ID, windowStart: '09:00', isRecurring: true, recurringPattern: 'quarterly', recurringOngoing: true, createInvoice: true, expected_price: 89, sendConfirmationSms: true,
    });
    expect(result).toMatchObject({ success: true, visits_booked: 4, dates: QUARTERLY_DATES });
  });

  test('the body carries no price, discount, add-on, booster, prepay, estimate or duplicate-series override', async () => {
    const card = await propose({ ...INPUT, visit_count: 4 });
    const keys = Object.keys(card._body);
    for (const banned of ['estimatedPrice', 'primaryLinePrice', 'primaryLineDiscount', 'discountId', 'discountType', 'discountAmount', 'serviceAddons',
      'boosterMonths', 'prepaid', 'billingTerm', 'prepayVisitCount', 'sourceEstimateId', 'source_estimate_id', 'allowDuplicateSeries',
      'duplicateSeriesOverride', 'allowCallBookingDuplicate']) {
      expect(keys).not.toContain(banned);
    }
    // The one price field is the handler's own check (PRICE_DIVERGED): its pricing must equal the catalog price the card showed.
    expect(card._body.expected_price).toBe(89);
  });

  test('send_texts false passes the no-text flag the handler reads', async () => {
    const input = { ...INPUT, send_texts: false };
    const card = await propose(input);
    await propose(confirmedInput(card, input));
    expect(AdminSchedule.createScheduleBooking.mock.calls[0][0].body.sendConfirmationSms).toBe(false);
  });

  test('refuses without the card\'s version (a model call can never approve itself)', async () => {
    const result = await propose({ ...INPUT, confirmed: true });
    expect(result.error).toMatch(/confirmation card/);
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test.each([
    ['the price changed', () => { pricing = { ...pricing, finalPrice: 99 }; }],
    ['the planned dates changed', () => { schedule.mockImplementationOnce(async (_c, o) => { o.plannedChildDates.push('2099-06-02', '2099-09-08', '2099-12-08'); return { plannedCount: 4 }; }); }],
    ['the address changed', () => { tables.customer_properties[0].address_line1 = '2 Moved Street'; }],
    ['the customer\'s billing changed', () => { tables.customers[0].monthly_rate = 59; }],
    ['the catalog price changed', () => { tables.services[0].base_price = 95; }],
  ])('a stale card is refused when %s, and nothing is booked', async (_label, change) => {
    const card = await propose();
    change();
    const result = await propose(confirmedInput(card));
    expect(result.preview_changed).toBe(true);
    expect(result.error).toMatch(/changed after the card was shown/);
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('a duplicate series that appeared since the card refuses at Confirm', async () => {
    const card = await propose();
    openSeries = [{ id: 'new-parent', next_upcoming_date: '2099-04-01' }];
    const result = await propose(confirmedInput(card));
    expect(result.code).toBe('duplicate_series');
    expect(result.preview_changed).toBe(true);
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the gate turned off between the card and Confirm refuses', async () => {
    const card = await propose();
    delete process.env.GATE_IB_BOOK_PLAN_VISITS;
    const result = await propose(confirmedInput(card));
    expect(result.code).toBe('gate_off');
    expect(AdminSchedule.createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the handler\'s own 409 duplicate-series answer comes back as a refusal', async () => {
    bookingReply = { status: 409, json: { error: 'Customer already has an active series', existingSeries: [{ id: 'p1' }] } };
    const card = await propose();
    const result = await propose(confirmedInput(card));
    expect(result).toMatchObject({ code: 'duplicate_series', status: 409 });
    expect(result.success).toBeUndefined();
  });

  test('the handler\'s in-transaction rollback (APPROVED_BOOKING_CHANGED, PRICE_DIVERGED) is a stale card', async () => {
    const card = await propose();
    for (const code of ['APPROVED_BOOKING_CHANGED', 'PRICE_DIVERGED', 'CUSTOMER_CHANGED_RETRY']) {
      bookingReply = { status: 409, json: { error: 'The visit price changed since the card was shown.', code } };
      const result = await propose(confirmedInput(card));
      expect(result).toMatchObject({ code, preview_changed: true });
      expect(result.success).toBeUndefined();
    }
  });

  test('another handler refusal keeps its words and code', async () => {
    bookingReply = { status: 409, json: { error: 'The billing lane has no billable amount', code: 'recurring_without_billable_amount' } };
    const card = await propose();
    const result = await propose(confirmedInput(card));
    expect(result).toMatchObject({ code: 'recurring_without_billable_amount' });
    expect(result.error).toMatch(/no billable amount/);
  });

  test('an operational error the handler throws is a refusal; any other throw is an unknown outcome', async () => {
    const card = await propose();
    AdminSchedule.createScheduleBooking.mockRejectedValueOnce(Object.assign(new Error('Technician is absent that day'), { status: 422, isOperational: true, code: 'TECH_ABSENT' }));
    expect(await propose(confirmedInput(card))).toMatchObject({ code: 'TECH_ABSENT', status: 422 });
    AdminSchedule.createScheduleBooking.mockRejectedValueOnce(new Error('connection reset'));
    const unknown = await propose(confirmedInput(card));
    expect(unknown).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    expect(unknown.success).toBeUndefined();
  });

  test('the handler\'s warnings ride back on the result', async () => {
    bookingReply.json.warnings = ['Recurring plan requested 4 visits but only 3 could be placed'];
    const card = await propose();
    const result = await propose(confirmedInput(card));
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/only 3 could be placed/);
  });
});

describe('the pieces it shares with the Schedule create', () => {
  test('the tool\'s schema is strict and carries no confirmed or pricing field', () => {
    const schema = BOOK_PLAN_VISITS_TOOLS[0].input_schema;
    expect(Object.keys(schema.properties).sort()).toEqual([
      'customer_id', 'property_id', 'recurring_pattern', 'scheduled_date', 'send_texts', 'service_type', 'technician_id', 'technician_name', 'time_window', 'visit_count',
    ]);
    expect(schema.required).toEqual(['customer_id', 'service_type', 'scheduled_date', 'time_window']);
  });

  test('a label-only customer whose derived tier would not change is not refused (the sync\'s own realignment rule)', async () => {
    process.env.GATE_AUTO_WAVEGUARD_TIER = 'true';
    let real;
    jest.isolateModules(() => { real = jest.requireActual('../services/self-booking-plan-sync'); });
    const customer = { id: CUSTOMER_ID, waveguard_tier: 'Bronze', waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: 'per_visit' };
    const existing = { id: 'e1', customer_id: CUSTOMER_ID, status: 'pending', is_recurring: true, scheduled_date: '2099-01-10', service_type: 'Quarterly Pest Control Service' };
    const database = (table) => {
      const q = {};
      for (const m of ['leftJoin', 'where', 'whereNotIn', 'orderBy', 'select']) q[m] = () => q;
      q.first = () => Promise.resolve(table === 'customers' ? customer : undefined);
      q.columnInfo = () => Promise.resolve({ waveguard_tier: {}, waveguard_tier_source: {} });
      q.then = (resolve, reject) => Promise.resolve(table.startsWith('scheduled_services') ? [existing] : []).then(resolve, reject);
      return q;
    };
    database.transaction = async (cb) => cb(database);
    const newRows = [{ service_type: 'Quarterly Pest Control Service', scheduled_date: '2099-03-02', is_recurring: true, status: 'pending', is_callback: false }];
    try {
      expect(await real.bookingWouldChangeCustomerPlan({ database, customerId: CUSTOMER_ID, newRows, today: '2098-12-01' })).toMatchObject({ writes: false, reason: 'no_change' });
      // A second plan family would raise the derived tier: that one does write.
      const lawn = [{ ...newRows[0], service_type: 'Bi-Monthly Lawn Care Service' }];
      expect(await real.bookingWouldChangeCustomerPlan({ database, customerId: CUSTOMER_ID, newRows: lawn, today: '2098-12-01' }))
        .toMatchObject({ writes: true, reason: 'label_only_realign' });
    } finally {
      delete process.env.GATE_AUTO_WAVEGUARD_TIER;
    }
  });

  test('a non-member the enrollment rules would not enroll (commercial, or no qualifying coverage) is not refused', async () => {
    process.env.GATE_AUTO_WAVEGUARD_TIER = 'true';
    let real;
    jest.isolateModules(() => { real = jest.requireActual('../services/self-booking-plan-sync'); });
    const mk = (customer) => {
      const database = (table) => {
        const q = {};
        for (const m of ['leftJoin', 'where', 'whereNotIn', 'orderBy', 'select']) q[m] = () => q;
        q.first = () => Promise.resolve(table === 'customers' ? customer : undefined);
        q.columnInfo = () => Promise.resolve({ waveguard_tier: {}, waveguard_tier_source: {} });
        q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
        return q;
      };
      database.transaction = async (cb) => cb(database);
      return database;
    };
    const newRows = [{ service_type: 'Quarterly Pest Control Service', scheduled_date: '2099-03-02', is_recurring: true, status: 'pending', is_callback: false }];
    try {
      const commercial = mk({ id: CUSTOMER_ID, waveguard_tier: null, monthly_rate: 0, property_type: 'commercial' });
      expect(await real.bookingWouldChangeCustomerPlan({ database: commercial, customerId: CUSTOMER_ID, newRows, today: '2098-12-01' })).toMatchObject({ writes: false, reason: 'commercial_customer' });
      const noCoverage = mk({ id: CUSTOMER_ID, waveguard_tier: null, monthly_rate: 0, property_type: 'residential' });
      expect(await real.bookingWouldChangeCustomerPlan({ database: noCoverage, customerId: CUSTOMER_ID, newRows: [], today: '2098-12-01' })).toMatchObject({ writes: false, reason: 'no_upcoming_recurring_evidence' });
      // A residential non-member whose new series would enroll a tier still writes.
      expect(await real.bookingWouldChangeCustomerPlan({ database: noCoverage, customerId: CUSTOMER_ID, newRows, today: '2098-12-01' })).toMatchObject({ writes: true, reason: 'would_enroll_tier' });
    } finally {
      delete process.env.GATE_AUTO_WAVEGUARD_TIER;
    }
  });

  test('planCreateSeriesDates keeps a quarterly series on the first visit nth weekday and plans nothing for a one-off', async () => {
    const real = jest.requireActual('../routes/admin-schedule');
    const anchor = real.seriesMonthAnchorOpts({ isRecurring: true, recurringPattern: 'quarterly', scheduledDate: '2099-03-02' });
    const seriesDates = new Set(['2099-03-02']);
    const plannedChildDates = [];
    const plan = await real.planCreateSeriesDates(jest.requireMock('../models/db'), {
      customerId: CUSTOMER_ID, scheduledDate: '2099-03-02', bookingProperty: null, isRecurring: true, recurringPattern: 'quarterly',
      recurringIntervalDays: undefined, recurringCount: 4, recurringOngoing: false, monthAnchorOpts: anchor, skipWeekends: false,
      weekendShift: undefined, seriesDates, plannedChildDates,
    });
    expect(plannedChildDates).toEqual(['2099-06-01', '2099-09-07', '2099-12-07']);
    expect(plan.plannedCount).toBe(4);
    expect(plan.shortfallWarning).toBeNull();
    // Not recurring: no plan at all.
    const none = await real.planCreateSeriesDates(jest.requireMock('../models/db'), {
      customerId: CUSTOMER_ID, scheduledDate: '2099-03-02', isRecurring: false, recurringPattern: undefined,
      monthAnchorOpts: {}, seriesDates: new Set(), plannedChildDates: [],
    });
    expect(none.plannedCount).toBe(0);
  });
});
