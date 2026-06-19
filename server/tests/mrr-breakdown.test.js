jest.mock('../services/annual-prepay-renewals', () => ({
  getPaymentPendingCustomerIds: jest.fn(),
}));

const { getPaymentPendingCustomerIds } = require('../services/annual-prepay-renewals');
const { computeMrrBreakdown, AT_RISK_PREDICATE } = require('../services/mrr-breakdown');

// Minimal fake Knex: the helper chains where/whereNull/where/select off the
// table builder and then awaits it for an array of {id, monthly_rate, at_risk}
// rows. We make the builder thenable so `await` / Promise.all resolve it to the
// canned rows, and capture raw() calls to assert the asOf binding.
function makeFakeDb(rows) {
  const rawCalls = [];
  const builder = {
    where: () => builder,
    whereNull: () => builder,
    select: () => builder,
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  const db = () => builder;
  db.raw = (sql, bindings) => {
    rawCalls.push({ sql, bindings });
    return { sql, bindings };
  };
  db._rawCalls = rawCalls;
  return db;
}

describe('computeMrrBreakdown', () => {
  beforeEach(() => {
    getPaymentPendingCustomerIds.mockResolvedValue(new Set());
  });

  test('splits total into committed + at-risk with counts', async () => {
    const db = makeFakeDb([
      { id: 1, monthly_rate: '100', at_risk: false },
      { id: 2, monthly_rate: '50', at_risk: true },
      { id: 3, monthly_rate: '25.50', at_risk: false },
    ]);
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out).toEqual({
      total: 175.5,
      committed: 125.5,
      atRisk: 50,
      totalCount: 3,
      atRiskCount: 1,
    });
    expect(out.committed + out.atRisk).toBeCloseTo(out.total, 2);
  });

  test('empty population collapses to zero, not NaN', async () => {
    const db = makeFakeDb([]);
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out).toEqual({ total: 0, committed: 0, atRisk: 0, totalCount: 0, atRiskCount: 0 });
  });

  test('annual-prepay payment-pending customer is at-risk even when the SQL predicate says committed', async () => {
    getPaymentPendingCustomerIds.mockResolvedValue(new Set(['7']));
    const db = makeFakeDb([{ id: 7, monthly_rate: '80', at_risk: false }]);
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out.atRisk).toBe(80);
    expect(out.committed).toBe(0);
    expect(out.atRiskCount).toBe(1);
  });

  test('a customer flagged by BOTH the SQL predicate and the pending set counts once', async () => {
    getPaymentPendingCustomerIds.mockResolvedValue(new Set(['7']));
    const db = makeFakeDb([{ id: 7, monthly_rate: '80', at_risk: true }]);
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out.atRisk).toBe(80);
    expect(out.atRiskCount).toBe(1);
  });

  test('asOf flows into the predicate binding and the prepay helper', async () => {
    const db = makeFakeDb([]);
    await computeMrrBreakdown(db, '2026-06-19');
    const atRiskRaw = db._rawCalls.find(c => c.sql.includes('at_risk'));
    expect(atRiskRaw.bindings).toEqual(['2026-06-19', '2026-06-19']);
    expect(getPaymentPendingCustomerIds).toHaveBeenCalledWith('2026-06-19', db);
  });

  test('a prepay-helper failure fails soft (does not throw, no false at-risk)', async () => {
    getPaymentPendingCustomerIds.mockRejectedValue(new Error('prepay table missing'));
    const db = makeFakeDb([{ id: 1, monthly_rate: '100', at_risk: false }]);
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out).toEqual({ total: 100, committed: 100, atRisk: 0, totalCount: 1, atRiskCount: 0 });
  });
});

describe('AT_RISK_PREDICATE definition', () => {
  test('flags service-paused accounts (billing cron skips these entirely)', () => {
    expect(AT_RISK_PREDICATE).toContain('c.service_paused_at IS NOT NULL');
  });

  test('flags paused autopay (future pause date)', () => {
    expect(AT_RISK_PREDICATE).toContain('c.autopay_enabled = true');
    expect(AT_RISK_PREDICATE).toContain('c.autopay_paused_until IS NOT NULL');
    expect(AT_RISK_PREDICATE).toContain('c.autopay_paused_until >= ?::date');
  });

  test('flags overdue accounts via correlated outstanding/past-due invoice', () => {
    expect(AT_RISK_PREDICATE).toContain('FROM invoices iv');
    expect(AT_RISK_PREDICATE).toContain('iv.customer_id = c.id');
    // "Outstanding" mirrors the AR query's exclusion model, not an inclusion
    // list: unpaid (paid_at IS NULL) and not a non-collectible status.
    expect(AT_RISK_PREDICATE).toContain('iv.paid_at IS NULL');
    expect(AT_RISK_PREDICATE).toContain("iv.status NOT IN ('void', 'cancelled', 'draft')");
    expect(AT_RISK_PREDICATE).toContain("iv.status = 'overdue' OR iv.due_date < ?::date");
  });

  test('does NOT treat autopay-disabled (invoice-on-receipt customers) as at-risk', () => {
    expect(AT_RISK_PREDICATE).not.toContain('autopay_enabled = false');
  });
});
