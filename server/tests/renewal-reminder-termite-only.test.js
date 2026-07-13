jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({}));

const db = require('../models/db');
const renewalReminder = require('../services/workflows/renewal-reminder');

// OWNER RULING (2026-07-13): "renewal" language is reserved for termite
// bonds — the only service with a real fixed term. This test pins the cron
// to that ruling so a WaveGuard/mosquito leg can't quietly come back.
describe('renewal reminders are termite-bond-only', () => {
  test('checkAndSend queries only termite_renewal_date', async () => {
    const columnsQueried = [];
    db.mockImplementation(() => {
      const q = {
        whereNotNull: jest.fn((col) => { columnsQueried.push(col); return q; }),
        whereRaw: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        where: jest.fn(() => q),
        select: jest.fn(async () => []),
        first: jest.fn(async () => undefined),
      };
      return q;
    });

    const out = await renewalReminder.checkAndSend();
    expect(out).toEqual({ sent: 0 });
    expect(columnsQueried.length).toBeGreaterThan(0);
    expect([...new Set(columnsQueried)]).toEqual(['termite_renewal_date']);
    expect(columnsQueried).not.toContain('waveguard_renewal_date');
    expect(columnsQueried).not.toContain('mosquito_season_start');
  });
});
