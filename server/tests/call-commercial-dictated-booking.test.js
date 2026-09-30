// Commercial dictated booking (owner ruling 2026-09-30, call-booker gates
// review item 8): a commercial job staff dictate on the call and the caller
// accepts — with a price agreed — books instead of always going to the office,
// on inbound AND outbound calls. Grounded with the reschedule agreement check
// (call-reschedule-agreement.js, reused unchanged): both quotes word for word
// in a turn of the right speaker. Fixtures are synthetic.
const fs = require('fs');
const path = require('path');
const { canAutoRoute } = require('../services/call-triage-flags');
const { commercialDictatedBookingGrounded } = require('../services/call-commercial-dictated-booking');
const { groundRescheduleAgreement } = require('../services/call-reschedule-agreement');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
// Wed Sep 23, 2026, 3 PM ET; the agreed slot is Thursday 2 PM.
const CALL_STARTED_AT = '2026-09-23T19:00:00Z';
const THURSDAY_2PM = '2026-09-24T14:00:00-04:00';
const PRICE_TALK = 'The quarterly service for the office is one hundred fifty dollars, does that work?';
const PRICE_OK = 'Yes, that price works for us.';
const COMMIT = 'We will see you Thursday at two in the afternoon.';
const ACCEPT = 'Yes, Thursday at two works for us.';
const WORDS = { day: 'Thursday', hour: 'two', period: 'in the afternoon' };
const TRANSCRIPT = [
  'Caller: Hi, I manage a small office and need pest control.',
  `Agent: ${PRICE_TALK}`,
  `Caller: ${PRICE_OK}`,
  `Agent: ${COMMIT}`,
  `Caller: ${ACCEPT}`,
].join('\n');

const quote = (fieldPath, speaker, text) => ({ field_path: fieldPath, speaker, quote: text });
function extraction({ flags = ['commercial_requires_quote'], scheduling = {}, evidence, service = {} } = {}) {
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
    evidence: evidence || [
      quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ],
  };
}
// The processor's options for a gate-ON call; `agentCommitFailOpen` is the
// inbound-only limit of the OLD path and must not matter to the new one.
const opts = (extra = {}) => ({
  commercialDictatedBooking: true, transcriptLabelsTrusted: true,
  transcript: TRANSCRIPT, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN,
  ...extra,
});
const route = (ex, extra) => canAutoRoute(ex, opts(extra));

describe('commercial dictated booking: canAutoRoute', () => {
  test('both quotes grounded + price agreed clears commercial_requires_quote and books (advisory card rides failedOpenFlags)', () => {
    const r = route(extraction());
    expect(r.allowed).toBe(true);
    expect(r.appointmentBlockingFlags || []).not.toContain('commercial_requires_quote');
    expect(r.failedOpenFlags).toEqual(['commercial_requires_quote']);
  });

  test('works the same on inbound and outbound (the old inbound-only limit does not apply)', () => {
    // Inbound shape: the old agent-commit path is also on. Outbound shape: off.
    expect(route(extraction(), { agentCommitFailOpen: true }).allowed).toBe(true);
    expect(route(extraction(), { agentCommitFailOpen: false }).allowed).toBe(true);
    // The processor passes the new option without any direction test.
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const lines = src.split('\n').filter((l) => l.includes('commercialDictatedBooking:'));
    expect(lines).toHaveLength(2);
    lines.forEach((l) => expect(l).not.toMatch(/isOutboundCall/));
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
    const ex = extraction({ scheduling: { caller_accepted_slot: false } });
    expect(route(ex).allowed).toBe(false);
    const noQuote = extraction({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
    ] });
    const r = route(noQuote);
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
  });

  test('the caller acceptance alone does not clear it (no staff commitment)', () => {
    expect(route(extraction({ scheduling: { agent_committed_booking: false } })).allowed).toBe(false);
    const noQuote = extraction({ evidence: [
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ] });
    expect(route(noQuote).allowed).toBe(false);
  });

  test('a quote found only in the OTHER speaker\'s turn fails closed (swapped speaker labels)', () => {
    // Every label swapped: the staff commitment now sits in a Caller turn.
    const swapped = TRANSCRIPT.replace(/^Caller:/gm, 'X:').replace(/^Agent:/gm, 'Caller:').replace(/^X:/gm, 'Agent:');
    expect(route(extraction(), { transcript: swapped }).allowed).toBe(false);
    // Only the agent line sits in a Caller turn.
    const agentAsCaller = TRANSCRIPT.replace(`Agent: ${COMMIT}`, `Caller: ${COMMIT}`);
    expect(route(extraction(), { transcript: agentAsCaller }).allowed).toBe(false);
    // Only the caller acceptance sits in an Agent turn.
    const callerAsAgent = TRANSCRIPT.replace(`Caller: ${ACCEPT}`, `Agent: ${ACCEPT}`);
    expect(route(extraction(), { transcript: callerAsAgent }).allowed).toBe(false);
    // The extraction pinned the quote to the wrong speaker.
    const misattributed = extraction({ evidence: [
      quote('/scheduling/agent_committed_booking', 'caller', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'agent', ACCEPT),
    ] });
    expect(route(misattributed).allowed).toBe(false);
  });

  test('an unlabeled or one-speaker transcript fails closed', () => {
    const unlabeled = TRANSCRIPT.replace(`Agent: ${COMMIT}`, COMMIT);
    expect(route(extraction(), { transcript: unlabeled }).allowed).toBe(false);
    expect(route(extraction(), { transcript: undefined }).allowed).toBe(false);
    expect(route(extraction(), { transcript: '' }).allowed).toBe(false);
    const oneSpeaker = `Agent: ${COMMIT}\nAgent: ${ACCEPT}`;
    expect(route(extraction(), { transcript: oneSpeaker }).allowed).toBe(false);
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
    for (const service of [{ quoted_price_usd: null }, {}]) {
      const ex = extraction({ service });
      if (!Object.keys(service).length) delete ex.service_request;
      const r = route(ex);
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
    }
    // A price stated but declined is not agreed.
    const declined = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 150, accepted: false, caller_response: 'declined' } } });
    expect(route(declined).allowed).toBe(false);
    // An accepted price entry (no quoted_price_usd) counts, like the estimator gate.
    const acceptedEntry = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 150, accepted: true, caller_response: 'accepted', unit: 'per_quarter' } } });
    expect(route(acceptedEntry).allowed).toBe(true);
    // A range is not one price.
    const range = extraction({ service: { quoted_price_usd: null, price: { amount_usd: 100, amount_max_usd: 150, accepted: true, caller_response: 'accepted' } } });
    expect(route(range).allowed).toBe(false);
  });

  test('needs the trusted-labels gate, a confirmed start and an on-the-hour start', () => {
    expect(route(extraction(), { transcriptLabelsTrusted: false }).allowed).toBe(false);
    expect(route(extraction({ scheduling: { status: 'tentative' } })).allowed).toBe(false);
    const halfPast = extraction({ scheduling: { confirmed_start_at: '2026-09-24T14:30:00-04:00' } });
    const r = route(halfPast);
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
  });

  test('the extraction\'s language judgements still apply (hedged promise, unjudged relative date)', () => {
    expect(route(extraction({ scheduling: { definite_commitment: false } })).allowed).toBe(false);
    expect(route(extraction({ scheduling: { definite_commitment: null } })).allowed).toBe(false);
    expect(route(extraction({ scheduling: { relative_date_used: null } })).allowed).toBe(false);
  });

  test('it only clears the commercial hold: every other hold and check still applies', () => {
    // Another hold beside it.
    const spam = route(extraction({ flags: ['commercial_requires_quote', 'spam_or_wrong_number'] }));
    expect(spam.allowed).toBe(false);
    expect(spam.appointmentBlockingFlags).toEqual(['spam_or_wrong_number']);
    // A third-party caller stays a hard block: this path does not clear it.
    const third = extraction({ flags: ['commercial_requires_quote', 'caller_not_authorized'] });
    third.caller = { relationship_to_property: 'tenant', on_site_authorization: false };
    const t = route(third);
    expect(t.allowed).toBe(false);
    expect(t.appointmentBlockingFlags).toEqual(['caller_not_authorized']);
    // HOA common-area approval is a different hold.
    expect(route(extraction({ flags: ['hoa_common_area_requires_approval'] })).allowed).toBe(false);
    // An unvalidated address still parks the call.
    const noAv = canAutoRoute(extraction(), opts({ addressValidation: undefined }));
    expect(noAv.allowed).toBe(false);
    expect(noAv.reason).toBe('address_not_validated');
    // Low confidence still blocks.
    const low = extraction();
    low.confidence = { overall: 0 };
    expect(route(low).reason).toBe('low_confidence');
  });

  test('a non-commercial call is unaffected either way', () => {
    // No commercial hold: books exactly as before, gate on or off.
    expect(route(extraction({ flags: [] })).allowed).toBe(true);
    expect(route(extraction({ flags: [] })).failedOpenFlags).toBeUndefined();
    // Not grounded and not commercial: still books (nothing to clear) …
    const ungrounded = route(extraction({ flags: [], evidence: [] }));
    expect(ungrounded.allowed).toBe(true);
    // … and a different hold is not cleared by grounded quotes.
    expect(route(extraction({ flags: ['spam_or_wrong_number'] })).allowed).toBe(false);
  });

  test('the old agent-commit path is untouched: the new option never clears caller_not_authorized', () => {
    // Only the new option on, old option off, and an ungrounded transcript for the old path.
    const ex = extraction({ flags: ['caller_not_authorized'] });
    ex.caller = { relationship_to_property: 'tenant', on_site_authorization: false };
    const r = canAutoRoute(ex, opts());
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(['caller_not_authorized']);
  });
});

describe('commercialDictatedBookingGrounded', () => {
  const grounded = (ex, transcript = TRANSCRIPT) => commercialDictatedBookingGrounded({ v2: ex, transcript, callStartedAt: CALL_STARTED_AT });

  test('grounds a confirmed new booking with a price agreed', () => {
    expect(grounded(extraction())).toEqual({ ok: true, reason: 'dictated_booking_grounded' });
  });

  test('reports why it failed', () => {
    expect(grounded(extraction({ service: { quoted_price_usd: null } }))).toEqual({ ok: false, reason: 'no_price_agreed' });
    expect(grounded(extraction({ scheduling: { status: 'reschedule_requested' } }))).toEqual({ ok: false, reason: 'not_confirmed' });
    expect(grounded(extraction({ scheduling: { moved_appointment_date: '2026-09-25' } }))).toEqual({ ok: false, reason: 'moves_existing_visit' });
    expect(grounded(extraction({ evidence: [] }))).toEqual({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(grounded(extraction({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
    ] }))).toEqual({ ok: false, reason: 'caller_acceptance_ungrounded' });
    expect(grounded(extraction(), `Caller: hi\nAgent: ${COMMIT}\nCaller: Thanks, bye.`)).toEqual({ ok: false, reason: 'caller_acceptance_ungrounded' });
    expect(grounded(undefined)).toEqual({ ok: false, reason: 'no_scheduling' });
  });

  test('is exactly the reschedule grounding underneath (same verdict on the same quotes)', () => {
    const ex = extraction();
    const direct = groundRescheduleAgreement({ v2: ex, transcript: TRANSCRIPT, callStartedAt: CALL_STARTED_AT });
    expect(direct.ok).toBe(true);
    const bad = extraction({ scheduling: { definite_commitment: false } });
    const directBad = groundRescheduleAgreement({ v2: bad, transcript: TRANSCRIPT, callStartedAt: CALL_STARTED_AT });
    expect(grounded(bad)).toEqual({ ok: false, reason: directBad.reason });
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
