jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/cors-origins', () => ({ allowedOrigins: [] }));
jest.mock('../sockets/auth', () => ({ socketAuth: jest.fn() }));

const db = require('../models/db');
const sockets = require('../sockets');

function staffSocket(overrides = {}) {
  return {
    userType: 'technician',
    userId: 'tech-1',
    staffTokenVersion: 3,
    disconnected: false,
    emit: jest.fn(),
    disconnect: jest.fn(function disconnect() { this.disconnected = true; }),
    ...overrides,
  };
}

describe('live staff socket revocation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('immediately disconnects every matching local staff socket only', () => {
    const matching = staffSocket();
    const otherStaff = staffSocket({ userId: 'tech-2' });
    const customer = staffSocket({ userType: 'customer' });
    const io = { sockets: { sockets: new Map([
      ['matching', matching],
      ['other', otherStaff],
      ['customer', customer],
    ]) } };

    expect(sockets._disconnectMatchingStaffSockets(io, 'tech-1', 'password_changed')).toBe(1);
    expect(matching.emit).toHaveBeenCalledWith('auth:revoked', expect.objectContaining({ reason: 'password_changed' }));
    expect(matching.disconnect).toHaveBeenCalledWith(true);
    expect(otherStaff.disconnect).not.toHaveBeenCalled();
    expect(customer.disconnect).not.toHaveBeenCalled();
  });

  test('cross-replica DB recheck fails closed after a token-version rotation', async () => {
    const socket = staffSocket();
    db.mockImplementation(() => ({
      where: jest.fn(() => ({
        first: jest.fn(async () => ({
          id: 'tech-1',
          active: true,
          role: 'technician',
          auth_token_version: 4,
          must_change_password: false,
        })),
      })),
    }));

    await expect(sockets._revalidateStaffSocket(socket)).resolves.toBe(false);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
