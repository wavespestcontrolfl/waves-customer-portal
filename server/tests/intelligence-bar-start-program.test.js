/**
 * start_program (owner 2026-10-06): one card starts a recurring program for
 * an existing monthly-plan customer — the series, the tier and the bill.
 * Synthetic names only. The scenario is the owner's: a customer on a $41.33
 * pest plan moves forward on monthly lawn care at $61.33 at Silver.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn(() => ({ __raw: true }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({
  ...jest.requireActual('../utils/customer-comms-lock'),
  lockCustomerComms: jest.fn(async () => {}),
}));
jest.mock('../routes/admin-schedule', () => {
  // The handler's own date-planning functions run for real; the booking and
  // the blackout read are stubbed.
  const actual = jest.requireActual('../routes/admin-schedule');
  return {
    createScheduleBooking: jest.fn(),
    loadSeriesBlackoutDates: jest.fn(async () => null),
    nextRecurringDate: actual.nextRecurringDate,
    seasonalSafeShift: actual.seasonalSafeShift,
    recurringCandidateTooCloseToAnchor: actual.recurringCandidateTooCloseToAnchor,
    recurrenceOrdinalOptions: actual.recurrenceOrdinalOptions,
  };
});

const db = require('../models/db');
const PlanRateLedger = require('../services/plan-rate-ledger');
const Welcome = require('../services/new-recurring-welcome-sms');
const Existing = require('../services/waveguard-existing-services');
const Sync = require('../services/self-booking-plan-sync');
const WindowRules = require('../services/scheduling/window-rules');
const DatetimeEt = require('../utils/datetime-et');
const InspectionCredit = require('../services/inspection-credit');
const TechNotices = require('../services/tech-visit-notifications');
const Seeder = require('../services/recurring-appointment-seeder');
const FeatureGates = require('../config/feature-gates');
const BookingContact = require('../services/booking-contact-state');
const Schedule = require('../routes/admin-schedule');
const { createScheduleBooking } = require('../routes/admin-schedule');
const { executeCustomerLifecycleTool, CUSTOMER_LIFECYCLE_TOOLS } = require('../services/intelligence-bar/customer-lifecycle-tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');

const CUSTOMER_ID = '00000000-0000-4000-8000-00000000c0a1';
const TECH_ID = '00000000-0000-4000-8000-00000000a0a1';
const PEST_LINE = [{ family_key: 'pest_control', monthly_rate: '41.33' }];

let tables;
let writes;
let calls;
const CUSTOMER_COLUMNS = { active: {}, pipeline_stage: {}, pipeline_stage_changed_at: {}, waveguard_tier: {}, waveguard_tier_source: {}, member_since: {}, monthly_rate: {} };

function fakeDb() {
  function builder(table) {
    const state = { single: false };
    const b = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          let rows = tables[table] || [];
          // The unlinked-estimate query (customer_id IS NULL) sees only rows written with customer_id null.
          if (table === 'estimates') rows = rows.filter((r) => (state.unlinked ? r.customer_id === null : r.customer_id !== null));
          return (resolve) => resolve(state.single ? rows[0] : rows);
        }
        if (prop === 'first') return () => { state.single = true; return b; };
        if (prop === 'columnInfo') return async () => (table === 'customers' ? CUSTOMER_COLUMNS : {});
        if (prop === 'update' || prop === 'insert' || prop === 'del') {
          return (data) => { writes.push({ table, op: prop, data }); return b; };
        }
        return (...args) => {
          calls.push({ table, method: String(prop), args });
          if (prop === 'whereNull' && args[0] === 'customer_id') state.unlinked = true;
          if (prop === 'where' && typeof args[0] === 'function') args[0].call(b, b);
          return b;
        };
      },
    });
    return b;
  }
  const trx = (table) => builder(table);
  trx.raw = jest.fn(async () => ({}));
  trx.isTransaction = true;
  db.mockImplementation(builder);
  db.transaction.mockImplementation(async (cb) => cb(trx));
}

function memberCustomer(overrides = {}) {
  return {
    id: CUSTOMER_ID, first_name: 'Dana', last_name: 'Example', version: '2026-10-06 10:00:00.123456+00',
    monthly_rate: '41.33', billing_mode: 'monthly_membership', waveguard_tier: 'Bronze',
    waveguard_tier_source: 'manual', payer_id: null, deleted_at: null,
    active: true, pipeline_stage: 'active_customer', member_since: '2024-01-01', ...overrides,
  };
}

const BASE_INPUT = {
  customer_id: CUSTOMER_ID,
  service: 'Lawn Care',
  cadence: 'monthly',
  monthly: 61.33,
  tier: 'Silver',
  first_date: '2099-03-03',
  time_window: '9:00 AM',
  technician_id: TECH_ID,
};

// The handler books and its WaveGuard plan sync raises the tier to what the
// card predicted (Silver), as the real booking would.
function bookWithPlanSync(reply) {
  createScheduleBooking.mockImplementation(async () => {
    tables.customers = [memberCustomer({ waveguard_tier: 'Silver' })];
    return reply;
  });
}

let contactState;
function contactStateFixture(overrides = {}) {
  return {
    unavailable: false, textTo: ['9415550134'], emailTo: ['lee@example.com'], holder: { phone: '9415550134', email: 'lee@example.com' },
    toggles: { channel: 'sms', confirmation: true, sms: true, email: true }, ...overrides,
  };
}

const run = (input, ctx = {}) => executeCustomerLifecycleTool('start_program', input, ctx);

beforeEach(() => {
  process.env.GATE_IB_START_PROGRAM = 'true';
  writes = [];
  calls = [];
  tables = {
    customers: [memberCustomer()],
    customer_properties: [{ id: 'prop-1', address_line1: '1 Example St', city: 'Sarasota', state: 'FL', zip: '34201' }],
    services: [
      { id: 'svc-lawn', name: 'Lawn Care', service_key: 'lawn_care', billing_type: 'recurring', is_active: true, default_duration_minutes: 60 },
      { id: 'svc-mosq-1x', name: 'Mosquito One Time', service_key: 'mosquito_one_time', billing_type: 'one_time', is_active: true },
      { id: 'svc-mosq-seasonal', name: 'Mosquito Seasonal', service_key: 'mosquito_seasonal', billing_type: 'recurring', frequency: 'every_6_weeks', visits_per_year: 9, is_active: true },
      { id: 'svc-tree', name: 'Tree & Shrub Care', service_key: 'tree_shrub_quarterly', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4, is_active: true },
    ],
    technicians: [{ id: TECH_ID, name: 'Sam Tech', employment_status: 'active', field_dispatchable: true, active: true }],
    estimates: [],
  };
  contactState = contactStateFixture();
  jest.spyOn(BookingContact, 'bookingContactState').mockImplementation(async () => contactState);
  fakeDb();
  jest.spyOn(PlanRateLedger, 'loadComponents').mockResolvedValue(PEST_LINE);
  jest.spyOn(PlanRateLedger, 'setLineForScalarWrite').mockResolvedValue(undefined);
  jest.spyOn(Welcome, 'isNewRecurringSignupCandidate').mockResolvedValue(false);
  jest.spyOn(Existing, 'loadLiveRecurringObligationRows').mockResolvedValue([
    { id: 'series-pest', service_type: 'General Pest Control', service_key: 'pest_general_quarterly', is_recurring: true },
  ]);
  jest.spyOn(Sync, 'scheduledServiceRowsForCustomer').mockResolvedValue([
    { id: 'series-pest', service_type: 'General Pest Control', service_key: 'pest_general_quarterly', scheduled_date: '2099-02-01', is_recurring: true, status: 'pending' },
  ]);
  jest.spyOn(WindowRules, 'probeSlotOverlap').mockResolvedValue([]);
  jest.spyOn(InspectionCredit, 'projectRedeemableOfferAmount').mockResolvedValue(0);
  jest.spyOn(TechNotices, 'isEnabled').mockReturnValue(false);
  jest.spyOn(Seeder, 'customerPrefersNoWeekends').mockResolvedValue(false);
  const realIsEnabled = FeatureGates.isEnabled;
  jest.spyOn(FeatureGates, 'isEnabled').mockImplementation((g) => (g === 'editApptAddress' ? true : realIsEnabled(g)));
  createScheduleBooking.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.GATE_IB_START_PROGRAM;
});

function lines(preview, kind) {
  return preview.card_lines.filter((l) => !kind || l.kind === kind).map((l) => l.text);
}

describe('pest member starts monthly lawn at Silver: the card', () => {
  test('one card shows the series, every bill line before and after, the tier and the texts', async () => {
    const preview = await run(BASE_INPUT);
    expect(preview.error).toBeUndefined();
    expect(preview.preview).toBe(true);
    expect(preview.customer_name).toBe('Dana Example');
    expect(preview.bill).toEqual({
      lines: [
        { service: 'Pest control', before: 41.33, after: 41.33 },
        { service: 'Lawn care', before: 0, after: 61.33 },
      ],
      total_before: 41.33,
      total_after: 102.66,
    });
    expect(lines(preview, 'billing')).toEqual([
      'Monthly bill 1 of 3: Pest control $41.33 -> $41.33 (unchanged, Silver not applied)',
      'Monthly bill 2 of 3: Lawn care $0.00 -> $61.33 (new)',
      'Monthly bill 3 of 3: total $41.33 -> $102.66 a month',
      'Visits carry no price: the monthly bill covers them (dues-billed plan visits)',
      'Billing lane: stays monthly membership',
    ]);
    expect(lines(preview, 'customer')).toEqual([
      "Booking's WaveGuard plan sync (runs with the booking): tier Bronze -> Silver",
      'WaveGuard tier: Bronze -> Silver (set by hand, so the nightly tier check keeps it)',
    ]);
    expect(preview.plan_sync).toEqual({ waveguard_tier: 'Silver' });
    expect(lines(preview, 'operational')[0]).toBe('Series: Lawn Care, monthly, ongoing, no end date (the first 4 visits are booked now, as on the Schedule screen)');
    expect(lines(preview, 'operational')[1]).toBe('First visit: Tue, Mar 3, 2099, 9:00 AM-10:00 AM, technician Sam Tech, at 1 Example St, Sarasota, FL 34201');
    expect(lines(preview, 'comms')).toEqual([
      'Texts: a booking confirmation for the first visit goes out by text or email, per their settings. It gives the arrival window Tue, Mar 3, 2099, 9:00 AM - 11:00 AM',
      'Confirmation goes to ***0134 by text',
      'Texts and email: no welcome text or welcome email (this customer already had a recurring service)',
      'Texts: visit reminders before each visit, set up as the Schedule screen sets them up',
      'Email: the membership-started email is not sent',
    ]);
    expect(preview.notifies_customer).toBe(true);
    expect(typeof preview._version).toBe('string');
    expect(writes).toEqual([]);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the card shows all four visit dates the Schedule screen would book', async () => {
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'operational')).toContain('Visit dates booked now: Tue, Mar 3, 2099; Tue, Apr 7, 2099; Tue, May 5, 2099; Tue, Jun 2, 2099');
  });

  test('a no-weekend customer: Saturday occurrences move the way the handler moves them', async () => {
    Seeder.customerPrefersNoWeekends.mockResolvedValue(true);
    const preview = await run({ ...BASE_INPUT, first_date: '2099-03-07' });
    const line = lines(preview, 'operational').find((l) => l.startsWith('Visit dates booked now:'));
    // The anchor the operator picked stays; every later visit lands on a weekday.
    expect(line.split(': ')[1].split('; ').slice(1).every((d) => !/^(Sat|Sun)/.test(d))).toBe(true);
    expect(line).toContain('Sat, Mar 7, 2099');
  });

  test('a blackout day on a planned date moves it, and the card shows the moved date', async () => {
    Schedule.loadSeriesBlackoutDates.mockResolvedValue({ dates: new Set(['2099-04-03']), weeklyDaysOff: [] });
    const preview = await run(BASE_INPUT);
    const line = lines(preview, 'operational').find((l) => l.startsWith('Visit dates booked now:'));
    expect(line).not.toContain('Fri, Apr 3, 2099');
    Schedule.loadSeriesBlackoutDates.mockResolvedValue(null);
  });

  test('GATE_EDIT_APPT_ADDRESS off: the pinned propertyId is still passed (a programmatic booking targets the property the card showed)', async () => {
    FeatureGates.isEnabled.mockImplementation(() => false);
    const { scheduleBody, buildProgramPlan } = require('../services/intelligence-bar/start-program')._test;
    const built = await buildProgramPlan(BASE_INPUT);
    expect(scheduleBody(built.plan).propertyId).toBe('prop-1');
  });

  test('the card says no lead status changes', async () => {
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'operational')).toContain('Leads: no lead status changes');
    expect(lines(preview, 'operational')).toContain('No other visits at the first four visit times (if one appears, nothing is booked)');
  });

  test('no open consultation: the card says no consultation is marked won, and pins the empty set', async () => {
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'operational')).toContain('No consultation is marked won');
    expect(lines(preview, 'operational').filter((l) => l.startsWith('Marks consultation'))).toEqual([]);
  });

  test('an open warm consultation: the card names it, and the booking pins it by id and outcome', async () => {
    tables['consultation_outcomes as co'] = [
      { outcome_id: 'co-1', scheduled_service_id: 'visit-9', outcome: 'warm', lost_reason: null, scheduled_date: '2099-02-10', window_start: '09:00' },
    ];
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'operational')).toContain('Marks consultation of Tue, Feb 10, 2099 (outcome warm) as won');
    expect(lines(preview, 'operational')).not.toContain('No consultation is marked won');
    const version = preview._version;
    bookWithPlanSync({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [{ id: 'series-1', date: '2099-03-03' }], warnings: [] } });
    await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true, technicianId: TECH_ID });
    expect(createScheduleBooking.mock.calls[0][0].approvedConsultations).toEqual(['co-1:warm']);
  });

  test('the card reads the consultations through the hook\'s own selection, not a copy', async () => {
    const Consultations = require('../services/consultation-outcomes');
    const spy = jest.spyOn(Consultations, 'openConsultationCandidates').mockResolvedValue([]);
    await run(BASE_INPUT);
    expect(spy).toHaveBeenCalledWith(db, CUSTOMER_ID);
    spy.mockRestore();
  });

  test('a consultation that appears after the card refuses with preview_changed; a changed outcome refuses too', async () => {
    const version = await (async () => (await run(BASE_INPUT))._version)();
    tables['consultation_outcomes as co'] = [
      { outcome_id: 'co-1', scheduled_service_id: 'visit-9', outcome: 'cold', lost_reason: null, scheduled_date: '2099-02-10', window_start: '09:00' },
    ];
    const appeared = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(appeared.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
    const withCold = (await run(BASE_INPUT))._version;
    tables['consultation_outcomes as co'][0].outcome = 'warm';
    const changed = await run({ ...BASE_INPUT, _verified_program_version: withCold }, { confirmed: true });
    expect(changed.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the handler\'s locked consultation rail refuses as preview_changed', async () => {
    const version = await (async () => (await run(BASE_INPUT))._version)();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'consultations changed', code: 'CONSULTATIONS_CHANGED' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code: 'CONSULTATIONS_CHANGED', preview_changed: true, nothing_changed: true });
  });

  test('the card names who the confirmation reaches, masked, and never an address or a full number', async () => {
    contactState = contactStateFixture({ toggles: { channel: 'both', confirmation: true, sms: true, email: true } });
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'comms')).toContain('Confirmation goes to ***0134 by text and l***@example.com by email');
    expect(JSON.stringify(preview)).not.toContain('lee@example.com');
    expect(JSON.stringify(preview)).not.toContain('9415550134');
  });

  test('the card says why no confirmation goes out: texts off, email off, or confirmations off', async () => {
    contactState = contactStateFixture({ toggles: { channel: 'sms', confirmation: true, sms: false, email: true } });
    expect(lines(await run(BASE_INPUT), 'comms')).toContain('No confirmation message: texts are off');
    contactState = contactStateFixture({ toggles: { channel: 'email', confirmation: true, sms: true, email: false } });
    expect(lines(await run(BASE_INPUT), 'comms')).toContain('No confirmation message: email is off');
    contactState = contactStateFixture({ toggles: { channel: 'sms', confirmation: false, sms: true, email: true } });
    expect(lines(await run(BASE_INPUT), 'comms')).toContain('No confirmation message: the customer turned appointment confirmations off');
  });

  test('a new-customer welcome line names its masked recipients too', async () => {
    jest.spyOn(Welcome, 'isNewRecurringSignupCandidate').mockResolvedValue(true);
    const preview = await run({ ...BASE_INPUT, send_texts: true });
    expect(lines(preview, 'comms')).toContain('Welcome goes to ***0134 by text and l***@example.com by email');
  });

  test('the booking carries the contact pin the card showed', async () => {
    const version = (await run(BASE_INPUT))._version;
    bookWithPlanSync({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [{ id: 'series-1', date: '2099-03-03' }], warnings: [] } });
    await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true, technicianId: TECH_ID });
    expect(createScheduleBooking.mock.calls[0][0].approvedContact).toBe(BookingContact.contactKey(contactStateFixture()));
  });

  test('a phone or email change after the card refuses with preview_changed', async () => {
    const version = (await run(BASE_INPUT))._version;
    contactState = contactStateFixture({ textTo: ['9415550199'], holder: { phone: '9415550199', email: 'lee@example.com' } });
    const phone = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(phone.preview_changed).toBe(true);
    contactState = contactStateFixture({ emailTo: ['new@example.com'], holder: { phone: '9415550134', email: 'new@example.com' } });
    const email = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(email.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('a notification setting that flips after the card refuses with preview_changed', async () => {
    const version = (await run(BASE_INPUT))._version;
    contactState = contactStateFixture({ toggles: { channel: 'sms', confirmation: true, sms: false, email: true } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('a contact lookup that fails refuses the proposal instead of guessing', async () => {
    contactState = { unavailable: true };
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'program_contact_unverified' });
  });

  test('the handler\'s locked contact rail refuses as preview_changed', async () => {
    const version = (await run(BASE_INPUT))._version;
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'contact changed', code: 'CONTACT_CHANGED' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code: 'CONTACT_CHANGED', preview_changed: true, nothing_changed: true });
  });

  test('a catalog rename between the card and the commit refuses with preview_changed (the booking would send the new name)', async () => {
    const version = await (async () => (await run(BASE_INPUT))._version)();
    tables.services[0] = { ...tables.services[0], name: 'Lawn Care Plus' };
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('a catalog row edited after the card (updated_at moved) refuses with preview_changed', async () => {
    tables.services[0] = { ...tables.services[0], updated_at: '2026-10-01T10:00:00Z' };
    const version = (await run(BASE_INPUT))._version;
    tables.services[0] = { ...tables.services[0], updated_at: '2026-10-02T10:00:00Z' };
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('tech notice gate on and the confirming actor is not the technician: the card and contract name the notice', async () => {
    TechNotices.isEnabled.mockReturnValue(true);
    const preview = await run(BASE_INPUT, { technicianId: 'office-admin-1' });
    expect(lines(preview, 'comms')).toContain('Technician: notifies Sam Tech of the new visits (app notice)');
    expect(preview.notifies_technician).toBe(true);
    const contract = buildContract({ toolName: 'start_program', params: BASE_INPUT, displayParams: {}, preview });
    expect(contract.notifies_technician).toBe(true);
  });

  test('tech notice: silent when the technician confirms, and when the gate is off', async () => {
    TechNotices.isEnabled.mockReturnValue(true);
    const own = await run(BASE_INPUT, { technicianId: TECH_ID });
    expect(own.notifies_technician).toBe(false);
    expect(lines(own, 'comms').some((l) => l.startsWith('Technician:'))).toBe(false);
    TechNotices.isEnabled.mockReturnValue(false);
    const off = await run(BASE_INPUT, { technicianId: 'office-admin-1' });
    expect(off.notifies_technician).toBe(false);
    expect(buildContract({ toolName: 'start_program', params: BASE_INPUT, displayParams: {}, preview: off }).notifies_technician).toBe(false);
  });

  test('the confirm-card contract carries every card line and says the customer is contacted', async () => {
    const preview = await run(BASE_INPUT);
    const contract = buildContract({
      toolName: 'start_program', params: BASE_INPUT, displayParams: { customer: preview.customer_name }, preview,
    });
    const labels = contract.effects.map((e) => e.label);
    for (const text of lines(preview)) expect(labels).toContain(text);
    expect(labels).toContain('Customer will be contacted: the texts listed on this card');
    expect(labels).toContain('customer: Dana Example');
    expect(contract.action_label).toBe('Start a recurring program');
    expect(contract.notifies_customer).toBe(true);
    expect(contract.tier).toBe('yellow');
  });

  test('a monthly_total the operator stated is split the same way', async () => {
    const preview = await run({ ...BASE_INPUT, monthly: undefined, monthly_total: 102.66 });
    expect(preview.bill.total_after).toBe(102.66);
    expect(preview.bill.lines.find((l) => l.service === 'Lawn care').after).toBe(61.33);
  });
});

describe('reprice opt-in (owner D1)', () => {
  test('a yes on pest reprices only that line, at the price the operator gave', async () => {
    const preview = await run({ ...BASE_INPUT, reprice_lines: [{ service: 'pest_control', monthly: 39.26 }] });
    expect(lines(preview, 'billing').slice(0, 3)).toEqual([
      'Monthly bill 1 of 3: Pest control $41.33 -> $39.26 (Silver applied, you said yes)',
      'Monthly bill 2 of 3: Lawn care $0.00 -> $61.33 (new)',
      'Monthly bill 3 of 3: total $41.33 -> $100.59 a month',
    ]);
  });

  test('no reprice_lines means no other line moves', async () => {
    const preview = await run(BASE_INPUT);
    expect(preview.bill.lines[0]).toEqual({ service: 'Pest control', before: 41.33, after: 41.33 });
  });

  test('a reprice for a service not on the bill is refused', async () => {
    const result = await run({ ...BASE_INPUT, reprice_lines: [{ service: 'mosquito', monthly: 30 }] });
    expect(result.code).toBe('rate_family_unknown');
  });
});

describe('send_texts (owner D3)', () => {
  test('off: the card says no confirmation goes out, and the booking asks for none', async () => {
    const preview = await run({ ...BASE_INPUT, send_texts: false });
    expect(lines(preview, 'comms')[0]).toBe('Texts: no booking confirmation is sent (send texts is off)');
    // Reminder rows are registered for every booked visit, so the customer
    // is still contacted and the card keeps its contact warning.
    expect(preview.notifies_customer).toBe(true);
    expect(lines(preview, 'comms')).toContain('Texts: visit reminders before each visit, set up as the Schedule screen sets them up');
    const contract = buildContract({
      toolName: 'start_program', params: BASE_INPUT, displayParams: { customer: preview.customer_name }, preview,
    });
    expect(contract.notifies_customer).toBe(true);
    expect(contract.effects.map((e) => e.label)).toContain('Customer will be contacted: the texts listed on this card');
    const { scheduleBody } = require('../services/intelligence-bar/start-program')._test;
    const built = await require('../services/intelligence-bar/start-program')._test.buildProgramPlan({ ...BASE_INPUT, send_texts: false });
    expect(scheduleBody(built.plan)).toMatchObject({ sendConfirmationSms: false, sendConfirmation: false });
  });

  test('off is refused when the first-ever welcome text would still go out', async () => {
    Welcome.isNewRecurringSignupCandidate.mockResolvedValue(true);
    expect(await run({ ...BASE_INPUT, send_texts: false })).toMatchObject({ code: 'program_welcome_cannot_skip' });
  });

  test('on, for a first recurring service: the welcome text is named', async () => {
    Welcome.isNewRecurringSignupCandidate.mockResolvedValue(true);
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'comms')).toContain('Texts and email: the new-customer welcome is queued for about 1 hour after booking. It sends the welcome text and the welcome email (welcome.new_recurring), once ever, by the channels the customer allows');
  });
});

describe('refusals', () => {
  test('gate off: refused, nothing read or written', async () => {
    delete process.env.GATE_IB_START_PROGRAM;
    db.mockClear();
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('ANY open estimate refuses, whatever its service (no family reading)', async () => {
    tables.estimates = [{ id: 'est-1', status: 'sent', created_at: '2026-10-01T15:00:00Z', estimate_data: {}, service_interest: 'Pest Control' }];
    const lines = jest.spyOn(PlanRateLedger, 'acceptedRecurringBillingLines').mockReturnValue([{ service: 'pest_control', name: 'Pest Control' }]);
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_open_estimate');
    expect(result.error).toBe('This customer has an open estimate (sent, 2026-10-01 ET). Accept or close it first; the bar does not start a program beside an open estimate.');
    // The guard never classifies the estimate's lines or service_interest.
    expect(lines).not.toHaveBeenCalled();
    const estimateCalls = calls.filter((c) => c.table === 'estimates');
    expect(estimateCalls).toContainEqual({ table: 'estimates', method: 'whereNull', args: ['archived_at'] });
    const statuses = estimateCalls.find((c) => c.method === 'whereIn').args[1];
    expect(statuses).toEqual(expect.arrayContaining(['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed']));
    expect(estimateCalls.find((c) => c.method === 'select').args).not.toContain('service_interest');
  });

  test('with no open estimate the program is proposed', async () => {
    tables.estimates = [];
    expect((await run(BASE_INPUT)).code).toBeUndefined();
  });

  test('an open estimate with no customer_id that the accept would land on this customer also refuses', async () => {
    const RecurringCof = require('../services/recurring-card-on-file');
    tables.customers = [memberCustomer({ phone: '+19415550123' })];
    tables.estimates = [{
      id: 'est-unlinked', customer_id: null, status: 'draft', created_at: '2026-10-02T15:00:00Z', estimate_data: {}, service_interest: 'Pest Control',
      customer_phone: '(941) 555-0123',
    }];
    const resolver = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer')
      .mockResolvedValue({ customerId: CUSTOMER_ID, lookupFailed: false });
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_open_estimate');
    expect(result.error).toContain('This customer has an open estimate (draft, 2026-10-02 ET). Accept or close it first');
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-unlinked' }), expect.anything(), { authoritative: true });
    // The phone digits pick candidates; the accept's own resolver decides whose estimate it is.
    expect(calls.some((c) => c.table === 'estimates' && c.method === 'orWhereRaw' && /regexp_replace/.test(c.args[0]))).toBe(true);
    // An unlinked estimate that resolves to someone else, or to nobody, does not refuse.
    resolver.mockResolvedValue({ customerId: '00000000-0000-4000-8000-00000000c0a2', lookupFailed: false });
    expect((await run(BASE_INPUT)).code).toBeUndefined();
    resolver.mockResolvedValue({ customerId: null, lookupFailed: false });
    expect((await run(BASE_INPUT)).code).toBeUndefined();
    // A lookup that fails reads as a match: fail closed.
    resolver.mockResolvedValue({ customerId: null, lookupFailed: true });
    expect((await run(BASE_INPUT)).code).toBe('program_open_estimate');
  });

  test('a member of an estimate group that one of the customer\'s estimates belongs to is found with no phone at all (round 4)', async () => {
    const RecurringCof = require('../services/recurring-card-on-file');
    tables.customers = [memberCustomer({ phone: null })];
    tables.estimates = [{ id: 'est-member', customer_id: null, status: 'sent', created_at: '2026-10-03T15:00:00Z', estimate_group_id: 'group-1', customer_phone: null }];
    const resolver = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer')
      .mockResolvedValue({ customerId: CUSTOMER_ID, lookupFailed: false });
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_open_estimate');
    expect(calls.some((c) => c.table === 'estimates' && c.method === 'whereIn' && c.args[0] === 'estimate_group_id')).toBe(true);
    // No phone: no phone clause, only the group clause.
    expect(calls.some((c) => c.method === 'orWhereRaw')).toBe(false);
    // The group's owner decides: a sibling owned by another customer does not refuse.
    resolver.mockResolvedValue({ customerId: '00000000-0000-4000-8000-00000000c0a2', lookupFailed: false });
    expect((await run(BASE_INPUT)).code).toBeUndefined();
  });

  test('an unlinked commercial proposal on the same phone does not refuse; a linked one does (round 5)', async () => {
    const RecurringCof = require('../services/recurring-card-on-file');
    tables.customers = [memberCustomer({ phone: '+19415550123' })];
    const proposal = { proposal: { enabled: true } };
    tables.estimates = [{
      id: 'est-prop', customer_id: null, status: 'sent', created_at: '2026-10-02T15:00:00Z', estimate_data: proposal, customer_phone: '(941) 555-0123',
    }];
    const resolver = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer')
      .mockResolvedValue({ customerId: CUSTOMER_ID, lookupFailed: false });
    expect((await run(BASE_INPUT)).code).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
    // The same proposal linked by customer_id counts whatever its category.
    tables.estimates = [{ ...tables.estimates[0], customer_id: CUSTOMER_ID }];
    expect((await run(BASE_INPUT)).code).toBe('program_open_estimate');
    // A scaffold proposal is the same lane; a residential unlinked estimate on the phone still refuses.
    tables.estimates = [{ ...tables.estimates[0], customer_id: null, estimate_data: { proposal: { scaffold: true } } }];
    expect((await run(BASE_INPUT)).code).toBeUndefined();
    tables.estimates = [{ ...tables.estimates[0], customer_id: null, estimate_data: {} }];
    expect((await run(BASE_INPUT)).code).toBe('program_open_estimate');
  });

  test('a sole property missing its ZIP (or street, city, state) refuses at planning, naming the field (round 5)', async () => {
    tables.customer_properties = [{ id: 'prop-1', address_line1: '1 Example St', city: 'Sarasota', state: 'FL', zip: '' }];
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_property_incomplete');
    expect(result.error).toContain('missing its ZIP code');
    tables.customer_properties = [{ id: 'prop-1', address_line1: '', city: ' ', state: 'FL', zip: '34201' }];
    expect((await run(BASE_INPUT)).error).toContain('missing its street, city');
    expect(createScheduleBooking).not.toHaveBeenCalled();
    // The predicate is the booking's own, imported.
    const Props = require('../services/customer-properties');
    expect(Props.missingBookingPropertyFields({ address_line1: 'a', city: 'b', state: 'c', zip: 'd' })).toEqual([]);
  });

  test('a date planner that cannot place all four visits refuses before the card; commit asserts four too (round 5)', async () => {
    jest.spyOn(Schedule, 'seasonalSafeShift').mockReturnValue(null);
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_dates_unplannable');
    expect(result.error).toBe('Could not place all four visits around blackout and closed days; book on the calendar. Nothing was proposed.');
    expect(result.preview).toBeUndefined();
    Schedule.seasonalSafeShift.mockRestore();
    const src = require('fs').readFileSync(require.resolve('../services/intelligence-bar/start-program'), 'utf8');
    expect(src).toContain('if (plan.visitDates.length !== ONGOING_PRESEED) return { ...unplannableDates(), preview_changed: true };');
  });

  test('a retired-for-sale service is refused at the card, before any approval (round 4)', async () => {
    const Library = require('../services/service-library');
    const retired = jest.spyOn(Library, 'retiredServicesNotHeldBy').mockResolvedValue([{ service_key: 'tree_shrub_quarterly', name: 'Tree & Shrub Care (quarterly)' }]);
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_service_retired');
    expect(result.error).toContain('Tree & Shrub Care (quarterly) is retired for new sales and this customer is not on that plan');
    expect(retired).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID, serviceIds: ['svc-lawn'], serviceTypes: ['Lawn Care'], recurrence: { pattern: 'monthly', intervalDays: null },
    });
    expect(createScheduleBooking).not.toHaveBeenCalled();
    // A customer who holds it (nothing returned) books as before.
    retired.mockResolvedValue([]);
    expect((await run(BASE_INPUT)).code).toBeUndefined();
  });

  test('welcome eligibility that cannot be verified refuses instead of pinning "not a new customer" (round 4)', async () => {
    Welcome.isNewRecurringSignupCandidate.mockRejectedValue(new Error('db down'));
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_welcome_unverified');
    expect(result.error).toBe('Could not verify welcome-message eligibility. Try again in a moment. Nothing was proposed.');
    expect(Welcome.isNewRecurringSignupCandidate).toHaveBeenCalledWith(CUSTOMER_ID, { throwOnError: true });
  });

  test('isNewRecurringSignupCandidate stays fail-soft for page callers and throws only on request', async () => {
    Welcome.isNewRecurringSignupCandidate.mockRestore();
    db.mockImplementation(() => { throw new Error('boom'); });
    expect(await Welcome.isNewRecurringSignupCandidate(CUSTOMER_ID)).toBe(false);
    await expect(Welcome.isNewRecurringSignupCandidate(CUSTOMER_ID, { throwOnError: true })).rejects.toThrow('boom');
  });

  test('a technician marked out on a LATER series date is refused at the card, naming that date', async () => {
    const Eligibility = require('../services/technician-eligibility');
    const seen = [];
    jest.spyOn(Eligibility, 'assertAssignableTechnician').mockImplementation(async (id, { date }) => {
      seen.push(date);
      if (date === '2099-05-05') throw Object.assign(new Error('Technician Sam Tech is marked out on 2099-05-05 and cannot be assigned work'), { code: 'TECH_NOT_ASSIGNABLE' });
      return { id };
    });
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_technician_unavailable');
    expect(result.error).toContain('Tue, May 5, 2099');
    expect(seen).toEqual(['2099-03-03', '2099-04-07', '2099-05-05']);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('open inspection credit: refused, book from the Schedule screen', async () => {
    InspectionCredit.projectRedeemableOfferAmount.mockResolvedValue(25);
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_inspection_credit');
    expect(result.error).toContain('Book the first visit from the Schedule screen');
    expect(InspectionCredit.projectRedeemableOfferAmount).toHaveBeenCalledWith(CUSTOMER_ID, { includePaused: true });
  });

  test('a fixed visit count is refused: ongoing programs only', async () => {
    expect(await run({ ...BASE_INPUT, visit_count: 12 })).toMatchObject({ code: 'program_visit_count_refused' });
  });

  test('seasonal mosquito needs the Feb-Oct schedule this tool cannot book: refused', async () => {
    const result = await run({ ...BASE_INPUT, service: 'Mosquito Seasonal' });
    expect(result.code).toBe('program_cadence_mismatch');
    expect(result.error).toContain('Start this program from the Schedule screen');
  });

  test('an operator cadence that conflicts with the catalog row is refused', async () => {
    const result = await run({ ...BASE_INPUT, service: 'Tree & Shrub Care', cadence: 'monthly' });
    expect(result.code).toBe('program_cadence_mismatch');
    expect(result.error).toContain('books quarterly, not monthly');
  });

  test('bill lines that do not add up to the rate are refused, no remainder line invented', async () => {
    tables.customers = [memberCustomer({ monthly_rate: '50.00' })];
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_bill_lines_mismatch');
    expect(result.error).toContain('Fix the rate on the customer page first');
  });

  test('a one-time catalog service cannot start a program', async () => {
    expect(await run({ ...BASE_INPUT, service: 'Mosquito One Time' })).toMatchObject({ code: 'program_service_not_recurring' });
  });

  test('a first window that already passed today is refused before the card', async () => {
    jest.spyOn(DatetimeEt, 'sameDayWindowElapsed').mockReturnValue(true);
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'window_elapsed' });
  });

  test('a plan-sync case the card cannot predict is refused', async () => {
    jest.spyOn(Sync, 'isAutoDerivedTierLabelRow').mockReturnValue(true);
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'program_plan_sync_unpredictable' });
  });

  test('a monthly total below the other services (D4)', async () => {
    const result = await run({ ...BASE_INPUT, monthly: undefined, monthly_total: 30 });
    expect(result.code).toBe('rate_below_other_lines');
  });

  test('missing technician', async () => {
    const { technician_id: _drop, ...input } = BASE_INPUT;
    expect(await run(input)).toMatchObject({ code: 'program_technician_required' });
  });

  test('missing time window', async () => {
    expect(await run({ ...BASE_INPUT, time_window: '' })).toMatchObject({ code: 'program_window_required' });
  });

  test('a customer not on a monthly plan bill', async () => {
    tables.customers = [memberCustomer({ billing_mode: 'per_visit' })];
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'program_needs_monthly_plan' });
  });

  test('a service already on the bill', async () => {
    PlanRateLedger.loadComponents.mockResolvedValue([...PEST_LINE, { family_key: 'lawn_care', monthly_rate: '50.00' }]);
    tables.customers = [memberCustomer({ monthly_rate: '91.33' })];
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'program_already_billed' });
  });

  test('no saved property: refused (the booking would create one)', async () => {
    tables.customer_properties = [];
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_no_property');
    expect(result.error).toContain('Add the service address as a property on the customer page first');
  });

  test('more than one saved address', async () => {
    tables.customer_properties = [{ id: 'prop-1' }, { id: 'prop-2' }];
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'program_multiple_properties' });
  });
});

describe('commit', () => {
  async function approvedVersion(input = BASE_INPUT) {
    return (await run(input))._version;
  }

  test('books through the Schedule screen handler, then sets tier and bill in one transaction', async () => {
    const version = await approvedVersion();
    bookWithPlanSync({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [{ id: 'series-1', date: '2099-03-03' }], warnings: [] } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true, technicianId: TECH_ID });

    expect(result).toMatchObject({ success: true, tier: { before: 'Bronze', after: 'Silver' }, monthly_bill: { before: 41.33, after: 102.66 } });
    expect(result.partial).toBeUndefined();
    expect(executionOutcome(result)).toBe('completed');
    const { body, actor } = createScheduleBooking.mock.calls[0][0];
    expect(body).toMatchObject({
      customerId: CUSTOMER_ID, scheduledDate: '2099-03-03', serviceType: 'Lawn Care', serviceId: 'svc-lawn',
      windowStart: '09:00', windowEnd: '10:00', assignmentMode: 'choose', technicianId: TECH_ID,
      isRecurring: true, recurringPattern: 'monthly', recurringOngoing: true, sendConfirmationSms: true,
      primaryLinePrice: null, estimatedPrice: null,
    });
    expect(actor).toEqual({ technicianId: TECH_ID, technicianName: 'Sam Tech' });
    expect(createScheduleBooking.mock.calls[0][0].creditFreeCard).toBe(true);
    expect(createScheduleBooking.mock.calls[0][0].approvedOverlapFacts).toEqual([]);
    expect(createScheduleBooking.mock.calls[0][0].skipLeadConversion).toBe(true);
    expect(createScheduleBooking.mock.calls[0][0].approvedVisitDates).toEqual(['2099-03-03', '2099-04-07', '2099-05-05', '2099-06-02']);
    expect(createScheduleBooking.mock.calls[0][0].approvedNoOpenEstimate).toBe(true);
    // The welcome verdict the card pinned (this customer is not a first-ever signup) rides into the booking.
    expect(createScheduleBooking.mock.calls[0][0].approvedWelcome).toBe(false);
    expect(body.propertyId).toBe('prop-1');
    expect(createScheduleBooking.mock.calls[0][0].approvedServiceAnchor).toEqual({ propertyId: 'prop-1', address: '1 Example St, Sarasota, FL 34201' });
    expect(createScheduleBooking.mock.calls[0][0].approvedBilling).toEqual({
      payer_id: null, billing_mode: 'monthly_membership', per_application_fee: null, waveguard_tier: 'Bronze', monthly_rate: '41.33',
      // Every other customers column the booking's plan sync reads (round 4).
      waveguard_tier_source: 'manual', active: true, pipeline_stage: 'active_customer', member_since: '2024-01-01', deleted_at: null,
    });
    // The handler queues its texts after it replies: queued, never "sent".
    expect(result.message).toContain('Booking confirmation queued (sent shortly by text or email per their settings; a failure is logged).');
    expect(result.message).not.toMatch(/\bsent per\b|confirmation sent/);
    const customerUpdate = writes.find((w) => w.table === 'customers' && w.op === 'update');
    expect(customerUpdate.data).toMatchObject({ waveguard_tier: 'Silver', waveguard_tier_source: 'manual', monthly_rate: 102.66 });
    expect(PlanRateLedger.setLineForScalarWrite).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID,
      { familyKey: 'lawn_care', previousScalar: 41.33, newScalar: 102.66 }, { source: 'ib_update' });
  });

  test('reprice lines are written first, in the card order', async () => {
    const input = { ...BASE_INPUT, reprice_lines: [{ service: 'pest_control', monthly: 39.26 }] };
    const version = await approvedVersion(input);
    bookWithPlanSync({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } });
    await run({ ...input, _verified_program_version: version }, { confirmed: true });
    expect(PlanRateLedger.setLineForScalarWrite.mock.calls.map((c) => c[2])).toEqual([
      { familyKey: 'pest_control', previousScalar: 41.33, newScalar: 39.26 },
      { familyKey: 'lawn_care', previousScalar: 39.26, newScalar: 100.59 },
    ]);
  });

  test('pin drift: a changed bill refuses with preview_changed and books nothing', async () => {
    const version = await approvedVersion();
    PlanRateLedger.loadComponents.mockResolvedValue([{ family_key: 'pest_control', monthly_rate: '45.00' }]);
    tables.customers = [memberCustomer({ monthly_rate: '45.00' })];
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('pin drift: a different technician or time refuses too', async () => {
    const version = await approvedVersion();
    const result = await run({ ...BASE_INPUT, time_window: '10:00 AM', _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('no approved card: refused', async () => {
    const result = await run(BASE_INPUT, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the Schedule screen refuses the booking: nothing changes', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'Duplicate recurring series', code: 'DUPLICATE_SERIES' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ nothing_changed: true, code: 'DUPLICATE_SERIES' });
    expect(result.error).toContain('Nothing was booked');
    expect(writes).toEqual([]);
    expect(PlanRateLedger.setLineForScalarWrite).not.toHaveBeenCalled();
  });

  test('partial failure: series booked, bill changed underneath -> receipt names both halves', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } });
    // The commit's own re-check reads the card's bill; the locked read in the
    // tier + bill transaction sees a bill another writer changed.
    PlanRateLedger.loadComponents
      .mockResolvedValueOnce(PEST_LINE)
      .mockResolvedValueOnce([{ family_key: 'pest_control', monthly_rate: '45.00' }]);
    // The booking's own plan sync raised the tier before the second step.
    createScheduleBooking.mockImplementation(async () => {
      tables.customers = [memberCustomer({ waveguard_tier: 'Silver', waveguard_tier_source: 'auto' })];
      return { status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } };
    });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ success: true, partial: true, not_done: ['waveguard_tier', 'monthly_bill'] });
    expect(result.customer_now).toEqual({ waveguard_tier: 'Silver', monthly_rate: 41.33 });
    expect(result.warning).toContain('Now the tier is Silver and the monthly bill is $41.33');
    expect(result.series_booked).toMatchObject({ series_id: 'series-1', visits_booked: 4 });
    expect(result.warning).toContain('PARTLY DONE');
    expect(result.warning).toContain('NOT done by this card: the tier Silver and the monthly bill $102.66');
    expect(executionOutcome(result)).toBe('partially_completed');
    expect(writes.filter((w) => w.table === 'customers')).toEqual([]);
  });

  test('fewer visits than the card promised: tier and bill are not applied, the shortfall is named', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 201, json: {
      id: 'series-1', recurringCreated: 2, appointments: [],
      warnings: ['Recurring plan requested 4 visits but only 2 could be placed.'],
    } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ success: true, partial: true, not_done: ['waveguard_tier', 'monthly_bill'] });
    expect(result.warning).toContain('booked 2 of the 4 visits');
    expect(result.warning).toContain('Add the missing visits on the Schedule screen');
    expect(executionOutcome(result)).toBe('partially_completed');
    expect(writes.filter((w) => w.table === 'customers')).toEqual([]);
    expect(PlanRateLedger.setLineForScalarWrite).not.toHaveBeenCalled();
  });

  test('an overlap is shown on the card; a new overlap after the card refuses with preview_changed', async () => {
    // Another customer's visit: shown on the card, not refused.
    tables.scheduled_services = [{ id: 'visit-9', customer_id: 'other-customer', property_id: 'prop-other', first_name: 'Pat', last_name: 'Sample' }];
    const existing = { id: 'visit-9', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' };
    WindowRules.probeSlotOverlap.mockResolvedValue([existing]);
    const preview = await run({ ...BASE_INPUT });
    // Every one of the four series dates is probed, and each overlap is listed with its date.
    expect(WindowRules.probeSlotOverlap.mock.calls.map(([a]) => a.date)).toEqual(['2099-03-03', '2099-04-07', '2099-05-05', '2099-06-02']);
    expect(lines(preview, 'operational')).toContain('Overlap: booked visits overlap visits already on the schedule (Tue, Mar 3, 2099: Pat Sample, Pest Control, 9:00 AM-10:00 AM; Tue, Apr 7, 2099: Pat Sample, Pest Control, 9:00 AM-10:00 AM; Tue, May 5, 2099: Pat Sample, Pest Control, 9:00 AM-10:00 AM; Tue, Jun 2, 2099: Pat Sample, Pest Control, 9:00 AM-10:00 AM). The booking goes ahead, as on the Schedule screen');
    expect(preview.slot_overlap.with).toHaveLength(4);
    WindowRules.probeSlotOverlap.mockResolvedValue([existing, { id: 'visit-10', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Lawn Care' }]);
    const result = await run({ ...BASE_INPUT, _verified_program_version: preview._version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('an overlap on a LATER series date alone is shown on the card, pinned, and refuses as preview_changed when a new one appears there', async () => {
    tables.scheduled_services = [{ id: 'visit-9', customer_id: 'other-customer', property_id: 'prop-other', first_name: 'Pat', last_name: 'Sample' }];
    const existing = { id: 'visit-9', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' };
    const onlyOn = (date, rows) => WindowRules.probeSlotOverlap.mockImplementation(async (a) => (a.date === date ? rows : []));
    onlyOn('2099-05-05', [existing]);
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'operational').find((l) => l.startsWith('Overlap:'))).toBe('Overlap: a booked visit overlaps a visit already on the schedule (Tue, May 5, 2099: Pat Sample, Pest Control, 9:00 AM-10:00 AM). The booking goes ahead, as on the Schedule screen');
    // Same overlap at confirm: books, with that overlap pinned for the handler.
    bookWithPlanSync({ status: 201, json: { id: 'v1', recurringCreated: 4 } });
    await run({ ...BASE_INPUT, _verified_program_version: preview._version }, { confirmed: true });
    expect(createScheduleBooking.mock.calls[0][0].approvedOverlapFacts).toEqual([expect.stringContaining('2099-05-05')]);
    // A new overlap on a later date refuses before booking.
    createScheduleBooking.mockClear();
    onlyOn('2099-06-02', [{ id: 'visit-11', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Lawn Care' }]);
    const result = await run({ ...BASE_INPUT, _verified_program_version: preview._version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('an inspection credit that appears after the card refuses with preview_changed', async () => {
    const version = await approvedVersion();
    InspectionCredit.projectRedeemableOfferAmount.mockResolvedValue(25);
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('the handler finds a credit recorded after the card: refused, nothing booked, preview_changed', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'This customer now has an open inspection credit the card did not show. Nothing was booked.', code: 'INSPECTION_CREDIT_CHANGED' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code: 'INSPECTION_CREDIT_CHANGED', preview_changed: true, nothing_changed: true });
    expect(writes).toEqual([]);
    expect(PlanRateLedger.setLineForScalarWrite).not.toHaveBeenCalled();
  });

  test('an overlapping visit of the same customer is refused (visit grouping would change it)', async () => {
    tables.scheduled_services = [{ id: 'visit-own', customer_id: CUSTOMER_ID, property_id: 'prop-1', first_name: 'Dana', last_name: 'Example' }];
    WindowRules.probeSlotOverlap.mockResolvedValue([{ id: 'visit-own', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' }]);
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_same_customer_overlap');
    expect(result.error).toContain('This customer already has a visit at that time');
  });

  test('an overlapping visit at the same property is refused', async () => {
    tables.scheduled_services = [{ id: 'visit-prop', customer_id: 'someone-else', property_id: 'prop-1' }];
    WindowRules.probeSlotOverlap.mockResolvedValue([{ id: 'visit-prop', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' }]);
    expect(await run(BASE_INPUT)).toMatchObject({ code: 'program_same_customer_overlap' });
  });

  test('the tech-notice gate flipping after the card refuses with preview_changed', async () => {
    const version = (await run(BASE_INPUT, { technicianId: 'office-admin-1' }))._version;
    TechNotices.isEnabled.mockReturnValue(true);
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true, technicianId: 'office-admin-1' });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test.each(['DATES_CHANGED', 'ESTIMATE_OPENED'])('the handler refuses with %s: nothing booked, preview_changed', async (code) => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'Changed. Nothing was booked.', code } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code, preview_changed: true, nothing_changed: true });
    expect(writes).toEqual([]);
  });

  test('a tier another writer set after the booking is not overwritten: partial receipt names it', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockImplementation(async () => {
      // Plan sync was predicted to leave Silver (source manual); someone set Gold.
      tables.customers = [memberCustomer({ waveguard_tier: 'Gold', waveguard_tier_source: 'manual' })];
      return { status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } };
    });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ partial: true, not_done: ['waveguard_tier', 'monthly_bill'] });
    expect(result.warning).toContain('The tier changed after the booking (now Gold, set by manual)');
    expect(writes.filter((w) => w.table === 'customers')).toEqual([]);
  });

  test('the handler finds changed billing under its lock: refused, nothing booked, preview_changed', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: "The customer's billing changed since the card was shown. Nothing was booked.", code: 'BILLING_CHANGED' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code: 'BILLING_CHANGED', preview_changed: true, nothing_changed: true });
    expect(writes).toEqual([]);
  });

  test('the handler resolves a different service address under its lock: refused, preview_changed', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'The service address changed since the card was shown. Nothing was booked.', code: 'ADDRESS_CHANGED' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code: 'ADDRESS_CHANGED', preview_changed: true, nothing_changed: true });
    expect(writes).toEqual([]);
  });

  test('the handler finds a new overlap under its lock: refused, nothing booked, preview_changed', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockResolvedValue({ status: 409, json: { error: 'Another visit now overlaps the first visit. Nothing was booked.', code: 'OVERLAP_CHANGED' } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ code: 'OVERLAP_CHANGED', preview_changed: true, nothing_changed: true });
    expect(writes).toEqual([]);
  });

  test('the service address is pinned: a changed address refuses with preview_changed', async () => {
    const version = await approvedVersion();
    tables.customer_properties = [{ id: 'prop-1', address_line1: '9 Other Rd', city: 'Venice', state: 'FL', zip: '34285' }];
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('partial receipt: a tier the plan sync already set (manual) is not listed as not done', async () => {
    const version = await approvedVersion();
    PlanRateLedger.loadComponents
      .mockResolvedValueOnce(PEST_LINE)
      .mockResolvedValueOnce([{ family_key: 'pest_control', monthly_rate: '45.00' }]);
    createScheduleBooking.mockImplementation(async () => {
      tables.customers = [memberCustomer({ waveguard_tier: 'Silver', waveguard_tier_source: 'manual' })];
      return { status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } };
    });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.not_done).toEqual(['monthly_bill']);
    expect(result.warning).toContain('NOT done by this card: the monthly bill $102.66.');
    expect(result.warning).not.toContain('the tier Silver and');
  });

  test('partial receipt: an equal total never marks the bill done (the lines were not written)', async () => {
    const input = { ...BASE_INPUT, monthly: undefined, monthly_total: 41.33, reprice_lines: [{ service: 'pest_control', monthly: 20 }] };
    const version = await approvedVersion(input);
    createScheduleBooking.mockResolvedValue({ status: 201, json: { id: 'series-1', recurringCreated: 2, appointments: [] } });
    const result = await run({ ...input, _verified_program_version: version }, { confirmed: true });
    expect(result.not_done).toContain('monthly_bill');
    expect(result.warning).toContain('the monthly bill $41.33');
  });

  test('a first-ever recurring customer: the receipt says the welcome is queued', async () => {
    Welcome.isNewRecurringSignupCandidate.mockResolvedValue(true);
    const version = await approvedVersion();
    bookWithPlanSync({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } });
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.message).toContain('Welcome text and welcome email queued for about 1 hour from now (a failure is logged).');
  });

  test('a changed plan-sync prediction after the card refuses with preview_changed', async () => {
    const version = await approvedVersion();
    Sync.scheduledServiceRowsForCustomer.mockResolvedValue([]);
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result.preview_changed).toBe(true);
    expect(createScheduleBooking).not.toHaveBeenCalled();
  });

  test('a thrown booking error is reported as unknown, with the tier and bill untouched', async () => {
    const version = await approvedVersion();
    createScheduleBooking.mockRejectedValue(new Error('connection reset'));
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(executionOutcome(result)).toBe('outcome_unknown');
    expect(result.error).toContain('NOT changed');
    expect(writes).toEqual([]);
  });
});

test('the model-facing schema has no confirm field and is admin-only in the tool list', () => {
  const tool = CUSTOMER_LIFECYCLE_TOOLS.find((t) => t.name === 'start_program');
  expect(tool.input_schema.properties.confirmed).toBeUndefined();
  expect(tool.input_schema.additionalProperties).toBe(false);
});

test('GATE_IB_START_PROGRAM hides the tool from the platform lists; on, it loads on customers, dashboard and schedule', () => {
  const registry = require('../services/intelligence-bar/action-registry');
  const scope = { role: 'admin' };
  const names = (context) => registry.initialTools(context, scope).map((t) => t.name);
  delete process.env.GATE_IB_START_PROGRAM;
  for (const context of ['customers', 'dashboard', 'schedule']) expect(names(context)).not.toContain('start_program');
  expect(registry.allowed(registry.actions.get('start_program'), { role: 'admin', context: 'customers' })).toBe(false);
  process.env.GATE_IB_START_PROGRAM = 'true';
  for (const context of ['customers', 'dashboard', 'schedule']) expect(names(context)).toContain('start_program');
  expect(names('seo')).not.toContain('start_program');
  expect(registry.allowed(registry.actions.get('start_program'), { role: 'technician', context: 'tech' })).toBe(false);
});
