/**
 * GATE_CALL_PREPAY_CHOICE, the parts that need no database (owner 2026-10-29): the gate reader, the extraction field,
 * the scheduling payload and held-visit row (present only with the gate on), and the coverage the accept is handed.
 * The card filing rule and the accept route run against PostgreSQL in call-prepay-choice.db.test.js.
 * Synthetic names and numbers only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const fs = require('fs');
const gates = require('../config/feature-gates');
const { buildTriageItem } = require('../services/call-routing-gates');
const { computeHeldVisits } = require('../services/call-held-visits');
const {
  billingChoiceOf, quotePlanOf, derivePrepayCoverage, runCallPrepayChoiceSweep, REFUSALS,
} = require('../services/call-prepay-choice');

const GATE = 'GATE_CALL_PREPAY_CHOICE';
const saved = process.env[GATE];
afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

describe('the gate', () => {
  test('strict true only: unset, 1, TRUE and yes are all off; the boot log lists it', () => {
    delete process.env[GATE];
    expect(gates.callPrepayChoiceLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'on', '']) { process.env[GATE] = v; expect(gates.callPrepayChoiceLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(gates.callPrepayChoiceLive()).toBe(true);
    expect(Object.keys(gates.gates)).toContain('callPrepayChoice');
  });
  test('the reader is read at call time, not captured at load', () => {
    process.env[GATE] = 'true';
    expect(gates.callPrepayChoiceLive()).toBe(true);
    delete process.env[GATE];
    expect(gates.callPrepayChoiceLive()).toBe(false);
  });
  test('off: the sweep returns before any query', async () => {
    delete process.env[GATE];
    await expect(runCallPrepayChoiceSweep()).resolves.toEqual({ skipped: true, scanned: 0, filed: 0, closed: 0 });
  });
  test('the sweep is scheduled behind the gate, and nothing in the service sends, invoices or texts', () => {
    const scheduler = fs.readFileSync(require.resolve('../services/scheduler.js'), 'utf8');
    expect(scheduler).toContain("require('./call-prepay-choice').runCallPrepayChoiceSweep()");
    expect(scheduler).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.callPrepayChoiceLive\(\)\) return;\s+try \{\s+await runExclusive\('call-prepay-choice'/);
    const service = fs.readFileSync(require.resolve('../services/call-prepay-choice.js'), 'utf8');
    for (const word of ['sendSms', 'sendEmail', 'twilio', 'sendgrid', 'sendInvoice', 'notifyAdmin', 'sendNewRecurringWelcome']) {
      expect(service).not.toContain(word);
    }
  });
});

describe('billingChoiceOf: the plan the caller chose, from the extraction', () => {
  test('annual_prepay and per_application are read; absence, null and any other value are null', () => {
    expect(billingChoiceOf({ service_request: { billing_choice: 'annual_prepay' } })).toBe('annual_prepay');
    expect(billingChoiceOf({ service_request: { billing_choice: 'per_application' } })).toBe('per_application');
    for (const x of [undefined, null, {}, { service_request: {} }, { service_request: { billing_choice: null } },
      { service_request: { billing_choice: 'monthly' } }, { service_request: { billing_choice: 'ANNUAL_PREPAY' } }, { billing_choice: 'annual_prepay' }]) {
      expect(billingChoiceOf(x)).toBeNull();
    }
  });
});

describe('the scheduling payload the office sees', () => {
  const extraction = (choice) => ({
    confidence: { overall: 0.9 },
    meta: { call_summary: 'Caller asked for Tuesday.' },
    service_request: { primary_service_category: 'pest_general', ...(choice === undefined ? {} : { billing_choice: choice }) },
    property: { service_address: { street_line_1: '12 Test Lane', city: 'Bradenton', postal_code: '34205' } },
    scheduling: { status: 'requested', requested_date_range_start: '2026-11-03', requested_date_range_end: '2026-11-03' },
  });
  const payloadOf = (choice) => JSON.parse(buildTriageItem({ callLogId: 'call-1', flag: 'not_confirmed', extraction: extraction(choice) }).payload);

  test('gate on: scheduling_window carries what the caller chose (both plans); a call that chose nothing adds nothing', () => {
    process.env[GATE] = 'true';
    expect(payloadOf('annual_prepay').scheduling_window.billing_choice).toBe('annual_prepay');
    expect(payloadOf('per_application').scheduling_window.billing_choice).toBe('per_application');
    expect(payloadOf(null).scheduling_window).not.toHaveProperty('billing_choice');
    expect(payloadOf(undefined).scheduling_window).not.toHaveProperty('billing_choice');
    expect(payloadOf('weekly').scheduling_window).not.toHaveProperty('billing_choice');
  });
  test('gate off: the payload is byte-identical to a call that named no plan', () => {
    delete process.env[GATE];
    expect(payloadOf('annual_prepay')).toEqual(payloadOf(undefined));
    expect(JSON.stringify(payloadOf('annual_prepay'))).not.toContain('billing_choice');
  });
  test('a card that carries no scheduling payload never gains the field', () => {
    process.env[GATE] = 'true';
    const item = buildTriageItem({ callLogId: 'call-1', flag: 'missing_last_name', extraction: extraction('annual_prepay') });
    expect(item.payload).not.toContain('billing_choice');
  });
  test('the new reason files in its own billing_review category', () => {
    const item = buildTriageItem({ callLogId: 'call-1', flag: 'call_prepay_choice', extraction: extraction('annual_prepay'), severity: 'advisory' });
    expect(item).toMatchObject({ category: 'billing_review', reason_code: 'call_prepay_choice', severity: 'advisory' });
  });
});

describe('the held-visit row', () => {
  const NOW = new Date('2026-10-12T16:00:00Z');
  const DAY = '2026-10-14';
  const heldCall = (choice) => ({
    id: 'call-1', twilio_call_sid: 'CAsynthetic001', customer_id: null, direction: 'inbound', created_at: '2026-10-12T14:30:00Z',
    from_phone: '+19415550100', to_phone: '+19415550111', processing_status: 'processed', v2_extraction_status: 'valid',
    ai_extraction_enriched: {
      caller: { name_full: 'Pat Sample', first_name: 'Pat', last_name: 'Sample' },
      property: { service_address: { street_line_1: '12 Test Lane', city: 'Bradenton', postal_code: '34205' } },
      service_request: { specific_service_name: 'General Pest Control', ...(choice === undefined ? {} : { billing_choice: choice }) },
      scheduling: { status: 'confirmed', confirmed_start_at: `${DAY}T11:00:00-04:00` },
    },
  });
  const rowFor = (choice) => computeHeldVisits([heldCall(choice)], [], [], { dateET: DAY, now: NOW })[0];

  test('gate on: the row carries the plan the caller chose; none chosen adds no key', () => {
    process.env[GATE] = 'true';
    expect(rowFor('annual_prepay')).toMatchObject({ call_log_id: 'call-1', billing_choice: 'annual_prepay' });
    expect(rowFor('per_application')).toMatchObject({ billing_choice: 'per_application' });
    expect(rowFor(null)).not.toHaveProperty('billing_choice');
    expect(rowFor(undefined)).not.toHaveProperty('billing_choice');
  });
  test('gate off: the row is byte-identical to a call that named no plan', () => {
    delete process.env[GATE];
    expect(rowFor('annual_prepay')).toEqual(rowFor(undefined));
    expect(rowFor('annual_prepay')).not.toHaveProperty('billing_choice');
  });
});

describe('derivePrepayCoverage: what the accept is handed', () => {
  const estimate = (over = {}) => ({
    id: 7, customer_id: 'cust-1', status: 'sent', property_id: null, annual_total: 472,
    estimate_data: { recurring: { services: [{ name: 'Quarterly Pest Control', frequency: 'quarterly', visitsPerYear: 4, price: 118 }] }, customerSelection: { frequency: 'quarterly' } },
    ...over,
  });
  const row = (over = {}) => ({ id: 'v1', service_type: 'Quarterly Pest Control Service', scheduled_date: '2026-11-10', is_recurring: false, ...over });

  test('the quote is read as a quarterly pest plan', () => {
    expect(quotePlanOf(estimate())).toEqual({ name: 'Quarterly Pest Control', cadence: 'quarterly' });
  });
  test('a single booked visit: term starts on its date; covered visits come from the QUOTED cadence (4), never the booking', () => {
    expect(derivePrepayCoverage({ estimate: estimate(), rows: [row()] })).toEqual({
      ok: true, termStart: '2026-11-10', bookedIds: ['v1'],
      coverage: { coverageServiceType: 'Quarterly Pest Control Service', coverageVisitCount: 4, coverageCadence: 'quarterly' },
    });
  });
  test('several booked visits: the earliest date anchors the term and every id is handed over', () => {
    const out = derivePrepayCoverage({ estimate: estimate(), rows: [row({ id: 'v2', scheduled_date: new Date('2027-02-10T00:00:00Z') }), row({ id: 'v1', scheduled_date: '2026-11-10' })] });
    expect(out).toMatchObject({ ok: true, termStart: '2026-11-10', bookedIds: ['v2', 'v1'] });
  });
  test('a booked series on the quoted cadence passes; a 42-day custom series is the every-6-weeks plan', () => {
    expect(derivePrepayCoverage({ estimate: estimate(), rows: [row({ is_recurring: true, recurring_pattern: 'quarterly' })] }).ok).toBe(true);
    const sixWeek = estimate({ estimate_data: { recurring: { services: [{ name: 'Lawn Care', frequency: 'every_6_weeks', visitsPerYear: 9 }] }, customerSelection: {} } });
    const out = derivePrepayCoverage({ estimate: sixWeek, rows: [row({ service_type: 'Lawn Care Service', is_recurring: true, recurring_pattern: 'custom', recurring_interval_days: 42 })] });
    expect(out).toMatchObject({ ok: true, coverage: { coverageVisitCount: 9, coverageCadence: 'every_6_weeks' } });
  });
  test.each([
    ['a different booked cadence', { rows: [row({ is_recurring: true, recurring_pattern: 'monthly' })] }, 'booked_cadence_differs'],
    ['an unsupported booked cadence', { rows: [row({ is_recurring: true, recurring_pattern: 'monthly_nth_weekday' })] }, 'booked_cadence_differs'],
    ['two kinds of visit', { rows: [row(), row({ id: 'v2', service_type: 'Lawn Care Service' })] }, 'mixed_services'],
    ['a service other than the quoted one', { rows: [row({ service_type: 'Lawn Care Service' })] }, 'service_mismatch'],
    ['a different property than the quote', { estimate: estimate({ property_id: 'prop-1' }), rows: [row({ property_id: 'prop-2' })] }, 'property_mismatch'],
    ['a stamped setup fee', { rows: [row({ pending_setup_fee: '99.00' })] }, 'setup_fee_stamped'],
    ['add-on lines', { rows: [row()], hasAddons: true }, 'has_addons'],
    ['no booked visit date', { rows: [row({ scheduled_date: null })] }, 'no_booked_visit'],
    ['a quote with no readable cadence', { estimate: estimate({ estimate_data: { recurring: { services: [{ name: 'Pest Control' }] } } }), rows: [row()] }, 'cadence_unsupported'],
  ])('refuses %s, with a plain message', (_name, input, reason) => {
    const out = derivePrepayCoverage({ estimate: estimate(), ...input });
    expect(out).toMatchObject({ ok: false, reason, message: REFUSALS[reason] });
    expect(out.message).toMatch(/\.$/);
  });
});
