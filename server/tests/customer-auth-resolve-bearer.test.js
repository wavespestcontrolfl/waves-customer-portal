/**
 * resolveBearerCustomer — the optional-auth resolver public routes use to
 * ACCEPT a customer bearer without demanding one (first consumer:
 * /booking/confirm under GATE_BOOKING_CUSTOMERS_ONLY). It mirrors
 * authenticateCore's access-token contract but returns the customer row (or
 * null) instead of writing 401s. Every branch matters: a miss here either
 * locks a real customer out of self-scheduling or lets a non-customer
 * through the customers-only gate.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'resolve-bearer-test-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// The resolver's single query: customers by id + active, non-deleted.
const state = { customerRow: null, lastWhere: null };
jest.mock('../models/db', () => {
  const dbFn = jest.fn(() => {
    const q = {};
    q.where = (arg) => { state.lastWhere = arg; return q; };
    q.whereNull = () => q;
    q.first = async () => state.customerRow;
    return q;
  });
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const jwt = require('jsonwebtoken');
const { resolveBearerCustomer, generateToken, generateRefreshToken } = require('../middleware/auth');

const CUST_ID = 'cust-1';
const reqWith = (authorization) => ({ headers: authorization ? { authorization } : {} });

beforeEach(() => {
  state.customerRow = null;
  state.lastWhere = null;
});

describe('resolveBearerCustomer', () => {
  test('valid access token + active customer on file → the customer row', async () => {
    state.customerRow = { id: CUST_ID, active: true, account_id: null };
    const customer = await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID)}`));
    expect(customer).toEqual(state.customerRow);
    // The lookup itself carries the active filter — an inactive or deleted
    // customer never comes back from the query, so it resolves to null.
    expect(state.lastWhere).toEqual({ id: CUST_ID, active: true });
  });

  test('absent / non-Bearer authorization → null, no lookup', async () => {
    expect(await resolveBearerCustomer(reqWith(null))).toBeNull();
    expect(await resolveBearerCustomer(reqWith('Basic dXNlcjpwYXNz'))).toBeNull();
    expect(state.lastWhere).toBeNull();
  });

  test('garbage and expired tokens → null (never throws)', async () => {
    state.customerRow = { id: CUST_ID, active: true };
    expect(await resolveBearerCustomer(reqWith('Bearer not-a-jwt'))).toBeNull();
    const expired = jwt.sign({ customerId: CUST_ID }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    expect(await resolveBearerCustomer(reqWith(`Bearer ${expired}`))).toBeNull();
  });

  test('refresh tokens are rejected outright — even with a customer on file', async () => {
    state.customerRow = { id: CUST_ID, active: true };
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateRefreshToken(CUST_ID)}`))).toBeNull();
    expect(state.lastWhere).toBeNull();
  });

  test('token without a customerId claim → null', async () => {
    const anonymous = jwt.sign({ role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    expect(await resolveBearerCustomer(reqWith(`Bearer ${anonymous}`))).toBeNull();
  });

  test('customer no longer on file (inactive/deleted lookup miss) → null', async () => {
    state.customerRow = null;
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID)}`))).toBeNull();
  });

  test('accountId claim must match the customer account (account_id, else own id)', async () => {
    state.customerRow = { id: CUST_ID, active: true, account_id: 'acct-1' };
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID, 'acct-OTHER')}`))).toBeNull();
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID, 'acct-1')}`))).toEqual(state.customerRow);

    // No account row linkage: the customer's own id is the account id.
    state.customerRow = { id: CUST_ID, active: true, account_id: null };
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID, CUST_ID)}`))).toEqual(state.customerRow);
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID, 'acct-OTHER')}`))).toBeNull();
  });

  test('token with no accountId claim skips the consistency check (legacy tokens)', async () => {
    state.customerRow = { id: CUST_ID, active: true, account_id: 'acct-1' };
    expect(await resolveBearerCustomer(reqWith(`Bearer ${generateToken(CUST_ID)}`))).toEqual(state.customerRow);
  });
});
