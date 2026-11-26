/**
 * The cross-sell number (services/cross-sell-rate.js), no database: where an added service came from (classifySource), which
 * family's visit counts as "added", the counts and source split built from the SQL rows, the family SQL the counting rule is
 * written from, the snapshot columns, the summary payload and the backfill (dry run writes nothing; --apply updates only the
 * three new columns and never inserts). The real SQL (the 95-day window, cancelled and callback visits, churn, the key
 * and service-type mapping) runs in cross-sell-rate-postgres.test.js. Synthetic numbers only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const svc = require('../services/cross-sell-rate');
const backfill = require('../scripts/backfill-cross-sell-snapshots');

describe('classifySource', () => {
  test('an estimate splits by the channel estimates.source records', () => {
    const of = (estimateSource) => svc.classifySource({ estimateId: 'e1', estimateSource });
    expect(of('one_tap_purchase')).toBe('app');
    expect(of('plan_start')).toBe('app');
    expect(of('service_report_cta')).toBe('service_report_card');
    expect(of('quote_wizard')).toBe('website_quote');
    expect(of('manual')).toBe('estimate');
    expect(of(null)).toBe('estimate');
  });

  test('without an estimate: website quote, phone call, imported, or the office', () => {
    expect(svc.classifySource({ source: 'quote-wizard' })).toBe('website_quote');
    expect(svc.classifySource({ source: 'quote-wizard-onetime' })).toBe('website_quote');
    expect(svc.classifySource({ sourceCallLogId: 'call-1', source: 'admin' })).toBe('phone_call');
    expect(svc.classifySource({ bookingSource: 'phone_call' })).toBe('phone_call');
    expect(svc.classifySource({ source: 'square_booking' })).toBe('imported');
    expect(svc.classifySource({ source: 'admin' })).toBe('office');
    expect(svc.classifySource({})).toBe('office');
    expect(svc.classifySource()).toBe('office');
  });

  test('an estimate wins over a quote-wizard source and a call', () => {
    expect(svc.classifySource({ estimateId: 'e1', estimateSource: 'plan_start', source: 'quote-wizard', sourceCallLogId: 'c1' })).toBe('app');
  });
});

describe('summarizeHeldFamilies', () => {
  const visit = (customer, fam, createdAt, extra = {}) => ({ customer_id: customer, fam, created_at: new Date(createdAt), ...extra });

  test('the added service is the family whose earliest visit is the newest', () => {
    const added = svc.addedServiceVisit([
      visit('c1', 'pest', '2025-01-01T00:00:00Z', { source: 'admin' }),
      visit('c1', 'lawn', '2026-06-01T00:00:00Z', { source: 'quote-wizard' }),
    ]);
    expect(added.fam).toBe('lawn');
  });

  test('counts customers with one family, two families and three, and splits only the multi-service ones', () => {
    const rows = [
      visit('single', 'pest', '2025-01-01T00:00:00Z'),
      visit('two', 'pest', '2025-01-01T00:00:00Z', { source: 'admin' }),
      visit('two', 'lawn', '2026-03-01T00:00:00Z', { source_estimate_id: 'e1', estimate_source: 'one_tap_purchase' }),
      visit('three', 'pest', '2024-01-01T00:00:00Z'),
      visit('three', 'mosquito', '2025-01-01T00:00:00Z'),
      visit('three', 'lawn', '2026-01-01T00:00:00Z', { source_call_log_id: 'call-9' }),
    ];
    expect(svc.summarizeHeldFamilies(rows)).toEqual({
      recurringCustomers: 3,
      multiServiceCustomers: 2,
      sources: {
        app: 1, service_report_card: 0, website_quote: 0, estimate: 0, phone_call: 1, imported: 0, office: 0,
      },
    });
  });

  test('no rows is zero customers and an all-zero split', () => {
    expect(svc.summarizeHeldFamilies([])).toEqual({
      recurringCustomers: 0,
      multiServiceCustomers: 0,
      sources: Object.fromEntries(svc.SOURCE_BUCKETS.map((bucket) => [bucket, 0])),
    });
  });
});

describe('familySql', () => {
  const sql = svc.familySql('ss');

  test('every stored key prefix maps to its family, using starts_with so an underscore is not a wildcard', () => {
    expect(sql).toContain("starts_with(ss.service_key_snapshot, 'pest_general') THEN 'pest'");
    expect(sql).toContain("starts_with(ss.service_key_snapshot, 'lawn_care') THEN 'lawn'");
    expect(sql).toContain("starts_with(ss.service_key_snapshot, 'tree_shrub') THEN 'tree_shrub'");
    expect(sql).toContain("starts_with(ss.service_key_snapshot, 'mosquito') THEN 'mosquito'");
    expect(sql).toContain("starts_with(ss.service_key_snapshot, 'termite') THEN 'termite'");
    expect(sql).toContain("starts_with(ss.service_key_snapshot, 'rodent_bait') THEN 'rodent_bait'");
  });

  test('the service type words are the fallback for a row with no stored key only', () => {
    expect(sql).toMatch(/^CASE WHEN ss\.service_key_snapshot IS NOT NULL THEN CASE .* END ELSE CASE .* END END$/);
    expect(sql).toContain("ss.service_type ILIKE '%lawn%' THEN 'lawn'");
    expect(sql).toContain("ss.service_type ILIKE '%shrub%' THEN 'tree_shrub'");
    expect(sql).toContain("ss.service_type ILIKE '%bait%' THEN 'termite'");
    expect(sql).toContain("ss.service_type ILIKE '%pest%' THEN 'pest'");
  });
});

// A recording db: db.raw answers from `queue` in order; db(table) is a chain that records and resolves a result.
function makeDb({ raws = [], updates = [], stored = [] } = {}) {
  const calls = { raw: [], chain: [] };
  const db = (table) => {
    const entry = { table, calls: [] };
    calls.chain.push(entry);
    const q = new Proxy({}, {
      get(_t, method) {
        if (method === 'then') return (resolve, reject) => Promise.resolve(stored).then(resolve, reject);
        return (...args) => {
          entry.calls.push([method, ...args]);
          if (method === 'update') return Promise.resolve(updates.shift() ?? 0);
          return q;
        };
      },
    });
    return q;
  };
  db.raw = (sql, bindings) => {
    calls.raw.push({ sql, bindings });
    return Promise.resolve(raws.shift() || { rows: [] });
  };
  db.calls = calls;
  return db;
}

describe('crossSellForMonthEnd and the snapshot columns', () => {
  test('reads once, as of the given day (all three date bindings), and stores the split as JSON text', async () => {
    const rows = [
      { customer_id: 'a', fam: 'pest', created_at: new Date('2025-01-01T00:00:00Z') },
      { customer_id: 'a', fam: 'lawn', created_at: new Date('2026-01-01T00:00:00Z'), source: 'quote-wizard' },
      { customer_id: 'b', fam: 'pest', created_at: new Date('2025-01-01T00:00:00Z') },
    ];
    const db = makeDb({ raws: [{ rows }] });
    const columns = await svc.crossSellColumns(db, new Date('2026-10-31T12:00:00Z'));
    expect(db.calls.raw).toHaveLength(1);
    expect(db.calls.raw[0].bindings).toEqual(['2026-10-31', '2026-10-31', '2026-10-31']);
    expect(db.calls.raw[0].sql).toContain('JOIN customers c ON c.id = v.customer_id AND c.deleted_at IS NULL');
    expect(db.calls.raw[0].sql).toContain('c.churned_at > CAST(? AS date)');
    expect(db.calls.raw[0].sql).toContain("ss.status <> 'cancelled'");
    expect(db.calls.raw[0].sql).toContain('COALESCE(ss.is_callback, false) = false');
    expect(columns).toMatchObject({ recurring_customers: 2, multi_service_customers: 1 });
    expect(JSON.parse(columns.multi_service_sources)).toMatchObject({ website_quote: 1, office: 0 });
  });

  test('a bad date is refused instead of reading a wrong window', async () => {
    await expect(svc.crossSellForMonthEnd(makeDb(), 'soon')).rejects.toThrow(/not a calendar date/);
  });
});

describe('pestOnlyCustomers', () => {
  test('returns names, city and pest key, at most 500, as of the given day', async () => {
    const db = makeDb({ raws: [{ rows: [{ id: 'c1', first_name: 'Sample', last_name: 'Alpha', city: 'Parrish', pest_service_key: 'pest_general_quarterly' }] }] });
    expect(await svc.pestOnlyCustomers(db, '2026-11-26')).toEqual([
      { id: 'c1', firstName: 'Sample', lastName: 'Alpha', city: 'Parrish', pestServiceKey: 'pest_general_quarterly' },
    ]);
    expect(db.calls.raw[0].bindings).toEqual(['2026-11-26', '2026-11-26', '2026-11-26']);
    expect(db.calls.raw[0].sql).toContain('LIMIT 500');
    expect(db.calls.raw[0].sql).toContain('ORDER BY LOWER(c.last_name)');
  });
});

describe('getCrossSellSummary', () => {
  test('stored months oldest first with their share, today live with its split, and the pest-only list', async () => {
    const stored = [
      { month: '2026-10-01', recurring_customers: 260, multi_service_customers: 26 },
      { month: '2026-09-01', recurring_customers: 250, multi_service_customers: 30 },
    ];
    const live = [{ customer_id: 'a', fam: 'pest', created_at: new Date('2025-01-01T00:00:00Z') }];
    const db = makeDb({ stored, raws: [{ rows: live }, { rows: [] }] });
    const out = await svc.getCrossSellSummary({ months: '12', db, today: '2026-11-26' });
    expect(out.series).toEqual([
      { month: '2026-09-01', recurringCustomers: 250, multiServiceCustomers: 30, share: 0.12 },
      { month: '2026-10-01', recurringCustomers: 260, multiServiceCustomers: 26, share: 0.1 },
    ]);
    expect(out.now).toEqual({ asOf: '2026-11-26', recurringCustomers: 1, multiServiceCustomers: 0, share: 0 });
    expect(out.sources).toMatchObject({ office: 0 });
    expect(out.pestOnly).toEqual([]);
    const chain = db.calls.chain[0];
    expect(chain.table).toBe('monthly_financial_snapshots');
    expect(chain.calls).toContainEqual(['whereNotNull', 'recurring_customers']);
    expect(chain.calls).toContainEqual(['limit', 12]);
  });

  test('no recurring customers gives a null share, not a divide by zero', () => {
    expect(svc.share(0, 0)).toBeNull();
    expect(svc.share(33, 275)).toBe(0.12);
  });
});

describe('backfill', () => {
  const now = new Date('2026-11-26T15:00:00Z');

  test('fills 2026-03 through last month, never the current month', () => {
    const months = backfill.monthsToFill(now);
    expect(months[0]).toBe('2026-03-01');
    expect(months[months.length - 1]).toBe('2026-10-01');
    expect(months).toHaveLength(8);
  });

  test('a dry run writes nothing and prints one line per month', async () => {
    const lines = [];
    const db = makeDb({ raws: Array.from({ length: 8 }, () => ({ rows: [] })) });
    const report = await backfill.backfillCrossSell(db, { apply: false, now, log: (l) => lines.push(l) });
    expect(report).toHaveLength(8);
    expect(report.every((r) => r.stored === false)).toBe(true);
    expect(lines).toHaveLength(8);
    expect(db.calls.chain).toHaveLength(0);
  });

  test('--apply updates only the three new columns on the existing row, by month, and skips a month with no row', async () => {
    const rows = [{ customer_id: 'a', fam: 'pest', created_at: new Date('2025-01-01T00:00:00Z') }];
    const db = makeDb({ raws: Array.from({ length: 8 }, () => ({ rows })), updates: [0, 1, 1, 1, 1, 1, 1, 1] });
    const lines = [];
    const report = await backfill.backfillCrossSell(db, { apply: true, now, log: (l) => lines.push(l) });
    expect(report.map((r) => r.stored)).toEqual([false, true, true, true, true, true, true, true]);
    expect(lines[0]).toContain('skipped');
    expect(db.calls.chain).toHaveLength(8);
    for (const entry of db.calls.chain) {
      expect(entry.table).toBe('monthly_financial_snapshots');
      expect(entry.calls.map(([method]) => method)).toEqual(['where', 'update']);
      const update = entry.calls.find(([method]) => method === 'update')[1];
      expect(Object.keys(update).sort()).toEqual(['multi_service_customers', 'multi_service_sources', 'recurring_customers']);
    }
  });
});

describe('migration', () => {
  const migration = require('../models/migrations/20261127100000_snapshot_cross_sell');
  const makeKnex = (existing) => {
    const added = [];
    const dropped = [];
    const column = { nullable: () => {} };
    const t = {
      integer: (name) => { added.push(['integer', name]); return column; },
      jsonb: (name) => { added.push(['jsonb', name]); return column; },
      dropColumns: (...names) => dropped.push(...names),
    };
    return {
      added,
      dropped,
      schema: {
        hasColumn: async (_table, name) => existing.includes(name),
        alterTable: async (_table, fn) => fn(t),
      },
    };
  };

  test('up adds the three columns when missing and does nothing when all exist', async () => {
    const fresh = makeKnex([]);
    await migration.up(fresh);
    expect(fresh.added).toEqual([['integer', 'recurring_customers'], ['integer', 'multi_service_customers'], ['jsonb', 'multi_service_sources']]);
    const done = makeKnex(['recurring_customers', 'multi_service_customers', 'multi_service_sources']);
    await migration.up(done);
    expect(done.added).toEqual([]);
  });

  test('down drops exactly the three columns it added and does nothing when none exist', async () => {
    const present = ['recurring_customers', 'multi_service_customers', 'multi_service_sources'];
    const knex = makeKnex(present);
    await migration.down(knex);
    expect(knex.dropped).toEqual(present);
    const none = makeKnex([]);
    await migration.down(none);
    expect(none.dropped).toEqual([]);
  });
});
