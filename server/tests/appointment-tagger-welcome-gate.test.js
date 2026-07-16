// The 2026-07-16 misfire: onServiceScheduled welcomed two long-standing
// customers as new because its gate only counted service_records (empty for
// imported customers). The tagger must decide candidacy through the shared
// isNewRecurringSignupCandidate gate, scoped to history that predates the
// triggering booking.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(),
}));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(async () => ({ sent: false, queued: true })),
  isNewRecurringSignupCandidate: jest.fn(async () => false),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
}));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: jest.fn(async () => ({ automation_count: 0, results: [] })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/automation-runner', () => ({
  enrollCustomer: jest.fn(async () => ({ enrolled: false })),
  hasLocalContent: jest.fn(async () => false),
}));

const db = require('../models/db');
const {
  sendNewRecurringWelcome,
  isNewRecurringSignupCandidate,
} = require('../services/new-recurring-welcome-sms');
const AppointmentTagger = require('../services/appointment-tagger');

let serviceRow;

function scheduledServicesChain() {
  const chain = {
    where: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    first: jest.fn(async () => serviceRow),
    update: jest.fn(async () => 1),
  };
  return chain;
}

function serviceFixture(overrides = {}) {
  return {
    id: 'svc-anchor',
    customer_id: 'cust-1',
    first_name: 'Dustin',
    last_name: 'Example',
    phone: '+19415550101',
    email: null,
    service_type: 'Quarterly Pest Control Service',
    scheduled_date: '2026-07-16',
    status: 'pending',
    is_recurring: true,
    recurring_pattern: 'quarterly',
    waveguard_tier: 'Bronze',
    address_line1: '123 Palm Ave',
    city: 'Bradenton',
    zip: '34211',
    ...overrides,
  };
}

describe('appointment tagger welcome gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => scheduledServicesChain());
  });

  test('recurring booking for an existing customer does NOT trigger the welcome', async () => {
    serviceRow = serviceFixture();
    isNewRecurringSignupCandidate.mockResolvedValue(false);

    await AppointmentTagger.onServiceScheduled('svc-anchor');

    expect(isNewRecurringSignupCandidate).toHaveBeenCalledWith('cust-1', {
      excludeServiceId: 'svc-anchor',
    });
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('recurring booking for a genuinely new customer triggers the welcome once', async () => {
    serviceRow = serviceFixture();
    isNewRecurringSignupCandidate.mockResolvedValue(true);

    await AppointmentTagger.onServiceScheduled('svc-anchor');

    expect(sendNewRecurringWelcome).toHaveBeenCalledTimes(1);
    expect(sendNewRecurringWelcome).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: expect.objectContaining({ id: 'cust-1' }),
        scheduledServiceId: 'svc-anchor',
        recurringPattern: 'quarterly',
        entryPoint: 'appointment_tagger_welcome',
      })
    );
  });

  test('suppressWelcome (regenerate-brief replay / estimate-accept reuse) never consults the gate or sends', async () => {
    serviceRow = serviceFixture();
    isNewRecurringSignupCandidate.mockResolvedValue(true);

    await AppointmentTagger.onServiceScheduled('svc-anchor', { suppressWelcome: true });

    expect(isNewRecurringSignupCandidate).not.toHaveBeenCalled();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('one-time booking never consults the gate or sends the welcome', async () => {
    serviceRow = serviceFixture({ is_recurring: false, recurring_pattern: null });
    isNewRecurringSignupCandidate.mockResolvedValue(true);

    await AppointmentTagger.onServiceScheduled('svc-anchor');

    expect(isNewRecurringSignupCandidate).not.toHaveBeenCalled();
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });
});
