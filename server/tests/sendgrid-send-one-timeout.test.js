/**
 * sendOne's per-request bound: default unchanged (120 s), overridable (and
 * only ever shortened) by callers that hold a connection/lock across the call.
 */
process.env.SENDGRID_API_KEY = 'SG.test';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const sendgrid = require('../services/sendgrid-mail');

const base = { to: 'a@example.com', subject: 's', html: '<p>x</p>', text: 'x', fromEmail: 'newsletter@wavespestcontrol.com' };
let timeoutSpy;
let fetchSpy;

beforeEach(() => {
  timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 202, headers: { get: () => 'msg-1' }, text: async () => '' });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('sendOne request timeout', () => {
  test('default is the unchanged 120 s bound', async () => {
    await sendgrid.sendOne({ ...base });
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  });

  test('a shorter timeoutMs is honored', async () => {
    await sendgrid.sendOne({ ...base, timeoutMs: 10_000 });
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  test('timeoutMs can only shorten the bound, never lengthen it; junk falls back to the default', async () => {
    await sendgrid.sendOne({ ...base, timeoutMs: 999_999 });
    expect(timeoutSpy).toHaveBeenLastCalledWith(120_000);
    for (const junk of [0, -5, NaN, 'soon', null]) {
      await sendgrid.sendOne({ ...base, timeoutMs: junk });
      expect(timeoutSpy).toHaveBeenLastCalledWith(120_000);
    }
  });

  test('a hung provider request aborts at the short bound and rejects (a failed send)', async () => {
    fetchSpy.mockImplementation((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const started = Date.now();
    await expect(sendgrid.sendOne({ ...base, timeoutMs: 50 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
