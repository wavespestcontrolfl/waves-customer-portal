/**
 * Line that cannot get texts (owner ruling 2026-10-08, CARD-ONLY; schema 1.25.0).
 *
 * A caller says the line they called from cannot get texts and may give another number.
 * Automation never uses that dictated number: no customer phone write, no send. Texts to
 * the calling line hold through the existing callback_number_needed number-keyed hold, and
 * an advisory text_number_differs card carries both numbers and asks the office to fix the
 * phones. NOT caller_id_disclaimed. All numbers are synthetic.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  aniCannotText,
  computeDeterministicTriageFlags,
  callerIdDisclaimedNeedsCallback,
  callbackNumberNeededBlocksSms,
  dropUnneededCallCards,
  deriveCallReviewBridge,
} = require('../services/call-triage-flags');
const { SCHEMA_VERSION } = require('../schemas/validate-extraction');
const modelOutputSchema = require('../schemas/call-extraction.model-output.schema.json');
const persistedSchema = require('../schemas/call-extraction.persisted.schema.json');
const { flatView, callerIdDisclaimedNoteText } = require('../utils/extraction-compat');
const { callbackNumberCoachingNote } = require('../services/csr/csr-coach');
const { buildExtractionPrompt, PROMPT_VERSION } = require('../services/prompts/call-extraction-v1');

const ANI = '+19415550100'; // the relay line the caller called from
const TEXT = '+19415559876'; // the number the caller dictated for texts

const v2 = (callerOver = {}) => ({
  meta: { schema_version: '1.25.0', is_voicemail: false, is_spam: false, call_summary: 's' },
  caller: { relationship_to_property: 'owner', on_site_authorization: true, ...callerOver },
  property: { service_address: { street_line_1: '1 Test St', city: 'Bradenton', postal_code: '34205' } },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-12T10:00:00-04:00' },
  confidence: { overall: 0.9 },
  consent: {},
  triage_flags: [],
});

describe('hold: texts to a no-text line ride the callback_number_needed hold', () => {
  test.each([
    ['no number given', { ani_cannot_text: true }],
    ['a number for texts given', { ani_cannot_text: true, text_phone_e164: TEXT }],
    ['the ANI repeated as the text number', { ani_cannot_text: true, text_phone_e164: ANI }],
  ])('%s: flag raised, SMS blocked', (_l, caller) => {
    const flags = computeDeterministicTriageFlags(v2(caller), { contactPhone: ANI });
    expect(flags).toContain('callback_number_needed');
    expect(callbackNumberNeededBlocksSms(flags)).toBe(true);
  });

  test('without the flag nothing changes', () => {
    for (const caller of [{}, { ani_cannot_text: null, text_phone_e164: TEXT }, { ani_cannot_text: false }]) {
      expect(computeDeterministicTriageFlags(v2(caller), { contactPhone: ANI })).not.toContain('callback_number_needed');
      expect(aniCannotText(caller)).toBe(false);
    }
  });

  test('one card: callback_number_needed is dropped for a no-text line, kept when the caller also disclaimed it', () => {
    const only = v2({ ani_cannot_text: true });
    expect(dropUnneededCallCards(['callback_number_needed'], only).dropped).toContain('callback_number_needed');
    const both = v2({ ani_cannot_text: true, caller_id_disclaimed: true });
    expect(dropUnneededCallCards(['callback_number_needed'], both).dropped).not.toContain('callback_number_needed');
    // shadow-mode bridge agrees
    const bridge = (ext) => deriveCallReviewBridge({ v2TriageFlags: ['callback_number_needed'], v2Extraction: ext, extracted: {} }).needsConfirmation;
    expect(bridge(only)).not.toContain('callback_number_needed');
    expect(bridge(both)).toContain('callback_number_needed');
  });
});

describe('not "not my number": every caller_id_disclaimed consumer ignores the new field', () => {
  const relay = { ani_cannot_text: true, text_phone_e164: TEXT, caller_id_disclaimed: null };
  test('the disclaimed predicate, the crm_notes stamp and the CSR coaching note stay silent', () => {
    expect(callerIdDisclaimedNeedsCallback(relay, { ani: ANI })).toBe(false);
    expect(callerIdDisclaimedNoteText(relay, { ani: ANI })).toBeNull();
    expect(callbackNumberCoachingNote({ caller: relay })).toBeNull();
  });
});

describe('schema 1.25.0, normalizer, flat view, prompt, replay watch list', () => {
  test('version, enum and both property definitions, additive and never required', () => {
    expect(SCHEMA_VERSION).toBe('1.25.0');
    expect(persistedSchema.properties.meta.properties.schema_version.enum).toContain('1.25.0');
    for (const schema of [modelOutputSchema, persistedSchema]) {
      const caller = schema.properties.caller;
      expect(caller.properties.ani_cannot_text.type).toEqual(['boolean', 'null']);
      expect(caller.properties.text_phone_e164.type).toEqual(['string', 'null']);
      expect(caller.required).not.toContain('ani_cannot_text');
      expect(caller.required).not.toContain('text_phone_e164');
    }
  });

  test('flatView mirrors both fields, null when absent', () => {
    const flat = flatView(v2({ ani_cannot_text: true, text_phone_e164: TEXT }));
    expect(flat.ani_cannot_text).toBe(true);
    expect(flat.text_phone).toBe(TEXT);
    expect(flatView(v2()).ani_cannot_text).toBeNull();
    expect(flatView(v2()).text_phone).toBeNull();
    expect(flat.caller_id_disclaimed).toBeNull();
  });

  test('the V2 normalizer cleans the text number and keeps the flag', () => {
    const { normalizeExtractionV2 } = require('../utils/normalize-extraction-v2');
    const out = normalizeExtractionV2(v2({ ani_cannot_text: true, text_phone_e164: '(941) 555-9876' }));
    expect(out.caller.ani_cannot_text).toBe(true);
    expect(out.caller.text_phone_e164).toBe(TEXT);
    expect(normalizeExtractionV2(v2({ ani_cannot_text: true, text_phone_e164: 'call me' })).caller.text_phone_e164).toBeNull();
  });

  test('prompt v25 carries the rule and keeps caller_id_disclaimed out of it', () => {
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

describe('processor wiring (source pins; nothing automatic uses the dictated number)', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('no automatic use of text_phone_e164: the processor reads it only to fill the card payload', () => {
    const uses = src.split('\n').filter((l) => /text_phone_e164/.test(l) && !/^\s*\/\//.test(l));
    expect(uses).toHaveLength(2); // the isDialablePhone check and the value it guards
    expect(src).not.toMatch(/callTextNumber|smsRecipient\s*=\s*[^;]*text/);
    // Step 3 is exactly as on main
    expect(src).toContain('const phone = resolveCallContactPhone(call, extracted.phone);');
    expect(src).not.toContain('secondary_phone: callText');
  });

  test('the card is filed for new and existing customers, with both numbers and the ask', () => {
    const at = src.indexOf('const fileTextNumberCard = async');
    expect(at).toBeGreaterThan(-1);
    const section = src.slice(at, at + 1800);
    expect(section).not.toContain('!createdCustomerFromCall');
    for (const key of ['ani_phone:', 'text_phone:', 'customer_phone:', 'note: `caller said this line cannot get texts', 'Resolve when the phones are right; texts to the calling line resume']) expect(section).toContain(key);
    expect(section).toContain('isDialablePhone(callerForText?.text_phone_e164)');
    expect(section).not.toMatch(/db\('customers'\)[^;]*\.update\(/);
  });

  test('the card is filed at BOTH hold decision points (before any hard-veto exit) and refreshed after the customer is known', () => {
    const calls = src.split('await fileTextNumberCard(').length - 1;
    expect(calls).toBe(3);
    const holdAt = src.indexOf("if (!(await armCallbackNumberHoldAtDecision())) return abandonToPeer('the disclaimed-number hold write');\n            if (aniCannotText(v2Extraction?.caller))");
    const vetoAt = src.indexOf('const routeDecision = buildRouteDecision({');
    expect(holdAt).toBeGreaterThan(-1);
    expect(holdAt).toBeLessThan(vetoAt);
    expect(src).toContain('await fileTextNumberCard(v2CanonicalExtraction, customerId, { refresh: true });');
  });

  test('the appointment-contact backfill never saves a no-text ANI into a blank customers.phone', () => {
    expect(src).toContain('let callerPhoneUnverified = callAniCannotText;');
    expect(src).toContain('{ suppressPhone: callerPhoneUnverified }');
    // and the "save this number to the account" card is not filed for a no-text line
    expect(src).toContain('if (linked && !phoneOnFile && !callAniCannotText) {');
  });

  test('the reason code is registered everywhere the code keeps reason codes, and has its own Resolve', () => {
    const gates = fs.readFileSync(require.resolve('../services/call-routing-gates'), 'utf8');
    expect(gates).toMatch(/text_number_differs: 'customer_field_conflict'/);
    expect(src).toMatch(/text_number_differs: "caller said the line they called from can't get texts/);
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/TriageInboxTabV2.jsx'), 'utf8');
    expect(client).toContain('text_number_differs: "Caller\'s line can\'t get texts — fix the phones"');
    const triage = fs.readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
    expect(triage).toContain("...(item.reason_code !== 'text_number_differs' ? ['text_number_differs'] : [])");
  });
});
