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
      quoted_price_usd: null, prices: [], price: { amount_usd: null }, price_offered_by_staff: null, price_accepted_by_caller: null, price_discussed: false,
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
    expect(priceDiscussed({ price_discussed: false }, OUTBOUND)).toBe(false);
    expect(priceDiscussed({ price_discussed: false, quoted_price_usd: null, prices: [], price: { amount_usd: null } }, OUTBOUND)).toBe(false);
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
      expect([j, priceDiscussed({ price_discussed: false, [j]: null }, OUTBOUND)]).toEqual([j, false]);
      expect([j, priceDiscussed({ price_discussed: false, [j]: undefined }, OUTBOUND)]).toEqual([j, false]);
      expect([j, grounded(extraction({ service: { [j]: false } }))]).toEqual([j, { ok: false, reason: 'price_discussed' }]);
      expect([j, route(extraction({ service: { [j]: false } })).allowed]).toEqual([j, false]);
    }
    expect(priceDiscussed({ price_discussed: false }, `${OUTBOUND}\nAgent: It is $150.`)).toBe(true);
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
  const EXTRACTED = { requested_service: 'Waves Assessment', matched_service: 'Waves Assessment', specific_service_name: 'Waves Assessment', pre_adoption_price_fields: { quoted_price: null, quoted_price_usd: null, price: null, prices: null, price_amount_usd: null, price_amount_max_usd: null, quote_requested: null, quote_promised: null } };

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
    expect(commercialAssessmentRoutingOptions(outbound, () => check, gatesOf())).toEqual({ commercialAssessmentBooking: true, commercialOutbound: true, commercialAssessmentBookable: check, commercialAssessmentV1Views: [] });
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
    expect(src.match(/\.\.\.commercialAssessmentRoutingOptions\(call, \(\) => commercialAssessmentBookableFor\(\{\s*extracted, preAdoptionExtracted, transcription, services: bookableCallServices,\s*\}\), \{ captured: assessmentLaneActive \}, \[extracted, preAdoptionExtracted\]\),/g)).toHaveLength(2);
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
    expect(PROMPT_HASH).toMatch(/^v\d{2}-[0-9a-f]{12}$/);
  });

  test('the persisted prompt version carries the block: its own cohort, gate-off byte-identical (codex #6046 r1 P1)', () => {
    const { extractionPromptVersion, PROMPT_VERSION } = require('../services/prompts/call-extraction-v1');
    const names = ['Waves Assessment', 'Cockroach Control Service'];
    for (const n of [undefined, [], names]) {
      const base = extractionPromptVersion(n);
      for (const o of [undefined, {}, { agentProposedSlotCommitment: false }, { agentProposedSlotCommitment: 'true' }]) expect(extractionPromptVersion(n, o)).toBe(base);
      const on = extractionPromptVersion(n, { agentProposedSlotCommitment: true });
      expect(on).not.toBe(base);
      expect(on.startsWith(`${PROMPT_VERSION}a-`)).toBe(true); // the cohort mark sits INSIDE the leading version token
      expect(on.endsWith('-aps')).toBe(false);
      expect(on.startsWith(`${PROMPT_VERSION}a-`)).toBe(true);
      expect(on.endsWith('-aps')).toBe(false);
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

  test('promotion readiness: the main cohort stays on the unsuffixed versions; the -aps cohort runs the same checks on its own rows', async () => {
    const mod = require('../scripts/v2-promotion-readiness');
    expect(mod.currentPromptVersions).toBeUndefined();
    expect(mod.evaluateApsCohort).toBeUndefined(); // no separate, weaker scoring any more
    const src = fs.readFileSync(path.join(__dirname, '../scripts/v2-promotion-readiness.js'), 'utf8');
    // main()'s default query is origin/main's: the bare hash and the live catalog's version only
    expect(src).toContain("[...new Set([CURRENT_PROMPT_VERSION, LIVE_PROMPT_VERSION])]");
    expect(src).toContain('aps ? [apsCohortVersion(liveCatalogNames)]');
    expect(src).not.toMatch(/like.*APS_PROMPT_HASH/);
    // gate off: exactly one main() run with no arguments (output identical to main)
    const calls = [];
    const fake = (verdicts) => async (arg) => { calls.push(arg); return verdicts.shift(); };
    expect(await mod.runReadiness(fake([true]), {})).toBe(true);
    expect(await mod.runReadiness(fake([true]), { GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING: 'TRUE' })).toBe(true);
    expect(calls).toEqual([undefined, undefined]);
    // gate on: the -aps cohort runs FIRST through main, and its verdict goes to the main cohort's run
    calls.length = 0;
    const on = { GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING: 'true' };
    await mod.runReadiness(fake([true, true]), on);
    expect(calls).toEqual([{ aps: true }, { apsPass: true }]);
    calls.length = 0;
    await mod.runReadiness(fake([false, false]), on);
    expect(calls).toEqual([{ aps: true }, { apsPass: false }]);
    calls.length = 0;
    await mod.runReadiness(fake([undefined, false]), on);
    expect(calls[1]).toEqual({ apsPass: false }); // a cohort that returned nothing is not a pass
    // main()'s verdict requires the -aps cohort to pass, and the -aps run uses the same pipeline
    expect(src).toContain('const allPass = cohortPass && apsPass !== false;');
    expect(src).toContain('async function main({ aps = false, apsPass = null } = {})');
    expect(src).toContain('return allPass;');
    expect(src).not.toContain('evaluateApsCohort');
  });

  test('ONE read of the lane per processing pass: the prompt, the stamps and both routing lanes share it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    // the only direct reads inside processRecording's extraction pass: one const
    expect(src.match(/const assessmentLaneActive = commercialAssessmentBookingActive\(call\);/g)).toHaveLength(1);
    expect(src).not.toMatch(/agentProposedSlotCommitment: commercialAssessmentBookingActive\(call\)/);
    expect(src).not.toMatch(/\.\.\.\(commercialAssessmentBookingActive\(call\) \? \{ agentProposedSlotCommitment/);
    expect(src).toContain('extractionPromptVersion(bookableServiceNames, { agentProposedSlotCommitment: assessmentLaneActive })');
    expect(src).toContain('...(assessmentLaneActive ? { agentProposedSlotCommitment: true } : {}),');
    expect(src.match(/\}\), \{ captured: assessmentLaneActive \}, \[extracted, preAdoptionExtracted\]\),/g)).toHaveLength(2);
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
      expect(extractionPromptVersion([], { agentProposedSlotCommitment: true })).toMatch(/^v\d+a-[0-9a-f]{12}$/);
      expect(on).not.toBe(off);
    });
  });
});

describe('codex #6046 round 4: the no-price decision fails closed on every view', () => {
  const v1Price = (over) => [{ requested_service: 'Waves Assessment', ...over }];
  const groundedWith = (ex, transcript, v1Views) => grounded(ex, transcript, { assessmentBooking: assess({ v1Views }) });

  test('control: no price anywhere books', () => {
    expect(groundedWith(extraction(), OUTBOUND, [{ requested_service: 'Waves Assessment', quoted_price: null, quote_requested: false, quote_promised: false }]).ok).toBe(true);
  });

  test('a V1-only price signal (merged or pre-adoption view) goes to the priced path', () => {
    for (const over of [
      { quoted_price: 149 }, { quoted_price_usd: 149 }, { price_amount_usd: 99 }, { price_amount_max_usd: 120 },
      { price: { amount_usd: 75 } }, { prices: [{ amount_max_usd: 120 }] }, { quote_requested: true }, { quote_promised: true },
    ]) {
      for (const views of [v1Price(over), [{}, v1Price(over)[0]], [v1Price(over)[0], null]]) {
        expect([over, groundedWith(extraction(), OUTBOUND, views)]).toEqual([over, { ok: false, reason: 'price_discussed' }]);
      }
    }
    expect(priceDiscussed({}, OUTBOUND, v1Price({ quoted_price: 149 }))).toBe(true);
    expect(priceDiscussed({ price_discussed: false }, OUTBOUND, undefined)).toBe(false);
    expect(priceDiscussed({ price_discussed: false }, OUTBOUND, 'nope')).toBe(false);
    // through canAutoRoute, with the views the processor threads in
    expect(route(extraction(), { commercialAssessmentV1Views: v1Price({ quoted_price: 149 }) }).allowed).toBe(false);
    expect(route(extraction(), { commercialAssessmentV1Views: v1Price({ quote_promised: true }) }).allowed).toBe(false);
    expect(route(extraction(), { commercialAssessmentV1Views: [{ quoted_price: null }] }).allowed).toBe(true);
  });

  test('price nouns in ANY turn count, not just currency words', () => {
    const withLine = (line) => OUTBOUND.replace('Caller: Great, thank you.', `Caller: Great, thank you.\n${line}`);
    for (const line of [
      "Agent: It'll be one forty-nine total.", 'Caller: What does it cost?', 'Agent: There is a fee for that.', 'Caller: How much is the rate?',
      'Agent: I can send you a quote.', 'Caller: Do I pay you today?', 'Agent: We will invoice you.', 'Caller: Is there a deposit?',
      'Agent: What is your bill like?', 'Caller: What is the price?', 'Agent: Payment is after the visit.', 'Agent: It is about forty bucks.', 'Agent: Eighty dollars.', 'Agent: That is $90.',
    ]) {
      expect([line, grounded(extraction(), withLine(line))]).toEqual([line, { ok: false, reason: 'price_discussed' }]);
    }
  });

  test('"free" and "no charge" are not price talk (and near-miss words do not trip it)', () => {
    const withLine = (line) => OUTBOUND.replace('Caller: Great, thank you.', `Caller: Great, thank you.\n${line}`);
    for (const line of ['Agent: The assessment is free.', 'Agent: There is no charge for the visit.', 'Agent: At no cost to you.', 'Agent: There is no extra fee.', 'Agent: We are accurate and separate about it, and Prater Street is fine.']) {
      expect([line, grounded(extraction(), withLine(line)).ok]).toEqual([line, true]);
    }
    // a charge that is NOT waived still counts
    expect(grounded(extraction(), withLine('Agent: There is no charge today, but a charge later.'))).toEqual({ ok: false, reason: 'price_discussed' });
  });

  test('the processor threads the V1 views into both live lanes and the audit builder', () => {
    const Processor = require('../services/call-recording-processor');
    const { buildFailOpenRoutingContext } = Processor;
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src.match(/\[extracted, preAdoptionExtracted\]\),/g)).toHaveLength(2);
    expect(src).toContain('commercialAssessmentV1Views: v1Views.filter(Boolean)');
    const call = { direction: 'inbound', transcription: OUTBOUND, created_at: CALL_STARTED_AT };
    const gates = { isEnabled: (g) => ({ callAgentCommitBooking: true, callAgentCommitTrustedLabels: true }[g] === true), assessmentLive: () => true };
    const build = (extracted) => buildFailOpenRoutingContext({ call, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates, bookableServices: [ASSESSMENT_ROW], extracted }).options;
    const ASSESS = { requested_service: 'Waves Assessment', matched_service: 'Waves Assessment', specific_service_name: 'Waves Assessment', pre_adoption_service_fields: {}, pre_adoption_price_fields: { quoted_price: null, quoted_price_usd: null, price: null, prices: null, price_amount_usd: null, price_amount_max_usd: null, quote_requested: null, quote_promised: null } };
    const priced = { ...ASSESS, quoted_price: 149 };
    expect(build(ASSESS).commercialAssessmentV1Views).toEqual([ASSESS, { ...ASSESS, ...ASSESS.pre_adoption_price_fields }]);
    const opts2 = (ex) => ({ addressValidation: AV_CLEAN, contactPhone: '+19415550100', ...build(ex) });
    expect(canAutoRoute(extraction(), { ...opts2(ASSESS), commercialOutbound: false }).allowed).toBe(true);
    expect(canAutoRoute(extraction(), { ...opts2(priced), commercialOutbound: false }).allowed).toBe(false);
    expect(canAutoRoute(extraction(), { ...opts2({ ...ASSESS, quote_promised: true }), commercialOutbound: false }).allowed).toBe(false);
  });
});

describe('the real shape still grounds after round 4 (outbound lead_auto_bridge)', () => {
  test('real transcript shape, no price signal on any view', () => {
    const real = [
      'Agent: Hey Jennifer, this is Adam with Waves. How are you?',
      'Caller: Good, thanks.',
      'Agent: How does noon on Thursday sound?',
      'Caller: Perfect.',
      "Agent: Awesome. I'll book you for that, and we'll see you then.",
    ].join('\n');
    const ex = extraction({ evidence: [
      quote('/scheduling/confirmed_start_at', 'agent', 'How does noon on Thursday sound?'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Perfect.'),
      quote('/scheduling/agent_committed_booking', 'agent', "I'll book you for that, and we'll see you then"),
    ] });
    const views = [{ requested_service: 'Waves Assessment', quoted_price: null, quote_requested: false, quote_promised: false }];
    expect(grounded(ex, real, { assessmentBooking: assess({ outbound: true, v1Views: views }) })).toEqual({ ok: true, reason: 'assessment_booking_grounded', mode: 'agent_proposed', assessment: true });
    expect(route(ex, { transcript: real, commercialAssessmentV1Views: views }).allowed).toBe(true);
  });
});

describe('codex #6046 round 5', () => {
  const PV = require('../services/prompts/call-extraction-v1');
  const { extractionPromptVersion, PROMPT_VERSION, APS_PROMPT_HASH } = PV;
  const HASH = '0123456789ab';
  const NAMES = ['Waves Assessment', 'Cockroach Control Service'];

  test('every possible stamped version fits varchar(30), for today\'s vNN and a later two-digit one', () => {
    const catalog = require('crypto').createHash('sha256').update(NAMES.join('\n')).digest('hex').slice(0, 8);
    for (const v of ['v22', 'v23', 'v99']) {
      for (const stamp of [`${v}-${HASH}`, `${v}-${HASH}-cat.${catalog}`, `${v}a-${HASH}`, `${v}a-${HASH}-cat.${catalog}`]) {
        expect([stamp, stamp.length <= 30]).toEqual([stamp, true]);
      }
    }
    // the real exports, every combination
    for (const names of [undefined, [], NAMES]) {
      for (const aps of [false, true]) {
        const stamp = extractionPromptVersion(names, { agentProposedSlotCommitment: aps });
        expect([stamp, stamp.length <= 30]).toEqual([stamp, true]);
      }
    }
    expect(PROMPT_VERSION).toMatch(/^v\d{2}$/);
    expect(APS_PROMPT_HASH).toMatch(new RegExp(`^${PROMPT_VERSION}a-[0-9a-f]{12}$`));
  });

  test('every column that stores this value is varchar(30) or wider (migrations scanned)', () => {
    const dir = path.join(__dirname, '../models/migrations');
    const widths = [];
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/\bt\.string\('(ai_extraction_prompt_version|ai_validation_prompt_version)',\s*(\d+)\)/g)) widths.push([f, m[1], Number(m[2])]);
    }
    expect(widths.map(([, c]) => c).sort()).toEqual(['ai_extraction_prompt_version', 'ai_validation_prompt_version', 'ai_validation_prompt_version']);
    const longest = Math.max(...[undefined, NAMES].flatMap((n) => [false, true].map((aps) => extractionPromptVersion(n, { agentProposedSlotCommitment: aps }).length)));
    for (const [file, col, width] of widths) expect([file, col, width >= longest]).toEqual([file, col, true]);
    // no migration shrinks them, and none of them is jsonb/text-checked by this PR: the widest stamp is 30
    expect(longest).toBeLessThanOrEqual(30);
  });

  describe('V1 pre-adoption price record', () => {
    const Processor = require('../services/call-recording-processor');
    const { preAdoptionPriceFields } = Processor._test;
    const { buildFailOpenRoutingContext } = Processor;
    const call = { direction: 'inbound', transcription: OUTBOUND, created_at: CALL_STARTED_AT };
    const gatesOn = { isEnabled: (g) => ({ callAgentCommitBooking: true, callAgentCommitTrustedLabels: true }[g] === true), assessmentLive: () => true };
    const ASSESS = { requested_service: 'Waves Assessment', matched_service: 'Waves Assessment', specific_service_name: 'Waves Assessment', pre_adoption_service_fields: {} };
    const build = (extracted, gates = gatesOn) => buildFailOpenRoutingContext({ call, customer: null, contactPhone: '+19415550100', failOpenEnabled: false, gates, bookableServices: [ASSESSMENT_ROW], extracted }).options;
    const decide = (extracted, v2 = extraction(), gates = gatesOn) => canAutoRoute(v2, { addressValidation: AV_CLEAN, contactPhone: '+19415550100', ...build(extracted, gates) });

    test('the record holds the V1 price fields, separate from the service view fields', () => {
      expect(Object.keys(preAdoptionPriceFields({}))).toEqual(['quoted_price', 'quoted_price_usd', 'price', 'prices', 'price_amount_usd', 'price_amount_max_usd', 'quote_requested', 'quote_promised']);
      expect(preAdoptionPriceFields({ quoted_price: 149, quote_promised: true, requested_service: 'x' })).toMatchObject({ quoted_price: 149, quote_promised: true, price: null });
      expect(preAdoptionPriceFields({ requested_service: 'x' })).not.toHaveProperty('requested_service');
      const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
      // the service view list and its record are untouched
      expect(src).toContain("const CALL_SERVICE_VIEW_FIELDS = Object.freeze(['matched_service', 'requested_service', 'specific_service_name', 'call_summary', 'pain_points']);");
      expect(src).toContain('extracted = { ...extracted, pre_adoption_service_fields: preAdoptionServiceFields(preAdoptionExtracted, serviceFieldsAdopted) };');
      // persisted only while the lane is live, from the pre-adoption copy
      expect(src).toContain('if (assessmentLaneActive) extracted = { ...extracted, pre_adoption_price_fields: preAdoptionPriceFields(preAdoptionExtracted) };');
    });

    test('audit: a V2 row with no price record holds (pre_adoption_price_unknown); the live lane is unaffected', () => {
      expect(decide(ASSESS).allowed).toBe(false);
      expect(canAutoRoute(extraction(), { addressValidation: AV_CLEAN, contactPhone: '+19415550100', ...build(ASSESS) }).reason).toBe('triage_flags');
      const g = (extracted) => commercialDictatedBookingGrounded({ v2: extraction(), transcript: OUTBOUND, callStartedAt: CALL_STARTED_AT, pricedPath: false, assessmentBooking: { bookable: () => true, outbound: false, ...extracted } });
      expect(g({ priceRecordMissing: true })).toEqual({ ok: false, reason: 'pre_adoption_price_unknown' });
      expect(g({ priceRecordMissing: false }).ok).toBe(true);
      // live lane: no such key is ever set, and the same call books
      expect(g({}).ok).toBe(true);
      expect(route(extraction(), { commercialOutbound: false }).allowed).toBe(true);
      const live = Processor._test.commercialAssessmentRoutingOptions(call, () => () => true, { captured: true }, [ASSESS]);
      expect(live).not.toHaveProperty('commercialAssessmentPriceRecordMissing');
    });

    test('audit: with the record, a V1 price that V2 adoption cleared still holds the call', () => {
      const NOPRICE = { ...ASSESS, pre_adoption_price_fields: preAdoptionPriceFields({}) };
      expect(build(NOPRICE).commercialAssessmentPriceRecordMissing).toBe(false);
      expect(decide(NOPRICE).allowed).toBe(true);
      // adoption cleared the merged quoted_price; the pre-adoption record still has it
      const cleared = { ...ASSESS, quoted_price: null, pre_adoption_price_fields: preAdoptionPriceFields({ quoted_price: 149 }) };
      expect(decide(cleared).allowed).toBe(false);
      const promised = { ...ASSESS, pre_adoption_price_fields: preAdoptionPriceFields({ quote_promised: true }) };
      expect(decide(promised).allowed).toBe(false);
      const entry = { ...ASSESS, pre_adoption_price_fields: preAdoptionPriceFields({ prices: [{ amount_usd: 99 }] }) };
      expect(decide(entry).allowed).toBe(false);
    });

    test('lane off: the audit options carry no price-record key (byte-identical)', () => {
      const off = { ...gatesOn, assessmentLive: () => false };
      expect(Object.keys(build(ASSESS, off)).some((k) => /^commercial/.test(k))).toBe(false);
    });
  });
});

describe('codex #6046 round 6: any number in an agent turn is price talk (bare amounts)', () => {
  const withAgentLine = (line, base = OUTBOUND) => base.replace('Caller: Great, thank you.', `Caller: Great, thank you.\n${line}`);

  test('bare amounts, digits and number words, send the call to the priced path', () => {
    for (const line of [
      "Agent: It'll be 149.", 'Agent: It will be one forty-nine.', 'Agent: One forty nine.', 'Agent: A hundred and fifty.', 'Agent: Two hundred.',
      'Agent: Fifteen hundred.', 'Agent: About eighty five.', 'Agent: Say forty-nine.', 'Agent: A thousand.', 'Agent: Ninety.', 'Agent: 149.99.',
      'Agent: One second.', // an article "one" fails closed too
    ]) {
      expect([line, grounded(extraction(), withAgentLine(line))]).toEqual([line, { ok: false, reason: 'price_discussed' }]);
      expect([line, route(extraction(), { transcript: withAgentLine(line) }).allowed]).toEqual([line, false]);
    }
    expect(priceDiscussed(extraction().service_request, withAgentLine('Agent: It will be one forty-nine.'), [], extraction())).toBe(true);
  });

  test('caller turns are not screened for bare numbers (addresses, zips, sizes)', () => {
    for (const line of ['Caller: It is 4120 Palm Lane, zip 34202.', 'Caller: About two thousand square feet, a hundred and fifty feet of fence.', 'Caller: Forty-nine.']) {
      expect([line, grounded(extraction(), withAgentLine(line)).ok]).toEqual([line, true]);
    }
  });

  test('the slot turn is exempt for its own recorded hour/day words and ordinal dates, and for nothing else', () => {
    const slotCase = ({ proposal, words, start, extra = '' }) => {
      const ex = extraction({
        scheduling: { agreed_slot_words: words, confirmed_start_at: start },
        evidence: [quote('/scheduling/confirmed_start_at', 'agent', proposal), AGENT_PROPOSED_EVIDENCE[1], AGENT_PROPOSED_EVIDENCE[2]],
      });
      return { ex, transcript: lines({ proposal: `Agent: ${proposal}${extra}` }) };
    };
    const ten = { words: { day: 'Thursday', hour: '10', period: 'AM' }, start: '2026-09-24T10:00:00-04:00' };
    const a = slotCase({ proposal: 'How about Thursday at 10 AM?', ...ten });
    expect(grounded(a.ex, a.transcript)).toMatchObject({ ok: true, mode: 'agent_proposed' });
    const two = { words: { day: 'Thursday', hour: 'two', period: 'PM' }, start: '2026-09-24T14:00:00-04:00' };
    const b = slotCase({ proposal: 'How about Thursday at two PM?', ...two });
    expect(grounded(b.ex, b.transcript)).toMatchObject({ ok: true });
    // an ordinal date in the same turn
    const c = slotCase({ proposal: 'How about Thursday the 24th at 10:00 AM?', ...ten });
    expect(grounded(c.ex, c.transcript).reason).not.toBe('price_discussed');
    // "noon" is not a number at all
    expect(grounded(extraction()).ok).toBe(true);
    // ANY other number in that same turn is not exempt
    const d = slotCase({ proposal: 'How about Thursday at 10 AM for 149?', ...ten });
    expect(grounded(d.ex, d.transcript)).toEqual({ ok: false, reason: 'price_discussed' });
    const e = slotCase({ proposal: 'How about Thursday at 10 AM? It is one forty-nine.', ...ten, extra: '' });
    expect(grounded(e.ex, e.transcript)).toEqual({ ok: false, reason: 'price_discussed' });
    // the recorded hour in ANOTHER agent turn that is not a pinned slot turn is not exempt
    const f = slotCase({ proposal: 'How about Thursday at two PM?', ...two });
    expect(grounded(f.ex, f.transcript.replace('Agent: I am following up', 'Agent: Two of our techs are out. I am following up')).reason).toBe('price_discussed');
  });

  test('the real shape (synthetic names) still grounds, outbound lead_auto_bridge', () => {
    const real = [
      'Agent: Hey Jordan, this is Alex with Waves. How are you?',
      'Caller: Good, thanks.',
      'Agent: What you got going on?',
      'Caller: We have some critters in the break room at the office.',
      "Agent: Do you think they're mice?",
      'Caller: Probably, we hear scratching in the ceiling.',
      'Agent: And where are you located?',
      'Caller: It is 4120 Palm Lane in Bradenton.',
      "Agent: What's the zip there, do you know?",
      'Caller: 34202.',
      'Agent: Let me just quickly check my schedule and see if we can get someone out there to do an assessment.',
      'Caller: Sure.',
      "Agent: Yep. Just give me a second, I'll just get to my—",
      'Caller: No problem.',
      'Agent: How does noon on Thursday sound?',
      'Caller: Perfect.',
      "Agent: Awesome. I'll book you for that, and we'll see you then.",
      'Caller: Great.',
      "Agent: Perfect. Yep, we'll get you notifications to your phone.",
      'Caller: Thank you.',
      'Agent: Thank you.',
      'Caller: Bye-bye.',
      'Agent: Bye-bye.',
    ].join('\n');
    const views = [{ requested_service: 'Waves Assessment', quoted_price: null, quote_requested: false, quote_promised: false }];
    expect(grounded(extraction(), real, { assessmentBooking: assess({ outbound: true, v1Views: views }) })).toEqual({ ok: true, reason: 'assessment_booking_grounded', mode: 'agent_proposed', assessment: true });
    expect(route(extraction(), { transcript: real, commercialAssessmentV1Views: views }).allowed).toBe(true);
  });
});

describe('codex #6046 round 7', () => {
  const PV = require('../services/prompts/call-extraction-v1');
  const { extractionPromptVersion, PROMPT_HASH, APS_PROMPT_HASH, buildExtractionPrompt } = PV;

  test('APS_PROMPT_HASH comes from the GATE-ON prompt contract; PROMPT_HASH is the gate-off one and unchanged', () => {
    const crypto = require('crypto');
    const src = fs.readFileSync(path.join(__dirname, '../services/prompts/call-extraction-v1.js'), 'utf8');
    expect(src).toContain("buildExtractionPrompt('', '', '', { agentProposedSlotCommitment: true })");
    expect(src).toContain("buildExtractionPrompt('', '', '') + '\\n' + JSON.stringify(modelOutputSchema)");
    // the two hashes differ, and the gate-on text really is part of the APS one
    expect(APS_PROMPT_HASH.split('-')[1]).not.toBe(PROMPT_HASH.split('-')[1]);
    expect(buildExtractionPrompt('', '', '', { agentProposedSlotCommitment: true })).not.toBe(buildExtractionPrompt('', '', ''));
    // changing the gated text changes the hash: rebuild the module with one gated string edited
    const jsPath = path.join(__dirname, '../services/prompts/call-extraction-v1.js');
    const edited = src.replace('AGENT-PROPOSED SLOT (NEW bookings only;', 'AGENT-PROPOSED SLOT (EDITED NEW bookings only;');
    expect(edited).not.toBe(src);
    const tmp = path.join(path.dirname(jsPath), '_round7_edit_tmp.js');
    fs.writeFileSync(tmp, edited);
    try {
      const changed = require(tmp);
      expect(changed.APS_PROMPT_HASH).not.toBe(APS_PROMPT_HASH);
      expect(changed.PROMPT_HASH).toBe(PROMPT_HASH); // gate-off hash untouched by a gated-only edit
    } finally {
      fs.unlinkSync(tmp);
    }
    expect(PROMPT_HASH).toMatch(/^v\d{2}-[0-9a-f]{12}$/);
    expect(APS_PROMPT_HASH.length).toBe(PROMPT_HASH.length + 1);
    expect(crypto).toBeTruthy();
  });

  test('readiness matches the EXACT live gate-on catalog version, no prefix match', () => {
    const { apsCohortVersion } = require('../scripts/v2-promotion-readiness');
    const names = ['Waves Assessment', 'Cockroach Control Service'];
    expect(apsCohortVersion(names)).toBe(extractionPromptVersion(names, { agentProposedSlotCommitment: true }));
    expect(apsCohortVersion(names)).toMatch(/^v\d+a-[0-9a-f]{12}-cat\.[0-9a-f]{8}$/);
    // another catalog is another cohort; an empty live catalog is the bare APS version
    expect(apsCohortVersion([...names, 'Other'])).not.toBe(apsCohortVersion(names));
    expect(apsCohortVersion([])).toBe(APS_PROMPT_HASH);
    expect(apsCohortVersion(undefined)).toBe(APS_PROMPT_HASH);
    const src = fs.readFileSync(path.join(__dirname, '../scripts/v2-promotion-readiness.js'), 'utf8');
    expect(src).not.toMatch(/like.*APS_PROMPT_HASH/);
    expect(src).toContain('loadBookableCallServices(db)');
  });

  describe('V2 quote signals and estimate words are price talk', () => {
    test('V2 quote_requested / quote_promised true counts; false, null and undefined do not', () => {
      for (const k of ['quote_requested', 'quote_promised']) {
        expect([k, priceDiscussed({ [k]: true }, OUTBOUND)]).toEqual([k, true]);
        for (const quiet of [false, null, undefined]) expect([k, quiet, priceDiscussed({ price_discussed: false, [k]: quiet }, OUTBOUND)]).toEqual([k, quiet, false]);
        expect([k, grounded(extraction({ service: { [k]: true } }))]).toEqual([k, { ok: false, reason: 'price_discussed' }]);
        expect([k, route(extraction({ service: { [k]: true } })).allowed]).toEqual([k, false]);
        expect([k, grounded(extraction({ service: { [k]: false } })).ok]).toEqual([k, true]);
      }
    });

    test('"Can I get an estimate?": with V2 quote_requested true, and with only the transcript word', () => {
      const talk = OUTBOUND.replace('Caller: Great, thank you.', 'Caller: Great, can I get an estimate?');
      expect(grounded(extraction({ service: { quote_requested: true } }), talk)).toEqual({ ok: false, reason: 'price_discussed' });
      expect(grounded(extraction(), talk)).toEqual({ ok: false, reason: 'price_discussed' }); // transcript word alone
      for (const word of ['estimate', 'estimates', 'estimated', 'estimating', 'quoted', 'quoting']) {
        const t = OUTBOUND.replace('Caller: Great, thank you.', `Caller: Great, ${word}.`);
        expect([word, grounded(extraction(), t)]).toEqual([word, { ok: false, reason: 'price_discussed' }]);
      }
      expect(grounded(extraction()).ok).toBe(true);
    });
  });

  test('the real shape (synthetic names) still grounds', () => {
    const real = [
      'Agent: Hey Jordan, this is Alex with Waves. How are you?', 'Caller: Good, thanks.',
      'Agent: What you got going on?', 'Caller: We have some critters in the break room at the office.',
      "Agent: Do you think they're mice?", 'Caller: Probably, we hear scratching in the ceiling.',
      'Agent: And where are you located?', 'Caller: It is 4120 Palm Lane in Bradenton.',
      "Agent: What's the zip there, do you know?", 'Caller: 34202.',
      'Agent: Let me just quickly check my schedule and see if we can get someone out there to do an assessment.', 'Caller: Sure.',
      "Agent: Yep. Just give me a second, I'll just get to my—", 'Caller: No problem.',
      'Agent: How does noon on Thursday sound?', 'Caller: Perfect.',
      "Agent: Awesome. I'll book you for that, and we'll see you then.", 'Caller: Great.',
      "Agent: Perfect. Yep, we'll get you notifications to your phone.", 'Caller: Thank you.',
      'Agent: Thank you.', 'Caller: Bye-bye.', 'Agent: Bye-bye.',
    ].join('\n');
    const views = [{ requested_service: 'Waves Assessment', quoted_price: null, quote_requested: false, quote_promised: false }];
    const ex = extraction({ service: { quote_requested: false, quote_promised: false } });
    expect(grounded(ex, real, { assessmentBooking: assess({ outbound: true, v1Views: views }) })).toEqual({ ok: true, reason: 'assessment_booking_grounded', mode: 'agent_proposed', assessment: true });
    expect(route(ex, { transcript: real, commercialAssessmentV1Views: views }).allowed).toBe(true);
    expect(grounded(extraction(), real, { assessmentBooking: assess({ outbound: true, v1Views: views }) }).ok).toBe(true);
  });
});

describe('codex #6046 round 8', () => {
  test('staff intro: punctuation does not matter, tag questions and hedges are rejected', () => {
    const proven = (line) => outboundStaffIdentityProven(`Agent: ${line}\nCaller: ok\nAgent: How does noon on Thursday sound?`);
    for (const ok of [
      'Hey Jordan, this is Alex with Waves. How are you?', 'this is Alex with Waves how are you?', 'this is Alex with Waves, how are you doing today',
      'Hi this is Alex with Waves Pest Control I am calling about your request', "Hello, this is Alex from Waves, I'm calling to follow up on your form", 'this is Alex with Waves',
    ]) expect([ok, proven(ok)]).toEqual([ok, true]);
    for (const bad of [
      'this is Alex with Waves right', 'this is Alex with Waves, right?', 'this is Alex with Waves correct', 'this is Alex with Waves yes', 'this is Alex with Waves yeah',
      'this is Alex with Waves huh', "this is Alex with Waves isn't it", 'this is Alex with Waves isnt it', "this is Alex with Waves aren't you", 'this is Alex with Waves is it',
      'this is Alex with Waves is that right', 'this is Alex with Waves I think', 'this is Alex with Waves maybe', 'this is Alex with Waves I guess',
      'this is Alex with Waves you said', 'this is Alex with Waves you told me', 'this is Alex right with Waves', 'this is Alex with Waves?',
      'this is Alex with Waves, calling to see if that is right', 'this is Alex with Waves not sure',
    ]) expect([bad, proven(bad)]).toEqual([bad, false]);
  });

  describe('the gated block cannot change routing outside the assessment lane', () => {
    const { hasAgentCommittedEvidence } = require('../services/call-triage-flags');
    const SHAPE = lines();
    // A residential call with the 3-turn shape, extracted WITH the block (agent_committed true, the bare third-turn quote)...
    const residential = (over = {}) => ({ ...extraction({ flags: [], ...over }), property: { property_type: 'single_family' }, caller: { relationship_to_property: 'tenant', on_site_authorization: false } });
    // ...and the same call extracted WITHOUT it (the old rule leaves agent_committed_booking null and pins no commitment quote)
    const blockOff = (over = {}) => residential({ scheduling: { agent_committed_booking: null }, evidence: AGENT_PROPOSED_EVIDENCE.slice(0, 2), ...over });
    const gateOpts = { agentCommitFailOpen: true, transcriptLabelsTrusted: true, transcript: SHAPE, callStartedAt: CALL_STARTED_AT, addressValidation: AV_CLEAN, failOpen: true, callerAni: '+19415550100' };
    const verdict = (ex, extra = {}) => { const r = canAutoRoute(ex, { ...gateOpts, ...extra }); return { allowed: r.allowed, reason: r.reason, blocking: r.appointmentBlockingFlags, failedOpen: r.failedOpenFlags, demoted: r.gateDemotedFlags }; };

    test('the bare agent-proposed commitment never passes the strict evidence check (every non-assessment consumer uses it)', () => {
      const ex = residential();
      expect(hasAgentCommittedEvidence(ex, SHAPE, CALL_STARTED_AT)).toBe(false); // the quote states no weekday or hour: it cannot bind the slot
      // nor can the slot-bearing PROPOSAL, a question, stand in for it
      const proposalPinned = residential({ evidence: [quote('/scheduling/agent_committed_booking', 'agent', PROPOSAL), ...AGENT_PROPOSED_EVIDENCE.slice(0, 2)] });
      expect(hasAgentCommittedEvidence(proposalPinned, SHAPE, CALL_STARTED_AT)).toBe(false);
      // control: a staff-stated commitment, the old shape, still passes
      const stated = 'We will see you Thursday at noon.';
      const t = lines({ proposal: `Agent: ${stated}`, accept: 'Caller: Perfect.', commit: 'Agent: Great.' });
      const old = residential({ evidence: [quote('/scheduling/agent_committed_booking', 'agent', stated)] });
      expect(hasAgentCommittedEvidence(old, t, CALL_STARTED_AT)).toBe(true);
    });

    test('canAutoRoute: a residential / non-assessment call routes exactly as it does with the block off', () => {
      // an unauthorized caller (the agent-commit demotion's target), and a plain residential booking
      for (const flags of [['caller_not_authorized'], []]) {
        expect([flags, verdict(residential({ flags }))]).toEqual([flags, verdict(blockOff({ flags }))]);
      }
      expect(verdict(residential({ flags: ['caller_not_authorized'] })).allowed).toBe(false); // an unauthorized caller is still held for the office, block on or off
      // control: the OLD staff-stated shape is what the demotion clears (it is unchanged)
      const stated = 'We will see you Thursday at noon.';
      const oldShape = residential({ flags: ['caller_not_authorized'], evidence: [quote('/scheduling/agent_committed_booking', 'agent', stated)] });
      const oldT = lines({ proposal: `Agent: ${stated}`, accept: 'Caller: Perfect.', commit: 'Agent: Great.' });
      expect(verdict(oldShape, { transcript: oldT }).allowed).toBe(true);
      // a commercial call that does NOT pass the assessment lane (service elsewhere): held on the quote hold, same as off
      const commercial = (ex) => ({ ...ex, property: { property_type: 'commercial' }, triage_flags: ['commercial_requires_quote'] });
      const lane = { commercialAssessmentBooking: true, commercialOutbound: false, commercialAssessmentBookable: () => false, commercialAssessmentV1Views: [] };
      const withBlock = verdict(commercial(residential()), lane);
      expect(withBlock).toEqual(verdict(commercial(blockOff())));
      expect(withBlock.allowed).toBe(false);
      expect(withBlock.blocking).toContain('commercial_requires_quote');
    });

    test('no consumer outside canAutoRoute trusts the flag without the strict check', () => {
      const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
      // canAutoRoute's demotion and the no-show detector both pair the flag with hasAgentCommittedEvidence
      expect(read('../services/call-triage-flags.js')).toMatch(/agent_committed_booking === true\s*&& hasAgentCommittedEvidence\(/);
      expect(read('../services/no-show-detector.js')).toMatch(/hasAgentCommittedEvidence\(v2, call\.transcription, call\.created_at\)/);
      // the reschedule applier only acts on reschedule_requested + a grounded moved date, and its grounding
      // (groundRescheduleAgreement) needs a commitment quote that states the slot
      expect(read('../services/call-reschedule-apply.js')).toMatch(/groundRescheduleAgreement\(/);
    });

    test('the block changes only the commitment flag and its quotes: status and the other fields keep their own rules', () => {
      const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');
      const on = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', { agentProposedSlotCommitment: true });
      const block = on.slice(on.indexOf('AGENT-PROPOSED SLOT'), on.indexOf('Transcript:'));
      expect(block).toContain('then ALSO set agent_committed_booking true');
      expect(block).toContain('changes that ONE flag and its evidence quotes only');
      expect(block).toContain('keep their own rules above');
      expect(block).not.toMatch(/set agent_committed_booking true, confirmed_start_at/);
      expect(block).not.toMatch(/status "confirmed"/);
    });
  });
});

describe('codex #6046 round 10: the appended schema agrees with the gated exception', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, `../schemas/call-extraction.${f}.schema.json`), 'utf8'));
  const EXCEPTION = 'when this prompt contains the AGENT-PROPOSED SLOT block';
  // every description (any depth) that restates the day-and-time rule for the agent commitment quote
  const restaters = (node, out = []) => {
    if (Array.isArray(node)) node.forEach((n) => restaters(n, out));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'description' && typeof v === 'string' && /agent_committed_booking\)? must be the WHOLE clause|quote.{0,40}holding the day, date and time/i.test(v)) out.push(v);
        else restaters(v, out);
      }
    }
    return out;
  };

  test('both schemas state the exception wherever the day/time quote rule is restated', () => {
    for (const f of ['model-output', 'persisted']) {
      const found = restaters(read(f));
      expect([f, found.length]).toEqual([f, 1]); // definite_commitment is the one place the rule is restated
      for (const text of found) {
        expect(text).toContain(EXCEPTION);
        expect(text).toContain("the agent's bare commitment sentence after the caller's yes");
      }
    }
  });

  test('gate off is the block-stripped gate-on prompt (compared structurally, never to a pinned string)', () => {
    const { buildExtractionPrompt } = require('../services/prompts/call-extraction-v1');
    const off = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', {});
    const on = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', { agentProposedSlotCommitment: true });
    const stripped = on
      .replace(/\nAGENT-PROPOSED SLOT[\s\S]*?\n(?=\n)/, '')
      .replaceAll(' (except in the exceptions listed below)', '')
      .replace('THREE EXCEPTIONS', 'TWO EXCEPTIONS')
      .replace(/ \(3\) An agent-proposed slot[^\n]*?(?=\n)/, '')
      .replace(/ For that agent-proposed shape the commitment quote[^\n]*?(?= null when no slot was agreed)/, '');
    expect(stripped).toBe(off);
    // the prompt text and the hashes agree: any gated edit moves only the APS hash
    const { PROMPT_HASH, APS_PROMPT_HASH, PROMPT_VERSION } = require('../services/prompts/call-extraction-v1');
    expect(PROMPT_HASH).toMatch(new RegExp(`^${PROMPT_VERSION}-[0-9a-f]{12}$`));
    expect(APS_PROMPT_HASH).toMatch(new RegExp(`^${PROMPT_VERSION}a-[0-9a-f]{12}$`));
  });

  test('the version columns still fit (30 characters)', () => {
    const { extractionPromptVersion } = require('../services/prompts/call-extraction-v1');
    for (const names of [undefined, ['Waves Assessment', 'Cockroach Control Service']]) {
      for (const aps of [false, true]) expect(extractionPromptVersion(names, { agentProposedSlotCommitment: aps }).length).toBeLessThanOrEqual(30);
    }
  });
});

describe('codex #6046 round 11', () => {
  test('agent-proposed mode: a proposal naming any other day or date does not ground (reschedule behavior untouched)', () => {
    const slot = { words: { day: 'Thursday', hour: 'noon', period: null }, start: THURSDAY_NOON };
    const tryProposal = (proposal) => {
      const ex = extraction({ evidence: [quote('/scheduling/confirmed_start_at', 'agent', proposal), AGENT_PROPOSED_EVIDENCE[1], AGENT_PROPOSED_EVIDENCE[2]] });
      return { ex, transcript: lines({ proposal: `Agent: ${proposal}` }) };
    };
    const ok = tryProposal('How does noon on Thursday sound?');
    expect(grounded(ok.ex, ok.transcript)).toMatchObject({ ok: true, mode: 'agent_proposed' });
    for (const bad of [
      'How does noon on Thursday and Friday sound?', 'How does Thursday and Friday at noon sound?', 'How does noon on Thursday or the 9th sound?', 'How does noon tomorrow or Thursday sound?',
      'How does noon on Thursday the 9th sound?', 'How does noon on Thursday sound? We are also open Sunday.', 'How does noon on Thursday, or next Monday, sound?',
    ]) {
      const t = tryProposal(bad);
      expect([bad, groundNewBookingAgreement({ v2: t.ex, transcript: t.transcript, callStartedAt: CALL_STARTED_AT, allowAgentProposed: true }).ok]).toEqual([bad, false]);
      expect([bad, grounded(t.ex, t.transcript).ok]).toEqual([bad, false]);
    }
    expect(slot.words.day).toBe('Thursday');
    // without the opt-in nothing here changed: the same proposal never grounded as agent_proposed, and the other modes are untouched
    expect(groundNewBookingAgreement({ v2: ok.ex, transcript: ok.transcript, callStartedAt: CALL_STARTED_AT }).ok).toBe(false);
  });

  describe('the extraction judges, the code verifies: service_request.price_discussed', () => {
    const callerAmount = OUTBOUND.replace('Caller: Great, thank you.', 'Caller: Could you do one forty-nine?');

    test('caller "Could you do one forty-nine?": judged true goes to the priced path; null or missing is held; false plus the real shape grounds', () => {
      expect(grounded(extraction({ service: { price_discussed: true } }), callerAmount)).toEqual({ ok: false, reason: 'price_discussed' });
      expect(route(extraction({ service: { price_discussed: true } }), { transcript: callerAmount }).allowed).toBe(false);
      for (const missing of [null, undefined]) {
        const ex = extraction({ service: { price_discussed: missing } });
        expect([missing, grounded(ex, OUTBOUND)]).toEqual([missing, { ok: false, reason: 'price_discussed' }]);
        expect([missing, route(ex).allowed]).toEqual([missing, false]);
      }
      const noField = extraction();
      delete noField.service_request.price_discussed;
      expect(grounded(noField, OUTBOUND)).toEqual({ ok: false, reason: 'price_discussed' });
      expect(grounded(extraction({ service: { price_discussed: false } }), OUTBOUND).ok).toBe(true);
      // a judged-false extraction does not override the screens: the layers stay
      expect(grounded(extraction({ service: { price_discussed: false, quoted_price_usd: 149 } }), OUTBOUND)).toEqual({ ok: false, reason: 'price_discussed' });
      expect(grounded(extraction({ service: { price_discussed: false } }), `${OUTBOUND}\nAgent: It will be one forty-nine.`)).toEqual({ ok: false, reason: 'price_discussed' });
      expect(priceDiscussed({ price_discussed: false }, OUTBOUND, [{ quote_promised: true }])).toBe(true);
      expect(priceDiscussed({ price_discussed: 'false' }, OUTBOUND)).toBe(true); // exactly the boolean false
    });

    test('the real shape (synthetic names) with price_discussed false still grounds', () => {
      const real = [
        'Agent: Hey Jordan, this is Alex with Waves. How are you?', 'Caller: Good, thanks.',
        'Agent: What you got going on?', 'Caller: We have some critters in the break room at the office.',
        "Agent: Do you think they're mice?", 'Caller: Probably, we hear scratching in the ceiling.',
        'Agent: And where are you located?', 'Caller: It is 4120 Palm Lane in Bradenton.',
        "Agent: What's the zip there, do you know?", 'Caller: 34202.',
        'Agent: Let me just quickly check my schedule and see if we can get someone out there to do an assessment.', 'Caller: Sure.',
        "Agent: Yep. Just give me a second, I'll just get to my—", 'Caller: No problem.',
        'Agent: How does noon on Thursday sound?', 'Caller: Perfect.',
        "Agent: Awesome. I'll book you for that, and we'll see you then.", 'Caller: Great.',
        "Agent: Perfect. Yep, we'll get you notifications to your phone.", 'Caller: Thank you.',
        'Agent: Thank you.', 'Caller: Bye-bye.', 'Agent: Bye-bye.',
      ].join('\n');
      const views = [{ requested_service: 'Waves Assessment', quoted_price: null, quote_requested: false, quote_promised: false }];
      const ex = extraction({ service: { price_discussed: false } });
      expect(grounded(ex, real, { assessmentBooking: assess({ outbound: true, v1Views: views }) })).toEqual({ ok: true, reason: 'assessment_booking_grounded', mode: 'agent_proposed', assessment: true });
      expect(route(ex, { transcript: real, commercialAssessmentV1Views: views }).allowed).toBe(true);
    });

    test('schema field: optional nullable boolean in both schemas, version 1.24.0, mirrored flat, in the prompt and the replay watch lists', () => {
      const { SCHEMA_VERSION } = require('../schemas/validate-extraction');
      expect(SCHEMA_VERSION).toBe('1.26.0');
      for (const f of ['model-output', 'persisted']) {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, `../schemas/call-extraction.${f}.schema.json`), 'utf8'));
        const field = schema.properties.service_request.properties.price_discussed;
        expect(field.type).toEqual(['boolean', 'null']);
        expect(field.description).toContain('Could you do one forty-nine?');
        expect(JSON.stringify(schema.properties.service_request.required || [])).not.toContain('price_discussed');
        if (f === 'persisted') expect(schema.properties.meta.properties.schema_version.enum).toContain('1.24.0');
      }
      const { flatView } = require('../utils/extraction-compat');
      expect(flatView({ meta: { schema_version: '1.24.0' }, service_request: { price_discussed: false } }).price_discussed).toBe(false);
      expect(flatView({ meta: { schema_version: '1.24.0' }, service_request: { price_discussed: true } }).price_discussed).toBe(true);
      expect(flatView({ meta: { schema_version: '1.24.0' }, service_request: {} }).price_discussed).toBeNull();
      const { buildExtractionPrompt, APS_PROMPT_HASH, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
      for (const o of [{}, { agentProposedSlotCommitment: true }]) {
        const prompt = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-09-23', o);
        expect(prompt).toContain('- price_discussed: judge over the WHOLE call, both speakers');
        expect(prompt).toContain('"Could you do one forty-nine?" -> true');
        expect(prompt).toContain("It's a free assessment");
      }
      expect(APS_PROMPT_HASH).not.toBe(PROMPT_HASH);
      const replay = fs.readFileSync(path.join(__dirname, '../scripts/replay-call-extraction-variance.js'), 'utf8');
      expect(replay.match(/'price_discussed'/g).length).toBeGreaterThanOrEqual(2);
    });
  });
});
