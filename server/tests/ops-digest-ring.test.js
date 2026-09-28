// Ring-only-on-change (admin-alerts-ring scope, owner ruling 2026-09-28,
// "ring only when something changed"): the alert-class helper, the pure
// new-news decision, the 7-day lookback query's SHAPE, and the refresh-path
// gate. No customer names — every fixture below uses real prod-shaped ops-
// crons keys and synthetic in-process ones.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  alertClassFor, ringDecision, findPriorRungRow, decideRingForNewRow, ringOnRefreshFrom,
} = require('../services/ops-digest');

describe('alertClassFor', () => {
  test('in-process senders: the class is the key, verbatim, whatever the second argument is', () => {
    expect(alertClassFor('promised-estimate', null)).toBe('promised-estimate');
    expect(alertClassFor('promised-estimate', 'ops-crons')).toBe('promised-estimate'); // never called this way in practice, but still verbatim
  });

  // Real prod keys (admin-alerts-ring scope doc).
  test.each([
    ['d15-voicemail-callbacks:unreturned-2026-09-24-86e082f1cd22', 'd15-voicemail-callbacks:unreturned'],
    ['d18-suppression-sync:sendgrid-drift-2026-09-24-2', 'd18-suppression-sync:sendgrid-drift'],
    ['e22-schedule-integrity:weekend-pref-0b9fce27_11425c5f_14c31e84', 'e22-schedule-integrity:weekend-pref'],
    ['e22-schedule-integrity:overlaps-039a882f_d4e83fcf', 'e22-schedule-integrity:overlaps'],
    ['e36-property-links:est-set-0c67f861_12d63c56', 'e36-property-links:est-set'],
    ['b08-uncharged-collectibles:collectible-05415f76.12c70329.c24b5c1f', 'b08-uncharged-collectibles:collectible'],
    ['c32-gate-drift:drift-GATE_SCHEDULING_CAPACITY-2026-09-26', 'c32-gate-drift:drift-GATE_SCHEDULING_CAPACITY'],
    ['d19-committed-bookings:gap-17ed9362', 'd19-committed-bookings:gap'],
    ['local:data-hygiene_sweep_N_fixed_N_exceptions_N_new_', 'local:data-hygiene_sweep_N_fixed_N_exceptions_N_new_'],
  ])('ops-crons %s -> %s', (key, expected) => {
    expect(alertClassFor(key, 'ops-crons')).toBe(expected);
  });

  test('the gate name survives — it sits in the MIDDLE of the finding key, not at its trailing end', () => {
    expect(alertClassFor('c32-gate-drift:drift-GATE_SCHEDULING_CAPACITY-2026-09-26', 'ops-crons'))
      .toContain('GATE_SCHEDULING_CAPACITY');
  });

  test('a key with no colon at all is trimmed as a whole (no check id to protect)', () => {
    expect(alertClassFor('bare-039a882f', 'ops-crons')).toBe('bare');
  });
});

describe('ringDecision (pure)', () => {
  test('no prior count and no newCount: quiet (nothing to compare, caller sent no count)', () => {
    expect(ringDecision({ newCount: undefined, count: undefined, priorCount: null })).toBe(false);
  });
  test('same count as the comparison point: quiet', () => {
    expect(ringDecision({ newCount: 0, count: 63, priorCount: 63 })).toBe(false);
  });
  test('count grew past the comparison point: rings', () => {
    expect(ringDecision({ newCount: 0, count: 66, priorCount: 63 })).toBe(true);
  });
  test('newCount > 0 always rings, even with a flat or missing count', () => {
    expect(ringDecision({ newCount: 2, count: 66, priorCount: 66 })).toBe(true);
    expect(ringDecision({ newCount: 1, count: undefined, priorCount: null })).toBe(true);
  });
  test('the comparison point has no count at all: rings (a sender that only just started reporting counts)', () => {
    expect(ringDecision({ newCount: 0, count: 5, priorCount: null })).toBe(true);
  });
  test('newCount of exactly 0 never rings on its own', () => {
    expect(ringDecision({ newCount: 0, count: 63, priorCount: 63 })).toBe(false);
  });
});

// findPriorRungRow / decideRingForNewRow: the 7-day lookback that stands in
// for "the comparison point" when there is no single standing dedupe row.
// A minimal chainable fake — same idiom as notification-admin-dedupe-window.
// test.js's mock: every builder method records its call and returns itself;
// `.first()` returns a pre-programmed row (or null, simulating "the SQL's
// resolved/quiet/source/alertClass filters left nothing standing").
function makeConn(firstResult) {
  const calls = { where: [], whereRaw: [] };
  const builder = {
    where: jest.fn((...args) => { calls.where.push(args); return builder; }),
    whereRaw: jest.fn((...args) => { calls.whereRaw.push(args); return builder; }),
    orderBy: jest.fn(() => builder),
    first: jest.fn(async () => firstResult),
  };
  const conn = jest.fn(() => builder);
  conn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  conn._calls = calls;
  return conn;
}

function makeSubBuilder() {
  const calls = { whereRaw: [], orWhere: [] };
  const sub = {
    whereRaw: jest.fn((...args) => { calls.whereRaw.push(args); return sub; }),
    orWhere: jest.fn((fn) => { calls.orWhere.push(fn); return sub; }),
  };
  sub._calls = calls;
  return sub;
}

describe('findPriorRungRow — query shape', () => {
  test('scopes to admin/ops_digest, excludes resolved and quiet, and matches by alertClass', async () => {
    const conn = makeConn(null);
    await findPriorRungRow(conn, { alertClass: 'promised-estimate', source: null, key: 'promised-estimate' });
    const builder = conn.mock.results[0].value;
    expect(conn).toHaveBeenCalledWith('notifications');
    expect(builder.where).toHaveBeenCalledWith({ recipient_type: 'admin', category: 'ops_digest' });
    const whereRawSql = builder.whereRaw.mock.calls.map((c) => c[0]);
    expect(whereRawSql.some((sql) => /resolved/.test(sql))).toBe(true);
    expect(whereRawSql.some((sql) => /quiet/.test(sql))).toBe(true);
    expect(whereRawSql.some((sql) => /source.*IS NULL/.test(sql))).toBe(true); // source: null -> no source
    expect(builder.first).toHaveBeenCalledWith('metadata');
  });

  test('ops-crons rows scope on metadata.source = ?, never IS NULL', async () => {
    const conn = makeConn(null);
    await findPriorRungRow(conn, { alertClass: 'd15-voicemail-callbacks:unreturned', source: 'ops-crons', key: null });
    const builder = conn.mock.results[0].value;
    expect(builder.whereRaw).toHaveBeenCalledWith("metadata->>'source' = ?", ['ops-crons']);
  });

  test('the alertClass match group ORs in a legacy opsKey fallback ONLY for in-process rows (source null + a key)', async () => {
    const conn = makeConn(null);
    await findPriorRungRow(conn, { alertClass: 'promised-estimate', source: null, key: 'promised-estimate' });
    const builder = conn.mock.results[0].value;
    const groupCall = builder.where.mock.calls.find(([arg]) => typeof arg === 'function');
    expect(groupCall).toBeDefined();
    const sub = makeSubBuilder();
    groupCall[0](sub);
    expect(sub._calls.whereRaw[0]).toEqual(["metadata->>'alertClass' = ?", ['promised-estimate']]);
    expect(sub._calls.orWhere).toHaveLength(1);
    const legacy = makeSubBuilder();
    sub._calls.orWhere[0](legacy);
    expect(legacy._calls.whereRaw.some((c) => /alertClass.*IS NULL/.test(c[0]))).toBe(true);
    expect(legacy._calls.whereRaw.some((c) => c[0].includes('opsKey') && c[1][0] === 'promised-estimate')).toBe(true);
  });

  test('ops-crons rows never get the legacy opsKey fallback — a raw ops-crons key is one-shot anyway', async () => {
    const conn = makeConn(null);
    await findPriorRungRow(conn, { alertClass: 'd15-voicemail-callbacks:unreturned', source: 'ops-crons', key: 'd15-voicemail-callbacks:unreturned-2026-09-24-86e082f1cd22' });
    const builder = conn.mock.results[0].value;
    const groupCall = builder.where.mock.calls.find(([arg]) => typeof arg === 'function');
    const sub = makeSubBuilder();
    groupCall[0](sub);
    expect(sub._calls.orWhere).toHaveLength(0);
  });
});

describe('decideRingForNewRow', () => {
  test('no prior row at all -> rings', async () => {
    const conn = makeConn(null);
    await expect(decideRingForNewRow(conn, { alertClass: 'a', source: null, key: 'a', count: 5, newCount: 0 })).resolves.toBe(true);
  });

  test('a prior row with the SAME count -> quiet', async () => {
    const conn = makeConn({ metadata: { count: 63 } });
    await expect(decideRingForNewRow(conn, { alertClass: 'a', source: null, key: 'a', count: 63, newCount: 0 })).resolves.toBe(false);
  });

  test('a prior row with a LOWER count -> rings (the backlog grew)', async () => {
    const conn = makeConn({ metadata: { count: 63 } });
    await expect(decideRingForNewRow(conn, { alertClass: 'a', source: null, key: 'a', count: 66, newCount: 0 })).resolves.toBe(true);
  });

  test('newCount > 0 rings regardless of count', async () => {
    const conn = makeConn({ metadata: { count: 66 } });
    await expect(decideRingForNewRow(conn, { alertClass: 'a', source: null, key: 'a', count: 66, newCount: 2 })).resolves.toBe(true);
  });

  test('a resolved or quiet prior row is excluded by the query itself, so the fake "no row survives" (null) rings, same as no prior row at all', async () => {
    // The SQL's own COALESCE(...,'') <> 'true' filters mean a resolved or
    // quiet row is never the one `.first()` returns — see the query-shape
    // tests above for proof those clauses are present. This exercises the
    // consequence: nothing standing -> ring.
    const conn = makeConn(null);
    await expect(decideRingForNewRow(conn, { alertClass: 'a', source: null, key: 'a', count: 1, newCount: 0 })).resolves.toBe(true);
  });

  test('a legacy in-process row with no alertClass is matched by opsKey (proven by the query-shape test above); given such a match, the SAME count still goes quiet', async () => {
    const conn = makeConn({ metadata: { opsKey: 'promised-estimate', count: 3 } }); // no alertClass — a pre-PR-2 row
    await expect(decideRingForNewRow(conn, { alertClass: 'promised-estimate', source: null, key: 'promised-estimate', count: 3, newCount: 0 })).resolves.toBe(false);
    await expect(decideRingForNewRow(conn, { alertClass: 'promised-estimate', source: null, key: 'promised-estimate', count: 4, newCount: 0 })).resolves.toBe(true);
  });
});

describe('ringOnRefreshFrom (notifyAdmin\'s ringOnRefresh contract)', () => {
  test('a resolved existing row rings (should not normally happen — resolve drops the dedupeKey — kept for safety)', () => {
    const gate = ringOnRefreshFrom({ count: 1, newCount: 0 });
    expect(gate({}, { resolved: true, count: 99 })).toBe(true);
  });
  test('same count as the existing row: quiet', () => {
    const gate = ringOnRefreshFrom({ count: 5, newCount: 0 });
    expect(gate({}, { count: 5 })).toBe(false);
  });
  test('count grew past the existing row: rings', () => {
    const gate = ringOnRefreshFrom({ count: 6, newCount: 0 });
    expect(gate({}, { count: 5 })).toBe(true);
  });
  test('newCount > 0 rings even when count is flat', () => {
    const gate = ringOnRefreshFrom({ count: 5, newCount: 1 });
    expect(gate({}, { count: 5 })).toBe(true);
  });
  test('the existing row has no count at all: rings', () => {
    const gate = ringOnRefreshFrom({ count: 5, newCount: 0 });
    expect(gate({}, {})).toBe(true);
  });
});

// Distinct items sharing one ops-crons alert class (review on #5236's
// stacked PR 2): a different missed booking, or a different set of
// unreturned calls, is new news even at the same count.
describe('setKeyFor + the item-set comparison', () => {
  const { setKeyFor } = require('../services/ops-digest');

  test('drops run dates, keeps what identifies the items', () => {
    expect(setKeyFor('d15-voicemail-callbacks:unreturned-2026-09-24-86e082f1cd22')).toBe('d15-voicemail-callbacks:unreturned-86e082f1cd22');
    expect(setKeyFor('d19-committed-bookings:gap-17ed9362')).toBe('d19-committed-bookings:gap-17ed9362');
    expect(setKeyFor('c32-gate-drift:drift-GATE_SCHEDULING_CAPACITY-2026-09-26')).toBe('c32-gate-drift:drift-GATE_SCHEDULING_CAPACITY');
    // Same items on two different days -> same set key.
    expect(setKeyFor('d15-voicemail-callbacks:unreturned-2026-09-18-6eca2bf6686d'))
      .toBe(setKeyFor('d15-voicemail-callbacks:unreturned-2026-09-19-6eca2bf6686d'));
  });

  test('ringDecision: equal or unknown counts ring only for a different set; a smaller count never rings', () => {
    expect(ringDecision({ count: 1, priorCount: 1, sameSet: true })).toBe(false);
    expect(ringDecision({ count: 1, priorCount: 1, sameSet: false })).toBe(true);
    expect(ringDecision({ count: null, priorCount: null, sameSet: true })).toBe(false);
    expect(ringDecision({ count: null, priorCount: null, sameSet: false })).toBe(true);
    expect(ringDecision({ count: 2, priorCount: 4, sameSet: false })).toBe(false);
    expect(ringDecision({ count: 5, priorCount: 4, sameSet: true })).toBe(true);
  });

  test('a second, different d19 gap in the same week rings; the same gap re-posted stays quiet', async () => {
    const prior = makeConn({ metadata: { opsKey: 'd19-committed-bookings:gap-17ed9362' } });
    await expect(decideRingForNewRow(prior, {
      alertClass: 'd19-committed-bookings:gap', source: 'ops-crons', key: null,
      opsKey: 'd19-committed-bookings:gap-6fee5f34', count: null, newCount: null,
    })).resolves.toBe(true);
    const same = makeConn({ metadata: { opsKey: 'd19-committed-bookings:gap-17ed9362' } });
    await expect(decideRingForNewRow(same, {
      alertClass: 'd19-committed-bookings:gap', source: 'ops-crons', key: null,
      opsKey: 'd19-committed-bookings:gap-17ed9362', count: null, newCount: null,
    })).resolves.toBe(false);
  });

  test('d15: the same unreturned set on the next day is quiet; a new set at the same count rings', async () => {
    const prior = () => makeConn({ metadata: { opsKey: 'd15-voicemail-callbacks:unreturned-2026-09-18-6eca2bf6686d', count: 1 } });
    await expect(decideRingForNewRow(prior(), {
      alertClass: 'd15-voicemail-callbacks:unreturned', source: 'ops-crons', key: null,
      opsKey: 'd15-voicemail-callbacks:unreturned-2026-09-19-6eca2bf6686d', count: 1, newCount: null,
    })).resolves.toBe(false);
    await expect(decideRingForNewRow(prior(), {
      alertClass: 'd15-voicemail-callbacks:unreturned', source: 'ops-crons', key: null,
      opsKey: 'd15-voicemail-callbacks:unreturned-2026-09-23-86e082f1cd22', count: 1, newCount: null,
    })).resolves.toBe(true);
  });
});
