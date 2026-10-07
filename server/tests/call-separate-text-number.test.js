/**
 * Separate number for texts (owner ruling 2026-10-07, option A; schema 1.25.0).
 *
 * A caller whose line cannot take texts (a deaf relay service, an office landline,
 * "you can't text this one") and who gives another number for texts gets texts at
 * that number. This is NOT caller_id_disclaimed: the caller still owns the line for
 * calls. All numbers here are synthetic.
 *
 * Pins: the two extraction fields (both schemas, normalizer, flat view, prompt, replay
 * watch list), the pure predicates, the deterministic flag, that the disclaimed-number
 * consumers ignore the new field, and the processor wiring (source pins, because the
 * processor cannot be run end to end without a database).
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  aniCannotTextNumber,
  aniCannotTextNeedsNumber,
  computeDeterministicTriageFlags,
  callerIdDisclaimedNeedsCallback,
} = require('../services/call-triage-flags');
const { SCHEMA_VERSION } = require('../schemas/validate-extraction');
const modelOutputSchema = require('../schemas/call-extraction.model-output.schema.json');
const persistedSchema = require('../schemas/call-extraction.persisted.schema.json');
const { flatView, callerIdDisclaimedNoteText } = require('../utils/extraction-compat');
const { callbackNumberCoachingNote } = require('../services/csr/csr-coach');
const { buildExtractionPrompt, PROMPT_VERSION } = require('../services/prompts/call-extraction-v1');

const TWILIO_NUMBERS = require('../config/twilio-numbers');
const ANI = '+19415550100'; // the relay line the caller called from
const TEXT = '+19415559876'; // the number the caller gave for texts

const v2 = (callerOver = {}) => ({
  meta: { schema_version: '1.25.0', is_voicemail: false, is_spam: false, call_summary: 's' },
  caller: { relationship_to_property: 'owner', on_site_authorization: true, ...callerOver },
  property: { service_address: { street_line_1: '1 Test St', city: 'Bradenton', postal_code: '34205' } },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-12T10:00:00-04:00' },
  confidence: { overall: 0.9 },
  consent: {},
  triage_flags: [],
});

describe('aniCannotTextNumber / aniCannotTextNeedsNumber', () => {
  test('a dialable number that is not the ANI is the text number, as E.164', () => {
    expect(aniCannotTextNumber({ ani_cannot_text: true, text_phone_e164: TEXT }, { ani: ANI })).toBe(TEXT);
    expect(aniCannotTextNeedsNumber({ ani_cannot_text: true, text_phone_e164: TEXT }, { ani: ANI })).toBe(false);
  });

  test.each([
    ['no number given', { ani_cannot_text: true }],
    ['null number', { ani_cannot_text: true, text_phone_e164: null }],
    ['the ANI itself', { ani_cannot_text: true, text_phone_e164: ANI }],
    ['a one-digit near miss of the ANI', { ani_cannot_text: true, text_phone_e164: '+19415550101' }],
    ['an impossible area code', { ani_cannot_text: true, text_phone_e164: '+11735559876' }],
    ['too short', { ani_cannot_text: true, text_phone_e164: '+1941555' }],
    ['one of our own lines', { ani_cannot_text: true, text_phone_e164: TWILIO_NUMBERS.getOutboundNumber() }],
  ])('%s: no usable number, the caller still needs one', (_label, caller) => {
    expect(aniCannotTextNumber(caller, { ani: ANI })).toBeNull();
    expect(aniCannotTextNeedsNumber(caller, { ani: ANI })).toBe(true);
  });

  test('without the flag nothing happens, even with a number present', () => {
    for (const caller of [null, undefined, {}, { ani_cannot_text: null, text_phone_e164: TEXT }, { ani_cannot_text: false, text_phone_e164: TEXT }]) {
      expect(aniCannotTextNumber(caller, { ani: ANI })).toBeNull();
      expect(aniCannotTextNeedsNumber(caller, { ani: ANI })).toBe(false);
    }
  });
});

describe('callback_number_needed flag', () => {
  test('raised when the line cannot take texts and no number for texts was given', () => {
    const flags = computeDeterministicTriageFlags(v2({ ani_cannot_text: true }), { contactPhone: ANI });
    expect(flags).toContain('callback_number_needed');
  });

  test('not raised when a separate number for texts was given', () => {
    const flags = computeDeterministicTriageFlags(v2({ ani_cannot_text: true, text_phone_e164: TEXT }), { contactPhone: ANI });
    expect(flags).not.toContain('callback_number_needed');
    expect(flags).not.toContain('caller_phone_missing');
  });

  test('raised when the "text number" is just the ANI again', () => {
    const flags = computeDeterministicTriageFlags(v2({ ani_cannot_text: true, text_phone_e164: ANI }), { contactPhone: ANI });
    expect(flags).toContain('callback_number_needed');
  });

  test('an ordinary caller with neither field is unchanged', () => {
    expect(computeDeterministicTriageFlags(v2(), { contactPhone: ANI })).not.toContain('callback_number_needed');
  });
});

describe('not "not my number": every caller_id_disclaimed consumer ignores the new field', () => {
  const relay = { ani_cannot_text: true, text_phone_e164: null, caller_id_disclaimed: null };

  test('the disclaimed predicate, the crm_notes stamp and the CSR coaching note stay silent', () => {
    expect(callerIdDisclaimedNeedsCallback(relay, { ani: ANI })).toBe(false);
    expect(callerIdDisclaimedNoteText(relay, { ani: ANI })).toBeNull();
    expect(callbackNumberCoachingNote({ caller: relay })).toBeNull();
  });

  test('the booking-link, processor and compat sources never read caller_id_disclaimed for the new field', () => {
    const lane = fs.readFileSync(require.resolve('../services/call-booking-link-text'), 'utf8');
    expect(lane).toMatch(/ani_cannot_text === true && !textNumberForCall/);
    // The disclaimed rule keeps its own, separate line.
    expect(lane).toMatch(/caller_id_disclaimed === true \? 'caller_id_disclaimed'/);
  });
});

describe('schema 1.25.0', () => {
  // Validation of real payloads lives in call-extraction-v2.test.js; this pins the shape.
  test('version, enum and both property definitions, additive and never required', () => {
    expect(SCHEMA_VERSION).toBe('1.25.0');
    expect(persistedSchema.properties.meta.properties.schema_version.enum).toContain('1.25.0');
    for (const schema of [modelOutputSchema, persistedSchema]) {
      const caller = schema.properties.caller;
      expect(caller.properties.ani_cannot_text.type).toEqual(['boolean', 'null']);
      expect(caller.properties.text_phone_e164.type).toEqual(['string', 'null']);
      expect(caller.properties.text_phone_e164.pattern).toBe('^\\+[1-9]\\d{1,14}$');
      expect(caller.required).not.toContain('ani_cannot_text');
      expect(caller.required).not.toContain('text_phone_e164');
    }
  });
});

describe('normalizer, flat view, prompt, replay watch list', () => {
  test('flatView mirrors both fields, null when absent', () => {
    const flat = flatView(v2({ ani_cannot_text: true, text_phone_e164: TEXT }));
    expect(flat.ani_cannot_text).toBe(true);
    expect(flat.text_phone).toBe(TEXT);
    const none = flatView(v2());
    expect(none.ani_cannot_text).toBeNull();
    expect(none.text_phone).toBeNull();
    // caller_id_disclaimed is a separate, untouched field
    expect(flat.caller_id_disclaimed).toBeNull();
  });

  test('the V2 normalizer cleans the text number like phone_e164 and keeps the flag', () => {
    const { normalizeExtractionV2 } = require('../utils/normalize-extraction-v2');
    const out = normalizeExtractionV2(v2({ ani_cannot_text: true, text_phone_e164: '(941) 555-9876' }));
    expect(out.caller.ani_cannot_text).toBe(true);
    expect(out.caller.text_phone_e164).toBe(TEXT);
    const junk = normalizeExtractionV2(v2({ ani_cannot_text: true, text_phone_e164: 'call me' }));
    expect(junk.caller.text_phone_e164).toBeNull();
  });

  test('prompt version 25 carries the rule and keeps caller_id_disclaimed out of it', () => {
    expect(PROMPT_VERSION).toBe('v25');
    const prompt = buildExtractionPrompt('', '', '');
    expect(prompt).toMatch(/- ani_cannot_text: set true ONLY when the caller says the line they are calling from cannot receive text messages/);
    expect(prompt).toMatch(/do NOT set caller_id_disclaimed for it/);
    expect(prompt).toMatch(/- text_phone_e164: /);
  });

  test('the replay variance script watches both fields', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/replay-call-extraction-variance.js'), 'utf8');
    expect(src).toContain("'ani_cannot_text',\n    'text_phone',");
    expect(src).toMatch(/BOOL_FIELDS = new Set\(\[[^\]]*'ani_cannot_text'/);
  });
});

describe('processor wiring (source pins)', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('the new customer takes the text number as its phone and keeps the ANI as secondary_phone', () => {
    expect(src).toContain('const phone = callTextNumberWrites || resolveCallContactPhone(call, extracted.phone);');
    expect(src).toMatch(/secondary_phone: callTextNumberWrites && !samePhone\(contactPhone, callTextNumberWrites\)\s*\? firstExternalPhone\(contactPhone\) : null/);
    // writes need V2 primary; the recipient does not
    expect(src).toContain('const callTextNumberWrites = callExtractionV2PrimaryEnabled() ? callTextNumber : null;');
  });

  test('an existing customer is never rewritten: only the advisory card is filed, with both numbers in the payload', () => {
    const at = src.indexOf("flag: 'text_number_differs'");
    expect(at).toBeGreaterThan(-1);
    const section = src.slice(at - 600, at + 900);
    expect(section).toContain('callTextNumberWrites && customerId && !createdCustomerFromCall');
    for (const key of ['text_phone:', 'ani_phone:', 'customer_phone:']) expect(section).toContain(key);
    expect(section).not.toMatch(/update\(\{\s*phone/);
    // no write to customers.phone anywhere in the card block
    const blockStart = src.indexOf('text_number_differs (owner ruling 2026-10-07');
    const blockEnd = src.indexOf('Phone-verification lane (owner directive 2026-07-27)');
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(src.slice(blockStart, blockEnd)).not.toMatch(/db\('customers'\)[\s\S]*\.update\(/);
  });

  test('an existing customer whose account phone is the ANI gets the number-keyed hold on it, so reminders skip it', () => {
    expect(src).toContain('holdAniForSwap = samePhone(linkedForText.phone, contactPhone);');
    const at = src.indexOf('if (holdAniForSwap) {');
    expect(at).toBeGreaterThan(-1);
    const section = src.slice(at, at + 700);
    expect(section).toContain('armDisclaimedNumberHold({');
    expect(section).toContain('phone: contactPhone');
    expect(section).toContain("abandonToPeer('the text-number hold write')");
  });

  test('the stranded-confirmation replay repair never re-arms a call whose ANI cannot take texts', () => {
    expect(src).toContain('if (replaySlotVerified && replaySlotStart && !v2SmsBlocked && !v2SmsClearedByImpliedConsent && !callAniCannotText) {');
  });

  test('the dropped-call address text (ANI only) is card-only when the ANI cannot take texts', () => {
    expect(src).toMatch(/genuineNewProspect && callAniCannotText\) \{\s*\/\/[^]*?smsOutcome = \{ sent: false, skipped: 'ani_cannot_text' \};/);
  });

  test('the confirmation never redirects to the ANI and goes to the text number', () => {
    expect(src).toMatch(/redirectImpliedToAni = v2SmsClearedByImpliedConsent && !smsTargetIsInboundAni\s*&& smsLast10\(contactPhone\)\.length === 10 && !callAniCannotText;/);
    expect(src).toContain('const smsRecipient = callTextNumber || (redirectImpliedToAni ? contactPhone : smsPhone);');
    expect(src).toMatch(/holdImpliedSmsLeg = \(v2SmsClearedByImpliedConsent && !smsTargetIsInboundAni && !redirectImpliedToAni\s*&& !callTextNumber\) \|\| \(callAniCannotText && !callTextNumber\);/);
  });

  test('the identity-confirm card does not ask the office to save a relay ANI', () => {
    expect(src).toContain('if (linked && !phoneOnFile && !callTextNumberWrites) {');
    expect(src).toContain('if (linked && !phoneOnFile && callTextNumberWrites) callerPhoneUnverified = true;');
  });

  test('the new reason code is registered everywhere the code keeps reason codes', () => {
    const gates = fs.readFileSync(require.resolve('../services/call-routing-gates'), 'utf8');
    expect(gates).toMatch(/text_number_differs: 'customer_field_conflict'/);
    expect(src).toMatch(/text_number_differs: "the caller's line can't take texts/);
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/TriageInboxTabV2.jsx'), 'utf8');
    expect(client).toContain('text_number_differs: "Caller wants texts at another number — swap?"');
  });
});
