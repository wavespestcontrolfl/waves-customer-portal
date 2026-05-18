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
    });
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
});
