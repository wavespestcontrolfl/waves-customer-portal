process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const db = require('../models/db');
// The route now takes the per-mailbox lock (codex #5165 P1, :393) inside a
// transaction before its write — `trx` is the same mocked `db`/query chain,
// matching the convention other suites use for this mock shape.
db.raw = jest.fn(async () => ({ rowCount: 0 }));
db.transaction = jest.fn(async (fn) => fn(db));
const publicNewsletterRouter = require('../routes/public-newsletter');

const TOKEN = '11111111-2222-3333-4444-555555555555';

function query(subscriber, { tokenRotated = false } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNot = jest.fn(() => q);
  q.first = jest.fn(async () => (tokenRotated ? null : subscriber));
  // The r45 atomic consumption returns the updated rows (id, email) — a
  // rotated/removed token matches nothing.
  q.update = jest.fn(async () => (
    (subscriber && !tokenRotated) ? [{ id: subscriber.id, email: subscriber.email }] : []
  ));
  return q;
}

function routeHandler(method) {
  const layer = publicNewsletterRouter.stack.find((item) => (
    item.route?.path === '/unsubscribe/:token' && item.route.methods[method]
  ));
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = { statusCode: 200, body: null, contentType: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.type = jest.fn((type) => { res.contentType = type; return res; });
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

describe('public newsletter unsubscribe scanner safety', () => {
  beforeEach(() => jest.clearAllMocks());

  test('GET renders a confirmation form without mutating the subscriber', async () => {
    const q = query({ id: 'sub-1', email: 'reader@example.com', status: 'active' });
    db.mockReturnValue(q);
    const res = response();
    await routeHandler('get')({ params: { token: TOKEN } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Confirm unsubscribe.');
    expect(res.body).toContain(`method="POST" action="/api/public/newsletter/unsubscribe/${TOKEN}"`);
    expect(q.update).not.toHaveBeenCalled();
  });

  test('form POST performs the opt-out and renders completion HTML', async () => {
    const q = query({ id: 'sub-1', email: 'reader@example.com', status: 'active' });
    db.mockReturnValue(q);
    const res = response();
    await routeHandler('post')({
      params: { token: TOKEN },
      body: { confirm_unsubscribe: '1' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'unsubscribed' }), ['id', 'email']);
    expect(res.body).toContain("You're unsubscribed.");
  });

  test('the opt-out is consumed atomically by TOKEN, never by a separate id write', async () => {
    // A correction rotating the tokens between a read and an id-keyed
    // update let a stale link opt out the freshly retargeted subscriber
    // (Codex #3084 r45) — the single conditional UPDATE keys on the token
    // and serializes against the fanout's row locks.
    const q = query({ id: 'sub-1', email: 'reader@example.com', status: 'active' });
    db.mockReturnValue(q);
    await routeHandler('post')({ params: { token: TOKEN }, body: {} }, response());
    expect(q.where).toHaveBeenCalledWith({ unsubscribe_token: TOKEN });
    expect(q.whereNot).toHaveBeenCalledWith({ status: 'unsubscribed' });
    expect(q.where).not.toHaveBeenCalledWith(expect.objectContaining({ id: expect.anything() }));
  });

  // Codex #5165 P1 (:393): a per-mailbox lock — the SAME lock
  // subscribeOrResubscribe and the reconcile take — must be taken on the
  // token's own address BEFORE the CAS write, so a concurrent import
  // decision for a differently-spelled alias of the same mailbox can't
  // commit in the gap.
  test('the per-mailbox lock is taken on the subscriber\'s address before the CAS write', async () => {
    const q = query({ id: 'sub-1', email: 'reader@example.com', status: 'active' });
    db.mockReturnValue(q);
    await routeHandler('post')({
      params: { token: TOKEN },
      body: { confirm_unsubscribe: '1' },
    }, response());
    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.arrayContaining(['customer-email:reader@example.com']),
    );
    // The lock call landed before the update it fences.
    const lockCallOrder = db.raw.mock.invocationCallOrder[0];
    const updateCallOrder = q.update.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(updateCallOrder);
  });

  test('a token rotated away mid-flight is a no-op with the expired page — never a retargeted opt-out', async () => {
    const q = query({ id: 'sub-1', email: 'reader@example.com', status: 'active' }, { tokenRotated: true });
    db.mockReturnValue(q);
    const res = response();
    await routeHandler('post')({
      params: { token: TOKEN },
      body: { confirm_unsubscribe: '1' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('expired or invalid');
  });

  test('RFC one-click POST keeps the uniform JSON response', async () => {
    const q = query(null);
    db.mockReturnValue(q);
    const res = response();
    await routeHandler('post')({
      params: { token: TOKEN },
      body: { 'List-Unsubscribe': 'One-Click' },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
