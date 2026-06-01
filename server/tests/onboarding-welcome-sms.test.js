const mockDb = jest.fn();

mockDb.fn = { now: jest.fn(() => new Date('2026-06-01T12:00:00Z')) };

jest.mock('express', () => ({
  Router: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
  })),
}), { virtual: true });
jest.mock('../models/db', () => mockDb);
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(),
}));
jest.mock('../services/billing-cadence', () => ({
  parseEstimateData: jest.fn(() => ({})),
  resolveBillingCadence: jest.fn(() => ({ label: 'Monthly' })),
}));
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: jest.fn(async () => false),
}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn(),
}));

const onboardingRouter = require('../routes/onboarding');

describe('onboarding welcome SMS formatting', () => {
  test('formats valid service dates for the welcome SMS', () => {
    expect(onboardingRouter._private.formatOnboardingServiceDate('2026-06-03')).toBe('Jun 3');
    expect(onboardingRouter._private.formatOnboardingServiceDate(new Date('2026-06-03T00:00:00.000Z'))).toBe('Jun 3');
  });

  test('falls back to TBD instead of rendering Invalid Date', () => {
    expect(onboardingRouter._private.formatOnboardingServiceDate(null)).toBe('TBD');
    expect(onboardingRouter._private.formatOnboardingServiceDate('')).toBe('TBD');
    expect(onboardingRouter._private.formatOnboardingServiceDate('not-a-date')).toBe('TBD');
  });

  test('omits the tech clause when no tech name exists', () => {
    expect(onboardingRouter._private.onboardingTechClause({ tech_name: 'Virginia' })).toBe(' with Virginia');
    expect(onboardingRouter._private.onboardingTechClause({ tech_name: null })).toBe('');
    expect(onboardingRouter._private.onboardingTechClause(null)).toBe('');
  });
});
