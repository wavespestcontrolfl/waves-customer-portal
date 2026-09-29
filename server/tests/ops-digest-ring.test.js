// Ring-only-on-change (admin-alerts-ring scope, owner ruling 2026-09-28,
// "ring only when something changed"): the alert-class helper, the pure
// new-news decision, the 7-day lookback query's SHAPE, and the refresh-path
// gate. No customer names — every fixture below uses real prod-shaped ops-
// crons keys and synthetic in-process ones.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  alertClassFor, ringDecision, findPriorRungRow, decideRingForNewRow, ringOnRefreshFrom,
  normalizeItemKeys, hasNewItemKeys,
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
    // A mapped route with `counts` (data-hygiene) gets a STABLE id, never
    // the generic trailing trim — its counters sit mid-key, before a
    // trailing "_new_" with nothing after it, which trimVariableTail can
    // never reach on its own.
    ['local:data-hygiene_sweep_N_fixed_N_exceptions_N_new_', 'local:data-hygiene'],
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

  // data-hygiene's real key shape: counters embedded mid-key
  // ("N_fixed_N_exceptions_N_new_", a bare trailing separator with nothing
  // after it) — two runs with different fixed/open counters must still
  // land in the SAME alert class, or the ring test compares apples to
  // oranges every single day.
  test('data-hygiene: two runs with different fixed/open counters produce the same alertClass', () => {
    const run1 = alertClassFor('local:data-hygiene_sweep_1_fixed_63_exceptions_0_new_', 'ops-crons');
    const run2 = alertClassFor('local:data-hygiene_sweep_2_fixed_71_exceptions_3_new_', 'ops-crons');
    expect(run1).toBe('local:data-hygiene');
    expect(run2).toBe('local:data-hygiene');
    expect(run1).toBe(run2);
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
    // Activity-only rows were never actually bell-visible — excluded from
    // the baseline even though quiet<>'true' alone would let one through
    // (an engineering row never carries a `quiet` key at all).
    expect(whereRawSql.some((sql) => /feed/.test(sql) && /activity/.test(sql))).toBe(true);
    expect(whereRawSql.some((sql) => /source.*IS NULL/.test(sql))).toBe(true); // source: null -> no source
    // Age baseline: the 7-day window and ordering read rungAt (falling back
    // to created_at), not created_at alone.
    expect(whereRawSql.some((sql) => /rungAt/.test(sql))).toBe(true);
    expect(builder.orderBy).toHaveBeenCalledTimes(1);
    const [orderArg] = builder.orderBy.mock.calls[0];
    expect(orderArg.sql).toMatch(/rungAt/);
    expect(orderArg.sql).toMatch(/DESC/);
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

describe('fullSetItemKeys', () => {
  const { fullSetItemKeys } = require('../services/ops-digest');
  test('uses all_ids (computed before LIMIT) when the query carries it', () => {
    expect(fullSetItemKeys([{ id: 'a', total_count: 3, all_ids: ['a', 'b', 'c'] }], { prefix: 'call:' }))
      .toEqual(['call:a', 'call:b', 'call:c']);
  });
  test('without all_ids: the page when it is the whole backlog, else null', () => {
    expect(fullSetItemKeys([{ id: 1, total_count: 2 }, { id: 2, total_count: 2 }])).toEqual(['1', '2']);
    expect(fullSetItemKeys([{ id: 1, total_count: 9 }])).toBeNull();
    expect(fullSetItemKeys([])).toEqual([]);
  });
  test('idOf picks a non-id identity (texts lane keys by peer)', () => {
    expect(fullSetItemKeys([{ peer: '9415550000' }], { prefix: 'text:', idOf: (r) => r.peer })).toEqual(['text:9415550000']);
  });
});

describe('ringOnRefreshFrom — ringOnFirstIdentity', () => {
  const legacy = { count: 4 };
  test('opt-in: the first identified refresh of a pre-identity row rings at an equal count', () => {
    expect(ringOnRefreshFrom({ count: 4, itemKeys: ['a'], itemSetHash: 'h', ringOnFirstIdentity: true })({}, legacy)).toBe(true);
  });
  test('never on a shrinking count, and not without the opt-in', () => {
    expect(ringOnRefreshFrom({ count: 3, itemKeys: ['a'], itemSetHash: 'h', ringOnFirstIdentity: true })({}, legacy)).toBe(false);
    expect(ringOnRefreshFrom({ count: 4, itemKeys: ['a'], itemSetHash: 'h' })({}, legacy)).toBe(false);
  });
  test('once the row carries identity, the normal comparison applies', () => {
    expect(ringOnRefreshFrom({ count: 4, itemKeys: ['a'], itemSetHash: 'h', ringOnFirstIdentity: true })({}, { count: 4, itemKeys: ['a'], itemSetHash: 'h' })).toBe(false);
  });
});

describe('decideRingForNewRow', () => {
  test('no prior row at all -> rings', async () => {
    const conn = makeConn(null);
    await expect(decideRingForNewRow(conn, { alertClass: 'a', source: null, key: 'a', count: 5, newCount: 0 })).resolves.toBe(true);
  });

  test('data-hygiene: a different run-counter key at the same count is the same set -> quiet', async () => {
    const conn = makeConn({ metadata: { count: 63, opsKey: 'local:data-hygiene_sweep_1_fixed_63_exceptions_0_new_' } });
    await expect(decideRingForNewRow(conn, {
      alertClass: 'local:data-hygiene', source: 'ops-crons', key: null,
      opsKey: 'local:data-hygiene_sweep_2_fixed_63_exceptions_0_new_', count: 63, newCount: 0,
    })).resolves.toBe(false);
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

// Follow-up to #5269 (codex r8 P1): a key shaped `<check-id>:<finding>-
// <date>` with NOTHING else variable collapses to exactly the alert class
// once the date is stripped (setKeyFor(opsKey) === alertClass) — the
// date-stripped comparison proves nothing about which items the finding
// names, so it must not read as "same set". e22's real key ("N overlapping
// visits") is the production example.
describe('decideRingForNewRow: a date-only key carries no identity (UNKNOWN, not "same")', () => {
  test('no count, no itemIds -> rings (the pre-#5269 behavior for such a check)', async () => {
    const conn = makeConn({ metadata: { opsKey: 'e22-schedule-integrity:overlaps-2026-09-10' } });
    await expect(decideRingForNewRow(conn, {
      alertClass: 'e22-schedule-integrity:overlaps', source: 'ops-crons', key: null,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11', count: null, newCount: null,
    })).resolves.toBe(true);
  });

  test('a count that grew still rings; an equal count with no item evidence still rings (never falsely "same")', async () => {
    const grown = makeConn({ metadata: { opsKey: 'e22-schedule-integrity:overlaps-2026-09-10', count: 2 } });
    await expect(decideRingForNewRow(grown, {
      alertClass: 'e22-schedule-integrity:overlaps', source: 'ops-crons', key: null,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11', count: 3, newCount: null,
    })).resolves.toBe(true);
    const flat = makeConn({ metadata: { opsKey: 'e22-schedule-integrity:overlaps-2026-09-10', count: 3 } });
    await expect(decideRingForNewRow(flat, {
      alertClass: 'e22-schedule-integrity:overlaps', source: 'ops-crons', key: null,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11', count: 3, newCount: null,
    })).resolves.toBe(true); // unknown identity + flat count -> still rings, never quiet on a guess
  });

  test('a shrinking count never rings, even with unknown identity', async () => {
    const conn = makeConn({ metadata: { opsKey: 'e22-schedule-integrity:overlaps-2026-09-10', count: 5 } });
    await expect(decideRingForNewRow(conn, {
      alertClass: 'e22-schedule-integrity:overlaps', source: 'ops-crons', key: null,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11', count: 3, newCount: null,
    })).resolves.toBe(false);
  });

  test('itemIds evidence rescues the comparison: the same set stays quiet, a swapped item rings', async () => {
    const { itemSetHashFor } = require('../services/ops-digest');
    const prior = () => makeConn({
      metadata: { opsKey: 'e22-schedule-integrity:overlaps-2026-09-10', itemKeys: ['a', 'b'], itemSetHash: itemSetHashFor(['a', 'b']) },
    });
    await expect(decideRingForNewRow(prior(), {
      alertClass: 'e22-schedule-integrity:overlaps', source: 'ops-crons', key: null,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11', count: null, newCount: null,
      itemKeys: ['b', 'a'], itemSetHash: itemSetHashFor(['b', 'a']),
    })).resolves.toBe(false);
    await expect(decideRingForNewRow(prior(), {
      alertClass: 'e22-schedule-integrity:overlaps', source: 'ops-crons', key: null,
      opsKey: 'e22-schedule-integrity:overlaps-2026-09-11', count: null, newCount: null,
      itemKeys: ['a', 'c'], itemSetHash: itemSetHashFor(['a', 'c']),
    })).resolves.toBe(true);
  });

  // A key that DOES carry identity beyond the class (d19's own hash suffix)
  // is unaffected by this fix — proven above in "setKeyFor + the item-set
  // comparison" and repeated here as the contrast case.
  test('contrast: a key with an identifying suffix still uses the key comparison, unaffected', async () => {
    const conn = makeConn({ metadata: { opsKey: 'd19-committed-bookings:gap-17ed9362' } });
    await expect(decideRingForNewRow(conn, {
      alertClass: 'd19-committed-bookings:gap', source: 'ops-crons', key: null,
      opsKey: 'd19-committed-bookings:gap-17ed9362', count: null, newCount: null,
    })).resolves.toBe(false); // same hash -> same set -> quiet, no count evidence needed
  });
});

// Item identity (admin-alerts-ring-v2 follow-up): a count-only standing
// digest (promised-estimate) can't tell "same N" from "N different items"
// on its own — itemKeys closes that gap.
describe('normalizeItemKeys + hasNewItemKeys', () => {
  test('dedupes, sorts, and drops blanks', () => {
    expect(normalizeItemKeys(['b', 'a', 'a', '', null, 'c'])).toEqual(['a', 'b', 'c']);
  });
  test('non-array or empty input normalizes to null', () => {
    expect(normalizeItemKeys(undefined)).toBeNull();
    expect(normalizeItemKeys('not-an-array')).toBeNull();
    expect(normalizeItemKeys([])).toBeNull();
    expect(normalizeItemKeys(['', null])).toBeNull();
  });
  test('past the cap, the set hash still proves a swap at an equal count — and never rings a shrink', () => {
    const { itemSetHashFor } = require('../services/ops-digest');
    const ids = (from) => Array.from({ length: 600 }, (_, i) => `id-${from + i}`);
    const prior = itemSetHashFor(ids(0));
    expect(itemSetHashFor(ids(0).reverse())).toBe(prior); // order-independent
    expect(ringDecision({ count: 600, priorCount: 600, itemSetHash: itemSetHashFor(ids(1)), priorItemSetHash: prior })).toBe(true);
    expect(ringDecision({ count: 600, priorCount: 600, itemSetHash: prior, priorItemSetHash: prior })).toBe(false);
    expect(ringDecision({ count: 599, priorCount: 600, itemSetHash: itemSetHashFor(ids(1).slice(1)), priorItemSetHash: prior })).toBe(false);
  });

  test('a set past 500 stores no key list (never a truncated prefix)', () => {
    expect(normalizeItemKeys(Array.from({ length: 500 }, (_, i) => `id-${i}`))).toHaveLength(500);
    expect(normalizeItemKeys(Array.from({ length: 501 }, (_, i) => `id-${i}`))).toBeNull();
  });
  test('hasNewItemKeys: true only when a current key is absent from the prior list', () => {
    expect(hasNewItemKeys(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(hasNewItemKeys(['a', 'c'], ['a', 'b'])).toBe(true);
  });
  test('hasNewItemKeys: either side missing an array is never new (count/newCount stay the only signal)', () => {
    expect(hasNewItemKeys(undefined, ['a'])).toBe(false);
    expect(hasNewItemKeys(['a'], undefined)).toBe(false);
    expect(hasNewItemKeys(undefined, undefined)).toBe(false);
  });
});

describe('ringDecision: itemKeys override an equal or smaller count', () => {
  test('a swapped item rings even at an EQUAL count', () => {
    expect(ringDecision({ count: 5, priorCount: 5, itemKeys: ['a', 'b'], priorItemKeys: ['a', 'c'] })).toBe(true);
  });
  test('a swapped item rings even at a SMALLER count (normally always quiet)', () => {
    expect(ringDecision({ count: 3, priorCount: 5, itemKeys: ['a', 'x'], priorItemKeys: ['a', 'b', 'c', 'd', 'e'] })).toBe(true);
  });
  test('the same items at an equal count stay quiet', () => {
    expect(ringDecision({ count: 5, priorCount: 5, itemKeys: ['a', 'b'], priorItemKeys: ['b', 'a'] })).toBe(false);
  });
  test('one side missing itemKeys falls back to the plain count/sameSet test, unaffected', () => {
    expect(ringDecision({ count: 5, priorCount: 5, itemKeys: ['a', 'z'] })).toBe(false);
    expect(ringDecision({ count: 5, priorCount: 5, priorItemKeys: ['a'] })).toBe(false);
  });
});

describe('decideRingForNewRow / ringOnRefreshFrom: itemKeys wired through to the prior row', () => {
  test('decideRingForNewRow: a different item set rings even at a flat count', async () => {
    const conn = makeConn({ metadata: { count: 5, itemKeys: ['call-1', 'call-2'] } });
    await expect(decideRingForNewRow(conn, {
      alertClass: 'promised-estimate', source: null, key: 'promised-estimate',
      count: 5, newCount: 0, itemKeys: ['call-1', 'call-3'],
    })).resolves.toBe(true);
  });
  test('decideRingForNewRow: the same item set at a flat count stays quiet', async () => {
    const conn = makeConn({ metadata: { count: 5, itemKeys: ['call-1', 'call-2'] } });
    await expect(decideRingForNewRow(conn, {
      alertClass: 'promised-estimate', source: null, key: 'promised-estimate',
      count: 5, newCount: 0, itemKeys: ['call-2', 'call-1'],
    })).resolves.toBe(false);
  });
  test('ringOnRefreshFrom: a different item set rings against the existing row\'s own itemKeys', () => {
    const gate = ringOnRefreshFrom({ count: 5, newCount: 0, itemKeys: ['call-9'] });
    expect(gate({}, { count: 5, itemKeys: ['call-1'] })).toBe(true);
    expect(gate({}, { count: 5, itemKeys: ['call-9'] })).toBe(false);
  });
});
