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
  AUTOPAY_EXTRA_ENTRY_POINTS,
  MONTHLY_CHARGE_ENTRY_POINTS,
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
    lane_checked: true,
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

describe('AUTOPAY_EXTRA_ENTRY_POINTS', () => {
  test('names exactly the send sites the wrapper does not already mark as autopay', () => {
    // autopay_* entry points (pre-charge, card-expiry, retry ladder,
    // completion decline + its deferred replay) are matched by the SQL
    // prefix rule that mirrors isAutopayCustomerSms — never listed here.
    expect(AUTOPAY_EXTRA_ENTRY_POINTS).toEqual(['monthly_billing_success', 'monthly_billing_failure', 'payment_expiry_workflow']);
    expect(AUTOPAY_EXTRA_ENTRY_POINTS.some((e) => e.startsWith('autopay_'))).toBe(false);
  });

  test('lane checks apply only to texts that presuppose a monthly charge (codex r6)', () => {
    expect(MONTHLY_CHARGE_ENTRY_POINTS).toEqual([
      'autopay_pre_charge_reminder', 'monthly_billing_success', 'monthly_billing_failure',
    ]);
    // Retry-ladder texts are governed by classifyFailedPaymentRetry's own
    // verdict (a lane transition with a paid monthly charge on file keeps
    // collecting) — never second-guessed by the lane at send (codex r8).
    expect(MONTHLY_CHARGE_ENTRY_POINTS).not.toContain('autopay_retry_failed');
    expect(MONTHLY_CHARGE_ENTRY_POINTS).not.toContain('autopay_completion_decline');
    expect(MONTHLY_CHARGE_ENTRY_POINTS).not.toContain('autopay_card_expiry_warning');
    expect(MONTHLY_CHARGE_ENTRY_POINTS).not.toContain('payment_expiry_workflow');
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

  test('an unresolved (null) lane counts as a mismatch — send sites stamp the RESOLVED lane, so null only means pre-stamp data', () => {
    const composed = composeAutopaySmsDigest([row({ billing_mode: null })]);
    expect(composed.mismatches).toBe(1);
    expect(composed.text).toContain('lane unresolved');
  });

  test('a send with no customer row fails closed: unknown lane counts as a mismatch (codex r1)', () => {
    const composed = composeAutopaySmsDigest([row({ customer_id: null, customer_name: null, billing_mode: null, waveguard_tier: null, monthly_rate: null })]);
    expect(composed.mismatches).toBe(1);
    expect(composed.subject).toBe('FIX: 1 of 1 autopay text went to NON-monthly customers');
    expect(composed.text).toContain('(no name on file)');
    expect(composed.text).toContain('lane unknown (no customer row)');
  });

  test('mismatches beyond the displayed page still escalate via the whole-window count (codex r1)', () => {
    // 80 sends in the window, only the newest (monthly) row is on the page,
    // but 3 non-monthly recipients sit past the LIMIT.
    const composed = composeAutopaySmsDigest([row({ total_count: 80, mismatch_count: 3 })]);
    expect(composed.mismatches).toBe(3);
    expect(composed.subject).toBe('FIX: 3 of 80 autopay texts went to NON-monthly customers');
    expect(composed.text).toContain('…and 79 more not shown');
  });

  test('lane is the SEND-TIME stamp; a pre-stamp row falls back to the live join and says so (codex r2)', () => {
    // billing_mode here is what the SQL already COALESCEd: the stamp wins.
    const stamped = composeAutopaySmsDigest([row({ lane_source: 'at_send', billing_mode: 'per_application' })]);
    expect(stamped.mismatches).toBe(1);
    expect(stamped.text).toContain('lane per_application ·');
    expect(stamped.text).not.toContain('(lane as of now)');

    const live = composeAutopaySmsDigest([row({ lane_source: 'live' })]);
    expect(live.mismatches).toBe(0);
    expect(live.text).toContain('lane monthly_membership (lane as of now)');

    // A stamped null (codex r3) stays a send-time value: flagged, never
    // relabeled from the customer's current lane.
    const stampedNull = composeAutopaySmsDigest([row({ lane_source: 'at_send', billing_mode: null })]);
    expect(stampedNull.mismatches).toBe(1);
    expect(stampedNull.text).toContain('lane unresolved');
    expect(stampedNull.text).not.toContain('(lane as of now)');
  });

  test('a per_application completion-decline notice is listed but never flagged (codex r6)', () => {
    const composed = composeAutopaySmsDigest([
      row({ total_count: 2, mismatch_count: 0 }),
      row({ total_count: 2, mismatch_count: 0, lane_checked: false, entry_point: 'autopay_completion_decline', message_type: 'payment_failed', customer_id: 'cust-pa', customer_name: 'Per App', billing_mode: 'per_application' }),
    ]);
    expect(composed.subject).toBe('FYI: 2 autopay texts went out');
    expect(composed.mismatches).toBe(0);
    expect(composed.text).toContain('Per App — payment_failed · lane per_application · Bronze · $33.33/mo');
    expect(composed.text).not.toContain('NOT a monthly member');
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

  test('sends to contact@ by default and stamps the marker with the window upper bound (now − settle lag), not the newest row', async () => {
    const stampSendMarker = jest.fn();
    const loadRows = jest.fn(async () => [row({ sent_at: '2026-08-29T13:03:00Z' })]);
    const r = await runAutopaySmsDigest({ windowStart, loadRows, stampSendMarker });
    expect(r.sent).toBe(true);
    expect(loadRows).toHaveBeenCalledWith(new Date('2026-08-29T00:00:00Z'), expect.any(Date));
    const until = loadRows.mock.calls[0][1];
    expect(Date.now() - until.getTime()).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    expect(Date.now() - until.getTime()).toBeLessThan(6 * 60 * 1000);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@wavespestcontrol.com',
      subject: 'FYI: 1 autopay text went out',
      categories: ['ops', 'autopay-sms-digest'],
    }));
    expect(stampSendMarker).toHaveBeenCalledWith(until);
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
