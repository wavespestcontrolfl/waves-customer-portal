/**
 * Line that cannot get texts (owner ruling 2026-10-08, CARD-ONLY; schema 1.28.0).
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
  meta: { schema_version: '1.28.0', is_voicemail: false, is_spam: false, call_summary: 's' },
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

describe('schema 1.28.0, normalizer, flat view, prompt, replay watch list', () => {
  test('version, enum and both property definitions, additive and never required', () => {
    expect(SCHEMA_VERSION).toBe('1.28.0');
    expect(persistedSchema.properties.meta.properties.schema_version.enum).toContain('1.28.0');
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

  test('prompt v29 carries the rule and keeps caller_id_disclaimed out of it', () => {
    expect(PROMPT_VERSION).toBe('v29');
    const prompt = buildExtractionPrompt('', '', '');
    expect(prompt).toMatch(/- ani_cannot_text: set true whenever the caller says the line they are calling from cannot receive text messages/);
    expect(prompt).toMatch(/WITH or WITHOUT naming another number to text/);
    expect(prompt).not.toMatch(/ani_cannot_text: set true ONLY/);
    expect(prompt).toMatch(/otherwise null \(ani_cannot_text stays true with no number\)/);
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
    const at = src.indexOf('const buildTextNumberCardItem = async');
    expect(at).toBeGreaterThan(-1);
    const section = src.slice(at, at + 1800);
    expect(section).not.toContain('!createdCustomerFromCall');
    for (const key of ['ani_phone:', 'text_phone:', 'customer_phone_at_call:', 'note: `caller said this line cannot get texts', 'Resolve when the phones are updated — the calling line stays blocked for texts. Use Line can get texts if the line can get texts after all.']) expect(section).toContain(key);
    expect(section).toContain('isDialablePhone(callerForText?.text_phone_e164)');
    expect(section).not.toMatch(/db\('customers'\)[^;]*\.update\(/);
  });

  test('the later refresh updates the OPEN card only; it never inserts, so a settled card stays settled', () => {
    const writeAt = src.indexOf('const writeTextNumberCard = async (trx, item');
    const fileAt = src.indexOf('const fileTextNumberCard = async');
    expect(writeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(fileAt);
    const write = src.slice(writeAt, fileAt);
    expect(write).toMatch(/if \(refresh\) \{[^]*?\.whereIn\('status', \['open', 'in_progress'\]\)\s*\.update\(\{ payload: item\.payload/);
    expect(write).not.toContain('.merge(');
    // …and the stand-alone writer runs it inside ONE transaction that takes the per-call triage lock
    // first and checks the processing claim before the write
    const file = src.slice(fileAt, fileAt + 1800);
    expect(file).toMatch(/await db\.transaction\(async \(trx\) => \{\s*await lockTriageCall\(trx, call\.id\);\s*const owner = await trx\('call_log'\)\.where\(\{ id: call\.id, processing_token: procToken \}\)\.forUpdate\(\)[^]*?if \(!owner\) return;\s*await writeTextNumberCard\(trx, item, \{ refresh \}\);/);
  });

  test('the decision-point pair (hold + release card) commits in ONE transaction: the card is written by afterArm inside armDisclaimedNumberHold', () => {
    const holds = fs.readFileSync(require.resolve('../services/disclaimed-number-holds'), 'utf8');
    // afterArm runs inside the arm transaction, after the hold row and the no-text marks, before return
    expect(holds).toMatch(/const recorded = await recordDisclaimedNumberHold\(\{ phone, customerId, callLogId, conn: trx \}\);[^]*?if \(noTextHold\) \{[^]*?\}\s*(?:\/\/[^\n]*\n\s*)*if \(afterArm\) await afterArm\(trx\);\s*return recorded;/);
    // the processor hands the card write to afterArm and never files the decision-point card separately
    expect(src).toContain('afterArm: item ? async (trx) => writeTextNumberCard(trx, item, { refresh: false }) : null,');
    expect(src).toContain("if (!(await armCallbackNumberHoldAtDecision({ cardExtraction: v2Extraction }))) return abandonToPeer('the disclaimed-number hold write');");
    expect(src).toContain("if (!(await armCallbackNumberHoldAtDecision({ cardExtraction: v2Ext }))) return abandonToPeer('the disclaimed-number hold write');");
    expect(src).not.toMatch(/armCallbackNumberHoldAtDecision\(\)\)\) return abandonToPeer\('the disclaimed-number hold write'\);\s*if \(aniCannotText\([^)]*\)\) await fileTextNumberCard/);
    // the pair is marked landed only when the card went in with the hold
    expect(src).toContain('if (item) noTextDecisionLanded = true;');
  });

  test('a no-text call never adopts a dictated number as the caller phone (the V1 single phone field is quarantined before the customer step)', () => {
    const at = src.indexOf('if (callAniCannotText && extracted.phone && !isOutboundCall(call) && !samePhone(extracted.phone, call.from_phone)) {');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toContain('extracted.phone = null;');
    expect(at).toBeLessThan(src.indexOf('const phone = resolveCallContactPhone(call, extracted.phone);'));
  });

  test('when enforce routing threw before the decision point, the post-customer write arms hold + card itself instead of refreshing a card that does not exist', () => {
    const at = src.indexOf('if (callAniCannotText) {\n      if (!noTextDecisionLanded) {');
    expect(at).toBeGreaterThan(-1);
    const section = src.slice(at, at + 1400);
    for (const line of ['v2SmsBlocked = true;', 'callbackNumberNeededHoldActive = true;', 'noTextHoldArming = true;',
      "if (!(await armCallbackNumberHoldAtDecision({ cardExtraction: v2CanonicalExtraction }))) return abandonToPeer('the disclaimed-number hold write');",
      'await fileTextNumberCard(v2CanonicalExtraction, customerId, { refresh: true });']) expect(section).toContain(line);
  });

  test('"Line can get texts" releases every no-text hold on the verified line, not only this call\'s, and leaves plain disclaimed-number holds alone', () => {
    const holds = fs.readFileSync(require.resolve('../services/disclaimed-number-holds'), 'utf8');
    const at = holds.indexOf('async function clearNoTextHoldsForPhone(');
    expect(at).toBeGreaterThan(-1);
    const fn = holds.slice(at, at + 1600);
    expect(fn).toContain("AND EXISTS (SELECT 1 FROM triage_items t");
    expect(fn).toContain("t.reason_code = 'text_number_differs'");
    expect(fn).toContain("AND NOT EXISTS (SELECT 1 FROM triage_items d");
    expect(fn).toContain("COALESCE(d.payload->>'no_text_hold', '') <> 'true'");
    expect(fn).toContain('AND h.cleared_at IS NULL');
    const triage = fs.readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
    const rel = triage.slice(triage.indexOf('async function releaseNoTextHold('), triage.indexOf('async function releaseClosedNoTextHold('));
    expect(rel).toContain('if (release) {');
    expect(rel).toContain('Holds.clearNoTextHoldsForPhone({');
    expect(rel).toContain('exceptCallLogId: item.call_log_id');
    expect(rel).toMatch(/for \(const otherCallLogId of otherCalls\) \{\s*await clearCallbackNumberHold\(trx, otherCallLogId, \{ clearedBy: assignedTo, numberVerdict: CALLBACK_CARD_VERDICT\.VERIFIED_SAME_NUMBER \}\);/);
  });

  test('arming the no-text hold also marks a callback_number_needed card an earlier pass left open (no stale unmarked card can release it)', () => {
    const at = src.indexOf('const writeTextNumberCard = async (trx, item');
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

  test('shadow mode arms the hold AND files the release card regardless of the V2 hard veto (enforce arms neither)', () => {
    const at = src.indexOf('if (callbackNumberNeededBlocksSms(bridgeTriageFlags)) {');
    expect(at).toBeGreaterThan(-1);
    const shadow = src.slice(at, at + 2200);
    expect(shadow).toContain('ASYMMETRY with enforce mode');
    expect(shadow).toContain('noTextHoldArming = aniCannotText(v2Ext?.caller);');
    expect(shadow).toContain("if (!(await armCallbackNumberHoldAtDecision({ cardExtraction: v2Ext }))) return abandonToPeer('the disclaimed-number hold write');");
    expect(shadow).not.toContain('!hasCanonicalWriteBlock(bridgeTriageFlags))');
    // enforce keeps its veto guard on both
    expect(src).toContain('if (callbackNumberNeededBlocksSms(finalFlags) && !noTextVetoed) {');
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
    // the stand-alone writer is used twice: the owed-card path of the arm helper and the post-customer refresh
    const calls = src.split('await fileTextNumberCard(').length - 1;
    expect(calls).toBe(2);
    const holdAt = src.indexOf("if (!(await armCallbackNumberHoldAtDecision({ cardExtraction: v2Extraction }))) return abandonToPeer('the disclaimed-number hold write');");
    const vetoAt = src.indexOf('const routeDecision = buildRouteDecision({');
    expect(holdAt).toBeGreaterThan(-1);
    expect(holdAt).toBeLessThan(vetoAt);
    expect(src).toContain('await fileTextNumberCard(v2CanonicalExtraction, customerId, { refresh: true });');
    // an owed card (hold armed earlier in the pass without it) aborts the pass for retry, like the hold write
    expect(src.split('{ failClosed: true })').length - 1).toBe(1);
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
