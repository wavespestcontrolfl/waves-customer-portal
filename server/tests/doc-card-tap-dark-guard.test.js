// The receipt/tracker card taps read as Not Found while GATE_DOC_CROSS_SELL is
// dark, ahead of the global /api/ limiter (AGENTS.md: a dark route never
// answers a revealing 429; Codex #8262 P0).
const fs = require('fs');
const path = require('path');

jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
const { isEnabled } = require('../config/feature-gates');
const { docCardTapDarkGuard } = require('../middleware/doc-card-tap-dark-guard');

function run(req) {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.set = jest.fn((k, v) => { res.headers[k] = v; return res; });
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  const next = jest.fn();
  docCardTapDarkGuard({ error: 'Receipt not found' }, req, res, next);
  return { res, next };
}

test.each(['/abc/cross-sell', '/abc/referral-link', '/abc/cross-sell/'])('gate off: POST %s → the route\'s own 404 with privacy headers', (p) => {
  isEnabled.mockReturnValue(false);
  const { res, next } = run({ method: 'POST', path: p });
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(404);
  expect(res.body).toEqual({ error: 'Receipt not found' });
  expect(res.headers['Cache-Control']).toBe('private, no-store');
});

test.each([
  ['gate on', true, 'POST', '/abc/cross-sell'],
  ['the receipt GET', false, 'GET', '/abc'],
  ['another POST', false, 'POST', '/abc/view'],
])('%s passes through untouched', (_label, gate, method, p) => {
  isEnabled.mockReturnValue(gate);
  const { res, next } = run({ method, path: p });
  expect(next).toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

test('index.js mounts the guard for both surfaces ahead of the global /api/ limiter', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const limiter = src.indexOf("app.use('/api/', limiter);");
  const receipt = src.indexOf("app.use('/api/receipt', (req, res, next) => docCardTapDarkGuard(");
  const track = src.indexOf("app.use('/api/public/track', (req, res, next) => docCardTapDarkGuard(");
  expect(limiter).toBeGreaterThan(0);
  expect(receipt).toBeGreaterThan(0);
  expect(track).toBeGreaterThan(0);
  expect(receipt).toBeLessThan(limiter);
  expect(track).toBeLessThan(limiter);
});
