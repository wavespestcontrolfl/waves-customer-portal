/**
 * The unread count (bell badge, push badge) counts an owner-only row (metadata.ownerOnly: a Claude plan bell) for the
 * owner login alone, as the bell list shows it to the owner alone. The owner check reads the login's own technicians-row
 * email against the ib-access full-access list, and fails closed.
 */
const mockState = { technician: null, throwOnRead: false };
jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const b = {
      where: jest.fn(() => b),
      first: jest.fn(async () => {
        if (mockState.throwOnRead) throw new Error('db down');
        return mockState.technician;
      }),
    };
    return b;
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ getAdminUnreadCount: jest.fn(async () => 3) }));
jest.mock('../services/notification-bell-policy', () => ({ isBellPolicyEnabled: () => true }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn(), toNotifications: jest.fn() }));
jest.mock('../services/dashboard-alerts-cron', () => ({ COUNT_ESCALATION_COOLDOWN_MS: 1000 }));

const NotificationService = require('../services/notification-service');
const { DEFAULT_FULL_ACCESS_EMAILS } = require('../services/intelligence-bar/ib-access');
const { _private: { ownerLogin, computeUnreadCount } } = require('../services/admin-unread');

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';

beforeEach(() => {
  mockState.technician = null;
  mockState.throwOnRead = false;
  NotificationService.getAdminUnreadCount.mockClear();
  delete process.env.IB_FULL_ACCESS_EMAILS;
});

describe('ownerLogin', () => {
  test('true only for a login whose own email is on the full-access list', async () => {
    mockState.technician = { email: DEFAULT_FULL_ACCESS_EMAILS[0] };
    expect(await ownerLogin(ADMIN_ID)).toBe(true);
    mockState.technician = { email: 'office.manager@example.com' };
    expect(await ownerLogin(ADMIN_ID)).toBe(false);
  });

  test('fails closed: no id, no row, a blank email or a failed read is not the owner', async () => {
    expect(await ownerLogin(null)).toBe(false);
    mockState.technician = null;
    expect(await ownerLogin(ADMIN_ID)).toBe(false);
    mockState.technician = { email: '' };
    expect(await ownerLogin(ADMIN_ID)).toBe(false);
    mockState.throwOnRead = true;
    expect(await ownerLogin(ADMIN_ID)).toBe(false);
  });
});

describe('computeUnreadCount', () => {
  test('passes fullAccess true for the owner login, so owner-only rows count for the owner', async () => {
    mockState.technician = { email: DEFAULT_FULL_ACCESS_EMAILS[0] };
    expect(await computeUnreadCount({ adminUserId: ADMIN_ID, role: 'admin' })).toBe(3);
    expect(NotificationService.getAdminUnreadCount).toHaveBeenCalledWith(
      { role: 'admin', technicianId: ADMIN_ID, fullAccess: true }, null);
  });

  test('passes fullAccess false for any other login and for a non-admin role (no owner read for them)', async () => {
    mockState.technician = { email: 'office.manager@example.com' };
    await computeUnreadCount({ adminUserId: ADMIN_ID, role: 'admin' });
    expect(NotificationService.getAdminUnreadCount).toHaveBeenLastCalledWith(
      { role: 'admin', technicianId: ADMIN_ID, fullAccess: false }, null);
    mockState.technician = { email: DEFAULT_FULL_ACCESS_EMAILS[0] };
    await computeUnreadCount({ adminUserId: ADMIN_ID, role: 'technician' });
    expect(NotificationService.getAdminUnreadCount).toHaveBeenLastCalledWith(
      { role: 'technician', technicianId: ADMIN_ID, fullAccess: false }, null);
  });
});
