// Abuse guards on the public lead webhook: honeypot trap + Cloudflare Turnstile
// verification. Turnstile must FAIL OPEN on misconfiguration / transport error
// (never lose a real lead) and FAIL CLOSED only on a definitive negative verdict.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { isHoneypotTripped } = _test;
const { verifyTurnstileToken } = require('../utils/turnstile');

describe('isHoneypotTripped', () => {
  test('absent honeypot field passes (old cached pages omit it)', () => {
    expect(isHoneypotTripped({})).toBe(false);
    expect(isHoneypotTripped({ name: 'Real Person', fax_number: undefined })).toBe(false);
  });

  test('empty / whitespace-only honeypot passes (humans leave it blank)', () => {
    expect(isHoneypotTripped({ fax_number: '' })).toBe(false);
    expect(isHoneypotTripped({ fax_number: '   ' })).toBe(false);
  });

  test('non-empty honeypot is a bot', () => {
    expect(isHoneypotTripped({ fax_number: '18005551234' })).toBe(true);
  });

  test('a non-string JSON value counts as filled (bot crafting JSON) (codex P2)', () => {
    // A bot can send fax_number as a number/array/object over JSON; without this
    // findField(/number|phone/) could even read a numeric fax_number as phone.
    expect(isHoneypotTripped({ fax_number: 18005551234 })).toBe(true);
    expect(isHoneypotTripped({ fax_number: 0 })).toBe(true);
    expect(isHoneypotTripped({ fax_number: ['x'] })).toBe(true);
    expect(isHoneypotTripped({ fax_number: { a: 1 } })).toBe(true);
    expect(isHoneypotTripped({ fax_number: true })).toBe(true);
  });

  test('never throws on a null/undefined body or null field', () => {
    expect(isHoneypotTripped(null)).toBe(false);
    expect(isHoneypotTripped(undefined)).toBe(false);
    expect(isHoneypotTripped({ fax_number: null })).toBe(false);
  });
});

describe('verifyTurnstileToken', () => {
  const ORIGINAL_SECRET = process.env.TURNSTILE_SECRET_KEY;
  let fetchSpy;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = ORIGINAL_SECRET;
    if (fetchSpy) fetchSpy.mockRestore();
    fetchSpy = undefined;
  });

  test('no secret configured → fails OPEN, no network call', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyTurnstileToken('any-token', '1.2.3.4');
    expect(r).toEqual({ ok: true, enforced: false, reason: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('secret set but token missing → fails CLOSED, no network call', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyTurnstileToken('', '1.2.3.4');
    expect(r).toMatchObject({ ok: false, enforced: true, reason: 'missing_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('blank / whitespace-only token → fails CLOSED before any network call', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyTurnstileToken('   ', '1.2.3.4');
    expect(r).toMatchObject({ ok: false, enforced: true, reason: 'missing_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('oversized (>2048) token → fails CLOSED locally, no network call (codex P1)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch');
    const r = await verifyTurnstileToken('x'.repeat(2049), '1.2.3.4');
    expect(r).toMatchObject({ ok: false, enforced: true, reason: 'malformed_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('missing-input-response verdict → fails CLOSED, not config_error (codex P2)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['missing-input-response'] }),
    });
    const r = await verifyTurnstileToken('present-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: false, enforced: true, reason: 'rejected' });
  });

  test('Cloudflare success:true → verified', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const r = await verifyTurnstileToken('good-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: true, enforced: true, reason: 'verified' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('token failure (invalid-input-response) → fails CLOSED', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    const r = await verifyTurnstileToken('bad-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: false, enforced: true, reason: 'rejected' });
    expect(r.codes).toEqual(['invalid-input-response']);
  });

  test('expired/duplicate token → fails CLOSED', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    });
    const r = await verifyTurnstileToken('stale-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: false, enforced: true, reason: 'rejected' });
  });

  test('config error (typoed/wrong secret) → fails OPEN, not a rejection (codex P1)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'wrong-secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-secret'] }),
    });
    const r = await verifyTurnstileToken('good-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: true, enforced: false, reason: 'config_error' });
    expect(r.codes).toEqual(['invalid-input-secret']);
  });

  test('bad-request / internal-error config codes → fail OPEN', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['bad-request', 'internal-error'] }),
    });
    const r = await verifyTurnstileToken('good-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: true, enforced: false, reason: 'config_error' });
  });

  test('siteverify 5xx → fails OPEN', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503 });
    const r = await verifyTurnstileToken('good-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: true, enforced: false, reason: 'http_503' });
  });

  test('network error / timeout → fails OPEN', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    );
    const r = await verifyTurnstileToken('good-token', '1.2.3.4');
    expect(r).toMatchObject({ ok: true, enforced: false, reason: 'verify_error' });
  });
});
