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
const { createScheduleBooking } = require('../routes/admin-schedule');
const { executeCustomerLifecycleTool, CUSTOMER_LIFECYCLE_TOOLS } = require('../services/intelligence-bar/customer-lifecycle-tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');

const CUSTOMER_ID = '00000000-0000-4000-8000-00000000c0a1';
const TECH_ID = '00000000-0000-4000-8000-00000000a0a1';
const PEST_LINE = [{ family_key: 'pest_control', monthly_rate: '41.33' }];

let tables;
let writes;

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
        if (prop === 'update' || prop === 'insert' || prop === 'del') {
          return (data) => { writes.push({ table, op: prop, data }); return b; };
        }
        return () => b;
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
    waveguard_tier_source: 'manual', payer_id: null, deleted_at: null, ...overrides,
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
  tables = {
    customers: [memberCustomer()],
    customer_properties: [{ id: 'prop-1' }],
    services: [{ id: 'svc-lawn', name: 'Lawn Care', service_key: 'lawn_care', is_active: true, default_duration_minutes: 60 }],
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
    expect(lines(preview, 'customer')).toEqual(['WaveGuard tier: Bronze -> Silver (set by hand, so the nightly tier check keeps it)']);
    expect(lines(preview, 'operational')[0]).toBe('Series: Lawn Care, monthly, ongoing, no end date (the first 4 visits are booked now, as on the Schedule screen)');
    expect(lines(preview, 'operational')[1]).toBe('First visit: Tue, Mar 3, 2099, 9:00 AM-10:00 AM, technician Sam Tech');
    expect(lines(preview, 'comms')).toEqual([
      'Texts: a booking confirmation for the first visit (Tue, Mar 3, 2099, 9:00 AM-10:00 AM) goes out by text or email, per their settings',
      'Texts: no welcome text (this customer already had a recurring service)',
      'Texts: visit reminders before each visit, set up as the Schedule screen sets them up',
      'Texts: no membership email is sent',
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
    expect(preview.notifies_customer).toBe(false);
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
    expect(lines(preview, 'comms')).toContain('Texts: the new-customer welcome text is queued about 1 hour after booking (sent once ever)');
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
    const result = await run({ ...BASE_INPUT, _verified_program_version: version }, { confirmed: true });
    expect(result).toMatchObject({ success: true, partial: true, not_done: ['waveguard_tier', 'monthly_bill'] });
    expect(result.series_booked).toMatchObject({ series_id: 'series-1', visits_booked: 4 });
    expect(result.warning).toContain('PARTLY DONE');
    expect(result.warning).toContain('NOT changed');
    expect(executionOutcome(result)).toBe('partially_completed');
    expect(writes.filter((w) => w.table === 'customers')).toEqual([]);
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
