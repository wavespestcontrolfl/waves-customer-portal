// The claim and release the once-a-day admin banners share (morning-banner.js, estimate-call-today-push.js), on a fake
// connection. The prune's own test runs against Postgres in CI (sms-send-claims-prune-postgres.test.js).
jest.mock('../models/db', () => jest.fn());
const fs = require('fs');
const path = require('path');
const { takeSendClaim, releaseSendClaim } = require('../services/sms-send-claims');

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
