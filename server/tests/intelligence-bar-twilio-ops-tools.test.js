/**
 * Twilio ops tools — unit tests with a mocked Twilio REST API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), alert URL redaction (path only — query
 * strings can carry tokens/PII), that message BODIES never appear in
 * results, and that every failure surfaces as { error } instead of throwing.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// get_texting_opt_out reads three tables. Each fake query resolves to the
// rows set for its table (an Error rejects) and records the calls made on it.
const mockTables = {};
const mockQueries = [];
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const name = String(table).split(' ')[0];
    const query = { table: name, calls: [] };
    mockQueries.push(query);
    const rows = () => {
      const value = mockTables[name];
      if (value instanceof Error) throw value;
      return value || [];
    };
    const builder = {
      then: (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject),
      first: (...args) => { query.calls.push(['first', ...args]); return Promise.resolve().then(() => rows()[0]); },
    };
    for (const method of ['whereIn', 'where', 'whereNull', 'select', 'join', 'count']) {
      builder[method] = (...args) => { query.calls.push([method, ...args]); return builder; };
    }
    return builder;
  });
  db.raw = (sql) => ({ sql });
  return db;
});

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
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockQueries.length = 0;
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
  test('get_twilio_failed_messages explains a known error code in plain words', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'auth';
    const now = new Date().toUTCString();
    global.fetch.mockResolvedValueOnce(jsonResponse({
      messages: [
        { sid: 'SM1', to: '+19415550101', status: 'undelivered', error_code: 21610, date_sent: now },
        { sid: 'SM2', to: '+19415550102', status: 'failed', error_code: 99999, date_sent: now },
      ],
    }));
    const result = await executeTwilioOpsTool('get_twilio_failed_messages', {});
    expect(result.failed_messages[0].error_meaning).toMatch(/opted out/);
    expect(result.failed_messages[1].error_meaning).toBeNull();
  });

  describe('get_texting_opt_out', () => {
    const PHONE = '+19415550142';
    const query = (table) => mockQueries.find(q => q.table === table);

    test('reads the database without Twilio credentials and reports the Twilio half unavailable', async () => {
      mockTables.messaging_suppression = [{
        reason: 'opt_out_keyword', active: true, source: 'twilio_webhook_STOP',
        created_at: '2026-10-02T14:00:00Z', cleared_at: null, captured_body: 'STOP',
      }];
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: '(941) 555-0142' });
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({
        phone_last4: '0142',
        texts_refused: true,
        do_not_text: { listed: true, reason: 'opt_out_keyword', since: '2026-10-02T14:00:00Z', recorded_by: 'twilio_webhook_STOP' },
        accounts_with_texts_off: 0,
        blocked_number: { blocked: false },
        recent_failed_texts: { available: false },
      });
      expect(result.do_not_text.meaning).toMatch(/STOP/);
      expect(global.fetch).not.toHaveBeenCalled();
      // The stored text that tripped the opt-out is a message body: never selected, never returned.
      expect(query('messaging_suppression').calls.find(c => c[0] === 'select')).not.toContain('captured_body');
      expect(JSON.stringify(result)).not.toContain('captured_body');
      // Rows are stored in E.164; the typed form is matched beside it.
      expect(query('messaging_suppression').calls).toContainEqual(['whereIn', 'phone', ['(941) 555-0142', PHONE]]);
      expect(query('blocked_numbers').calls).toContainEqual(['whereIn', 'number', ['(941) 555-0142', PHONE]]);
    });

    test('a number on no list reads as not refused and not blocked', async () => {
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result).toMatchObject({
        texts_refused: false,
        do_not_text: { listed: false },
        accounts_with_texts_off: 0,
        blocked_number: { blocked: false },
      });
    });

    test('a cleared opt-out reads as not listed, with when and how it was removed', async () => {
      mockTables.messaging_suppression = [{
        reason: 'opt_out_keyword', active: false, source: 'cleared_by:twilio_webhook_START',
        created_at: '2026-09-01T10:00:00Z', cleared_at: '2026-09-20T10:00:00Z',
      }];
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result.texts_refused).toBe(false);
      expect(result.do_not_text).toEqual({ listed: false, removed_at: '2026-09-20T10:00:00Z', removed_by: 'cleared_by:twilio_webhook_START' });
    });

    test('an active row wins over a cleared row for the same number', async () => {
      mockTables.messaging_suppression = [
        { reason: 'cleared', active: false, source: 'cleared_by:twilio_webhook_START', created_at: '2026-09-01T10:00:00Z', cleared_at: '2026-09-01T10:00:00Z' },
        { reason: 'non_mobile', active: true, source: 'twilio_status_30006', created_at: '2026-10-10T10:00:00Z', cleared_at: null },
      ];
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result.do_not_text).toMatchObject({ listed: true, reason: 'non_mobile' });
      expect(result.do_not_text.meaning).toMatch(/Landline/);
    });

    test('an unknown reason is still reported as listed', async () => {
      mockTables.messaging_suppression = [{ reason: 'other', active: true, source: null, created_at: '2026-10-10T10:00:00Z', cleared_at: null }];
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result.texts_refused).toBe(true);
      expect(result.do_not_text).toMatchObject({ listed: true, reason: 'other', meaning: 'Listed for another reason.' });
    });

    test('the account texting switch refuses texts with no do-not-text row', async () => {
      mockTables.customers = [{ count: '1' }];
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result).toMatchObject({ texts_refused: true, do_not_text: { listed: false }, accounts_with_texts_off: 1 });
      const calls = query('customers').calls;
      expect(calls).toContainEqual(['where', 'np.sms_enabled', false]);
      expect(calls).toContainEqual(['whereNull', 'c.deleted_at']);
      // Stored customer phones are mixed format: matched on digits, with and without the country code.
      expect(calls.find(c => c[0] === 'whereIn')[2]).toEqual(['19415550142', '9415550142']);
    });

    test('a blocked number is reported apart from the do-not-text list', async () => {
      mockTables.blocked_numbers = [{ block_type: 'hard_block', auto_blocked: false, blocked_at: '2026-10-05T09:00:00Z', reason: 'x'.repeat(260) }];
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result.texts_refused).toBe(false);
      expect(result.blocked_number).toMatchObject({ blocked: true, block_type: 'hard_block', auto_blocked: false, blocked_at: '2026-10-05T09:00:00Z' });
      expect(result.blocked_number.reason.length).toBeLessThan(230);
    });

    test('lists the failed texts for that number only, newest first, without bodies', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth';
      const recent = new Date(Date.now() - 2 * 3600 * 1000).toUTCString();
      const old = new Date(Date.now() - 9 * 24 * 3600 * 1000).toUTCString();
      global.fetch.mockResolvedValueOnce(jsonResponse({
        messages: [
          { sid: 'SM1', to: PHONE, status: 'undelivered', error_code: 30007, error_message: 'Carrier violation', body: 'SECRET BODY', date_sent: recent },
          { sid: 'SM2', to: PHONE, status: 'delivered', body: 'SECRET BODY', date_sent: recent },
          { sid: 'SM3', to: PHONE, status: 'failed', error_code: 30006, body: 'SECRET BODY', date_sent: old },
        ],
        next_page_uri: null,
      }));
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      const url = new URL(global.fetch.mock.calls[0][0]);
      expect(url.pathname).toBe('/2010-04-01/Accounts/AC123/Messages.json');
      expect(url.searchParams.get('To')).toBe(PHONE);
      expect(result.recent_failed_texts).toMatchObject({ available: true, window_days: 7, total: 1, complete: true });
      expect(result.recent_failed_texts.failures).toEqual([
        { status: 'undelivered', error_code: 30007, error_meaning: expect.stringMatching(/spam/), error_message: 'Carrier violation', date_sent: recent },
      ]);
      expect(JSON.stringify(result)).not.toContain('SECRET BODY');
    });

    test('more failures than the cap are counted and a further page is flagged', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth';
      const recent = new Date(Date.now() - 3600 * 1000).toUTCString();
      global.fetch.mockResolvedValueOnce(jsonResponse({
        messages: Array.from({ length: 14 }, (_, i) => ({ sid: `SM${i}`, to: PHONE, status: 'failed', error_code: 30003, date_sent: recent })),
        next_page_uri: '/2010-04-01/Accounts/AC123/Messages.json?Page=1',
      }));
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result.recent_failed_texts).toMatchObject({ total: 14, complete: false });
      expect(result.recent_failed_texts.failures).toHaveLength(10);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('a Twilio failure keeps the database answer', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC123';
      process.env.TWILIO_AUTH_TOKEN = 'auth';
      mockTables.messaging_suppression = [{ reason: 'wrong_number', active: true, source: 'twilio_webhook_natural_language', created_at: '2026-10-10T10:00:00Z', cleared_at: null }];
      global.fetch.mockResolvedValueOnce(jsonResponse({}, 500));
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result.error).toBeUndefined();
      expect(result.do_not_text).toMatchObject({ listed: true, reason: 'wrong_number' });
      expect(result.recent_failed_texts).toEqual({ available: false, reason: 'Twilio API returned HTTP 500' });
    });

    test('a failed database read is an error, never "not on the list"', async () => {
      mockTables.messaging_suppression = new Error('connection terminated');
      const result = await executeTwilioOpsTool('get_texting_opt_out', { phone: PHONE });
      expect(result).toEqual({ error: 'connection terminated' });
    });

    test('refuses a value that is not a phone number, before any read', async () => {
      for (const phone of [undefined, '', 'the Smith account', '555-0142', 9415550142]) {
        expect(await executeTwilioOpsTool('get_texting_opt_out', { phone })).toEqual({ error: 'A valid phone number is required' });
      }
      expect(mockQueries).toHaveLength(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
