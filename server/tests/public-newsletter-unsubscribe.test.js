process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const db = require('../models/db');
const publicNewsletterRouter = require('../routes/public-newsletter');

const TOKEN = '11111111-2222-3333-4444-555555555555';

function query(subscriber) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => subscriber);
  q.update = jest.fn(async () => 1);
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
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'unsubscribed' }));
    expect(res.body).toContain("You're unsubscribed.");
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
