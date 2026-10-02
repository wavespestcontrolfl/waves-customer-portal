/**
 * /api/public/price-change/:token — the view write never overwrites an
 * in-flight send claim: a customer opening the emailed link while the SMS
 * leg is still going leaves the row 'sending' (the sender finalizes it to
 * 'sent'), so a draft-retirement pass can never take it for an unsent
 * preview. Every other status still flips to 'viewed'.
 */
const mockUpdates = [];
const mockNotice = { id: 'n-1', customer_id: 'c-1', notice_token: 'a'.repeat(32), current_amount_cents: 11700, new_amount_cents: 12100, cadence_label: 'application', effective_date: '2026-12-10', status: 'sending' };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => (table === 'customers' ? { first_name: 'Pat' } : mockNotice)),
      update: jest.fn(async (patch) => { mockUpdates.push(patch); return 1; }),
    };
    return q;
  });
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

test('the view keeps a send claim and flips anything else to viewed', async () => {
  const router = require('../routes/price-change-public');
  const handler = router.stack.find((l) => l.route && l.route.path === '/:token').route.stack[0].handle;
  const res = { statusCode: 200, body: null, set: jest.fn(), status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { token: 'a'.repeat(32) } }, res);
  expect(res.statusCode).toBe(200);
  await new Promise((r) => setImmediate(r));
  expect(mockUpdates).toHaveLength(1);
  expect(mockUpdates[0].status).toEqual({ sql: "CASE WHEN status = 'sending' THEN status ELSE 'viewed' END" });
});
