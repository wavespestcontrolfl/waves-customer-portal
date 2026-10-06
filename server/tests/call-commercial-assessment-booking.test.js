// A commercial Waves Assessment that Waves staff book on the call with NO price
// discussed auto-books, on OUTBOUND callback calls (lead_auto_bridge) as well as
// inbound (owner ruling 2026-10-06, GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING).
// The priced commercial path (owner ruling 2026-09-30) is untouched: any price
// mentioned on the call goes to it. Outbound speaker labels have swapped, so an
// outbound call also needs a deterministic staff-identity anchor in the words.
// Fixtures are synthetic.
const fs = require('fs');
const path = require('path');
const { canAutoRoute } = require('../services/call-triage-flags');
const { commercialDictatedBookingGrounded, outboundStaffIdentityProven, priceDiscussed } = require('../services/call-commercial-dictated-booking');
const { groundNewBookingAgreement } = require('../services/call-reschedule-agreement');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
// Wed Sep 23, 2026, 3 PM ET; the agreed slot is Thursday noon.
const CALL_STARTED_AT = '2026-09-23T19:00:00Z';
const THURSDAY_NOON = '2026-09-24T12:00:00-04:00';
const PROPOSAL = 'How does noon on Thursday sound?';
const ACCEPT = 'Perfect.';
const COMMIT = "I'll book you for that, and we'll see you then";
const COMMIT_TURN = `Awesome. ${COMMIT}.`;
const INTRO = 'Hey Jordan, this is Alex with Waves. How are you?';
const lines = ({ intro = `Agent: ${INTRO}`, proposal = `Agent: ${PROPOSAL}`, accept = `Caller: ${ACCEPT}`, commit = `Agent: ${COMMIT_TURN}`, between = [] } = {}) => [
  intro, 'Caller: Good, thanks.',
  'Agent: I am following up on your request for an assessment at the office.', 'Caller: Great, thank you.',
  proposal, ...between, accept, commit,
].join('\n');
const OUTBOUND = lines();
const swap = (t) => t.replace(/^Caller:/gm, 'X:').replace(/^Agent:/gm, 'Caller:').replace(/^X:/gm, 'Agent:');

const ASSESSMENT_ROW = { id: 'svc-assess', service_key: 'lawn_inspection', name: 'Waves Assessment', short_name: 'Assessment', billing_type: 'one_time', pricing_type: 'fixed', base_price: '0.00' };
const ONE_TIME_ROW = { id: 'svc-roach', service_key: 'cockroach_control', name: 'Cockroach Control Service', short_name: 'Cockroach Control', billing_type: 'one_time', pricing_type: 'fixed', base_price: '350.00' };
const RECURRING_ROW = { id: 'svc-pest-q', service_key: 'pest_general_quarterly', name: 'General Pest Control (Quarterly)', short_name: 'Pest Quarterly', billing_type: 'recurring', pricing_type: 'variable', base_price: '65.00' };

const quote = (fieldPath, speaker, text) => ({ field_path: fieldPath, speaker, quote: text });
const AGENT_PROPOSED_EVIDENCE = [
  quote('/scheduling/confirmed_start_at', 'agent', PROPOSAL),
  quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
  quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
];
function extraction({ flags = ['commercial_requires_quote'], scheduling = {}, service = {}, evidence = AGENT_PROPOSED_EVIDENCE } = {}) {
  return {
    triage_flags: flags,
    confidence: { overall: 0.9 },
    consent: {},
    caller: { relationship_to_property: 'owner', on_site_authorization: true },
    property: { property_type: 'commercial' },
    scheduling: {
      status: 'confirmed', confirmed_start_at: THURSDAY_NOON,
      agent_committed_booking: true, caller_accepted_slot: true,
      definite_commitment: true, relative_date_used: false, moved_appointment_relative_date_used: null,
      agreed_slot_words: { day: 'Thursday', hour: 'noon', period: null },
      ...scheduling,
    },
    service_request: {
      specific_service_name: 'Waves Assessment', service_intent: 'inspection_only',
      quoted_price_usd: null, prices: [], price: { amount_usd: null }, price_offered_by_staff: null, price_accepted_by_caller: null,
      ...service,
    },
    evidence,
  };
}

// The processor's options for a gate-ON no-price assessment lane.
const opts = (extra = {}) => ({
  commercialAssessmentBooking: true, commercialOutbound: true, commercialAssessmentBookable: () => true,
  transcriptLabelsTrusted: true, transcript: OUTBOUND, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN,
  ...extra,
});
const route = (ex, extra) => canAutoRoute(ex, opts(extra));
const assess = (extra = {}) => ({ bookable: () => true, outbound: true, ...extra });
const grounded = (ex = extraction(), transcript = OUTBOUND, args = {}) => commercialDictatedBookingGrounded({
  v2: ex, transcript, callStartedAt: CALL_STARTED_AT, pricedPath: false, assessmentBooking: assess(), ...args,
});

describe('the real shape: staff propose the slot, the caller says yes, staff commit (no price)', () => {
  test('outbound with a proper staff introduction books, as an agent-proposed agreement', () => {
    expect(grounded()).toEqual({ ok: true, reason: 'assessment_booking_grounded', mode: 'agent_proposed', assessment: true });
    const r = route(extraction());
    expect(r.allowed).toBe(true);
    expect(r.appointmentBlockingFlags || []).not.toContain('commercial_requires_quote');
    // book-and-flag: the office still gets the advisory card
    expect(r.failedOpenFlags).toEqual(['commercial_requires_quote']);
    expect(r.gateDemotedFlags).toEqual(['commercial_requires_quote']);
  });

  test('inbound books too, with no introduction needed', () => {
    const inbound = OUTBOUND.replace(INTRO, 'Hello, thanks for calling Waves.');
    expect(grounded(extraction(), inbound, { assessmentBooking: assess({ outbound: false }) }).ok).toBe(true);
    expect(route(extraction(), { commercialOutbound: false, transcript: inbound }).allowed).toBe(true);
  });

  test('the agent-proposed shape is read only by the assessment lane (the priced path and reschedules never see it)', () => {
    const args = { v2: extraction(), transcript: OUTBOUND, callStartedAt: CALL_STARTED_AT };
    expect(groundNewBookingAgreement(args).ok).toBe(false);
    expect(groundNewBookingAgreement({ ...args, allowAgentProposed: false }).ok).toBe(false);
    expect(groundNewBookingAgreement({ ...args, allowAgentProposed: true })).toMatchObject({ ok: true, mode: 'agent_proposed' });
  });

  test('a staff-stated commitment and a caller proposal still ground in the assessment lane (the existing modes)', () => {
    const stated = 'Awesome. We will see you Thursday at noon.';
    const ex = extraction({ evidence: [
      quote('/scheduling/confirmed_start_at', 'agent', 'We will see you Thursday at noon'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Yes, Thursday at noon works for us.'),
      quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at noon'),
    ] });
    const t = lines({ proposal: `Agent: ${stated}`, accept: 'Caller: Yes, Thursday at noon works for us.', commit: 'Agent: Great.' });
    expect(grounded(ex, t)).toMatchObject({ ok: true, mode: 'staff_stated' });
  });
});

describe('other phrasings of the same shape', () => {
  const variant = ({ proposal, accept, commitTurn, commit, words, start }) => ({
    ex: extraction({
      scheduling: { agreed_slot_words: words, confirmed_start_at: start },
      evidence: [quote('/scheduling/confirmed_start_at', 'agent', proposal), quote('/scheduling/caller_accepted_slot', 'caller', accept), quote('/scheduling/agent_committed_booking', 'agent', commit)],
    }),
    transcript: lines({ proposal: `Agent: ${proposal}`, accept: `Caller: ${accept}`, commit: `Agent: ${commitTurn}` }),
  });

  test('a digit time with a period, a longer acceptance and a short commitment ground', () => {
    const { ex, transcript } = variant({
      proposal: 'How about Thursday at 10 AM?', accept: 'Yes, that works for us.', commitTurn: "Perfect, you're all set.", commit: "Perfect, you're all set.",
      words: { day: 'Thursday', hour: '10', period: 'AM' }, start: '2026-09-24T10:00:00-04:00',
    });
    expect(grounded(ex, transcript)).toMatchObject({ ok: true, mode: 'agent_proposed' });
  });

  test('a caller who restates the slot in the yes grounds only when it is THIS slot', () => {
    const base = { proposal: PROPOSAL, commitTurn: COMMIT_TURN, commit: COMMIT, words: { day: 'Thursday', hour: 'noon', period: null }, start: THURSDAY_NOON };
    const same = variant({ ...base, accept: 'Yes, Thursday at noon works for us.' });
    expect(grounded(same.ex, same.transcript).ok).toBe(true);
    const other = variant({ ...base, accept: 'Yes, but Friday at noon works better for us.' });
    expect(grounded(other.ex, other.transcript).ok).toBe(false);
  });
});

describe('outbound staff identity (the labels are LLM-inferred and have swapped)', () => {
  test('the predicate: an Agent turn introduces itself as Waves, no Caller turn does', () => {
    expect(outboundStaffIdentityProven(OUTBOUND)).toBe(true);
    for (const intro of ['this is Alex with Waves', 'This is Alex from Waves Pest Control', 'this is Alex Smith at WAVES', 'this is Alex, with Waves']) {
      expect(outboundStaffIdentityProven(OUTBOUND.replace('this is Alex with Waves', intro))).toBe(true);
    }
    for (const intro of ['this is Alex', 'this is Alex with Wave Cleaning', 'Alex with Waves here', 'it is Alex with Waves']) {
      expect(outboundStaffIdentityProven(OUTBOUND.replace('this is Alex with Waves', intro))).toBe(false);
    }
  });

  test('the introduction is a plain first-person assertion that opens the turn: no question, negation or reported speech (codex #6046 r1 P1)', () => {
    const withAgentTurn = (text) => OUTBOUND.replace(`Agent: ${INTRO}`, `Agent: ${text}`);
    for (const ok of ['Hi, this is Alex with Waves.', 'Good morning Jordan, this is Alex Smith from Waves Pest Control. How are you?', 'Hello Jordan this is Alex at Waves']) {
      expect([ok, outboundStaffIdentityProven(withAgentTurn(ok))]).toEqual([ok, true]);
    }
    for (const bad of [
      'this is Alex with Waves?', 'Is this Alex with Waves?', 'this is not Alex with Waves.', 'this is Alex not with Waves.', 'this is never Alex with Waves.',
      'You told me this is Alex with Waves.', 'I think this is Alex with Waves', 'Hey, how are you, this is Alex with Waves', 'They said this is Alex with Waves.',
    ]) {
      expect([bad, outboundStaffIdentityProven(withAgentTurn(bad))]).toEqual([bad, false]);
    }
    // a Caller turn saying it ANYWHERE fails the whole proof (the labels are in doubt)
    expect(outboundStaffIdentityProven(OUTBOUND.replace('Caller: Good, thanks.', 'Caller: Good, and this is Jordan with Waves too.'))).toBe(false);
    expect(outboundStaffIdentityProven('')).toBe(false);
    expect(outboundStaffIdentityProven(undefined)).toBe(false);
    expect(outboundStaffIdentityProven(OUTBOUND.replace('Agent: Hey Jordan', 'Hey Jordan'))).toBe(false); // an unlabeled line
  });

  test('swapped labels hold: the introduction sits in a Caller turn', () => {
    const swapped = swap(OUTBOUND);
    expect(outboundStaffIdentityProven(swapped)).toBe(false);
    expect(grounded(extraction(), swapped)).toEqual({ ok: false, reason: 'outbound_staff_identity_unproven' });
    expect(route(extraction(), { transcript: swapped }).allowed).toBe(false);
  });

  test('both sides introducing themselves as Waves, or neither, holds', () => {
    const both = OUTBOUND.replace('Caller: Good, thanks.', 'Caller: Hi, this is Jordan with Waves.');
    const none = OUTBOUND.replace('this is Alex with Waves', 'I am calling about your request');
    for (const t of [both, none]) {
      expect(grounded(extraction(), t)).toEqual({ ok: false, reason: 'outbound_staff_identity_unproven' });
      expect(route(extraction(), { transcript: t }).allowed).toBe(false);
    }
  });

  test('the proof applies to OUTBOUND only', () => {
    const none = OUTBOUND.replace('this is Alex with Waves', 'I am calling about your request');
    expect(grounded(extraction(), none, { assessmentBooking: assess({ outbound: false }) }).ok).toBe(true);
  });

  test('a swapped transcript whose introduction line lands on the right side but whose commitment is the caller\'s still fails the speaker grounding', () => {
    // the introduction is staff-side, but the agreement lines are on the other side
    const t = [
      `Agent: ${INTRO}`, 'Caller: Good, thanks.',
      `Caller: ${PROPOSAL}`, `Agent: ${ACCEPT}`, `Caller: ${COMMIT_TURN}`,
    ].join('\n');
    expect(outboundStaffIdentityProven(t)).toBe(true);
    expect(grounded(extraction(), t).ok).toBe(false);
  });
});

describe('no price discussed: the assessment mode; any price: the priced path decides', () => {
  const PRICED = (extra = {}) => extraction({ service: { quoted_price_usd: 150, price_offered_by_staff: true, price_accepted_by_caller: true, price_is_final: true, ...extra } });

  test('priceDiscussed reads the extracted amounts, the judgements and the transcript', () => {
    expect(priceDiscussed({}, OUTBOUND)).toBe(false);
    expect(priceDiscussed({ quoted_price_usd: null, prices: [], price: { amount_usd: null } }, OUTBOUND)).toBe(false);
    expect(priceDiscussed({ quoted_price_usd: 150 }, OUTBOUND)).toBe(true);
    expect(priceDiscussed({ quoted_price_usd: 0 }, OUTBOUND)).toBe(true);
    expect(priceDiscussed({ price: { amount_usd: 99 } }, OUTBOUND)).toBe(true);
    expect(priceDiscussed({ prices: [{ amount_usd: null, amount_max_usd: 120 }] }, OUTBOUND)).toBe(true);
    expect(priceDiscussed({ price_offered_by_staff: true }, OUTBOUND)).toBe(true);
    expect(priceDiscussed({ price_accepted_by_caller: true }, OUTBOUND)).toBe(true);
    // ANY non-null judgement means price talk happened: false counts, only null means none (codex #6046 r1 P1)
    for (const j of ['price_offered_by_staff', 'price_accepted_by_caller', 'price_is_final']) {
      expect([j, priceDiscussed({ [j]: false }, OUTBOUND)]).toEqual([j, true]);
      expect([j, priceDiscussed({ [j]: true }, OUTBOUND)]).toEqual([j, true]);
      expect([j, priceDiscussed({ [j]: null }, OUTBOUND)]).toEqual([j, false]);
      expect([j, priceDiscussed({ [j]: undefined }, OUTBOUND)]).toEqual([j, false]);
      expect([j, grounded(extraction({ service: { [j]: false } }))]).toEqual([j, { ok: false, reason: 'price_discussed' }]);
      expect([j, route(extraction({ service: { [j]: false } })).allowed]).toEqual([j, false]);
    }
    expect(priceDiscussed({}, `${OUTBOUND}\nAgent: It is $150.`)).toBe(true);
    expect(priceDiscussed({}, `${OUTBOUND}\nAgent: It is a hundred dollars.`)).toBe(true);
    expect(priceDiscussed({}, `${OUTBOUND}\nAgent: Forty bucks.`)).toBe(true);
  });

  test('a price mentioned (extracted) never books in the assessment mode: the priced path is off here', () => {
    expect(grounded(PRICED())).toEqual({ ok: false, reason: 'price_discussed' });
    expect(route(PRICED()).allowed).toBe(false);
    expect(route(extraction({ service: { price: { amount_usd: 75, accepted: false, caller_response: 'declined' } } })).allowed).toBe(false);
  });

  test('a price in the transcript that the extraction missed also goes to the priced path', () => {
    const talk = OUTBOUND.replace('Great, thank you.', 'Great, how much is it? Agent: The visit is $150. Caller: Okay.').replace(' Agent: The visit', '\nAgent: The visit').replace(' Caller: Okay.', '\nCaller: Okay.');
    expect(grounded(extraction(), talk)).toEqual({ ok: false, reason: 'price_discussed' });
  });

  test('with the priced path ALSO on, a price mentioned is decided by it, unchanged (no_price_agreed / its own terms)', () => {
    // the extraction names a price judgement but no quoted total: the priced terms fail it
    const r = grounded(extraction({ service: { price_offered_by_staff: true } }), OUTBOUND, { pricedPath: true });
    expect(r).toEqual({ ok: false, reason: 'no_price_agreed' });
    // the no-price lane does not pick it up
    expect(grounded(extraction(), OUTBOUND, { pricedPath: true }).assessment).toBe(true);
  });

  test('both lanes on, a priced job on the priced path books exactly as before', () => {
    const PRICE_TALK = 'The quarterly service for the office is $150, does that work?';
    const PRICE_QUOTE = 'The quarterly service for the office is $150';
    const PRICE_OK = 'Yes, that price works for us.';
    const COMMIT_P = 'We will see you Thursday at two in the afternoon.';
    const ACCEPT_P = 'Yes, Thursday at two works for us.';
    const t = ['Caller: Hi, I manage a small office and need pest control.', `Agent: ${PRICE_TALK}`, `Caller: ${PRICE_OK}`, `Agent: ${COMMIT_P}`, `Caller: ${ACCEPT_P}`].join('\n');
    const ex = {
      ...extraction({ evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', COMMIT_P),
        quote('/scheduling/confirmed_start_at', 'agent', COMMIT_P),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT_P),
        quote('/service_request/price_offered_by_staff', 'agent', PRICE_QUOTE),
        quote('/service_request/price_accepted_by_caller', 'caller', PRICE_OK),
      ], scheduling: { confirmed_start_at: '2026-09-24T14:00:00-04:00', agreed_slot_words: { day: 'Thursday', hour: 'two', period: 'in the afternoon' } } }),
    };
    ex.service_request = {
      ...ex.service_request, quoted_price_usd: 150, price_offered_by_staff: true, price_accepted_by_caller: true, price_is_final: true,
      price: { amount_usd: 150, accepted: true, caller_response: 'accepted', unit: 'unknown' },
      prices: [{ amount_usd: 150, accepted: true, caller_response: 'accepted', unit: 'unknown' }],
    };
    const priced = commercialDictatedBookingGrounded({ v2: ex, transcript: t, callStartedAt: CALL_STARTED_AT, quoteBookable: () => true, pricedPath: true, assessmentBooking: assess({ outbound: false }) });
    expect(priced).toEqual({ ok: true, reason: 'dictated_booking_grounded', mode: 'staff_stated' });
    expect(canAutoRoute(ex, {
      commercialDictatedBooking: true, commercialAssessmentBooking: true, commercialOutbound: false, commercialAssessmentBookable: () => true,
      commercialQuoteBookable: () => true, transcriptLabelsTrusted: true, transcript: t, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN,
    }).allowed).toBe(true);
  });
});

describe('the service must be the Waves Assessment on every view', () => {
  const { commercialAssessmentBookableFor } = require('../services/call-recording-processor')._test;
  const services = [ASSESSMENT_ROW, ONE_TIME_ROW, RECURRING_ROW];
  const v2For = (name) => ({ ...extraction(), service_request: { ...extraction().service_request, specific_service_name: name, requested_service: name } });
  const check = (extracted, pre = null, transcription = OUTBOUND, svcs = services) => commercialAssessmentBookableFor({ extracted, preAdoptionExtracted: pre, transcription, services: svcs });
  const ASSESS = { requested_service: 'Waves Assessment', matched_service: 'Waves Assessment', specific_service_name: 'Waves Assessment' };

  test('a non-assessment service holds', () => {
    const ex = v2For(ONE_TIME_ROW.name);
    const bad = check({ requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name });
    expect(bad(ex)).toBe(false);
    expect(grounded(ex, OUTBOUND, { assessmentBooking: assess({ bookable: bad }) })).toEqual({ ok: false, reason: 'assessment_service_not_resolved' });
    expect(route(ex, { commercialAssessmentBookable: bad }).allowed).toBe(false);
  });

  test('the catalog row is the shared assessment identity (isAssessmentServiceRow), not a name regex (codex #6046 r1 P1)', () => {
    const { isAssessmentServiceRow } = require('../services/assessment-booking');
    const KEY_ONLY = { ...ASSESSMENT_ROW, name: 'Waves Assessment (legacy)' }; // matches by service_key alone
    expect(isAssessmentServiceRow(KEY_ONLY)).toBe(true);
    const keyOnlyView = { requested_service: KEY_ONLY.name, matched_service: KEY_ONLY.name, specific_service_name: KEY_ONLY.name };
    expect(check(keyOnlyView, null, OUTBOUND, [KEY_ONLY, ONE_TIME_ROW])(v2For(KEY_ONLY.name))).toBe(true);
    const NOT_IT = { ...ASSESSMENT_ROW, service_key: 'waves_assessment_plus', name: 'Waves Assessment Plus' };
    expect(isAssessmentServiceRow(NOT_IT)).toBe(false);
    const notItView = { requested_service: NOT_IT.name, matched_service: NOT_IT.name, specific_service_name: NOT_IT.name };
    expect(check(notItView, null, OUTBOUND, [NOT_IT, ONE_TIME_ROW])(v2For(NOT_IT.name))).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toContain("const { isAssessmentServiceRow } = require('./assessment-booking');");
    expect(src).not.toMatch(/waves assessment\$\/i\.test\(String\(row/);
  });

  test('the assessment on every view books', () => {
    const ok = check(ASSESS, ASSESS);
    expect(ok(v2For('Waves Assessment'))).toBe(true);
    expect(route(v2For('Waves Assessment'), { commercialAssessmentBookable: ok }).allowed).toBe(true);
  });

  test('one view resolving elsewhere holds (the V1 pick before V2 adoption, or the V2 pick)', () => {
    const v1Elsewhere = check(ASSESS, { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name });
    expect(v1Elsewhere(v2For('Waves Assessment'))).toBe(false);
    const v2Elsewhere = check(ASSESS, ASSESS);
    const v2Pick = v2For(ONE_TIME_ROW.name);
    v2Pick.meta = { schema_version: '1.21.0' }; // a real V2 record: its service overrides the V1 pick at booking
    expect(v2Elsewhere(v2Pick)).toBe(false);
  });

  test('no catalog, no match, no assessment row, a re-service revisit and any error fail closed', () => {
    expect(check(ASSESS, null, OUTBOUND, [])(v2For('Waves Assessment'))).toBe(false);
    expect(check(ASSESS, null, OUTBOUND, null)(v2For('Waves Assessment'))).toBe(false);
    expect(check(ASSESS, null, OUTBOUND, [ONE_TIME_ROW, RECURRING_ROW])(v2For('Waves Assessment'))).toBe(false);
    expect(check({ requested_service: 'Nothing Known', matched_service: 'Nothing Known' })(v2For('Nothing Known'))).toBe(false);
    expect(commercialAssessmentBookableFor({ extracted: null, services })(null)).toBe(false);
    expect(grounded(extraction(), OUTBOUND, { assessmentBooking: { outbound: true } })).toEqual({ ok: false, reason: 'assessment_service_not_resolved' });
    expect(grounded(extraction(), OUTBOUND, { assessmentBooking: assess({ bookable: () => 'true' }) })).toEqual({ ok: false, reason: 'assessment_service_not_resolved' });
  });

  test('the audits rebuild the pre-adoption view from the recorded V1 fields, and hold a V2 row with no record', () => {
    const { auditCommercialAssessmentBookableFor } = require('../services/call-recording-processor')._test;
    const v2 = v2For('Waves Assessment');
    v2.meta = { schema_version: '1.21.0' };
    const recordedElsewhere = { ...ASSESS, pre_adoption_service_fields: { requested_service: ONE_TIME_ROW.name, matched_service: ONE_TIME_ROW.name } };
    expect(auditCommercialAssessmentBookableFor({ extracted: recordedElsewhere, transcription: OUTBOUND, services })(v2)).toBe(false);
    expect(auditCommercialAssessmentBookableFor({ extracted: { ...ASSESS, pre_adoption_service_fields: {} }, transcription: OUTBOUND, services })(v2)).toBe(true);
    expect(auditCommercialAssessmentBookableFor({ extracted: ASSESS, transcription: OUTBOUND, services })(v2)).toBe(false);
    expect(auditCommercialAssessmentBookableFor({ extracted: ASSESS, transcription: OUTBOUND, services })(null)).toBe(true);
  });
});

describe('everything else still applies (the lane clears ONLY commercial_requires_quote)', () => {
  test('the agreement must be grounded word for word in the right speaker\'s turns', () => {
    const cases = {
      'the caller never accepted': extraction({ scheduling: { caller_accepted_slot: false } }),
      'staff never committed': extraction({ scheduling: { agent_committed_booking: null } }),
      'the commitment is not definite': extraction({ scheduling: { definite_commitment: false } }),
      'no acceptance pinned': extraction({ evidence: AGENT_PROPOSED_EVIDENCE.filter((e) => e.field_path !== '/scheduling/caller_accepted_slot') }),
      'no proposal pinned': extraction({ evidence: AGENT_PROPOSED_EVIDENCE.filter((e) => e.field_path !== '/scheduling/confirmed_start_at') }),
      'no commitment pinned': extraction({ evidence: AGENT_PROPOSED_EVIDENCE.filter((e) => e.field_path !== '/scheduling/agent_committed_booking') }),
      'the proposal quote is pinned to the caller': extraction({ evidence: [quote('/scheduling/confirmed_start_at', 'caller', PROPOSAL), ...AGENT_PROPOSED_EVIDENCE.slice(1)] }),
      'a fabricated commitment quote': extraction({ evidence: [...AGENT_PROPOSED_EVIDENCE.slice(0, 2), quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at noon, guaranteed')] }),
      'the slot words are another hour': extraction({ scheduling: { agreed_slot_words: { day: 'Thursday', hour: 'one', period: null } } }),
      'the slot words are another day': extraction({ scheduling: { agreed_slot_words: { day: 'Friday', hour: 'noon', period: null } } }),
      'a relative date': extraction({ scheduling: { relative_date_used: true } }),
      'moves an existing visit': extraction({ scheduling: { moved_appointment_date: '2026-09-25' } }),
    };
    for (const [why, ex] of Object.entries(cases)) {
      expect([why, grounded(ex).ok]).toEqual([why, false]);
      expect([why, route(ex).allowed]).toEqual([why, false]);
    }
  });

  test('the three turns must be consecutive: proposal, the caller\'s whole-turn yes, staff\'s commitment', () => {
    expect(grounded(extraction(), lines({ between: ['Caller: Hold on a second.', 'Agent: Sure.'] })).ok).toBe(false); // the proposal is no longer the turn before the yes
    expect(grounded(extraction(), lines({ commit: `Caller: Okay.\nAgent: ${COMMIT_TURN}` })).ok).toBe(false); // the commitment is not the very next turn
    expect(grounded(extraction(), lines({ accept: 'Caller: Perfect, thank you very much.' })).ok).toBe(false); // the pinned yes is not the whole turn
  });

  test('a caller who does not simply accept, a hedged or conditional commitment, and another slot in the last turns hold', () => {
    expect(grounded(extraction(), lines({ accept: 'Caller: No.' }), { v2: extraction({ evidence: [AGENT_PROPOSED_EVIDENCE[0], quote('/scheduling/caller_accepted_slot', 'caller', 'No.'), AGENT_PROPOSED_EVIDENCE[2]] }) }).ok).toBe(false);
    const hedged = (text) => lines({ commit: `Agent: ${text}` });
    for (const text of ["Awesome. I'll book you for that if the schedule allows, and we'll see you then.", "Awesome. I'll book you for that, though I might have to move it, and we'll see you then."]) {
      const sentence = text.replace('Awesome. ', '').replace(/\.$/, '');
      const ex = extraction({ evidence: [AGENT_PROPOSED_EVIDENCE[0], AGENT_PROPOSED_EVIDENCE[1], quote('/scheduling/agent_committed_booking', 'agent', sentence)] });
      expect([text, grounded(ex, hedged(text)).ok]).toEqual([text, false]);
    }
    const another = "Awesome. I'll book you for that, and we'll see you Friday at two.";
    expect(grounded(extraction({ evidence: [AGENT_PROPOSED_EVIDENCE[0], AGENT_PROPOSED_EVIDENCE[1], quote('/scheduling/agent_committed_booking', 'agent', "I'll book you for that, and we'll see you Friday at two")] }), lines({ commit: `Agent: ${another}` })).ok).toBe(false);
    expect(grounded(extraction(), lines({ commit: `Agent: ${COMMIT_TURN} Does one o'clock work better?` })).ok).toBe(false);
  });

  test('a proposal that offers alternatives or another time does not ground', () => {
    for (const proposal of ['How does noon or one on Thursday sound?', 'How does noon on Thursday, or maybe Friday, sound?', 'How does around noon on Thursday sound?', 'How does noon on Thursday at three sound?', 'How about around noon on Thursday?', 'About noon on Thursday?']) {
      const sentence = proposal;
      const ex = extraction({ evidence: [quote('/scheduling/confirmed_start_at', 'agent', sentence), AGENT_PROPOSED_EVIDENCE[1], AGENT_PROPOSED_EVIDENCE[2]] });
      expect([proposal, grounded(ex, lines({ proposal: `Agent: ${proposal}` })).ok]).toEqual([proposal, false]);
    }
  });

  test('an unlabeled or one-speaker transcript fails closed', () => {
    expect(grounded(extraction(), `${OUTBOUND}\nstray line`).ok).toBe(false);
    expect(grounded(extraction(), `Agent: ${INTRO}\nAgent: ${PROPOSAL}\nAgent: ${ACCEPT}\nAgent: ${COMMIT_TURN}`).ok).toBe(false);
  });

  test('swapped labels on the agreement hold on inbound too (the speaker grounding)', () => {
    expect(grounded(extraction(), swap(OUTBOUND), { assessmentBooking: assess({ outbound: false }) }).ok).toBe(false);
  });

  test('canAutoRoute still needs trusted labels, a confirmed on-the-hour start and no forced Assessment demotion', () => {
    expect(route(extraction(), { transcriptLabelsTrusted: false }).allowed).toBe(false);
    expect(route(extraction({ scheduling: { confirmed_start_at: '2026-09-24T12:30:00-04:00' } })).allowed).toBe(false);
    expect(route(extraction({ scheduling: { status: 'ambiguous' } })).allowed).toBe(false);
    const both = route(extraction({ flags: ['commercial_requires_quote', 'ambiguous_pest_or_service'] }), { failOpen: true, unclearServiceAssessment: true, callerAni: '+19415550100' });
    expect(both.allowed).toBe(false);
    expect(both.appointmentBlockingFlags).toEqual(['commercial_requires_quote']);
  });

  test('another blocking hold still holds: the lane clears only commercial_requires_quote', () => {
    const spam = { ...extraction(), meta: { is_spam: true } };
    const r = route(spam);
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toContain('spam_or_wrong_number');
    // an address that is not validated still holds, exactly as before
    expect(route(extraction(), { addressValidation: { status: 'confirm_needed', inServiceArea: true } }).allowed).toBe(false);
  });
});

describe('gate off: byte-identical', () => {
  test('without the option the hold stays, outbound or inbound, whatever else rides along', () => {
    const { commercialAssessmentBooking: _on, ...off } = opts();
    for (const o of [off, { ...off, commercialAssessmentBooking: false }, { ...off, commercialAssessmentBooking: 'true' }]) {
      const r = canAutoRoute(extraction(), o);
      expect(r.allowed).toBe(false);
      expect(r.appointmentBlockingFlags).toContain('commercial_requires_quote');
    }
  });

  test('the priced path called as before (no new arguments) fails a no-price call exactly as it did', () => {
    expect(commercialDictatedBookingGrounded({ v2: extraction(), transcript: OUTBOUND, callStartedAt: CALL_STARTED_AT, quoteBookable: () => true }))
      .toEqual({ ok: false, reason: 'no_price_agreed' });
    expect(canAutoRoute(extraction(), { commercialDictatedBooking: true, transcriptLabelsTrusted: true, commercialQuoteBookable: () => true, transcript: OUTBOUND, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN }).allowed).toBe(false);
  });

  test('the new lane alone never opens the priced path', () => {
    expect(route(extraction({ service: { quoted_price_usd: 150, price_offered_by_staff: true, price_accepted_by_caller: true, price_is_final: true } })).allowed).toBe(false);
  });
});

describe('GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING: the processor predicate, the options and the audits', () => {
  const Processor = require('../services/call-recording-processor');
  const { buildFailOpenRoutingContext } = Processor;
  const { commercialAssessmentBookingActive, commercialAssessmentRoutingOptions, commercialDictatedBookingActive } = Processor._test;
  const gatesOf = ({ agentCommit = true, trusted = true, assessment = true, commercial = false, outboundBooking = true, v2Routing = true } = {}) => ({
    isEnabled: (g) => ({ callAgentCommitBooking: agentCommit, callAgentCommitTrustedLabels: trusted, callOutboundBooking: outboundBooking }[g] === true),
    assessmentLive: () => assessment,
    commercialLive: () => commercial,
    v2Routing,
  });
  const outbound = { direction: 'outbound', metadata: { type: 'lead_auto_bridge' }, transcription: OUTBOUND, created_at: CALL_STARTED_AT };
  const inbound = { direction: 'inbound', transcription: OUTBOUND, created_at: CALL_STARTED_AT };
  const build = (call = outbound, gates = gatesOf(), extra = {}) => buildFailOpenRoutingContext({
    call, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates, ...extra,
  }).options;
  const EXTRACTED = { requested_service: 'Waves Assessment', matched_service: 'Waves Assessment', specific_service_name: 'Waves Assessment' };

  test('the predicate: both directions, needs GATE_CALL_AGENT_COMMIT_BOOKING, off when its own gate is off', () => {
    expect(commercialAssessmentBookingActive(outbound, gatesOf())).toBe(true);
    expect(commercialAssessmentBookingActive(inbound, gatesOf())).toBe(true);
    expect(commercialAssessmentBookingActive(outbound, gatesOf({ agentCommit: false }))).toBe(false);
    expect(commercialAssessmentBookingActive(outbound, gatesOf({ assessment: false }))).toBe(false);
    // the priced lane keeps its inbound-only rule, whatever the new gate says
    expect(commercialDictatedBookingActive(outbound, gatesOf({ commercial: true }))).toBe(false);
    expect(commercialDictatedBookingActive(inbound, gatesOf({ commercial: true }))).toBe(true);
  });

  test('the options builder: {} when off, never calls the catalog builder; else direction and check ride along', () => {
    const never = () => { throw new Error('built while off'); };
    expect(commercialAssessmentRoutingOptions(outbound, never, gatesOf({ assessment: false }))).toEqual({});
    expect(commercialAssessmentRoutingOptions(outbound, never, gatesOf({ agentCommit: false }))).toEqual({});
    const check = () => true;
    expect(commercialAssessmentRoutingOptions(outbound, () => check, gatesOf())).toEqual({ commercialAssessmentBooking: true, commercialOutbound: true, commercialAssessmentBookable: check });
    expect(commercialAssessmentRoutingOptions(inbound, () => check, gatesOf())).toMatchObject({ commercialOutbound: false });
    expect(commercialAssessmentRoutingOptions({ direction: 'Outbound-API', metadata: { type: 'lead_auto_bridge' } }, () => check, gatesOf())).toMatchObject({ commercialOutbound: true });
  });

  test('outbound is eligible only as a lead callback bridge (metadata.type), inbound always (codex #6046 r1 P1)', () => {
    const gates = gatesOf();
    expect(commercialAssessmentBookingActive(outbound, gates)).toBe(true);
    expect(commercialAssessmentBookingActive({ ...outbound, metadata: JSON.stringify({ type: 'lead_auto_bridge' }) }, gates)).toBe(true); // a stored JSON string
    for (const metadata of [undefined, null, {}, { type: 'office_dial' }, { type: 'lead_auto_bridge_x' }, '{not json', 'null']) {
      expect([metadata, commercialAssessmentBookingActive({ direction: 'outbound', metadata }, gates)]).toEqual([metadata, false]);
    }
    expect(commercialAssessmentBookingActive({ direction: 'outbound' }, gates)).toBe(false);
    expect(commercialAssessmentBookingActive(inbound, gates)).toBe(true);
    expect(commercialAssessmentBookingActive({ direction: 'inbound', metadata: { type: 'office_dial' } }, gates)).toBe(true);
    // the audit builder reads the SAME predicate: an ordinary outbound call gets no assessment keys
    const ordinary = buildFailOpenRoutingContext({ call: { direction: 'outbound', transcription: OUTBOUND, created_at: CALL_STARTED_AT }, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates }).options;
    expect(Object.keys(ordinary).some((k) => /^commercial/.test(k))).toBe(false);
  });

  test('both live lanes and the audit builder derive it through that ONE predicate', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src.match(/\.\.\.commercialAssessmentRoutingOptions\(call, \(\) => commercialAssessmentBookableFor\(\{\s*extracted, preAdoptionExtracted, transcription, services: bookableCallServices,\s*\}\), \{ captured: assessmentLaneActive \}\),/g)).toHaveLength(2);
    expect(src).toMatch(/\.\.\.\(commercialAssessmentBookingActive\(call, gates\) \? auditCommercialAssessmentOptions\(/);
    const at = src.indexOf('function commercialAssessmentBookingActive');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain("enabled('callAgentCommitBooking')");
    expect(body).toContain('callCommercialAssessmentBookingLive');
    expect(body).toContain('isLeadCallbackBridge(call)');
    // the extraction is asked for the agent-proposed shape under the same predicate
    expect(src).toMatch(/\.\.\.\(assessmentLaneActive \? \{ agentProposedSlotCommitment: true \} : \{\}\)/);
  });

  test('the audit context carries the assessment lane for an outbound call, and never the priced switch', () => {
    const options = build();
    expect(options).toMatchObject({ commercialAssessmentBooking: true, commercialOutbound: true, transcriptLabelsTrusted: true, transcript: OUTBOUND });
    expect(options.commercialDictatedBooking).toBeUndefined();
    expect(options.commercialQuoteBookable).toBeUndefined();
    expect(typeof options.commercialAssessmentBookable).toBe('function');
    expect(new Date(options.callStartedAt).toISOString()).toBe(new Date(CALL_STARTED_AT).toISOString());
    // both lanes on, inbound: both ride along
    expect(build(inbound, gatesOf({ commercial: true }))).toMatchObject({ commercialDictatedBooking: true, commercialAssessmentBooking: true, commercialOutbound: false });
  });

  test('every gate-off shape is byte-identical: no commercial keys at all', () => {
    const base = { failOpen: false, callerAni: '+19415550100', knownCustomer: null };
    for (const options of [
      build(outbound, gatesOf({ assessment: false })),
      build(inbound, gatesOf({ assessment: false })),
      build(outbound, gatesOf({ agentCommit: false })),
    ]) {
      expect(options).toEqual(expect.objectContaining(base));
      expect(Object.keys(options).sort()).toEqual(Object.keys(base).sort());
    }
  });

  test('canAutoRoute over the audit context books the real shape (outbound lead_auto_bridge); gate off, or no catalog, holds it', () => {
    const ex = extraction();
    const route2 = (options) => canAutoRoute(ex, { contactPhone: '+19415550100', addressValidation: AV_CLEAN, ...options });
    const on = route2(build(outbound, gatesOf(), { bookableServices: [ASSESSMENT_ROW, ONE_TIME_ROW], extracted: EXTRACTED }));
    expect(on).toMatchObject({ allowed: true, gateDemotedFlags: ['commercial_requires_quote'], failedOpenFlags: ['commercial_requires_quote'] });
    expect(route2(build(outbound, gatesOf({ assessment: false }))).allowed).toBe(false);
    expect(route2(build(outbound)).allowed).toBe(false); // no catalog handed to the builder: fail closed
    // a swapped outbound transcript holds
    expect(route2(build({ ...outbound, transcription: swap(OUTBOUND) }, gatesOf(), { bookableServices: [ASSESSMENT_ROW, ONE_TIME_ROW], extracted: EXTRACTED })).allowed).toBe(false);
    // the same call over the live options builder reaches the same verdict
    const live = commercialAssessmentRoutingOptions(outbound, () => Processor._test.commercialAssessmentBookableFor({ extracted: EXTRACTED, preAdoptionExtracted: EXTRACTED, transcription: OUTBOUND, services: [ASSESSMENT_ROW, ONE_TIME_ROW] }), gatesOf());
    expect(canAutoRoute(ex, { addressValidation: AV_CLEAN, transcriptLabelsTrusted: true, transcript: OUTBOUND, callStartedAt: CALL_STARTED_AT, ...live }).allowed).toBe(true);
  });
});

describe('callCommercialAssessmentBookingLive (GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING)', () => {
  const gates = require('../config/feature-gates');
  const saved = process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING;
    else process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING = saved;
  });

  test('strict === \'true\', read at call time, dark by default', () => {
    delete process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING;
    expect(gates.callCommercialAssessmentBookingLive()).toBe(false);
    for (const v of ['TRUE', '1', 'yes', 'on', ' true', '']) {
      process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING = v;
      expect(gates.callCommercialAssessmentBookingLive()).toBe(false);
    }
    process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING = 'true';
    expect(gates.callCommercialAssessmentBookingLive()).toBe(true);
  });

  test('exported on its own line, and independent of the priced lane\'s gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(src).toMatch(/^module\.exports\.callCommercialAssessmentBookingLive = callCommercialAssessmentBookingLive;$/m);
    process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING = 'true';
    expect(gates.callCommercialDictatedBookingLive()).toBe(process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING === 'true');
  });
});

describe('the extraction prompt reads the agent-proposed shape only under the gate', () => {
  const { buildExtractionPrompt, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
  test('off: byte-identical (the option absent, undefined or false renders nothing); on: the block is added', () => {
    const base = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', {});
    for (const o of [{ agentProposedSlotCommitment: false }, { agentProposedSlotCommitment: undefined }, { agentProposedSlotCommitment: 'true' }]) {
      expect(buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', o)).toBe(base);
    }
    const on = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', { agentProposedSlotCommitment: true });
    expect(on).toContain('AGENT-PROPOSED SLOT');
    expect(base).not.toContain('AGENT-PROPOSED SLOT');
    expect(on.replace(/\nAGENT-PROPOSED SLOT[\s\S]*?\n(?=\n?Transcript:|PRIOR|\n)/, '')).not.toBe('');
    expect(PROMPT_HASH).toMatch(/^v22-/);
  });

  test('the persisted prompt version carries the block: its own cohort, gate-off byte-identical (codex #6046 r1 P1)', () => {
    const { extractionPromptVersion } = require('../services/prompts/call-extraction-v1');
    const names = ['Waves Assessment', 'Cockroach Control Service'];
    for (const n of [undefined, [], names]) {
      const base = extractionPromptVersion(n);
      for (const o of [undefined, {}, { agentProposedSlotCommitment: false }, { agentProposedSlotCommitment: 'true' }]) expect(extractionPromptVersion(n, o)).toBe(base);
      const on = extractionPromptVersion(n, { agentProposedSlotCommitment: true });
      expect(on).toBe(`${base}-aps`);
      expect(on).not.toBe(base);
    }
    expect(extractionPromptVersion([], {})).toBe(PROMPT_HASH);
    // both stamps (the extractor's and the processor's per-call one) pass the block's own switch
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toContain('promptVersion: extractionPromptVersion(opts.bookableServiceNames, { agentProposedSlotCommitment: opts.agentProposedSlotCommitment === true })');
    expect(src).toContain('const v2PromptVersion = extractionPromptVersion(bookableServiceNames, { agentProposedSlotCommitment: assessmentLaneActive });');
  });
});

describe('codex #6046 round 2', () => {
  const Processor = require('../services/call-recording-processor');
  const { commercialAssessmentBookingActive } = Processor._test;

  test('promotion readiness counts the -aps cohort as current while the lane is live, and only then', () => {
    const { currentPromptVersions } = require('../scripts/v2-promotion-readiness');
    const { extractionPromptVersion, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
    const names = ['Waves Assessment', 'Cockroach Control Service'];
    const off = currentPromptVersions(names);
    expect(off).toEqual([PROMPT_HASH, extractionPromptVersion(names)]);
    expect(off.some((v) => v.endsWith('-aps'))).toBe(false);
    expect(currentPromptVersions(names, { assessmentLane: false })).toEqual(off);
    const on = currentPromptVersions(names, { assessmentLane: true });
    expect(on).toEqual(expect.arrayContaining([...off, `${PROMPT_HASH}-aps`, extractionPromptVersion(names, { agentProposedSlotCommitment: true })]));
    expect(on).toContain(`${extractionPromptVersion(names)}-aps`);
    // the exact versions the processor stamps for an eligible call are all counted
    expect(on).toContain(extractionPromptVersion(names, { agentProposedSlotCommitment: true }));
    expect(on).toContain(extractionPromptVersion([], { agentProposedSlotCommitment: true }));
    // the script selects rows with that list, not a hand-built pair
    const src = fs.readFileSync(path.join(__dirname, '../scripts/v2-promotion-readiness.js'), 'utf8');
    expect(src).toContain(".whereIn('ai_extraction_prompt_version', currentVersions)");
    expect(src).toContain("commercialAssessmentBookingActive({ direction: 'inbound' })");
  });

  test('ONE read of the lane per processing pass: the prompt, the stamps and both routing lanes share it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    // the only direct reads inside processRecording's extraction pass: one const
    expect(src.match(/const assessmentLaneActive = commercialAssessmentBookingActive\(call\);/g)).toHaveLength(1);
    expect(src).not.toMatch(/agentProposedSlotCommitment: commercialAssessmentBookingActive\(call\)/);
    expect(src).not.toMatch(/\.\.\.\(commercialAssessmentBookingActive\(call\) \? \{ agentProposedSlotCommitment/);
    expect(src).toContain('extractionPromptVersion(bookableServiceNames, { agentProposedSlotCommitment: assessmentLaneActive })');
    expect(src).toContain('...(assessmentLaneActive ? { agentProposedSlotCommitment: true } : {}),');
    expect(src.match(/\}\), \{ captured: assessmentLaneActive \}\),/g)).toHaveLength(2);
    // every ai_extraction_prompt_version stamp in the pass uses the const's version
    expect(src.match(/ai_extraction_prompt_version: v2PromptVersion,/g).length).toBeGreaterThanOrEqual(2);
  });

  test('a captured value is handed back as is, whatever the gates say now', () => {
    const flipped = { isEnabled: () => false, assessmentLive: () => false };
    expect(commercialAssessmentBookingActive({ direction: 'inbound' }, { ...flipped, captured: true })).toBe(true);
    expect(commercialAssessmentBookingActive({ direction: 'inbound' }, { isEnabled: () => true, assessmentLive: () => true, captured: false })).toBe(false);
    const { commercialAssessmentRoutingOptions } = Processor._test;
    const never = () => { throw new Error('built'); };
    expect(commercialAssessmentRoutingOptions({ direction: 'inbound' }, never, { captured: false })).toEqual({});
    expect(commercialAssessmentRoutingOptions({ direction: 'inbound' }, () => () => true, { captured: true })).toMatchObject({ commercialAssessmentBooking: true });
  });

  test('the agent-proposed block is for NEW bookings and leaves the reschedule rule standing', () => {
    const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');
    const on = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', { agentProposedSlotCommitment: true });
    const block = on.slice(on.indexOf('AGENT-PROPOSED SLOT'), on.indexOf('Transcript:'));
    expect(block).toMatch(/NEW bookings only/);
    expect(block).toMatch(/never applies to a move of an existing appointment/);
    expect(block).toMatch(/RESCHEDULE RULE above stands/);
    expect(block).toMatch(/reschedule_requested/);
    expect(block).toMatch(/never overrides it/);
    expect(on).toContain('reschedule_requested'); // the rule itself stays in the prompt
  });

  test('the lane refuses when the extraction names an existing appointment being moved', () => {
    const moved = [
      { moved_appointment_date: '2026-09-25' },
      { moved_appointment_words: 'the 25th' },
      { moved_appointment_relative_date_used: true },
      { status: 'reschedule_requested' },
    ];
    for (const scheduling of moved) {
      const ex = extraction({ scheduling });
      expect([scheduling, grounded(ex).ok]).toEqual([scheduling, false]);
      expect([scheduling, route(ex).allowed]).toEqual([scheduling, false]);
    }
    expect(grounded(extraction({ scheduling: { moved_appointment_date: '2026-09-25' } })).reason).toBe('moves_existing_visit');
    // control: the same call with none of them books
    expect(grounded(extraction({ scheduling: { moved_appointment_date: null, moved_appointment_words: null, moved_appointment_relative_date_used: false } })).ok).toBe(true);
  });
});

describe('codex #6046 round 3', () => {
  const Processor = require('../services/call-recording-processor');
  const { commercialAssessmentBookingActive, outboundAutoBookingEnabled, commercialAssessmentRoutingOptions } = Processor._test;
  const gatesOf = ({ outboundBooking = true, v2Routing = true, assessment = true } = {}) => ({
    isEnabled: (g) => ({ callAgentCommitBooking: true, callAgentCommitTrustedLabels: true, callOutboundBooking: outboundBooking }[g] === true),
    assessmentLive: () => assessment, v2Routing,
  });
  const bridge = { direction: 'outbound', metadata: { type: 'lead_auto_bridge' } };
  const inbound = { direction: 'inbound' };

  test('outbound needs outbound booking creation too: either prerequisite off holds the lane inactive', () => {
    expect(commercialAssessmentBookingActive(bridge, gatesOf())).toBe(true);
    expect(commercialAssessmentBookingActive(bridge, gatesOf({ outboundBooking: false }))).toBe(false); // GATE_CALL_OUTBOUND_BOOKING off
    expect(commercialAssessmentBookingActive(bridge, gatesOf({ v2Routing: false }))).toBe(false); // V2 routing not enforced
    expect(commercialAssessmentBookingActive(bridge, gatesOf({ outboundBooking: false, v2Routing: false }))).toBe(false);
    // the new gate never authorizes outbound creation by itself
    expect(outboundAutoBookingEnabled(gatesOf({ assessment: true, outboundBooking: false }))).toBe(false);
    expect(outboundAutoBookingEnabled(gatesOf())).toBe(true);
    // the options (so routing) follow the same predicate
    const never = () => { throw new Error('built'); };
    expect(commercialAssessmentRoutingOptions(bridge, never, gatesOf({ outboundBooking: false }))).toEqual({});
    expect(commercialAssessmentRoutingOptions(bridge, never, gatesOf({ v2Routing: false }))).toEqual({});
  });

  test('inbound does not need the outbound prerequisites', () => {
    expect(commercialAssessmentBookingActive(inbound, gatesOf({ outboundBooking: false, v2Routing: false }))).toBe(true);
  });

  test('the creation path reads the SAME predicate, and the audit builder follows it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toContain('const outboundAutoBooking = isOutboundCall(call) && outboundAutoBookingEnabled();');
    const at = src.indexOf('function outboundAutoBookingEnabled');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toContain("enabled('callOutboundBooking')");
    expect(body).toContain('CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED');
    const { buildFailOpenRoutingContext } = Processor;
    const build = (gates) => buildFailOpenRoutingContext({ call: { ...bridge, transcription: 'Agent: x', created_at: CALL_STARTED_AT }, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates }).options;
    expect(build(gatesOf()).commercialAssessmentBooking).toBe(true);
    expect(build(gatesOf({ outboundBooking: false })).commercialAssessmentBooking).toBeUndefined();
  });

  describe('the gated prompt: one unambiguous rule for the agent-proposed shape', () => {
    const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');
    const on = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', { agentProposedSlotCommitment: true });
    const off = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', {});
    const fieldRule = (text) => text.slice(text.indexOf('- agent_committed_booking:'), text.indexOf('- caller_accepted_slot:'));
    const evidenceRule = (text) => text.slice(text.indexOf('- definite_commitment:'), text.indexOf('- relative_date_used:'));

    test('gate on: the field rule lists a THIRD exception and every "null" / "state both" line defers to it', () => {
      const rule = fieldRule(on);
      expect(rule).toContain('THREE EXCEPTIONS');
      expect(rule).not.toContain('TWO EXCEPTIONS');
      expect(rule).toContain('(3) An agent-proposed slot');
      // each instruction that would send this shape to null or to a day-and-time quote carries the exception
      expect(rule).toContain('not a bare acknowledgment (except in the exceptions listed below)');
      expect(rule).toContain('leave agent_committed_booking null (except in the exceptions listed below)');
      expect(rule.indexOf('(3) An agent-proposed slot')).toBeGreaterThan(rule.indexOf('leave agent_committed_booking null'));
    });

    test('gate on: the commitment-quote rule allows the bare commitment sentence for that shape', () => {
      const rule = evidenceRule(on);
      expect(rule).toContain("the agent's bare commitment sentence from the turn after the caller's yes");
      expect(rule).toContain('holds no day or time');
      expect(rule).toContain('MUST be the WHOLE clause that holds the day, date and time'); // the base rule still governs every other shape
    });

    test('gate off: none of it renders and the base rules read as before', () => {
      expect(off).not.toContain('THREE EXCEPTIONS');
      expect(off).not.toContain('(except in the exceptions listed below)');
      expect(off).not.toContain('(3) An agent-proposed slot');
      expect(off).not.toContain('bare commitment sentence from the turn after');
      expect(fieldRule(off)).toContain('TWO EXCEPTIONS');
      expect(fieldRule(off)).toContain('leave agent_committed_booking null (the booking can still be confirmed;');
      expect(buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', { agentProposedSlotCommitment: false })).toBe(off);
      // removing exactly the gated additions from the gate-on prompt gives the gate-off prompt back
      const stripped = on
        .replace(/\nAGENT-PROPOSED SLOT[\s\S]*?\n(?=\n)/, '')
        .replaceAll(' (except in the exceptions listed below)', '')
        .replace('THREE EXCEPTIONS', 'TWO EXCEPTIONS')
        .replace(/ \(3\) An agent-proposed slot[^\n]*?(?=\n)/, '')
        .replace(/ For that agent-proposed shape the commitment quote[^\n]*?(?= null when no slot was agreed)/, '');
      expect(stripped).toBe(off);
    });

    test('the -aps cohort suffix covers the rule edits (one switch renders the block and the rules)', () => {
      const { extractionPromptVersion } = require('../services/prompts/call-extraction-v1');
      expect(extractionPromptVersion([], { agentProposedSlotCommitment: true })).toMatch(/-aps$/);
      expect(on).not.toBe(off);
    });
  });
});
