/**
 * deriveMonthlyChargeIdempotencyKey (retry-collectibility.js) — Codex
 * round-2 + round-3 P1s: this obligation's most-recently-created 'failed'
 * row is not always the one whose key the monthly-attempt sequence should
 * advance from. Two ways a NEWER row can carry the wrong (or no) key:
 *   - a retry-sweep attempt for that same failed row writes its own
 *     per-payment-id key (autopay_retry_<paymentId>_<rung>), a completely
 *     different family that never matches the monthly _r<n> suffix;
 *   - the monthly cron's lock-contention deferred row (billing-cron.js)
 *     has NO idempotency_key recorded at all — no charge was attempted
 *     for it.
 * Either one being newest must not be read as "no monthly attempt yet,
 * start at 1" — that would silently REUSE whatever _r<n> key a genuine
 * monthly attempt already consumed, replaying its stale decline (or
 * hitting a parameter mismatch) instead of advancing to a fresh key. The
 * fix is a POSITIVE match — only a row whose key is actually in the
 * autopay_monthly_ family counts — not an exclude-list of every bad shape.
 *
 * Exercised directly (not through the HTTP route) with a small in-memory
 * conn that actually applies the whereRaw filter, since the shared
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
        // no-op here (this mock's job is the monthly-family key filter).
        return qb;
      },
      whereRaw(sql) {
        if (String(sql).includes('idempotency_key') && String(sql).includes('LIKE')) {
          filtered = filtered.filter((r) => {
            let meta = {};
            try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch (_) { /* ignore */ }
            return String(meta.idempotency_key || '').startsWith('autopay_monthly_');
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

const monthlyRow = (id, createdAt, idempotencyKey) => ({
  id, customer_id: 'cust-1', status: 'failed', created_at: createdAt,
  metadata: JSON.stringify({ billed_month: '2026-09', idempotency_key: idempotencyKey }),
});

describe('deriveMonthlyChargeIdempotencyKey', () => {
  test('a more-recently-inserted retry-sweep failure is skipped — the monthly family\'s own latest key still advances correctly', async () => {
    const conn = makeConn([
      monthlyRow('p-monthly-r1', '2026-09-23T09:00:00Z', 'autopay_monthly_cust-1_2026-09-23_r1'),
      // Created LATER (the 10 AM retry sweep retrying that SAME failed row
      // under its own per-attempt key) — must not be mistaken for "no
      // monthly attempt yet" and must not make the next monthly attempt
      // reuse r1.
      monthlyRow('p-retry-sweep', '2026-09-23T10:07:00Z', 'autopay_retry_p-monthly-r1_0'),
    ]);
    const key = await deriveMonthlyChargeIdempotencyKey('cust-1', '2026-09', conn);
    expect(key).toMatch(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}_r2$/);
  });

  test('a more-recently-inserted lock-contention deferred row (no key at all) is skipped — the monthly key still advances', async () => {
    const conn = makeConn([
      monthlyRow('p-monthly-r1', '2026-09-23T08:00:00Z', 'autopay_monthly_cust-1_2026-09-23_r1'),
      // The monthly cron's deferred row for a LATER lock-contention skip
      // that same day — no charge was attempted, so no key was recorded.
      { id: 'p-deferred', customer_id: 'cust-1', status: 'failed', created_at: '2026-09-23T08:00:05Z',
        metadata: JSON.stringify({ billed_month: '2026-09', deferred_reason: 'lock_contention' }) },
    ]);
    const key = await deriveMonthlyChargeIdempotencyKey('cust-1', '2026-09', conn);
    expect(key).toMatch(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}_r2$/);
  });

  test('no prior failure at all → the bare key (shared with chargeMonthly\'s own default)', async () => {
    const conn = makeConn([]);
    const key = await deriveMonthlyChargeIdempotencyKey('cust-1', '2026-09', conn);
    expect(key).toMatch(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}$/);
  });

  test('only non-monthly-family rows exist (no genuine monthly attempt yet) → still the bare key, never a stray suffix', async () => {
    const conn = makeConn([
      { id: 'p-retry-only', customer_id: 'cust-1', status: 'failed', created_at: '2026-09-23T10:07:00Z',
        metadata: JSON.stringify({ billed_month: '2026-09', idempotency_key: 'autopay_retry_x_0' }) },
    ]);
    const key = await deriveMonthlyChargeIdempotencyKey('cust-1', '2026-09', conn);
    expect(key).toMatch(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}$/);
  });
});
