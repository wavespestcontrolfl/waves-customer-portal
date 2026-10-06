/**
 * Spoken-phone guard (audit 2026-10-05): a spoken NANP number whose area or
 * exchange code starts with 0 or 1 is never saved as a contact number. Synthetic
 * names and 555-01xx style numbers only.
 */
const fs = require('fs');
const path = require('path');
const { rejectImpossibleSpokenPhones } = require('../services/call-spoken-phone-guard');
const { isImpossibleNanpPhone } = require('../utils/phone');
const {
  computeDeterministicTriageFlags,
  callerIdDisclaimedNeedsCallback,
  isDialablePhone,
} = require('../services/call-triage-flags');
const processor = require('../services/call-recording-processor');

const ANI = '+19415550100';

const v2 = (caller = {}, over = {}) => ({
  meta: { schema_version: '1.22.0', is_voicemail: false, is_spam: false, call_summary: 's' },
  caller: { relationship_to_property: 'owner', on_site_authorization: true, phone_source: 'caller_id', ...caller },
  property: { service_address: {} },
  scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-11T10:00:00-04:00' },
  confidence: { overall: 0.9 },
  consent: {},
  triage_flags: [],
  ...over,
});

describe('isImpossibleNanpPhone', () => {
  test('an area code starting 0 or 1 is impossible; the exchange is not judged (same as isValidNanpNumber)', () => {
    expect(isImpossibleNanpPhone('+11733038616')).toBe(true);
    expect(isImpossibleNanpPhone('173-303-8616')).toBe(true);
    expect(isImpossibleNanpPhone('1 073 555 0123')).toBe(true);
    expect(isImpossibleNanpPhone('+15550100123')).toBe(false);
  });

  test('a +1 number with the wrong digit count is impossible', () => {
    expect(isImpossibleNanpPhone('+1941555012')).toBe(true);
    expect(isImpossibleNanpPhone('+194155501234')).toBe(true);
  });

  test('real NANP numbers, international numbers and fragments are not flagged', () => {
    expect(isImpossibleNanpPhone('+19415550123')).toBe(false);
    expect(isImpossibleNanpPhone('941-555-0123')).toBe(false);
    expect(isImpossibleNanpPhone('+442079460958')).toBe(false);
    expect(isImpossibleNanpPhone('555-0123')).toBe(false);
    expect(isImpossibleNanpPhone('anonymous')).toBe(false);
    expect(isImpossibleNanpPhone(null)).toBe(false);
  });
});

describe('impossible phones never reach a contact number', () => {
  test('isDialablePhone keeps the shared ten-digit floor and refuses a short +1 number', () => {
    expect(isDialablePhone('+35312345678')).toBe(true);
    expect(isDialablePhone('+33123456')).toBe(false);
    expect(isDialablePhone('+1941555012')).toBe(false);
  });

  test('isDialablePhone refuses an impossible number', () => {
    expect(isDialablePhone('+11733038616')).toBe(false);
    expect(isDialablePhone('+19415550123')).toBe(true);
  });

  test('isUsableContactPhone / resolveCallContactPhone fall back to the ANI', () => {
    expect(processor._test.isUsableContactPhone('+11733038616')).toBe(false);
    expect(processor._test.isUsableContactPhone('+19415550123')).toBe(true);
    expect(processor.resolveCallContactPhone({ direction: 'inbound', from_phone: ANI, to_phone: '+19415550199' }, '+11733038616')).toBe(ANI);
  });

  test('a spoken impossible phone with no usable ANI files caller_phone_missing (a person asks again)', () => {
    const flags = computeDeterministicTriageFlags(v2({ phone_e164: '+11733038616', phone_source: 'spoken' }), { contactPhone: null });
    expect(flags).toContain('caller_phone_missing');
    const ok = computeDeterministicTriageFlags(v2({ phone_e164: '+19415550123', phone_source: 'spoken' }), { contactPhone: null });
    expect(ok).not.toContain('caller_phone_missing');
  });

  test('a disclaimed caller whose only spoken number is impossible still needs a callback', () => {
    expect(callerIdDisclaimedNeedsCallback(
      { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: '+11733038616' },
      { ani: ANI },
    )).toBe(true);
    expect(callerIdDisclaimedNeedsCallback(
      { caller_id_disclaimed: true, phone_source: 'spoken', phone_e164: '+19415557781' },
      { ani: ANI },
    )).toBe(false);
  });

  test('an impossible CALLER phone is nulled and the V2 source stops claiming "spoken"', () => {
    const extracted = { first_name: 'Joyce', phone: '+11733038616' };
    const v2Extraction = v2({ phone_e164: '+11733038616', phone_source: 'spoken' });
    const result = rejectImpossibleSpokenPhones({ extracted, v2Extraction });
    expect(extracted.phone).toBeNull();
    expect(v2Extraction.caller.phone_e164).toBeNull();
    expect(v2Extraction.caller.phone_source).toBe('unknown');
    expect(result.rejectedCaller).toBe(true);
  });
});

describe('caller guard', () => {
  test('a V1 caller phone is nulled too (belt and braces over the intake normalizer)', () => {
    const extracted = { first_name: 'Joyce', phone: '+11733038616' };
    expect(rejectImpossibleSpokenPhones({ extracted })).toEqual({ rejectedCaller: true });
    expect(extracted.phone).toBeNull();
  });

  test('secondary contacts are left to the slot writer', () => {
    const v2Extraction = { caller: {}, secondary_contact: { first_name: 'Quentrell', phone_e164: '+11733038616' } };
    rejectImpossibleSpokenPhones({ v2Extraction });
    expect(v2Extraction.secondary_contact.phone_e164).toBe('+11733038616');
  });

  test('nothing to reject is a clean no-op', () => {
    expect(rejectImpossibleSpokenPhones({})).toEqual({ rejectedCaller: false });
  });
});

describe('secondary contacts: an impossible number is never saved or asked', () => {
  const { onSiteOptinAskTrigger } = require('../services/call-recording-processor')._test;

  test('the on-site opt-in ask never triggers on an impossible number', () => {
    const contact = { first_name: 'Quentrell', phone: '+11733038616', on_site: true, role: 'tenant', on_site_role: 'tenant' };
    expect(onSiteOptinAskTrigger(contact)).toBe(false);
    expect(onSiteOptinAskTrigger({ ...contact, phone: '+19415550123' })).toBe(true);
  });

  test('the slot writer refuses the impossible number before anything else reads it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const fn = src.indexOf('async function persistCallSecondaryContact(');
    const refuse = src.indexOf('if (contact && contact.phone && isImpossibleNanpPhone(contact.phone)) contact = { ...contact, phone: null };', fn);
    const onSite = src.indexOf('const onSiteOnly =', fn);
    expect(refuse).toBeGreaterThan(fn);
    expect(onSite).toBeGreaterThan(refuse);
  });
});

describe('processor wiring order', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the V2 caller guard runs before the ai_extraction_enriched write', () => {
    const v2Guard = src.indexOf('rejectImpossibleSpokenPhones({ v2Extraction: v2Result.extraction })');
    const write = src.indexOf('ai_extraction_enriched: v2Result.extraction ? JSON.stringify', v2Guard);
    expect(v2Guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(v2Guard);
  });
});
