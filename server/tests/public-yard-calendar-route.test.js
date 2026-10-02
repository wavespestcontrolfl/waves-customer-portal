/**
 * GET /api/public/yard-calendar: 200 shape, defaults, 400 on bad params, and
 * the cache headers. Handler-level (no DB, no network).
 */

const router = require('../routes/public-yard-calendar');

const ONLY_DATE = { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };

function handler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  return layer.route.stack[0].handle;
}

function call(query) {
  const res = { headers: {}, statusCode: 200, body: undefined };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  handler()({ query }, res);
  return res;
}

describe('public yard-calendar route', () => {
  test('200 with the calendar payload and an explicit-month cache lifetime', () => {
    const res = call({ month: '10', grass: 'sta' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ month: 10, grass: 'sta', area: 'Southwest Florida', reviewedAt: '2026-10-02' });
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.find((i) => i.id === 'chinch-bug').level).toBe(1);
    expect(res.body.items.find((i) => i.id === 'mole-cricket')).toBeUndefined();
    expect(res.headers['Cache-Control']).toBe('public, max-age=3600, s-maxage=86400');
  });

  describe('defaults to the current ET month', () => {
    afterEach(() => jest.useRealTimers());
    test('ET, not UTC: 03:00Z on Nov 1 is still October in Eastern time', () => {
      jest.useFakeTimers({ ...ONLY_DATE, now: new Date('2026-11-01T03:00:00Z') });
      const res = call({});
      expect(res.body.month).toBe(10);
      expect(res.body.grass).toBe('all');
      expect(res.headers['Cache-Control']).toBe('public, max-age=300, s-maxage=900');
    });
    test('after ET midnight it is November', () => {
      jest.useFakeTimers({ ...ONLY_DATE, now: new Date('2026-11-01T05:30:00Z') });
      expect(call({}).body.month).toBe(11);
    });
  });

  test.each(['0', '13', 'abc', '', '1.5', '-1', '10; drop', ['1', '2']])('400 invalid_month for month=%p', (month) => {
    const res = call({ month });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_month');
    expect(res.headers['Cache-Control']).toBeUndefined();
  });

  test.each(['centipede', '', 'STA', ['sta', 'bah']])('400 invalid_grass for grass=%p', (grass) => {
    const res = call({ month: '3', grass });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_grass');
  });

  test('grass=all is accepted', () => {
    expect(call({ month: '3', grass: 'all' }).statusCode).toBe(200);
  });
});
