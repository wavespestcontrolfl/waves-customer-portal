// Proves isLandline shares the phone_line_types cache with the send-pipeline
// validator, so a number is looked up at most once across both paths.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(),
  cacheLineType: jest.fn(async () => {}),
}));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC', authToken: 'tok' } }));

const mockFetch = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({
  lookups: { v2: { phoneNumbers: jest.fn(() => ({ fetch: mockFetch })) } },
})));

const db = require('../models/db');
const { readCachedLineType, cacheLineType } = require('../services/messaging/validators/line-type');
const { isLandline } = require('../services/appointment-reminders')._internals;

function wireCustomer(customer) {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => customer), update: jest.fn(async () => 1) };
  db.mockImplementation(() => q);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
});

describe('isLandline shares the phone_line_types cache', () => {
  test('shared-cache hit (landline) → returns true WITHOUT a Twilio Lookup', async () => {
    wireCustomer({ id: 'c1', phone: '+19415550101', line_type: null });
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });

    const res = await isLandline('c1', '+19415550101');

    expect(res).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled(); // no second lookup
  });

  test('shared-cache hit (mobile) on a SERVICE-contact number → false, no Lookup', async () => {
    // checked phone differs from the customer primary → service contact, which the
    // legacy customers.line_type cache never covered. Shared cache still hits.
    wireCustomer({ id: 'c1', phone: '+19415550101', line_type: null });
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'mobile' });

    const res = await isLandline('c1', '+18135559999');

    expect(res).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('shared-cache miss → Twilio Lookup once, then seeds the shared cache', async () => {
    wireCustomer({ id: 'c1', phone: '+18135559999', line_type: null }); // checked == primary, but no legacy cache
    readCachedLineType.mockResolvedValue({ state: 'miss' });
    mockFetch.mockResolvedValue({ lineTypeIntelligence: { type: 'landline' } });

    const res = await isLandline('c1', '+18135559999');

    expect(res).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(cacheLineType).toHaveBeenCalledWith('+18135559999', 'landline');
  });
});
