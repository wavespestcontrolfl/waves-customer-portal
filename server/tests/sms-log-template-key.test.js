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
