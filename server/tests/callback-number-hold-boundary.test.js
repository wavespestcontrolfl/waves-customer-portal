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

/**
 * Codex round 7 P1: the decision-point write (armDisclaimedNumberHold) is
 * the only re-arming write in a pass and serializes with /resolve under the
 * per-call triage lock; every later in-pass write (ensureDisclaimedNumberHold)
 * never re-arms, so a Resolve landing between the writes stands.
 */
describe('armDisclaimedNumberHold / ensureDisclaimedNumberHold (round 7)', () => {
  function recordingConn({ clearedAt = null } = {}) {
    const calls = [];
    const trx = { raw: jest.fn(async (sql, bindings) => { calls.push({ on: 'trx', sql, bindings }); return { rows: [{ cleared_at: clearedAt }] }; }) };
    const conn = {
      raw: jest.fn(async (sql, bindings) => { calls.push({ on: 'conn', sql, bindings }); return { rows: [{ cleared_at: clearedAt }] }; }),
      transaction: jest.fn(async (fn) => fn(trx)),
    };
    return { conn, trx, calls };
  }

  test('arm: takes the per-call triage lock FIRST, then the re-arming upsert, in one transaction', async () => {
    const { conn, calls } = recordingConn();
    const res = await Holds.armDisclaimedNumberHold({ phone: '(941) 555-1234', customerId: null, callLogId: 'call-1', conn });
    expect(res).toEqual({ recorded: true, phoneE164: HELD });
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.on)).toEqual(['trx', 'trx']);
    expect(calls[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(calls[0].bindings).toEqual(['triage-call-review', 'call-1']);
    expect(calls[1].sql).toMatch(/cleared_at = NULL/);
  });

  test('ensure: never re-arms — the upsert only fills customer_id; a cleared row comes back active:false', async () => {
    const cleared = recordingConn({ clearedAt: new Date() });
    const res = await Holds.ensureDisclaimedNumberHold({ phone: HELD, customerId: 'cust-1', callLogId: 'call-1', conn: cleared.conn });
    expect(res).toEqual({ recorded: true, phoneE164: HELD, active: false });
    const { sql, bindings } = cleared.calls[0];
    expect(bindings).toEqual([HELD, 'cust-1', 'call-1']);
    expect(sql).toMatch(/ON CONFLICT \(phone_e164, source_call_log_id\) DO UPDATE SET/);
    expect(sql).toMatch(/customer_id = COALESCE\(EXCLUDED\.customer_id, disclaimed_number_holds\.customer_id\)/);
    expect(sql).not.toMatch(/cleared_at\s*=/);
    expect(sql).not.toMatch(/held_at\s*=/);
    expect(sql).toMatch(/RETURNING cleared_at/);
    const active = recordingConn({ clearedAt: null });
    expect(await Holds.ensureDisclaimedNumberHold({ phone: HELD, callLogId: 'call-1', conn: active.conn }))
      .toEqual({ recorded: true, phoneE164: HELD, active: true });
  });

  // Codex round 8 P1: with the pass's claim, the arm verifies it (FOR
  // UPDATE on call_log) inside the same transaction, after the triage lock
  // and before the upsert; a mismatch writes nothing.
  function fencedConn({ owned }) {
    const calls = [];
    const trx = jest.fn((table) => {
      const q = {
        wheres: [],
        where(a, b) { q.wheres.push(typeof a === 'object' ? a : { [a]: b }); return q; },
        forUpdate() { calls.push({ on: 'trx', op: 'forUpdate', table, wheres: q.wheres }); return q; },
        first: jest.fn(async () => (owned ? { id: 'call-1' } : undefined)),
      };
      return q;
    });
    trx.raw = jest.fn(async (sql, bindings) => { calls.push({ on: 'trx', sql, bindings }); return { rows: [] }; });
    const conn = { raw: jest.fn(), transaction: jest.fn(async (fn) => fn(trx)) };
    return { conn, calls };
  }

  test('arm with a processing claim: triage lock → claim row FOR UPDATE (token + generation) → upsert', async () => {
    const { conn, calls } = fencedConn({ owned: true });
    const res = await Holds.armDisclaimedNumberHold({ phone: HELD, callLogId: 'call-1', procToken: 'tok-A', procGeneration: 7, conn });
    expect(res).toEqual({ recorded: true, phoneE164: HELD });
    expect(calls[0].sql).toMatch(/pg_advisory_xact_lock/);
    expect(calls[1]).toMatchObject({ op: 'forUpdate', table: 'call_log' });
    expect(calls[1].wheres).toEqual([{ id: 'call-1' }, { processing_token: 'tok-A' }, { processing_generation: 7 }]);
    expect(calls[2].sql).toMatch(/INSERT INTO disclaimed_number_holds/);
  });

  test('arm after losing the claim: claimLost, nothing written', async () => {
    const { conn, calls } = fencedConn({ owned: false });
    const res = await Holds.armDisclaimedNumberHold({ phone: HELD, callLogId: 'call-1', procToken: 'tok-A', procGeneration: 7, conn });
    expect(res).toEqual({ recorded: false, claimLost: true });
    expect(calls.some((c) => /INSERT/.test(c.sql || ''))).toBe(false);
  });

  test('neither writes without a dialable number and a call', async () => {
    const { conn } = recordingConn();
    expect(await Holds.ensureDisclaimedNumberHold({ phone: null, callLogId: 'call-1', conn })).toEqual({ recorded: false, reason: 'no_phone' });
    expect(await Holds.armDisclaimedNumberHold({ phone: HELD, callLogId: null, conn })).toEqual({ recorded: false, reason: 'no_call' });
    expect(conn.raw).not.toHaveBeenCalled();
    expect(conn.transaction).not.toHaveBeenCalled();
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
    // Round 8 P1 (changed expectation): a held NUMBER alone is not proof
    // THIS visit was booked under callback_number_needed — this visit has
    // no stamp and no source call, so the card-request email-only reader
    // does not confirm it (see the round-8 describe below).
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(false);
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

// Codex round 8 P1: callbackNumberHoldConfirmedForVisit (the card-request
// email-only gate) requires THIS visit's own evidence, not just any active
// hold on the number on file.
describe('callbackNumberHoldConfirmedForVisit — visit evidence (round 8 P1)', () => {
  const STAMP = new Date('2026-09-25T14:00:00Z');
  const visitRow = (overrides = {}) => ({
    id: 'svc-1', customer_id: 'cust-1', visit_id: null, source_call_log_id: 'call-A',
    callback_number_hold_at: STAMP, call_sms_cleared_at: null, ...overrides,
  });
  const holdRow = (overrides = {}) => ({ id: 'h1', phone_e164: HELD, source_call_log_id: 'call-A', cleared_at: null, ...overrides });

  test('stamped visit + an active row from its OWN source call on the phone on file → confirmed', async () => {
    wire(makeFakeDb({
      scheduled_services: [visitRow()],
      customers: [{ id: 'cust-1', phone: '941-555-1234' }],
      disclaimed_number_holds: [holdRow()],
    }));
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(true);
  });

  test('the number is held only by ANOTHER call → not confirmed (visit suppressed for some other reason)', async () => {
    wire(makeFakeDb({
      scheduled_services: [visitRow({ source_call_log_id: 'call-A', callback_number_hold_at: null })],
      customers: [{ id: 'cust-1', phone: HELD }],
      disclaimed_number_holds: [holdRow({ source_call_log_id: 'call-B' })],
    }));
    // The SMS pre-check still holds the number…
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(true);
    // …but nothing proves THIS visit's delivery:'none' was that hold.
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(false);
  });

  test('stamped visit, but the only active row on this number is from a different call → not confirmed', async () => {
    wire(makeFakeDb({
      scheduled_services: [visitRow()],
      customers: [{ id: 'cust-1', phone: HELD }],
      disclaimed_number_holds: [holdRow({ source_call_log_id: 'call-A', cleared_at: new Date() }), holdRow({ id: 'h2', source_call_log_id: 'call-B' })],
    }));
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(false);
  });

  test('a call-level clearance newer than the stamp → not confirmed', async () => {
    wire(makeFakeDb({
      scheduled_services: [visitRow({ call_sms_cleared_at: new Date(STAMP.getTime() + 1000) })],
      customers: [{ id: 'cust-1', phone: HELD }],
      disclaimed_number_holds: [holdRow()],
    }));
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(false);
  });

  test('no source call on the visit → not confirmed', async () => {
    wire(makeFakeDb({
      scheduled_services: [visitRow({ source_call_log_id: null })],
      customers: [{ id: 'cust-1', phone: HELD }],
      disclaimed_number_holds: [holdRow()],
    }));
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBe(false);
  });
});

// Codex round 8 P1: hold-read failures log a code/name only — a Knex
// err.message can render the SQL and the bound phone_e164.
describe('hold-read failure logs carry no phone number (round 8 P1)', () => {
  const logger = require('../services/logger');
  const leaky = () => Object.assign(
    new Error(`select "id" from "disclaimed_number_holds" where "phone_e164" = '${HELD}' - connection terminated`),
    { code: '57P01' },
  );
  const allLogText = () => [...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls]
    .map((args) => args.map(String).join(' ')).join('\n');

  test('callbackNumberHoldActiveForVisit / ConfirmedForVisit / disclaimedNumberBlocksSend', async () => {
    wire(makeFakeDb({
      scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1', visit_id: null }],
      customers: [{ id: 'cust-1', phone: HELD }],
    }, { failTables: { disclaimed_number_holds: leaky() } }));
    expect(await AppointmentReminders.callbackNumberHoldActiveForVisit('svc-1')).toBe(true);
    expect(await AppointmentReminders.callbackNumberHoldConfirmedForVisit('svc-1')).toBeNull();
    expect(await Holds.disclaimedNumberBlocksSend({ to: HELD })).toBe(true);
    const text = allLogText();
    expect(text).toContain('57P01');
    expect(text).not.toContain('5551234');
    expect(text).not.toContain('phone_e164');
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

  /**
   * Codex round 7 P2: an App-push reminder never dials the number — the
   * pre-check must not suppress it. Only the account holder's App leg
   * proceeds (no other contact is texted on a held visit); its SMS fallback
   * is refused at sendCustomerMessage's boundary (covered in
   * send-customer-message-callback-number-hold.test.js).
   */
  test('round 7 P2: held + expectedChannel push → the holder\'s App leg is sent (not suppressed); no other contact is texted', async () => {
    wire(visitFixture());
    const { getAppointmentContacts } = require('../services/customer-contact');
    getAppointmentContacts.mockReturnValueOnce([
      { phone: HELD, name: 'Ada', role: 'primary' },
      { phone: CLEAN, name: 'Bo', role: 'service_contact' },
    ]);
    const sendOutcome = {};
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'reminder_24h', 'appointment_reminder_24h',
      { scheduled_service_id: 'svc-1' }, { sendOutcome, expectedChannel: 'push' },
    );
    expect(sent).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
      to: HELD, channel: 'sms', metadata: expect.objectContaining({ requestedChannel: 'push', useCustomerChannel: true }),
    });
    expect(sendOutcome.lastCode).not.toBe('CALLBACK_NUMBER_HOLD');
  });

  test('round 7 P2: held + push, App unavailable → the SMS fallback refused at the boundary surfaces as CALLBACK_NUMBER_HOLD (retryable → caller\'s email fallback)', async () => {
    wire(visitFixture());
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'CALLBACK_NUMBER_HOLD', retryable: true, requestedChannel: 'push' });
    const sendOutcome = {};
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, 'BODY', 'reminder_24h', 'appointment_reminder_24h',
      { scheduled_service_id: 'svc-1' }, { sendOutcome, expectedChannel: 'push' },
    );
    expect(sent).toBe(false);
    expect(sendOutcome.lastCode).toBe('CALLBACK_NUMBER_HOLD');
    expect(sendOutcome.retryable).toBe(true);
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
