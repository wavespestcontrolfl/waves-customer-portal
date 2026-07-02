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
  sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/email-template-automation-executor', () => ({
  processTrigger: jest.fn(async () => ({ automation_count: 1, results: [] })),
}));

const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const executor = require('../services/email-template-automation-executor');
const AppointmentTagger = require('../services/appointment-tagger');

function service(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Example',
    email: 'taylor@example.com',
    phone: '+19415550101',
    service_type: 'Cockroach Treatment - Interior',
    scheduled_date: '2026-07-10',
    address_line1: '123 Palm Ave',
    city: 'Bradenton',
    zip: '34211',
    ...overrides,
  };
}

describe('appointment tagger prep email automation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
  });

  test('cockroach booking emits appointment.booked scoped to prep.cockroach', async () => {
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.triggerEventKey).toBe('appointment.booked');
    expect(call.automationKey).toBe('prep.cockroach');
    expect(call.triggerEventId).toBe('appointment_booked:svc-1');
    expect(call.entityType).toBe('scheduled_service');
    expect(call.entityId).toBe('svc-1');
    expect(call.executeImmediately).toBe(false);
    expect(call.recipient).toEqual({ email: 'taylor@example.com', type: 'customer', id: 'cust-1' });
    expect(call.payload).toMatchObject({
      scheduled_service_id: 'svc-1',
      customer_id: 'cust-1',
      customer_email: 'taylor@example.com',
      first_name: 'Taylor',
      service_type: 'Cockroach Treatment - Interior',
      service_date: 'July 10, 2026',
      property_address: '123 Palm Ave, Bradenton, 34211',
    });
    expect(call.payload.prep_url).toContain('?tab=visits');
    expect(call.payload.customer_portal_url).toContain('?tab=visits');
  });

  test('flea booking maps to prep.flea with no SMS companion', async () => {
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

    await AppointmentTagger.triggerPestPrep(
      service({ service_type: 'Flea Treatment - Interior & Exterior' }),
      'flea',
    );

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.automationKey).toBe('prep.flea');
    expect(call.payload.project_type).toBe('Flea Treatment');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('classifier tags flea service types', () => {
    expect(AppointmentTagger.classifyAppointmentType('Flea Treatment')).toEqual({
      tag: 'flea',
      label: 'Flea Treatment',
    });
    expect(AppointmentTagger.classifyAppointmentType('flea & tick service').tag).toBe('flea');
  });

  test('bed bug booking maps to prep.bed_bug', async () => {
    await AppointmentTagger.triggerPestPrep(
      service({ service_type: 'Bed Bug Treatment' }),
      'bed_bug',
    );

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.automationKey).toBe('prep.bed_bug');
    expect(call.payload.project_type).toBe('Bed Bug Treatment');
  });

  test('DATE column returned as a UTC-midnight Date keeps the ET calendar day', async () => {
    await AppointmentTagger.triggerPestPrep(
      service({ scheduled_date: new Date('2026-07-10T00:00:00Z') }),
      'cockroach',
    );

    expect(executor.processTrigger.mock.calls[0][0].payload.service_date).toBe('July 10, 2026');
  });

  test('skips when the emailTemplateAutomations gate is off', async () => {
    isEnabled.mockReturnValue(false);

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('skips when the customer has no email on file', async () => {
    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('prep.bed_bug'));
  });

  test('executor failure is logged and does not throw', async () => {
    executor.processTrigger.mockRejectedValueOnce(new Error('boom'));

    await expect(AppointmentTagger.triggerPestPrep(service(), 'cockroach')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  test('unknown pest type does not emit', async () => {
    await AppointmentTagger.triggerPrepEmailGuide(service(), 'termite');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });
});
