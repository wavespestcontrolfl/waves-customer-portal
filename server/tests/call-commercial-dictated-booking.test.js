// Commercial dictated booking (owner ruling 2026-09-30, call-booker gates
// review item 8): a commercial job staff dictate on the call and the caller
// accepts — with a price agreed and grounded — books instead of always going
// to the office. INBOUND only for now (the processor gates it; outbound
// speaker labels have swapped) and behind GATE_CALL_AGENT_COMMIT_BOOKING too.
// Grounded with the reschedule module's checks (call-reschedule-agreement.js,
// groundRescheduleAgreement itself unchanged): both quotes word for word in a
// turn of the right speaker. Fixtures are synthetic.
const fs = require('fs');
const path = require('path');
const { canAutoRoute } = require('../services/call-triage-flags');
const { commercialDictatedBookingGrounded } = require('../services/call-commercial-dictated-booking');
const { groundRescheduleAgreement } = require('../services/call-reschedule-agreement');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
// Wed Sep 23, 2026, 3 PM ET; the agreed slot is Thursday 2 PM.
const CALL_STARTED_AT = '2026-09-23T19:00:00Z';
const THURSDAY_2PM = '2026-09-24T14:00:00-04:00';
const PRICE_TALK = 'The quarterly service for the office is $150, does that work?';
const PRICE_QUOTE = 'The quarterly service for the office is $150';
const PRICE_OK = 'Yes, that price works for us.';
const COMMIT = 'We will see you Thursday at two in the afternoon.';
const ACCEPT = 'Yes, Thursday at two works for us.';
const WORDS = { day: 'Thursday', hour: 'two', period: 'in the afternoon' };
const OPENING = 'Caller: Hi, I manage a small office and need pest control.';
const PRICE_LINES = [`Agent: ${PRICE_TALK}`, `Caller: ${PRICE_OK}`];
const transcriptOf = (...lines) => [OPENING, ...PRICE_LINES, ...lines].join('\n');
const TRANSCRIPT = transcriptOf(`Agent: ${COMMIT}`, `Caller: ${ACCEPT}`);

const quote = (fieldPath, speaker, text) => ({ field_path: fieldPath, speaker, quote: text });
const PRICE_EVIDENCE = [
  quote('/service_request/quoted_price_usd', 'agent', PRICE_QUOTE),
  quote('/service_request/quoted_price_usd', 'caller', PRICE_OK),
];
const SCHEDULE_EVIDENCE = [
  quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
  quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
  quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
];
function extraction({
  flags = ['commercial_requires_quote'], scheduling = {}, evidence = SCHEDULE_EVIDENCE, priceEvidence = PRICE_EVIDENCE, service = {},
} = {}) {
  return {
    triage_flags: flags,
    confidence: { overall: 0.9 },
    consent: {},
    caller: { relationship_to_property: 'owner', on_site_authorization: true },
    scheduling: {
      status: 'confirmed', confirmed_start_at: THURSDAY_2PM,
      agent_committed_booking: true, caller_accepted_slot: true,
      definite_commitment: true, relative_date_used: false, moved_appointment_relative_date_used: null,
      agreed_slot_words: WORDS,
      ...scheduling,
    },
    service_request: { quoted_price_usd: 150, ...service },
    evidence: [...evidence, ...priceEvidence],
  };
}
// The processor's options for a gate-ON inbound call.
const opts = (extra = {}) => ({
  commercialDictatedBooking: true, transcriptLabelsTrusted: true,
  transcript: TRANSCRIPT, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN,
  ...extra,
});
const route = (ex, extra) => canAutoRoute(ex, opts(extra));
const grounded = (ex, transcript = TRANSCRIPT) => commercialDictatedBookingGrounded({ v2: ex, transcript, callStartedAt: CALL_STARTED_AT });

// "Sure, that works." shapes.
const SURE = 'Sure, that works.';
const acceptShape = (acceptQuote, lines) => extraction({
  evidence: [
    quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
    quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
    quote('/scheduling/caller_accepted_slot', 'caller', acceptQuote),
  ],
}) && { ex: extraction({
  evidence: [
    quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
    quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
    quote('/scheduling/caller_accepted_slot', 'caller', acceptQuote),
  ],
}), transcript: transcriptOf(...lines) };
// Caller proposes, staff replies.
const PROPOSAL = 'Can you come Thursday at 2?';
const PROPOSAL_WORDS = { day: 'Thursday', hour: '2', period: null };
const proposalCase = ({ proposalText = PROPOSAL, replyText = SURE, between = [], evidence, words = PROPOSAL_WORDS, quoteText = proposalText.replace(/\?.*$/, '') } = {}) => ({
  ex: extraction({
    scheduling: { agreed_slot_words: words },
    evidence: evidence || [
      quote('/scheduling/agent_committed_booking', 'agent', SURE),
      quote('/scheduling/confirmed_start_at', 'caller', quoteText),
      quote('/scheduling/caller_accepted_slot', 'caller', quoteText),
    ],
  }),
  transcript: transcriptOf('Agent: When would you like us to come out?', `Caller: ${proposalText}`, ...between, `Agent: ${replyText}`),
});
// Day said earlier, final time turn omits it.
const dayOmittedCase = ({ dayLine = 'Caller: Thursday works.', dayLines = [dayLine] } = {}) => ({
  ex: extraction({
    scheduling: { agreed_slot_words: { day: null, hour: 'two', period: null } },
    evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'We will see you at two'),
      quote('/scheduling/confirmed_start_at', 'agent', 'We will see you at two'),
      quote('/scheduling/caller_accepted_slot', 'caller', SURE),
    ],
  }),
  transcript: transcriptOf('Agent: When works for you?', ...dayLines, 'Agent: We will see you at two.', `Caller: ${SURE}`),
});

describe('commercial dictated booking: canAutoRoute', () => {
  test('both quotes grounded + price agreed clears commercial_requires_quote and books (advisory card rides failedOpenFlags)', () => {
    const r = route(extraction());
    expect(r.allowed).toBe(true);
    expect(r.appointmentBlockingFlags || []).not.toContain('commercial_requires_quote');
    expect(r.failedOpenFlags).toEqual(['commercial_requires_quote']);
  });

  test('inbound only: the processor passes the option behind !isOutboundCall AND the agent-commit gate at both call sites', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const sites = [...src.matchAll(/commercialDictatedBooking: ([^,]*),/gs)].map((m) => m[1]);
    expect(sites).toHaveLength(2);
    sites.forEach((expr) => {
      expect(expr).toContain("isEnabled('callAgentCommitBooking')");
      expect(expr).toContain('!isOutboundCall(call)');
      expect(expr).toContain('callCommercialDictatedBookingLive');
    });
  });

  test('gate off (option absent or false) is the old behavior: the hold stays', () => {
    const { commercialDictatedBooking: _on, ...off } = opts();
    for (const o of [off, { ...off, commercialDictatedBooking: false }, { ...off, commercialDictatedBooking: 'true' }]) {
      const r = canAutoRoute(extraction(), o);
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
    }
  });

  test('the agent quote alone does not clear it (no caller acceptance)', () => {
    expect(route(extraction({ scheduling: { caller_accepted_slot: false } })).allowed).toBe(false);
    const r = route(extraction({ evidence: SCHEDULE_EVIDENCE.filter((e) => e.field_path !== '/scheduling/caller_accepted_slot') }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
  });

  test('the caller acceptance alone does not clear it (no staff commitment)', () => {
    expect(route(extraction({ scheduling: { agent_committed_booking: false } })).allowed).toBe(false);
    expect(route(extraction({ evidence: SCHEDULE_EVIDENCE.filter((e) => e.field_path !== '/scheduling/agent_committed_booking') })).allowed).toBe(false);
  });

  test('a quote found only in the OTHER speaker\'s turn fails closed (swapped speaker labels)', () => {
    const swapped = TRANSCRIPT.replace(/^Caller:/gm, 'X:').replace(/^Agent:/gm, 'Caller:').replace(/^X:/gm, 'Agent:');
    expect(route(extraction(), { transcript: swapped }).allowed).toBe(false);
    expect(route(extraction(), { transcript: TRANSCRIPT.replace(`Agent: ${COMMIT}`, `Caller: ${COMMIT}`) }).allowed).toBe(false);
    expect(route(extraction(), { transcript: TRANSCRIPT.replace(`Caller: ${ACCEPT}`, `Agent: ${ACCEPT}`) }).allowed).toBe(false);
    const misattributed = extraction({ evidence: [
      quote('/scheduling/agent_committed_booking', 'caller', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'agent', ACCEPT),
    ] });
    expect(route(misattributed).allowed).toBe(false);
  });

  test('an unlabeled or one-speaker transcript fails closed', () => {
    expect(route(extraction(), { transcript: TRANSCRIPT.replace(`Agent: ${COMMIT}`, COMMIT) }).allowed).toBe(false);
    expect(route(extraction(), { transcript: undefined }).allowed).toBe(false);
    expect(route(extraction(), { transcript: '' }).allowed).toBe(false);
    expect(route(extraction(), { transcript: `Agent: ${COMMIT}\nAgent: ${ACCEPT}` }).allowed).toBe(false);
  });

  test('a fabricated quote that is not in the transcript fails closed', () => {
    const ex = extraction({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at two in the afternoon, guaranteed.'),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ] });
    expect(route(ex).allowed).toBe(false);
  });

  test('no price agreed on the call still goes to the office', () => {
    for (const service of [{ quoted_price_usd: null }, { quoted_price_usd: undefined }]) {
      const r = route(extraction({ service }));
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
    }
    const declined = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 150, accepted: false, caller_response: 'declined' } } });
    expect(route(declined).allowed).toBe(false);
    const range = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 100, amount_max_usd: 150, accepted: true, caller_response: 'accepted' } } });
    expect(route(range).allowed).toBe(false);
  });

  test('needs the trusted-labels gate, a confirmed start and an on-the-hour start', () => {
    expect(route(extraction(), { transcriptLabelsTrusted: false }).allowed).toBe(false);
    expect(route(extraction({ scheduling: { status: 'tentative' } })).allowed).toBe(false);
    const r = route(extraction({ scheduling: { confirmed_start_at: '2026-09-24T14:30:00-04:00' } }));
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
  });

  test('the extraction\'s language judgements still apply (hedged promise, unjudged relative date)', () => {
    expect(route(extraction({ scheduling: { definite_commitment: false } })).allowed).toBe(false);
    expect(route(extraction({ scheduling: { definite_commitment: null } })).allowed).toBe(false);
    expect(route(extraction({ scheduling: { relative_date_used: null } })).allowed).toBe(false);
  });

  test('it only clears the commercial hold: every other hold and check still applies', () => {
    const spam = route(extraction({ flags: ['commercial_requires_quote', 'spam_or_wrong_number'] }));
    expect(spam.allowed).toBe(false);
    expect(spam.appointmentBlockingFlags).toEqual(['spam_or_wrong_number']);
    const third = extraction({ flags: ['commercial_requires_quote', 'caller_not_authorized'] });
    third.caller = { relationship_to_property: 'tenant', on_site_authorization: false };
    const t = route(third);
    expect(t.allowed).toBe(false);
    expect(t.appointmentBlockingFlags).toEqual(['caller_not_authorized']);
    expect(route(extraction({ flags: ['hoa_common_area_requires_approval'] })).allowed).toBe(false);
    const noAv = canAutoRoute(extraction(), opts({ addressValidation: undefined }));
    expect(noAv.allowed).toBe(false);
    expect(noAv.reason).toBe('address_not_validated');
    const low = extraction();
    low.confidence = { overall: 0 };
    expect(route(low).reason).toBe('low_confidence');
  });

  test('a non-commercial call is unaffected either way', () => {
    expect(route(extraction({ flags: [] })).allowed).toBe(true);
    expect(route(extraction({ flags: [] })).failedOpenFlags).toBeUndefined();
    expect(route(extraction({ flags: [], evidence: [], priceEvidence: [] })).allowed).toBe(true);
    expect(route(extraction({ flags: ['spam_or_wrong_number'] })).allowed).toBe(false);
  });

  test('the old agent-commit path is untouched: the new option never clears caller_not_authorized', () => {
    const ex = extraction({ flags: ['caller_not_authorized'] });
    ex.caller = { relationship_to_property: 'tenant', on_site_authorization: false };
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(['caller_not_authorized']);
  });
});

describe('the price must be agreed AND grounded in the transcript', () => {
  test('a price the extraction invented (no price talk in the transcript) fails closed', () => {
    const t = ['Caller: Hi, I manage a small office.', 'Agent: Okay.', `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    expect(grounded(extraction(), t)).toEqual({ ok: false, reason: 'price_not_stated_by_staff' });
    expect(route(extraction(), { transcript: t }).allowed).toBe(false);
  });

  test('staff stated a different amount than the one recorded', () => {
    const t = TRANSCRIPT.replace('$150', '$120');
    expect(grounded(extraction(), t).ok).toBe(false);
    // Two different figures in the staff turn are ambiguous.
    const two = TRANSCRIPT.replace('$150, does', '$150 or $120, does');
    expect(grounded(extraction(), two).ok).toBe(false);
  });

  test('the caller must accept it: the first caller turn after the price is the affirmative reply', () => {
    const t = [OPENING, `Agent: ${PRICE_TALK}`, 'Caller: What does that include?', `Caller: ${PRICE_OK}`, `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    expect(grounded(extraction(), t)).toEqual({ ok: false, reason: 'price_not_accepted_by_caller' });
    const declined = TRANSCRIPT.replace(PRICE_OK, 'No, that is too much for us.');
    expect(grounded(extraction({ priceEvidence: [PRICE_EVIDENCE[0], quote('/service_request/quoted_price_usd', 'caller', 'No, that is too much for us.')] }), declined).ok).toBe(false);
  });

  test('the price quotes must sit in the right speaker\'s turns', () => {
    expect(grounded(extraction({ priceEvidence: [] })).reason).toBe('price_not_stated_by_staff');
    expect(grounded(extraction({ priceEvidence: [quote('/service_request/quoted_price_usd', 'caller', PRICE_QUOTE), PRICE_EVIDENCE[1]] })).reason).toBe('price_not_stated_by_staff');
    expect(grounded(extraction({ priceEvidence: [PRICE_EVIDENCE[0], quote('/service_request/quoted_price_usd', 'agent', PRICE_OK)] })).reason).toBe('price_not_accepted_by_caller');
  });

  test('an accepted price entry without quoted_price_usd is not enough: booking stamps only the accepted total', () => {
    const entry = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 150, accepted: true, caller_response: 'accepted', unit: 'per_quarter' } } });
    expect(grounded(entry)).toEqual({ ok: false, reason: 'no_quoted_total' });
    expect(route(entry).allowed).toBe(false);
  });
});

describe('"Sure, that works." (owner ruling 2026-09-30)', () => {
  test('the caller\'s "Sure, that works." / "Sure." / "That works." right after staff\'s commitment is the acceptance', () => {
    for (const accept of [SURE, 'Sure.', 'That works.', 'Okay, sounds good, thank you.']) {
      const { ex, transcript } = acceptShape(accept, [`Agent: ${COMMIT}`, `Caller: ${accept}`]);
      expect([accept, grounded(ex, transcript)]).toEqual([accept, expect.objectContaining({ ok: true, mode: 'staff_stated' })]);
      expect(route(ex, { transcript }).allowed).toBe(true);
    }
  });

  test('...but not when it is not the reply to staff\'s commitment, is hedged, or is a longer non-slot reply', () => {
    // Not directly after the commitment turn.
    const late = acceptShape(SURE, [`Agent: ${COMMIT}`, 'Agent: Anything else?', `Caller: ${SURE}`]);
    expect(grounded(late.ex, late.transcript)).toEqual({ ok: false, reason: 'caller_acceptance_not_of_the_slot' });
    const wrongPlace = acceptShape('Yes, that price works for us.', [`Agent: ${COMMIT}`, 'Caller: Thanks, bye.']);
    expect(grounded(wrongPlace.ex, wrongPlace.transcript).ok).toBe(false);
    // Hedged / conditional.
    const cond = acceptShape(SURE, [`Agent: ${COMMIT}`, 'Caller: Sure, that works if my partner agrees.']);
    expect(grounded(cond.ex, cond.transcript).ok).toBe(false);
    const hedged = acceptShape(SURE, [`Agent: ${COMMIT}`, 'Caller: Sure, that works, maybe.']);
    expect(grounded(hedged.ex, hedged.transcript).ok).toBe(false);
    // A longer reply that never restates the hour.
    const longer = acceptShape('Sure, thank you for calling us back today.', [`Agent: ${COMMIT}`, 'Caller: Sure, thank you for calling us back today.']);
    expect(grounded(longer.ex, longer.transcript)).toEqual({ ok: false, reason: 'caller_acceptance_not_of_the_slot' });
  });

  test('a caller acceptance that restates the hour must state THIS slot (codex #5377 r1 pre-push P1)', () => {
    const restate = (acceptText, lines = [`Agent: ${COMMIT}`, `Caller: ${acceptText}`]) => {
      const c = acceptShape(acceptText, lines);
      return grounded(c.ex, c.transcript);
    };
    expect(restate('Yes, at two in the afternoon works for us.').ok).toBe(true);
    expect(restate('Yes, Thursday at two in the afternoon works for us.').ok).toBe(true);
    // A quote cut from a sentence that says the minutes (the pre-push reproduction).
    const cut = acceptShape('Yes, Thursday at two', [`Agent: ${COMMIT}`, 'Caller: Yes, Thursday at two thirty works for us.']);
    expect(grounded(cut.ex, cut.transcript).ok).toBe(false);
    const bound = acceptShape('Yes, Thursday by two', [`Agent: ${COMMIT}`, 'Caller: Yes, Thursday by two works for us.']);
    expect(grounded(bound.ex, bound.transcript).ok).toBe(false);
    expect(restate('Yes, two in the morning works for us.').ok).toBe(false);
    expect(restate('Yes, Thursday at two thirty works for us.').ok).toBe(false);
    expect(restate('Yes, Friday at two works for us.').ok).toBe(false);
    expect(restate('Yes, Thursday the 25th at two works for us.').ok).toBe(false);
    expect(restate('Yes, two or three works for us.').ok).toBe(false);
    // The day-omitted booking (the reproduction): earlier Thursday, final turns only give the hour.
    const c = dayOmittedCase();
    c.ex.scheduling.agreed_slot_words = { day: null, hour: 'two', period: 'in the afternoon' };
    c.transcript = c.transcript.replace('We will see you at two.', 'We will see you at two in the afternoon.').replace(`Caller: ${SURE}`, 'Caller: Yes, two in the morning works for us.');
    c.ex.evidence = c.ex.evidence.map((e) => (e.field_path === '/scheduling/caller_accepted_slot' ? { ...e, quote: 'Yes, two in the morning works for us' } : { ...e, quote: e.quote === 'We will see you at two' ? 'We will see you at two in the afternoon' : e.quote }));
    expect(grounded(c.ex, c.transcript).ok).toBe(false);
    c.transcript = c.transcript.replace('two in the morning', 'at two in the afternoon');
    c.ex.evidence = c.ex.evidence.map((e) => (e.field_path === '/scheduling/caller_accepted_slot' ? { ...e, quote: 'Yes, at two in the afternoon works for us' } : e));
    expect(grounded(c.ex, c.transcript)).toMatchObject({ ok: true });
  });

  test('staff\'s "Sure, that works." directly after the caller\'s exact day-and-hour proposal is the commitment', () => {
    const { ex, transcript } = proposalCase();
    expect(grounded(ex, transcript)).toMatchObject({ ok: true, mode: 'caller_proposed' });
    const r = route(ex, { transcript });
    expect(r.allowed).toBe(true);
    expect(r.failedOpenFlags).toEqual(['commercial_requires_quote']);
    // With a stated period.
    const pm = proposalCase({
      proposalText: 'Can you come Thursday at 2 pm?', quoteText: 'Can you come Thursday at 2 pm',
      words: { day: 'Thursday', hour: '2', period: 'pm' },
    });
    expect(grounded(pm.ex, pm.transcript).ok).toBe(true);
    // Other polite forms of the same yes.
    for (const yes of ['Yes, sounds good.', 'Okay, that will work.', 'Sure, we can do that.']) {
      const c = proposalCase({ replyText: yes, evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', yes),
        quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
        quote('/scheduling/caller_accepted_slot', 'caller', 'Can you come Thursday at 2'),
      ] });
      expect(grounded(c.ex, c.transcript).ok).toBe(true);
    }
  });

  test('the proposal path fails closed on everything else', () => {
    const reason = (c) => grounded(c.ex, c.transcript);
    // The reply is not immediately after the proposal.
    expect(reason(proposalCase({ between: ['Agent: Let me pull up the calendar.', 'Caller: Okay.'] })).ok).toBe(false);
    // The caller's turn is vague, or offers alternatives, or holds another hour.
    expect(reason(proposalCase({ proposalText: 'Can you come sometime Thursday?', quoteText: 'Can you come sometime Thursday' })).ok).toBe(false);
    expect(reason(proposalCase({ proposalText: 'Can you come Thursday at 2 or Friday at 3?', quoteText: 'Can you come Thursday at 2' })).ok).toBe(false);
    expect(reason(proposalCase({ proposalText: 'Can you come Thursday at 2? I get off at 4.', quoteText: 'Can you come Thursday at 2' })).ok).toBe(false);
    expect(reason(proposalCase({ proposalText: 'Can you come around Thursday at 2?', quoteText: 'Can you come around Thursday at 2' })).ok).toBe(false);
    expect(reason(proposalCase({ proposalText: 'Can you come Thursday at 2:30?', quoteText: 'Can you come Thursday at 2:30' })).ok).toBe(false);
    // The reply hedges, conditions, or changes the time.
    expect(reason(proposalCase({ replyText: 'Sure, that works if the tech is free.' })).ok).toBe(false);
    expect(reason(proposalCase({ replyText: 'Sure, that might work.', evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'Sure, that might work'),
      quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Can you come Thursday at 2'),
    ] })).ok).toBe(false);
    expect(reason(proposalCase({ replyText: 'Sure, that works. Actually, make it 3.' })).ok).toBe(false);
    expect(reason(proposalCase({ replyText: 'No, that does not work.', evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'that does not work'),
      quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Can you come Thursday at 2'),
    ] })).ok).toBe(false);
    // A bare "Sure." from staff, and a question, are not commitments.
    expect(reason(proposalCase({ replyText: 'Sure.', evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'Sure.'),
      quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Can you come Thursday at 2'),
    ] })).ok).toBe(false);
    // The reply is in a CALLER turn (swapped labels), or the proposal is in a staff turn.
    const swapped = proposalCase();
    expect(grounded(swapped.ex, swapped.transcript.replace(`Agent: ${SURE}`, `Caller: ${SURE}`)).ok).toBe(false);
    const staffProposal = proposalCase();
    expect(grounded(staffProposal.ex, staffProposal.transcript.replace(`Caller: ${PROPOSAL}`, `Agent: ${PROPOSAL}`)).ok).toBe(false);
    // The proposal is not pinned as the caller's acceptance.
    const noAccept = proposalCase({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', SURE),
      quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
      quote('/scheduling/caller_accepted_slot', 'caller', SURE),
    ] });
    expect(reason(noAccept).ok).toBe(false);
    // The recorded slot is not the one proposed.
    const wrongHour = proposalCase();
    wrongHour.ex.scheduling.confirmed_start_at = '2026-09-24T15:00:00-04:00';
    expect(reason(wrongHour).ok).toBe(false);
  });

  test('groundRescheduleAgreement is NOT loosened: a bare "Sure, that works." still is not a commitment for a move', () => {
    const { ex, transcript } = proposalCase();
    ex.scheduling.status = 'reschedule_requested';
    const r = groundRescheduleAgreement({ v2: ex, transcript, callStartedAt: CALL_STARTED_AT });
    expect(r.ok).toBe(false);
  });
});

describe('a new booking whose final time turn omits the day', () => {
  test('the closest earlier day turn binds it', () => {
    const { ex, transcript } = dayOmittedCase();
    expect(grounded(ex, transcript)).toMatchObject({ ok: true, mode: 'staff_stated' });
    expect(route(ex, { transcript }).allowed).toBe(true);
  });

  test('a full calendar date is one date, not its fragments (codex #5377 pre-push P1)', () => {
    // Call Wed Sep 23: Sat Oct 24 2026.
    const saturday = (dayLine) => {
      const c = dayOmittedCase({ dayLine });
      c.ex.scheduling.confirmed_start_at = '2026-10-24T14:00:00-04:00';
      return grounded(c.ex, c.transcript);
    };
    expect(saturday('Caller: October 24th works.').ok).toBe(true);
    expect(saturday('Caller: Saturday October 24 works.').ok).toBe(true);
    expect(saturday('Caller: Saturday works.').ok).toBe(false); // the nearest Saturday is Sep 26, not Oct 24
    expect(saturday('Caller: Saturday October 25 works.').ok).toBe(false); // Oct 25 is a Sunday
    expect(saturday('Caller: October 25th works.').ok).toBe(false);
  });

  test('fails closed when the earlier day is missing, another date, several, relative or hedged', () => {
    const notOk = (c) => expect(grounded(c.ex, c.transcript).ok).toBe(false);
    notOk(dayOmittedCase({ dayLine: 'Caller: Friday works.' }));
    notOk(dayOmittedCase({ dayLine: 'Caller: Thursday or Friday works.' }));
    notOk(dayOmittedCase({ dayLine: 'Caller: Next Thursday works.' }));
    notOk(dayOmittedCase({ dayLine: 'Caller: Thursday might work.' }));
    notOk(dayOmittedCase({ dayLine: 'Caller: Any day works.' }));
    // A later day turn overrides an earlier one: the closest names Friday.
    notOk(dayOmittedCase({ dayLines: ['Caller: Thursday works.', 'Agent: Or Friday?', 'Caller: Friday works.'] }));
    // The relative-date flag with a day omitted never binds.
    const rel = dayOmittedCase();
    rel.ex.scheduling.relative_date_used = true;
    notOk(rel);
  });

  test('the commitment itself may not name another day', () => {
    const c = dayOmittedCase();
    c.transcript = c.transcript.replace('We will see you at two.', 'We will see you Friday at two.');
    expect(grounded(c.ex, c.transcript).ok).toBe(false);
  });
});

describe('commercialDictatedBookingGrounded', () => {
  test('grounds a confirmed new booking with a price agreed', () => {
    expect(grounded(extraction())).toEqual({ ok: true, reason: 'dictated_booking_grounded', mode: 'staff_stated' });
  });

  test('reports why it failed', () => {
    expect(grounded(extraction({ service: { quoted_price_usd: null } }))).toEqual({ ok: false, reason: 'no_price_agreed' });
    expect(grounded(extraction({ scheduling: { status: 'reschedule_requested' } }))).toEqual({ ok: false, reason: 'not_confirmed' });
    expect(grounded(extraction({ scheduling: { moved_appointment_date: '2026-09-25' } }))).toEqual({ ok: false, reason: 'moves_existing_visit' });
    expect(grounded(extraction({ evidence: [] }))).toEqual({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(grounded(extraction({ evidence: SCHEDULE_EVIDENCE.filter((e) => e.field_path !== '/scheduling/caller_accepted_slot') })))
      .toEqual({ ok: false, reason: 'caller_acceptance_ungrounded' });
    expect(grounded(undefined)).toEqual({ ok: false, reason: 'no_scheduling' });
  });
});

describe('callCommercialDictatedBookingLive (GATE_CALL_COMMERCIAL_DICTATED_BOOKING)', () => {
  const gates = require('../config/feature-gates');
  const saved = process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING;
    else process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING = saved;
  });

  test('strict === \'true\', read at call time, dark by default', () => {
    delete process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING;
    expect(gates.callCommercialDictatedBookingLive()).toBe(false);
    for (const v of ['TRUE', '1', 'yes', 'on', ' true', '']) {
      process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING = v;
      expect(gates.callCommercialDictatedBookingLive()).toBe(false);
    }
    process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING = 'true';
    expect(gates.callCommercialDictatedBookingLive()).toBe(true);
  });
});
