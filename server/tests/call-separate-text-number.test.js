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
    // …even when a spoken number repeats the ANI (the disclaimer is then still unresolved)
    const bothSame = v2({ ani_cannot_text: true, caller_id_disclaimed: true, phone_e164: ANI, phone_source: 'both' });
    expect(dropUnneededCallCards(['callback_number_needed'], bothSame).dropped).not.toContain('callback_number_needed');
    expect(dropUnneededCallCards(['callback_number_needed'], both).dropped).not.toContain('callback_number_needed');
    // shadow-mode bridge agrees
    const bridge = (ext) => deriveCallReviewBridge({ v2TriageFlags: ['callback_number_needed'], v2Extraction: ext, extracted: {} }).needsConfirmation;
    expect(bridge(only)).not.toContain('callback_number_needed');
    expect(bridge(both)).toContain('callback_number_needed');
  });
});

describe('only a valid V2 payload speaks for the no-text fields', () => {
  const { noTextSafeExtraction } = require('../services/call-triage-flags');
  const raw = v2({ ani_cannot_text: true, text_phone_e164: TEXT });

  test.each(['schema_failed', 'normalization_failed', 'not_run', undefined])('a %s payload loses both fields: no flag, no hold', (status) => {
    const safe = noTextSafeExtraction({ status, extraction: raw });
    expect(safe.caller.ani_cannot_text).toBeNull();
    expect(safe.caller.text_phone_e164).toBeNull();
    expect(aniCannotText(safe.caller)).toBe(false);
    expect(computeDeterministicTriageFlags(safe, { contactPhone: ANI })).not.toContain('callback_number_needed');
    // the raw payload is not mutated (it is still stored for audit)
    expect(raw.caller.ani_cannot_text).toBe(true);
  });

  test('a valid payload is returned untouched; a payload without the fields is not cloned; null passes through', () => {
    expect(noTextSafeExtraction({ status: 'valid', extraction: raw })).toBe(raw);
    const plain = v2();
    expect(noTextSafeExtraction({ status: 'schema_failed', extraction: plain })).toBe(plain);
    expect(noTextSafeExtraction({ status: 'schema_failed', extraction: null })).toBeNull();
  });

  test('the shadow bridge reads the extraction through the helper, and so does Step 3', () => {
    const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    expect(src).toContain('const v2Ext = noTextSafeExtraction(v2Result) || null;');
    expect(src).toContain('aniCannotText(noTextSafeExtraction(v2Result, v2CanonicalExtraction)?.caller)');
  });
});

describe('no_text_hold marker on both cards', () => {
  const { buildTriageItem } = require('../services/call-routing-gates');
  const payloadOf = (flag, caller) => {
    const item = buildTriageItem({ callLogId: 'c1', flag, extraction: v2(caller), severity: 'advisory' });
    return typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload;
  };

  test.each(['callback_number_needed', 'text_number_differs'])('%s carries no_text_hold only when the valid extraction says ani_cannot_text', (flag) => {
    expect(payloadOf(flag, { ani_cannot_text: true }).no_text_hold).toBe(true);
    expect(payloadOf(flag, { caller_id_disclaimed: true }).no_text_hold).toBeUndefined();
    expect(payloadOf(flag, { ani_cannot_text: false }).no_text_hold).toBeUndefined();
  });

  test('the shadow bridge files its cards from the safe extraction, so an invalid payload never marks one', () => {
    const src = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const at = src.indexOf('for (const flag of needsConfirmation.slice(0, 10)) {');
    const seg = src.slice(at, at + 4500);
    expect(seg.split('extraction: noTextSafeExtraction(v2Result) ||').length - 1).toBe(2);
    expect(seg).not.toContain('extraction: v2Result?.extraction ||');
  });
});

describe('hard veto', () => {
  test('a no-text-only call with a canonical-write veto flag is vetoed; one that also disclaimed the number is not', () => {
    const { aniCannotTextOnly, hasCanonicalWriteBlock } = require('../services/call-triage-flags');
    for (const veto of ['spam_or_wrong_number', 'out_of_service_area', 'do_not_contact_requested']) {
      expect(aniCannotTextOnly(v2({ ani_cannot_text: true })) && hasCanonicalWriteBlock([veto, 'callback_number_needed'])).toBe(true);
    }
    expect(aniCannotTextOnly(v2({ ani_cannot_text: true })) && hasCanonicalWriteBlock(['callback_number_needed'])).toBe(false);
    expect(aniCannotTextOnly(v2({ ani_cannot_text: true, caller_id_disclaimed: true }))).toBe(false);
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
    for (const key of ['ani_phone:', 'text_phone:', 'customer_phone_at_call:', 'note: `caller said this line cannot get texts', 'Resolve when the phones are updated — the calling line stays blocked for texts. Use Line can get texts if the line can get texts after all.']) expect(section).toContain(key);
    expect(section).toContain('isDialablePhone(callerForText?.text_phone_e164)');
    expect(section).not.toMatch(/db\('customers'\)[^;]*\.update\(/);
  });

  test('the later refresh updates the OPEN card only; it never inserts, so a settled card stays settled', () => {
    const at = src.indexOf('const fileTextNumberCard = async');
    const section = src.slice(at, at + 3200);
    expect(section).toMatch(/if \(refresh\) \{[^]*?\.whereIn\('status', \['open', 'in_progress'\]\)\s*\.update\(\{ payload: item\.payload/);
    // …inside ONE transaction that takes the per-call triage lock first and checks the processing claim
    expect(section).toMatch(/await db\.transaction\(async \(trx\) => \{\s*await lockTriageCall\(trx, call\.id\);\s*const owner = await trx\('call_log'\)\.where\(\{ id: call\.id, processing_token: procToken \}\)\.forUpdate\(\)/);
    expect(section.indexOf('lockTriageCall(trx, call.id)')).toBeLessThan(section.indexOf('if (refresh) {'));
    expect(section).not.toContain('.merge(');
  });

  test('arming the no-text hold also marks a callback_number_needed card an earlier pass left open (no stale unmarked card can release it)', () => {
    const at = src.indexOf('const fileTextNumberCard = async');
    const section = src.slice(at, at + 3600);
    expect(section).toMatch(/reason_code: 'callback_number_needed'[^]*?\.whereIn\('status', \['open', 'in_progress'\]\)[^]*?no_text_hold/);
  });

  test('the hold arm stamps open callback cards in its own transaction, and Resolve reads the LIVE payload under the lock', () => {
    const holds = fs.readFileSync(require.resolve('../services/disclaimed-number-holds'), 'utf8');
    expect(holds).toMatch(/const recorded = await recordDisclaimedNumberHold[^]*?if \(noTextHold\) \{[^]*?no_text_hold/);
    expect(src).toContain('noTextHold: noTextHoldArming');
    expect(src.split('noTextHoldArming = aniCannotText(').length - 1).toBe(2);
    const triage = fs.readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
    expect(triage).toContain('noTextHold: cardCarriesNoTextHold({ ...item, ...liveCard })');
  });

  test('shadow mode applies the same no-text hard-veto rule as enforce mode', () => {
    expect(src).toContain('if (callbackNumberNeededBlocksSms(bridgeTriageFlags) && !(aniCannotTextOnly(v2Ext) && hasCanonicalWriteBlock(bridgeTriageFlags))) {');
  });

  test('re-arming the hold bumps the version of the call\'s text_number_differs cards, so an older closed card goes stale', () => {
    const holds = fs.readFileSync(require.resolve('../services/disclaimed-number-holds'), 'utf8');
    expect(holds).toMatch(/if \(noTextHold\) \{[^]*?reason_code: 'text_number_differs'[^]*?\.update\(\{ updated_at: new Date\(\) \}\)/);
  });

  test('finalization judges the early-filed text card by its CURRENT state, so a settled card never reopens review_status', () => {
    expect(src).toContain("const textCardStillOpen = !bridgeNeedsConfirmation.includes('text_number_differs')\n        || await callCardStillOpen(trx, call.id, 'text_number_differs');");
    expect(src).toContain("&& (r !== 'text_number_differs' || textCardStillOpen)).length;");
    // judged after the per-call lock taken for the final write
    expect(src.indexOf('await lockTriageCall(trx, call.id);\n      // A street-level hold')).toBeLessThan(src.indexOf('const textCardStillOpen'));
  });

  test('a hard-vetoed no-text call gets neither the hold nor the card (the veto the pipeline applies)', () => {
    expect(src).toContain('const noTextVetoed = aniCannotTextOnly(v2Extraction) && hasCanonicalWriteBlock(finalFlags);');
    expect(src).toContain('if (callbackNumberNeededBlocksSms(finalFlags) && !noTextVetoed) {');
  });

  test('the card is filed at BOTH hold decision points (before any hard-veto exit) and refreshed after the customer is known', () => {
    const calls = src.split('await fileTextNumberCard(').length - 1;
    expect(calls).toBe(3);
    const holdAt = src.indexOf("if (!(await armCallbackNumberHoldAtDecision())) return abandonToPeer('the disclaimed-number hold write');\n            if (aniCannotText(v2Extraction?.caller))");
    const vetoAt = src.indexOf('const routeDecision = buildRouteDecision({');
    expect(holdAt).toBeGreaterThan(-1);
    expect(holdAt).toBeLessThan(vetoAt);
    expect(src).toContain('await fileTextNumberCard(v2CanonicalExtraction, customerId, { refresh: true });');
    // decision-point failures abort the pass for retry, like the hold write
    expect(src.split('{ failClosed: true })').length - 1).toBe(2);
    expect(src).toMatch(/if \(failClosed\) \{[^]*?DISCLAIMED_NUMBER_HOLD_WRITE_FAILED/);
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
    expect(src).not.toContain('texts to the calling line resume');
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/TriageInboxTabV2.jsx'), 'utf8');
    expect(client).toContain('text_number_differs: "Caller\'s line can\'t get texts — fix the phones"');
    expect(client).toContain('livePhone: item.customer_phone');
    // in the shared tables, not parallel branches
    expect(client).toMatch(/const NO_VERDICT_REASONS = new Set\(\[[^\]]*"text_number_differs"/);
    const triage = fs.readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
    expect(triage).toContain("          'text_number_differs',\n          ...(item.reason_code !== 'auto_booking_skipped_after_approval'");
    expect(triage).toContain('text_number_differs: \'This card is a no-text line');
    expect(triage).toMatch(/const VERSION_BOUND_REASONS = \[[^\]]*'text_number_differs'/);
  });
});
