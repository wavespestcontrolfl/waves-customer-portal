const {
  allocateAdCosts,
  perLeadCost,
  monthBounds,
  PAID_CHANNELS,
} = require('../services/ad-cost-allocation');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('perLeadCost', () => {
  test('even split, rounded to cents', () => {
    expect(perLeadCost(300, 3)).toBe(100);
    expect(perLeadCost(100, 3)).toBe(33.33);
  });
  test('zero leads → 0 (no divide-by-zero)', () => {
    expect(perLeadCost(500, 0)).toBe(0);
  });
  test('zero spend → 0', () => {
    expect(perLeadCost(0, 5)).toBe(0);
  });
});

describe('monthBounds', () => {
  test('half-open month range', () => {
    expect(monthBounds('2026-06')).toEqual({ start: '2026-06-01', end: '2026-07-01' });
  });
  test('December rolls to next January', () => {
    expect(monthBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });
});

// ---------------------------------------------------------------------------
// allocateAdCosts (fake knex)
// ---------------------------------------------------------------------------
function makeDb(state) {
  const captured = (state.captured = state.captured || { updates: [] });
  // ad_performance_daily: .join().where('ac.platform',P).modify().groupByRaw().select() → spend rows
  const apd = () => {
    let platform = null;
    const b = {
      join: () => b,
      where: (a, op, val) => {
        if (a === 'ac.platform') platform = op;
        if (a === 'apd.date' && op === '>=') captured.apdSince = val;
        return b;
      },
      modify: (fn) => { fn(b); return b; },
      groupByRaw: () => b,
      select: () => Promise.resolve(state.spendByPlatform?.[platform] || []),
    };
    return b;
  };
  // ad_service_attribution: group query (select) OR range update
  const asa = () => {
    let platform = null;
    const range = {};
    const b = {
      where: (a, op, val) => {
        if (typeof a === 'function') {
          captured.paidFilterApplied = (captured.paidFilterApplied || 0) + 1;
          // Exercise the paid predicate against a recording sub-builder so tests
          // can assert which columns count as "paid".
          const sub = {
            cols: [],
            whereNotNull(c) { this.cols.push(c); return this; },
            orWhereNotNull(c) { this.cols.push(c); return this; },
            orWhere(c) { this.cols.push(c); return this; },
          };
          a(sub);
          captured.paidFilterCols = sub.cols;
          return b;
        }
        if (a === 'lead_source') platform = op;
        if (a === 'lead_date' && op === '>=') range.start = val;
        if (a === 'lead_date' && op === '<') range.end = val;
        return b;
      },
      whereNotNull: () => b,
      modify: (fn) => { fn(b); return b; },
      groupByRaw: () => b,
      select: () => Promise.resolve(state.leadsByPlatform?.[platform] || []),
      update: (patch) => {
        captured.updates.push({ platform, start: range.start, end: range.end, patch });
        return Promise.resolve(state.updateCount ?? 1);
      },
    };
    return b;
  };
  const db = (table) => {
    const t = String(table);
    if (t.startsWith('ad_performance_daily')) return apd();
    if (t.startsWith('ad_service_attribution')) return asa();
    throw new Error(`unexpected table ${t}`);
  };
  db.raw = (sql) => ({ sql });
  db.schema = {
    hasTable: () => Promise.resolve(state.tablesExist !== false),
    // is_paid column present by default; set hasIsPaid:false to simulate a fresh DB
    // running the all-time backfill BEFORE migration 000004 adds the column.
    hasColumn: () => Promise.resolve(state.hasIsPaid !== false),
  };
  return db;
}

describe('allocateAdCosts', () => {
  test('spreads a channel-month spend evenly across its leads into ad_cost', async () => {
    const state = {
      spendByPlatform: { google_ads: [{ ym: '2026-06', spend: '300' }] },
      leadsByPlatform: { google_ads: [{ ym: '2026-06', leads: '3' }] },
      updateCount: 3,
    };
    const res = await allocateAdCosts(makeDb(state));

    const gads = state.captured.updates.find((u) => u.platform === 'google_ads');
    expect(gads).toBeTruthy();
    expect(gads.start).toBe('2026-06-01');
    expect(gads.end).toBe('2026-07-01');
    expect(gads.patch.ad_cost).toBe(100); // 300 / 3
    expect(res.updatedRows).toBe(3);
    expect(res.monthsTouched).toBe(1);
  });

  test('a month with leads but no spend gets ad_cost 0 (not skipped)', async () => {
    const state = {
      spendByPlatform: {}, // no spend synced
      leadsByPlatform: { facebook: [{ ym: '2026-05', leads: '4' }] },
    };
    await allocateAdCosts(makeDb(state));
    const fb = state.captured.updates.find((u) => u.platform === 'facebook');
    expect(fb.patch.ad_cost).toBe(0);
  });

  test('only paid channels are processed', async () => {
    const state = {
      leadsByPlatform: {
        google_ads: [{ ym: '2026-06', leads: '2' }],
        organic: [{ ym: '2026-06', leads: '9' }], // not a paid channel → never queried
      },
      spendByPlatform: { google_ads: [{ ym: '2026-06', spend: '50' }] },
    };
    await allocateAdCosts(makeDb(state));
    const platforms = state.captured.updates.map((u) => u.platform);
    expect(platforms).toContain('google_ads');
    expect(platforms).not.toContain('organic');
    expect(PAID_CHANNELS.map((c) => c.source)).toEqual(['google_ads', 'google_lsa', 'facebook']);
  });

  test('normalizes a mid-month sinceDate to the month start (no partial-month corruption)', async () => {
    const state = {
      spendByPlatform: { google_ads: [{ ym: '2026-03', spend: '90' }] },
      leadsByPlatform: { google_ads: [{ ym: '2026-03', leads: '3' }] },
    };
    await allocateAdCosts(makeDb(state), { sinceDate: '2026-03-29' });
    expect(state.captured.apdSince).toBe('2026-03-01'); // floored to month start, not 03-29
    const gads = state.captured.updates.find((u) => u.platform === 'google_ads');
    expect(gads.patch.ad_cost).toBe(30); // 90 / 3 over the FULL month
  });

  test('facebook allocation applies a paid-click filter (excludes organic social)', async () => {
    const state = {
      spendByPlatform: { facebook: [{ ym: '2026-06', spend: '200' }] },
      leadsByPlatform: { facebook: [{ ym: '2026-06', leads: '4' }] },
    };
    await allocateAdCosts(makeDb(state));
    expect(state.captured.paidFilterApplied).toBeGreaterThan(0); // fbclid/_fbc filter ran
  });

  test('the facebook paid filter also counts is_paid rows when the column exists', async () => {
    const state = {
      // hasIsPaid defaults to true (column present)
      spendByPlatform: { facebook: [{ ym: '2026-06', spend: '200' }] },
      leadsByPlatform: { facebook: [{ ym: '2026-06', leads: '4' }] },
    };
    await allocateAdCosts(makeDb(state));
    // Paid Meta lead = a click id (fbclid/_fbc) OR the explicit is_paid flag.
    expect(state.captured.paidFilterCols).toEqual(['fbclid', 'fbc', 'is_paid']);
  });

  test('omits the is_paid clause when the column is absent (fresh DB, 000003 backfill before 000004)', async () => {
    const state = {
      hasIsPaid: false, // column not yet added
      spendByPlatform: { facebook: [{ ym: '2026-06', spend: '200' }] },
      leadsByPlatform: { facebook: [{ ym: '2026-06', leads: '4' }] },
    };
    await allocateAdCosts(makeDb(state));
    expect(state.captured.paidFilterApplied).toBeGreaterThan(0); // filter still runs
    expect(state.captured.paidFilterCols).toEqual(['fbclid', 'fbc']); // no is_paid clause
  });

  test('no-op when the tables are absent', async () => {
    const res = await allocateAdCosts(makeDb({ tablesExist: false }));
    expect(res).toEqual({ updatedRows: 0, monthsTouched: 0 });
  });
});
