jest.mock('../services/token-health', () => ({
  getAll: jest.fn(),
}));

const tokenHealth = require('../services/token-health');
const { getEnvPresence, getIntegrationHealth } = require('../services/integration-health');
const { getIntegrationEnvKeys } = require('../config/integration-registry');

describe('integration health', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const key of getIntegrationEnvKeys()) delete process.env[key];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('env presence is derived from the registry and exposes booleans only', () => {
    const present = getEnvPresence({
      SENDGRID_API_KEY: 'secret-value',
      TWILIO_AUTH_TOKEN: '',
    });

    expect(present).toHaveProperty('SENDGRID_API_KEY', true);
    expect(present).toHaveProperty('TWILIO_AUTH_TOKEN', false);
    expect(Object.values(present).every((value) => typeof value === 'boolean')).toBe(true);
    expect(Object.keys(present)).toEqual(expect.arrayContaining(getIntegrationEnvKeys()));
  });

  test('SendGrid is degraded when API key is healthy but FROM_EMAIL is missing', async () => {
    process.env.SENDGRID_API_KEY = 'set';
    tokenHealth.getAll.mockResolvedValue([
      { platform: 'sendgrid', status: 'healthy', last_verified_at: '2026-05-25T12:00:00.000Z' },
    ]);

    const result = await getIntegrationHealth();
    const sendgrid = result.integrations.find((integration) => integration.id === 'sendgrid');

    expect(sendgrid.health.status).toBe('degraded');
    expect(sendgrid.health.reason).toContain('SENDGRID_FROM_EMAIL');
    expect(sendgrid.env.find((row) => row.key === 'SENDGRID_API_KEY')).toMatchObject({
      present: true,
      required: true,
    });
  });

  test('GBP aggregates child credential checks as a fraction', async () => {
    tokenHealth.getAll.mockResolvedValue([
      { platform: 'gbp_lwr', status: 'healthy', last_verified_at: '2026-05-25T12:00:00.000Z' },
      { platform: 'gbp_parrish', status: 'expired', last_verified_at: '2026-05-25T12:00:00.000Z' },
      { platform: 'gbp_sarasota', status: 'not_configured', last_verified_at: '2026-05-25T12:00:00.000Z' },
      { platform: 'gbp_venice', status: 'not_configured', last_verified_at: '2026-05-25T12:00:00.000Z' },
    ]);

    const result = await getIntegrationHealth();
    const gbp = result.integrations.find((integration) => integration.id === 'google_business_profile');

    expect(gbp.health.status).toBe('degraded');
    expect(gbp.health.label).toBe('Degraded · 1/4');
    expect(gbp.health.lastCheckedAt).toBe('2026-05-25T12:00:00.000Z');
    expect(gbp.health.children).toHaveLength(4);
  });

  test('GBP is degraded when stale healthy checks exist but required env vars are missing', async () => {
    tokenHealth.getAll.mockResolvedValue([
      { platform: 'gbp_lwr', status: 'healthy', last_verified_at: '2026-05-25T12:00:00.000Z' },
      { platform: 'gbp_parrish', status: 'healthy', last_verified_at: '2026-05-25T12:00:00.000Z' },
      { platform: 'gbp_sarasota', status: 'healthy', last_verified_at: '2026-05-25T12:00:00.000Z' },
      { platform: 'gbp_venice', status: 'healthy', last_verified_at: '2026-05-25T12:00:00.000Z' },
    ]);

    const result = await getIntegrationHealth();
    const gbp = result.integrations.find((integration) => integration.id === 'google_business_profile');

    expect(gbp.health.status).toBe('degraded');
    expect(gbp.health.label).toBe('Degraded · 4/4');
    expect(gbp.health.reason).toContain('Missing required config');
  });

  test('Beehiiv is not included in the admin integration registry', async () => {
    tokenHealth.getAll.mockResolvedValue([]);

    const result = await getIntegrationHealth();
    const beehiiv = result.integrations.find((integration) => integration.id === 'beehiiv');

    expect(beehiiv).toBeUndefined();
    expect(getIntegrationEnvKeys()).not.toEqual(expect.arrayContaining(['BEEHIIV_API_KEY', 'BEEHIIV_PUB_ID']));
  });
});
