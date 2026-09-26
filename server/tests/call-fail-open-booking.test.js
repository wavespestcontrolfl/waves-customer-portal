// Fail-open booking + inbound implied consent (2026-07-10). Grounded in live
// misses: confirmed bookings blocked over recoverable contact-field flags
// (ANI present but caller_phone_missing; existing customer's on-file address;
// garbled-email name_email_mismatch; low confidence on a short familiar call).
const {
  canAutoRoute, BLOCKING_TRIAGE_FLAGS, ADVISORY_TRIAGE_FLAGS, SMS_ONLY_FLAGS,
  hasAgentCommittedEvidence, quoteBindsConfirmedSlot, normalizeCommitmentText,
} = require('../services/call-triage-flags');
const { checkTcpaConsent, buildTriageItem } = require('../services/call-routing-gates');

// Auto-routing requires a positively validated address (AGENTS.md: "auto-create
// only when ... the address validates"), enforced at the common exit since
// 2026-08-01. Tests whose subject is flag classification or the fail-open
// machinery pass this clean verdict so they isolate their own subject; the
// known-customer cases below instead satisfy the gate via the on-file address.
const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };

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
      failOpen: true, callerAni: '+19419603120', addressValidation: AV_CLEAN,
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

  test('a new lead with a validated on-file address (addressOnly) clears the address flags but keeps every confidence check (codex #4685 r1 P1)', () => {
    const addressOnly = { hasAddress: true, addressOnly: true };
    // Address flags alone: the on-file address satisfies them, booking proceeds.
    const addr = canAutoRoute(extraction(['address_unverifiable', 'missing_service_address', 'caller_phone_missing']), {
      failOpen: true, callerAni: '+19414651056', knownCustomer: addressOnly,
    });
    expect(addr.allowed).toBe(true);
    // The Barbara call with addressOnly trust: low_extraction_confidence still holds it.
    const ex = extraction(['address_unverifiable', 'missing_service_address', 'low_confidence_address', 'caller_phone_missing', 'low_extraction_confidence'], 0);
    const held = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: addressOnly });
    expect(held.allowed).toBe(false);
    expect(held.appointmentBlockingFlags).toContain('low_extraction_confidence');
    expect(held.appointmentBlockingFlags).not.toContain('missing_service_address');
    // And a low overall score is not exempted either.
    const low = extraction(['address_unverifiable'], 0);
    low.confidence = { ...(low.confidence || {}), overall: 0.1 };
    const lowOut = canAutoRoute(low, { failOpen: true, callerAni: '+19414651056', knownCustomer: addressOnly });
    expect(lowOut.allowed).toBe(false);
    expect(lowOut.reason).toBe('low_confidence');
    const establishedOut = canAutoRoute(low, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(establishedOut.allowed).toBe(true);
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
  const opts = (extra = {}) => ({
    agentCommitFailOpen: true, transcriptLabelsTrusted: true, transcript: TRANSCRIPT,
    callStartedAt: '2026-07-30T15:50:00-04:00',
    // The subject here is the commitment machinery, not the address gate.
    addressValidation: AV_CLEAN,
    ...extra,
  });

  test('agent commitment demotes caller_not_authorized to failedOpenFlags and books', () => {
    const r = canAutoRoute(agentCommitted(), opts());
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Owner ruling 2026-09-24: commercial/HOA calls are never auto-booked on
  // an agreed price alone; Waves personnel dictating the booking on the
  // recording (the same grounded agent commitment) is what clears the hold.
  test('agent commitment demotes commercial_requires_quote to failedOpenFlags and books', () => {
    const ex = agentCommitted(['commercial_requires_quote']);
    ex.caller = { relationship_to_property: 'owner', on_site_authorization: true };
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(true);
    expect(r.appointmentBlockingFlags || []).not.toContain('commercial_requires_quote');
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['commercial_requires_quote']));
  });

  test('an agreed price WITHOUT an agent commitment does not clear commercial_requires_quote', () => {
    const ex = agentCommitted(['commercial_requires_quote'], { claim: false, quote: null });
    ex.caller = { relationship_to_property: 'owner', on_site_authorization: true };
    ex.service_request = { ...(ex.service_request || {}), quoted_price_usd: 100 };
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
  });

  test('gate off → commercial_requires_quote still hard-blocks even with a pinned agent commitment', () => {
    const ex = agentCommitted(['commercial_requires_quote']);
    ex.caller = { relationship_to_property: 'owner', on_site_authorization: true };
    const r = canAutoRoute(ex, { transcript: TRANSCRIPT, addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
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

  // Superseded (codex P1, live miss 17ed9362, 2026-09-25): a period-less
  // "N o'clock" used to be treated as irreducibly ambiguous. It now infers
  // its day period from the Waves business day (7am–6pm: 7–11 → am, 12 →
  // pm, 1–6 → pm) and binds when that inferred period AND hour match the
  // confirmed slot — see quoteBindsConfirmedSlot. A period that does NOT
  // match the slot still fails closed.
  test('a period-less "10 o\'clock" commitment infers "am" from business hours and binds a 10 AM slot', () => {
    const bare = "So we'll see you Sunday at 10 o'clock, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, bare);
    const ex = agentCommitted(['caller_not_authorized'], { quote: bare });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('the same "10 o\'clock" quote does NOT bind a 10 PM (22:00) slot — the inferred period must match, not just the hour', () => {
    const bare = "So we'll see you Sunday at 10 o'clock, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, bare);
    const ex = agentCommitted(['caller_not_authorized'], { quote: bare });
    ex.scheduling.confirmed_start_at = '2026-08-02T22:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('"8 o\'clock" infers "am" and binds an 8 AM slot', () => {
    const eight = "So we'll see you Sunday at 8 o'clock, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, eight);
    const ex = agentCommitted(['caller_not_authorized'], { quote: eight });
    ex.scheduling.confirmed_start_at = '2026-08-02T08:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
  });

  test('"1 o\'clock" infers "pm" and binds a 1 PM slot', () => {
    const one = "So we'll see you Sunday at 1 o'clock, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, one);
    const ex = agentCommitted(['caller_not_authorized'], { quote: one });
    ex.scheduling.confirmed_start_at = '2026-08-02T13:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
  });

  // Codex regression (finding 2, this PR's round-2 audit): the "N o'clock"
  // matcher always inferred a period from business hours, even when an
  // EXPLICIT am/pm follows — "10 o'clock PM" recorded 10 AM (the inferred
  // period) instead of the stated 10 PM, and "1 o'clock AM" could ground a
  // 13:00 (1 PM) slot instead of refusing it. An explicit trailing period
  // must now be consumed and used verbatim, ahead of any inference.
  test('"10 o\'clock PM" binds a 22:00 slot, not the business-hours-inferred 10 AM one', () => {
    const pm = "So we'll see you Sunday at 10 o'clock PM, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, pm);
    const mk = (startAt) => {
      const ex = agentCommitted(['caller_not_authorized'], { quote: pm });
      ex.scheduling.confirmed_start_at = startAt;
      return ex;
    };
    const evening = canAutoRoute(mk('2026-08-02T22:00:00-04:00'), opts({ transcript }));
    expect(evening.allowed).toBe(true);
    expect(evening.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
    const morning = canAutoRoute(mk('2026-08-02T10:00:00-04:00'), opts({ transcript }));
    expect(morning.allowed).toBe(false);
    expect(morning.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('"1 o\'clock AM" binds a 01:00 slot, not a 13:00 (1 PM) one', () => {
    const am = "So we'll see you Sunday at 1 o'clock AM, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, am);
    const mk = (startAt) => {
      const ex = agentCommitted(['caller_not_authorized'], { quote: am });
      ex.scheduling.confirmed_start_at = startAt;
      return ex;
    };
    const overnight = canAutoRoute(mk('2026-08-02T01:00:00-04:00'), opts({ transcript }));
    expect(overnight.allowed).toBe(true);
    expect(overnight.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
    const afternoon = canAutoRoute(mk('2026-08-02T13:00:00-04:00'), opts({ transcript }));
    expect(afternoon.allowed).toBe(false);
    expect(afternoon.appointmentBlockingFlags).toContain('caller_not_authorized');
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
    // NOT the shared clean verdict here: a decisive in-area acceptance
    // deliberately SUPPRESSES a stale model out_of_service_area
    // (suppressAddressFlagsForAV), which would defeat the point of this test.
    // A genuinely out-of-area call carries an out-of-area verdict.
    const r = canAutoRoute(agentCommitted(['caller_not_authorized', 'out_of_service_area']),
      opts({ addressValidation: { status: 'out_of_service_area', inServiceArea: false } }));
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

  // Sentence-scoped poisoning (codex P1, live miss 17ed9362): a conditional
  // ELSEWHERE in the grounding turn only poisons the pinned commitment
  // sentence when it references authorization/approval or the scheduling
  // itself — a conditional about something unrelated (here, which inbox a
  // notification lands in) does not.
  test('a conditional about NOTIFICATION ROUTING elsewhere in the turn does not poison the pinned commitment', () => {
    const turn = "Yep, it should go to him, the notification. If it goes to you, I'll make sure that gets figured out. "
      + "But yeah, we'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "But yeah, we'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('a conditional about HOMEOWNER APPROVAL elsewhere in the turn still poisons the pinned commitment', () => {
    const turn = "If the homeowner is not okay with it, we will have to reschedule. But yeah, we'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "But yeah, we'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Round-2 local-audit finding: a DECLARATIVE naming an unmet
  // authorization requirement carries no "if"/"unless"/"subject to" trigger
  // word, so it must poison unconditionally (the whitelist in
  // otherSentenceIsClean already rejects it — "homeowner"/"sign"/"off" are
  // in neither the base vocabulary nor the conditional carve-out), not only
  // when phrased as a conditional.
  test('a DECLARATIVE naming an unmet authorization requirement (no conditional wording) still poisons the pinned commitment', () => {
    const turn = "That still needs the homeowner's sign-off. But yeah, we'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "But yeah, we'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Same round-2 finding, Codex's own phrasing (GitHub review round 1 on
  // this PR): still a bare declarative, no conditional wording at all.
  test('Codex regression: "Homeowner approval is still required." (declarative, no conditional) still poisons', () => {
    const turn = "Homeowner approval is still required. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex regression (GitHub review round 1 on this PR): the benign/poison
  // call must look at the CONDITION CLAUSE ("the technician is available"),
  // not the consequent ("I will email you") — "email" sitting in the
  // consequent must not launder a condition that is actually about
  // technician availability.
  test('Codex regression: a conditional on TECHNICIAN AVAILABILITY still poisons even though its consequent mentions email', () => {
    const turn = "If the technician is available, I'll email you. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex regression, round 2 of this PR's audit (finding 1): the OLD
  // extractor pulled out only the FIRST conditional clause in a sentence —
  // "If the email goes to you, let me know," (benign) — and never looked
  // past it to the SECOND clause, "and if the technician is available,"
  // (non-benign), so the whole sentence read as clean. Every clause must be
  // inspected; one bad clause among several benign ones still poisons.
  test('Codex regression: a sentence with TWO conditional clauses poisons on the second even though the first is benign', () => {
    const turn = "If the email goes to you, let me know, and if the technician is available, I'll call you. "
      + "We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex regression, round 2 of this PR's audit (finding 3): a DECLARATIVE
  // unavailability statement carries no "if"/"unless"/"subject to" trigger
  // word, so it must poison unconditionally, the same way an unmet-
  // authorization declarative already does — the old NEGATION_HEDGE_TOKENS
  // screen only recognized the narrow " unable " token, which "unavailable"
  // never contains.
  test('Codex regression: a DECLARATIVE unavailability statement ("The technician is unavailable.") still poisons', () => {
    const turn = "The technician is unavailable. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // The clause-scoped conditional carve-out (otherSentenceIsClean +
  // clauseIsBenign) only applies to a genuine CONDITIONAL sentence — a
  // plain declarative that merely MENTIONS a weekday or unrelated topic in
  // passing, built entirely from the closed vocabulary, must not poison
  // just for naming one.
  test('an adjacent sentence merely mentioning an unrelated topic (invoice email) does not poison the pinned commitment', () => {
    const turn = "I'll email you the invoice. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // A genuinely benign CONDITIONAL clause — "if the confirmation text goes
  // to the wrong number" is about text-delivery routing, not scheduling,
  // staffing, availability, or authorization — must still ground.
  test('a benign conditional clause about confirmation-text delivery does not poison the pinned commitment', () => {
    const turn = "If the confirmation text goes to the wrong number, let me know. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 3, finding 1: a comma-less consequent ("I'll email you") sat
  // in the SAME clause as the actual condition ("we have space") because
  // extractConditionalClauses previously bounded a clause only at a comma —
  // with no comma, "email" (a benign topic) rode along and laundered the
  // real, unrelated condition (schedule capacity). extractConditionalClauses
  // now also stops a clause at the first first-person consequent head.
  test('Codex round-3 regression: a comma-less clause ("If we have space I\'ll email you.") still poisons on the isolated condition', () => {
    const turn = "If we have space I'll email you. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 3, finding 2: a declarative CANCELLATION carries no
  // conditional trigger and no authorization/unavailability term either —
  // "cancel" simply is not, and was never meant to be, in the closed
  // commitment vocabulary, so the whitelist rejects it with no new list.
  test('Codex round-3 regression: an adjacent CANCELLATION ("Actually, we have to cancel.") still poisons', () => {
    const turn = "We'll see you Sunday at noon. Actually, we have to cancel.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 3, finding 3: an IMPLICIT condition with no trigger word at
  // all ("weather permitting", "contingent on the weather") slipped past
  // every conditional-trigger-based screen. Neither "weather" nor
  // "permitting" nor "contingent" is in the closed vocabulary, so the
  // whitelist rejects all three shapes — as a separate other-sentence, and
  // (via the pinned sentence's own affirmative-form + vocabulary checks)
  // fused into the same sentence as the commitment.
  test('Codex round-3 regression: "Weather permitting." as its own sentence still poisons', () => {
    const turn = "Weather permitting. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-3 regression: "Contingent on the weather." as its own sentence still poisons', () => {
    const turn = "Contingent on the weather. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-3 regression: "Weather permitting, we\'ll see you Sunday at noon." (same sentence) still poisons', () => {
    const sameQuote = "Weather permitting, we'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, sameQuote);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: sameQuote }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 4, finding 1: round 3's whitelist inversion assumed a
  // declarative naming an unmet authorization requirement would always
  // fail commitmentTurnVocabularyOk on its own — but "I need him to confirm
  // the appointment." is built entirely from ordinary base-vocabulary words
  // (i/need/him/to/confirm/the/appointment), so the early
  // `commitmentTurnVocabularyOk → return true` short-circuited past every
  // authorization check before it ever ran. sentenceHasDeclarativePoisonVocabulary
  // (restored, now including the anchored AUTHORIZATION_NEED_RE shape) must
  // run FIRST in otherSentenceIsClean, ahead of the vocabulary early return.
  test('Codex round-4 regression: "I need him to confirm the appointment." still poisons even though every word is base vocabulary', () => {
    const turn = "I need him to confirm the appointment. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Same shape, different party/verb combination, to pin the regex (not a
  // token list) rather than the one literal sentence above.
  test('Codex round-4 regression: "She\'s going to need someone to sign off." still poisons (AUTHORIZATION_NEED_RE, not a literal phrase)', () => {
    const turn = "She's going to need someone to sign off. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 4, finding 1 (pinned-sentence path): the same declarative
  // poison screen now also guards the PINNED commitment sentence itself,
  // as an explicit, non-accidental check (it previously only failed here
  // via turnHasAffirmativeCommitmentForm's slot-word-only tail).
  test('Codex round-4 regression: a declarative unmet-authorization clause FUSED into the pinned sentence still poisons', () => {
    const sameQuote = "We'll see you Sunday at noon, he still needs to confirm.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, sameQuote);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: sameQuote }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 5: rounds 3-4 still leaned on vocabulary MEMBERSHIP as the
  // primary gate, and growing that shared vocabulary for one shape ("should"
  // in round 3, the "confirmation text" topic tokens merged into the base
  // set) quietly opened a hole for another — every word in "We should
  // confirm the appointment." happened to be vocabulary, so the whole
  // sentence passed. otherSentenceIsClean now screens for
  // SCHEDULING_PREDICATE_TERMS directly (after benign topic phrases are
  // stripped), independent of vocabulary membership or conditional
  // structure, so none of the three fixes below needed a new word on any
  // list.
  test('Codex round-5 regression: "We should confirm the appointment." still poisons', () => {
    const turn = "We should confirm the appointment. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-5 regression: "We need your confirmation of the appointment." still poisons', () => {
    const turn = "We need your confirmation of the appointment. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-5 regression: "If you need it, we will book the appointment." still poisons', () => {
    const turn = "If you need it, we will book the appointment. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Positive control (codex round 5): the SAME small-talk + benign-topic-
  // aside shape as the live 17ed9362 turn below, in a different real call —
  // small talk ("Awesome, we made it. Yep.") plus a benign non-scheduling
  // aside ("I'll send you a confirmation text momentarily.") ahead of a
  // clean pinned commitment must still ground. Adapted from the coordinator's
  // exact wording ("...momentarily, and then we'll see you Sunday at 4.")
  // by splitting "momentarily" and the commitment into two sentences with a
  // period instead of a comma — sentence boundaries in this file are
  // period/question/exclamation/semicolon only (splitSentences), so a
  // comma-joined "and then" keeps the commitment fused into the SAME
  // sentence as "I'll send you...", and that fused sentence fails the
  // PRE-EXISTING, unrelated turnHasAffirmativeCommitmentForm check (it must
  // START with a recognized opener + commitment head, and "i ll send you a
  // confirmation text momentarily and then we ll see you" does not) — a
  // structural fact of this file since long before round 3, not something
  // round 5 introduced. The split preserves the exact intent (does small
  // talk plus a benign topic aside poison the turn?) without touching what
  // round 5 actually fixed.
  test('Codex round-5 positive control: small talk + a benign confirmation-text aside does not poison the pinned commitment', () => {
    const turn = "Awesome, we made it. Yep. I'll send you a confirmation text momentarily. So we'll see you Sunday at 4.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const ex = agentCommitted(['caller_not_authorized'], { quote: "So we'll see you Sunday at 4." });
    ex.scheduling.confirmed_start_at = '2026-08-02T16:00:00-04:00'; // Sunday 4 PM
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 6, P1 (:1029): AUTHORIZATION_NEED_RE only covered the
  // third-party INFINITIVE shape ("need him TO confirm"). "We need your
  // okay." is a DIRECT OBJECT shape ("need YOUR okay", no "to <verb>") and
  // named no term from AUTHORIZATION_PARTY_OR_ACT_TERMS either, so it
  // passed whole. The regex gained a second anchored alternative for this
  // shape.
  test('Codex round-6 regression: "We need your okay." still poisons (direct-object authorization shape)', () => {
    const turn = "We need your okay. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-6 regression: "We\'re waiting on his approval." still poisons (same shape, different trigger/party)', () => {
    const turn = "We're waiting on his approval. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 6, P2 (:1234): a purely REINFORCING affirmative ("You're
  // confirmed.") was getting caught by SCHEDULING_PREDICATE_TERMS on
  // "confirmed" even though it states no new scheduling fact — it only
  // echoes the pinned sentence. REINFORCING_AFFIRMATION_RE recognizes this
  // as a narrow, whole-sentence-anchored shape, checked before the
  // scheduling-predicate screen; anything longer than the exact shape still
  // falls through to the ordinary screens.
  test('Codex round-6 regression: "You\'re confirmed." (reinforcing affirmative) does not poison the pinned commitment', () => {
    const turn = "You're confirmed. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('Codex round-6: "You\'re confirmed once he approves." still poisons — a reason clause is not the reinforcing shape', () => {
    const turn = "You're confirmed once he approves. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Accepted strictness (per the coordinator's instruction): a weekday
  // tacked onto an otherwise-reinforcing affirmative is new scheduling
  // information the narrow REINFORCING_AFFIRMATION_RE shape was never meant
  // to cover, so it still falls through to SCHEDULING_PREDICATE_TERMS and
  // poisons on "sunday" — even though the sentence never actually commits
  // to a DIFFERENT day.
  test('Codex round-6: "You\'re confirmed for Sunday." still poisons — a weekday is outside the reinforcing shape (accepted strictness)', () => {
    const turn = "You're confirmed for Sunday. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 6, P2 (:1179): bare ' may ' in SCHEDULING_PREDICATE_TERMS
  // collided with the MODAL verb — "it may go to him" poisoned on the month
  // name. "may" is now recognized only in genuine date-shaped usage
  // (MAY_DATE_RE, a day number/ordinal immediately adjacent).
  test('Codex round-6 regression: modal "may" no longer collides with the month name — the notification-routing turn still grounds', () => {
    const turn = "Yep, it may go to him, the notification. If it goes to you, I'll make sure that gets figured out. "
      + "But yeah, we'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "But yeah, we'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('Codex round-6: a genuine date-shaped "May" mention in an OTHER sentence still poisons', () => {
    const turn = "That's set for May 3rd. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 7, P1: round 6 removed "should" from the base vocabulary,
  // but it was still a FREE token in BENIGN_CONDITIONAL_GLUE_WORDS,
  // reachable by ANY sentence's vocabulary check (conditional or not).
  // "We should get your okay." named no declarative-poison term and no
  // scheduling predicate, so it passed on vocabulary alone. "should" is now
  // never a free token anywhere — it only grounds a sentence through the
  // narrow, anchored NOTIFICATION_ROUTING_RE shape.
  test('Codex round-7 regression: "We should get your okay." still poisons (approval-request shape, modal-independent)', () => {
    const turn = "We should get your okay. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-7 regression: "We\'ll need to get his sign off." still poisons (same approval-request shape, no "should")', () => {
    const turn = "We'll need to get his sign off. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // The live 17ed9362 single-turn fixture (added round 4, re-verified round
  // 5) must still ground after "should" was pulled out of the free glue set
  // — "Yep, it should go to him, the notification." now grounds ONLY
  // through NOTIFICATION_ROUTING_RE's anchored shape, not vocabulary.
  test('Codex round-7: the live 17ed9362 single-turn fixture still grounds after "should" left the free glue set', () => {
    const transcript = [
      'Agent: Waves Pest Control, this is Adam.',
      'Caller: Hi, I handle refinances and need to set up a WDO inspection for a client.',
      'Agent: Sure — what area?',
      'Caller: 100 Example Street in Venice.',
      "Caller: Please make my client the point of contact so you can reach him with any appointment updates. I'll take the report and invoice.",
      "Agent: Awesome. Yep, it should go to him, the notification. It's autonomously done, so if it goes to you, I'll make sure that's rectified. But yeah, we'll see him on Monday at 10 o'clock.",
      "Caller: All right, perfect. I'll let him know. Thank you.",
      'Agent: Thank you. Bye.',
    ].join('\n');
    const extraction = {
      evidence: [{
        field_path: '/scheduling/agent_committed_booking',
        speaker: 'agent',
        quote: "we'll see him on Monday at 10 o'clock.",
      }],
      scheduling: { confirmed_start_at: '2026-09-28T10:00:00-04:00' }, // Monday
    };
    expect(hasAgentCommittedEvidence(extraction, transcript, '2026-09-24T17:50:00Z')).toBe(true);
  });

  // Codex round 7, P2: a direct past-tense reinforcement from the agent's
  // own voice states no new scheduling fact any more than "You're
  // confirmed." does — extended REINFORCING_AFFIRMATION_RE with this second
  // anchored alternative.
  test('Codex round-7 regression: "We confirmed your appointment." (direct past-tense reinforcement) does not poison the pinned commitment', () => {
    const turn = "We confirmed your appointment. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Accepted strictness, same as the round-6 weekday case: a trailing
  // weekday is new scheduling information outside the narrow reinforcing
  // shape, so it still falls through to SCHEDULING_PREDICATE_TERMS.
  test('Codex round-7: "We confirmed your appointment for Sunday." still poisons — a weekday is outside the reinforcing shape', () => {
    const turn = "We confirmed your appointment for Sunday. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // "We'll confirm your appointment." (future, not done) must never ground
  // AS THE PINNED COMMITMENT SENTENCE — verifying the pre-existing
  // turnHasAffirmativeCommitmentForm gate still holds and that the
  // round-7 REINFORCING_AFFIRMATION_RE extension (which only matches the
  // PAST-TENSE "confirmed"/"booked"/"scheduled" verbs) does not interact
  // with it at all.
  test('Codex round-7: "We\'ll confirm your appointment." (future tense) never grounds as the pinned sentence', () => {
    const futureTranscript = [
      'Caller: Hi, checking on my appointment.',
      "Agent: We'll confirm your appointment.",
    ].join('\n');
    const extraction = {
      evidence: [{
        field_path: '/scheduling/agent_committed_booking',
        speaker: 'agent',
        quote: "We'll confirm your appointment.",
      }],
      scheduling: { confirmed_start_at: '2026-08-02T12:00:00-04:00' },
    };
    expect(hasAgentCommittedEvidence(extraction, futureTranscript, '2026-07-30T15:50:00-04:00')).toBe(false);
  });

  // Codex round 8, P1: AUTHORIZATION_NEED_RE's infinitive branch listed only
  // THIRD-PARTY parties (him/her/them/someone/the owner/…) — but the CALLER
  // themself needing to grant authorization is the same shape, just a
  // different pronoun. "I need YOU to okay it." named no party from the
  // original list (the caller isn't a third party) and no verb match either
  // (the trailing "it" wasn't accounted for), so it passed whole. Added
  // caller-directed parties (you/us/me/you guys/y'all) and an optional
  // trailing object after the verb, same anchored "need <party> to <verb>"
  // shape.
  test('Codex round-8 regression: "I need you to okay it." still poisons (caller-directed party, trailing object)', () => {
    const turn = "I need you to okay it. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-8 regression: "We\'re going to need you to sign off on it." still poisons (same shape, different trigger/verb/object)', () => {
    const turn = "We're going to need you to sign off on it. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // The live 17ed9362 single-turn fixture and the round-6/round-7 positive
  // controls must still pass after widening AUTHORIZATION_NEED_RE's party
  // and verb-object groups — none of those turns use "need <caller> to
  // <verb> (it)", so the widened regex should not newly catch them.
  test('Codex round-8: the live 17ed9362 single-turn fixture still grounds after widening AUTHORIZATION_NEED_RE', () => {
    const transcript = [
      'Agent: Waves Pest Control, this is Adam.',
      'Caller: Hi, I handle refinances and need to set up a WDO inspection for a client.',
      'Agent: Sure — what area?',
      'Caller: 100 Example Street in Venice.',
      "Caller: Please make my client the point of contact so you can reach him with any appointment updates. I'll take the report and invoice.",
      "Agent: Awesome. Yep, it should go to him, the notification. It's autonomously done, so if it goes to you, I'll make sure that's rectified. But yeah, we'll see him on Monday at 10 o'clock.",
      "Caller: All right, perfect. I'll let him know. Thank you.",
      'Agent: Thank you. Bye.',
    ].join('\n');
    const extraction = {
      evidence: [{
        field_path: '/scheduling/agent_committed_booking',
        speaker: 'agent',
        quote: "we'll see him on Monday at 10 o'clock.",
      }],
      scheduling: { confirmed_start_at: '2026-09-28T10:00:00-04:00' }, // Monday
    };
    expect(hasAgentCommittedEvidence(extraction, transcript, '2026-09-24T17:50:00Z')).toBe(true);
  });

  test('Codex round-8: round-6/round-7 positive controls ("You\'re confirmed.", "We confirmed your appointment.") still pass', () => {
    for (const turn of ["You're confirmed. We'll see you Sunday at noon.", "We confirmed your appointment. We'll see you Sunday at noon."]) {
      const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
      const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
      expect(r.allowed).toBe(true);
      expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
    }
  });

  // Codex round 9, P1 (:713): neither AUTHORIZATION_NEED_RE nor
  // APPROVAL_REQUEST_RE covers a DIRECTIVE the agent gives to have a third
  // party grant approval — "I will tell him to okay it." named no "need"/
  // "waiting"/"get...your" trigger, and every word (i/will/him/to/okay/it)
  // was ordinary COMMITMENT_TURN_VOCAB; "tell" reached the sentence only
  // because BENIGN_CONDITIONAL_GLUE_WORDS is consulted for every OTHER
  // sentence, not just a conditional one. Added THIRD_PARTY_APPROVAL_DIRECTIVE_RE,
  // the same anchored "(tell/ask/have/get) <party> (to)? <authorization
  // verb> (<object>)?" shape as the existing two authorization-need checks.
  test('Codex round-9 regression: "I will tell him to okay it." still poisons (third-party approval directive)', () => {
    const turn = "I will tell him to okay it. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-9 root cause: conditional glue words never unlock for a plain declarative', () => {
    const turn = "We tell them to make sure it gets figured out. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-9 regression: "Ask her to approve it." still poisons (same shape, different trigger/party)', () => {
    const turn = "Ask her to approve it. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-9 regression: "We\'ll have him sign off on it." still poisons (causative trigger, no "to", trailing "on it")', () => {
    const turn = "We'll have him sign off on it. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 9, P1 (:1263): an ordinal date token ("3rd") is admitted by
  // the final vocabulary whitelist (turnVocabularyTokenOk already has to
  // allow it so the PINNED sentence can state a date), but
  // sentenceHasSchedulingPredicate never recognized that same token as
  // scheduling CONTENT — so an OTHER sentence naming a bare date, with no
  // weekday/month/"confirm" term, cleared every screen even though it names
  // a DIFFERENT date than the pinned Sunday-noon slot. Widened the bare-digit
  // fallback to also match the ordinal suffix.
  test('Codex round-9 regression: "We\'re set for the 3rd." still poisons (bare ordinal date, no weekday/month term)', () => {
    const turn = "We're set for the 3rd. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 9, P1 (:1263): MAY_DATE_RE's alternation required the day
  // number to sit directly after "may" ("may 3rd") or before it ("3rd of
  // may") — "May the 3rd", the other common spoken order, matched neither
  // branch. Widened with an optional "the" between month and day. (The
  // ordinal-token fallback above also independently catches "3rd" here, so
  // this sentence poisons either way — this test pins the MAY_DATE_RE fix
  // specifically, per the finding.)
  test('Codex round-9 regression: "That\'s set for May the 3rd." still poisons (MAY_DATE_RE with "the" between month and day)', () => {
    const turn = "That's set for May the 3rd. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // The live 17ed9362 single-turn fixture and the round-6/round-7 positive
  // controls must still pass after adding THIRD_PARTY_APPROVAL_DIRECTIVE_RE
  // and widening the ordinal-date checks — none of those turns use a
  // "tell/ask/have/get <party> <verb>" directive or an ordinal date token,
  // so neither change should newly catch them.
  test('Codex round-9: the live 17ed9362 single-turn fixture still grounds after the round-9 fixes', () => {
    const transcript = [
      'Agent: Waves Pest Control, this is Adam.',
      'Caller: Hi, I handle refinances and need to set up a WDO inspection for a client.',
      'Agent: Sure — what area?',
      'Caller: 100 Example Street in Venice.',
      "Caller: Please make my client the point of contact so you can reach him with any appointment updates. I'll take the report and invoice.",
      "Agent: Awesome. Yep, it should go to him, the notification. It's autonomously done, so if it goes to you, I'll make sure that's rectified. But yeah, we'll see him on Monday at 10 o'clock.",
      "Caller: All right, perfect. I'll let him know. Thank you.",
      'Agent: Thank you. Bye.',
    ].join('\n');
    const extraction = {
      evidence: [{
        field_path: '/scheduling/agent_committed_booking',
        speaker: 'agent',
        quote: "we'll see him on Monday at 10 o'clock.",
      }],
      scheduling: { confirmed_start_at: '2026-09-28T10:00:00-04:00' }, // Monday
    };
    expect(hasAgentCommittedEvidence(extraction, transcript, '2026-09-24T17:50:00Z')).toBe(true);
  });

  test('Codex round-9: round-6/round-7 positive controls ("You\'re confirmed.", "We confirmed your appointment.") still pass', () => {
    for (const turn of ["You're confirmed. We'll see you Sunday at noon.", "We confirmed your appointment. We'll see you Sunday at noon."]) {
      const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
      const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
      expect(r.allowed).toBe(true);
      expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
    }
  });

  // Codex round 10, P1 (:1048): AUTHORIZATION_NEED_RE's "need <party> to
  // <verb>" shape only matched when the party needing to act sat BETWEEN
  // "need" and "to" — a SUBJECT-LED phrasing ("You need to okay it.") names
  // no such object party at all, and every word (you/need/to/okay/it) was
  // ordinary COMMITMENT_TURN_VOCAB, so it read as clean. Added
  // SUBJECT_LED_APPROVAL_NEED_RE, the fourth anchored shape in the same
  // family.
  test('Codex round-10 regression: "You need to okay it." still poisons (subject-led approval requirement)', () => {
    const turn = "You need to okay it. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 10, P1 (:655): this PR (round 9) added "yeah" and "but" to
  // the SHARED COMMITMENT_TURN_VOCAB (needed only because the real pinned
  // grounding sentence opened "But yeah, …"), but that Set is also what
  // every OTHER sentence is checked against — so "Yeah, but no." named no
  // scheduling predicate and no declarative-poison term, and every token
  // was vocabulary, laundering an explicit rejection as a clean aside. "but"
  // is now pinned-sentence-only (via COMMITMENT_OPENER_TOKENS), and a bare
  // "no"/"nope"/"nah" is a negation/hedge token in its own right.
  // Codex round 10 (review of 86991f9bdc): P1 — the non-possessive
  // approval requirement; P2 — "No problem." must survive the bare-"no" screen.
  test.each([
    "We need the okay. We'll see you Sunday at noon.",
    "Just have to get an approval. We'll see you Sunday at noon.",
    "We're waiting for the go ahead. We'll see you Sunday at noon.",
  ])('Codex round-11 regression: non-possessive approval requirement poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-11: "No problem." still grounds (affirmation, not the bare-"no" rejection)', () => {
    const turn = "No problem. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 11 (review of 73953c1db3): three P1s.
  test.each([
    "I need to okay it. We'll see you Sunday at noon.",
    "We need to okay it. We'll see you Sunday at noon.",
  ])('Codex round-12 regression: first-person approval requirement poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "You'll need to okay it. We'll see you Sunday at noon.",
    "You will have to sign off on it. We'll see you Sunday at noon.",
    "They're going to need to approve it. We'll see you Sunday at noon.",
    "He'll still have to confirm. We'll see you Sunday at noon.",
  ])('Codex round-13 regression: modal subject-led approval requirement poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "The okay will come in the email. We'll see you Sunday at noon.",
    "Your approval should come through the email. We'll see you Sunday at noon.",
  ])('Codex round-18 regression: a pending approval as the subject poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 18 (review of 0f5ba00c50): four P1s.
  // P1 (:1375) — progressive "confirming" (and "inspection") is scheduling content.
  // P1 (:1590) — a benign "let us know if…" closer must END its sentence.
  // P1 (:1213) — an article-less pending approval subject.
  // P1 (:746)  — a bare-pronoun routing sentence names no topic.
  test.each([
    "We need you confirming it. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. You're set for the inspection.",
    "Let us know if anything changes, and then we will put you down. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon, just let us know if anything changes and we'll put you down.",
    "Okay will come in the email. We'll see you Sunday at noon.",
    "Approval will come in the email. We'll see you Sunday at noon.",
    "So okay will come through. We'll see you Sunday at noon.",
    "It should go to him. We'll see you Sunday at noon.",
    "That should go to the homeowner. We'll see you Sunday at noon.",
    "It may go to him. We'll see you Sunday at noon.",
  ])('Codex round-19 regression: confirming, trailing consequents, article-less approvals, and topic-less routing poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "We'll see you Sunday at noon. Just let us know if anything changes.",
    "We'll see you Sunday at noon. Let us know if anything changes, thank you so much.",
    "Okay, we'll see you Sunday at noon.",
    "The notification should go to him. We'll see you Sunday at noon.",
    "Yep, it should go to him, the notification. We'll see you Sunday at noon.",
    "Yep, it may go to him, the notification. We'll see you Sunday at noon.",
  ])('Codex round-19: benign closers, openers, and topic-named routing still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 19 (review of 4de001a2fc): three P1s.
  // P1 (:1215) — an approval need coordinated onto a benign routing span.
  // P1 (:1169) — a subjectless approval need (ASR fragment).
  // P1 (:1543) — a second trigger with no consequent of its own.
  test.each([
    "You may get a text and need to okay it. We'll see you Sunday at noon.",
    "Need to okay it. We'll see you Sunday at noon.",
    "Have to okay it. We'll see you Sunday at noon.",
    "Got to okay it. We'll see you Sunday at noon.",
    "Okay, need to sign off on it. We'll see you Sunday at noon.",
    "If the email goes to you, I'll make sure that's rectified, and if the text goes to him. We're all set. We'll see you Sunday at noon.",
  ])('Codex round-20 regression: coordinated or subjectless approval needs and dangling second triggers poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "You may get a text. We'll see you Sunday at noon.",
    "If the email goes to you, I'll make sure that's rectified. We'll see you Sunday at noon.",
    "If the confirmation text goes to the wrong number, let me know. We'll see you Sunday at noon.",
  ])('Codex round-20: benign routing and single-trigger conditionals with a consequent still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 20 (review of c65ffa5423): P1 (:1138) — an approval
  // directive sent through a communication channel.
  test.each([
    "We'll text him to okay it. We'll see you Sunday at noon.",
    "We'll email her to approve it. We'll see you Sunday at noon.",
    "We'll send him a link to okay it. We'll see you Sunday at noon.",
    "I'll call the owner to sign off on it. We'll see you Sunday at noon.",
  ])('Codex round-21 regression: approval directives through a channel poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 21 (review of 73d8b63ddd): three P1s, closed by family.
  // P1 (:1143) — object before the recipient in a channel directive.
  // P1 (:1181) — a direct future approval promise.
  // P1 (:1426) — a pending booking idiom.
  test.each([
    "We'll send the email to him to okay it. We'll see you Sunday at noon.",
    "We'll forward the link over to the owner to approve it. We'll see you Sunday at noon.",
    "You will okay it. We'll see you Sunday at noon.",
    "He'll okay it. We'll see you Sunday at noon.",
    "They can sign off on it. We'll see you Sunday at noon.",
    "Need to put you down. We'll see you Sunday at noon.",
    "Have to get you in. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. Still have to put him down.",
  ])('Codex round-22 regression: approval-verb use and pending booking idioms poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 22 (review of e41594dfe4): four P1s.
  // P1 (:1121) — determiner-less "need yes".
  // P1 (:1439) — "put you in" (any "<party> in").
  // P1 (:1406) — a compound antecedent with one booking-status component.
  // P1 (:611)  — the bare "We'll see." hedge.
  test.each([
    "We need yes. We'll see you Sunday at noon.",
    "We need approval. We'll see you Sunday at noon.",
    "Need to put you in. We'll see you Sunday at noon.",
    "If we are all set and the email goes to you, I'll make sure that's rectified. We'll see you Sunday at noon.",
    "We'll see. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. We'll see, thanks.",
    "Let's see. We'll see you Sunday at noon.",
  ])('Codex round-23 regression: need-yes, put-you-in, compound antecedents, and see-hedges poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "If the email goes to you, I'll make sure that's rectified. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. Thank you so much.",
  ])('Codex round-23: single-topic antecedents and courtesy closers still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Owner ruling 2026-09-26 (after codex round 22): a non-conditional OTHER
  // sentence grounds only if it is an allowlisted whole-sentence shape.
  // Sentences built purely from commitment vocabulary no longer clear.
  test.each([
    "We will have it. We'll see you Sunday at noon.",
    "It will come up. We'll see you Sunday at noon.",
    "We'll get it. We'll see you Sunday at noon.",
    "That is it for him. We'll see you Sunday at noon.",
    "You got it all. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. We will send it.",
    "We'll send you a link. We'll see you Sunday at noon.",
    "I'll email him the invoice to okay it. We'll see you Sunday at noon.",
    "Thanks, we need yes. We'll see you Sunday at noon.",
  ])('owner allowlist: an unlisted other sentence holds the call — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "Perfect. We'll see you Sunday at noon.",
    "Okay, sounds good. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. Have a good one.",
    "We'll see you Sunday at noon. Okay, bye.",
    "I'll send you the invoice. We'll see you Sunday at noon.",
    "You'll get a text shortly. We'll see you Sunday at noon.",
    "We're all set. We'll see you Sunday at noon.",
  ])('owner allowlist: listed shapes still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 23 (reviews of 223c088e84 and 1be805e080): four P1s.
  // (:1266) "Okay it." and (:613) "We'll let you know." — unlisted shapes,
  // held by the owner allowlist. (:1429) an unpunctuated compound clause —
  // the whole clause must be the benign routing shape.
  test.each([
    "Okay it. We'll see you Sunday at noon.",
    "We'll let you know. We'll see you Sunday at noon.",
    "If we're all set the email goes to you, I'll make sure that's rectified. We'll see you Sunday at noon.",
  ])('Codex round-24 regression: approval imperatives, pending hedges, and unpunctuated compound clauses poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // (:958) a retraction or caveat in a LATER agent turn.
  test.each([
    "Agent: Actually, Sunday won't work.",
    "Agent: Let me move that to Monday at noon.",
    "Agent: We'll see you Monday at 3 instead.",
    "Agent: He still needs to okay it.",
    "Agent: We need to check with the technician first.",
    "Agent: Sunday at noon is off.",
    "Agent: Sorry, we can't do Sunday.",
    "Agent: Actually, that won't work.",
    "Agent: We'll do Monday at 3.",
    "Agent: Does Sunday still work?",
    "Agent: Let's do it at 3.",
    "Agent: We can come at 10 30.",
    "Agent: Sunday at noon, we'll see.",
  ])('Codex round-24 regression: a later agent turn retracting or caveating the commitment holds the call — %s', (later) => {
    const transcript = `${TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, "We'll see you Sunday at noon.")}\n${later}\nCaller: Okay.`;
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "Agent: Can I get your email address?",
    "Agent: Perfect, you'll get a text shortly. Have a good one.",
    "Agent: So, we'll see you Sunday at noon.",
    "Agent: Sorry, what was your email address?",
    "Agent: Please wait for the text.",
    "Agent: So that's 100 Example Street in Venice.",
    "Agent: Is 100 Example Street correct?",
    "Agent: Our technician will text you when he's on the way.",
    "Agent: And the house is at 100 Example Street.",
  ])('Codex round-24: ordinary wrap-up or a same-slot restatement in a later turn still grounds — %s', (later) => {
    const transcript = `${TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, "We'll see you Sunday at noon.")}\n${later}\nCaller: Okay.`;
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 25 (review of 6eed8bfd87): P1 (:1017) — a later CALLER
  // turn rejecting or caveating the slot.
  test.each([
    "Caller: No, Sunday does not work for me.",
    "Caller: Actually, can we do Monday instead?",
    "Caller: Sunday at noon is off.",
    "Caller: I need to ask my husband first.",
    "Caller: Let me check and call you back.",
    "Caller: Can we do the following week?",
    "Agent: Let's push it back a day.",
    "Caller: Could we do it a little earlier?",
    "Caller: I decline.",
    "Caller: I have to pass.",
    "Caller: Forget it, that's too expensive.",
    "Caller: I changed my mind.",
  ])('Codex round-26 regression: a later caller rejection or caveat holds the call — %s', (later) => {
    const transcript = `${TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, "We'll see you Sunday at noon.")}\n${later}`;
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "Caller: Great, see you Sunday at noon.",
    "Caller: No, that's all, thank you.",
    "Caller: Perfect, thanks so much. Bye.",
  ])('Codex round-26: a later caller acknowledgement or closer still grounds — %s', (later) => {
    const transcript = `${TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, "We'll see you Sunday at noon.")}\n${later}`;
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test.each([
    "We need that okay. We'll see you Sunday at noon.",
    "We need this approval. We'll see you Sunday at noon.",
    "We're set for the morning. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. You're set for the afternoon.",
  ])('Codex round-17 regression: demonstrative approval / spoken day period in another sentence poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "We'll see you Sunday at noon. We are all booked.",
    "We'll see you Sunday at noon. We're booked.",
  ])('Codex round-12 regression: "We are (all) booked." is a capacity statement and poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "You're all booked. We'll see you Sunday at noon.",
    "We're all set. We'll see you Sunday at noon.",
    "You're confirmed. We'll see you Sunday at noon.",
    "We confirmed your appointment. We'll see you Sunday at noon.",
  ])('Codex round-12: reinforcing affirmations still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('Codex round-12 regression: a cardinal date equal to the hour ("Sunday the 10 at 10 o\'clock") must match the slot day', () => {
    const turn = "We'll see you Sunday the 10 at 10 o'clock.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const ex = agentCommitted(['caller_not_authorized'], { quote: turn });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "We'll see you Sunday the 2 at 10 o'clock.",
    "We'll see you Sunday at 10 o'clock.",
    "We'll see you Sunday for the 10 o'clock.",
  ])('Codex round-12: date-position numbers that match the slot (or are hour-marked) still bind — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const ex = agentCommitted(['caller_not_authorized'], { quote: turn });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('Codex round-10 regression: "Yeah, but no." still poisons (explicit rejection must not launder through shared vocabulary)', () => {
    const turn = "We'll see you Sunday at noon. Yeah, but no.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 10, P1 (:1345): a conditional's ANTECEDENT can clear
  // clauseIsBenign (a benign-topic clause — "the email goes to you") while
  // its CONSEQUENT is itself a full, un-grounded booking commitment ("we'll
  // have you down") that names no SCHEDULING_PREDICATE_TERMS phrase.
  // sentenceHasSchedulingPredicate now also recognizes any of the pinned-
  // sentence binder's own COMMITMENT_HEADS templates anywhere in the
  // sentence as scheduling content.
  test('Codex round-10 regression: "If the email goes to you, we\'ll have you down." still poisons (consequent is itself a commitment head)', () => {
    const turn = "We'll see you Sunday at noon. If the email goes to you, we'll have you down.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Codex round 13 (review of b1cc43a04b): three P1s.
  // P1 (:1397) — a conditional's consequent is inspected on its own: an
  // agent-side future/commitment head + any verb poisons, whatever the verb.
  test.each([
    "If the email goes to you, we'll put you down. We'll see you Sunday at noon.",
    "We'll see you Sunday at noon. If the email goes to you, we'll put you down.",
    "If the email goes to you, I'll make sure that's rectified and we'll have you down. We'll see you Sunday at noon.",
  ])('Codex round-14 regression: a conditional consequent committing the agent poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "Yep, it should go to him, the notification. If it goes to you, I'll make sure that gets figured out. We'll see you Sunday at noon.",
    "Yep, it should go to him, the notification. It's autonomously done, so if it goes to you, I'll make sure that's rectified. We'll see you Sunday at noon.",
  ])('Codex round-14: a benign notification-remediation consequent still grounds — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // P1 (:1084) — "yes" (and "green light") are authorization nouns.
  test.each([
    "We need your yes. We'll see you Sunday at noon.",
    "We're waiting on your green light. We'll see you Sunday at noon.",
    "Just have to get a yes. We'll see you Sunday at noon.",
  ])('Codex round-14 regression: "yes"/"green light" as an approval noun poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test('Codex round-14: an opening "Yes," still grounds (not an approval noun)', () => {
    const turn = "Yes. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
  });

  // P1 (:1659) — a standalone period before (or after) a bare hour is
  // honored before any business-hours inference.
  test('Codex round-14 regression: "Sunday PM at 10" binds the 22:00 slot, not the inferred 10:00 one', () => {
    const turn = "We'll see you Sunday PM at 10.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const mk = (startAt) => {
      const ex = agentCommitted(['caller_not_authorized'], { quote: turn });
      ex.scheduling.confirmed_start_at = startAt;
      return ex;
    };
    const morning = canAutoRoute(mk('2026-08-02T10:00:00-04:00'), opts({ transcript }));
    expect(morning.allowed).toBe(false);
    expect(morning.appointmentBlockingFlags).toContain('caller_not_authorized');
    const evening = canAutoRoute(mk('2026-08-02T22:00:00-04:00'), opts({ transcript }));
    expect(evening.allowed).toBe(true);
    expect(evening.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test.each([
    ['We will see you Sunday pm at 10.', '2026-08-02T22:00:00-04:00', true],
    ['We will see you at 10 on Sunday pm.', '2026-08-02T22:00:00-04:00', true],
    ['We will see you at 10 on Sunday pm.', '2026-08-02T10:00:00-04:00', false],
    ["We will see you Sunday am at 1 o'clock.", '2026-08-02T01:00:00-04:00', true],
    ["We will see you Sunday am at 1 o'clock.", '2026-08-02T13:00:00-04:00', false],
    ['We will see you Sunday am at noon.', '2026-08-02T12:00:00-04:00', false],
    ['We will see you Sunday am at 10 pm.', '2026-08-02T22:00:00-04:00', false],
    ['We will see you Sunday am pm at 10.', '2026-08-02T10:00:00-04:00', false],
  ])('Codex round-14: standalone period binding — %s @ %s → %s', (sentence, startAt, expected) => {
    const ns = normalizeCommitmentText(sentence);
    expect(quoteBindsConfirmedSlot(ns, startAt, '2026-07-30T15:50:00-04:00')).toBe(expected);
  });

  // Codex round 14 (review of c0f0cd2a59): three P1s.
  // P1 (:1413) — a conditional's consequent is guilty unless it is a known-
  // benign anchored shape; present-tense and comma-less forms included.
  test.each([
    "If the email goes to you, then we are all set. We'll see you Sunday at noon.",
    "If the email goes to you, you're all booked. We'll see you Sunday at noon.",
    "If the email goes to you, it's all good. We'll see you Sunday at noon.",
    "If the email goes to you you're all set. We'll see you Sunday at noon.",
    "If the email goes to you then we are all set. We'll see you Sunday at noon.",
    "We are all set if the email goes to you. We'll see you Sunday at noon.",
  ])('Codex round-15 regression: any non-exempt conditional consequent poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "Yep, it should go to him, the notification. If it goes to you, I'll make sure that gets figured out. We'll see you Sunday at noon.",
    "Yep, it should go to him, the notification. It's autonomously done, so if it goes to you, I'll make sure that's rectified. We'll see you Sunday at noon.",
    "If the confirmation text goes to the wrong number, let me know. We'll see you Sunday at noon.",
  ])('Codex round-15: the anchored benign consequents still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // P1 (:1037) — a delegated decision poisons.
  test.each([
    "It's up to him. We'll see you Sunday at noon.",
    "That's on the owner. We'll see you Sunday at noon.",
    "It's all up to you guys. We'll see you Sunday at noon.",
    "Up to you. We'll see you Sunday at noon.",
    "He makes the call. We'll see you Sunday at noon.",
    "My boss has the final say. We'll see you Sunday at noon.",
  ])('Codex round-15 regression: a delegated decision poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // P1 (:1476) — modal uncertainty poisons; the month and the benign
  // notification-routing modals do not.
  test.each([
    "We'll see you Sunday at noon. We may get you in.",
    "We'll see you Sunday at noon. We might get you in.",
    "We'll see you Sunday at noon. I should be able to get you in.",
    "We'll see you Sunday at noon. You may be all set.",
    "We'll see you Sunday at noon. It may be all set.",
  ])('Codex round-15 regression: modal uncertainty poisons — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    "Yep, it may go to him, the notification. We'll see you Sunday at noon.",
    "You may get a text. We'll see you Sunday at noon.",
  ])('Codex round-15: benign notification-routing "may" still grounds — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // Codex round 15 (review of 64941712eb): four P1s.
  // P1 (:1377) — "May" named by a month-context word, no day number.
  // P1 (:1487) — a 3-4 digit number (year / run-together time).
  // P1 (:1537) — a dangling conditional antecedent split off its consequent.
  // P1 (:1192) — a modal coordinated onto a benign routing modal.
  test.each([
    "We'll see you Sunday at noon. We are set for May.",
    "We'll see you Sunday at noon. We are set in May.",
    "We'll see you Sunday at noon. We are set for 2027.",
    "We'll see you Sunday at noon. We're set for 1030.",
    "We'll see you Sunday at noon. We are set for 305.",
    "If the email goes to you. We're all set. We'll see you Sunday at noon.",
    "Yep, it should go to him, the notification. If it goes to you. We're all set. We'll see you Sunday at noon.",
    "It may go to him and may put you down. We'll see you Sunday at noon.",
    "It may go to him, may put you down. We'll see you Sunday at noon.",
  ])('Codex round-16 regression: month context, 4-digit numbers, dangling antecedents, and coordinated modals poison — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // SUPERSEDED in part by codex round 18 (reported, not silently reworded):
  // this list also asserted the bare "It may go to him." grounds. Round 18
  // showed a topic-less pronoun can route the approval decision itself
  // ("It should go to him." after "who has to okay it?"), so both routing
  // forms now require the notification/email/text to be named; the bare
  // form moved to the round-19 poison list above.
  test.each([
    "You may get a text. We'll see you Sunday at noon.",
    "If the confirmation text goes to the wrong number, let me know. We'll see you Sunday at noon.",
  ])('Codex round-16: benign modal routing and a conditional with its consequent still ground — %s', (turn) => {
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  // SUPERSEDED by codex round 5 (reported, not silently reworded — see PR
  // history). Round 3 reworded this test from "Adam works Sundays." (out-
  // of-vocabulary words) to "We come out Sunday afternoon." on the theory
  // that a non-conditional sentence merely MENTIONING the same weekday,
  // built entirely from ordinary vocabulary, should stay clean. Round 5
  // converged the whole design onto a single rule instead — OTHER sentences
  // may not talk about scheduling AT ALL, checked via SCHEDULING_PREDICATE_TERMS
  // (weekday names included) rather than vocabulary membership — so ANY
  // weekday mention in a non-pinned sentence now conservatively poisons,
  // regardless of how innocuous the rest of the sentence is. This is a
  // GENUINELY DIFFERENT intent from what round 3 was testing (that test
  // asserted the mention was SAFE; this one asserts the opposite, on
  // purpose), not a reword-to-pass — the round-3 test's premise (a benign
  // weekday mention can be told apart from a conditional one by vocabulary
  // alone) no longer holds under the round-5 design.
  test('Codex round-5: an adjacent sentence merely mentioning a weekday now poisons — scheduling talk is never allowed in an OTHER sentence', () => {
    const turn = "We come out Sunday afternoon. We'll see you Sunday at noon.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, turn);
    const r = canAutoRoute(agentCommitted(['caller_not_authorized'], { quote: "We'll see you Sunday at noon." }), opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  // Live miss 2026-09-24, call 17ed9362: a lender arranging a WDO inspection
  // for the homeowner (the point of contact) on behalf of the caller. The
  // model pinned the closing agent sentence — a third-party "see him", a
  // bare "o'clock", and an adjacent conditional about which inbox gets the
  // notification email — and the OLD grounding rejected all three;
  // hasAgentCommittedEvidence must now ground it. Shape only: every name,
  // address, phone and email in the live call is replaced with the same
  // kind of clearly-fictitious placeholder this file already uses elsewhere
  // (AGENTS.md "Customer PII in the repo" — no realistic identifying detail
  // in tests, even synthetic).
  //
  // Codex round 4, finding 2: an earlier draft of this test SPLIT the live
  // agent turn across two separate "Agent:" lines and reworded "It's
  // autonomously done ... I'll make sure that's rectified" down to "I'll
  // make sure that gets figured out" — both changes moved the notification-
  // routing sentence out of the SAME turn as the pinned commitment (so
  // otherSentenceIsClean never even ran on it) and swapped in easier
  // vocabulary, masking the actual gap this PR exists to fix. The live call
  // is genuinely ONE agent turn with several sentences; this test now uses
  // that exact turn, unsplit, with the real wording.
  test('hasAgentCommittedEvidence grounds a third-party "see him ... 10 o\'clock" commitment past a notification-routing conditional (live miss 17ed9362 shape, single unsplit turn)', () => {
    const transcript = [
      'Agent: Waves Pest Control, this is Adam.',
      'Caller: Hi, I handle refinances and need to set up a WDO inspection for a client.',
      'Agent: Sure — what area?',
      'Caller: 100 Example Street in Venice.',
      "Caller: Please make my client the point of contact so you can reach him with any appointment updates. I'll take the report and invoice.",
      "Agent: Awesome. Yep, it should go to him, the notification. It's autonomously done, so if it goes to you, I'll make sure that's rectified. But yeah, we'll see him on Monday at 10 o'clock.",
      "Caller: All right, perfect. I'll let him know. Thank you.",
      'Agent: Thank you. Bye.',
    ].join('\n');
    const extraction = {
      evidence: [{
        field_path: '/scheduling/agent_committed_booking',
        speaker: 'agent',
        quote: "we'll see him on Monday at 10 o'clock.",
      }],
      scheduling: { confirmed_start_at: '2026-09-28T10:00:00-04:00' }, // Monday
    };
    expect(hasAgentCommittedEvidence(extraction, transcript, '2026-09-24T17:50:00Z')).toBe(true);
  });

  // P1 coverage gap (local fallback auditor): AT_WEEKDAY_RE (the bare
  // "at N" path) shared no test with the "N o'clock" path above it.
  test('a bare "at N" immediately before the end of the sentence infers "am" from business hours and binds', () => {
    // No trailing benign closer here on purpose — "at 10, and just let us
    // know..." puts "and" right after the number, so it is no longer
    // immediately before the end of the sentence.
    const bareEnd = "So we'll see you Sunday at 10.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, bareEnd);
    const ex = agentCommitted(['caller_not_authorized'], { quote: bareEnd });
    ex.scheduling.confirmed_start_at = '2026-08-02T10:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['caller_not_authorized']));
  });

  test('a bare "at N" immediately before "on <weekday>" infers "pm" from business hours and binds', () => {
    const bareOnWeekday = "So we'll see you at 1 on Sunday, and just let us know if anything changes.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, bareOnWeekday);
    const ex = agentCommitted(['caller_not_authorized'], { quote: bareOnWeekday });
    ex.scheduling.confirmed_start_at = '2026-08-02T13:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(true);
  });

  test('the same bare "at N" does NOT bind a mismatched period — "at 10" never books a 10 PM slot', () => {
    const bareEnd = "So we'll see you Sunday at 10.";
    const transcript = TRANSCRIPT.replace(AGENT_COMMIT_QUOTE, bareEnd);
    const ex = agentCommitted(['caller_not_authorized'], { quote: bareEnd });
    ex.scheduling.confirmed_start_at = '2026-08-02T22:00:00-04:00';
    const r = canAutoRoute(ex, opts({ transcript }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
  });

  test.each([
    ["We'll see you Sunday at 10 o'clock p.", '2026-08-02T10:00:00-04:00'],
    ["We'll see you Sunday at 10 o'clock p.", '2026-08-02T22:00:00-04:00'],
    ["We'll see you Sunday at 10 a.", '2026-08-02T10:00:00-04:00'],
  ])('Codex round-18 regression: a lone period initial after the hour fails binding — %s @ %s', (sentence, slot) => {
    const ns = normalizeCommitmentText(sentence);
    expect(quoteBindsConfirmedSlot(ns, slot, '2026-07-30T15:50:00-04:00')).toBe(false);
  });

  test('Codex round-18: "10 o\'clock" with no initial still binds by business hours', () => {
    const ns = normalizeCommitmentText("We'll see you Sunday at 10 o'clock.");
    expect(quoteBindsConfirmedSlot(ns, '2026-08-02T10:00:00-04:00', '2026-07-30T15:50:00-04:00')).toBe(true);
  });

  // AT_WEEKDAY_RE false-positive guards, exercised directly against
  // quoteBindsConfirmedSlot (bypassing the closed-vocabulary/form gates,
  // which only ever admit "at <N>" glued right before the sentence end or
  // "on <weekday>" anyway — these pin the regex boundary itself: a number
  // followed by anything else, like an address, is never read as a time).
  test('AT_WEEKDAY_RE: "at N" followed by an unrelated trailing clause adds no time mention — does not bind', () => {
    const ns = normalizeCommitmentText('We will see you Sunday at 10 for the appointment.');
    expect(quoteBindsConfirmedSlot(ns, '2026-08-02T10:00:00-04:00', '2026-07-30T15:50:00-04:00')).toBe(false);
  });

  test('AT_WEEKDAY_RE: "at N" not glued to the sentence end or "on <weekday>" adds no second time mention — the real one still binds', () => {
    // "at 12 sharp" deliberately reuses the slot's own hour (12) so the
    // separate positional-numeric-shape guard (round 7j/7k, "every
    // standalone number must explain itself") does not also reject this for
    // an unrelated reason — this isolates AT_WEEKDAY_RE's own boundary: "at
    // 12" is followed by "sharp", not end-of-sentence or "on <weekday>", so
    // it must not add a conflicting second time mention alongside "noon".
    const ns = normalizeCommitmentText('We will see you Sunday at noon, and we open at 12 sharp.');
    expect(quoteBindsConfirmedSlot(ns, '2026-08-02T12:00:00-04:00', '2026-07-30T15:50:00-04:00')).toBe(true);
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
  const AV_OK = AV_CLEAN;

  // 2026-09-08 (call-agent audit): the flag no longer EXISTS for an unknown
  // relationship — isExplicitlyNonOwner gates derivation, and a model-
  // emitted copy is dropped before the merge — so nothing is demoted and no
  // advisory "confirm the account holder" card files for an ordinary
  // homeowner. What used to be backstopped by the demotion's guards is the
  // central address-trust gate's job, pinned below.
  test('unknown relationship never raises caller_not_authorized (no block, no advisory)', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.flags).not.toContain('caller_not_authorized');
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('absent caller block counts as unknown too', () => {
    const r = canAutoRoute(extraction(['caller_not_authorized']), { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.flags).not.toContain('caller_not_authorized');
  });

  test('spouse / partner is owner-equivalent', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'spouse_partner', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.flags).not.toContain('caller_not_authorized');
  });

  test('NO positive AV verdict → the CENTRAL address gate holds the call (codex round-3 P1)', () => {
    // With AV disabled/not_attempted, computeDeterministicTriageFlags raises
    // no address flag for a populated address — the address-trust gate, not
    // an incidental authorization flag, is what parks the dispatch.
    for (const av of [undefined, { status: 'not_attempted' }, { status: 'api_unavailable' },
      { status: 'validated_accept', inServiceArea: false }, { status: 'confirm_needed', inServiceArea: true }]) {
      const ex = extraction(['caller_not_authorized']);
      ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
      const r = canAutoRoute(ex, av ? { addressValidation: av } : {});
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags || []).not.toContain('caller_not_authorized');
      expect(['address_not_validated', 'triage_flags']).toContain(r.reason);
    }
  });

  test('a CORRECTED in-area verdict also satisfies the address gate', () => {
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

  test('the full live-miss shape still parks on the ADDRESS block (codex rounds 2-4)', () => {
    // The 2026-07-31 call carried both flags against an AV verdict of
    // missing_component. address_unverified means Google could not verify
    // the premise, so the call reaches the office — on the address alone.
    const ex = extraction(['no_sms_consent_captured', 'caller_not_authorized', 'address_unverified']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_UNVERIFIABLE });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('address_unverified');
    expect(r.appointmentBlockingFlags).not.toContain('caller_not_authorized');
    // The SMS-only flag never blocked and still doesn't.
    expect(r.appointmentBlockingFlags).not.toContain('no_sms_consent_captured');
  });

  test('a clean AV acceptance + unknown relationship books (the shape that SHOULD auto-route)', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags || []).not.toContain('caller_not_authorized');
  });

  test('OFF-HOUR confirmed start still parks an unknown-relationship call (windows start on the hour)', () => {
    // The booking path copies confirmed_start_at's wall clock into
    // window_start unchanged, so a :30 slot must never auto-create a
    // prohibited off-hour start (AGENTS.md owner rule). The central hour
    // gate parks it — no authorization flag is involved any more.
    for (const off of ['2026-07-11T09:30:00-04:00', '2026-07-11T09:00:30-04:00']) {
      const ex = extraction(['caller_not_authorized']);
      ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
      ex.scheduling.confirmed_start_at = off;
      const r = canAutoRoute(ex, { addressValidation: AV_OK });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('off_hour_start');
    }
  });

  test('a foreign offset that lands off-hour in ET still parks (wall clock, not raw minutes)', () => {
    // "+05:30" carries raw :00 minutes but books a :30 ET wall time — the
    // wall clock is what the booking writes.
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    ex.scheduling.confirmed_start_at = '2026-07-11T19:00:00+05:30';
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('off_hour_start');
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

  test('CENTRAL address gate: no positive AV verdict → no auto-route (codex round-4 P1)', () => {
    // With AV disabled/not_attempted the deterministic flags raise nothing for
    // a populated address, so the contract has to be stated directly:
    // AGENTS.md "auto-create only when ... the address validates".
    for (const av of [undefined, { status: 'not_attempted' }, { status: 'api_unavailable' },
      { status: 'validated_accept', inServiceArea: false }]) {
      const r = canAutoRoute(extraction([]), av ? { addressValidation: av } : {});
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('address_not_validated');
    }
  });

  test('CENTRAL address gate closes the advisory-flag paths too', () => {
    for (const flag of ['prior_complaint_unresolved', 'competing_quotes_active', 'brand_new_model_flag']) {
      const r = canAutoRoute(extraction([flag]), { addressValidation: { status: 'not_attempted' } });
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('address_not_validated');
    }
  });

  test('a known customer dispatching to their on-file address satisfies the address gate', () => {
    // On-file-address lane (the 2026-07-10 known-customer live case): no new
    // address stated, so the booking goes to the stored (already verified)
    // address — AV has nothing on THIS call to validate.
    const ex = extraction(['missing_service_address'], 0.9);
    ex.property = { service_address: {} };
    const r = canAutoRoute(ex, { failOpen: true, callerAni: '+19414651056', knownCustomer: { hasAddress: true } });
    expect(r.allowed).toBe(true);
  });

  test('address_not_validated files in the address-review lane', () => {
    const item = buildTriageItem({
      callLogId: 'c1',
      flag: 'address_not_validated',
      extraction: { meta: { call_summary: 'confirmed slot, address never validated' } },
    });
    expect(item.category).toBe('address_review');
  });

  test('a foreign offset that normalizes to an on-the-hour ET start is ALLOWED (codex round-4 P2)', () => {
    // 19:30+05:30 == 10:00 ET. The ET wall clock is what the booking writes,
    // so judging raw minutes parked valid hourly appointments.
    const ex = extraction([]);
    ex.scheduling.confirmed_start_at = '2026-07-11T19:30:00+05:30';
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(true);
  });

  test('nonzero SECONDS are still rejected (the ET wall clock carries none)', () => {
    const ex = extraction([]);
    ex.scheduling.confirmed_start_at = '2026-07-11T09:00:30-04:00';
    const r = canAutoRoute(ex, { addressValidation: AV_OK });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('off_hour_start');
  });

  test('an unconfirmed unknown-relationship call files NO authorization card (2026-09-08)', () => {
    // Before the audit fix this shape filed a blocking "confirm the account
    // holder" card on nearly every ordinary call (162 open in the backlog).
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'unknown', on_site_authorization: false };
    ex.scheduling = { status: 'tentative' };
    const r = canAutoRoute(ex, {});
    expect(r.allowed).toBe(false);
    const surfaced = [...(r.appointmentBlockingFlags || []), ...(r.failedOpenFlags || [])];
    expect(surfaced).not.toContain('caller_not_authorized');
  });

  test('an EXPLICIT third party without authorization still files the card when unconfirmed', () => {
    const ex = extraction(['caller_not_authorized']);
    ex.caller = { relationship_to_property: 'tenant', on_site_authorization: false };
    ex.scheduling = { status: 'tentative' };
    const r = canAutoRoute(ex, {});
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('caller_not_authorized');
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
    const r = canAutoRoute(extraction(['prior_complaint_unresolved']), { addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(true);
    expect(r.flags).toContain('prior_complaint_unresolved');
    expect(r.appointmentBlockingFlags || []).not.toContain('prior_complaint_unresolved');
  });

  test('a flag OUTSIDE every known set is advisory-by-default, never a silent block', () => {
    // New prompt vocabulary / model drift: unknown names ride failedOpenFlags
    // (card files, booking proceeds) instead of holding the appointment.
    const r = canAutoRoute(extraction(['brand_new_model_flag']), { addressValidation: AV_CLEAN });
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

describe('V2 decision version bookkeeping', () => {
  test('V2_DECISION_VERSIONS ends with the current V2_DECISION_VERSION and has no duplicates', () => {
    const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');
    expect(V2_DECISION_VERSIONS[V2_DECISION_VERSIONS.length - 1]).toBe(V2_DECISION_VERSION);
    expect(new Set(V2_DECISION_VERSIONS).size).toBe(V2_DECISION_VERSIONS.length);
  });
});
