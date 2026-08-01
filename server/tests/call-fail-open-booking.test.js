// Fail-open booking + inbound implied consent (2026-07-10). Grounded in live
// misses: confirmed bookings blocked over recoverable contact-field flags
// (ANI present but caller_phone_missing; existing customer's on-file address;
// garbled-email name_email_mismatch; low confidence on a short familiar call).
const {
  canAutoRoute, BLOCKING_TRIAGE_FLAGS, ADVISORY_TRIAGE_FLAGS, SMS_ONLY_FLAGS,
} = require('../services/call-triage-flags');
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

  test('state-only service_address ("FL") is NOT new-address evidence — fail-open still books (P2)', () => {
    // Florida-only portal: a bare state locates nothing and must not keep the
    // on-file-address recovery dark for a confirmed known-customer booking.
    const ex = extraction(['address_unverifiable', 'missing_service_address'], 0.9);
    ex.property = { service_address: { state: 'FL' } };
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(true);
  });

  test('community-only service_address ("the Lakewood Ranch property") IS new-address evidence — stays blocked (P2)', () => {
    const ex = extraction(['address_unverifiable', 'missing_service_address'], 0.9);
    ex.property = { service_address: { subdivision_or_community: 'Lakewood Ranch' } };
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
  });

  test('held implied-consent confirmation files in the customer-field-conflict lane (P2)', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'implied_consent_non_ani_recipient',
      extraction: { meta: { call_summary: 'booked; confirmation held, number needs confirming' } },
      severity: 'advisory',
    });
    expect(item.category).toBe('customer_field_conflict');
  });

  test('fail-open never strips flags from an UNCONFIRMED call (P2)', () => {
    // Fail-open is for confirmed bookings only: an unconfirmed call keeps
    // caller_phone_missing / name_email_mismatch etc., so the blocked branch
    // files the contact/name review cards, not just the not_confirmed card.
    const ex = extraction(['caller_phone_missing', 'name_email_mismatch']);
    ex.scheduling = { status: 'tentative' };
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19419603120', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('triage_flags');
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['caller_phone_missing', 'name_email_mismatch']));
  });

  test('hard blocks are NEVER failed open', () => {
    for (const hard of ['out_of_service_area', 'caller_not_authorized', 'spam_or_wrong_number']) {
      const ex = extraction([hard]);
      // caller_not_authorized hard-blocks only for an EXPLICIT non-owner
      // (unknown relationship demotes — owner ruling 2026-07-31).
      if (hard === 'caller_not_authorized') {
        ex.caller = { relationship_to_property: 'tenant', on_site_authorization: false };
      }
      const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19419603120', knownCustomer: { hasAddress: true } });
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

describe('canAutoRoute agent-commitment authorization (GATE_CALL_AGENT_COMMIT_BOOKING)', () => {
  // Live miss 2026-07-30: a third-party arranger (realtor booking a WDO
  // inspection for a buyer) confirmed a slot the agent verbally accepted on
  // the call ("we'll confirm it for noon on Sunday") — the booking still
  // parked in triage on caller_not_authorized. All names/quotes here are
  // synthetic.
  const AGENT_COMMIT_QUOTE = "So we'll confirm it for noon on Sunday, and just let us know if anything changes.";
  const TRANSCRIPT = [
    'Caller: Hi, I want to confirm the inspection for noon on Sunday.',
    'Agent: Sounds good, let me grab the address.',
    'Caller: 100 Example Street in Venice.',
    `Agent: ${AGENT_COMMIT_QUOTE}`,
    'Caller: Okay, thank you.',
  ].join('\n');

  function agentCommitted(flags = ['caller_not_authorized'], { claim = true, speaker = 'agent', quote = AGENT_COMMIT_QUOTE } = {}) {
    const ex = extraction(flags);
    // The arranger scenario is an EXPLICIT non-owner — with the relationship
    // unstated ('unknown') the flag demotes before this machinery runs
    // (owner ruling 2026-07-31), and these tests would stop exercising it.
    ex.caller = { relationship_to_property: 'real_estate_agent', on_site_authorization: false };
    // Slot must match the committed quote ("noon on Sunday") — 2026-08-02 is
    // a Sunday; slot binding rejects a quote↔confirmed_start_at mismatch.
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:00-04:00';
    ex.scheduling.agent_committed_booking = claim;
    ex.evidence = quote === null ? [] : [
      { field_path: '/scheduling/agent_committed_booking', quote, speaker, transcript_offset_ms: null },
    ];
    return ex;
  }
  // Call Thursday 7/30; committed slot Sunday 8/2 — inside the 7-day window
  // that makes a spoken weekday a unique calendar date.
  const opts = (extra = {}) => ({ agentCommitFailOpen: true, transcriptLabelsTrusted: true, transcript: TRANSCRIPT, callStartedAt: '2026-07-30T15:50:00-04:00', ...extra });

  test('agent commitment demotes caller_not_authorized to failedOpenFlags and books', () => {
    const r = canAutoRoute(agentCommitted(), opts());
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('gate off → caller_not_authorized still hard-blocks even with a pinned agent commitment', () => {
    const r = canAutoRoute(agentCommitted(), { transcript: TRANSCRIPT });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('caller-attributed evidence cannot satisfy the commitment (trust boundary)', () => {
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { speaker: 'caller' }), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a hallucinated quote that never appears in the transcript stays blocked (P0: evidence is untrusted)', () => {
    const r = canAutoRoute(
      agentCommitted(['caller_not_authorized'], { quote: "You're all booked for Sunday at noon, guaranteed." }),
      opts()
    );
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a quote spoken by the CALLER cannot ground even with an agent speaker label (P0)', () => {
    const r = canAutoRoute(
      agentCommitted(['caller_not_authorized'], { quote: 'Hi, I want to confirm the inspection for noon on Sunday.' }),
      opts()
    );
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('no transcript / unlabeled transcript → fail closed', () => {
    for (const transcript of [null, '', 'we will confirm it for noon on Sunday and just let us know if anything changes']) {
      const r = canAutoRoute(agentCommitted(), opts({ transcript }));
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
    }
  });

  test('untrusted transcript labels fail closed — LLM-inferred Agent:/Caller: prefixes never clear the hard block (round-2 P1)', () => {
    for (const trusted of [undefined, false, 'true']) {
      const r = canAutoRoute(agentCommitted(), opts({ transcriptLabelsTrusted: trusted }));
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
    }
  });

  test('the commitment quote must bind to the confirmed slot — a Tuesday-at-10 commitment never unlocks a Sunday-noon booking (round-2 P1)', () => {
    // Same call, but the model mixed slots: commitment quote says Tuesday at
    // 10 while confirmed_start_at holds Sunday noon.
    const tueQuote = "So we'll get you on the schedule for Tuesday at 10, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, tueQuote);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: tueQuote }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('slot binding requires the weekday too — an hour-only commitment quote stays in triage (round-2 P1)', () => {
    const vagueQuote = "So we'll confirm it for noon then, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, vagueQuote);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: vagueQuote }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('AM/PM must corroborate — a "10 AM" commitment never authorizes a 10 PM slot (round-4 P1)', () => {
    const amQuote = "So we'll see you Sunday at 10 AM, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, amQuote);
    const mk = (startAt) => {
      const ex = agentCommitted(['caller_not_authorized'], { quote: amQuote });
      ex.scheduling.confirmed_start_at = startAt;
      return ex;
    };
    const pm = canAutoRoute(mk('2026-08-02T22:00:00-04:00'), opts({ transcript }));
    expect(pm.allowed).toBe(false);
    expect(pm.appointmentBlockingFlags).toContain('caller_not_authorized');
    const am = canAutoRoute(mk('2026-08-02T10:00:00-04:00'), opts({ transcript }));
    expect(am.allowed).toBe(true);
    expect(am.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test("a period-less \"10 o'clock\" commitment is ambiguous and fails closed (round-4 P1)", () => {
    const bare = "So we'll see you Sunday at 10 o'clock, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, bare);
    const ex = agentCommitted(['caller_not_authorized'], { quote: bare });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('a multi-slot turn never binds — rejected 10 AM + committed 11 AM fails for BOTH slots (round-5 P1)', () => {
    const multi = "Sunday at 10 AM won't work, but we'll see you at 11 AM, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, multi);
    for (const startAt of ['2026-08-02T10:00:00-04:00', '2026-08-02T11:00:00-04:00']) {
      const ex = agentCommitted(['caller_not_authorized'], { quote: multi });
      ex.scheduling.confirmed_start_at = startAt;
      const r = canAutoRoute(ex, opts({ transcript }));
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
    }
  });

  test('two weekday names in the quote are ambiguous and fail closed (round-5 P1)', () => {
    const twoDays = "Saturday is booked solid, so we'll confirm it for noon on Sunday instead, just let us know.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, twoDays);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: twoDays }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('a committed slot more than 7 days after the call fails closed — weekday is not a unique date (round-5 P1)', () => {
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-09T12:00:00-04:00'; // Sunday AFTER next
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('missing callStartedAt fails closed (round-5 P1)', () => {
    const r = canAutoRoute(agentCommitted(), opts({ callStartedAt: undefined }));
    expect(r.allowed).toBe(false);
  });

  test('a SAME-ET-DAY slot is ambiguous and fails closed — "Sunday" on a Sunday could mean next week (round-7 P1)', () => {
    const r = canAutoRoute(agentCommitted(), opts({ callStartedAt: '2026-08-02T09:00:00-04:00' }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a day-7 slot (same weekday next week) fails closed — ET calendar-date diff, not a 168h window (round-7 P1)', () => {
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:00-04:00';
    const r = canAutoRoute(ex, opts({ callStartedAt: '2026-07-26T12:00:00-04:00' })); // prior Sunday, exactly 7 ET days
    expect(r.allowed).toBe(false);
  });

  test('a pinned FRAGMENT cannot strip negation — the whole grounding turn is screened (round-6 P1)', () => {
    const rejectingTurn = "Sunday at 10 AM won't work, but I'll ask someone to call you back.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, rejectingTurn);
    const ex = agentCommitted(['caller_not_authorized'], { quote: 'Sunday at 10 AM' });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('punctuated day periods bind — "Sunday at 10 a.m." matches a 10 AM slot (round-6 P2)', () => {
    const punctuated = "So we'll see you Sunday at 10 a.m., and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, punctuated);
    const ex = agentCommitted(['caller_not_authorized'], { quote: punctuated });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('a CONDITIONAL commitment never books — "If the homeowner approves, we will see you Sunday at noon" (P0)', () => {
    const conditional = "If the homeowner approves, we will see you Sunday at noon, thanks so much.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, conditional);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: conditional }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a trailing non-benign conditional also fails — "…Sunday at noon if the buyer signs off" (P0)', () => {
    const conditional = "So we'll see you Sunday at noon if the buyer signs off on everything.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, conditional);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: conditional }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('the benign closer "just let us know if anything changes" still books (P0 counter-case)', () => {
    const r = canAutoRoute(agentCommitted(), opts());
    expect(r.allowed).toBe(true);
  });

  test('an explicit date in the quote must match the slot — "Sunday, August 9, at noon" never books an August 2 slot (P1)', () => {
    const wrongDate = "So we'll confirm it for Sunday, August 9, at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, wrongDate);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: wrongDate }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a MATCHING explicit date binds — "Sunday, August 2nd, at noon" books the August 2 slot (P1 counter-case)', () => {
    const rightDate = "So we'll confirm it for Sunday, August 2nd, at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, rightDate);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: rightDate }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('a standalone mismatched ordinal day ("the 9th") fails closed (P1)', () => {
    const ordinal = "So we'll confirm it for noon on Sunday the 9th, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, ordinal);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: ordinal }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('out-of-vocabulary commitment language fails closed — "subject to homeowner approval" (P0 contract)', () => {
    const subj = "We will see you Sunday at noon, subject to homeowner approval.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, subj);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: subj }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('any unexpected wording fails the vocabulary contract — "we will swing by Sunday at noon" (P0 contract)', () => {
    const swing = "We will swing by Sunday at noon with all the equipment loaded.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, swing);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: swing }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('a numeric date must match the slot — "Sunday 8/9 at noon" never books an August 2 slot (P1)', () => {
    const numeric = "So we will see you Sunday 8/9 at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, numeric);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: numeric }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('a MATCHING numeric date binds — "Sunday 8/2 at noon" books the August 2 slot (P1 counter-case)', () => {
    const numeric = "So we will see you Sunday 8/2 at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, numeric);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: numeric }), opts({ transcript }));
    expect(r.allowed).toBe(true);
  });

  test('a wrong year fails closed (P1)', () => {
    const yearQuote = "So we will see you Sunday at noon August 2 2027, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, yearQuote);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: yearQuote }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('an interrogative turn never commits — "Will you be there Sunday at noon?" (P0 regression)', () => {
    const question = 'Will you be there Sunday at noon?';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, question);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: question }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a first-person REQUEST is not a commitment — "We will need you to confirm Sunday at noon" (P0 regression)', () => {
    const request = 'We will need you to confirm Sunday at noon.';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, request);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: request }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a conditional BOOKING with a benign-looking tail fails — "we will book you for Sunday at noon if anything changes" (P0 regression)', () => {
    const conditionalBooking = 'We will book you for Sunday at noon if anything changes.';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, conditionalBooking);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: conditionalBooking }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('binding validates the CANONICAL wall clock booking writes — a July "-05:00" noon books noon and binds "noon" (P0 wall-clock)', () => {
    // Wrong seasonal offset: the instant is 13:00 EDT but v2IsoToEtWallClock
    // books the LITERAL wall clock (noon). The noon quote must bind.
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:00-05:00';
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(true);
  });

  test('an instant-equivalent quote does NOT bind the wall clock — "1 PM" against a "-05:00" noon stays blocked (P0 wall-clock)', () => {
    const onePm = "So we'll see you Sunday at 1 PM, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, onePm);
    const ex = agentCommitted(['caller_not_authorized'], { quote: onePm });
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:00-05:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('a foreign offset whose ET wall clock is off-hour fails the guard — raw ":00" with "+05:30" (P0 wall-clock)', () => {
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:00+05:30'; // 02:30 ET wall
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
  });

  test('the SAME sentence must carry form + slot — a pinned question after a commitment sentence never books (P0 splice regression)', () => {
    const splice = 'We will see you Tuesday at 10 AM. Are you booked Sunday at noon?';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, splice);
    const ex = agentCommitted(['caller_not_authorized'], { quote: 'Are you booked Sunday at noon' });
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a two-digit year must match — "Sunday 8/2/27 at noon" never books a 2026 slot (P0 regression)', () => {
    const wrongYear = "So we'll see you Sunday 8/2/27 at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, wrongYear);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: wrongYear }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a matching two-digit year binds — "Sunday 8/2/26 at noon" books the 2026-08-02 slot (counter-case)', () => {
    const rightYear = "So we'll see you Sunday 8/2/26 at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, rightYear);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: rightYear }), opts({ transcript }));
    expect(r.allowed).toBe(true);
  });

  test('a confirmation-required tail is not a commitment — "You are all set to confirm Sunday at noon" (P0 regression)', () => {
    const tail = 'You are all set to confirm Sunday at noon.';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, tail);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: tail }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('a trailing obligation never books — "We will see you Sunday at noon and you need to confirm" (P0 regression)', () => {
    const tail = 'We will see you Sunday at noon and you need to confirm.';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, tail);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: tail }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('positional date shapes — "Sunday 8/2/2 at noon" never books a 2026-08-02 slot (P1 regression)', () => {
    const odd = "So we'll see you Sunday 8/2/2 at noon, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, odd);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: odd }), opts({ transcript }));
    expect(r.allowed).toBe(false);
  });

  test('an ADJACENT conditional sentence poisons the turn — "If the homeowner approves. We will see you Sunday at noon." (P0 regression)', () => {
    const adjacent = 'If the homeowner approves. We will see you Sunday at noon.';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, adjacent);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: 'We will see you Sunday at noon' }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('an adjacent out-of-vocabulary sentence poisons the turn — "Subject to homeowner approval. We will see you Sunday at noon." (P0 regression)', () => {
    const adjacent = 'Subject to homeowner approval. We will see you Sunday at noon.';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, adjacent);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: 'We will see you Sunday at noon' }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a declarative QUESTION never commits — "So we will confirm it for noon on Sunday?" (P0 regression)', () => {
    const question = 'So we will confirm it for noon on Sunday?';
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, question);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: question }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test("a TAG QUESTION poisons the turn — \"You're booked Sunday at noon. Right?\" (round-7o P1 regression)", () => {
    const tag = "You're booked Sunday at noon. Right?";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, tag);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "You're booked Sunday at noon" }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('nonzero SECONDS in confirmed_start_at fail the on-the-hour guard (round-4 P1)', () => {
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:30-04:00';
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('demoted caller_not_authorized survives a block by another gate as failedOpenFlags (round-4 P2)', () => {
    // The "other gate" was prior_complaint_unresolved until 2026-07-31, when
    // the owner ruling made it advisory (a returning customer re-booking is
    // a booking, not a dispute). Swapped for a flag that still hard-blocks
    // so this keeps testing what it was written to test.
    const r = canAutoRoute(agentCommitted(['caller_not_authorized', 'hoa_common_area_requires_approval']), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('hoa_common_area_requires_approval');
    expect(r.appointmentBlockingFlags).not.toContain('caller_not_authorized');
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('an off-hour confirmed start (2:30 PM) is never demoted — windows start on the hour (P1)', () => {
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-02T14:30:00-04:00';
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a partially-labeled transcript (any unlabeled non-empty line) fails closed (P1)', () => {
    const partial = TRANSCRIPT + '\nAnd we are all set for Sunday then.';
    const r = canAutoRoute(agentCommitted(), opts({ transcript: partial }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('an agent-only-labeled transcript (no caller turns) fails closed (P1)', () => {
    const agentOnly = ['Agent: Hello, you have reached Waves.', `Agent: ${AGENT_COMMIT_QUOTE}`].join('\n');
    const r = canAutoRoute(agentCommitted(), opts({ transcript: agentOnly }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a trivially short quote ("sounds good") cannot ground a commitment', () => {
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: 'Sounds good' }), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('a bare boolean claim with no pinned evidence stays blocked', () => {
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: null }), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('evidence without the claim (agent_committed_booking false) stays blocked', () => {
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { claim: false }), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('an unconfirmed booking is never demoted (confirmed-with-start contract)', () => {
    const ex = agentCommitted();
    ex.scheduling.status = 'offered';
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('other hard blocks are untouched — out_of_service_area still vetoes an agent-committed booking', () => {
    const r = canAutoRoute(agentCommitted(['caller_not_authorized', 'out_of_service_area']), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('out_of_service_area');
    expect(r.appointmentBlockingFlags).not.toContain('caller_not_authorized');
  });

  test('composes with contact-field fail-open: both gates demote their flags on one call', () => {
    const ex = agentCommitted(['caller_not_authorized', 'caller_phone_missing']);
    const r = canAutoRoute(ex, opts({ failOpen: true, callerAni: '+19415550100' }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized', 'caller_phone_missing']));
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

describe('canAutoRoute unknown-relationship demotion (owner ruling 2026-07-31)', () => {
  // Live miss 2026-07-31 (call log a771fa15): an inbound caller requested
  // service, gave their info, and agreed a 2:00 PM slot — the booking parked
  // in triage on caller_not_authorized (they never STATED they own the
  // house; relationship arrived 'unknown'). Names/addresses are synthetic.
  //
  // That call ALSO carried address_unverified. The address block is
  // deliberately NOT demoted (codex round-2 P1) — see the regression block
  // at the bottom of this file. Only the relationship demotion lives here.
  const AV_UNVERIFIABLE = {
    status: 'missing_component',
    granularity: 'PREMISE_PROXIMITY',
    inServiceArea: true,
    normalized: { street_line_1: '100 Example Court', city: 'Bradenton', postal_code: '34211' },
  };

  // A positively validated address is REQUIRED before the authorization
  // demotion lifts (codex round-3 P1) — it is the last block on the path, so
  // everything it incidentally backstopped must be satisfied another way.
  const AV_OK = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };

  test('unknown relationship demotes caller_not_authorized and books (advisory card kept)', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('absent caller block counts as unknown and demotes too', () => {
    const r = canAutoRoute(extraction(['caller_not_authorized']), { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('NO positive AV verdict → the authorization block stays (codex round-3 P1)', () => {
    // With AV disabled/not_attempted, computeDeterministicTriageFlags raises
    // no address flag for a populated address — caller_not_authorized was the
    // only thing standing between an unvalidated address and a dispatch.
    for (const av of [undefined, { status: 'not_attempted' }, { status: 'api_unavailable' },
      { status: 'validated_accept', inServiceArea: false }, { status: 'confirm_needed', inServiceArea: true }]) {
      const ex = extraction(['caller_not_authorized']);
      ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
      const r = canAutoRoute(ex, av ? { addressValidation: av } : {});
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
    }
  });

  test('a CORRECTED in-area verdict also satisfies the demotion', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: { status: 'corrected', inServiceArea: true } });
    expect(r.allowed).toBe(true);
  });

  test('an EXPLICIT non-owner without authorization still hard-blocks', () => {
    for (const rel of ['tenant', 'property_manager', 'real_estate_agent', 'neighbor']) {
      const ex = extraction(['caller_not_authorized']);
      ex.caller = { relationship_to_property: rel, on_site_authorization: false };
      const r = canAutoRoute(ex, {});
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
    }
  });

  test('the full live-miss shape: relationship demotes, the ADDRESS still blocks (codex round-2 P1)', () => {
    // The 2026-07-31 call carried both flags. Only caller_not_authorized is
    // safe to demote; address_unverified means Google could not verify the
    // premise, so this call still parks for the office — correctly.
    const ex = extraction(['no_sms_consent_captured', 'caller_not_authorized', 'address_unverified']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_UNVERIFIABLE });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('address_unverified');
    expect(r.appointmentBlockingFlags).not.toContain('caller_not_authorized');
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('a clean AV acceptance + unknown relationship books (the shape that SHOULD auto-route)', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('OFF-HOUR confirmed start keeps the relationship demotion blocked (windows start on the hour)', () => {
    // The booking path copies confirmed_start_at's wall clock into
    // window_start unchanged, so demoting a :30 slot would auto-create a
    // prohibited off-hour start (AGENTS.md owner rule). It parks instead.
    for (const off of ['2026-07-11T09:30:00-04:00', '2026-07-11T09:00:30-04:00']) {
      const ex = extraction(['caller_not_authorized']);
      ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
      ex.scheduling.confirmed_start_at = off;
      const r = canAutoRoute(ex, { addressValidation: AV_OK });
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
    }
  });

  test('a foreign offset that lands off-hour in ET keeps the block (wall clock, not raw minutes)', () => {
    // "+05:30" carries raw :00 minutes but books a :30 ET wall time — the
    // wall clock is what the booking writes.
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    ex.scheduling.confirmed_start_at = '2026-07-11T19:00:00+05:30';
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('REGRESSION: an unverifiable AV verdict is NEVER demoted, in any shape (codex round-2 P1)', () => {
    // address-validation/index.js derives confirm_needed and missing_component
    // PRECISELY when the address cannot be verified: missing_component fires
    // when granularity is not PREMISE/SUB_PREMISE (PREMISE_PROXIMITY means
    // Google did NOT resolve a building), and confirm_needed fires on
    // hasUnconfirmedComponents ("Never auto-route these — hand to a human").
    // An earlier revision of this PR demoted the address block on exactly
    // these verdicts; it would have dispatched a tech to an address Google
    // could not confirm. Pin the contract so it is not re-attempted.
    const shapes = [
      { status: 'missing_component', granularity: 'PREMISE_PROXIMITY' },
      { status: 'missing_component', granularity: 'PREMISE' },
      { status: 'confirm_needed', granularity: 'PREMISE' },
      { status: 'confirm_needed', granularity: 'SUB_PREMISE', hasUnconfirmed: true },
      { status: 'ambiguous', granularity: 'PREMISE' },
    ];
    for (const shape of shapes) {
      const av = {
        inServiceArea: true,
        normalized: { street_line_1: '100 Example Court', city: 'Bradenton', postal_code: '34211' },
        ...shape,
      };
      for (const flag of ['address_unverified', 'address_unverifiable']) {
        const ex = extraction([flag]);
        ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
        const r = canAutoRoute(ex, { addressValidation: av });
        expect(r.allowed).toBe(false);
        expect(r.appointmentBlockingFlags).toContain(flag);
      }
    }
  });

  test('CENTRAL hour gate: an otherwise-clean off-hour call never auto-books (codex round-3 P1)', () => {
    // No flags at all, high confidence, validated address — the ONLY problem
    // is the :30 start. Previously this booked a prohibited window.
    const ex = extraction([]);
    ex.scheduling.confirmed_start_at = '2026-07-11T09:30:00-04:00';
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('off_hour_start');
    expect(r.confirmedStartAt).toBe('2026-07-11T09:30:00-04:00');
  });

  test('CENTRAL hour gate covers the newly-advisory paths too', () => {
    for (const flag of ['prior_complaint_unresolved', 'competing_quotes_active', 'brand_new_model_flag']) {
      const ex = extraction([flag]);
      ex.scheduling.confirmed_start_at = '2026-07-11T09:30:00-04:00';
      const r = canAutoRoute(ex, { addressValidation: AV_OK });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('off_hour_start');
    }
  });

  test('an on-the-hour clean call is unaffected by the central gate', () => {
    const r = canAutoRoute(extraction([]), { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
  });

  test('a demoted flag still rides a scheduling-blocked return so its advisory card files (codex P2)', () => {
    // Guarded on confirmedWithStart, the demotion no longer runs for an
    // unconfirmed call — the flag stays in appointmentBlockingFlags and the
    // card files from there. Belt-and-braces: the scheduling returns now
    // carry failedOpenFlags too, matching low_confidence / do_not_contact.
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    ex.scheduling = { status: 'tentative' };
    const r = canAutoRoute(ex, {});
    expect(r.allowed).toBe(false);
    const surfaced = [...(r.appointmentBlockingFlags || []), ...(r.failedOpenFlags || [])];
    expect(surfaced).toContain('caller_not_authorized');
  });

  test('coarse AV granularity (ROUTE) keeps the address hard block', () => {
    const r = canAutoRoute(extraction(['address_unverified']), {
      addressValidation: { ...AV_UNVERIFIABLE, granularity: 'ROUTE' },
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('address_unverified');
  });

  test('AV match without a normalized street line keeps the address hard block', () => {
    const r = canAutoRoute(extraction(['address_unverified']), {
      addressValidation: { ...AV_UNVERIFIABLE, normalized: { city: 'Bradenton', postal_code: '34211' } },
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('address_unverified');
  });

  test('out-of-area AV verdict keeps the address hard block', () => {
    const r = canAutoRoute(extraction(['address_unverified']), {
      addressValidation: { ...AV_UNVERIFIABLE, inServiceArea: false },
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('address_unverified');
  });

  test('an UNCONFIRMED booking keeps the address hard block even when AV localized it', () => {
    const ex = extraction(['address_unverified']);
    ex.scheduling = { status: 'tentative' };
    const r = canAutoRoute(ex, { addressValidation: AV_UNVERIFIABLE });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('address_unverified');
  });

  test('prior_complaint_unresolved is advisory — a returning customer re-booking is not held', () => {
    // "Last time the ants came back — can you come Tuesday at 10" books; the
    // card tells the office to review the history before the visit.
    const r = canAutoRoute(extraction(['prior_complaint_unresolved']), {});
    expect(r.allowed).toBe(true);
    expect(r.flags).toContain('prior_complaint_unresolved');
    expect(r.appointmentBlockingFlags || []).not.toContain('prior_complaint_unresolved');
  });

  test('a flag OUTSIDE every known set is advisory-by-default, never a silent block', () => {
    // New prompt vocabulary / model drift: unknown names ride failedOpenFlags
    // (card files, booking proceeds) instead of holding the appointment.
    const r = canAutoRoute(extraction(['brand_new_model_flag']), {});
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['brand_new_model_flag']));
  });

  test('allowlist sanity: known hard flags still block without any rescue', () => {
    for (const hard of ['after_hours_emergency', 'cancellation_request', 'ambiguous_pest_or_service', 'voicemail']) {
      const r = canAutoRoute(extraction([hard]), {});
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain(hard);
    }
  });

  test('CONTRACT: every model-schema triage_flag is explicitly classified', () => {
    // Drift guard for the allowlist. Advisory-by-default is the safe
    // direction for an unknown flag, but a NEW enum value MEANT to block
    // would silently book instead. Adding a triage_flag to the schema must
    // be a deliberate three-way choice: BLOCKING / ADVISORY / SMS_ONLY.
    const schema = require('../schemas/call-extraction.model-output.schema.json');
    const enumValues = schema.properties.triage_flags.items.enum;
    expect(Array.isArray(enumValues)).toBe(true);
    expect(enumValues.length).toBeGreaterThan(0);

    const sets = [BLOCKING_TRIAGE_FLAGS, ADVISORY_TRIAGE_FLAGS, SMS_ONLY_FLAGS];
    const unclassified = enumValues.filter((f) => !sets.some((s) => s.has(f)));
    expect(unclassified).toEqual([]);

    // A flag must not carry two classifications at once.
    const doubled = enumValues.filter((f) => sets.filter((s) => s.has(f)).length > 1);
    expect(doubled).toEqual([]);
  });
});
