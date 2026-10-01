/**
 * Owner 2026-10-01 ("fix it", superseding the morning's pool ruling): the provider-boundary Zelle recheck runs on the send's OWN
 * connection - every read zelleInvoiceStillEligible makes (deposit settlement, payer ownership, saved-method requirement, credit,
 * siblings, saved-card charge reconciliation) goes through the `dbh` it is handed, never a second pool connection, so two overlapping
 * sends on a pool of 2 cannot stall each other. The shared pool is made to throw on any use: the check must still answer.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const pool = jest.fn((table) => { throw new Error(`shared pool used for ${table}`); });
  pool.raw = jest.fn(() => { throw new Error('shared pool used (raw)'); });
  pool.transaction = jest.fn(() => { throw new Error('shared pool used (transaction)'); });
  pool.fn = { now: () => 'now()' };
  return pool;
});

// A connection that answers every query with the given table rows (first() = first row, a list read = all rows).
function connection(rows = {}) {
  const reads = [];
  const dbh = jest.fn((table) => {
    const name = String(table).split(' ')[0];
    reads.push(name);
    const q = {};
    const chain = () => q;
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereNull', 'orWhereNotNull',
      'orWhereIn', 'andWhere', 'select', 'orderBy', 'limit', 'offset', 'leftJoin', 'join', 'forUpdate', 'forShare', 'noWait', 'modify', 'clone', 'distinct', 'groupBy', 'max', 'sum', 'count', 'pluck']) q[m] = jest.fn(chain);
    q.first = jest.fn(async () => (rows[name] || [])[0]);
    q.then = (res, rej) => Promise.resolve(rows[name] || []).then(res, rej);
    q.catch = (h) => Promise.resolve(rows[name] || []).catch(h);
    return q;
  });
  dbh.raw = jest.fn(async () => ({ rows: [] }));
  dbh.fn = { now: () => 'now()' };
  dbh.schema = { hasColumn: jest.fn(async () => true), hasTable: jest.fn(async () => true) };
  dbh.reads = reads;
  return dbh;
}

describe('the Zelle eligibility recheck reads only through the connection it is given', () => {
  const INV = { id: 'inv-1', customer_id: 'c1', status: 'sent', total: 95, credit_applied: 0, payer_id: null, payer_statement_id: null, scheduled_service_id: null, stripe_payment_intent_id: null, scheduled_send_error: null };
  beforeEach(() => { process.env.ZELLE_RECIPIENT = 'pay@example.com'; });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; });

  test('an eligible invoice: answered on the handed connection alone (the shared pool would throw)', async () => {
    const { zelleInvoiceStillEligible } = require('../services/sms-amount-recheck');
    const dbh = connection({ invoices: [INV], customers: [{ id: 'c1', payer_id: null, billing_mode: 'monthly_membership', monthly_rate: 0, account_credits: 0, auto_apply_account_credit: false }] });
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh })).resolves.toEqual({ eligible: true });
    expect(dbh.reads).toEqual(expect.arrayContaining(['invoices', 'customers']));
  });

  test('a saved-card charge in flight (read on the handed connection) still withholds Zelle', async () => {
    const { zelleInvoiceStillEligible } = require('../services/sms-amount-recheck');
    const dbh = connection({
      invoices: [INV],
      customers: [{ id: 'c1', payer_id: null, billing_mode: 'monthly_membership', monthly_rate: 0, account_credits: 0, auto_apply_account_credit: false }],
      stripe_invoice_charge_attempts: [{ id: 'a1', status: 'claimed', stripe_payment_intent_id: null, idempotency_key: 'k', submitted_at: null, created_at: new Date() }],
    });
    const verdict = await zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh });
    expect(verdict.eligible).toBe(false);
    expect(dbh.reads).toContain('stripe_invoice_charge_attempts');
  });
});
