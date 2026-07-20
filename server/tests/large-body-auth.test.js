/**
 * P1-10 (07-19 admin audit): the /api/admin and /api/tech 50 MB body parsers
 * ran before authentication, so an anonymous or forged-token caller could force
 * 50 MB of JSON parsing per request. requireStaffTokenForLargeBody challenges
 * anything not proven ≤1 MB and requires a valid STAFF access token for it;
 * bodiless / small requests (GET callbacks, login, webhooks) pass untouched.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
// admin-auth pulls in the db/model layer at require time; the middleware only
// needs isStaffAccessToken, so stub the module to its pure claim check.
jest.mock('../middleware/admin-auth', () => ({
  isStaffAccessToken: (decoded) => decoded?.type === 'access'
    && Number.isInteger(decoded.tokenVersion) && decoded.tokenVersion >= 1,
}));

const jwt = require('jsonwebtoken');
const { requireStaffTokenForLargeBody, STAFF_LARGE_BODY_AUTH_MIN } = require('../middleware/large-body-auth');

function run(headers = {}) {
  const req = { headers };
  let status = null;
  let body = null;
  let nexted = false;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  requireStaffTokenForLargeBody(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

const LARGE = String(STAFF_LARGE_BODY_AUTH_MIN + 1);
const staffToken = (extra = {}) => jwt.sign({ technicianId: 't1', type: 'access', tokenVersion: 1, ...extra }, 'test-secret');

describe('requireStaffTokenForLargeBody', () => {
  test('bodiless and small requests pass with no auth', () => {
    expect(run({}).nexted).toBe(true); // no body (e.g. GET OAuth callback)
    expect(run({ 'content-length': String(500 * 1024) }).nexted).toBe(true);
    expect(run({ 'content-length': String(STAFF_LARGE_BODY_AUTH_MIN) }).nexted).toBe(true);
  });

  test('large body with no token is rejected before parsing', () => {
    const r = run({ 'content-length': LARGE });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'Authentication required' });
  });

  test('chunked/unknown-length body without a token is rejected (no Content-Length bypass)', () => {
    expect(run({ 'transfer-encoding': 'chunked' }).status).toBe(401);
  });

  test('large body with a valid staff token passes to the parser', () => {
    const r = run({ 'content-length': LARGE, authorization: `Bearer ${staffToken()}` });
    expect(r.nexted).toBe(true);
    expect(r.status).toBeNull();
  });

  test('a validly-signed but NON-staff token is rejected', () => {
    // customer-shaped (no type/tokenVersion), terminal-scoped, and missing-tech
    const customer = jwt.sign({ sub: 'cust-1' }, 'test-secret');
    const terminal = jwt.sign({ technicianId: 't1', type: 'access', tokenVersion: 1, scope: 'terminal' }, 'test-secret');
    const noTech = jwt.sign({ type: 'access', tokenVersion: 1 }, 'test-secret');
    expect(run({ 'content-length': LARGE, authorization: `Bearer ${customer}` }).status).toBe(401);
    expect(run({ 'content-length': LARGE, authorization: `Bearer ${terminal}` }).status).toBe(401);
    expect(run({ 'content-length': LARGE, authorization: `Bearer ${noTech}` }).status).toBe(401);
  });

  test('forged, wrong-secret, and expired tokens are rejected', () => {
    const wrongSecret = jwt.sign({ technicianId: 't1', type: 'access', tokenVersion: 1 }, 'other-secret');
    const expired = jwt.sign({ technicianId: 't1', type: 'access', tokenVersion: 1 }, 'test-secret', { expiresIn: -10 });
    expect(run({ 'content-length': LARGE, authorization: 'Bearer garbage' }).status).toBe(401);
    expect(run({ 'content-length': LARGE, authorization: `Bearer ${wrongSecret}` }).status).toBe(401);
    expect(run({ 'content-length': LARGE, authorization: `Bearer ${expired}` }).status).toBe(401);
  });
});
