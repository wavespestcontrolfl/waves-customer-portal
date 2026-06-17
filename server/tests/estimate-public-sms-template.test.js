process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

describe('public estimate SMS templates', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('../routes/admin-sms-templates');
  });

  test('renders an editable accept SMS from the admin SMS template', async () => {
    const getTemplate = jest.fn(async () => 'Rendered template body');
    jest.doMock('../routes/admin-sms-templates', () => ({ getTemplate }));

    const { renderEditableSmsTemplate } = require('../routes/estimate-public');
    const body = await renderEditableSmsTemplate('estimate_accepted_onetime', {
      first_name: 'Ada',
    });

    expect(body).toBe('Rendered template body');
    expect(getTemplate).toHaveBeenCalledWith('estimate_accepted_onetime', {
      first_name: 'Ada',
    }, {});
  });

  test('renders annual prepay acceptance SMS from the admin SMS template', async () => {
    const getTemplate = jest.fn(async () => 'Annual prepay template body');
    jest.doMock('../routes/admin-sms-templates', () => ({ getTemplate }));

    const { renderEditableSmsTemplate } = require('../routes/estimate-public');
    const body = await renderEditableSmsTemplate('estimate_accepted_annual_prepay', {
      first_name: 'Ada',
      waveguard_tier: 'Gold',
      amount_text: ' for $1,200.00',
    });

    expect(body).toBe('Annual prepay template body');
    expect(getTemplate).toHaveBeenCalledWith('estimate_accepted_annual_prepay', {
      first_name: 'Ada',
      waveguard_tier: 'Gold',
      amount_text: ' for $1,200.00',
    }, {});
  });

  test('does not provide hardcoded fallback copy when the SMS template is unavailable', async () => {
    jest.doMock('../routes/admin-sms-templates', () => ({
      getTemplate: jest.fn(async () => null),
    }));

    const { renderEditableSmsTemplate } = require('../routes/estimate-public');
    const body = await renderEditableSmsTemplate('estimate_accepted_onetime', {
      first_name: 'Ada',
    });

    expect(body).toBeNull();
  });

  test('registers accepted estimate slot appointments for reminder cron without duplicate confirmation SMS', async () => {
    const registerAppointment = jest.fn(async () => ({ id: 'reminder-1' }));
    const { registerAcceptedEstimateAppointmentReminder } = require('../routes/estimate-public');

    await registerAcceptedEstimateAppointmentReminder({
      appointment: {
        id: 'scheduled-service-1',
        scheduled_date: '2026-06-01',
        window_start: '10:00:00',
        service_type: 'General Pest Control',
      },
      customerId: 'customer-1',
      appointmentReminders: { registerAppointment },
    });

    expect(registerAppointment).toHaveBeenCalledWith(
      'scheduled-service-1',
      'customer-1',
      '2026-06-01T10:00',
      'General Pest Control',
      'estimate_accept_slot',
      { sendConfirmation: false },
    );
  });

  test('seeds annual prepay acceptance as a protected SMS template', () => {
    const { TEMPLATES } = require('../models/migrations/20260514000002_tighten_sms_template_copy');
    const template = TEMPLATES.find((row) => row.template_key === 'estimate_accepted_annual_prepay');

    expect(template).toMatchObject({
      name: 'Estimate Accepted — Annual Prepay',
      category: 'estimates',
      variables: ['first_name', 'waveguard_tier', 'amount_text'],
    });
    expect(template.body).toContain('{waveguard_tier}');
    expect(template.body).toContain('{amount_text}');
  });
});
