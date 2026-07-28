// The contact fan-out rewrites lead/estimate/contract/promoter/booking/
// automation NAME and PHONE snapshots after a customer edit — only rows still
// carrying the customer's OLD value, only non-terminal rows, never on a
// removal. Origin: 2026-07-26, a customer's estimate kept rendering her old
// name after the Customer 360 record was corrected — the estimate page reads
// its own customer_name snapshot on every view and nothing ever rewrote it.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  propagateCustomerNameChange,
  propagateCustomerPhoneChange,
  nameKey,
  phoneKey,
} = require('../services/customer-contact-fanout');

/**
 * Minimal knex-shaped stub (mirrors customer-email-fanout.test.js). Per-table
 * config: rows (every awaited select) or rowsQueue (successive awaited
 * selects — the estimates table is selected twice: per-row pass, then the
 * preparedFor repair pass), firstQueue (successive first() results),
 * updateCount (what update() resolves, default 1). Builders are thenable so
 * they work both awaited and embedded. Mutations recorded in conn.__calls.
 */
function makeConn(cfg = {}) {
  const calls = [];
  const conn = (table) => {
    const t = cfg[table] || {};
    const qb = {
      where: (arg) => { calls.push({ table, op: 'where', arg }); return qb; },
      whereRaw: (sql, bindings) => { calls.push({ table, op: 'whereRaw', arg: { sql, bindings } }); return qb; },
      orWhereRaw: (sql, bindings) => { calls.push({ table, op: 'orWhereRaw', arg: { sql, bindings } }); return qb; },
      whereNot: (arg) => { calls.push({ table, op: 'whereNot', arg }); return qb; },
      whereNull: () => qb,
      whereNotExists: () => { calls.push({ table, op: 'whereNotExists' }); return qb; },
      whereIn: (col, vals) => { calls.push({ table, op: 'whereIn', arg: { col, vals } }); return qb; },
      whereNotIn: (col, vals) => { calls.push({ table, op: 'whereNotIn', arg: { col, vals } }); return qb; },
      select: () => qb,
      first: () => Promise.resolve((t.firstQueue || []).shift() ?? null),
      update: (patch) => {
        calls.push({ table, op: 'update', arg: patch });
        if (t.updateRejectQueue && t.updateRejectQueue.length) return Promise.reject(t.updateRejectQueue.shift());
        return Promise.resolve(t.updateCount ?? 1);
      },
      then: (resolve, reject) => Promise.resolve(
        t.rowsQueue ? ((t.rowsQueue.shift()) ?? []) : (t.rows || [])
      ).then(resolve, reject),
    };
    return qb;
  };
  conn.raw = (sql, bindings) => ({ __raw: sql, __bindings: bindings });
  // Savepoint stand-in: the promoter sync wraps its guarded update in a
  // nested transaction so a raced 23505 can't poison the caller's trx.
  conn.transaction = (cb) => Promise.resolve(cb(conn));
  conn.__calls = calls;
  conn.__updates = (table) => calls.filter((c) => c.table === table && c.op === 'update');
  return conn;
}

const NAME_BEFORE = { id: 'cust-1', first_name: 'Kathy', last_name: 'Nunez' };
const NAME_AFTER = { id: 'cust-1', first_name: 'Cathy', last_name: 'Nunes Furao' };
const ZERO_NAME_COUNTS = { leads: 0, estimates: 0, enrollments: 0, newsletter: 0, promoters: 0, contracts: 0, bookingIntents: 0, templateRuns: 0 };

describe('propagateCustomerNameChange', () => {
  test('syncs every open snapshot copy, the proposal preparedFor, and queued payload greetings', async () => {
    const conn = makeConn({
      estimates: {
        rowsQueue: [[{
          id: 'est-1',
          customer_name: 'Kathy Nunez',
          estimate_data: { proposal: { preparedFor: 'Kathy Nunez' }, proposalDelivery: { sentAt: 'x' } },
        }], []],
      },
      email_template_automation_runs: {
        rows: [{ id: 'run-1', payload: { first_name: 'Kathy', customer_name: 'Kathy Nunez', service: 'pest' } }],
      },
    });
    const counts = await propagateCustomerNameChange({ before: NAME_BEFORE, after: NAME_AFTER }, conn);
    // estimates = the open per-row sync + the 'sending' column-only sync.
    expect(counts).toEqual({ leads: 1, estimates: 2, enrollments: 1, newsletter: 1, promoters: 1, contracts: 1, bookingIntents: 1, templateRuns: 1 });

    const leadSync = conn.__updates('leads')[0].arg;
    expect(leadSync.first_name).toBe('Cathy');
    expect(leadSync.last_name).toBe('Nunes Furao');

    const estSync = conn.__updates('estimates')[0].arg;
    expect(estSync.customer_name).toBe('Cathy Nunes Furao');
    // The proposal's own preparedFor copy moves under the same guard, and the
    // stale "PDF emailed" marker (a PDF that printed the OLD name) drops.
    expect(estSync.estimate_data.__raw).toContain('{proposal,preparedFor}');
    expect(estSync.estimate_data.__raw).toContain("- 'proposalDelivery'");
    expect(estSync.estimate_data.__bindings).toEqual(['Cathy Nunes Furao']);
    // The guarded update re-asserts the preparedFor the patch was decided
    // from — a concurrent proposal save must not be rewritten from a stale read.
    expect(conn.__calls.some((c) => c.table === 'estimates' && c.op === 'whereRaw'
      && c.arg.sql.includes('preparedFor') && c.arg.bindings[0] === 'Kathy Nunez')).toBe(true);

    // The trailing catch-up (in-flight 'sending' rows + rows that raced past
    // the per-row pass) is COLUMN-ONLY — never an estimate_data write under
    // an active send claim.
    const sendingSync = conn.__updates('estimates')[1].arg;
    expect(sendingSync.customer_name).toBe('Cathy Nunes Furao');
    expect(sendingSync.estimate_data).toBeUndefined();
    expect(conn.__calls.some((c) => c.table === 'estimates' && c.op === 'whereIn'
      && c.arg.vals.includes('sending'))).toBe(true);

    expect(conn.__updates('automation_enrollments')[0].arg.first_name).toBe('Cathy');
    expect(conn.__updates('newsletter_subscribers')[0].arg.first_name).toBe('Cathy');
    const promoterSync = conn.__updates('referral_promoters')[0].arg;
    expect(promoterSync.first_name).toBe('Cathy');
    expect(promoterSync.last_name).toBe('Nunes Furao');
    expect(conn.__updates('customer_contracts')[0].arg.recipient_name).toBe('Cathy Nunes Furao');
    expect(conn.__updates('booking_intents')[0].arg.first_name).toBe('Cathy');

    // Payload greeting variables carrying the old name are rewritten too —
    // the executor renders the body from the stored payload. Unrelated keys
    // ride along untouched.
    const runSync = conn.__updates('email_template_automation_runs')[0].arg;
    expect(JSON.parse(runSync.payload)).toEqual({ first_name: 'Cathy', customer_name: 'Cathy Nunes Furao', service: 'pest' });
  });

  test('matches copies by the OLD name only (case-insensitive keys)', async () => {
    const conn = makeConn();
    await propagateCustomerNameChange({ before: NAME_BEFORE, after: NAME_AFTER }, conn);
    const leadFilters = conn.__calls.filter((c) => c.table === 'leads' && c.op === 'whereRaw');
    expect(leadFilters.map((c) => c.arg.bindings[0])).toEqual(['kathy', 'nunez']);
    const estFilter = conn.__calls.find((c) => c.table === 'estimates' && c.op === 'whereRaw');
    expect(estFilter.arg.bindings).toEqual(['kathy nunez']);
  });

  test('a case-only fix is a real display change and propagates', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerNameChange({
      before: { id: 'cust-1', first_name: 'cathy', last_name: 'nunes furao' },
      after: { id: 'cust-1', first_name: 'Cathy', last_name: 'Nunes Furao' },
    }, conn);
    expect(counts.leads).toBe(1);
    expect(conn.__updates('leads')[0].arg.first_name).toBe('Cathy');
  });

  test('a custom preparedFor leaves the proposal and its delivery marker untouched (column-only)', async () => {
    // The PDF prints the CUSTOM addressee (a landlord's estimate addressed to
    // the tenant) — the column rewrite doesn't change the PDF, so the "PDF
    // emailed" state must survive.
    const conn = makeConn({
      estimates: {
        rows: [{
          id: 'est-1',
          customer_name: 'Kathy Nunez',
          estimate_data: { proposal: { preparedFor: 'Tenant Tina' }, proposalDelivery: { sentAt: 'x' } },
        }],
      },
    });
    await propagateCustomerNameChange({ before: NAME_BEFORE, after: NAME_AFTER }, conn);
    const estSync = conn.__updates('estimates')[0].arg;
    expect(estSync.customer_name).toBe('Cathy Nunes Furao');
    expect(estSync.estimate_data).toBeUndefined();
  });

  test('a case-only edit never touches an already-correct estimate (delivery marker survives)', async () => {
    // A case-only edit's OLD key also matches rows already holding the exact
    // NEW spelling — those get no write at all, so their "PDF emailed" state
    // is preserved.
    const conn = makeConn({
      estimates: {
        rows: [{
          id: 'est-1',
          customer_name: 'Cathy Nunes Furao',
          estimate_data: { proposal: { preparedFor: 'Cathy Nunes Furao' }, proposalDelivery: { sentAt: 'x' } },
        }],
      },
    });
    await propagateCustomerNameChange({
      before: { id: 'cust-1', first_name: 'cathy', last_name: 'nunes furao' },
      after: { id: 'cust-1', first_name: 'Cathy', last_name: 'Nunes Furao' },
    }, conn);
    // The only estimates write allowed is the column-only 'sending' sync —
    // nothing may carry an estimate_data patch.
    expect(conn.__updates('estimates').every((u) => u.arg.estimate_data === undefined)).toBe(true);
  });

  test('the repair pass heals a stale preparedFor even when the column already synced', async () => {
    // A row that raced through 'sending' during an earlier fan-out has its
    // column corrected but the proposal still addressed to the old name —
    // the repair pass keys on the proposal's own copy and fixes it.
    const conn = makeConn({
      estimates: {
        rowsQueue: [[], [{
          id: 'est-2',
          status: 'sent',
          estimate_data: { proposal: { preparedFor: 'Kathy Nunez' }, proposalDelivery: { sentAt: 'x' } },
        }]],
      },
    });
    const counts = await propagateCustomerNameChange({ before: NAME_BEFORE, after: NAME_AFTER }, conn);
    expect(counts.estimates).toBe(2); // catch-up + repair
    const repairSync = conn.__updates('estimates')[1].arg;
    expect(repairSync.customer_name).toBeUndefined();
    // The keep-or-drop decision for the delivery marker is made IN the update
    // from the status AT UPDATE TIME: a 'sending' row keeps the marker its
    // in-flight send is about to stamp; every other state drops the stale one.
    expect(repairSync.estimate_data.__raw).toContain("CASE WHEN status = 'sending'");
    expect(repairSync.estimate_data.__raw).toContain('{proposal,preparedFor}');
    expect(repairSync.estimate_data.__raw).toContain("- 'proposalDelivery' END");
    expect(repairSync.estimate_data.__bindings).toEqual(['Cathy Nunes Furao', 'Cathy Nunes Furao']);
  });

  test('no-ops when the name did not actually change', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerNameChange({
      before: { id: 'cust-1', first_name: 'Cathy', last_name: 'Nunes Furao' },
      after: { id: 'cust-1', first_name: 'Cathy', last_name: '  Nunes  Furao ' },
    }, conn);
    expect(counts).toEqual(ZERO_NAME_COUNTS);
    expect(conn.__calls).toHaveLength(0);
  });

  test('a name removal is never propagated', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerNameChange({
      before: NAME_BEFORE,
      after: { id: 'cust-1', first_name: '', last_name: '' },
    }, conn);
    expect(counts).toEqual(ZERO_NAME_COUNTS);
    expect(conn.__calls).toHaveLength(0);
  });

  test('leaves a moved proposal alone and falls back to the column-only sync', async () => {
    // The guarded update returns 0 (a proposal save landed between select and
    // update) — the fallback syncs the column and drops the stale delivery
    // marker without touching the fresh proposal content.
    const conn = makeConn({
      estimates: {
        rows: [{ id: 'est-1', customer_name: 'Kathy Nunez', estimate_data: { proposal: { preparedFor: 'Kathy Nunez' } } }],
        updateCount: 0,
      },
    });
    await propagateCustomerNameChange({ before: NAME_BEFORE, after: NAME_AFTER }, conn);
    const estUpdates = conn.__updates('estimates');
    // guarded attempt, fallback attempt, then the 'sending' sync. The
    // fallback is COLUMN-ONLY — the concurrent save's fresh proposal (and any
    // delivery marker it stamped) must not be rewritten from a stale read.
    expect(estUpdates[1].arg.customer_name).toBe('Cathy Nunes Furao');
    expect(estUpdates[1].arg.estimate_data).toBeUndefined();
  });
});

const PHONE_BEFORE = { id: 'cust-1', phone: '(941) 555-1234' };
const PHONE_AFTER = { id: 'cust-1', phone: '+19415556789' };
const ZERO_PHONE_COUNTS = { leads: 0, estimates: 0, contracts: 0, promoters: 0, promoterSkipped: 0, bookingIntents: 0, scheduledSms: 0 };

describe('propagateCustomerPhoneChange', () => {
  test('syncs lead, estimate, contract, promoter, and booking-intent copies', async () => {
    const conn = makeConn({
      referral_promoters: { firstQueue: [{ id: 7, customer_phone: '9415551234' }] },
    });
    const counts = await propagateCustomerPhoneChange({ before: PHONE_BEFORE, after: PHONE_AFTER }, conn);
    expect(counts).toEqual({ leads: 1, estimates: 1, contracts: 1, promoters: 1, promoterSkipped: 0, bookingIntents: 1, scheduledSms: 1 });

    expect(conn.__updates('leads')[0].arg.phone).toBe('+19415556789');
    expect(conn.__updates('estimates')[0].arg.customer_phone).toBe('+19415556789');
    expect(conn.__updates('customer_contracts')[0].arg.recipient_phone).toBe('+19415556789');
    expect(conn.__updates('referral_promoters')[0].arg.customer_phone).toBe('+19415556789');
    expect(conn.__updates('booking_intents')[0].arg.phone).toBe('+19415556789');
    // Queued admin SMS still awaiting their cron claim retarget too — the
    // scheduler sends to the frozen to_phone snapshot.
    expect(conn.__updates('sms_log')[0].arg.to_phone).toBe('+19415556789');
  });

  test('matches copies by NANP digits, both stored spellings', async () => {
    const conn = makeConn();
    await propagateCustomerPhoneChange({ before: PHONE_BEFORE, after: PHONE_AFTER }, conn);
    const leadFilter = conn.__calls.find((c) => c.table === 'leads' && c.op === 'whereRaw');
    expect(leadFilter.arg.bindings).toEqual(['9415551234', '19415551234']);
  });

  test('skips the promoter sync when another promoter row already holds the new number', async () => {
    // Promoter rows carry reward balances — a collision is never merged by a
    // fan-out; the update's NOT EXISTS guard makes it a no-op (n=0), logged
    // and left for the owner instead of raising 23505 into the caller's
    // transaction.
    const conn = makeConn({
      referral_promoters: {
        firstQueue: [{ id: 7, customer_phone: '9415551234' }],
        updateCount: 0,
      },
    });
    const counts = await propagateCustomerPhoneChange({ before: PHONE_BEFORE, after: PHONE_AFTER }, conn);
    expect(counts.promoters).toBe(0);
    expect(counts.promoterSkipped).toBe(1);
    // The conflict check is INSIDE the update statement, not a separate read.
    expect(conn.__calls.some((c) => c.table === 'referral_promoters' && c.op === 'whereNotExists')).toBe(true);
  });

  test('a raced promoter unique violation is absorbed by the savepoint, not thrown at the caller', async () => {
    // A conflict row can commit mid-statement past the NOT EXISTS guard; the
    // 23505 must resolve to the designed skip instead of poisoning the
    // caller's transaction (whose generic handler would misreport a
    // phone-only edit as an address collision).
    const conn = makeConn({
      referral_promoters: {
        firstQueue: [{ id: 7, customer_phone: '9415551234' }],
        updateRejectQueue: [Object.assign(new Error('duplicate key'), { code: '23505' })],
      },
    });
    const counts = await propagateCustomerPhoneChange({ before: PHONE_BEFORE, after: PHONE_AFTER }, conn);
    expect(counts.promoters).toBe(0);
    expect(counts.promoterSkipped).toBe(1);
    // Everything else still synced — the edit survives.
    expect(counts.leads).toBe(1);
  });

  test('no-ops on a formatting-only change (same digits)', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerPhoneChange({
      before: { id: 'cust-1', phone: '+19415551234' },
      after: { id: 'cust-1', phone: '(941) 555-1234' },
    }, conn);
    expect(counts).toEqual(ZERO_PHONE_COUNTS);
    expect(conn.__calls).toHaveLength(0);
  });

  test('a supported international new number propagates (repo preserves non-NANP phones)', async () => {
    const conn = makeConn();
    const counts = await propagateCustomerPhoneChange({
      before: PHONE_BEFORE,
      after: { id: 'cust-1', phone: '+442079460958' },
    }, conn);
    expect(counts.leads).toBe(1);
    expect(conn.__updates('leads')[0].arg.phone).toBe('+442079460958');
  });

  test('a removal or partial new phone is never propagated', async () => {
    const conn = makeConn();
    expect(await propagateCustomerPhoneChange({
      before: PHONE_BEFORE, after: { id: 'cust-1', phone: '' },
    }, conn)).toEqual(ZERO_PHONE_COUNTS);
    expect(await propagateCustomerPhoneChange({
      before: PHONE_BEFORE, after: { id: 'cust-1', phone: '555-123' },
    }, conn)).toEqual(ZERO_PHONE_COUNTS);
    expect(conn.__calls).toHaveLength(0);
  });
});

describe('keys', () => {
  test('nameKey collapses whitespace and case', () => {
    expect(nameKey('  Cathy   Nunes  Furao ')).toBe('cathy nunes furao');
    expect(nameKey(null)).toBe('');
  });

  test('phoneKey strips to NANP digits', () => {
    expect(phoneKey('+1 (941) 555-1234')).toBe('9415551234');
    expect(phoneKey('941.555.1234')).toBe('9415551234');
    expect(phoneKey(null)).toBe('');
  });
});
