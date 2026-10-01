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

const ONE_TIME_ROW = { id: 'svc-roach', service_key: 'cockroach_control', name: 'Cockroach Control Service', short_name: 'Cockroach Control', billing_type: 'one_time', pricing_type: 'fixed', base_price: '350.00' };
const RECURRING_ROW = { id: 'svc-pest-q', service_key: 'pest_general_quarterly', name: 'General Pest Control (Quarterly)', short_name: 'Pest Quarterly', billing_type: 'recurring', pricing_type: 'variable', base_price: '65.00' };

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
    service_request: withAcceptedEntry({ quoted_price_usd: 150, ...PRICE_JUDGEMENTS, ...service }, service),
    evidence: [...evidence, ...priceEvidence],
  };
}
// The accepted price entry for the quoted total (unit 'unknown': a bare "$150"), unless the
// test supplies its own price / prices.
function withAcceptedEntry(sr, service) {
  if ('price' in service || 'prices' in service || typeof sr.quoted_price_usd !== 'number') return sr;
  const entry = { amount_usd: sr.quoted_price_usd, accepted: true, caller_response: 'accepted', unit: 'unknown' };
  return { ...sr, price: entry, prices: [entry] };
}
// The processor's options for a gate-ON inbound call.
const opts = (extra = {}) => ({
  commercialDictatedBooking: true, transcriptLabelsTrusted: true,
  // the catalog-aware quote check the caller supplies (codex #5377 r9 P1); the real
  // resolver is exercised in its own describe below
  commercialQuoteBookable: () => true,
  transcript: TRANSCRIPT, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN,
  ...extra,
});
const route = (ex, extra) => canAutoRoute(ex, opts(extra));
const grounded = (ex, transcript = TRANSCRIPT, quoteBookable = () => true) => commercialDictatedBookingGrounded({ v2: ex, transcript, callStartedAt: CALL_STARTED_AT, quoteBookable });

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

  test('inbound only: ONE predicate (behind !isOutboundCall AND the agent-commit gate) feeds both processor call sites and the audit builder', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const sites = [...src.matchAll(/commercialDictatedBooking: (commercialDictatedBookingActive\([^)]*\))/g)].map((m) => m[1]);
    expect(sites).toEqual(['commercialDictatedBookingActive(call)', 'commercialDictatedBookingActive(call)']);
    const at = src.indexOf('function commercialDictatedBookingActive');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain("enabled('callAgentCommitBooking')");
    expect(body).toContain('!isOutboundCall(call)');
    expect(body).toContain('callCommercialDictatedBookingLive');
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

  test('the offer quote must state the recorded amount (digits or words); other numbers in the turn are not scanned (owner ruling 2026-10-01)', () => {
    expect(grounded(extraction(), TRANSCRIPT.replace('$150', '$120')).ok).toBe(false);
    // no code scan for "other figures": a mention of another number does not block, and the
    // extraction's price_is_final judgement is what governs corrections and added charges
    expect(grounded(extraction(), TRANSCRIPT.replace('$150, does', '$150 or $120, does')).ok).toBe(true);
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

  test('a staff correction or an added charge is governed by the extraction\'s price_is_final judgement, not a code scan (owner ruling 2026-10-01)', () => {
    const t = [OPENING, `Agent: ${PRICE_TALK}`, 'Agent: Actually, correction, the service is $250.', `Caller: ${PRICE_OK}`, `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    // the extraction judges a corrected price NOT final: the call is held
    expect(grounded(extraction({ service: { price_is_final: false } }), t).reason).toBe('price_not_final');
    expect(route(extraction({ service: { price_is_final: false } }), { transcript: t }).allowed).toBe(false);
    // an added small charge ("plus ten dollars"): same path, nothing is scanned
    const added = [OPENING, `Agent: ${PRICE_TALK}`, 'Agent: Plus ten dollars for the garage.', `Caller: ${PRICE_OK}`, `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    expect(grounded(extraction({ service: { price_is_final: false } }), added).reason).toBe('price_not_final');
    expect(grounded(extraction({ service: { price_is_final: null } }), added).reason).toBe('price_not_final');
  });

  test('a recurring billing unit on the accepted price goes to the office (codex #5377 r5 P1)', () => {
    for (const unit of ['per_month', 'per_quarter', 'per_year']) {
      const entry = { amount_usd: 150, accepted: true, caller_response: 'accepted', unit };
      const r = extraction({ service: { price: entry, prices: [entry] } });
      expect(grounded(r)).toEqual({ ok: false, reason: 'price_unit_not_bookable' });
      expect(route(r).allowed).toBe(false);
    }
    for (const unit of ['one_time', 'per_application', 'unknown']) {
      const entry = { amount_usd: 150, accepted: true, caller_response: 'accepted', unit };
      expect(grounded(extraction({ service: { price: entry, prices: [entry] } })).ok).toBe(true);
    }
    // No unit recorded (null = "no price stated" in the schema): the spoken unit is unknown, so the office books it.
    for (const unit of [null, undefined]) {
      const entry = { amount_usd: 150, accepted: true, caller_response: 'accepted', ...(unit === null ? { unit } : {}) };
      expect(grounded(extraction({ service: { price: entry, prices: [entry] } }))).toEqual({ ok: false, reason: 'price_unit_not_bookable' });
    }
  });

  test('the unit must come from an accepted price entry for the quoted total, never a synthesized unitless term (codex #5377 r15 P1)', () => {
    // "$150 per month" pinned and accepted, quoted_price_usd 150, but the price entry omitted ...
    const omitted = extraction({ service: { price: null, prices: [] } });
    expect(grounded(omitted)).toEqual({ ok: false, reason: 'no_accepted_price_entry' });
    expect(route(omitted).allowed).toBe(false);
    // ... or present but not marked accepted (caller_response 'no_response')
    const unaccepted = { amount_usd: 150, accepted: false, caller_response: 'no_response', unit: 'per_month' };
    const r = extraction({ service: { price: unaccepted, prices: [unaccepted] } });
    expect(grounded(r)).toEqual({ ok: false, reason: 'no_accepted_price_entry' });
    expect(route(r).allowed).toBe(false);
    // ... or accepted at a different amount than the quoted total
    const other = { amount_usd: 140, accepted: true, caller_response: 'accepted', unit: 'one_time' };
    expect(grounded(extraction({ service: { price: other, prices: [other] } })).ok).toBe(false);
  });

  test('a dollars-and-cents offer spoken in words grounds the quoted amount (codex #5377 r15 P2)', () => {
    const at = (spoken, amount) => {
      const offer = `The quarterly service for the office is ${spoken}`;
      const t = TRANSCRIPT.split(PRICE_QUOTE).join(offer);
      const ex = extraction({ service: { quoted_price_usd: amount }, priceEvidence: [quote('/service_request/price_offered_by_staff', 'agent', offer), PRICE_EVIDENCE[1]] });
      return grounded(ex, t);
    };
    expect(at('one hundred fifty dollars and fifty cents', 150.5).ok).toBe(true);
    expect(at('150 dollars and 50 cents', 150.5).ok).toBe(true);
    expect(at('one hundred forty nine dollars and ninety-nine cents', 149.99).ok).toBe(true);
    // the compound states 150.50, not 150 or 50
    expect(at('one hundred fifty dollars and fifty cents', 150).reason).toBe('price_not_stated_by_staff');
    expect(at('one hundred fifty dollars and fifty cents', 50).reason).toBe('price_not_stated_by_staff');
    // cents below twenty (spokenFiguresIn skips them) — codex #5377 pre-push P1
    expect(at('one hundred fifty dollars and five cents', 150.05).ok).toBe(true);
    expect(at('one hundred fifty dollars and fifteen cents', 150.15).ok).toBe(true);
    expect(at('150 dollars and 5 cents', 150.05).ok).toBe(true);
    expect(at('one hundred fifty dollars and five cents', 150).reason).toBe('price_not_stated_by_staff');
    expect(at('one hundred fifty dollars and fifteen cents', 150).reason).toBe('price_not_stated_by_staff');
    // an unreadable compound fails closed
    expect(at('one hundred fifty dollars and a few cents', 150).reason).toBe('price_not_stated_by_staff');
    // the dollars are the figure right before "dollars and", not an earlier one (codex #5377 local r1 P2)
    expect(at('for twenty rooms 150 dollars and fifty cents', 150.5).ok).toBe(true);
    expect(at('for twenty rooms 150 dollars and fifty cents', 150).reason).toBe('price_not_stated_by_staff');
    expect(at('for 20 rooms one hundred fifty dollars and fifty cents', 150.5).ok).toBe(true);
  });

  test('a quote clipped inside the spoken amount does not ground the shorter amount (codex #5377 local r1 P1)', () => {
    const clipped = (turnText, quoteText) => {
      const t = TRANSCRIPT.split(PRICE_TALK).join(turnText);
      const ex = extraction({ priceEvidence: [quote('/service_request/price_offered_by_staff', 'agent', quoteText), PRICE_EVIDENCE[1]] });
      return grounded(ex, t);
    };
    expect(clipped('The quarterly service for the office is $150.50, does that work?', 'The quarterly service for the office is $150').reason).toBe('price_not_stated_by_staff');
    expect(clipped('The quarterly service for the office is one hundred fifty dollars and fifty cents, does that work?', 'The quarterly service for the office is one hundred fifty dollars').reason).toBe('price_not_stated_by_staff');
    // the whole amount, quoted whole, still grounds
    expect(clipped('The quarterly service for the office is $150, does that work?', 'The quarterly service for the office is $150').ok).toBe(true);
  });

  test('a multi-term accepted price ("$150 to start plus $50/month") goes to the office (codex #5377 r3 P1)', () => {
    const prices = [
      { amount_usd: 150, accepted: true, caller_response: 'accepted', unit: 'one_time' },
      { amount_usd: 50, accepted: true, caller_response: 'accepted', unit: 'per_month' },
    ];
    const multi = extraction({ service: { price: prices[0], prices } });
    expect(grounded(multi)).toEqual({ ok: false, reason: 'price_has_multiple_terms' });
    expect(route(multi).allowed).toBe(false);
    // One accepted term alone still books.
    const single = extraction({ service: { price: prices[0], prices: [prices[0]] } });
    expect(grounded(single).ok).toBe(true);
  });

  test('a total the booking path would discard (sanitizeQuotedCallPrice) fails closed (codex #5377 r4 P1)', () => {
    const at = (amount) => {
      const t = TRANSCRIPT.split('$150').join(`$${amount}`);
      const ex = extraction({ service: { quoted_price_usd: amount } });
      ex.evidence = ex.evidence.map((e) => ({ ...e, quote: e.quote.split('$150').join(`$${amount}`) }));
      return { ex, t };
    };
    for (const amount of [19, 20500]) {
      const { ex, t } = at(amount);
      expect([amount, grounded(ex, t)]).toEqual([amount, { ok: false, reason: 'quoted_total_not_bookable' }]);
      expect(route(ex, { transcript: t }).allowed).toBe(false);
    }
    // The bounds are inclusive at the low end and a valid amount books.
    const { ex, t } = at(275);
    expect(grounded(ex, t).ok).toBe(true);
    expect(route(ex, { transcript: t }).allowed).toBe(true);
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

// A force-reprocess after the gate flips (codex #5377 r4 P1): the first pass
// (gate off) filed an open BLOCKING commercial_requires_quote card; the booking
// pass's advisory insert is ON CONFLICT DO NOTHING, so the blocking card would
// stay red on a booked visit. The gate-agnostic gateDemotedFlags list (shared
// with GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT) rides canAutoRoute's verdict and the
// processor demotes whatever it holds through the ONE fenced, verified path.
describe('reprocess after the flip: the open blocking commercial card is demoted (codex #5377 r4 P1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const Processor = require('../services/call-recording-processor');
  const { demoteOpenTriageCards } = Processor._test;
  const { demoteFailOpenOnV1AddressConflict } = Processor;

  test('gate ON books and reports the flag it waived; gate OFF has no such key at all (byte-identical)', () => {
    const on = route(extraction());
    expect(on).toMatchObject({ allowed: true, failedOpenFlags: ['commercial_requires_quote'], gateDemotedFlags: ['commercial_requires_quote'] });
    // The unclear-service-only force logic is not triggered by a commercial waiver.
    expect(on.unclearServiceDemotedFlags).toBeUndefined();
    expect(on.forceAssessmentService).toBeUndefined();
    const off = route(extraction(), { commercialDictatedBooking: false });
    expect(off.allowed).toBe(false);
    expect('gateDemotedFlags' in off).toBe(false);
  });

  test('the processor demotes whatever the shared list holds, fenced, and holds/abandons on failure', () => {
    const at = src.indexOf('const demoted = await demoteOpenTriageCards(');
    const call = src.slice(at, at + 600);
    expect(call).toMatch(/routingResult\.gateDemotedFlags, procToken,/);
    expect(call).toMatch(/\(routingResult\.gateDemotedFlags \|\| \[\]\)\.map\(\(f\) => buildTriageItem\(/);
    expect(src.slice(at, at + 1400)).toMatch(/if \(demoted === null\) return abandonToPeer\(/);
    expect(src.slice(at - 150, at)).not.toMatch(/try \{\s*$/);
  });

  // A recording fake of the fenced transaction.
  function fakeConn({ owner = true, blockingRows = 1 } = {}) {
    const calls = [];
    const builder = (table) => {
      const chain = {
        where(...a) { calls.push([table, 'where', ...a]); return chain; },
        whereIn(...a) { calls.push([table, 'whereIn', ...a]); return chain; },
        forUpdate() { return chain; },
        first() { return Promise.resolve(table === 'call_log' && owner ? { id: 'call-1' } : undefined); },
        update(u) { calls.push([table, 'update', u]); return Promise.resolve(blockingRows); },
        insert(row) { calls.push([table, 'insert', row]); return chain; },
        onConflict() { return chain; },
        ignore() { return Promise.resolve([]); },
        select() { return Promise.resolve([{ reason_code: 'commercial_requires_quote' }]); },
      };
      return chain;
    };
    builder.fn = { now: () => 'NOW' };
    builder.raw = () => Promise.resolve({ rows: [] });
    return { conn: { transaction: async (fn) => fn(builder) }, calls };
  }

  test('an open blocking commercial_requires_quote card becomes advisory in place, under the owning token', async () => {
    const { conn, calls } = fakeConn();
    const item = { call_log_id: 'call-1', reason_code: 'commercial_requires_quote', severity: 'advisory' };
    expect(await demoteOpenTriageCards(conn, 'call-1', ['commercial_requires_quote'], 'tok-1', [item])).toBe(1);
    expect(calls).toEqual(expect.arrayContaining([
      ['call_log', 'where', 'processing_token', 'tok-1'],
      ['triage_items', 'where', { call_log_id: 'call-1', severity: 'blocking' }],
      ['triage_items', 'whereIn', 'reason_code', ['commercial_requires_quote']],
      ['triage_items', 'update', { severity: 'advisory', updated_at: 'NOW' }],
      ['triage_items', 'insert', item],
    ]));
  });

  test('a lost claim reports null (the pass abandons instead of booking)', async () => {
    const { conn } = fakeConn({ owner: false });
    expect(await demoteOpenTriageCards(conn, 'call-1', ['commercial_requires_quote'], 'stale', [])).toBeNull();
  });

  test('a call held by the V1 address-conflict demotion still files the commercial advisory card', () => {
    const allowed = {
      allowed: true, flags: [], usesOnFileAddress: true,
      failedOpenFlags: ['commercial_requires_quote', 'missing_service_address'],
      gateDemotedFlags: ['commercial_requires_quote'],
    };
    const held = demoteFailOpenOnV1AddressConflict(
      allowed,
      { address_line1: '9 Elsewhere Ln', city: 'Sarasota', state: 'FL', zip: '34231' },
      { hasAddress: true, addressLine1: '100 Synthetic St', addressZip: '34202', addressCity: 'Bradenton', addressState: 'FL' },
    );
    expect(held).toMatchObject({ allowed: false, reason: 'v1_only_new_address', appointmentBlockingFlags: ['address_unverified'] });
    expect(held.failedOpenFlags).toEqual(['commercial_requires_quote']);
    expect(held.gateDemotedFlags).toEqual(['commercial_requires_quote']);
  });
});

// The offline routing audits (codex #5377 r6 P1): v2-promotion-readiness,
// verify-v2-shadow-path and replay-call-extraction-variance all spread
// buildFailOpenRoutingContext into canAutoRoute, so the commercial context is
// derived THERE, by the same predicate the processor lanes use.
describe('the audits derive the commercial context the way the processor does (codex #5377 r6 P1)', () => {
  const Processor = require('../services/call-recording-processor');
  const { buildFailOpenRoutingContext } = Processor;
  const { commercialDictatedBookingActive } = Processor._test;
  const gatesOf = ({ agentCommit = true, trusted = true, commercial = true } = {}) => ({
    isEnabled: (g) => ({ callAgentCommitBooking: agentCommit, callAgentCommitTrustedLabels: trusted }[g] === true),
    commercialLive: () => commercial,
  });
  const inbound = { direction: 'inbound', transcription: TRANSCRIPT, created_at: CALL_STARTED_AT };
  const build = (call = inbound, gates = gatesOf(), extra = {}) => buildFailOpenRoutingContext({
    call, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates, ...extra,
  }).options;

  test('gate ON, inbound: the option, the trusted-label gate, the transcript and the call time ride along', () => {
    const options = build();
    expect(options).toMatchObject({ commercialDictatedBooking: true, transcriptLabelsTrusted: true, transcript: TRANSCRIPT });
    // the call's start (callStartedAt(call), a Date): an ordinary row's created_at
    expect(new Date(options.callStartedAt).toISOString()).toBe(new Date(CALL_STARTED_AT).toISOString());
  });

  test('untrusted labels ride as false (the demotion stays dark, exactly as in the processor)', () => {
    expect(build(inbound, gatesOf({ trusted: false }))).toMatchObject({ commercialDictatedBooking: true, transcriptLabelsTrusted: false });
  });

  test('every gate-off shape is byte-identical: no commercial keys at all', () => {
    const base = { failOpen: false, callerAni: '+19415550100', knownCustomer: null };
    for (const options of [
      build(inbound, gatesOf({ commercial: false })),
      build(inbound, gatesOf({ agentCommit: false })),
      build({ ...inbound, direction: 'outbound-api' }),
      build({ ...inbound, direction: 'Outbound' }),
    ]) {
      expect(options).toEqual(expect.objectContaining(base));
      expect(Object.keys(options).sort()).toEqual(Object.keys(base).sort());
    }
  });

  test('the SAME predicate the processor lanes call (inbound-only, needs GATE_CALL_AGENT_COMMIT_BOOKING)', () => {
    expect(commercialDictatedBookingActive(inbound, gatesOf())).toBe(true);
    expect(commercialDictatedBookingActive({ direction: 'outbound' }, gatesOf())).toBe(false);
    expect(commercialDictatedBookingActive(inbound, gatesOf({ agentCommit: false }))).toBe(false);
    expect(commercialDictatedBookingActive(inbound, gatesOf({ commercial: false }))).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src.match(/commercialDictatedBooking: commercialDictatedBookingActive\(call\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/commercialDictatedBooking: isEnabled\('callAgentCommitBooking'\)/);
  });

  test('an explicit transcript (a re-transcription) overrides the row\'s own', () => {
    expect(build(inbound, gatesOf(), { transcript: 'Agent: x' }).transcript).toBe('Agent: x');
  });

  test('canAutoRoute over the audit context books an admitted commercial call; gate off holds it (the audit no longer misclassifies)', () => {
    const ex = extraction();
    const on = canAutoRoute(ex, { contactPhone: '+19415550100', addressValidation: AV_CLEAN, ...build(inbound, gatesOf(), { bookableServices: [ONE_TIME_ROW, RECURRING_ROW], extracted: { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name } }) });
    expect(on).toMatchObject({ allowed: true, gateDemotedFlags: ['commercial_requires_quote'] });
    const off = canAutoRoute(ex, { contactPhone: '+19415550100', addressValidation: AV_CLEAN, ...build(inbound, gatesOf({ commercial: false })) });
    expect(off.allowed).toBe(false);
    // no catalog handed to the builder (an audit that could not load it): FAIL CLOSED
    const noCatalog = canAutoRoute(ex, { contactPhone: '+19415550100', addressValidation: AV_CLEAN, ...build() });
    expect(noCatalog.allowed).toBe(false);
  });

  test('replay-call-extraction-variance routes through it, on the transcript the extraction was made from', () => {
    const { routeForV2, defaultReplayHelpers } = require('../scripts/replay-call-extraction-variance');
    const helpers = defaultReplayHelpers();
    const ctx = build(inbound, gatesOf(), { bookableServices: [ONE_TIME_ROW, RECURRING_ROW], extracted: { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name } });
    const route = (extra, context = ctx) => routeForV2(extraction(), '+19415550100', helpers, AV_CLEAN, context, { demote: (r) => r, transcription: TRANSCRIPT, ...extra });
    expect(route().allowed).toBe(true);
    // a fresh extraction from a different (re-)transcription is judged against THAT text:
    // the context is REBUILT from it (transcript AND the catalog quote checker)
    const other = TRANSCRIPT.replace(COMMIT, 'We will be there sometime.');
    const rebuilt = build(inbound, gatesOf(), { bookableServices: [ONE_TIME_ROW, RECURRING_ROW], extracted: { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name }, transcript: other });
    expect(route({ transcription: other }, rebuilt).allowed).toBe(false);
    // gate off: the shared context is unchanged and the replay holds the call
    expect(routeForV2(extraction(), '+19415550100', helpers, AV_CLEAN, build(inbound, gatesOf({ commercial: false })), { demote: (r) => r, transcription: TRANSCRIPT }).allowed).toBe(false);
  });

  test('a re-transcription rebuilds the quote checker: it resolves the catalog row from the text it is handed (codex #5377 r10 P2)', () => {
    const services = [ONE_TIME_ROW, RECURRING_ROW];
    const oneTimeTalk = `Caller: we have a roach problem and need cockroach control\n${TRANSCRIPT}`;
    const recurringTalk = `Caller: we want general pest control quarterly service\n${TRANSCRIPT}`;
    const ctxFor = (transcript) => build(inbound, gatesOf(), { bookableServices: services, extracted: {}, transcript });
    expect(ctxFor(oneTimeTalk).commercialQuoteBookable(150, null)).toBe(true);
    expect(ctxFor(recurringTalk).commercialQuoteBookable(150, null)).toBe(false);
    // the persisted transcript's checker does NOT follow a re-transcription: the replay must rebuild it
    const persisted = ctxFor(oneTimeTalk);
    expect(persisted.transcript).toBe(oneTimeTalk);
    const src = fs.readFileSync(path.join(__dirname, '../scripts/replay-call-extraction-variance.js'), 'utf8');
    expect(src).toMatch(/transcriptForExtraction === call\.transcription \? failOpenContext : contextFor\(transcriptForExtraction\)\.options/);
    expect(src).toMatch(/const contextFor = \(transcript\) => CRP\.buildFailOpenRoutingContext\(/);
    expect(src).not.toMatch(/\.\.\.routeContext/);
  });

  test('every audit caller already carries the fields the builder reads (no silent no-op)', () => {
    const readiness = fs.readFileSync(path.join(__dirname, '../scripts/v2-promotion-readiness.js'), 'utf8');
    expect(readiness).toMatch(/\.select\('id', 'twilio_call_sid', 'transcription',[^)]*'created_at',[^)]*'direction'/);
    const verify = fs.readFileSync(path.join(__dirname, '../scripts/verify-v2-shadow-path.js'), 'utf8');
    expect(verify).toMatch(/\.select\('id', 'transcription', 'from_phone', 'to_phone', 'direction', 'metadata', 'source', 'created_at'/);
    const replay = fs.readFileSync(path.join(__dirname, '../scripts/replay-call-extraction-variance.js'), 'utf8');
    for (const col of ["'created_at'", "'direction'", "'transcription'"]) expect(replay).toContain(`    ${col},`);
    for (const src of [readiness, verify, replay]) expect(src).toMatch(/buildFailOpenRoutingContext\(\{\s*call/);
  });
});

// GATE_CALL_COMMERCIAL_DICTATED_BOOKING also needs the quote to survive the booking
// path's catalog-aware resolver (codex #5377 r9 P1): resolveCallBookingPrice discards
// every quote when the resolved catalog row is recurring, so a dictated booking of a
// recurring service would book with estimated_price null.
describe('the quote must survive the catalog-aware price resolver (codex #5377 r9 P1)', () => {
  const { commercialQuoteBookableFor } = require('../services/call-recording-processor')._test;
  const serviceOf = (name) => ({ ...extraction(), service_request: { ...extraction().service_request, specific_service_name: name, requested_service: name } });
  const check = (name, services) => commercialQuoteBookableFor({
    extracted: { requested_service: name, matched_service: name }, transcription: TRANSCRIPT, services,
  });

  test('the gate fails closed without the check, and when the check says no', () => {
    expect(commercialDictatedBookingGrounded({ v2: extraction(), transcript: TRANSCRIPT, callStartedAt: CALL_STARTED_AT }))
      .toEqual({ ok: false, reason: 'price_not_bookable_for_service' });
    expect(grounded(extraction(), TRANSCRIPT, () => false)).toEqual({ ok: false, reason: 'price_not_bookable_for_service' });
    expect(grounded(extraction(), TRANSCRIPT, () => 'true')).toEqual({ ok: false, reason: 'price_not_bookable_for_service' }); // strict === true
    expect(grounded(extraction(), TRANSCRIPT, (q, v2) => q === 150 && !!v2).ok).toBe(true); // it is handed the quote and the extraction
    expect(route(extraction(), { commercialQuoteBookable: undefined }).allowed).toBe(false);
  });

  test('a ONE-TIME catalog row books: the quote survives resolveCallBookingPrice', () => {
    const ex = serviceOf(ONE_TIME_ROW.name);
    const ok = check(ONE_TIME_ROW.name, [ONE_TIME_ROW, RECURRING_ROW]);
    expect(ok(150, ex)).toBe(true);
    const r = route(ex, { commercialQuoteBookable: ok });
    expect(r).toMatchObject({ allowed: true, gateDemotedFlags: ['commercial_requires_quote'] });
  });

  test('a RECURRING catalog row goes to the office (price_not_bookable_for_service): the resolver would discard the quote', () => {
    const ex = serviceOf(RECURRING_ROW.name);
    const bad = check(RECURRING_ROW.name, [ONE_TIME_ROW, RECURRING_ROW]);
    expect(bad(150, ex)).toBe(false);
    expect(grounded(ex, TRANSCRIPT, bad)).toEqual({ ok: false, reason: 'price_not_bookable_for_service' });
    expect(route(ex, { commercialQuoteBookable: bad }).allowed).toBe(false);
  });

  test('cannot resolve a catalog row at routing time (no catalog, no match, error): fail closed', () => {
    const ex = serviceOf('Nothing Known');
    expect(check('Nothing Known', [ONE_TIME_ROW, RECURRING_ROW])(150, ex)).toBe(false);
    expect(check(ONE_TIME_ROW.name, [])(150, serviceOf(ONE_TIME_ROW.name))).toBe(false);
    expect(check(ONE_TIME_ROW.name, null)(150, serviceOf(ONE_TIME_ROW.name))).toBe(false);
    expect(commercialQuoteBookableFor({ extracted: null, services: [ONE_TIME_ROW] })(150, null)).toBe(false);
  });

  test('EVERY view of the call\'s service must survive: a V1 pick that V2 replaces with a recurring row holds', () => {
    const ex = serviceOf(RECURRING_ROW.name); // V2 says recurring
    ex.service_request.primary_service_category = 'pest_general';
    ex.meta = { schema_version: '1.21.0' }; // a real V2 record: its service overrides the V1 pick at booking
    const f = commercialQuoteBookableFor({
      extracted: { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name },
      preAdoptionExtracted: { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name },
      transcription: TRANSCRIPT, services: [ONE_TIME_ROW, RECURRING_ROW],
    });
    expect(f(150, ex)).toBe(false);
  });

  test('each view is judged as the booking books it, after the recurring-intent override (codex #5377 local r1 P1)', () => {
    const QUARTERLY = { id: 'svc-pest-q2', service_key: 'pest_quarterly', name: 'Quarterly Pest Control Service', short_name: 'Pest Quarterly', billing_type: 'recurring', pricing_type: 'variable', base_price: '65.00' };
    const roach = { is_lead: true, matched_service: ONE_TIME_ROW.name, requested_service: ONE_TIME_ROW.name, specific_service_name: ONE_TIME_ROW.name };
    const services = [ONE_TIME_ROW, QUARTERLY];
    const oneTimeCall = 'Caller: I have roaches in the office kitchen.\nAgent: We can do that.';
    const planCall = 'Caller: I have roaches in the office and I want the quarterly pest control plan going forward.\nAgent: We can do that.';
    expect(commercialQuoteBookableFor({ extracted: roach, transcription: oneTimeCall, services })(150, null)).toBe(true);
    // the booking turns the one-time pick into the quarterly program, which drops the quote
    expect(commercialQuoteBookableFor({ extracted: roach, transcription: planCall, services })(150, null)).toBe(false);
  });

  test('the audits rebuild the pre-adoption view from the recorded V1 service fields (codex #5377 r17 P1)', () => {
    const { auditCommercialQuoteBookableFor, preAdoptionServiceFields } = require('../services/call-recording-processor')._test;
    // V1 resolved the RECURRING row; V2-primary filled specific_service_name with the one-time row.
    const v1 = { requested_service: RECURRING_ROW.name, matched_service: RECURRING_ROW.name, specific_service_name: null };
    const merged = { ...v1, specific_service_name: ONE_TIME_ROW.name };
    const v2 = serviceOf(ONE_TIME_ROW.name);
    v2.meta = { schema_version: '1.21.0' };
    const services = [ONE_TIME_ROW, RECURRING_ROW];
    const recorded = preAdoptionServiceFields(v1, ['specific_service_name', 'first_name']);
    expect(recorded).toEqual({ specific_service_name: null }); // service fields only, V1 values
    // live: every view must survive, the V1 recurring view does not
    expect(commercialQuoteBookableFor({ extracted: merged, preAdoptionExtracted: v1, transcription: TRANSCRIPT, services })(150, v2)).toBe(false);
    // audit with the record: the same verdict
    expect(auditCommercialQuoteBookableFor({ extracted: { ...merged, pre_adoption_service_fields: recorded }, transcription: TRANSCRIPT, services })(150, v2)).toBe(false);
    // audit with an empty record (adoption touched no service field): the merged view decides
    const oneTime = { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name };
    expect(auditCommercialQuoteBookableFor({ extracted: { ...oneTime, pre_adoption_service_fields: {} }, transcription: TRANSCRIPT, services })(150, v2)).toBe(true);
    // a row processed before the record existed, with a V2 extraction: unknown pre-adoption view, held
    expect(auditCommercialQuoteBookableFor({ extracted: oneTime, transcription: TRANSCRIPT, services })(150, v2)).toBe(false);
    // ... and with no V2 extraction there was no adoption: the V1 record decides
    expect(auditCommercialQuoteBookableFor({ extracted: oneTime, transcription: TRANSCRIPT, services })(150, null)).toBe(true);
  });

  test('the processor records the V1 service fields for every valid V2 extraction, and the audit builder reads them', () => {
    const proc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(proc).toMatch(/if \(v2Result\?\.status === 'valid' && isV2Extraction\(v2Result\.extraction\)\) \{\n\s+extracted = \{ \.\.\.extracted, pre_adoption_service_fields: preAdoptionServiceFields\(preAdoptionExtracted, serviceFieldsAdopted\) \};/);
    expect(proc).toMatch(/commercialQuoteBookable: auditCommercialQuoteBookableFor\(\{\n\s+extracted: extracted !== undefined \? extracted : parseLooseJson\(call\.ai_extraction\),/);
    // the record is written before the first ai_extraction write that follows adoption
    const adoptAt = proc.indexOf('const adoption = adoptV2PrimaryFields(');
    const rec = proc.indexOf('pre_adoption_service_fields: preAdoptionServiceFields(');
    expect(rec).toBeGreaterThan(adoptAt);
    expect(rec).toBeLessThan(proc.indexOf('ai_extraction: JSON.stringify(extracted)', adoptAt));
  });

  test('both processor lanes and every audit hand the check the SAME way', () => {
    const src = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const proc = src('../services/call-recording-processor.js');
    expect(proc.match(/commercialQuoteBookable: commercialQuoteBookableFor\(\{\s*extracted, preAdoptionExtracted, transcription, services: bookableCallServices,/g)).toHaveLength(2);
    expect(src('../scripts/v2-promotion-readiness.js')).toMatch(/bookableServices: bookableCallServices,/);
    expect(src('../scripts/verify-v2-shadow-path.js')).toMatch(/bookableServices: Array\.isArray\(r\.bookable_services\)/);
    expect(src('../scripts/verify-v2-shadow-path.js')).toMatch(/row\.bookable_services = bookableServices/);
    expect(src('../scripts/replay-call-extraction-variance.js')).toMatch(/const bookableServices = await require\('\.\.\/services\/call-booking-catalog'\)\.loadBookableCallServices\(db\)[\s\S]*?\n    bookableServices,/);
    expect(src('../services/call-triage-flags.js')).toMatch(/quoteBookable: opts\.commercialQuoteBookable,/);
  });
});

// Both gates on (codex #5377 r10 P1): GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT waives
// ambiguous_pest_or_service and FORCES the Waves Assessment row, whose booking clears
// the treatment price — so a quote validated against the originally resolved service
// must not clear commercial_requires_quote. The call holds for the office.
describe('both gates on: a forced Assessment never clears the commercial hold (codex #5377 r10 P1)', () => {
  const BOTH = { failOpen: true, unclearServiceAssessment: true, callerAni: '+19415550100' };

  test('ambiguous service alone (unclear gate on) is waived and forces the Assessment', () => {
    const r = route(extraction({ flags: ['ambiguous_pest_or_service'] }), BOTH);
    expect(r).toMatchObject({ allowed: true, forceAssessmentService: true, gateDemotedFlags: ['ambiguous_pest_or_service'] });
  });

  test('commercial_requires_quote + ambiguous_pest_or_service: the commercial hold STANDS (fail closed)', () => {
    const r = route(extraction({ flags: ['commercial_requires_quote', 'ambiguous_pest_or_service'] }), BOTH);
    expect(r).toMatchObject({ allowed: false, reason: 'triage_flags', appointmentBlockingFlags: ['commercial_requires_quote'] });
    // the ambiguity waiver rides along for the advisory card, the commercial flag does not
    expect(r.failedOpenFlags).toEqual(['ambiguous_pest_or_service']);
    expect(r.forceAssessmentService).toBeUndefined();
  });

  test('commercial alone, unclear gate on: books as before (the force only applies to an ambiguous demotion)', () => {
    const r = route(extraction(), BOTH);
    expect(r).toMatchObject({ allowed: true, gateDemotedFlags: ['commercial_requires_quote'] });
    expect(r.forceAssessmentService).toBeUndefined();
  });

  test('unclear gate OFF, commercial gate on: the ambiguous flag itself still holds', () => {
    const r = route(extraction({ flags: ['commercial_requires_quote', 'ambiguous_pest_or_service'] }), { failOpen: true, callerAni: '+19415550100' });
    expect(r.allowed).toBe(false);
  });
});

// Slot dates resolve from the call's own START (codex #5377 r12 P2): a post-call
// fallback row's created_at is AFTER the call ended, so a call that began before
// midnight and ended after it would resolve "eight days away" a day late.
describe('slot dates resolve from the actual call start across midnight (codex #5377 r12 P2)', () => {
  const said = 'We will see you Thursday eight days away at two PM.';
  const RELATIVE_SLOT = '2026-10-01T14:00:00-04:00'; // eight days after Wed Sep 23 (ET)
  const relativeCase = () => ({
    ex: extraction({
      scheduling: { confirmed_start_at: RELATIVE_SLOT, relative_date_used: true, agreed_slot_words: { day: 'Thursday', hour: 'two', period: 'PM' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', said),
        quote('/scheduling/confirmed_start_at', 'agent', said),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        quote('/scheduling/relative_date_used', 'agent', said),
      ],
    }),
    transcript: transcriptOf(`Agent: ${said}`, `Caller: ${ACCEPT}`),
  });
  // The call began Wed Sep 23 11:30 PM ET and ended Thu Sep 24 12:30 AM ET; the
  // status-callback fallback row was inserted AFTER it ended.
  const STARTED = '2026-09-24T03:30:00.000Z';
  const POST_CALL_ROW = {
    direction: 'inbound', created_at: '2026-09-24T04:30:00.000Z', duration_seconds: 3600,
    metadata: { source: 'status_callback' }, transcription: relativeCase().transcript,
  };
  const { callStartedAt } = require('../utils/call-timeline');
  const gatesOn = { isEnabled: (g) => g === 'callAgentCommitBooking' || g === 'callAgentCommitTrustedLabels', commercialLive: () => true };
  const { buildFailOpenRoutingContext } = require('../services/call-recording-processor');

  test('the grounding itself: the real start books, the post-call created_at does not (why the helper matters)', () => {
    const { ex, transcript } = relativeCase();
    const at = (when) => commercialDictatedBookingGrounded({ v2: ex, transcript, callStartedAt: when, quoteBookable: () => true });
    expect(at(STARTED).ok).toBe(true);
    expect(at(POST_CALL_ROW.created_at).ok).toBe(false);
  });

  test('callStartedAt() backs a post-call row\'s length out of created_at', () => {
    expect(callStartedAt(POST_CALL_ROW).toISOString()).toBe(STARTED);
  });

  test('buildFailOpenRoutingContext (the audits) hands canAutoRoute the real start, so the call books', () => {
    const { ex, transcript } = relativeCase();
    const options = buildFailOpenRoutingContext({ call: POST_CALL_ROW, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates: gatesOn }).options;
    expect(new Date(options.callStartedAt).toISOString()).toBe(STARTED);
    const r = canAutoRoute(ex, { contactPhone: '+19415550100', addressValidation: AV_CLEAN, ...options, commercialQuoteBookable: () => true, transcript });
    expect(r).toMatchObject({ allowed: true, gateDemotedFlags: ['commercial_requires_quote'] });
    // an ordinary inbound row (created at the call's start) is unchanged
    const plain = buildFailOpenRoutingContext({ call: { direction: 'inbound', created_at: STARTED, transcription: transcript }, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates: gatesOn }).options;
    expect(new Date(plain.callStartedAt).toISOString()).toBe(STARTED);
  });

  test('both processor lanes use the same helper, and every audit selects the columns it reads', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const proc = read('../services/call-recording-processor.js');
    expect(proc.match(/callStartedAt: callStartedAt\(call\) \|\| call\.created_at,/g)).toHaveLength(5); // builder + 2 routing lanes + the 2 extraction sites that already used it
    expect(proc).not.toMatch(/callStartedAt: call\.created_at,/);
    expect(read('../scripts/v2-promotion-readiness.js')).toMatch(/'duration_seconds', 'recording_duration_seconds'\)/);
    expect(read('../scripts/verify-v2-shadow-path.js')).toMatch(/'duration_seconds', 'recording_duration_seconds',/);
    expect(read('../scripts/replay-call-extraction-variance.js')).toMatch(/'duration_seconds',\s*'recording_duration_seconds',/);
  });
});

// Amounts said as WORDS (codex #5377 r12 P2). There was no reusable spoken-number
// parser in the repo (procurement-tools' percentWordsToValue is private and 1-99),
// so a small closed-set one lives in the shared grounding tools.
describe('prices said as words ground like digit prices (codex #5377 r12 P2)', () => {
  const { groundingTools: { spokenFiguresIn } } = require('../services/call-reschedule-agreement');
  const withSpoken = (spoken, amount, { between = [] } = {}) => {
    const swap = (t) => t.split('$150').join(spoken);
    const talk = swap(PRICE_TALK);
    const ex = extraction({
      service: { quoted_price_usd: amount },
      priceEvidence: [quote('/service_request/price_offered_by_staff', 'agent', swap(PRICE_QUOTE)), PRICE_EVIDENCE[1]],
    });
    const t = [OPENING, `Agent: ${talk}`, ...between, `Caller: ${PRICE_OK}`, `Agent: ${COMMIT}`, `Caller: ${ACCEPT}`].join('\n');
    return { ex, t };
  };
  const verdict = (spoken, amount, opts) => { const { ex, t } = withSpoken(spoken, amount, opts); return grounded(ex, t); };

  test('the parser: closed set, well-formed runs of 20+ only, ambiguity is NaN', () => {
    const cases = {
      'a hundred forty nine dollars': [149], 'one hundred and fifty': [150], 'two hundred fifty': [250], 'fifteen hundred': [1500],
      'forty-nine': [49], 'a thousand': [1000], 'two thousand five hundred': [2500], 'twenty one hundred': [2100], seventy: [70],
      'one fifty': [NaN], 'two thirty': [NaN], 'hundred fifty': [NaN],
      // prose and sub-$20 numbers are not figures
      'Thursday at two': [], 'one of our technicians': [], nineteen: [], 'a lot': [],
    };
    for (const [text, want] of Object.entries(cases)) expect([text, spokenFiguresIn(text)]).toEqual([text, want]);
  });

  test('"a hundred forty nine dollars" is the amount 149: an offer in words grounds', () => {
    expect(verdict('a hundred forty nine dollars', 149)).toEqual({ ok: true, reason: 'dictated_booking_grounded', mode: 'staff_stated' });
    expect(verdict('one hundred and forty nine dollars', 149).ok).toBe(true);
    expect(verdict('one hundred fifty dollars', 150).ok).toBe(true);
  });

  test('the wrong amount in words does not ground', () => {
    expect(verdict('a hundred forty nine dollars', 150)).toEqual({ ok: false, reason: 'price_not_stated_by_staff' });
  });

  test('"one fifty" is AMBIGUOUS (150 or 1:50 or 1 and 50): it fails closed, so the office books it', () => {
    expect(verdict('one fifty', 150)).toEqual({ ok: false, reason: 'price_not_stated_by_staff' });
    expect(verdict('one fifty', 50).ok).toBe(false);
  });
});

describe('the embedded schemas let the staff price quote be words (codex #5377 r13 P2)', () => {
  test('model-output and persisted schema descriptions match the prompt', () => {
    for (const f of ['call-extraction.model-output.schema.json', 'call-extraction.persisted.schema.json']) {
      const s = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas', f), 'utf8'));
      const d = s.properties?.service_request?.properties?.price_offered_by_staff?.description
        || JSON.stringify(s).match(/"price_offered_by_staff":\{[^}]*"description":"([^"]*(?:\\"[^"]*)*)"/)?.[1] || '';
      expect(d).toMatch(/digits or words/);
      expect(d).not.toMatch(/the digits of the amount must appear/);
    }
  });
});

// The prompt/schema tell the model that ANY later correction or added charge makes the
// price non-final (owner ruling 2026-10-01: the AI judges the price language).
describe('price_is_final carries correction and added-charge language (owner ruling 2026-10-01)', () => {
  test('prompt and both schemas say a correction or an added charge, any amount, makes it false', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '../services/prompts/call-extraction-v1.js'), 'utf8');
    const line = prompt.split('\n').find((l) => l.startsWith('- price_is_final:'));
    expect(line).toMatch(/ADDED CHARGE/);
    expect(line).toMatch(/any amount and any phrasing/);
    expect(line).toMatch(/When in doubt, false/);
    for (const f of ['call-extraction.model-output.schema.json', 'call-extraction.persisted.schema.json']) {
      const raw = fs.readFileSync(path.join(__dirname, '../schemas', f), 'utf8');
      const d = JSON.parse(raw).properties?.service_request?.properties?.price_is_final?.description
        || raw.match(/"price_is_final": \{[\s\S]*?"description": "((?:[^"\\]|\\.)*)"/)[1];
      expect(d).toMatch(/ADDED CHARGE/);
      expect(d).toMatch(/When in doubt, false/);
    }
  });

  test('the deleted number scan is gone from the module', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-commercial-dictated-booking.js'), 'utf8');
    for (const gone of ['TIME_BEFORE', 'nonPriceContext', 'figuresIn(', 'QUANTITY_AFTER', 'STREET_WORDS', 'spokenFigureRuns']) expect(src).not.toContain(gone);
  });
});
