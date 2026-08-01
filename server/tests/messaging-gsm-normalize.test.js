/**
 * GSM-7 punctuation normalizer — unit coverage plus the send-path wiring.
 *
 * Typographic punctuation forces UCS-2 encoding (67 chars/segment vs 153),
 * silently multiplying segment count; multi-segment texts have failed to
 * reach handsets that still ACK delivery. The normalizer must fix exactly
 * the typographic set and leave meaning-bearing characters (emoji, accents)
 * alone, and sendCustomerMessage must apply it before segment counting so
 * the audit row records what actually went to the provider.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_provided_unverified'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-test' })),
}));

const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { countSegments } = require('../services/messaging/segment-counter');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');

describe('normalizeGsmPunctuation', () => {
  test('maps curly quotes, dashes, ellipsis, and bullets to GSM equivalents', () => {
    expect(normalizeGsmPunctuation('we’ll see “you”')).toBe('we\'ll see "you"');
    expect(normalizeGsmPunctuation('3–4pm — window')).toBe('3-4pm - window');
    expect(normalizeGsmPunctuation('soon…')).toBe('soon...');
    expect(normalizeGsmPunctuation('• first item')).toBe('- first item');
  });

  test('normalizes the Unicode space family and strips invisibles', () => {
    expect(normalizeGsmPunctuation('a b c')).toBe('a b c');
    expect(normalizeGsmPunctuation('a​b­c﻿')).toBe('abc');
  });

  test('flips a UCS-2 body back to GSM-7 with fewer segments', () => {
    const curly = 'Hello there! Your service is tomorrow. Your arrival window starts at 3:00 PM, and we’ll text you a tracking link when your technician is on the way.';
    expect(countSegments(curly).encoding).toBe('UCS_2');
    const fixed = normalizeGsmPunctuation(curly);
    const meta = countSegments(fixed);
    expect(meta.encoding).toBe('GSM_7');
    expect(meta.segmentCount).toBeLessThan(countSegments(curly).segmentCount);
  });

  test('leaves emoji, accented letters, and plain ASCII untouched', () => {
    expect(normalizeGsmPunctuation('ok \u{1F44D}')).toBe('ok \u{1F44D}');
    expect(normalizeGsmPunctuation('José & Muñoz')).toBe('José & Muñoz');
    expect(normalizeGsmPunctuation("plain 'text' - fine...")).toBe("plain 'text' - fine...");
  });

  test('expands the ellipsis only when the body lands on GSM-7', () => {
    // ASCII body: expansion flips it to GSM-7 — worth 2 extra chars.
    expect(normalizeGsmPunctuation('soon…')).toBe('soon...');
    // A preserved non-GSM character keeps the body UCS-2 either way, so the
    // single-char ellipsis is cheaper (3 code units would eat segment room).
    expect(normalizeGsmPunctuation('alert \u{1F6A8} soon…')).toBe('alert \u{1F6A8} soon…');
    expect(normalizeGsmPunctuation('Erdős…')).toBe('Erdős…');
    // GSM-alphabet accents (é) do NOT force UCS-2 — expansion still applies.
    expect(normalizeGsmPunctuation('José…')).toBe('José...');
  });

  test('preserves ZWJ/ZWNJ join controls (joined emoji must not split)', () => {
    const joined = '\u{1F469}‍\u{1F4BB}'; // woman + ZWJ + laptop = one glyph
    expect(normalizeGsmPunctuation(joined)).toBe(joined);
    expect(normalizeGsmPunctuation('a‌b')).toBe('a‌b');
  });

  test('is idempotent and passes through non-string input', () => {
    const once = normalizeGsmPunctuation('a’b — c…');
    expect(normalizeGsmPunctuation(once)).toBe(once);
    expect(normalizeGsmPunctuation(null)).toBe(null);
    expect(normalizeGsmPunctuation(undefined)).toBe(undefined);
    expect(normalizeGsmPunctuation('')).toBe('');
  });
});

describe('sendCustomerMessage GSM normalization wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  const BASE_INPUT = {
    to: '+19415550142',
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId: 'c-1',
  };

  test('provider receives the normalized body and audit logs GSM_7', async () => {
    const result = await sendCustomerMessage({
      ...BASE_INPUT,
      body: 'We’ll see you tomorrow — reply here with questions…',
    });
    expect(result.sent).toBe(true);
    expect(result.encoding).toBe('GSM_7');

    const providerInput = sendViaTwilio.mock.calls[0][0];
    expect(providerInput.body).toBe("We'll see you tomorrow - reply here with questions...");

    const auditInput = persistAudit.mock.calls[0][0];
    expect(auditInput.input.body).toBe("We'll see you tomorrow - reply here with questions...");
    expect(auditInput.segmentMeta.encoding).toBe('GSM_7');
  });
});
