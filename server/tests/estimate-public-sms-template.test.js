process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

describe('public estimate SMS templates', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('../routes/admin-sms-templates');
  });

  test('renders recurring accept onboarding SMS from the admin SMS template', async () => {
    const getTemplate = jest.fn(async () => 'Rendered template body');
    jest.doMock('../routes/admin-sms-templates', () => ({ getTemplate }));

    const { renderEditableSmsTemplate } = require('../routes/estimate-public');
    const body = await renderEditableSmsTemplate('estimate_accepted_customer', {
      first_name: 'Ada',
      onboarding_url: 'https://portal.wavespestcontrol.com/l/abc23',
    });

    expect(body).toBe('Rendered template body');
    expect(getTemplate).toHaveBeenCalledWith('estimate_accepted_customer', {
      first_name: 'Ada',
      onboarding_url: 'https://portal.wavespestcontrol.com/l/abc23',
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
    const body = await renderEditableSmsTemplate('estimate_accepted_customer', {
      first_name: 'Ada',
      onboarding_url: 'https://portal.wavespestcontrol.com/l/abc23',
    });

    expect(body).toBeNull();
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
