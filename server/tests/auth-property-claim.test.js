/**
 * GATE_APP_PROPERTY_SCOPE — the selected saved property rides the customer
 * session as a `propertyId` claim. The middleware honors it only for the
 * signed-in customer's own ACTIVE customer_properties row; anything else
 * resolves to "no selection" (primary), never a 401.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const { authenticate, generateToken, generateRefreshToken, _test: authTest } = require('../middleware/auth');

const CUSTOMER = { id: 'cust-1', active: true, account_id: 'acct-1', deleted_at: null };
const PROPERTY = { id: 'prop-2', customer_id: 'cust-1', active: true, is_primary: false, label: 'Family - Oak Ave' };

function customerQuery(row = CUSTOMER) {
  return { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) };
}
function propertyQuery(row) {
  return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) };
}
async function run(token) {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await authenticate(req, res, next);
  return { req, res, next };
}

describe('saved-property session claim', () => {
  const originalGate = process.env.GATE_APP_PROPERTY_SCOPE;
  beforeEach(() => { jest.clearAllMocks(); db.mockReset(); });
  afterEach(() => {
    if (originalGate === undefined) delete process.env.GATE_APP_PROPERTY_SCOPE;
    else process.env.GATE_APP_PROPERTY_SCOPE = originalGate;
  });

  test('access and refresh tokens carry propertyId only when one is given', () => {
    const withClaim = jwt.verify(generateToken('cust-1', 'acct-1', 'fam-1', { propertyId: 'prop-2' }), config.jwt.secret);
    expect(withClaim).toMatchObject({ customerId: 'cust-1', accountId: 'acct-1', sessionId: 'fam-1', propertyId: 'prop-2' });
    const without = jwt.verify(generateToken('cust-1', 'acct-1', 'fam-1'), config.jwt.secret);
    expect(without).not.toHaveProperty('propertyId');

    const refresh = jwt.verify(generateRefreshToken('cust-1', 'acct-1', { jti: 'j', familyId: 'f', propertyId: 'prop-2' }), config.jwt.secret);
    expect(refresh).toMatchObject({ type: 'refresh', propertyId: 'prop-2' });
    const refreshPlain = jwt.verify(generateRefreshToken('cust-1', 'acct-1', { jti: 'j', familyId: 'f' }), config.jwt.secret);
    expect(refreshPlain).not.toHaveProperty('propertyId');
  });

  test('gate on: the customer\'s own active property is honored on req', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    const properties = propertyQuery(PROPERTY);
    db.mockReturnValueOnce(customerQuery()).mockReturnValueOnce(properties);

    const { req, res, next } = await run(generateToken('cust-1', 'acct-1', 'fam-1', { propertyId: 'prop-2' }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(db).toHaveBeenCalledTimes(2);
    expect(db.mock.calls[1][0]).toBe('customer_properties');
    // Scoped to THIS customer and active — the check that makes a foreign or retired claim inert.
    expect(properties.where).toHaveBeenCalledWith({ id: 'prop-2', customer_id: 'cust-1', active: true });
    expect(req.propertyId).toBe('prop-2');
    expect(req.property).toEqual(PROPERTY);
    expect(req.customerId).toBe('cust-1');
  });

  test('gate on: a claim that is not this customer\'s (or was retired) resolves to no selection, not a 401', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockReturnValueOnce(customerQuery()).mockReturnValueOnce(propertyQuery(undefined));

    const { req, res, next } = await run(generateToken('cust-1', 'acct-1', 'fam-1', { propertyId: 'prop-of-someone-else' }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.propertyId).toBeNull();
    expect(req.property).toBeNull();
  });

  test('gate on: a FAILED property lookup aborts with a retryable 503 — never a silent primary fallback, never a 401', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    const failing = { where: jest.fn().mockReturnThis(), first: jest.fn().mockRejectedValue(new Error('connection reset')) };
    db.mockReturnValueOnce(customerQuery()).mockReturnValueOnce(failing);

    const { req, res, next } = await run(generateToken('cust-1', 'acct-1', 'fam-1', { propertyId: 'prop-2' }));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'Property selection is temporarily unavailable. Please try again.', code: 'PROPERTY_SCOPE_UNAVAILABLE' });
    expect(req.propertyId).toBeNull();
  });

  test('gate off: the claim is ignored and the property table is never read', async () => {
    delete process.env.GATE_APP_PROPERTY_SCOPE;
    db.mockReturnValueOnce(customerQuery());

    const { req, next } = await run(generateToken('cust-1', 'acct-1', 'fam-1', { propertyId: 'prop-2' }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(req.propertyId).toBeNull();
    expect(req.property).toBeNull();
  });

  test('gate on, no claim: no property lookup, req.propertyId is null (primary)', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    db.mockReturnValueOnce(customerQuery());

    const { req, next } = await run(generateToken('cust-1', 'acct-1', 'fam-1'));

    expect(next).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(req.propertyId).toBeNull();
  });

  test('a cancelled read-only session may read the per-property summary, but never switch', () => {
    expect(authTest.cancelledReadRoute({ method: 'GET', baseUrl: '/api/schedule', path: '/properties-next' })).toBe(true);
    expect(authTest.cancelledReadRoute({ method: 'POST', baseUrl: '/api/auth', path: '/select-property' })).toBe(false);
  });
});
