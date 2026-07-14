jest.mock('../config', () => ({ jwt: { secret: 'maintenance-socket-secret' } }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { socketAuth } = require('../sockets/auth');

const SECRET = 'maintenance-socket-secret';
const originalMode = process.env.STAFF_MAINTENANCE_MODE;

function socketWithToken(token) {
  return { handshake: { auth: { token }, headers: {} } };
}

function mockIdentityLookup(row) {
  db.mockImplementation(() => ({
    where: jest.fn(() => ({ first: jest.fn(async () => row) })),
  }));
}

function mockTrackLookup(row) {
  db.mockImplementation(() => {
    const query = {
      leftJoin: jest.fn(() => query),
      where: jest.fn(() => query),
      first: jest.fn(async () => row),
    };
    return query;
  });
}

async function authorize(socket) {
  let result;
  await socketAuth(socket, (error) => {
    result = error || null;
  });
  return result;
}

beforeEach(() => db.mockReset());

afterEach(() => {
  if (originalMode === undefined) delete process.env.STAFF_MAINTENANCE_MODE;
  else process.env.STAFF_MAINTENANCE_MODE = originalMode;
});

describe('Staff maintenance Socket.io interlock', () => {
  test('rejects a valid Staff handshake before any identity lookup', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const token = jwt.sign({ technicianId: 'tech-1', role: 'admin' }, SECRET);

    const error = await authorize(socketWithToken(token));

    expect(error).toBeInstanceOf(Error);
    expect(error.data).toEqual({ code: 'STAFF_MAINTENANCE' });
    expect(db).not.toHaveBeenCalled();
  });

  test('rejects the supported Authorization-header Staff fallback', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const token = jwt.sign({ technicianId: 'tech-1', role: 'technician' }, SECRET);
    const socket = {
      handshake: {
        auth: {},
        headers: { authorization: `Bearer ${token}` },
      },
    };

    const error = await authorize(socket);

    expect(error.data).toEqual({ code: 'STAFF_MAINTENANCE' });
    expect(db).not.toHaveBeenCalled();
  });

  test('keeps customer JWT sockets available during maintenance', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    mockIdentityLookup({ id: 'customer-1', active: true });
    const socket = socketWithToken(jwt.sign({ customerId: 'customer-1' }, SECRET));

    await expect(authorize(socket)).resolves.toBeNull();
    expect(socket.userType).toBe('customer');
    expect(socket.userId).toBe('customer-1');
  });

  test('keeps public tracking sockets available during maintenance', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    mockTrackLookup({
      id: 'job-1',
      customer_id: 'customer-1',
      track_token_expires_at: new Date(Date.now() + 60_000),
      active: true,
    });
    const socket = {
      handshake: {
        auth: { trackToken: 'a'.repeat(64) },
        headers: {},
      },
    };

    await expect(authorize(socket)).resolves.toBeNull();
    expect(socket.userType).toBe('customer-track');
    expect(socket.userId).toBe('customer-1');
  });

  test('authenticates Staff normally while the interlock is disabled', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'false';
    mockIdentityLookup({
      id: 'tech-1',
      active: true,
      role: 'technician',
      auth_token_version: 2,
      must_change_password: false,
    });
    const socket = socketWithToken(jwt.sign({
      technicianId: 'tech-1',
      role: 'technician',
      type: 'access',
      tokenVersion: 2,
    }, SECRET));

    await expect(authorize(socket)).resolves.toBeNull();
    expect(socket.userType).toBe('technician');
    expect(socket.userId).toBe('tech-1');
  });

  test('does not relabel an invalid Staff-looking token as maintenance', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const token = jwt.sign({ technicianId: 'tech-1' }, 'wrong-secret');

    const error = await authorize(socketWithToken(token));

    expect(error.data).toEqual({ code: 'AUTH_FAILED' });
    expect(db).not.toHaveBeenCalled();
  });
});
