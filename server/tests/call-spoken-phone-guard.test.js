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
  test('an area code starting 0 or 1 is impossible; the exchange is not judged (isValidNanpNumber)', () => {
    expect(isImpossibleNanpPhone('+11733038616')).toBe(true);
    expect(isImpossibleNanpPhone('173-303-8616')).toBe(true);
    expect(isImpossibleNanpPhone('1 073 555 0123')).toBe(true);
    expect(isImpossibleNanpPhone('(941) 155-0123')).toBe(false);
    expect(isImpossibleNanpPhone('+19410550123')).toBe(false);
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

  test('the guard nulls an impossible secondary phone in the V1 view and in V2, keeps a real one', () => {
    const extracted = {
      first_name: 'Joyce',
      last_name: null,
      secondary_contact: { first_name: 'Quentrell', last_name: 'Varnum', phone: '+11733038616', email: null },
    };
    const v2Extraction = v2({}, {
      secondary_contact: { first_name: 'Quentrell', last_name: 'Varnum', phone_e164: '+11733038616' },
      secondary_contacts: [
        { first_name: 'Quentrell', last_name: 'Varnum', phone_e164: '+11733038616' },
        { first_name: 'Lorna', last_name: 'Varnum', phone_e164: '+19415550123' },
      ],
    });
    const result = rejectImpossibleSpokenPhones({ extracted, v2Extraction });
    expect(extracted.secondary_contact.phone).toBeNull();
    expect(v2Extraction.secondary_contact.phone_e164).toBeNull();
    expect(v2Extraction.secondary_contacts[0].phone_e164).toBeNull();
    expect(v2Extraction.secondary_contacts[1].phone_e164).toBe('+19415550123');
    expect(result.rejectedSecondary).toBe(3);
    expect(extracted.secondary_contact.first_name).toBe('Quentrell');
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

describe('the guard runs on each record independently', () => {
  test('V1 only (V2 off or failed): the V1 secondary phone is nulled and counted', () => {
    const extracted = { first_name: 'Joyce', secondary_contact: { first_name: 'Quentrell', phone: '+11733038616' } };
    const result = rejectImpossibleSpokenPhones({ extracted });
    expect(extracted.secondary_contact.phone).toBeNull();
    expect(result.rejectedSecondary).toBe(1);
  });

  test('V2 only (no V1 record): the V2 caller and secondary phones are nulled', () => {
    const v2Extraction = v2({ phone_e164: '+11733038616', phone_source: 'spoken' }, {
      secondary_contact: { first_name: 'Quentrell', phone_e164: '+11733038616' },
    });
    const result = rejectImpossibleSpokenPhones({ v2Extraction });
    expect(v2Extraction.caller.phone_e164).toBeNull();
    expect(v2Extraction.secondary_contact.phone_e164).toBeNull();
    expect(result).toEqual({ rejectedSecondary: 1, rejectedCaller: true });
  });

  test('nothing to reject is a clean no-op', () => {
    expect(rejectImpossibleSpokenPhones({})).toEqual({ rejectedSecondary: 0, rejectedCaller: false });
  });
});

describe('processor wiring order', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the V1 guard runs before the optional V2 branch', () => {
    const v1Guard = src.indexOf('rejectImpossibleSpokenPhones({ extracted })');
    const v2Branch = src.indexOf('if (CALL_EXTRACTION_V2_ENABLED) {', v1Guard);
    expect(v1Guard).toBeGreaterThan(-1);
    expect(v2Branch).toBeGreaterThan(v1Guard);
  });

  test('the V2 guard runs before the ai_extraction_enriched write', () => {
    const v2Guard = src.indexOf('rejectImpossibleSpokenPhones({\n            v2Extraction');
    const write = src.indexOf('ai_extraction_enriched: v2Result.extraction ? JSON.stringify');
    expect(v2Guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(v2Guard);
  });
});
