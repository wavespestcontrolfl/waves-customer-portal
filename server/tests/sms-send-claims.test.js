// The claim and release the once-a-day admin banners share (morning-banner.js, estimate-call-today-push.js), on a fake
// connection. The prune's own test runs against Postgres in CI (sms-send-claims-prune-postgres.test.js).
jest.mock('../models/db', () => jest.fn());
const fs = require('fs');
const path = require('path');
const {
  takeSendClaim, releaseSendClaim, pruneSmsSendClaims,
  acquirePushDedupeLease, renewPushDedupeLease, markPushDedupeDelivered, releasePushDedupeLease,
  recordPushDedupeSubDelivered, listPushDedupeDeliveredSubs, MONTHLY_CLAIM_PREFIXES,
} = require('../services/sms-send-claims');

function fakeConn({ deleteFails = false } = {}) {
  const held = new Set();
  const conn = jest.fn(() => ({
    where: ({ claim_key: key }) => ({
      del: async () => {
        if (deleteFails) throw Object.assign(new Error('delete failed'), { code: '57P01' });
        return held.delete(key) ? 1 : 0;
      },
    }),
  }));
  conn.raw = jest.fn(async (_sql, [key]) => {
    if (held.has(key)) return { rows: [] };
    held.add(key);
    return { rows: [{ id: held.size }] };
  });
  return conn;
}

test('the first run takes the key; a second run with the same key gets false; another key is its own', async () => {
  const conn = fakeConn();
  await expect(takeSendClaim('morning_banner:2026-11-20', conn)).resolves.toBe(true);
  await expect(takeSendClaim('morning_banner:2026-11-20', conn)).resolves.toBe(false);
  await expect(takeSendClaim('estimate_call_today:2026-11-20', conn)).resolves.toBe(true);
  // One atomic insert: a conflict returns no row, so two processes cannot both send.
  expect(conn.raw.mock.calls[0][0]).toMatch(/INSERT INTO sms_send_claims \(claim_key\) VALUES \(\?\)\s+ON CONFLICT \(claim_key\) DO NOTHING\s+RETURNING id/);
});

test('a released key can be taken again; a failed release throws to the caller', async () => {
  const conn = fakeConn();
  await takeSendClaim('estimate_call_today:2026-11-20', conn);
  await releaseSendClaim('estimate_call_today:2026-11-20', conn);
  expect(conn).toHaveBeenCalledWith('sms_send_claims');
  await expect(takeSendClaim('estimate_call_today:2026-11-20', conn)).resolves.toBe(true);
  await expect(releaseSendClaim('estimate_call_today:2026-11-20', fakeConn({ deleteFails: true }))).rejects.toMatchObject({ code: '57P01' });
});

// One claim mechanism for the daily banners: a fix to the insert or the delete reaches both.
test('both daily banners take and release their claim through this module', () => {
  for (const file of ['morning-banner.js', 'estimate-call-today-push.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../services', file), 'utf8');
    expect(src).toContain("require('./sms-send-claims')");
    expect(src).not.toMatch(/INSERT INTO sms_send_claims/);
    expect(src).not.toMatch(/db\('sms_send_claims'\)/);
  }
});

test('pruneSmsSendClaims retains notif_push_dedupe:, notif_push_sub:, and notif_push_partial: claims for 30 days', async () => {
  expect(MONTHLY_CLAIM_PREFIXES).toEqual(expect.arrayContaining(['notif_push_dedupe:', 'notif_push_sub:', 'notif_push_partial:']));
  const clauses = [];
  const makeBuilder = () => {
    const b = {
      where(a, b2, c) {
        if (typeof a === 'function') a(makeBuilder());
        else clauses.push(['where', a, b2, c]);
        return b;
      },
      orWhere(fn) {
        fn(makeBuilder());
        return b;
      },
      whereRaw(sql, bindings) {
        clauses.push(['whereRaw', sql, bindings]);
        return b;
      },
      del: jest.fn(async () => 1),
    };
    return b;
  };
  const conn = jest.fn(() => makeBuilder());
  conn.raw = jest.fn((sql) => sql);
  await pruneSmsSendClaims(conn);
  for (const prefix of ['notif_push_dedupe:', 'notif_push_sub:', 'notif_push_partial:']) {
    expect(clauses).toContainEqual(['whereRaw', 'left(claim_key, ?) <> ?', [prefix.length, prefix]]);
    expect(clauses).toContainEqual(['whereRaw', 'left(claim_key, ?) = ?', [prefix.length, prefix]]);
  }
  expect(clauses).toContainEqual(['where', 'created_at', '<', "NOW() - interval '30 days'"]);
});

test('push dedupe leases enforce owner tokens, renew on handoff, and look up sub markers via exact indexed keys', async () => {
  const store = new Map();
  let renewCalls = 0;
  const conn = jest.fn(() => ({
    where: (cond) => ({
      first: async () => {
        const row = store.get(cond.claim_key);
        if (!row) return null;
        if (cond.outcome !== undefined && row.outcome !== cond.outcome) return null;
        return row;
      },
      update: async (patch) => {
        const row = store.get(cond.claim_key);
        if (!row || (cond.outcome !== undefined && row.outcome !== cond.outcome)) return 0;
        if (patch.outcome) row.outcome = patch.outcome;
        else renewCalls += 1;
        row.stale = false;
        return 1;
      },
      del: async () => {
        const row = store.get(cond.claim_key);
        if (!row || (cond.outcome !== undefined && row.outcome !== cond.outcome)) return 0;
        store.delete(cond.claim_key);
        return 1;
      },
    }),
    whereIn: (_col, keys) => ({
      select: async () => keys.filter((k) => store.has(k)).map((claim_key) => ({ claim_key })),
    }),
  }));
  conn.raw = jest.fn(async (sql, params) => {
    if (/INSERT INTO sms_send_claims/i.test(sql)) {
      const [key, outcome = 'delivered'] = params;
      if (store.has(key)) return { rows: [] };
      store.set(key, { id: store.size + 1, outcome, stale: false });
      return { rows: [{ id: store.size }] };
    }
    if (/UPDATE sms_send_claims/i.test(sql)) {
      const [ownerToken, key] = params;
      const row = store.get(key);
      if (row && (row.outcome === 'pending' || row.outcome.startsWith('pending:')) && row.stale) {
        row.outcome = ownerToken;
        row.stale = false;
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });

  const key = 'notif_push_dedupe:relay_unbooked_call:CA-owner-1';
  const first = await acquirePushDedupeLease(key, {}, conn);
  expect(first.state).toBe('acquired');
  expect(first.ownerToken).toMatch(/^pending:[0-9a-f]{16}$/);
  // Active owner renews lease atomically.
  await expect(renewPushDedupeLease(key, first.ownerToken, conn)).resolves.toBe(true);
  expect(renewCalls).toBe(1);

  // Lease expires and worker 2 reclaims it with a new owner token.
  store.get(key).stale = true;
  const second = await acquirePushDedupeLease(key, {}, conn);
  expect(second.state).toBe('acquired');
  expect(second.ownerToken).not.toBe(first.ownerToken);

  // Worker 1 (stale owner) is rejected on renew, release, and mark-delivered.
  await expect(renewPushDedupeLease(key, first.ownerToken, conn)).resolves.toBe(false);
  await expect(releasePushDedupeLease(key, first.ownerToken, conn)).resolves.toBe(false);
  await expect(markPushDedupeDelivered(key, first.ownerToken, conn)).resolves.toBe(false);
  expect(store.get(key).outcome).toBe(second.ownerToken);

  // Per-device sub markers round-trip via exact key lookup (no prefix scan) and Worker 2 completes cleanly.
  await expect(listPushDedupeDeliveredSubs(key, ['sub-a', 'sub-b'], conn)).resolves.toEqual([]);
  await recordPushDedupeSubDelivered(key, 'sub-a', conn);
  await recordPushDedupeSubDelivered(key, 'sub-b', conn);
  await expect(listPushDedupeDeliveredSubs(key, ['sub-a', 'sub-b', 'sub-c'], conn)).resolves.toEqual(['sub-a', 'sub-b']);
  await expect(markPushDedupeDelivered(key, second.ownerToken, conn)).resolves.toBe(true);
  expect(store.get(key).outcome).toBe('delivered');
});
