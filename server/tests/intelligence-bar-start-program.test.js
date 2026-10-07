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
jest.mock('../routes/admin-schedule', () => ({ createScheduleBooking: jest.fn() }));

const db = require('../models/db');
const PlanRateLedger = require('../services/plan-rate-ledger');
const Welcome = require('../services/new-recurring-welcome-sms');
const Existing = require('../services/waveguard-existing-services');
const Sync = require('../services/self-booking-plan-sync');
const WindowRules = require('../services/scheduling/window-rules');
const DatetimeEt = require('../utils/datetime-et');
const InspectionCredit = require('../services/inspection-credit');
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
          const rows = tables[table] || [];
          return (resolve) => resolve(state.single ? rows[0] : rows);
        }
        if (prop === 'first') return () => { state.single = true; return b; };
        if (prop === 'columnInfo') return async () => (table === 'customers' ? CUSTOMER_COLUMNS : {});
        if (prop === 'update' || prop === 'insert' || prop === 'del') {
          return (data) => { writes.push({ table, op: prop, data }); return b; };
        }
        return (...args) => { calls.push({ table, method: String(prop), args }); return b; };
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

const run = (input, ctx = {}) => executeCustomerLifecycleTool('start_program', input, ctx);

beforeEach(() => {
  process.env.GATE_IB_START_PROGRAM = 'true';
  writes = [];
  calls = [];
  tables = {
    customers: [memberCustomer()],
    customer_properties: [{ id: 'prop-1' }],
    services: [
      { id: 'svc-lawn', name: 'Lawn Care', service_key: 'lawn_care', billing_type: 'recurring', is_active: true, default_duration_minutes: 60 },
      { id: 'svc-mosq-1x', name: 'Mosquito One Time', service_key: 'mosquito_one_time', billing_type: 'one_time', is_active: true },
    ],
    technicians: [{ id: TECH_ID, name: 'Sam Tech' }],
    estimates: [],
  };
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
    expect(lines(preview, 'operational')[1]).toBe('First visit: Tue, Mar 3, 2099, 9:00 AM-10:00 AM, technician Sam Tech');
    expect(lines(preview, 'comms')).toEqual([
      'Texts: a booking confirmation for the first visit goes out by text or email, per their settings. It gives the arrival window Tue, Mar 3, 2099, 9:00 AM - 11:00 AM',
      'Texts and email: no welcome text or welcome email (this customer already had a recurring service)',
      'Texts: visit reminders before each visit, set up as the Schedule screen sets them up',
      'Email: the membership-started email is not sent',
    ]);
    expect(preview.notifies_customer).toBe(true);
    expect(typeof preview._version).toBe('string');
    expect(writes).toEqual([]);
    expect(createScheduleBooking).not.toHaveBeenCalled();
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

  test('an open estimate for the service', async () => {
    tables.estimates = [{ id: 'est-1', status: 'sent', estimate_data: {} }];
    jest.spyOn(PlanRateLedger, 'acceptedRecurringBillingLines').mockReturnValue([{ service: 'lawn_care', name: 'Lawn Care' }]);
    const result = await run(BASE_INPUT);
    expect(result.code).toBe('program_open_estimate');
    expect(result.error).toContain('Mark the estimate accepted on the estimate page');
    const estimateCalls = calls.filter((c) => c.table === 'estimates');
    expect(estimateCalls).toContainEqual({ table: 'estimates', method: 'whereNull', args: ['archived_at'] });
    const statuses = estimateCalls.find((c) => c.method === 'whereIn').args[1];
    expect(statuses).toEqual(expect.arrayContaining(['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed']));
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
    createScheduleBooking.mockResolvedValue({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [{ id: 'series-1', date: '2099-03-03' }], warnings: [] } });
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
    const customerUpdate = writes.find((w) => w.table === 'customers' && w.op === 'update');
    expect(customerUpdate.data).toMatchObject({ waveguard_tier: 'Silver', waveguard_tier_source: 'manual', monthly_rate: 102.66 });
    expect(PlanRateLedger.setLineForScalarWrite).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID,
      { familyKey: 'lawn_care', previousScalar: 41.33, newScalar: 102.66 }, { source: 'ib_update' });
  });

  test('reprice lines are written first, in the card order', async () => {
    const input = { ...BASE_INPUT, reprice_lines: [{ service: 'pest_control', monthly: 39.26 }] };
    const version = await approvedVersion(input);
    createScheduleBooking.mockResolvedValue({ status: 201, json: { id: 'series-1', recurringCreated: 4, appointments: [] } });
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
    tables.scheduled_services = [{ id: 'visit-9', first_name: 'Pat', last_name: 'Sample' }];
    const existing = { id: 'visit-9', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control' };
    WindowRules.probeSlotOverlap.mockResolvedValue([existing]);
    const preview = await run(BASE_INPUT);
    expect(lines(preview, 'operational')).toContain('Overlap: the first visit overlaps a visit already on the schedule (Pat Sample, Pest Control, 9:00 AM-10:00 AM). The booking goes ahead, as on the Schedule screen');
    expect(preview.slot_overlap.with).toEqual([{ customer: 'Pat Sample', service: 'Pest Control', window: '9:00 AM-10:00 AM' }]);
    WindowRules.probeSlotOverlap.mockResolvedValue([existing, { id: 'visit-10', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Lawn Care' }]);
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
