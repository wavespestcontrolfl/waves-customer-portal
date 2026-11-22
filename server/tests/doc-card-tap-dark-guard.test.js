// The receipt/tracker card taps are decided ahead of the global /api/
// limiter and the body parsers: Not Found while GATE_DOC_CROSS_SELL is dark
// (AGENTS.md: a dark route never answers a revealing 429; Codex #8262 P0),
// and Not Found for a token of the wrong shape while it is on.
const fs = require('fs');
const path = require('path');

jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
const { isEnabled } = require('../config/feature-gates');
const { docCardTapDarkGuard, CARD_TAP_SURFACES } = require('../middleware/doc-card-tap-dark-guard');

const RECEIPT_TOKEN = 'a'.repeat(64);

function run(req, surface = CARD_TAP_SURFACES.receipt) {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.set = jest.fn((k, v) => { res.headers[k] = v; return res; });
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  const next = jest.fn();
  docCardTapDarkGuard(surface, req, res, next);
  return { res, next };
}

const PRIVACY = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

// Express matches a route name in any letter case and with or without a
// closing slash, so the guard must too: a spelling it missed would reach the
// limiter while the gate is dark.
test.each([
  `/${RECEIPT_TOKEN}/cross-sell`,
  `/${RECEIPT_TOKEN}/referral-link`,
  `/${RECEIPT_TOKEN}/cross-sell/`,
  `/${RECEIPT_TOKEN}/CROSS-SELL`,
  `/${RECEIPT_TOKEN}/Referral-Link/`,
  '/abc/cross-sell',
])('gate off: POST %s → the route\'s own 404 with privacy headers', (p) => {
  isEnabled.mockReturnValue(false);
  const { res, next } = run({ method: 'POST', path: p });
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(404);
  expect(res.body).toEqual({ error: 'Receipt not found' });
  expect(res.headers).toEqual(PRIVACY);
});

test.each([
  ['receipt: too short', CARD_TAP_SURFACES.receipt, '/abc/cross-sell', { error: 'Receipt not found' }],
  ['receipt: a character outside the token set', CARD_TAP_SURFACES.receipt, `/${'a'.repeat(30)}!/referral-link`, { error: 'Receipt not found' }],
  ['receipt: a segment that cannot be decoded', CARD_TAP_SURFACES.receipt, `/${'a'.repeat(30)}%E0%A4%A/cross-sell`, { error: 'Receipt not found' }],
  ['tracker: a valid receipt token is not a track token', CARD_TAP_SURFACES.track, `/${'A'.repeat(64)}/cross-sell`, { error: 'Not found' }],
  ['tracker: too short', CARD_TAP_SURFACES.track, '/nope/Cross-Sell', { error: 'Not found' }],
])('gate on, %s → the same 404 before the limiter', (_label, surface, p, body) => {
  isEnabled.mockReturnValue(true);
  const { res, next } = run({ method: 'POST', path: p }, surface);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(404);
  expect(res.body).toEqual(body);
  expect(res.headers).toEqual(PRIVACY);
});

test('gate on, a well-formed token passes, with the privacy headers on whatever answers next', () => {
  isEnabled.mockReturnValue(true);
  for (const [surface, token] of [[CARD_TAP_SURFACES.receipt, RECEIPT_TOKEN], [CARD_TAP_SURFACES.track, 'f'.repeat(64)]]) {
    const { res, next } = run({ method: 'POST', path: `/${token}/cross-sell` }, surface);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.headers).toEqual(PRIVACY);
  }
});

test.each([
  ['the receipt GET', 'GET', `/${RECEIPT_TOKEN}`],
  ['a GET of a tap path', 'GET', `/${RECEIPT_TOKEN}/cross-sell`],
  ['another POST', 'POST', `/${RECEIPT_TOKEN}/view`],
])('gate off: %s passes through untouched', (_label, method, p) => {
  isEnabled.mockReturnValue(false);
  const { res, next } = run({ method, path: p });
  expect(next).toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.set).not.toHaveBeenCalled();
});

test('index.js mounts the guard for both surfaces ahead of the global /api/ limiter', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const limiter = src.indexOf("app.use('/api/', limiter);");
  const receipt = src.indexOf("app.use('/api/receipt', (req, res, next) => docCardTapDarkGuard(CARD_TAP_SURFACES.receipt,");
  const track = src.indexOf("app.use('/api/public/track', (req, res, next) => docCardTapDarkGuard(CARD_TAP_SURFACES.track,");
  expect(limiter).toBeGreaterThan(0);
  expect(receipt).toBeGreaterThan(0);
  expect(track).toBeGreaterThan(0);
  expect(receipt).toBeLessThan(limiter);
  expect(track).toBeLessThan(limiter);
});

// docs/gates-and-env.md: both gates are read at call time, so unsetting one
// stops its cards, taps or email line in a running process (no restart).
test('both document gates follow the environment after the gates module has loaded', () => {
  const real = jest.requireActual('../config/feature-gates');
  const names = { docCrossSell: 'GATE_DOC_CROSS_SELL', docCrossSellEmail: 'GATE_DOC_CROSS_SELL_EMAIL' };
  const prior = Object.fromEntries(Object.values(names).map((name) => [name, process.env[name]]));
  try {
    for (const [gate, name] of Object.entries(names)) {
      delete process.env[name];
      expect(real.isEnabled(gate)).toBe(false);
      process.env[name] = 'true';
      expect(real.isEnabled(gate)).toBe(true);
      process.env[name] = '1';
      expect(real.isEnabled(gate)).toBe(false);
    }
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
