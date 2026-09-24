/**
 * deriveMonthlyChargeIdempotencyKey (retry-collectibility.js) — Codex
 * round-2 P1: a retry-sweep attempt for the SAME obligation writes its own
 * 'failed' row with a DIFFERENT key family (autopay_retry_<paymentId>_
 * <rung>), which never matches the monthly family's _r<n> suffix. If that
 * row happens to be the most recently created 'failed' row (e.g. the 10 AM
 * sweep runs after a same-day monthly decline), naively reading "the
 * latest failed row's key" would see no _r match, default to attempt 1,
 * and REUSE whatever _r1 key a genuine monthly attempt already consumed —
 * replaying its stale decline (or hitting a parameter mismatch) instead of
 * advancing to a fresh key.
 *
 * Exercised directly (not through the HTTP route) with a small in-memory
 * conn that actually applies the whereRaw exclusion, since the shared
 * jest.mock('../models/db') doubles used elsewhere in this suite don't
 * filter by query content.
 */
const { deriveMonthlyChargeIdempotencyKey } = require('../services/retry-collectibility');

function makeConn(rows) {
  return (table) => {
    if (table !== 'payments') throw new Error(`unexpected table ${table}`);
    let filtered = rows.slice();
    const qb = {
      where(cond) {
        if (typeof cond === 'object' && cond) {
          filtered = filtered.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        }
        // The grouped billed_month/legacy OR clause is a function — the
        // fixtures below are pre-shaped to already satisfy it, so it's a
        // no-op here (this mock's job is the retry-family exclusion).
        return qb;
      },
      whereRaw(sql) {
        if (String(sql).includes('idempotency_key') && String(sql).includes('NOT LIKE')) {
          filtered = filtered.filter((r) => {
            let meta = {};
            try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch (_) { /* ignore */ }
            return !String(meta.idempotency_key || '').startsWith('autopay_retry_');
          });
        }
        return qb;
      },
      orderBy(col, dir) {
        filtered = filtered.slice().sort((a, b) => {
          const cmp = String(a[col]).localeCompare(String(b[col]));
          return dir === 'desc' ? -cmp : cmp;
        });
        return qb;
      },
      first: () => Promise.resolve(filtered[0] || null),
    };
    return qb;
  };
}

describe('deriveMonthlyChargeIdempotencyKey', () => {
  test('a more-recently-inserted retry-sweep failure is excluded — the monthly family\'s own latest key still advances correctly', async () => {
    const conn = makeConn([
      {
        id: 'p-monthly-r1',
        customer_id: 'cust-1',
        status: 'failed',
        created_at: '2026-09-23T09:00:00Z',
        metadata: JSON.stringify({ billed_month: '2026-09', idempotency_key: 'autopay_monthly_cust-1_2026-09-23_r1' }),
      },
      {
        // Created LATER (the 10 AM retry sweep retrying that SAME failed
        // row under its own per-attempt key) — must not be mistaken for
        // "no monthly attempt yet" and must not make the next monthly
        // attempt reuse r1.
        id: 'p-retry-sweep',
        customer_id: 'cust-1',
        status: 'failed',
        created_at: '2026-09-23T10:07:00Z',
        metadata: JSON.stringify({ billed_month: '2026-09', idempotency_key: 'autopay_retry_p-monthly-r1_0' }),
      },
    ]);
    const key = await deriveMonthlyChargeIdempotencyKey('cust-1', '2026-09', conn);
    expect(key).toMatch(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}_r2$/);
  });

  test('no prior failure at all → the bare key (shared with chargeMonthly\'s own default)', async () => {
    const conn = makeConn([]);
    const key = await deriveMonthlyChargeIdempotencyKey('cust-1', '2026-09', conn);
    expect(key).toMatch(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}$/);
  });
});
