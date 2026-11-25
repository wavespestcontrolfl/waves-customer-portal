// The track-token socket path binds the bearer token in its lookup, and a knex error message carries its bound
// values. A failed lookup must log the driver code only (holder tokens included), and still answer AUTH_FAILED.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
}));
jest.mock('../config', () => ({ jwt: { secret: 'socket-test-secret' } }));

const db = require('../models/db');
const logger = require('../services/logger');
const { socketAuth } = require('../sockets/auth');

const TOKEN = 'e'.repeat(64);

test('a failed track-token lookup logs the driver code only, never the token', async () => {
  const boom = Object.assign(
    new Error(`select "s"."id" from "scheduled_services" as "s" where "s"."track_view_token" = '${TOKEN}' - connection terminated`),
    { code: '57P01' },
  );
  db.mockImplementation(() => {
    const q = { leftJoin: () => q, where: () => q, first: async () => { throw boom; } };
    return q;
  });
  const socket = { handshake: { auth: { trackToken: TOKEN }, headers: {} } };
  const next = jest.fn();
  await socketAuth(socket, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[0][0]).toMatchObject({ data: { code: 'AUTH_FAILED' } });
  const logged = JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls]);
  expect(logged).not.toContain(TOKEN);
  expect(logged).toContain('code=57P01');
  expect(socket.userType).toBeUndefined();
});

test('a recipient\'s token (not a track_view_token) is never a socket credential: no row, no room', async () => {
  db.mockImplementation(() => {
    const q = { leftJoin: () => q, where: () => q, first: async () => null };
    return q;
  });
  const socket = { handshake: { auth: { trackToken: TOKEN }, headers: {} } };
  const next = jest.fn();
  await socketAuth(socket, next);
  expect(next.mock.calls[0][0]).toMatchObject({ data: { code: 'TRACK_TOKEN_INVALID' } });
  expect(socket.userType).toBeUndefined();
});
