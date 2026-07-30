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

  test('nonzero SECONDS in confirmed_start_at fail the on-the-hour guard (round-4 P1)', () => {
    const ex = agentCommitted();
    ex.scheduling.confirmed_start_at = '2026-08-02T12:00:30-04:00';
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('demoted caller_not_authorized survives a block by another gate as failedOpenFlags (round-4 P2)', () => {
    const r = canAutoRoute(agentCommitted(['caller_not_authorized', 'prior_complaint_unresolved']), opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('prior_complaint_unresolved');
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
