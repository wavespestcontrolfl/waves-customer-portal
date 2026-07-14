jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  isStaffAccessToken: jest.fn((decoded) => decoded?.type === 'access' && Number.isInteger(decoded.tokenVersion)),
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

describe('staff socket token scope', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    [{ technicianId: 'tech-1', type: 'refresh' }],
    [{ technicianId: 'tech-1' }],
    [{ technicianId: 'tech-1', type: 'bouncie_oauth', tokenVersion: 0 }],
    [{ technicianId: 'tech-1', type: 'access', tokenVersion: 0, scope: 'terminal' }],
  ])('rejects non-general staff JWTs before a database lookup', async (claims) => {
    const { next } = await authenticate(claims);

    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0][0];
    expect(error).toMatchObject({
      message: 'Invalid token type',
      data: { code: 'AUTH_FAILED' },
    });
    expect(db).not.toHaveBeenCalled();
  });
});
