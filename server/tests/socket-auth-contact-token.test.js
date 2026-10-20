// Contact session (GATE_CONTACT_LOGIN, codex #6363 r8 security P2): a
// contact's JWT carries the HOLDER's customerId. Socket.io's customer room
// has no per-socket revalidation when the holder removes the contact, so a
// contact token gets no live channel at all — rejected before any lookup.
// The holder's own token still joins its room.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
}));
jest.mock('../config', () => ({ jwt: { secret: 'socket-test-secret' } }));

const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { socketAuth } = require('../sockets/auth');

function token(claims) {
  return jwt.sign(claims, 'socket-test-secret', { expiresIn: '15m' });
}

async function authenticate(claims) {
  const socket = { handshake: { auth: { token: token(claims) }, headers: {} } };
  const next = jest.fn();
  await socketAuth(socket, next);
  return { socket, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => ({ where: () => ({ first: async () => ({ id: 'cust-1', active: true }) }) }));
});

test('a contact JWT is refused before any database lookup', async () => {
  const { next, socket } = await authenticate({ customerId: 'cust-1', accountId: 'cust-1', sessionId: 'fam-1', contactKey: '9415550202' });
  expect(next).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[0][0]).toMatchObject({ data: { code: 'AUTH_FAILED' } });
  expect(socket.userType).toBeUndefined();
  expect(db).not.toHaveBeenCalled();
});

test('the holder\'s JWT still joins the customer room', async () => {
  const { next, socket } = await authenticate({ customerId: 'cust-1', accountId: 'cust-1', sessionId: 'fam-1' });
  expect(next).toHaveBeenCalledWith();
  expect(socket.userType).toBe('customer');
  expect(socket.userId).toBe('cust-1');
});
