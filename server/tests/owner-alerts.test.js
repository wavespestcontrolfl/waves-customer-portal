// Owner alerts that used to be texts to the owner's phone (services/owner-alerts.js). Since about 2026-09-01
// those texts reached nobody: twilio.js turned them into the internal_admin_alert trigger, which the 08-28
// bell policy denylists, and the caller still read success. Each is now a composed ops digest row: quiet
// (Activity only) unless the owner chose its kind to ring, and never a text.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'n-1' })),
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const { deliverOpsDigest } = require('../services/ops-digest');
const TwilioService = require('../services/twilio');
const {
  recordOwnerAlert, recordUrgentEscalation, whyFromFreeText, OWNER_ALERT_KINDS, RINGING_KINDS,
} = require('../services/owner-alerts');

const credentialAlert = (extra = {}) => ({
  action: 'renew an expired credential',
  why: '1 credential failed the 7 AM check.',
  link: '/admin/settings?tab=integrations',
  subject: { type: 'check', id: 'credential-check' },
  text: 'Token Alert: 1 credential(s) need attention:\n- cloudflare_workers_ai: expired — HTTP 401',
  dedupeKey: 'owner-alert:credential-check:2026-10-30',
  itemKeys: ['cloudflare_workers_ai'],
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  RINGING_KINDS.clear();
});

describe('recordOwnerAlert', () => {
  test('writes a quiet, composed Activity row under the dedupe key and sends no text or email', async () => {
    const result = await recordOwnerAlert('credential-check', credentialAlert());
    expect(result).toEqual({ ok: true, channel: 'in_app', id: 'n-1' });
    expect(deliverOpsDigest).toHaveBeenCalledTimes(1);
    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest).toMatchObject({
      key: 'owner-alert:credential-check',
      headline: 'System — renew an expired credential',
      summary: '1 credential failed the 7 AM check.',
      link: '/admin/settings?tab=integrations',
      audience: 'fyi',
      dedupeKey: 'owner-alert:credential-check:2026-10-30',
      refreshOnDedupe: true,
      itemKeys: ['cloudflare_workers_ai'],
      count: 1,
    });
    expect(digest.text).toContain('cloudflare_workers_ai: expired');
    expect(digest.metadata).toMatchObject({
      ownerAlert: 'credential-check', area: 'System', severity: 'needs-you', doneWhen: 'credential_renewed', who: 'person',
      subject: { type: 'check', id: 'credential-check' },
    });
    // The digest's email fallback has nothing to send: these alerts never had an email.
    await expect(digest.sendEmail()).resolves.toMatchObject({ ok: false });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('a kind the owner chose to ring is written for the owner (rings on a new item)', async () => {
    RINGING_KINDS.add('credential-check');
    await recordOwnerAlert('credential-check', credentialAlert());
    expect(deliverOpsDigest.mock.calls[0][0].audience).toBe('owner');
    // Only the chosen kind rings.
    await recordOwnerAlert('seo-rank-drops', {
      action: 'check SEO rank drops', why: '2 priority keywords fell 3 or more places today.', link: '/admin/ads',
      subject: { type: 'check', id: 'seo-rank-drops' }, dedupeKey: 'owner-alert:seo-rank-drops:2026-10-31',
    });
    expect(deliverOpsDigest.mock.calls[1][0].audience).toBe('fyi');
  });

  test('a customer-tied alert carries the customer id, so an internal test account is dropped downstream', async () => {
    await recordOwnerAlert('overdue-visit', {
      action: 'collect an overdue balance before the visit',
      why: 'Taylor Morgan owes $129.00, 31 days overdue, with service tomorrow.',
      link: '/admin/customers?customerId=c-1', subject: { type: 'customer', id: 'c-1' },
      dedupeKey: 'owner-alert:overdue-visit:c-1:2026-11-01', metadata: { customerId: 'c-1' },
    });
    expect(deliverOpsDigest.mock.calls[0][0].metadata).toMatchObject({ customerId: 'c-1', ownerAlert: 'overdue-visit', severity: 'needs-you' });
  });

  test('an alert that breaks the notification rule throws under test, so the emitter test catches it', async () => {
    await expect(recordOwnerAlert('credential-check', credentialAlert({ why: 'Check GATE_TOKEN_HEALTH now. Then retry.' })))
      .rejects.toMatchObject({ violations: expect.arrayContaining(['why_multiple_sentences']) });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('outside tests a rule break keeps the alert, cut to fit and stamped with the rules it broke', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await recordOwnerAlert('credential-check', credentialAlert({ why: 'Check GATE_TOKEN_HEALTH now.' }));
    } finally {
      process.env.NODE_ENV = saved;
    }
    const digest = deliverOpsDigest.mock.calls[0][0];
    expect(digest.headline).toBe('System — renew an expired credential');
    expect(digest.metadata.ruleViolations).toEqual(expect.arrayContaining(['why_forbidden_token:env_name']));
    expect(logger.warn.mock.calls.map(([line]) => line).join('\n')).not.toContain('GATE_TOKEN_HEALTH');
  });

  test('refuses an unknown kind or a missing dedupe key without writing', async () => {
    await expect(recordOwnerAlert('nope', credentialAlert())).resolves.toMatchObject({ ok: false });
    await expect(recordOwnerAlert('credential-check', credentialAlert({ dedupeKey: '' }))).resolves.toMatchObject({ ok: false });
    expect(deliverOpsDigest).not.toHaveBeenCalled();
  });

  test('a failed write never throws and logs the error code, never the alert text', async () => {
    deliverOpsDigest.mockRejectedValueOnce(Object.assign(new Error('insert "Taylor Morgan" failed'), { code: '23505' }));
    await expect(recordOwnerAlert('credential-check', credentialAlert())).resolves.toEqual({ ok: false, error: '23505' });
    const lines = logger.error.mock.calls.map(([line]) => line).join('\n');
    expect(lines).toContain('23505');
    expect(lines).not.toContain('Taylor');
  });
});

test('every kind composes under the notification rule', async () => {
  for (const kind of Object.keys(OWNER_ALERT_KINDS)) {
    await recordOwnerAlert(kind, {
      action: 'read the alert', why: 'Something happened today.', link: '/admin/dashboard',
      subject: { type: 'check', id: kind }, dedupeKey: `owner-alert:${kind}:x`,
    });
  }
  expect(deliverOpsDigest).toHaveBeenCalledTimes(Object.keys(OWNER_ALERT_KINDS).length);
});

test('an urgent assistant hand-off keeps the model reason and the customer words out of the why', async () => {
  await recordUrgentEscalation({
    customer: { id: 'c-9', first_name: 'Jamie', last_name: 'Rivera' },
    reason: 'wants_to_cancel!', customerMessage: 'Cancel everything 2026-11-01', conversationId: 'conv-1', escalationId: 'esc-1',
  });
  const digest = deliverOpsDigest.mock.calls[0][0];
  expect(digest).toMatchObject({ summary: 'Jamie Rivera asked the assistant for a person.', dedupeKey: 'owner-alert:ai-escalation:esc-1' });
  expect(digest.text).toContain('Reason: wants_to_cancel!');
  expect(digest.metadata.subject).toEqual({ type: 'customer', id: 'c-9' });
});

test('whyFromFreeText keeps a clean first sentence and drops one that breaks the rule', () => {
  expect(whyFromFreeText('Spend is on track. Two campaigns need new copy.')).toBe('Spend is on track.');
  expect(whyFromFreeText('Pause campaign_brand_2 today.')).toBe('');
  expect(whyFromFreeText(null)).toBe('');
});

// The regression this replaces: an internal alert texted to the owner's phone is redirected into the
// denylisted internal_admin_alert trigger and reaches nobody. The one kept send is the tax reminder's
// legacy branch, which runs only while GATE_TAX_DEADLINE_BELLS is off.
test('no server code texts an internal alert to the owner phone without allowOwnerSms', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', '__tests__'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(file, 'utf8');
        const calls = src.match(/sendSMS\(\s*process\.env\.ADAM_PHONE[^;]*?;/g) || [];
        for (const call of calls) {
          if (/internal_alert|admin_alert/.test(call) && !/allowOwnerSms:\s*true/.test(call)) offenders.push(path.relative(root, file));
        }
      }
    }
  };
  walk(path.join(root, 'routes'));
  walk(path.join(root, 'services'));
  expect(offenders).toEqual(['services/scheduler.js']);
});
