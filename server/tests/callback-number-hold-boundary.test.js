/**
 * callback_number_needed hold — keyed on the disclaimed NUMBER (codex round
 * 6 on PR #4807, structural; supersedes the per-visit column predicate
 * rounds 2–5 tested here).
 *
 * Covered here:
 *   - disclaimedNumberBlocksSend, THE predicate every SMS passes
 *     (sendCustomerMessage step 6.45 + providerPreparationCheck, twilio.js
 *     sendSMS dispatch): normalized `to`, active = cleared_at IS NULL,
 *     FAILS CLOSED on a read error (a missing table alone proves no hold).
 *   - recordDisclaimedNumberHold: idempotent (number, call) upsert that
 *     re-arms a cleared row.
 *   - the visit-level pre-check (appointment-reminders.js's
 *     callbackNumberHoldActiveForVisit / ...ConfirmedForVisit →
 *     disclaimedNumberHeldForVisit): held iff the visit customer's phone on
 *     file is a held number; grouped occurrences resolve every member; a
 *     terminal member retained in a frozen group — whatever its old
 *     per-visit hold stamp says — cannot strand live siblings (round-6 P2);
 *     a phone moved to an unheld number is not held; fail-closed vs.
 *     tri-state on a read error.
 *   - safeSendAppointment as the email-fallback pre-check boundary, and the
 *     source-level proof every notice call site threads its visit id.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn((customer) => (customer?.phone
    ? [{ phone: customer.phone, name: customer.first_name, role: 'primary' }]
    : [])),
  isServiceContactRole: jest.fn(() => false),
  firstNameFrom: jest.fn((n) => n),
  prefsUnavailable: jest.fn(() => false),
  getPrimaryContact: jest.fn((customer) => ({ phone: customer?.phone, name: customer?.first_name, role: 'primary' })),
}));
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');
const Holds = require('../services/disclaimed-number-holds');

// Minimal knex-shaped in-memory table simulator: where(obj | fn(orWhere)),
// whereIn, whereNull, first, select, update, plus per-table error injection.
function makeFakeDb(seed = {}, { failTables = {} } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const reads = [];
  function builder(name) {
    const rows = tables[name] || (tables[name] = []);
    const eq = {};
    const nulls = [];
    const ins = [];
    const ors = [];
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && nulls.every((c) => row[c] == null)
      && ins.every(({ col, vals }) => vals.includes(row[col]))
      && (ors.length === 0 || ors.some((fn) => fn(row)));
    const run = (fn) => {
      reads.push(name);
      if (failTables[name]) return Promise.reject(failTables[name]);
      return Promise.resolve(fn(rows.filter(matches)));
    };
    const api = {
      where(a, b) {
        if (typeof a === 'function') {
          a.call({ orWhere: (col, val) => { ors.push((row) => row[col] === val); } });
        } else if (a && typeof a === 'object') Object.assign(eq, a);
        else eq[a] = b;
        return api;
      },
      whereIn(col, vals) { ins.push({ col, vals }); return api; },
      whereNull(col) { nulls.push(col); return api; },
      first: () => run((found) => found[0] || undefined),
      select: () => run((found) => found),
      update: (patch) => run((found) => { found.forEach((row) => Object.assign(row, patch)); return found.length; }),
    };
    return api;
  }
  const conn = jest.fn((name) => builder(name));
  conn.raw = jest.fn(async () => ({ rows: [] }));
  return { conn, tables, reads };
}

function wire(fake) {
  db.mockImplementation(fake.conn);
  db.raw = fake.conn.raw;
}

const HELD = '+19415551234';
const CLEAN = '+19415559999';

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
});

describe('disclaimedNumberBlocksSend — the per-SMS predicate', () => {
  test('an active hold on the number blocks, whatever formatting the send carries', async () => {
    wire(makeFakeDb({ disclaimed_number_holds: [{ id: 'h1', phone_e164: HELD, cleared_at: null }] }));
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(true);
    expect(await Holds.disclaimedNumberBlocksSend({ to: '(941) 555-1234' })).toBe(true);
    expect(await Holds.disclaimedNumberBlocksSend({ to: '1-941-555-1234' })).toBe(true);
  });

  test('a cleared hold, or a different number, does not block', async () => {
    wire(makeFakeDb({ disclaimed_number_holds: [{ id: 'h1', phone_e164: HELD, cleared_at: new Date() }] }));
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(false);
    expect(await Holds.disclaimedNumberBlocksSend({ to: CLEAN })).toBe(false);
  });

  test('not customer-scoped: a hold placed under one customer blocks the number for every record', async () => {
    wire(makeFakeDb({ disclaimed_number_holds: [{ id: 'h1', phone_e164: HELD, customer_id: 'cust-a', cleared_at: null }] }));
    // The predicate takes no customer at all — a duplicate record or a lead
    // carrying the same ANI can't route around it.
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(true);
  });

  test('a read error FAILS CLOSED (held), never clear-to-text', async () => {
    wire(makeFakeDb({}, { failTables: { disclaimed_number_holds: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) } }));
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(true);
  });

  test('a missing table (42P01) proves no hold was ever recorded — not held; but inside a caller transaction it still fails closed', async () => {
    const missing = Object.assign(new Error('relation "disclaimed_number_holds" does not exist'), { code: '42P01' });
    const fake = makeFakeDb({}, { failTables: { disclaimed_number_holds: missing } });
    wire(fake);
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(false);
    const trx = (name) => fake.conn(name);
    trx.isTransaction = true;
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD, conn: trx })).toBe(true);
  });

  test('a non-phone destination never reads (and never blocks)', async () => {
    const fake = makeFakeDb({});
    wire(fake);
    expect(await Holds.disclaimedNumberBlocksSend({ to: 'anonymous' })).toBe(false);
    expect(await Holds.disclaimedNumberBlocksSend({ to: null })).toBe(false);
    expect(fake.reads).toEqual([]);
  });
});

describe('recordDisclaimedNumberHold', () => {
  test('upserts one row per (normalized number, call) and re-arms a cleared row', async () => {
    const fake = makeFakeDb({});
    wire(fake);
    const res = await Holds.recordDisclaimedNumberHold({ phone: '(941) 555-1234', customerId: 'cust-1', callLogId: 'call-1' });
    expect(res).toEqual({ recorded: true, phoneE164: HELD });
    const [sql, bindings] = fake.conn.raw.mock.calls[0];
    expect(bindings).toEqual([HELD, 'cust-1', 'call-1']);
    expect(sql).toMatch(/ON CONFLICT \(phone_e164, source_call_log_id\) DO UPDATE/);
    // Re-arm: a write against a cleared row nulls the clearance and bumps
    // held_at; an active row keeps its original held_at.
    expect(sql).toMatch(/cleared_at = NULL/);
    expect(sql).toMatch(/held_at = CASE WHEN disclaimed_number_holds\.cleared_at IS NULL THEN disclaimed_number_holds\.held_at ELSE now\(\) END/);
    // A later write that learns the customer fills it; one that doesn't
    // never erases it.
    expect(sql).toMatch(/customer_id = COALESCE\(EXCLUDED\.customer_id, disclaimed_number_holds\.customer_id\)/);
  });

  test('no dialable number or no call → nothing written', async () => {
    const fake = makeFakeDb({});
    wire(fake);
    expect(await Holds.recordDisclaimedNumberHold({ phone: null, callLogId: 'call-1' })).toEqual({ recorded: false, reason: 'no_phone' });
    expect(await Holds.recordDisclaimedNumberHold({ phone: HELD, callLogId: null })).toEqual({ recorded: false, reason: 'no_call' });
    expect(fake.conn.raw).not.toHaveBeenCalled();
  });
});

describe('visit-level pre-check (callbackNumberHoldActiveForVisit / ConfirmedForVisit)', () => {
  const holdRow = (overrides = {}) => ({ id: 'h1', phone_e164: HELD, source_call_log_id: 'call-1', cleared_at: null, ...overrides });

  test('held iff the visit customer\'s phone on file is an actively held number', async () => {
    wire(makeFakeDb({
      scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1', visit_id: null }],
      customers: [{ id: 'cust-1', phone: '941-555-1234' }],
      disclaimed_number_holds: [holdRow()],
    }));
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(true);
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(true);
  });

  test('a customer whose phone was CHANGED to an unheld number is not held — even though the old number stays held', async () => {
    const fake = makeFakeDb({
      scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1', visit_id: null }],
      customers: [{ id: 'cust-1', phone: CLEAN }],
      disclaimed_number_holds: [holdRow()],
    });
    wire(fake);
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(false);
    expect(fake.tables.disclaimed_number_holds[0].cleared_at).toBeNull();
    // ...and a send that still targets the old number is blocked at the boundary.
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(true);
  });

  test('round-6 P2: a TERMINAL member retained in a frozen group, still carrying its old per-visit stamp, cannot strand live siblings once the number is cleared', async () => {
    wire(makeFakeDb({
      scheduled_services: [
        { id: 'svc-live', customer_id: 'cust-1', visit_id: 'visit-g', status: 'confirmed', callback_number_hold_at: new Date(), call_sms_cleared_at: new Date() },
        // Terminal, kept in the frozen group; the clear writers never touch
        // it, so its per-visit hold columns read "held" forever.
        { id: 'svc-done', customer_id: 'cust-1', visit_id: 'visit-g', status: 'completed', callback_number_hold_at: new Date(), call_sms_cleared_at: null },
      ],
      customers: [{ id: 'cust-1', phone: HELD }],
      disclaimed_number_holds: [holdRow({ cleared_at: new Date() })],
    }));
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-live')).toBe(false);
  });

  test('a grouped occurrence resolves every member: a sibling belonging to a held customer holds the group', async () => {
    wire(makeFakeDb({
      scheduled_services: [
        { id: 'svc-owner', customer_id: 'cust-clean', visit_id: 'visit-g' },
        { id: 'svc-sib', customer_id: 'cust-held', visit_id: 'visit-g' },
      ],
      customers: [{ id: 'cust-clean', phone: CLEAN }, { id: 'cust-held', phone: HELD }],
      disclaimed_number_holds: [holdRow()],
    }));
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-owner')).toBe(true);
  });

  test('an explicit visitId (even null) skips the owner lookup', async () => {
    const fake = makeFakeDb({
      scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1', visit_id: 'visit-g' }],
      customers: [{ id: 'cust-1', phone: CLEAN }],
    });
    wire(fake);
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit({ scheduledServiceId: 'svc-1', visitId: null })).toBe(false);
    expect(fake.reads.filter((t) => t === 'scheduled_services')).toHaveLength(1);
  });

  test('no visit context at all → not held, nothing read', async () => {
    const fake = makeFakeDb({});
    wire(fake);
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit(null)).toBe(false);
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit({})).toBe(false);
    expect(fake.reads).toEqual([]);
  });

  test('a read error: the SMS pre-check FAILS CLOSED (held); the card-request tri-state reader returns null (never "confirmed")', async () => {
    wire(makeFakeDb({
      scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1', visit_id: null }],
      customers: [{ id: 'cust-1', phone: HELD }],
    }, { failTables: { disclaimed_number_holds: new Error('db down') } }));
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(true);
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBeNull();
  });
});

// Finding #7 (round 2): every notice-sending call site threads
// scheduled_service_id so safeSendAppointment's pre-check has a visit to
// resolve. Source-level proof (the callers' claim machinery is too deep to
// mock functionally here).
describe('every safeSendAppointment call site threads scheduled_service_id (finding #7 wiring)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
  const NEEDLE = 'safeSendAppointment(customer,';
  const starts = [];
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) starts.push(i);
  const callSites = starts.map((i) => src.slice(i, i + 2500));

  test('at least the 7 known callers (confirmation, 72h, 24h, reschedule, cancellation, no-show, series cancellation) are found', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(7);
  });

  test('every safeSendAppointment call site includes scheduled_service_id in its metaExtra', () => {
    const missing = callSites.filter((call) => !call.includes('scheduled_service_id'));
    expect(missing).toEqual([]);
  });
});

describe('safeSendAppointment — the email-fallback pre-check boundary', () => {
  const CUSTOMER = { id: 'cust-1', first_name: 'Ada', phone: HELD };

  function visitFixture({ holdCleared = false, customerPhone = HELD } = {}, opts) {
    return makeFakeDb({
      scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1', visit_id: null }],
      customers: [{ id: 'cust-1', phone: customerPhone, line_type: 'mobile' }],
      disclaimed_number_holds: [{ id: 'h1', phone_e164: HELD, cleared_at: holdCleared ? new Date() : null }],
    }, opts);
  }

  test('held → never reaches sendCustomerMessage, returns false, marks the outcome retryable', async () => {
    wire(visitFixture());
    const sendOutcome = {};
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'appointment_rescheduled', 'appointment_confirmation',
      { scheduled_service_id: 'svc-1' }, { sendOutcome },
    );
    expect(sent).toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendOutcome.retryable).toBe(true);
    expect(sendOutcome.lastCode).toBe('CALLBACK_NUMBER_HOLD');
  });

  test('clear path: once the number hold is cleared, the same visit proceeds to the real send', async () => {
    wire(visitFixture({ holdCleared: true }));
    const sent = await AppointmentReminders.safeSendAppointment(
      { ...CUSTOMER }, {}, 'BODY', 'appointment_rescheduled', 'appointment_confirmation',
      { scheduled_service_id: 'svc-1' }, {},
    );
    expect(sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('no scheduled_service_id/visit_id in metaExtra → the visit pre-check is skipped (the per-SMS boundary in sendCustomerMessage still applies)', async () => {
    const fake = visitFixture({ holdCleared: true });
    wire(fake);
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'some_message', 'appointment_confirmation', {}, {},
    );
    expect(sent).toBe(true);
    expect(fake.reads).not.toContain('disclaimed_number_holds');
  });

  test('a read error while pre-checking FAILS CLOSED — the boundary refuses to text on an unknown consent state', async () => {
    wire(visitFixture({}, { failTables: { disclaimed_number_holds: new Error('db down') } }));
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'appointment_cancelled', 'appointment_cancellation',
      { scheduled_service_id: 'svc-1' }, {},
    );
    expect(sent).toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
