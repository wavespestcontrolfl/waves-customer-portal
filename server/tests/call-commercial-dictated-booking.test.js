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
  quote('/service_request/price_offered_by_staff', 'agent', PRICE_QUOTE),
  quote('/service_request/price_accepted_by_caller', 'caller', PRICE_OK),
];
// The extraction's judgements of the price language (schema 1.21.0).
const PRICE_JUDGEMENTS = { price_offered_by_staff: true, price_accepted_by_caller: true, price_is_final: true };
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
    service_request: { quoted_price_usd: 150, ...PRICE_JUDGEMENTS, ...service },
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
const acceptShape = (acceptQuote, lines) => ({ ex: extraction({
  evidence: [
    quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
    quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
    quote('/scheduling/caller_accepted_slot', 'caller', acceptQuote),
  ],
}), transcript: transcriptOf(...lines) });
// Caller proposes, staff replies.
const PROPOSAL = 'Can you come Thursday at 2?';
const PROPOSAL_WORDS = { day: 'Thursday', hour: '2', period: null };
const proposalCase = ({ proposalText = PROPOSAL, replyText = SURE, between = [], evidence, words = PROPOSAL_WORDS, quoteText = proposalText.replace(/\?.*$/, ''), judged = true } = {}) => ({
  ex: extraction({
    scheduling: { agreed_slot_words: words, staff_accepted_proposed_slot: judged },
    evidence: evidence || [
      quote('/scheduling/agent_committed_booking', 'agent', replyText),
      quote('/scheduling/staff_accepted_proposed_slot', 'agent', replyText),
      quote('/scheduling/confirmed_start_at', 'caller', quoteText),
      quote('/scheduling/caller_accepted_slot', 'caller', quoteText),
    ],
  }),
  transcript: transcriptOf('Agent: When would you like us to come out?', `Caller: ${proposalText}`, ...between, `Agent: ${replyText}`),
});
// Day said earlier, final time turn omits it.
const dayOmittedCase = ({ dayLine = 'Caller: Thursday works.', dayLines = [dayLine], selected = 'Thursday', selectedQuote = 'Thursday works', selectedSpeaker = 'caller' } = {}) => ({
  ex: extraction({
    scheduling: { agreed_slot_words: { day: null, hour: 'two', period: null }, selected_day_words: selected },
    evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'We will see you at two'),
      quote('/scheduling/confirmed_start_at', 'agent', 'We will see you at two'),
      quote('/scheduling/caller_accepted_slot', 'caller', SURE),
      ...(selectedQuote ? [quote('/scheduling/selected_day_words', selectedSpeaker, selectedQuote)] : []),
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

describe('the price: the extraction judges it, the code verifies the pinned quotes (schema 1.21.0)', () => {
  test('each judgement must be true; a missing or false one fails closed', () => {
    const cases = [
      ['price_offered_by_staff', 'price_offer_unjudged'],
      ['price_accepted_by_caller', 'price_acceptance_unjudged'],
      ['price_is_final', 'price_not_final'],
    ];
    for (const [field, reason] of cases) {
      for (const value of [false, null, undefined]) {
        const ex = extraction({ service: { [field]: value } });
        expect([field, value, grounded(ex)]).toEqual([field, value, { ok: false, reason }]);
        expect(route(ex).allowed).toBe(false);
      }
    }
  });

  test('a price the extraction invented (no price talk in the transcript) fails closed', () => {
    const t = ['Caller: Hi, I manage a small office.', 'Agent: Okay.', `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    expect(grounded(extraction(), t)).toEqual({ ok: false, reason: 'price_not_stated_by_staff' });
    expect(route(extraction(), { transcript: t }).allowed).toBe(false);
  });

  test('a price offer that is a question about someone else\'s quote is judged false (offer unjudged)', () => {
    const t = TRANSCRIPT.replace(PRICE_TALK, 'Did another company quote you $150?');
    const ex = extraction({ service: { price_offered_by_staff: false }, priceEvidence: [quote('/service_request/price_offered_by_staff', 'agent', 'another company quote you $150'), PRICE_EVIDENCE[1]] });
    expect(grounded(ex, t)).toEqual({ ok: false, reason: 'price_offer_unjudged' });
  });

  test('the offer quote must state exactly the recorded amount, and no other figure in its turn', () => {
    expect(grounded(extraction(), TRANSCRIPT.replace('$150', '$120')).ok).toBe(false);
    expect(grounded(extraction(), TRANSCRIPT.replace('$150, does', '$150 or $120, does')).ok).toBe(false);
    const noFigure = extraction({ priceEvidence: [quote('/service_request/price_offered_by_staff', 'agent', 'The quarterly service for the office'), PRICE_EVIDENCE[1]] });
    expect(grounded(noFigure).reason).toBe('price_not_stated_by_staff');
  });

  test('the acceptance must come after the offer, in a caller turn', () => {
    const before = [OPENING, `Caller: ${PRICE_OK}`, `Agent: ${PRICE_TALK}`, `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    expect(grounded(extraction(), before)).toEqual({ ok: false, reason: 'price_not_accepted_by_caller' });
    expect(grounded(extraction({ priceEvidence: [PRICE_EVIDENCE[0], quote('/service_request/price_accepted_by_caller', 'agent', PRICE_OK)] })).reason).toBe('price_not_accepted_by_caller');
    expect(grounded(extraction({ priceEvidence: [] })).reason).toBe('price_not_stated_by_staff');
    expect(grounded(extraction({ priceEvidence: [quote('/service_request/price_offered_by_staff', 'caller', PRICE_QUOTE), PRICE_EVIDENCE[1]] })).reason).toBe('price_not_stated_by_staff');
  });

  test('a staff correction between the offer and the "yes" does not attach the "yes" to the old price', () => {
    const t = [OPENING, `Agent: ${PRICE_TALK}`, 'Agent: Actually, correction, the service is $250.', `Caller: ${PRICE_OK}`, `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    expect(grounded(extraction(), t)).toEqual({ ok: false, reason: 'price_not_accepted_by_caller' });
    // ...and the extraction judges a corrected price not final.
    expect(grounded(extraction({ service: { price_is_final: false } }), t).reason).toBe('price_not_final');
  });

  test('an accepted price entry without quoted_price_usd is not enough: booking stamps only the accepted total', () => {
    const entry = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 150, accepted: true, caller_response: 'accepted', unit: 'per_quarter' } } });
    expect(grounded(entry)).toEqual({ ok: false, reason: 'no_quoted_total' });
    expect(route(entry).allowed).toBe(false);
  });
});

describe('"Sure, that works." (owner ruling 2026-09-30)', () => {
  test('the caller\'s "Sure, that works." / "Sure." / "That works." right after staff\'s commitment is the acceptance (the extraction judges it, the code verifies the quote)', () => {
    for (const accept of [SURE, 'Sure.', 'That works.', 'Okay, sounds good, thank you.']) {
      const { ex, transcript } = acceptShape(accept, [`Agent: ${COMMIT}`, `Caller: ${accept}`]);
      expect([accept, grounded(ex, transcript)]).toEqual([accept, expect.objectContaining({ ok: true, mode: 'staff_stated' })]);
      expect(route(ex, { transcript }).allowed).toBe(true);
    }
  });

  test('...but the quote must be the caller\'s WHOLE turn directly after the commitment, and the judgement true', () => {
    // Not directly after the commitment turn.
    const late = acceptShape(SURE, [`Agent: ${COMMIT}`, 'Agent: Anything else?', `Caller: ${SURE}`]);
    expect(grounded(late.ex, late.transcript)).toEqual({ ok: false, reason: 'caller_acceptance_not_of_the_slot' });
    // A fragment of a longer turn (the rest takes it back).
    const partial = acceptShape(SURE, [`Agent: ${COMMIT}`, 'Caller: Sure, that works for the price, but the time is bad.']);
    expect(grounded(partial.ex, partial.transcript)).toEqual({ ok: false, reason: 'caller_acceptance_not_of_the_slot' });
    // The extraction judged the caller did not accept: fails closed whatever the words.
    const rejected = acceptShape(SURE, [`Agent: ${COMMIT}`, `Caller: ${SURE}`]);
    rejected.ex.scheduling.caller_accepted_slot = false;
    expect(grounded(rejected.ex, rejected.transcript)).toEqual({ ok: false, reason: 'caller_did_not_accept' });
    rejected.ex.scheduling.caller_accepted_slot = null;
    expect(grounded(rejected.ex, rejected.transcript).ok).toBe(false);
    // The acceptance in the wrong speaker's turn.
    const swapped = acceptShape(SURE, [`Agent: ${COMMIT}`, `Agent: ${SURE}`]);
    expect(grounded(swapped.ex, swapped.transcript).ok).toBe(false);
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
    // Other forms of the same yes are the extraction's judgement, verified by the pinned whole turn.
    for (const yes of ['Yes, sounds good.', 'Okay, that will work.', 'Sure, we can do that.', 'Absolutely, see you then.']) {
      const c = proposalCase({ replyText: yes });
      expect([yes, grounded(c.ex, c.transcript).ok]).toEqual([yes, true]);
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
    // The extraction did not judge that staff accepted the whole proposal.
    for (const judged of [false, null]) {
      expect(reason(proposalCase({ judged }))).toEqual({ ok: false, reason: 'staff_acceptance_unjudged' });
    }
    const missing = proposalCase();
    delete missing.ex.scheduling.staff_accepted_proposed_slot;
    expect(reason(missing)).toEqual({ ok: false, reason: 'staff_acceptance_unjudged' });
    // The pinned reply must be the ENTIRE reply turn: a fragment of a rejecting reply fails.
    const partialTurn = 'Sure, that works for the price, but the time is bad.';
    expect(reason(proposalCase({ replyText: partialTurn, evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'Sure, that works'),
      quote('/scheduling/staff_accepted_proposed_slot', 'agent', 'Sure, that works'),
      quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Can you come Thursday at 2'),
    ] })).ok).toBe(false);
    // The reply is a hedge or condition the shared screens catch.
    expect(reason(proposalCase({ replyText: 'Sure, that works if the tech is free.' })).ok).toBe(false);
    expect(reason(proposalCase({ replyText: 'Sure, that might work.' })).ok).toBe(false);
    // The reply is in a CALLER turn (swapped labels), or the proposal is in a staff turn.
    const swapped = proposalCase();
    expect(grounded(swapped.ex, swapped.transcript.replace(`Agent: ${SURE}`, `Caller: ${SURE}`)).ok).toBe(false);
    const staffProposal = proposalCase();
    expect(grounded(staffProposal.ex, staffProposal.transcript.replace(`Caller: ${PROPOSAL}`, `Agent: ${PROPOSAL}`)).ok).toBe(false);
    // The staff-acceptance quote is not the commitment turn.
    const otherTurn = proposalCase({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'When would you like us to come out?'),
      quote('/scheduling/staff_accepted_proposed_slot', 'agent', SURE),
      quote('/scheduling/confirmed_start_at', 'caller', 'Can you come Thursday at 2'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Can you come Thursday at 2'),
    ] });
    expect(reason(otherTurn).ok).toBe(false);
    // The proposal is not pinned as the caller's acceptance.
    const noAccept = proposalCase({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', SURE),
      quote('/scheduling/staff_accepted_proposed_slot', 'agent', SURE),
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

describe('a new booking whose final time turn omits the day: the caller\'s SELECTED day is judged and pinned', () => {
  test('the selected day, pinned to an earlier caller turn, binds it', () => {
    const { ex, transcript } = dayOmittedCase();
    expect(grounded(ex, transcript)).toMatchObject({ ok: true, mode: 'staff_stated' });
    expect(route(ex, { transcript }).allowed).toBe(true);
  });

  test('a full calendar date is one date (verified with the shared date grammar)', () => {
    // Call Wed Sep 23: Sat Oct 24 2026.
    const saturday = (words, line) => {
      const c = dayOmittedCase({ dayLine: `Caller: ${line}`, selected: words, selectedQuote: line.replace(/\.$/, '') });
      c.ex.scheduling.confirmed_start_at = '2026-10-24T14:00:00-04:00';
      return grounded(c.ex, c.transcript);
    };
    expect(saturday('October 24th', 'October 24th works.').ok).toBe(true);
    expect(saturday('Saturday October 24', 'Saturday October 24 works.').ok).toBe(true);
    expect(saturday('Saturday', 'Saturday works.').ok).toBe(false); // the nearest Saturday is Sep 26
    expect(saturday('Saturday October 25', 'Saturday October 25 works.').ok).toBe(false); // Oct 25 is a Sunday
    expect(saturday('October 25th', 'October 25th works.').ok).toBe(false);
  });

  test('fails closed on a missing or unjudged day, another date, a relative day, the wrong speaker or order', () => {
    const notOk = (c, reason) => {
      const r = grounded(c.ex, c.transcript);
      expect(r.ok).toBe(false);
      if (reason) expect(r.reason).toBe(reason);
    };
    notOk(dayOmittedCase({ selected: null }), 'day_not_bound');
    notOk(dayOmittedCase({ selectedQuote: null }), 'day_not_bound');
    notOk(dayOmittedCase({ dayLine: 'Caller: Thursday is impossible for us.', selected: null, selectedQuote: null }), 'day_not_bound');
    notOk(dayOmittedCase({ dayLine: 'Caller: Friday works.', selected: 'Friday', selectedQuote: 'Friday works' }), 'day_not_bound');
    notOk(dayOmittedCase({ dayLine: 'Caller: Next Thursday works.', selected: 'Next Thursday', selectedQuote: 'Next Thursday works' }), 'day_not_bound');
    // Words that are not in the quote, and a quote that is not in a caller turn.
    notOk(dayOmittedCase({ selected: 'Thursday', selectedQuote: 'Wednesday works' }));
    notOk(dayOmittedCase({ dayLine: 'Agent: Thursday works.', selectedSpeaker: 'agent' }));
    notOk(dayOmittedCase({ dayLine: 'Agent: Thursday works.' }));
    // A selected day said AFTER the time turn does not bind it.
    const late = dayOmittedCase({ dayLine: 'Caller: Sure, I will be there.' });
    late.transcript = `${late.transcript}\nCaller: Thursday works.`;
    notOk(late);
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

describe('a relative date the extraction resolved (positive booking case)', () => {
  test('"Thursday eight days away at two PM" books on the resolved date; an unresolved or ungrounded one does not', () => {
    const said = 'We will see you Thursday eight days away at two PM.';
    const build = ({ slot = '2026-10-01T14:00:00-04:00', relativeQuote = said } = {}) => ({
      ex: extraction({
        scheduling: { confirmed_start_at: slot, relative_date_used: true, agreed_slot_words: { day: 'Thursday', hour: 'two', period: 'PM' } },
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', said),
          quote('/scheduling/confirmed_start_at', 'agent', said),
          quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
          ...(relativeQuote ? [quote('/scheduling/relative_date_used', 'agent', relativeQuote)] : []),
        ],
      }),
      transcript: transcriptOf(`Agent: ${said}`, `Caller: ${ACCEPT}`),
    });
    const ok = build();
    expect(grounded(ok.ex, ok.transcript)).toMatchObject({ ok: true });
    expect(route(ok.ex, { transcript: ok.transcript }).allowed).toBe(true);
    const noQuote = build({ relativeQuote: null });
    expect(grounded(noQuote.ex, noQuote.transcript)).toEqual({ ok: false, reason: 'relative_date_ungrounded' });
    const nearest = build({ slot: THURSDAY_2PM });
    expect(grounded(nearest.ex, nearest.transcript).ok).toBe(false);
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
