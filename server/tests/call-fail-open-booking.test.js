// Fail-open booking + inbound implied consent (2026-07-10). Grounded in live
// misses: confirmed bookings blocked over recoverable contact-field flags
// (ANI present but caller_phone_missing; existing customer's on-file address;
// garbled-email name_email_mismatch; low confidence on a short familiar call).
const { canAutoRoute } = require('../services/call-triage-flags');
const { checkTcpaConsent, buildTriageItem } = require('../services/call-routing-gates');

// A confirmed booking with a high-enough confidence; flags injected per test.
function extraction(flags, overall = 0.9) {
  return {
    triage_flags: flags,
    confidence: { overall },
    scheduling: { status: 'confirmed', confirmed_start_at: '2026-07-11T09:00:00-04:00' },
    consent: {},
  };
}

describe('canAutoRoute fail-open booking', () => {
  test('Robin case: caller_phone_missing + name_email_mismatch block WITHOUT fail-open', () => {
    const r = canAutoRoute(extraction(['caller_phone_missing', 'name_email_mismatch']), {});
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['caller_phone_missing', 'name_email_mismatch']));
  });

  test('Robin case: fail-open books when the ANI is present (phone) and clears name_email_mismatch', () => {
    const r = canAutoRoute(extraction(['caller_phone_missing', 'name_email_mismatch']), {
      failOpen: true, callerAni: '+19419603120',
    });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_phone_missing', 'name_email_mismatch']));
  });

  test('caller_phone_missing is NOT recovered when the ANI is absent', () => {
    const r = canAutoRoute(extraction(['caller_phone_missing']), { failOpen: true, callerAni: null });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_phone_missing');
  });

  test('Barbara case: existing customer with on-file address + low confidence books under fail-open', () => {
    const ex = extraction(['address_unverifiable', 'missing_service_address', 'low_confidence_address', 'caller_phone_missing', 'low_extraction_confidence'], 0);
    const blocked = canAutoRoute(ex, {});
    expect(blocked.allowed).toBe(false);
    const open = canAutoRoute(ex, {
      failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true },
    });
    expect(open.allowed).toBe(true);
  });

  test('address flags are NOT cleared for a new caller (no on-file address)', () => {
    const r = canAutoRoute(extraction(['address_unverifiable', 'missing_service_address']), {
      failOpen: true, callerAni: '+19419603120', knownCustomer: null,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable', 'missing_service_address']));
  });

  test('existing customer who GAVE a new AV-rejected address is NOT failed open (P1)', () => {
    // Known customer, but this call provided a new/secondary street AV couldn't
    // accept — must stay blocked (AV still governs new addresses).
    const ex = extraction(['address_unverifiable', 'low_confidence_address'], 0.9);
    ex.property = { service_address: { street_line_1: '9999 Nonexistent Rd' } };
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable', 'low_confidence_address']));
  });

  test('existing customer who gave a PARTIAL new address (city/ZIP only, no street) is NOT failed open (P2)', () => {
    // Caller states a different location by city/ZIP/unit only; AV can't accept
    // it (missing_component). A street line is absent, but a partial component
    // must still count as a new address so the booking fallback never stamps
    // the on-file primary address instead of the partially-stated property.
    for (const partial of [{ city: 'Sarasota' }, { zip: '34231' }, { unit: 'Apt 4B' }, { postal_code: '34292' }]) {
      const ex = extraction(['address_unverifiable', 'low_confidence_address'], 0.9);
      ex.property = { service_address: partial };
      const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
    }
  });

  test('a spoken address surviving only as raw_text counts as a new address and is NOT failed open (P1)', () => {
    // The parser/AV couldn't split the spoken address into components — it
    // survives only in raw_text. It is still a NEW address: fail-open must not
    // drop the address flags, or the booking fallback would dispatch to the
    // on-file primary instead of the stated property.
    const ex = extraction(['address_unverifiable', 'low_confidence_address'], 0.9);
    ex.property = { service_address: { raw_text: '9999 Nonexistent Road, Venice' } };
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
  });

  test('failed-open address_unverifiable files its advisory card in the address-review lane (P3)', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'address_unverifiable',
      extraction: { meta: { call_summary: 'known customer, on-file address' } },
      severity: 'advisory',
    });
    expect(item.category).toBe('address_review');
  });

  test('existing customer who did NOT restate an address (uses on-file) IS failed open', () => {
    const ex = extraction(['address_unverifiable', 'low_confidence_address'], 0.9);
    ex.property = { service_address: {} }; // nothing given → on-file address used
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(true);
  });

  test('hard blocks are NEVER failed open', () => {
    for (const hard of ['out_of_service_area', 'caller_not_authorized', 'spam_or_wrong_number']) {
      const r = canAutoRoute(extraction([hard]), { failOpen: true, callerAni: '+19419603120', knownCustomer: { hasAddress: true } });
      expect(r.allowed).toBe(false);
    }
  });

  test('do_not_contact is never failed open', () => {
    const ex = extraction([]);
    ex.consent.do_not_contact_request = true;
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19419603120' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('do_not_contact');
  });

  test('low overall confidence still blocks a NEW caller even under fail-open', () => {
    const r = canAutoRoute(extraction([], 0), { failOpen: true, callerAni: '+19419603120', knownCustomer: null });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('low_confidence');
  });
});

describe('checkTcpaConsent inbound implied consent', () => {
  test('no explicit consent → canSms false by default', () => {
    expect(checkTcpaConsent({ consent: { sms_consent_given: false } }).canSms).toBe(false);
  });

  test('implied consent (inbound) → canSms true for a transactional confirmation', () => {
    expect(checkTcpaConsent({ consent: { sms_consent_given: false } }, { impliedConsent: true }).canSms).toBe(true);
  });

  test('do-not-contact overrides implied consent', () => {
    const r = checkTcpaConsent({ consent: { do_not_contact_request: true } }, { impliedConsent: true });
    expect(r.canSms).toBe(false);
    expect(r.canEmail).toBe(false);
  });

  test('implied consent applies even with no consent block at all', () => {
    expect(checkTcpaConsent({}, { impliedConsent: true }).canSms).toBe(true);
    expect(checkTcpaConsent({}, {}).canSms).toBe(false);
  });

  test('reason distinguishes implied from explicit clearance (P1: send-site non-ANI hold keys on it)', () => {
    // The processor holds a non-ANI recipient ONLY when the send was cleared
    // by implied consent — explicit sms_consent_given must keep the legacy
    // behavior (send to the resolved customer phone). That distinction rides
    // entirely on the reason string, so pin it.
    expect(checkTcpaConsent({ consent: { sms_consent_given: false } }, { impliedConsent: true }).reason)
      .toBe('implied_consent_inbound');
    expect(checkTcpaConsent({}, { impliedConsent: true }).reason).toBe('implied_consent_inbound');
    expect(checkTcpaConsent({ consent: { sms_consent_given: true } }, { impliedConsent: true }).reason)
      .toBe('sms_consent_given');
  });
});
