// Objective: every outbound SMS rendered from an sms_templates row records
// WHICH template key rendered it, so a future audit can map sent texts to
// templates. options.templateKey / options.templateVariantId are optional —
// never inferred from messageType (a guessed key is worse than none) — and
// land in sms_log.metadata as template_key / template_variant_id only when
// the caller supplies them. Mirrors the mock harness in
// twilio-pre-send-check.test.js.

const mockTwilioCreate = jest.fn();
const mockValidateOutbound = jest.fn(() => ({ ok: true }));

jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: mockTwilioCreate },
})));
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
    verifyServiceSid: 'VA_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(gate => gate !== 'smsGratitudeReplies'),
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
jest.mock('../services/messaging/sync-optout', () => ({ recordSyncProviderOptOut: jest.fn(async () => {}) }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));

const TwilioService = require('../services/twilio');

const TO = '+19415550123';
const FROM = '+19413180000';

describe('sms_log.metadata carries the rendering template key', () => {
  let insertedRows;

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    delete process.env.OWNER_SMS_DISABLED;
    insertedRows = [];
    require('../models/db').mockImplementation(table => ({
      insert: async row => { if (table === 'sms_log') insertedRows.push(row); },
    }));
    require('../models/db').transaction = jest.fn(async cb => cb(require('../models/db')));
    require('../models/db').raw = jest.fn(async () => ({}));
  });

  test('writes template_key when the caller supplies options.templateKey', async () => {
    const result = await TwilioService.sendSMS(TO, 'Your appointment is tomorrow', {
      messageType: 'appointment_reminder',
      fromNumber: FROM,
      templateKey: 'reminder_72h',
    });
    expect(result.success).toBe(true);
    expect(insertedRows).toHaveLength(1);
    const metadata = JSON.parse(insertedRows[0].metadata);
    expect(metadata.template_key).toBe('reminder_72h');
  });

  test('writes template_variant_id alongside template_key when both are supplied', async () => {
    await TwilioService.sendSMS(TO, 'Your appointment is tomorrow', {
      messageType: 'appointment_reminder',
      fromNumber: FROM,
      templateKey: 'reminder_72h',
      templateVariantId: 'variant-abc',
    });
    const metadata = JSON.parse(insertedRows[0].metadata);
    expect(metadata.template_key).toBe('reminder_72h');
    expect(metadata.template_variant_id).toBe('variant-abc');
  });

  test('omits template_key and template_variant_id when the caller does not supply them', async () => {
    await TwilioService.sendSMS(TO, 'Hand-typed composer text', {
      messageType: 'manual',
      fromNumber: FROM,
    });
    const metadata = JSON.parse(insertedRows[0].metadata);
    expect(metadata).not.toHaveProperty('template_key');
    expect(metadata).not.toHaveProperty('template_variant_id');
  });

  test('never infers template_key from messageType — a guessed key is worse than none', async () => {
    await TwilioService.sendSMS(TO, 'Your appointment is tomorrow', {
      // messageType looks template-shaped, but no templateKey was passed —
      // must not be inferred or copied over.
      messageType: 'appointment_reminder_72h',
      fromNumber: FROM,
    });
    const metadata = JSON.parse(insertedRows[0].metadata);
    expect(metadata).not.toHaveProperty('template_key');
  });
});

describe('deferred completion texts keep their template key through the morning replay', () => {
  const fs = require('fs');
  const path = require('path');
  test('the enqueue stores template_key and the scheduler replay forwards it', () => {
    const css = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const deferred = css.slice(css.indexOf("entry_point: 'dispatch_completion_deferred'"));
    expect(deferred.slice(0, 400)).toMatch(/template_key: sentSmsType/);
    const sched = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(sched).toMatch(/claimMeta\.template_key \? \{ templateKey: String\(claimMeta\.template_key\) \}/);
  });
});

describe('every accepted-send record keeps the template evidence (codex #5284 r1)', () => {
  const fs = require('fs');
  const path = require('path');
  const twilio = fs.readFileSync(path.join(__dirname, '../services/twilio.js'), 'utf8');
  test('a promoted provider-handoff reservation carries template_key and template_variant_id', () => {
    const meta = twilio.slice(twilio.indexOf('const providerSmsMetadata = () => ({'));
    const body = meta.slice(0, meta.indexOf('\n      });'));
    expect(body).toMatch(/template_key: options\.templateKey/);
    expect(body).toMatch(/template_variant_id: options\.templateVariantId/);
  });
  test('the push-first proof row carries the variant id too', () => {
    expect(twilio).toMatch(/templateVariantId: options\.templateVariantId,\n\s*\}\);/);
    const push = fs.readFileSync(path.join(__dirname, '../services/messaging/push-channel-routing.js'), 'utf8');
    expect(push).toMatch(/template_variant_id: templateVariantId/);
  });
  test('template performance groups by the exact rendered key when recorded', () => {
    const route = fs.readFileSync(path.join(__dirname, '../routes/admin-communications.js'), 'utf8');
    expect(route).toMatch(/COALESCE\(metadata->>'templateKey', metadata->>'original_message_type', purpose, 'unknown'\) as template_key/);
  });
});

describe('held invoice and payment-failure texts keep their template key (codex #5284 r3)', () => {
  const fs = require('fs');
  const path = require('path');
  const inv = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
  test('both invoice_send_deferred producers store template_key', () => {
    expect(inv).toMatch(/templateKey: renderedTemplateKey,\n\s*database: trx, \.\.\.pendingChannelToQueue/);
    expect(inv).toMatch(/partial_fanout_retry: true,[\s\S]{0,200}template_key: templateKey/);
    expect(inv).toMatch(/if \(renderedTemplateKey\) err\.smsTemplateKey = renderedTemplateKey;/);
    expect(inv).toMatch(/hasEmailLeg: true,[\s\S]{0,250}template_key: sms\.heldTemplateKey/);
  });
  test('the deferred payment_failed row stores its key', () => {
    const css = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const row = css.slice(css.indexOf("entry_point: 'autopay_completion_decline_deferred'"));
    expect(row.slice(0, 250)).toMatch(/template_key: 'payment_failed'/);
  });
});
