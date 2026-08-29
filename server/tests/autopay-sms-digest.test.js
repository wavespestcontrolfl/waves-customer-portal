jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  // Window/marker reads are try/caught in the service; loaders are injected.
  const qb = () => { throw new Error('db must not be touched when loadRows is injected'); };
  qb.raw = () => { throw new Error('db.raw must not be touched when loadRows is injected'); };
  return qb;
});

const sendgrid = require('../services/sendgrid-mail');
const {
  runAutopaySmsDigest,
  AUTOPAY_ENTRY_POINTS,
  _private: { composeAutopaySmsDigest },
} = require('../services/autopay-sms-digest');

function row(overrides = {}) {
  return {
    total_count: 1,
    sent_at: '2026-08-29T13:03:00Z',
    entry_point: 'autopay_pre_charge_reminder',
    message_type: 'autopay_pre_charge',
    body_preview: 'Hello Member! Your WaveGuard auto-pay processes on September 1.',
    customer_id: 'cust-1',
    customer_name: 'Test Member',
    billing_mode: 'monthly_membership',
    waveguard_tier: 'Bronze',
    monthly_rate: '33.33',
    ...overrides,
  };
}

const windowStart = async () => new Date('2026-08-29T00:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.AUTOPAY_SMS_DIGEST_DISABLED;
  delete process.env.AUTOPAY_SMS_DIGEST_EMAIL;
});

describe('AUTOPAY_ENTRY_POINTS', () => {
  test('covers every autopay-family send site', () => {
    expect(AUTOPAY_ENTRY_POINTS).toEqual(expect.arrayContaining([
      'autopay_pre_charge_reminder', 'autopay_card_expiry_warning',
      'monthly_billing_success', 'monthly_billing_failure',
      'autopay_retry_success', 'autopay_retry_failed', 'autopay_retry_final_failed',
      'payment_expiry_workflow',
    ]));
  });
});

describe('composeAutopaySmsDigest', () => {
  test('no rows composes nothing (quiet window)', () => {
    expect(composeAutopaySmsDigest([])).toBeNull();
    expect(composeAutopaySmsDigest(null)).toBeNull();
  });

  test('all monthly members → FYI subject with count', () => {
    const composed = composeAutopaySmsDigest([row({ total_count: 2 }), row({ total_count: 2, customer_id: 'cust-2', customer_name: 'Other Member' })]);
    expect(composed.subject).toBe('FYI: 2 autopay texts went out');
    expect(composed.mismatches).toBe(0);
    expect(composed.text).toContain('Test Member');
    expect(composed.text).toContain('lane monthly_membership');
  });

  test('a prepay or per-application recipient escalates to FIX and is flagged (the 2026-08-29 shape)', () => {
    const composed = composeAutopaySmsDigest([
      row({ total_count: 3 }),
      row({ total_count: 3, customer_id: 'cust-pa', customer_name: 'Per App', billing_mode: 'per_application' }),
      row({ total_count: 3, customer_id: 'cust-ap', customer_name: 'Pre Pay', billing_mode: 'annual_prepay' }),
    ]);
    expect(composed.subject).toBe('FIX: 2 of 3 autopay texts went to NON-monthly customers');
    expect(composed.mismatches).toBe(2);
    expect(composed.text).toContain('Per App — autopay_pre_charge · lane per_application · Bronze · $33.33/mo ⚠ NOT a monthly member');
    expect(composed.text).toContain('Pre Pay — autopay_pre_charge · lane annual_prepay');
    expect(composed.html).toContain('NOT a monthly member');
  });

  test('NULL billing_mode is shown as inferred and counts as a mismatch', () => {
    const composed = composeAutopaySmsDigest([row({ billing_mode: null })]);
    expect(composed.mismatches).toBe(1);
    expect(composed.text).toContain('lane NULL (inferred)');
  });

  test('a send with no customer row is listed but not counted as a lane mismatch', () => {
    const composed = composeAutopaySmsDigest([row({ customer_id: null, customer_name: null, billing_mode: null, waveguard_tier: null, monthly_rate: null })]);
    expect(composed.mismatches).toBe(0);
    expect(composed.text).toContain('(no name on file)');
    expect(composed.text).toContain('lane no customer row');
  });

  test('html escapes the preview and reports overflow beyond the page', () => {
    const composed = composeAutopaySmsDigest([row({ total_count: 80, body_preview: 'x <b>&</b>' })]);
    expect(composed.html).toContain('x &lt;b&gt;&amp;&lt;/b&gt;');
    expect(composed.html).not.toContain('<b>&</b>');
    expect(composed.text).toContain('…and 79 more not shown');
  });
});

describe('runAutopaySmsDigest', () => {
  test('quiet window: nothing_found, no send, no marker stamp', async () => {
    const stampSendMarker = jest.fn();
    const r = await runAutopaySmsDigest({ windowStart, loadRows: async () => [], stampSendMarker });
    expect(r).toEqual({ skipped: 'nothing_found' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(stampSendMarker).not.toHaveBeenCalled();
  });

  test('sends to contact@ by default and stamps the marker with the newest sent_at', async () => {
    const stampSendMarker = jest.fn();
    const loadRows = jest.fn(async () => [row({ sent_at: '2026-08-29T13:03:00Z' })]);
    const r = await runAutopaySmsDigest({ windowStart, loadRows, stampSendMarker });
    expect(r.sent).toBe(true);
    expect(loadRows).toHaveBeenCalledWith(new Date('2026-08-29T00:00:00Z'));
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FYI: 1 autopay text went out',
      categories: ['ops', 'autopay-sms-digest'],
    }));
    expect(stampSendMarker).toHaveBeenCalledWith('2026-08-29T13:03:00Z');
  });

  test('kill switch: composes but does not send or stamp', async () => {
    process.env.AUTOPAY_SMS_DIGEST_DISABLED = '1';
    const stampSendMarker = jest.fn();
    const r = await runAutopaySmsDigest({ windowStart, loadRows: async () => [row()], stampSendMarker });
    expect(r.skipped).toBe('disabled');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(stampSendMarker).not.toHaveBeenCalled();
  });

  test('fails closed on a non-internal recipient', async () => {
    process.env.AUTOPAY_SMS_DIGEST_EMAIL = 'someone@example.com';
    const r = await runAutopaySmsDigest({ windowStart, loadRows: async () => [row()], stampSendMarker: jest.fn() });
    expect(r.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('mailer unconfigured → unconfigured skip', async () => {
    sendgrid.isConfigured.mockReturnValue(false);
    const r = await runAutopaySmsDigest({ windowStart, loadRows: async () => [row()], stampSendMarker: jest.fn() });
    expect(r.skipped).toBe('unconfigured');
  });

  test('query failure → query_failed, nothing sent', async () => {
    const r = await runAutopaySmsDigest({ windowStart, loadRows: async () => { throw new Error('boom'); } });
    expect(r).toEqual({ skipped: 'query_failed' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('send failure → error result and NO marker stamp so the next tick retries', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('503'), { status: 503 }));
    const stampSendMarker = jest.fn();
    const r = await runAutopaySmsDigest({ windowStart, loadRows: async () => [row()], stampSendMarker });
    expect(r.sent).toBe(false);
    expect(r.error).toBe(true);
    expect(stampSendMarker).not.toHaveBeenCalled();
  });
});
