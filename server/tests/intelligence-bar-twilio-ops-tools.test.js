/**
 * Twilio ops tools — unit tests with a mocked Twilio REST API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), alert URL redaction (path only — query
 * strings can carry tokens/PII), that message BODIES never appear in
 * results, and that every failure surfaces as { error } instead of throwing.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const TWILIO_ENV_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_BASE', 'TWILIO_MONITOR_BASE'];

const savedEnv = {};
let executeTwilioOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of TWILIO_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of TWILIO_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of TWILIO_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeTwilioOpsTool } = require('../services/intelligence-bar/twilio-ops-tools'));
});

describe('intelligence bar Twilio ops tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeTwilioOpsTool('get_twilio_alerts', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const result = await executeTwilioOpsTool('send_sms', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_twilio_alerts strips query strings from request URLs', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      alerts: [{
        date_generated: '2026-07-11T10:00:00Z',
        log_level: 'error',
        error_code: '11200',
        alert_text: 'HTTP retrieval failure',
        request_url: 'https://portal.example.com/api/twilio/sms?AccountSid=AC123&Token=secret',
      }],
    }));

    const result = await executeTwilioOpsTool('get_twilio_alerts', {});
    expect(result.error).toBeUndefined();
    expect(result.alerts[0].request_path).toBe('/api/twilio/sms');
    expect(JSON.stringify(result)).not.toContain('Token=secret');
  });

  test('get_twilio_failed_messages filters to failed/undelivered and never includes bodies', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const now = new Date().toISOString();
    global.fetch.mockResolvedValueOnce(jsonResponse({
      messages: [
        { sid: 'SM1', to: '+19415551234', direction: 'outbound-api', status: 'failed', error_code: 30003, error_message: 'Unreachable', date_sent: now, body: 'SECRET CUSTOMER TEXT' },
        { sid: 'SM2', to: '+19415555678', direction: 'outbound-api', status: 'delivered', error_code: null, error_message: null, date_sent: now, body: 'fine' },
        { sid: 'SM3', to: '+19415559999', direction: 'outbound-api', status: 'undelivered', error_code: 30005, error_message: 'Unknown destination', date_sent: now, body: 'ALSO SECRET' },
      ],
    }));

    const result = await executeTwilioOpsTool('get_twilio_failed_messages', {});
    expect(result.error).toBeUndefined();
    expect(result.failed_messages.map(m => m.sid)).toEqual(['SM1', 'SM3']);
    expect(result.scanned_recent_messages).toBe(3);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET CUSTOMER TEXT');
    expect(serialized).not.toContain('ALSO SECRET');
    expect(result.failed_messages[0].body).toBeUndefined();
  });

  test('get_twilio_failed_messages follows next_page_uri until the window is covered', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const now = new Date().toISOString();
    global.fetch
      .mockResolvedValueOnce(jsonResponse({
        messages: [
          { sid: 'SM-ok', to: '+1', direction: 'outbound-api', status: 'delivered', date_sent: now },
        ],
        next_page_uri: '/2010-04-01/Accounts/AC123/Messages.json?PageToken=PT2&PageSize=100',
      }))
      .mockResolvedValueOnce(jsonResponse({
        messages: [
          { sid: 'SM-fail-p2', to: '+1', direction: 'outbound-api', status: 'failed', error_code: 30003, error_message: null, date_sent: now },
        ],
      }));

    const result = await executeTwilioOpsTool('get_twilio_failed_messages', {});
    expect(result.error).toBeUndefined();
    expect(result.failed_messages.map(m => m.sid)).toEqual(['SM-fail-p2']);
    expect(result.scanned_recent_messages).toBe(2);
    expect(result.scan_exhaustive).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(String(global.fetch.mock.calls[1][0])).toContain('PageToken=PT2');
  });

  test('get_twilio_failed_messages stops paging past the window and reports exhaustive scan', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    global.fetch.mockResolvedValueOnce(jsonResponse({
      messages: [
        { sid: 'SM-old', to: '+1', direction: 'outbound-api', status: 'delivered', date_sent: stale },
      ],
      next_page_uri: '/2010-04-01/Accounts/AC123/Messages.json?PageToken=PT2&PageSize=100',
    }));

    const result = await executeTwilioOpsTool('get_twilio_failed_messages', { hours: 24 });
    expect(result.error).toBeUndefined();
    expect(result.scan_exhaustive).toBe(true); // page ran past the window — nothing left to scan
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('get_twilio_failed_messages flags a non-exhaustive scan at the page cap', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const now = new Date().toISOString();
    const page = {
      messages: [{ sid: 'SM-x', to: '+1', direction: 'outbound-api', status: 'delivered', date_sent: now }],
      next_page_uri: '/2010-04-01/Accounts/AC123/Messages.json?PageToken=PTn&PageSize=100',
    };
    global.fetch.mockResolvedValue(jsonResponse(page));

    const result = await executeTwilioOpsTool('get_twilio_failed_messages', {});
    expect(result.error).toBeUndefined();
    expect(result.scan_exhaustive).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(5); // MAX_MESSAGE_PAGES
  });

  test('get_twilio_failed_messages is non-exhaustive when the failure limit fills', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const now = new Date().toISOString();
    global.fetch.mockResolvedValueOnce(jsonResponse({
      messages: [
        { sid: 'SM-f1', to: '+1', direction: 'outbound-api', status: 'failed', error_code: 30003, error_message: null, date_sent: now },
        { sid: 'SM-f2', to: '+1', direction: 'outbound-api', status: 'failed', error_code: 30003, error_message: null, date_sent: now },
        { sid: 'SM-f3', to: '+1', direction: 'outbound-api', status: 'failed', error_code: 30003, error_message: null, date_sent: now },
      ],
    }));

    const result = await executeTwilioOpsTool('get_twilio_failed_messages', { limit: 2 });
    expect(result.error).toBeUndefined();
    expect(result.failed_messages).toHaveLength(2);
    // The limit filled with more failures behind it — must not read as a
    // clean, complete scan.
    expect(result.scan_exhaustive).toBe(false);
  });

  test('get_twilio_failed_messages excludes failures older than the window', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    global.fetch.mockResolvedValueOnce(jsonResponse({
      messages: [
        { sid: 'SM-old', to: '+1', direction: 'outbound-api', status: 'failed', error_code: 30003, error_message: null, date_sent: stale },
      ],
    }));

    const result = await executeTwilioOpsTool('get_twilio_failed_messages', { hours: 24 });
    expect(result.error).toBeUndefined();
    expect(result.failed_messages).toEqual([]);
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'bad';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await executeTwilioOpsTool('get_twilio_alerts', {});
    expect(result.error).toMatch(/rejected the credentials/);
  });
});
