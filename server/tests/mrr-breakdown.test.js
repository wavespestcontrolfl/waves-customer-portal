const { computeMrrBreakdown, AT_RISK_PREDICATE } = require('../services/mrr-breakdown');

// Minimal fake Knex: the helper only chains where/whereNull/where/select/first
// off the table builder and calls db.raw() for the aggregate columns. We
// capture every raw() call so we can assert the asOf date is bound into the
// FILTER predicates, and resolve .first() to a canned aggregate row.
function makeFakeDb(row) {
  const rawCalls = [];
  const builder = {
    where: () => builder,
    whereNull: () => builder,
    select: () => builder,
    first: async () => row,
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
  test('splits total into committed + at-risk with counts', async () => {
    const db = makeFakeDb({ total: '12500.50', at_risk: '2200.50', total_count: '40', at_risk_count: '6' });
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out).toEqual({
      total: 12500.5,
      committed: 10300,
      atRisk: 2200.5,
      totalCount: 40,
      atRiskCount: 6,
    });
    // committed + atRisk reconstructs total exactly.
    expect(out.committed + out.atRisk).toBeCloseTo(out.total, 2);
  });

  test('null/empty aggregates collapse to zero, not NaN', async () => {
    const db = makeFakeDb({ total: null, at_risk: null, total_count: null, at_risk_count: null });
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out).toEqual({ total: 0, committed: 0, atRisk: 0, totalCount: 0, atRiskCount: 0 });
  });

  test('committed is clamped at zero even if at-risk somehow exceeds total', async () => {
    const db = makeFakeDb({ total: '100', at_risk: '130', total_count: '5', at_risk_count: '5' });
    const out = await computeMrrBreakdown(db, '2026-06-19');
    expect(out.committed).toBe(0);
  });

  test('asOf date is bound into both at-risk FILTER predicates', async () => {
    const db = makeFakeDb({ total: '0', at_risk: '0', total_count: '0', at_risk_count: '0' });
    await computeMrrBreakdown(db, '2026-06-19');
    const filtered = db._rawCalls.filter(c => c.sql.includes('FILTER'));
    expect(filtered).toHaveLength(2);
    for (const c of filtered) {
      expect(c.bindings).toEqual(['2026-06-19', '2026-06-19']);
    }
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
    // Only a *paused* future date counts — there is no bare
    // "autopay_enabled = false" branch in the predicate.
    expect(AT_RISK_PREDICATE).not.toContain('autopay_enabled = false');
  });
});
