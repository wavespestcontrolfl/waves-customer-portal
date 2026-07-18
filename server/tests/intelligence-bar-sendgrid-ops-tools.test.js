/**
 * SendGrid deliverability ops tools — unit tests with a mocked SendGrid API.
 * Read-only contract: benign dark state, list/window params, reason
 * truncation, per-email check across all four lists with 404 = not listed,
 * failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const SENDGRID_ENV_KEYS = ['SENDGRID_API_KEY', 'SENDGRID_API_BASE'];
const savedEnv = {};
let executeSendgridOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of SENDGRID_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of SENDGRID_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of SENDGRID_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeSendgridOpsTool } = require('../services/intelligence-bar/sendgrid-ops-tools'));
});

describe('intelligence bar SendGrid ops tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeSendgridOpsTool('get_email_suppressions', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/SENDGRID_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    const result = await executeSendgridOpsTool('delete_suppression', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_email_suppressions merges the four lists with truncated reasons', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    const created = Math.floor(Date.now() / 1000) - 3600;
    const longReason = 'x'.repeat(400);
    global.fetch
      .mockResolvedValueOnce(jsonResponse([{ email: 'bounced@example.com', created, reason: longReason, status: '5.1.1' }]))
      .mockResolvedValueOnce(jsonResponse([{ email: 'blocked@example.com', created, reason: 'IP on deny list' }]))
      .mockResolvedValueOnce(jsonResponse([{ email: 'spam@example.com', created }]))
      .mockResolvedValueOnce(jsonResponse([{ email: 'unsub@example.com', created }]));

    const result = await executeSendgridOpsTool('get_email_suppressions', { hours: 24 });
    expect(result.error).toBeUndefined();
    expect(result.bounces).toHaveLength(1);
    expect(result.bounces[0].email).toBe('bounced@example.com');
    expect(result.bounces[0].reason).toHaveLength(200);
    expect(result.blocks[0].email).toBe('blocked@example.com');
    expect(result.spam_reports[0].list).toBe('spam_reports');
    expect(result.unsubscribes[0].email).toBe('unsub@example.com');
    expect(result.total).toBe(4);
    expect(result.window_hours).toBe(24);
    const urls = global.fetch.mock.calls.map(c => String(c[0]));
    expect(urls[0]).toContain('/suppression/bounces');
    expect(urls[0]).toContain('start_time=');
    expect(urls[1]).toContain('/suppression/blocks');
    expect(urls[2]).toContain('/suppression/spam_reports');
    expect(urls[3]).toContain('/suppression/unsubscribes');
  });

  test('check_email_suppression reports the lists an address is on; 404 means not listed', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    const created = Math.floor(Date.now() / 1000) - 7200;
    global.fetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/suppression/bounces/')) {
        return Promise.resolve(jsonResponse([{ email: 'jane@example.com', created, reason: 'mailbox full', status: '4.2.2' }]));
      }
      if (u.includes('/asm/suppressions/global/')) return Promise.resolve(jsonResponse({}, 404));
      if (u.includes('/asm/suppressions/')) return Promise.resolve(jsonResponse({ suppressions: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });

    const result = await executeSendgridOpsTool('check_email_suppression', { email: 'Jane@Example.com' });
    expect(result.error).toBeUndefined();
    expect(result.email).toBe('jane@example.com');
    expect(result.suppressed).toBe(true);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].list).toBe('bounces');
    // 4 per-email lists + global unsubscribe + ASM group memberships
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  test('check_email_suppression surfaces global and ASM group unsubscribes', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    global.fetch.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/asm/suppressions/global/')) {
        return Promise.resolve(jsonResponse({ recipient_email: 'jane@example.com' }));
      }
      if (u.includes('/asm/suppressions/')) {
        return Promise.resolve(jsonResponse({
          suppressions: [
            { id: 12, name: 'Newsletter', suppressed: true },
            { id: 13, name: 'Service Updates', suppressed: false },
          ],
        }));
      }
      return Promise.resolve(jsonResponse([]));
    });

    const result = await executeSendgridOpsTool('check_email_suppression', { email: 'jane@example.com' });
    expect(result.error).toBeUndefined();
    expect(result.suppressed).toBe(true);
    expect(result.listings.map(l => l.list)).toEqual(['global_unsubscribe', 'asm_group_unsubscribe']);
    // Only groups with suppressed: true count
    expect(result.listings[1].reason).toContain('Newsletter');
  });

  test('check_email_suppression with a clean address reports not suppressed', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    global.fetch.mockResolvedValue(jsonResponse([]));
    const result = await executeSendgridOpsTool('check_email_suppression', { email: 'clean@example.com' });
    expect(result.suppressed).toBe(false);
    expect(result.listings).toEqual([]);
  });

  test('invalid email input returns an error without network calls', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    const result = await executeSendgridOpsTool('check_email_suppression', { email: 'not-an-email' });
    expect(result.error).toMatch(/valid email/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('auth rejection surfaces as { error }, never a throw', async () => {
    process.env.SENDGRID_API_KEY = 'SG.bad';
    global.fetch.mockResolvedValue(jsonResponse({}, 401));
    const result = await executeSendgridOpsTool('get_email_suppressions', {});
    expect(result.error).toMatch(/rejected the key/);
  });
});
