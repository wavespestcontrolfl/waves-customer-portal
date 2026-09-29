/**
 * B11 follow-ups: a quote-wizard handoff whose draft was contact-linked to an
 * ESTABLISHED customer must (1) be refused inside the booking transaction
 * under the customer lock against the CURRENT stage, (2) honor a
 * committed-booking retry by the factor that linked the draft, (3) never leave
 * an abandoned-booking recovery intent that could message the real customer.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'booking-established-secret';
process.env.ESTIMATE_HANDOFF_SECRET = process.env.ESTIMATE_HANDOFF_SECRET || 'booking-established-handoff-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

// Recording db mock: every chain call is logged per table; .first()/.update()
// resolve from per-table configuration.
const ops = [];
const firstResults = {};
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    const record = (name) => (...args) => {
      // Grouped where((q) => …): run the callback against this same recorder.
      if (typeof args[0] === 'function') { args[0](q); return q; }
      ops.push({ table, op: name, args });
      return q;
    };
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere',
      'orWhereRaw', 'join', 'leftJoin', 'forShare', 'forUpdate', 'orderBy', 'limit', 'select']) q[m] = record(m);
    q.first = async (...args) => { ops.push({ table, op: 'first', args }); return firstResults[table] !== undefined ? firstResults[table] : null; };
    q.update = async (payload) => { ops.push({ table, op: 'update', args: [payload] }); return 1; };
    q.insert = async (payload) => { ops.push({ table, op: 'insert', args: [payload] }); return [{ id: 'new' }]; };
    q.then = (ok, err) => Promise.resolve(firstResults[`${table}:list`] || []).then(ok, err);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.fn = { now: () => 'NOW()' };
  dbFn.raw = (s) => s;
  return dbFn;
});

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const bookingRouter = require('../routes/booking');
const {
  assertContactLinkedHandoffProvisional, suppressRecoveryIntents, mintCaptureToken,
} = bookingRouter._internals;
const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');

const ROOT = 'cust-root';
const BOUND = 'cust-bound';
const handoff = { rootId: ROOT, boundId: BOUND };
const SLOT = { slotDate: '2099-01-01', slotStart: '09:00' };
const customer = (over = {}) => ({
  id: BOUND, pipeline_stage: 'active_customer', phone: '(941) 555-0101', email: 'owner@example.com', ...over,
});

// Fake trx: customers read (forShare rows), consumed-booking lookup, draft row.
function fakeTrx({ customers, consumed = null, draft = null }) {
  const calls = [];
  const trx = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'join', 'select']) q[m] = (...a) => { calls.push([table, m, ...a]); return q; };
    q.forShare = () => { calls.push([table, 'forShare']); return q; };
    q.first = async () => (table === 'estimates' ? draft : consumed);
    q.then = (ok, err) => Promise.resolve(customers).then(ok, err);
    return q;
  };
  trx.calls = calls;
  return trx;
}
const run = (trx, newCustomer, pricingEstimateId = 'pe-1') => assertContactLinkedHandoffProvisional(trx, {
  handoff, pricingEstimateId, ...SLOT, newCustomer,
});
const REFUSED = expect.objectContaining({ code: 'ESTABLISHED_CUSTOMER_SIGN_IN', statusCode: 409 });

beforeEach(() => {
  ops.length = 0;
  for (const k of Object.keys(firstResults)) delete firstResults[k];
});

describe('assertContactLinkedHandoffProvisional (runs under the customer lock, inside the transaction)', () => {
  test('established customer → refused with the sign-in message', async () => {
    const trx = fakeTrx({ customers: [customer()] });
    await expect(run(trx, { phone: '941-555-0101' })).rejects.toEqual(REFUSED);
    await expect(run(trx, { phone: '941-555-0101' })).rejects.toThrow(/sign in to your customer portal/i);
    // the read is a share lock — a promotion UPDATE cannot land before commit
    expect(trx.calls.some((c) => c[1] === 'forShare')).toBe(true);
  });

  test('TOCTOU: a row that was pre-customer at the gate but is established by the locked read is refused', async () => {
    // The gate no longer reads the stage at all; the transaction's locked read
    // is the only classification, so a stage flipped between the gate and the
    // transaction is seen here.
    const trx = fakeTrx({ customers: [customer({ pipeline_stage: 'won' })] });
    await expect(run(trx, { phone: '941-555-0101' })).rejects.toEqual(REFUSED);
  });

  test('still a pre-customer lead at the locked read → allowed (the quoter\'s own row)', async () => {
    for (const stage of ['new_lead', 'contacted', 'estimate_sent']) {
      await expect(run(fakeTrx({ customers: [customer({ pipeline_stage: stage })] }), { phone: '941-555-0101' })).resolves.toBeUndefined();
    }
  });

  test('a null/legacy stage counts as established (fail closed on identity)', async () => {
    await expect(run(fakeTrx({ customers: [customer({ pipeline_stage: null })] }), {})).rejects.toEqual(REFUSED);
  });

  test('either the draft\'s root customer or the bound property row being established refuses', async () => {
    const trx = fakeTrx({ customers: [customer({ id: ROOT, pipeline_stage: 'won' }), customer({ id: BOUND, pipeline_stage: 'new_lead' })] });
    await expect(run(trx, {})).rejects.toEqual(REFUSED);
  });

  test('no handoff tag (bearer / accept-link identity) → never checked', async () => {
    const trx = fakeTrx({ customers: [customer()] });
    await expect(assertContactLinkedHandoffProvisional(trx, { handoff: null, pricingEstimateId: 'pe-1', ...SLOT, newCustomer: {} })).resolves.toBeUndefined();
    expect(trx.calls).toEqual([]);
  });

  describe('committed-booking retry (lead promoted to won by the first booking)', () => {
    test('same customer + slot + typed phone → allowed (idempotent replay reachable)', async () => {
      const trx = fakeTrx({ customers: [customer({ pipeline_stage: 'won' })], consumed: { id: 'ss-1' }, draft: { customer_email: 'owner@example.com' } });
      await expect(run(trx, { phone: '941-555-0101' })).resolves.toBeUndefined();
    });

    test('draft linked by EMAIL with a new/different typed phone → allowed (P2)', async () => {
      const trx = fakeTrx({
        customers: [customer({ pipeline_stage: 'won' })],
        consumed: { id: 'ss-1' },
        draft: { customer_email: 'Owner@Example.com' },
      });
      await expect(run(trx, { phone: '941-555-0177', email: 'owner@example.com' })).resolves.toBeUndefined();
    });

    test('email matches the customer but did NOT link the draft → refused', async () => {
      const trx = fakeTrx({
        customers: [customer({ pipeline_stage: 'won' })],
        consumed: { id: 'ss-1' },
        draft: { customer_email: 'someone-else@example.com' },
      });
      await expect(run(trx, { phone: '941-555-0177', email: 'owner@example.com' })).rejects.toEqual(REFUSED);
    });

    test('a consumed booking with an unrelated typed contact → refused', async () => {
      const trx = fakeTrx({ customers: [customer({ pipeline_stage: 'won' })], consumed: { id: 'ss-1' }, draft: { customer_email: 'owner@example.com' } });
      await expect(run(trx, { phone: '941-555-0177', email: 'nobody@example.com' })).rejects.toEqual(REFUSED);
    });

    test('no consumed booking for this draft/slot/customer → a fresh booking is refused even with the right phone', async () => {
      const trx = fakeTrx({ customers: [customer({ pipeline_stage: 'won' })], consumed: null });
      await expect(run(trx, { phone: '941-555-0101' })).rejects.toEqual(REFUSED);
    });
  });
});

describe('wiring in createSelfBooking (source guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');

  test('the gate tags the binding but never refuses on stage itself', () => {
    const gate = src.slice(src.indexOf('const bindGateEstimate = async'), src.indexOf('let gatePass = { valid: false };'));
    expect(gate).toContain('contactLinkedRootId');
    expect(gate).not.toMatch(/PRE_CUSTOMER_PIPELINE_STAGES/);
    expect(gate).not.toMatch(/status: 409/);
  });

  test('the check runs inside the transaction, right after the locked customer re-read and before any insert', () => {
    const txStart = src.indexOf('txResult = await db.transaction(async (trx) => {');
    const call = src.indexOf('await assertContactLinkedHandoffProvisional(trx, {');
    const lockedRead = src.indexOf('const freshBookingCustomer = await trx(\'customers\')');
    const firstInsert = src.indexOf("trx('scheduled_services').insert", txStart);
    expect(txStart).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(lockedRead);
    expect(lockedRead).toBeGreaterThan(txStart);
    if (firstInsert !== -1) expect(call).toBeLessThan(firstInsert);
  });

  test('the refusal is answered as a 409 and retires the recovery intent', () => {
    const catchStart = src.indexOf('} catch (txErr) {');
    const branch = src.slice(catchStart, catchStart + 3500);
    expect(branch).toContain("txErr.code === 'ESTABLISHED_CUSTOMER_SIGN_IN'");
    expect(branch).toContain('suppressRecoveryIntents(db,');
    // scoped to the verified draft's own stored contact, never typed values
    expect(branch).toContain('draftContact?.customer_phone');
    expect(branch).not.toMatch(/suppressRecoveryIntents\(db, \{[^}]*new_customer/);
  });
});

describe('recovery intents after a refused / established handoff (P1)', () => {
  test('suppressRecoveryIntents kills every open intent for the draft, phone and email — converted ones untouched', async () => {
    await suppressRecoveryIntents(db, { pricingEstimateId: 'pe-1', phone: '(941) 555-0101', email: 'Owner@Example.com' });
    const forIntents = ops.filter((o) => o.table === 'booking_intents');
    expect(forIntents.find((o) => o.op === 'whereNull').args).toEqual(['converted_at']);
    const groupedWhere = forIntents.filter((o) => ['orWhere', 'orWhereRaw'].includes(o.op)).map((o) => o.args);
    expect(groupedWhere).toEqual(expect.arrayContaining([
      ['pricing_estimate_id', 'pe-1'],
      [expect.stringMatching(/RIGHT\(regexp_replace/), ['9415550101']],
      ['LOWER(email) = ?', ['owner@example.com']],
    ]));
    expect(forIntents.find((o) => o.op === 'update').args[0]).toEqual(expect.objectContaining({ suppressed: true }));
  });

  test('the recovery cron only selects suppressed = false rows (both touches)', () => {
    const cron = fs.readFileSync(path.join(__dirname, '../services/booking-abandon-recovery.js'), 'utf8');
    const sms = cron.slice(cron.indexOf('async function runSmsStage'), cron.indexOf('async function runEmailStage'));
    const email = cron.slice(cron.indexOf('async function runEmailStage'), cron.indexOf('async function checkAbandoned'));
    for (const stage of [sms, email]) {
      const candidateQuery = stage.slice(0, stage.indexOf('.select('));
      expect(candidateQuery).toContain("whereNull('converted_at')");
      expect(candidateQuery).toContain("where('suppressed', false)");
    }
  });

  describe('POST /booking/capture-intent', () => {
    const captureHandler = (() => {
      const layer = bookingRouter.stack.find((i) => i.route?.path === '/capture-intent' && i.route.methods.post);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    })();
    const call = async (body) => {
      const req = { body, headers: {}, ip: '203.0.113.9' };
      const { _internals } = bookingRouter;
      // capture_token is IP-bound: mint with the same key the route derives.
      const key = _internals.captureIpKey(req);
      req.body = { capture_token: mintCaptureToken(key), ...body };
      let payload;
      const res = { json: (p) => { payload = p; return res; }, status: () => res };
      await captureHandler(req, res);
      return payload;
    };
    const base = () => ({
      session_id: 'sess-1',
      source: 'quote-wizard',
      pricing_estimate_id: 'pe-victim',
      estimate_token: mintEstimateHandoffToken('pe-victim'),
      slot_date: '2099-01-01',
      slot_start: '09:00',
      new_customer: { first_name: 'Pat', phone: '941-555-0101', email: 'pat@example.com', address_line1: '123 Palm Ave', zip: '34231' },
    });

    test('a handoff whose draft is linked to an ESTABLISHED customer stages nothing and retires any staged intent', async () => {
      firstResults.estimates = { customer_id: 'cust-established', customer_phone: '941-555-0101', customer_email: 'owner@example.com' };
      firstResults.customers = { pipeline_stage: 'active_customer' };
      const result = await call(base());
      expect(result).toEqual({ ok: true, skipped: 'contact_linked_established' });
      expect(ops.filter((o) => o.table === 'booking_intents' && o.op === 'insert')).toEqual([]);
      const upd = ops.find((o) => o.table === 'booking_intents' && o.op === 'update');
      expect(upd.args[0]).toEqual(expect.objectContaining({ suppressed: true }));
      // Scoped to the verified draft: its id and ITS stored contact — never
      // the phone/email the caller typed in the body.
      const scope = ops.filter((o) => o.table === 'booking_intents' && ['orWhere', 'orWhereRaw'].includes(o.op)).map((o) => o.args);
      expect(scope).toEqual(expect.arrayContaining([
        ['pricing_estimate_id', 'pe-victim'],
        [expect.stringMatching(/RIGHT\(regexp_replace/), ['9415550101']],
        ['LOWER(email) = ?', ['owner@example.com']],
      ]));
      expect(JSON.stringify(scope)).not.toContain('pat@example.com');
    });

    test('a lookup error fails closed — no row is staged', async () => {
      db.mockImplementationOnce(() => { throw new Error('boom'); });
      const result = await call(base());
      expect(result).toEqual({ ok: false, skipped: 'lookup_failed' });
      expect(ops.filter((o) => o.table === 'booking_intents')).toEqual([]);
    });

    test('a draft linked to the quoter\'s own pre-customer lead is NOT skipped by this check', async () => {
      firstResults.estimates = { customer_id: 'cust-lead' };
      firstResults.customers = { pipeline_stage: 'new_lead' };
      const result = await call(base());
      expect(result?.skipped).not.toBe('contact_linked_established');
      expect(ops.filter((o) => o.table === 'booking_intents' && o.op === 'update' && o.args[0]?.suppressed === true)).toEqual([]);
    });
  });
});
