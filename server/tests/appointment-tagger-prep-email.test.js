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
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const executor = require('../services/email-template-automation-executor');
const AppointmentTagger = require('../services/appointment-tagger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { formatDisplayDate } = require('../utils/date-only');

const FUTURE_DATE = etDateString(addETDays(new Date(), 7));
const PAST_DATE = etDateString(addETDays(new Date(), -1));

function service(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Example',
    email: 'taylor@example.com',
    phone: '+19415550101',
    service_type: 'Cockroach Treatment - Interior',
    scheduled_date: FUTURE_DATE,
    status: 'scheduled',
    address_line1: '123 Palm Ave',
    city: 'Bradenton',
    zip: '34211',
    ...overrides,
  };
}

let customerRow;
let priorBookingRow;

function customersQuery() {
  const q = {
    where: jest.fn(() => q),
    first: jest.fn(async () => customerRow),
  };
  return q;
}

// First-time gate lookup (hasPriorSameTypeBooking) — resolves the prior
// same-family scheduled_services row, null = first-time treatment.
function priorBookingQuery() {
  const q = {
    where: jest.fn(() => q),
    whereIn: jest.fn(() => q),
    whereNot: jest.fn(() => q),
    whereNotIn: jest.fn(() => q),
    first: jest.fn(async () => priorBookingRow),
  };
  return q;
}

describe('appointment tagger prep email automation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
    customerRow = {
      id: 'cust-1',
      first_name: 'Taylor',
      last_name: 'Example',
      email: 'taylor@example.com',
    };
    priorBookingRow = null;
    db.mockImplementation((table) => (
      table === 'scheduled_services' ? priorBookingQuery() : customersQuery()
    ));
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
      service_date: formatDisplayDate(FUTURE_DATE),
      property_address: '123 Palm Ave, Bradenton, 34211',
    });
    expect(call.payload.prep_url).toContain('?tab=visits');
    expect(call.payload.customer_portal_url).toContain('?tab=visits');
  });

  test('flea booking maps to prep.flea and renders the auto_flea SMS companion', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');

    await AppointmentTagger.triggerPestPrep(
      service({ service_type: 'Flea Treatment - Interior & Exterior' }),
      'flea',
    );

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.automationKey).toBe('prep.flea');
    expect(call.payload.project_type).toBe('Flea Treatment');
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea',
      { first_name: 'Taylor' },
      { workflow: 'appointment_tagger_prep', entity_type: 'scheduled_service', entity_id: 'svc-1' },
    );
  });

  test('skips prep entirely when the customer already had a same-family booking', async () => {
    const { renderSmsTemplate } = require('../services/sms-template-renderer');
    priorBookingRow = { id: 'svc-0' };

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
    expect(renderSmsTemplate).not.toHaveBeenCalled();
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
      service({ scheduled_date: new Date(`${FUTURE_DATE}T00:00:00Z`) }),
      'cockroach',
    );

    expect(executor.processTrigger.mock.calls[0][0].payload.service_date).toBe(formatDisplayDate(FUTURE_DATE));
  });

  test('skips past-dated appointments (regenerate-brief re-runs)', async () => {
    await AppointmentTagger.triggerPestPrep(service({ scheduled_date: PAST_DATE }), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('skips terminal-status appointments', async () => {
    for (const status of ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']) {
      await AppointmentTagger.triggerPestPrep(service({ status }), 'cockroach');
    }

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('payload carries the calendar date for the send-time appointment.past exit', async () => {
    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger.mock.calls[0][0].payload.service_date_ymd).toBe(FUTURE_DATE);
  });

  test('skips when the emailTemplateAutomations gate is off', async () => {
    isEnabled.mockReturnValue(false);

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    expect(executor.processTrigger).not.toHaveBeenCalled();
  });

  test('routes to the service contact when one is set', async () => {
    customerRow = {
      ...customerRow,
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'onsite@example.com',
    };

    await AppointmentTagger.triggerPestPrep(service(), 'cockroach');

    const call = executor.processTrigger.mock.calls[0][0];
    expect(call.recipient.email).toBe('onsite@example.com');
    expect(call.payload.customer_email).toBe('onsite@example.com');
    expect(call.payload.first_name).toBe('Jamie');
  });

  test('still sends via the service contact when the primary email is blank', async () => {
    customerRow = {
      ...customerRow,
      email: '',
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'onsite@example.com',
    };

    await AppointmentTagger.triggerPestPrep(service({ email: null }), 'bed_bug');

    expect(executor.processTrigger).toHaveBeenCalledTimes(1);
    expect(executor.processTrigger.mock.calls[0][0].recipient.email).toBe('onsite@example.com');
  });

  test('skips when the customer has no valid email on any contact', async () => {
    customerRow = { ...customerRow, email: '' };

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
