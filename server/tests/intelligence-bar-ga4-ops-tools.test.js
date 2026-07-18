/**
 * GA4 snapshot tool — unit tests with a mocked ga4 service.
 * Read-only contract: benign dark state (env-gated before the service is
 * touched), day clamping, overview + conversions pass-through, failures as
 * { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockGa4 = {
  getOverview: jest.fn(),
  getConversions: jest.fn(),
};
jest.mock('../services/analytics/ga4', () => mockGa4);

const ENV_KEYS = ['GA4_PROPERTY_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'];
const savedEnv = {};
const { executeGa4OpsTool } = require('../services/intelligence-bar/ga4-ops-tools');

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('intelligence bar GA4 snapshot tool', () => {
  test('unconfigured state is benign — no error field and no service call', async () => {
    const result = await executeGa4OpsTool('get_ga4_snapshot', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/GA4_PROPERTY_ID/);
    expect(mockGa4.getOverview).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.GA4_PROPERTY_ID = '123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
    const result = await executeGa4OpsTool('run_ga4_report');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('passes through overview and conversions with clamped days', async () => {
    process.env.GA4_PROPERTY_ID = '123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
    mockGa4.getOverview.mockResolvedValueOnce({
      configured: true,
      data: { sessions: 900, users: 700, newUsers: 400, bounceRate: 0.4, avgSessionDuration: 62, pageviewsPerSession: 2.1, period: { days: 90 } },
    });
    mockGa4.getConversions.mockResolvedValueOnce({
      configured: true,
      data: [{ event: 'form_submit', count: 12, users: 11 }],
      period: { days: 90 },
    });

    const result = await executeGa4OpsTool('get_ga4_snapshot', { days: 500 });
    expect(result.error).toBeUndefined();
    expect(result.window_days).toBe(90);
    expect(mockGa4.getOverview).toHaveBeenCalledWith(90);
    expect(result.overview.sessions).toBe(900);
    expect(result.conversions[0].event).toBe('form_submit');
  });

  test('service-reported unconfigured maps to the benign dark state', async () => {
    process.env.GA4_PROPERTY_ID = '123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
    mockGa4.getOverview.mockResolvedValueOnce({ configured: false, data: null });
    mockGa4.getConversions.mockResolvedValueOnce({ configured: false, data: null });

    const result = await executeGa4OpsTool('get_ga4_snapshot', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
  });

  test('GA4 API failure surfaces as { error }, never a throw', async () => {
    process.env.GA4_PROPERTY_ID = '123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
    mockGa4.getOverview.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    mockGa4.getConversions.mockResolvedValueOnce({ configured: true, data: [] });

    const result = await executeGa4OpsTool('get_ga4_snapshot', {});
    expect(result.error).toMatch(/PERMISSION_DENIED/);
  });
});
