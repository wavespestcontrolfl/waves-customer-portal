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
      if (typeof args[0] === 'function') { args[0].call(q, q); return q; }
      ops.push({ table, op: name, args });
      return q;
    };
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere',
      'orWhereRaw', 'andWhere', 'join', 'leftJoin', 'forShare', 'forUpdate', 'orderBy', 'limit', 'select']) q[m] = record(m);
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
  id: ROOT, pipeline_stage: 'active_customer', phone: '(941) 555-0101', email: 'owner@example.com', ...over,
});

// Fake trx: customers read (forShare rows), consumed-booking lookup, draft row.
function fakeTrx({ customers, consumed = null, draft = null }) {
  const calls = [];
  const trx = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'andWhere', 'orderBy', 'limit', 'join', 'select']) q[m] = (...a) => { calls.push([table, m, ...a]); return q; };
    q.forShare = () => { calls.push([table, 'forShare']); return q; };
    // customers: the draft-linked ROOT row is read with .first(); the account
    // siblings come back from the list query (same shape the shared loader uses).
    q.first = async () => {
      if (table === 'estimates') return draft;
      if (table === 'customers') return customers.find((r) => r.id === ROOT) || null;
      return consumed;
    };
    q.then = (ok, err) => Promise.resolve(customers.filter((r) => r.id !== ROOT)).then(ok, err);
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

  test('account-wide: a lead ROOT row under an account holding an ESTABLISHED sibling property is refused (r3 P1)', async () => {
    const trx = fakeTrx({ customers: [
      customer({ id: ROOT, pipeline_stage: 'new_lead', account_id: 'acct-1' }),
      customer({ id: 'cust-sibling', pipeline_stage: 'active_customer', account_id: 'acct-1' }),
    ] });
    await expect(run(trx, { phone: '941-555-0101' })).rejects.toEqual(REFUSED);
    // the sibling read is the same account resolution the gate uses, share-locked
    const sibQuery = trx.calls.filter((c) => c[0] === 'customers');
    expect(sibQuery.some((c) => c[1] === 'forShare')).toBe(true);
  });

  test('no sibling cap: an established row far down a large account still blocks (r3 P1 follow-up)', async () => {
    const leads = Array.from({ length: 40 }, (_, i) => customer({ id: `lead-${i}`, pipeline_stage: 'new_lead', account_id: 'acct-1' }));
    const trx = fakeTrx({ customers: [
      customer({ id: ROOT, pipeline_stage: 'new_lead', account_id: 'acct-1' }),
      ...leads,
      customer({ id: 'cust-established-41st', pipeline_stage: 'active_customer', account_id: 'acct-1' }),
    ] });
    await expect(run(trx, { phone: '941-555-0101' })).rejects.toEqual(REFUSED);
    expect(trx.calls.some((c) => c[0] === 'customers' && c[1] === 'limit')).toBe(false);
    const loader = fs.readFileSync(path.join(__dirname, '../services/booking-contact-linked-handoff.js'), 'utf8');
    expect(loader).not.toMatch(/\.limit\(/);
  });

  test('archived customer rows block — archiving can never re-open the handoff (r5 P1)', async () => {
    const ARCHIVED = '2026-09-01T00:00:00Z';
    // archived root, still stage new_lead
    await expect(run(fakeTrx({ customers: [customer({ id: ROOT, pipeline_stage: 'new_lead', deleted_at: ARCHIVED })] }), {})).rejects.toEqual(REFUSED);
    // archived SIBLING with a lead stage
    await expect(run(fakeTrx({ customers: [
      customer({ id: ROOT, pipeline_stage: 'new_lead', account_id: 'acct-1' }),
      customer({ id: 'cust-sibling', pipeline_stage: 'new_lead', account_id: 'acct-1', deleted_at: ARCHIVED }),
    ] }), {})).rejects.toEqual(REFUSED);
    // archived established sibling
    await expect(run(fakeTrx({ customers: [
      customer({ id: ROOT, pipeline_stage: 'new_lead', account_id: 'acct-1' }),
      customer({ id: 'cust-sibling', pipeline_stage: 'active_customer', account_id: 'acct-1', deleted_at: ARCHIVED }),
    ] }), {})).rejects.toEqual(REFUSED);
  });

  test('a draft whose customer row is missing is blocked (fail closed)', async () => {
    await expect(run(fakeTrx({ customers: [] }), {})).rejects.toEqual(REFUSED);
  });

  test('the shared loader reads the root and siblings WITHOUT deleted/inactive filters', () => {
    const loader = fs.readFileSync(path.join(__dirname, '../services/booking-contact-linked-handoff.js'), 'utf8');
    const body = loader.slice(loader.indexOf('async function loadContactLinkedAccountRows'), loader.indexOf('const isEstablishedCustomerRow'));
    expect(body).not.toMatch(/deleted_at'\)|whereNull|'active'/);
  });

  test('account with only lead rows → allowed', async () => {
    const trx = fakeTrx({ customers: [
      customer({ id: ROOT, pipeline_stage: 'new_lead', account_id: 'acct-1' }),
      customer({ id: 'cust-sibling', pipeline_stage: 'contacted', account_id: 'acct-1' }),
    ] });
    await expect(run(trx, { phone: '941-555-0101' })).resolves.toBeUndefined();
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

    test('draft-linking contact belongs to the ROOT row A while the address bound property row B — retry still allowed (P2)', async () => {
      const trx = fakeTrx({
        customers: [
          customer({ id: ROOT, pipeline_stage: 'won', phone: '(941) 555-0101', email: 'root@example.com' }),
          customer({ id: BOUND, pipeline_stage: 'won', phone: '(941) 555-0999', email: 'bound@example.com' }),
        ],
        consumed: { id: 'ss-1' }, // under BOUND for this slot
        draft: { customer_email: 'root@example.com' },
      });
      await expect(run(trx, { phone: '941-555-0101' })).resolves.toBeUndefined();
      await expect(run(trx, { phone: '941-555-0177', email: 'root@example.com' })).resolves.toBeUndefined();
      // B's own contact is not the linking factor
      await expect(run(trx, { phone: '941-555-0999' })).rejects.toEqual(REFUSED);
      // and the consumed booking under B is still required
      const noBooking = fakeTrx({
        customers: [customer({ id: ROOT, pipeline_stage: 'won' }), customer({ id: BOUND, pipeline_stage: 'won' })],
        consumed: null,
      });
      await expect(run(noBooking, { phone: '941-555-0101' })).rejects.toEqual(REFUSED);
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
    // scoped to the verified draft id only — no contact of any kind
    expect(branch).toContain('suppressRecoveryIntents(db, { pricingEstimateId: pricing_estimate_id })');
  });
});

describe('recovery intents after a refused / established handoff (P1)', () => {
  test('suppressRecoveryIntents retires open intents for the verified draft id ONLY — no phone/email widening, converted rows untouched', async () => {
    await suppressRecoveryIntents(db, { pricingEstimateId: 'pe-1', phone: '(941) 555-0101', email: 'Owner@Example.com' });
    const forIntents = ops.filter((o) => o.table === 'booking_intents');
    expect(forIntents.find((o) => o.op === 'whereNull').args).toEqual(['converted_at']);
    expect(forIntents.filter((o) => o.op === 'where').map((o) => o.args)).toEqual([['pricing_estimate_id', 'pe-1']]);
    // Draft contact and typed contact are both anonymous input: neither may
    // widen suppression to another person's intents (pre-push audit P1 x2).
    expect(forIntents.filter((o) => ['orWhere', 'orWhereRaw', 'whereRaw'].includes(o.op))).toEqual([]);
    expect(forIntents.find((o) => o.op === 'update').args[0]).toEqual(expect.objectContaining({ suppressed: true }));
    ops.length = 0;
    await suppressRecoveryIntents(db, { pricingEstimateId: null });
    expect(ops).toEqual([]); // no verified draft id → nothing suppressed
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
      let status = 200;
      const res = { json: (p) => { payload = p; return res; }, status: (c) => { status = c; return res; } };
      await captureHandler(req, res);
      return Object.assign({}, payload, { __status: status });
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

    const suppressedForDraft = () => ops.filter((o) => o.table === 'booking_intents' && o.op === 'update' && o.args[0]?.suppressed === true);

    test('every accepted capture returns ONE constant response — lead-linked, established-linked, pre-seeded row, lookup error (r5 P0)', async () => {
      const responses = {};
      // 1. ordinary: draft linked to the quoter's own pre-customer lead
      firstResults.estimates = { customer_id: 'cust-lead' };
      firstResults.customers = { id: 'cust-lead', pipeline_stage: 'new_lead' };
      responses.lead = await call(base());
      expect(suppressedForDraft()).toEqual([]);
      ops.length = 0;
      // 2. established-linked
      firstResults.customers = { id: 'cust-lead', pipeline_stage: 'active_customer' };
      responses.established = await call(base());
      expect(suppressedForDraft().length).toBe(1);
      expect(ops.find((o) => o.table === 'booking_intents' && o.op === 'where' && o.args[0] === 'pricing_estimate_id').args).toEqual(['pricing_estimate_id', 'pe-victim']);
      ops.length = 0;
      // 3. pre-seeded un-suppressed open intent for the same session/phone
      firstResults.customers = { id: 'cust-lead', pipeline_stage: 'new_lead' };
      firstResults.booking_intents = { id: 'bi-existing' };
      responses.preSeeded = await call(base());
      delete firstResults.booking_intents;
      ops.length = 0;
      // 4. lookup error
      db.mockImplementationOnce(() => { throw new Error('boom'); });
      responses.lookupError = await call(base());
      expect(suppressedForDraft().length).toBe(1);

      const wire = (r) => JSON.stringify(r);
      const expected = wire({ ok: true, __status: 200 });
      for (const [name, r] of Object.entries(responses)) expect([name, wire(r)]).toEqual([name, expected]);
      expect(expected).not.toMatch(/skipped|intent_id|created|updated|contact_linked/);
    });

    test('account-wide: a lead root row whose account holds an established sibling property is treated as established', async () => {
      firstResults.estimates = { customer_id: 'cust-lead' };
      firstResults.customers = { id: 'cust-lead', account_id: 'acct-1', pipeline_stage: 'new_lead' };
      firstResults['customers:list'] = [{ id: 'cust-sibling', account_id: 'acct-1', pipeline_stage: 'active_customer' }];
      const result = await call(base());
      expect(result.skipped).not.toBe('contact_linked_established');
      expect(suppressedForDraft().length).toBe(1);
    });

    test('the write side: a linked-established capture is born suppressed and finds its own suppressed row (source guard)', () => {
      const src = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');
      expect(src).toContain('...(linkedEstablished ? { suppressed: true } : {})');
      expect(src).toContain(".where('suppressed', linkedEstablished)");
      expect(src).not.toContain("skipped: 'contact_linked_established'");
    });

    test('the handler has exactly one success response (`accepted`) plus the request-shape 400 (source guard)', () => {
      const src = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');
      const start = src.indexOf("router.post('/capture-intent'");
      const handler = src.slice(start, src.indexOf('// GET /api/booking/embed-snippet'));
      expect(handler.match(/res\.json\(/g)).toHaveLength(1);
      expect(handler).toContain("res.json({ ok: true })");
      expect(handler.match(/res\.status\(\d+\)/g)).toEqual(['res.status(400)']);
      expect(handler).not.toMatch(/res\.json\([^)]*(intent_id|created|updated)/);
    });

    test('gate off (flow still books): no skip, no suppression — recovery keeps working', async () => {
      const { isEnabled } = require('../config/feature-gates');
      isEnabled.mockImplementation((name) => name !== 'bookingCustomersOnly');
      try {
        firstResults.estimates = { customer_id: 'cust-established' };
        firstResults.customers = { pipeline_stage: 'active_customer' };
        const result = await call(base());
        expect(result?.skipped).not.toBe('contact_linked_established');
        expect(ops.filter((o) => o.table === 'booking_intents' && o.op === 'update' && o.args[0]?.suppressed === true)).toEqual([]);
        expect(ops.filter((o) => o.table === 'estimates')).toEqual([]);
      } finally {
        isEnabled.mockImplementation(() => true);
      }
    });

    test('a draft linked to the quoter\'s own pre-customer lead is NOT skipped by this check', async () => {
      firstResults.estimates = { customer_id: 'cust-lead' };
      firstResults.customers = { id: 'cust-lead', pipeline_stage: 'new_lead' };
      const result = await call(base());
      expect(result?.skipped).not.toBe('contact_linked_established');
      expect(ops.filter((o) => o.table === 'booking_intents' && o.op === 'update' && o.args[0]?.suppressed === true)).toEqual([]);
    });
  });
});
