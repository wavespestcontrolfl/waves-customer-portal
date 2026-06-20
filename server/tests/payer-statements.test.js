// Unit tests for the Phase-2 statement accrual core (get-or-create + rollup).
// The db is mocked as a per-table chainable so we exercise the control flow:
// reuse the open statement, create one when none, advance past a closed period,
// converge on a race, and no-op the rollup once frozen.

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const fn = jest.fn((...args) => mockDbHandler(...args));
  fn.raw = jest.fn(async () => ({}));        // pg_advisory_xact_lock — resolves
  fn.fn = { now: jest.fn(() => 'NOW') };
  return fn;
});
jest.mock('../utils/datetime-et', () => ({
  // Deterministic period: offset 0 = Jan, +1 = Feb, … (avoids real Date()).
  etMonthStart: (_d, offset = 0) => `2026-${String(1 + offset).padStart(2, '0')}-01`,
  etMonthEnd: (_d, offset = 0) => `2026-${String(1 + offset).padStart(2, '0')}-28`,
  // finalize: due_date = etDateString(addETDays(date, termDays)) → deterministic.
  addETDays: (_d, days) => ({ __days: days }),
  etDateString: (d) => (d && d.__days != null ? `due+${d.__days}` : '2026-01-15'),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockGetPayer = jest.fn(async () => ({ id: 7, active: true, company_name: 'Homes by West Bay', ap_email: 'ap@westbay.com' }));
jest.mock('../services/payer', () => ({
  getPayer: (...a) => mockGetPayer(...a),
  payerSnapshot: (p) => ({ company_name: p.company_name, ap_email: p.ap_email }),
}));

const db = require('../models/db');
const { getOrCreateOpenStatement, rollupStatement, finalizeStatement } = require('../services/payer-statements');

beforeEach(() => { jest.clearAllMocks(); });

// A statement-table builder whose .first() answers the two queries the
// get-or-create makes per period — the open lookup and the closed lookup —
// from a per-period script, and records inserts.
function statementsTable(script, inserts) {
  let where = null;
  const b = {
    where(criteria) { where = criteria; return b; },
    whereNot() { b._whereNot = true; return b; },
    async first() {
      const period = where.period_start;
      const plan = script[period] || {};
      if (b._whereNot) { b._whereNot = false; return plan.closed || undefined; }
      // status:'open' lookup
      return where.status === 'open' ? (plan.open || undefined) : undefined;
    },
    insert(payload) {
      return { returning: async () => { const row = { id: 900 + inserts.length, ...payload }; inserts.push(row); return [row]; } };
    },
  };
  return b;
}

describe('getOrCreateOpenStatement', () => {
  test('reuses the existing open statement for the period', async () => {
    const inserts = [];
    mockDbHandler = (t) => statementsTable({ '2026-01-01': { open: { id: 1, status: 'open' } } }, inserts);
    const out = await getOrCreateOpenStatement({ payerId: 7, termsSnapshot: 'net30' });
    expect(out).toEqual({ id: 1, status: 'open' });
    expect(inserts).toHaveLength(0);
    expect(db.raw).toHaveBeenCalled(); // advisory lock taken
  });

  test('creates an open statement when none exists for the period', async () => {
    const inserts = [];
    mockDbHandler = (t) => statementsTable({ '2026-01-01': {} }, inserts);
    const out = await getOrCreateOpenStatement({ payerId: 7, termsSnapshot: 'net15' });
    expect(inserts).toHaveLength(1);
    expect(out).toMatchObject({ payer_id: 7, period_start: '2026-01-01', status: 'open', terms_snapshot: 'net15' });
    expect(out.token).toEqual(expect.any(String));
  });

  test('advances to the next period when the month already closed', async () => {
    const inserts = [];
    // Jan has a non-open (sent) statement → advance to Feb and open there.
    mockDbHandler = (t) => statementsTable({
      '2026-01-01': { closed: { id: 5 } },
      '2026-02-01': {},
    }, inserts);
    const out = await getOrCreateOpenStatement({ payerId: 7, termsSnapshot: 'net30' });
    expect(out.period_start).toBe('2026-02-01');
    expect(inserts).toHaveLength(1);
  });

  test('converges on a concurrent-insert race via the partial unique index', async () => {
    const inserts = [];
    let firstOpenLookup = true;
    const raced = { id: 42, status: 'open' };
    mockDbHandler = () => ({
      where(c) { this._c = c; return this; },
      whereNot() { this._wn = true; return this; },
      async first() {
        if (this._wn) { this._wn = false; return undefined; }
        if (this._c.status === 'open') {
          if (firstOpenLookup) { firstOpenLookup = false; return undefined; } // initial miss
          return raced; // re-select after the unique violation
        }
        return undefined;
      },
      insert() { return { returning: async () => { throw new Error('duplicate key value violates unique constraint'); } }; },
    });
    const out = await getOrCreateOpenStatement({ payerId: 7, termsSnapshot: 'net30' });
    expect(out).toEqual(raced);
  });

  test('rejects an invalid payerId', async () => {
    await expect(getOrCreateOpenStatement({ payerId: 0, termsSnapshot: 'net30' })).rejects.toThrow(/invalid payerId/);
  });
});

describe('rollupStatement', () => {
  test('recomputes totals for an OPEN statement', async () => {
    const updates = [];
    mockDbHandler = (t) => {
      if (t === 'payer_statements') {
        return {
          where() { return this; },
          forUpdate() { return this; },
          first: async () => ({ id: 10, status: 'open' }),
          update: async (p) => { updates.push(p); return 1; },
        };
      }
      // invoices aggregate
      return {
        where() { return this; },
        whereNot() { return this; },
        first: async () => ({ subtotal: '100.00', tax_amount: '7.00', total: '107.00', invoice_count: 2 }),
      };
    };
    await rollupStatement(10);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ subtotal: '100.00', tax_amount: '7.00', total: '107.00', invoice_count: 2 });
  });

  test('is a no-op once the statement is frozen (not open)', async () => {
    let updated = false;
    mockDbHandler = () => ({
      where() { return this; },
      forUpdate() { return this; },
      first: async () => ({ id: 10, status: 'sent' }),
      update: async () => { updated = true; return 1; },
    });
    await rollupStatement(10);
    expect(updated).toBe(false);
  });
});

describe('finalizeStatement', () => {
  test('freezes an OPEN statement → finalized (rolled-up totals, due date, frozen snapshot)', async () => {
    const stmt = {
      id: 20, payer_id: 7, period_start: '2026-01-01', status: 'open',
      terms_snapshot: 'net30', payer_snapshot: null,
      subtotal: '0', tax_amount: '0', total: '0', invoice_count: 0,
    };
    const updates = [];
    mockDbHandler = (t) => {
      if (t === 'invoices') {
        return {
          where() { return this; },
          whereNot() { return this; },
          first: async () => ({ subtotal: '300.00', tax_amount: '21.00', total: '321.00', invoice_count: 3 }),
        };
      }
      return {
        where() { return this; },
        forUpdate() { return this; },
        first: async () => ({ ...stmt }),
        update(p) { updates.push(p); Object.assign(stmt, p); return this; },
        returning: async () => [{ ...stmt }],
      };
    };
    const res = await finalizeStatement(20);
    expect(res.status).toBe('finalized');
    expect(res.subtotal).toBe('300.00');            // final rollup ran while open
    expect(res.invoice_count).toBe(3);
    expect(res.due_date).toBe('due+30');            // net30 → addETDays(_, 30)
    expect(JSON.parse(res.payer_snapshot)).toEqual({ company_name: 'Homes by West Bay', ap_email: 'ap@westbay.com' });
    expect(mockGetPayer).toHaveBeenCalledWith(7, expect.anything());
    // rollup patch (no status) + the open→finalized patch
    expect(updates.some((p) => p.status === 'finalized')).toBe(true);
  });

  test('is idempotent — a non-open statement is returned unchanged', async () => {
    let touched = false;
    mockDbHandler = () => ({
      where() { return this; },
      forUpdate() { return this; },
      first: async () => ({ id: 21, payer_id: 7, period_start: '2026-01-01', status: 'sent', total: '321.00' }),
      update() { touched = true; return this; },
      returning: async () => [{ id: 21 }],
    });
    const res = await finalizeStatement(21);
    expect(res.status).toBe('sent');
    expect(touched).toBe(false);
    expect(mockGetPayer).not.toHaveBeenCalled();
  });

  test('falls back to the existing snapshot when the live payer read fails', async () => {
    mockGetPayer.mockRejectedValueOnce(new Error('payer db down'));
    const existing = { company_name: 'Frozen Co', ap_email: 'ap@frozen.com' };
    const stmt = {
      id: 22, payer_id: 9, period_start: '2026-02-01', status: 'open',
      terms_snapshot: 'net15', payer_snapshot: existing,
      subtotal: '0', tax_amount: '0', total: '0', invoice_count: 0,
    };
    mockDbHandler = (t) => {
      if (t === 'invoices') {
        return {
          where() { return this; }, whereNot() { return this; },
          first: async () => ({ subtotal: '50.00', tax_amount: '0', total: '50.00', invoice_count: 1 }),
        };
      }
      return {
        where() { return this; },
        forUpdate() { return this; },
        first: async () => ({ ...stmt }),
        update(p) { Object.assign(stmt, p); return this; },
        returning: async () => [{ ...stmt }],
      };
    };
    const res = await finalizeStatement(22);
    expect(res.status).toBe('finalized');
    expect(res.due_date).toBe('due+15');            // net15 → addETDays(_, 15)
    expect(JSON.parse(res.payer_snapshot)).toEqual(existing);  // kept the frozen fallback
  });
});
