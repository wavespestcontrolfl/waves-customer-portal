jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/triage-auto-resolve', () => ({ resolveRescheduleCards: jest.fn(async () => 1) }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
const db = require('../models/db');
const logger = require('../services/logger');
const { resolveRescheduleCards } = require('../services/triage-auto-resolve');
const links = require('../services/reschedule-link-promises');
const { parseETDateTime } = require('../utils/datetime-et');
const { gates } = require('../config/feature-gates');
const { portalUrl } = require('../utils/portal-url');
const now = new Date('2030-01-07T12:00:00Z');
const quote = 'I will text you a reschedule link for that appointment.';
const customer = { id: 'customer', phone: '+15555550100', active: true };
const visit = { id: 'visit', customer_id: customer.id, scheduled_date: '2030-01-08', window_start: '09:00', window_end: '10:30',
  status: 'confirmed', service_type: 'WaveGuard', reschedule_token: 'token', property_address: '100 Example Street', property_unit: 'Unit 2' };
const call = { customer_id: customer.id, direction: 'inbound', from_phone: customer.phone, created_at: now,
  v2_extraction_status: 'valid', ai_extraction_enriched: { meta: {} }, transcription: `Agent: ${quote}\nCaller: Thank you.` };
const commitment = { confidence: 0.95, evidence: [{ quote, speaker: 'agent' }] };
const select = (extra = {}) => links.selectDiscussedVisit({ commitment, call, customer, candidates: [visit], now, ...extra });
beforeEach(() => resolveRescheduleCards.mockClear());

test('an explicit promise with one available visit identifies it; multiple visits stay in review', () => {
  expect(select().visit?.id).toBe('visit');
  expect(select({ candidates: [visit, { ...visit, id: 'other' }] }).reason).toBe('ambiguous_visit');
});

test.each([
  "I'm going to text you a reschedule link for that appointment.",
  "We're going to text you a reschedule link for that appointment.",
])('a contracted future-tense promise (%s) is recognized, not parked as promise_needs_review (codex #4293 P2 r4)', (phrasing) => {
  // norm() strips the apostrophe to a bare space — "I'm going to" reads as
  // "i m going to" and "We're going to" as "we re going to". Neither
  // spelled-out form ("I am going to" / "we are going to") appears verbatim
  // in real transcripts nearly as often as the contraction does, so missing
  // it dropped a high-confidence, uniquely-grounded promise from
  // promisedQuotes and parked it for review instead of sending.
  const transcription = `Agent: ${phrasing}\nCaller: Thank you.`;
  expect(select({ call: { ...call, transcription }, commitment: { ...commitment, evidence: [{ quote: phrasing, speaker: 'agent' }] } }).visit?.id).toBe('visit');
});

test.each([undefined, NaN, 0.89])('invalid or low promise confidence stays in review: %s', confidence => {
  expect(select({ commitment: { ...commitment, confidence } }).reason).toBe('promise_needs_review');
});

test('a caller request, conditional promise, or later revocation cannot send', () => {
  expect(select({ call: { ...call, transcription: `Caller: ${quote}` } }).reason).toBe('promise_needs_review');
  expect(select({ call: { ...call, transcription: `Agent: If that works, ${quote}` } }).reason).toBe('promise_needs_review');
  expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: Do not send the link.` } }).reason).toBe('promise_needs_review');
});

test('outbound source variants retain full phone identity', () => {
  expect(select({ call: { ...call, direction: 'outbound-api', from_phone: '+15555550200', to_phone: customer.phone } }).visit?.id).toBe('visit');
  expect(select({ customer: { ...customer, phone: '+445555550100' } }).reason).toBe('customer_identity');
});

test('each subject field must occur in its own source quote, and units remain distinct', () => {
  const subject = { quote: 'The appointment at 100 Example Street Unit 2.', address: '100 Example Street Unit 2' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}\nCaller: WaveGuard is my other service.` };
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, service: 'WaveGuard' } } }).reason).toBe('subject_not_grounded');
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [visit, { ...visit, id: 'unit-3', property_unit: 'Unit 3' }] }).visit?.id).toBe('visit');
});

test('a stated current date must match the candidate visit exactly', () => {
  const weekday = parseETDateTime('2030-01-08T09:00').toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const subject = { quote: `My appointment is ${weekday} at 9 AM.`, visit_date: '2030-01-08' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject } }).visit?.id).toBe('visit');
  // The quote names Jan 8's actual weekday; a mismatched extraction is now
  // caught as ungrounded before narrowBySubject's own date filter ever runs
  // — the sole-candidate exemption no longer covers a weekday the quote
  // contradicts (codex #4293 P1 r4).
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-09' } } }).reason).toBe('date_not_grounded');
});

test('dispatch-owned pending and grouped visits stay in review', () => {
  expect(select({ candidates: [{ ...visit, visit_id: 'group' }] }).reason).toBe('visit_not_self_service');
  expect(select({ candidates: [{ ...visit, status: 'pending', source_action: 'ai_call_outbound_review' }] }).visit).toBeUndefined();
});

test('a missed appointment is still promised the link the page would honour', () => {
  // /reschedule/:token treats a pending or confirmed visit whose window has
  // passed as MISSED, not served, and still lets the customer pick a new time.
  // The call right after a missed visit is the one most likely to be promised
  // this link, so the worker reaches the page's own verdict.
  expect(select({ now: parseETDateTime('2030-01-08T11:00') }).visit?.id).toBe('visit');
  expect(select({ now: parseETDateTime('2030-02-01T09:00') }).visit?.id).toBe('visit');
  // Still inside the quoted two-hour arrival window: not missed, and eligible
  // for the same reason.
  expect(select({ now: parseETDateTime('2030-01-08T10:45') }).visit?.id).toBe('visit');
  // Terminal and live states are still refused, elapsed or not.
  for (const status of ['completed', 'cancelled', 'en_route']) {
    expect(select({ candidates: [{ ...visit, status }], now: parseETDateTime('2030-01-08T11:00') }).reason).toBe('visit_not_self_service');
  }
  // A 'rescheduled' row is eligibility()'s own missed-vs-past call, not this
  // worker's: elapsed same-day, its answer is reason 'past' (a pending-rebook
  // placeholder is never "missed"), which reads here as visit_elapsed rather
  // than the generic visit_not_self_service the other terminal statuses get.
  expect(select({ candidates: [{ ...visit, status: 'rescheduled' }], now: parseETDateTime('2030-01-08T11:00') }).reason).toBe('visit_elapsed');
});

test('a rescheduled visit still in the future is promised the link exactly like a pending one', () => {
  // eligibility() already lets a customer self-serve a 'rescheduled' row from
  // the public page — a local, narrower status allowlist here parked the
  // promise anyway, refusing a link the customer could already get
  // themselves (codex #4293 P1 r8).
  const future = { ...visit, status: 'rescheduled', scheduled_date: '2030-01-20' };
  const subject = { quote: 'My appointment on January 20.', visit_date: '2030-01-20' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [future] }).visit?.id).toBe('visit');
});

test('an emailed link is office work, not a silent SMS', () => {
  const emailed = 'I will email you a reschedule link for that appointment.';
  expect(select({ call: { ...call, transcription: `Agent: ${emailed}` },
    commitment: { ...commitment, evidence: [{ quote: emailed, speaker: 'agent' }] } }).reason).toBe('channel_unsupported');
  // An extracted channel the one SMS pipeline cannot keep parks the same way,
  // whatever the quote says.
  expect(select({ commitment: { ...commitment, channel: 'email' } }).reason).toBe('channel_unsupported');
  // "email or text" names a channel this worker can keep, and an absent or
  // unknown channel is the default.
  const either = 'I will email or text you a reschedule link for that appointment.';
  expect(select({ call: { ...call, transcription: `Agent: ${either}` },
    commitment: { ...commitment, evidence: [{ quote: either, speaker: 'agent' }] } }).visit?.id).toBe('visit');
  for (const channel of [undefined, null, '', 'sms', 'unknown']) {
    expect(select({ commitment: { ...commitment, channel } }).visit?.id).toBe('visit');
  }
});

test('a stated appointment date binds by exact match, not the new-booking slot rules', () => {
  const far = { ...visit, scheduled_date: '2030-09-20', window_start: '13:00', window_end: '15:00' };
  const subject = { quote: 'My September 20 appointment.', visit_date: '2030-09-20' };
  // Months out, no weekday word and no time word: all three were refused by
  // the new-booking slot validator even though the date matched exactly.
  expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` },
    commitment: { ...commitment, subject }, candidates: [far] }).visit?.id).toBe('visit');
  // A quote that contradicts the stated date still binds nothing — caught
  // now as an ungrounded explicit claim before narrowBySubject's own
  // exact-match filter ever runs, regardless of the single open candidate
  // (codex #4293 P1 r4).
  for (const spoken of ['My September 27 appointment.', 'My October 20 appointment.', 'My appointment on the 27th.']) {
    expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: ${spoken}` },
      commitment: { ...commitment, subject: { quote: spoken, visit_date: '2030-09-20' } }, candidates: [far] })
      .reason).toBe('date_not_grounded');
  }
});

test('an extracted date needs the quote to actually name it, even against the sole open visit', () => {
  const second = { ...visit, id: 'second', scheduled_date: '2030-01-15' };
  // The call happened 2030-01-07 (ET). "tomorrow" means 2030-01-08 relative
  // to THAT date — not whatever date the model happened to select.
  const subject = { quote: 'My appointment tomorrow, please.' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  // The model picked the OTHER visit's date; the quote never grounds that
  // pick, so a wrong extraction cannot silently bind the wrong appointment —
  // it parks for review instead (codex #4293 P1).
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-15' } },
    candidates: [visit, second] }).reason).toBe('date_not_grounded');
  // The same "tomorrow" DOES ground the date the caller actually meant.
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-08' } },
    candidates: [visit, second] }).visit?.id).toBe('visit');
  // A sole remaining candidate is NOT an exemption from a CONTRADICTED
  // explicit claim: 2030-01-15 is the only open visit, but "tomorrow"
  // (2030-01-08) still contradicts it, so the link for the wrong appointment
  // must not go out just because it is the only row on file (codex #4293 P1
  // r4 — this is the sole-candidate bug the earlier round's exemption missed).
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-15' } },
    candidates: [second] }).reason).toBe('date_not_grounded');
  // The sole-candidate exemption still stands when the quote gives NOTHING
  // to check the pick against at all (no explicit claim, no weekday name).
  const noToken = { quote: 'My appointment, please.', visit_date: '2030-01-15' };
  expect(select({ call: { ...call, transcription: `${call.transcription}\nCaller: ${noToken.quote}` },
    commitment: { ...commitment, subject: noToken }, candidates: [second] }).visit?.id).toBe('second');
});

test('a bare weekday alongside an explicit relative token cannot override the relative token', () => {
  // 2030-01-07 is a Monday, so "tomorrow" is 2030-01-08 — but 2030-01-15 is
  // ALSO a Tuesday, like the visit the caller actually meant. Checking the
  // bare weekday name BEFORE the explicit relative token let "Tuesday" match
  // first and ground the wrong visit (codex #4293 P1 r2).
  const second = { ...visit, id: 'second', scheduled_date: '2030-01-15' };
  const subject = { quote: 'My appointment tomorrow, Tuesday, please.' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-15' } },
    candidates: [visit, second] }).reason).toBe('date_not_grounded');
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-01-08' } },
    candidates: [visit, second] }).visit?.id).toBe('visit');
});

test('a bare weekday name grounds the date only when exactly one open visit shares it', () => {
  // `visit` is 2030-01-08, a Tuesday; this candidate is the following day, a
  // Wednesday, so the weekday word alone is unambiguous.
  const second = { ...visit, id: 'second', scheduled_date: '2030-01-16' };
  const weekday = parseETDateTime('2030-01-16T09:00').toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const uniqueSubject = { quote: `My appointment is on ${weekday}.`, visit_date: '2030-01-16' };
  const uniqueSource = { ...call, transcription: `${call.transcription}\nCaller: ${uniqueSubject.quote}` };
  expect(select({ call: uniqueSource, commitment: { ...commitment, subject: uniqueSubject }, candidates: [visit, second] }).visit?.id).toBe('second');

  // Two open visits sharing the SAME weekday leave a bare weekday name unable
  // to tell them apart, so it grounds neither pick.
  const alsoTuesday = { ...visit, id: 'also-tuesday', scheduled_date: '2030-01-15' };
  const sharedSubject = { quote: 'My appointment is on Tuesday.', visit_date: '2030-01-15' };
  const sharedSource = { ...call, transcription: `${call.transcription}\nCaller: ${sharedSubject.quote}` };
  expect(select({ call: sharedSource, commitment: { ...commitment, subject: sharedSubject }, candidates: [visit, alsoTuesday] })
    .reason).toBe('date_not_grounded');
});

test('an extracted date with no naming token at all parks for review among several visits', () => {
  const second = { ...visit, id: 'second', scheduled_date: '2030-01-15' };
  const subject = { quote: 'My WaveGuard appointment.', visit_date: '2030-01-08', service: 'WaveGuard' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [visit, second] }).reason).toBe('date_not_grounded');
});

test('a bare ordinal date names a day only, not a month — two visits sharing it stay ambiguous', () => {
  // "on the 20th" resolves ONLY a day (explicitQuoteDate: "the 14th" is
  // month-agnostic). Treating the missing month as a wildcard the model was
  // free to fill in let a February extraction narrow Jan 20 / Feb 20 down to
  // one and send the link for a visit the quote never actually identified
  // (codex #4293 P1 r3). The claim grounds the pick only when the components
  // it DID resolve single that date out among the open candidates.
  const jan20 = { ...visit, id: 'jan20', scheduled_date: '2030-01-20' };
  const feb20 = { ...visit, id: 'feb20', scheduled_date: '2030-02-20' };
  const subject = { quote: 'My appointment on the 20th.' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  // The model picked February; the bare "20th" cannot tell Jan 20 and Feb 20
  // apart, so neither is grounded — this must park for review, not narrow to
  // whichever date the model happened to extract.
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-02-20' } },
    candidates: [jan20, feb20] }).reason).toBe('date_not_grounded');
  // The SAME bare-day quote DOES ground the pick once only one open visit
  // falls on the 20th of any month at all.
  expect(select({ call: source, commitment: { ...commitment, subject: { ...subject, visit_date: '2030-02-20' } },
    candidates: [feb20] }).visit?.id).toBe('feb20');
});

test('a numeric subject date (9/20) grounds the pick exactly like a spelled-out month, and refuses a mismatched sole candidate (codex #4293 P1)', () => {
  // explicitQuoteDate only recognized month names, ordinals, and relative
  // words — "my 9/20 appointment" matched none of them, fell through to the
  // no-explicit-claim/sole-candidate path, and let a mistaken extraction
  // send whatever visit happened to be the only one open, even when the
  // quote plainly named a DIFFERENT date.
  const nineTwenty = { ...visit, id: 'nine-twenty', scheduled_date: '2030-09-20' };
  const nineTwentyOne = { ...visit, id: 'nine-twenty-one', scheduled_date: '2030-09-21' };
  const subject = { quote: 'My 9/20 appointment.', visit_date: '2030-09-21' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  // The model's extraction (9/21) is the customer's only open visit, but the
  // quote names 9/20 — the sole-candidate exemption must not paper over the
  // mismatch just because there is nothing else on file.
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [nineTwentyOne] }).reason).toBe('date_not_grounded');
  // The identical quote DOES ground a visit that actually falls on 9/20 —
  // "09/20" and "9-20" resolve the same way.
  for (const quote of ['My 9/20 appointment.', 'My 09/20 appointment.', 'My 9-20 appointment.']) {
    const src = { ...call, transcription: `${call.transcription}\nCaller: ${quote}` };
    expect(select({ call: src, commitment: { ...commitment, subject: { quote, visit_date: '2030-09-20' } },
      candidates: [nineTwenty] }).visit?.id).toBe('nine-twenty');
  }
});

test('an ambiguous numeric subject date fails closed rather than guessing M/D vs D/M (codex #4293 P1)', () => {
  // "9/10" reads as September 10 under M/D, October 9 under D/M — the two
  // conventions disagree on which date it names. Guessing either way risks
  // sending the wrong visit's link, so this must never ground a pick, even
  // against a sole open visit that happens to match one of the readings.
  const sept10 = { ...visit, id: 'sept-10', scheduled_date: '2030-09-10' };
  const subject = { quote: 'My 9/10 appointment.', visit_date: '2030-09-10' };
  const source = { ...call, transcription: `${call.transcription}\nCaller: ${subject.quote}` };
  expect(select({ call: source, commitment: { ...commitment, subject }, candidates: [sept10] }).reason).toBe('date_not_grounded');
  // A shape where one component is out of month range (13-31) is NOT
  // ambiguous — only one reading is a valid calendar date at all (the
  // number over 12 can only be a day), so it resolves unambiguously even
  // though it leads with what would be the day under M/D: "25/12" can only
  // be December 25.
  const dec25 = { ...visit, id: 'dec-25', scheduled_date: '2030-12-25' };
  const dmSubject = { quote: 'My 25/12 appointment.', visit_date: '2030-12-25' };
  const dmSource = { ...call, transcription: `${call.transcription}\nCaller: ${dmSubject.quote}` };
  expect(select({ call: dmSource, commitment: { ...commitment, subject: dmSubject }, candidates: [dec25] }).visit?.id).toBe('dec-25');
});

test('an inactive account cannot be promised a link the reschedule page refuses', () => {
  for (const active of [false, null, undefined]) {
    expect(select({ customer: { ...customer, active } }).reason).toBe('customer_inactive');
  }
});

test('a bare "I will text you a link" needs rescheduling language or a grounded subject', () => {
  const generic = 'I will text you a link.';
  const bare = { ...commitment, evidence: [{ quote: generic, speaker: 'agent' }] };
  const source = { ...call, transcription: `Agent: ${generic}\nCaller: Thank you.` };
  expect(select({ call: source, commitment: bare }).reason).toBe('promise_needs_review');
  // A subject with a grounded quote but no date/service/address names no
  // appointment, so it cannot stand in for the missing language.
  expect(select({ call: source, commitment: { ...bare, subject: { quote: 'Thank you.' } } }).reason).toBe('promise_needs_review');
  // Either half is enough on its own.
  const subjectQuote = 'That is for my WaveGuard service.';
  expect(select({ call: { ...call, transcription: `Agent: ${generic}\nCaller: ${subjectQuote}` },
    commitment: { ...bare, subject: { quote: subjectQuote, service: 'WaveGuard' } } }).visit?.id).toBe('visit');
  for (const spoken of ['I will text you a link to pick a new time for your appointment.',
    'I will send you a link to move your appointment.', 'Let me text you a link to re-schedule that visit.']) {
    expect(select({ call: { ...call, transcription: `Agent: ${spoken}` },
      commitment: { ...commitment, evidence: [{ quote: spoken, speaker: 'agent' }] } }).visit?.id).toBe('visit');
  }
});

test('generic slot wording and first-booking wording are not a reschedule promise', () => {
  for (const spoken of ['I will text you a link to choose a time for your new service.',
    'I will text you a link to pick a new time.', 'I will text you a link to get you on the schedule.']) {
    expect(select({ call: { ...call, transcription: `Agent: ${spoken}` },
      commitment: { ...commitment, evidence: [{ quote: spoken, speaker: 'agent' }] } }).reason).toBe('promise_needs_review');
  }
});

test('an agent who takes the promise back later in the call stops the send', () => {
  const retracted = `${call.transcription}\nAgent: Actually I cannot send that link, the office will call you.`;
  expect(select({ call: { ...call, transcription: retracted } }).reason).toBe('promise_needs_review');
  // An ordinary later turn is not a retraction, and a retraction spoken
  // BEFORE the promise does not reach back over it.
  expect(select({ call: { ...call, transcription: `${call.transcription}\nAgent: You are all set, have a good day.` } }).visit?.id).toBe('visit');
  expect(select({ call: { ...call, transcription: `Agent: I cannot send that link yet.\nAgent: ${quote}` } }).visit?.id).toBe('visit');
});

test('a caller refusal revokes only the channel it names, wherever in the call it falls', () => {
  // An early "don't email me anything" refuses only email — it never touches
  // the SMS channel the agent goes on to promise, regardless of where in the
  // call it falls.
  const early = `Caller: Don't email me anything, please.\nAgent: ${quote}\nCaller: Thank you.`;
  expect(select({ call: { ...call, transcription: early } }).visit?.id).toBe('visit');

  // "Don't email it—text it" in ONE caller turn, spoken AFTER the promise,
  // refuses only email and asks for the text in the same breath — a
  // channel-blind scan read the whole turn as refusing every channel,
  // including the SMS the agent actually promised and this worker only ever
  // sends over.
  const namedChannel = `Agent: ${quote}\nCaller: Don't email it, text it.`;
  expect(select({ call: { ...call, transcription: namedChannel } }).visit?.id).toBe('visit');

  // A later, unqualified refusal after the promise still stands down exactly
  // as before (the existing 'a caller request... revocation cannot send'
  // test covers this baseline; repeated here as the order/channel test's own
  // negative control).
  const stillRefused = `Agent: ${quote}\nCaller: Do not text me that.`;
  expect(select({ call: { ...call, transcription: stillRefused } }).reason).toBe('promise_needs_review');
});

test('a refusal spoken before the promise still stands (codex #4293 P1 r5)', () => {
  // A refusal spoken BEFORE the agent's promise is not withdrawn by the
  // agent going on to promise the very thing the caller refused — the
  // agent's promise is not a consent event at all, and scanning only the
  // turns after it (round 4's fix) quietly made the agent's own words the
  // cutoff for the customer's wishes (codex #4293 P1 r5). This is the
  // consent bug itself: without the whole-call fold, a pre-promise refusal
  // is silently discarded and the link goes out.
  const transcription = `Caller: Do not text me any links.\nAgent: ${quote}`;
  expect(select({ call: { ...call, transcription } }).reason).toBe('promise_needs_review');
});

test('a pre-promise refusal is still lifted by a later caller request for the text (codex #4293 P1 r5)', () => {
  const transcription = `Caller: Do not text me any links.\nAgent: ${quote}\nCaller: Actually, text it to me.`;
  expect(select({ call: { ...call, transcription } }).visit?.id).toBe('visit');
});

test('a caller request for the text followed by a later refusal still refuses (codex #4293 P1 r5)', () => {
  const transcription = `Caller: Text it to me.\nAgent: ${quote}\nCaller: Actually, do not text me that.`;
  expect(select({ call: { ...call, transcription } }).reason).toBe('promise_needs_review');
});

test.each([
  // The bare word "text" appears AFTER the negation in every one of these,
  // exactly the shape that used to flip `refused` back to false: the
  // refusal's own object ("the link", "that") or its own channel noun
  // ("texts") is not a later request superseding it (codex #4293 P1).
  'Do not send the link by text.',
  "Don't text me the link.",
  'No texts please.',
  "Please don't send that by text.",
])('a negated channel phrase stays refused — the refusal cannot supply the token that reverses itself (%s) (codex #4293 P1)', (refusal) => {
  const transcription = `Agent: ${quote}\nCaller: ${refusal}`;
  expect(select({ call: { ...call, transcription } }).reason).toBe('promise_needs_review');
});

test('a genuine change of mind in a LATER clause still supersedes an earlier refusal (codex #4293 P1)', () => {
  // Round 4's real target: an affirmative ask ("actually, text it to me"),
  // not a bare channel noun, in a clause the refusal itself never reached.
  const transcription = `Agent: ${quote}\nCaller: Don't email me the link... actually, text it to me.`;
  expect(select({ call: { ...call, transcription } }).visit?.id).toBe('visit');
});

// A knex stand-in that records the filters the worker builds and the writes it
// makes. Only the shapes this module actually uses are modelled; builders are
// thenable the way knex's are.
// `selfServeVisitIds` is the set of visits that have a self-serve move on
// record at all — what reconcileUsedLinks's correlated EXISTS against
// reschedule_log admits into the bounded scan (modelled here by filtering
// the outbox rows the moment that predicate is applied); `selfServe` still
// answers the per-row exact-match check (selfServeMoveAfterSend). Defaulting
// the former from the latter — present for every outbox row when
// `selfServe` is truthy, empty when it is not — keeps every existing fixture
// behaving exactly as before; pass it explicitly to pull the two apart.
// `smsRows` (when given) are answered through the sms_log evidence query's
// own status allowlist and NOT NULL predicates, so a SID-less row can be
// shown to fall out of the result rather than merely asserting the SQL.
// `filterStatus` makes the outbox rows honour the sweep's status allowlist
// the way the real WHERE does.
function fakeConn({ outbox = [], selfServe = null, selfServeVisitIds = null, cards = [], throwOn = null, smsLog = null, smsRows = null, systemSettings = {}, filterStatus = false, calls = [], commitments = [] } = {}) {
  const seen = { statusAllowlist: null, logFilters: [], visitIdFilters: [], orderByCalls: [], whereRawCalls: [], updates: [], inserts: [], resolved: [] };
  const openCards = () => cards.filter((card) => !seen.resolved.includes(card.id));
  const evidenceVisitIds = () => (selfServeVisitIds !== null ? selfServeVisitIds
    : selfServe ? [...new Set(outbox.map((row) => row.related_scheduled_service_id).filter(Boolean))] : []);
  const build = (table) => {
    const name = String(table).split(' ')[0];
    const state = { eq: {}, ranges: [], whereIn: [], notNull: [], evidenceFilter: false, orPredicates: [] };
    const statusIn = (row) => state.whereIn.filter((w) => w.col === 'status').every((w) => w.values.includes(row.status));
    const rows = () => {
      if (name === 'outbox_messages') {
        return outbox.filter((row) => (!state.evidenceFilter || evidenceVisitIds().includes(row.related_scheduled_service_id))
          && (!filterStatus || statusIn(row)));
      }
      if (name === 'triage_items') return openCards();
      if (name === 'sms_log' && smsRows) return smsRows.filter((row) => statusIn(row) && state.notNull.every((col) => row[col] != null));
      if (name === 'call_log') return calls.filter((row) => Object.entries(state.eq).every(([k, v]) => row[k] === v));
      // needsSendInterlock's pre-staging check (codex #4293 P1): an open
      // commitment with no outbox row at all yet. `orPredicates` covers the
      // human_state null-or-confirmed clause below — a query-builder
      // callback, not a plain eq object.
      if (name === 'call_commitments') {
        return commitments.filter((row) => Object.entries(state.eq).every(([k, v]) => row[k] === v)
          && state.whereIn.every((w) => w.values.includes(row[w.col]))
          && (state.orPredicates.length === 0 || state.orPredicates.some((fn) => fn(row))));
      }
      return [];
    };
    const b = {};
    const pass = (fn) => (...args) => { if (fn) fn(...args); return b; };
    Object.assign(b, {
      whereNotNull: pass((col) => state.notNull.push(col)), orWhereNotNull: pass(), whereNot: pass(), whereNotIn: pass(),
      orWhere: pass((col, val) => state.orPredicates.push((row) => row[col] === val)),
      whereRaw: pass((sql, bindings) => {
        seen.whereRawCalls.push({ table: name, sql, bindings });
        if (name === 'outbox_messages' && /reschedule_log/.test(sql)) state.evidenceFilter = true;
      }),
      whereNull: pass((col) => state.orPredicates.push((row) => row[col] == null)),
      join: pass(), leftJoin: pass(), limit: pass(), forUpdate: pass(), forShare: pass(),
      orderBy: pass((arg) => seen.orderByCalls.push({ table: name, arg })),
      onConflict: () => ({ ignore: async () => 1 }),
      whereIn: pass((col, values) => {
        if (name === 'outbox_messages' && col === 'status') seen.statusAllowlist = values;
        state.whereIn.push({ col, values });
      }),
      where: pass((first, op, value) => {
        // knex passes the sub-builder as BOTH `this` and the first argument
        // — real code in this codebase already relies on the arrow-function
        // form (e.g. admin-estimate-persistence.js's `.where((q) => ...)`),
        // so the mock has to support it too, not just the `this`-only style.
        if (typeof first === 'function') first.call(b, b);
        else if (first && typeof first === 'object') Object.assign(state.eq, first);
        else state.ranges.push({ col: first, op, value });
      }),
      modify: (fn) => { fn(b); return b; },
      then: (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject),
      select: pass(),   // knex returns the builder; awaiting it yields the rows
      pluck: async (col) => {
        if (name === 'call_log' && col === 'id') return rows().map((row) => row.id);
        // A bulk pluck of reschedule_log is the unbounded shape the r3 P2
        // retired; it is recorded so a regression back to it is visible.
        if (name !== 'reschedule_log' || col !== 'scheduled_service_id') return [];
        seen.visitIdFilters.push({ eq: { ...state.eq } });
        return evidenceVisitIds();
      },
      first: async () => {
        if (name === 'outbox_messages') {
          if (throwOn && state.eq.id === throwOn) throw new Error('Promised-link delivery evidence is truncated');
          if (state.eq.id !== undefined) return outbox.find((row) => row.id === state.eq.id) || null;
          return outbox[0] || null;
        }
        if (name === 'reschedule_log') { seen.logFilters.push({ eq: { ...state.eq }, ranges: [...state.ranges] }); return selfServe; }
        if (name === 'triage_items') return openCards()[0] || null;
        if (name === 'sms_log') return smsLog;
        if (name === 'system_settings') {
          const key = state.eq.key;
          return key != null && systemSettings[key] !== undefined ? { value: systemSettings[key] } : null;
        }
        if (name === 'call_commitments') return rows()[0] || null;
        return null;
      },
      insert: (data) => {
        seen.inserts.push({ table: name, data });
        // 'insert-if-absent' for system_settings mirrors onConflict('key').ignore()
        // in production: first writer wins, everyone else just reads it back.
        const settle = () => {
          if (name === 'system_settings' && data?.key && !(data.key in systemSettings)) systemSettings[data.key] = data.value;
          return 1;
        };
        return {
          then: (resolve, reject) => Promise.resolve().then(() => [settle()]).then(resolve, reject),
          onConflict: () => ({
            ignore: async () => settle(),
            merge: async (mergeData) => {
              if (name === 'system_settings' && data?.key) systemSettings[data.key] = (mergeData && 'value' in mergeData) ? mergeData.value : data.value;
              return 1;
            },
          }),
        };
      },
      update: async (patch) => {
        seen.updates.push({ table: name, eq: { ...state.eq }, whereIn: [...state.whereIn], patch });
        if (name === 'triage_items' && patch.status === 'resolved' && state.eq.id) seen.resolved.push(state.eq.id);
        return 1;
      },
    });
    return b;
  };
  const conn = (table) => build(table);
  // Doubles as an inline SQL fragment (sql/bindings, for whereIn(conn.raw(...)))
  // AND as the persistedActivationBoundary's direct `await conn.raw('SELECT
  // now() ...')` — a plain (non-thenable) object just resolves to itself
  // under await, so both callers read what they need off the same value.
  // deliveryUncertainPatch's jsonb-merge idiom is a THIRD shape: production
  // code passes its raw() result straight into `.update({ payload: ... })`
  // to merge under the row's own lock rather than replace from a JS
  // snapshot (codex #4293 P1) — genuinely exercising that merge against a
  // concurrent writer needs the real-PG suite, but a unit test asserting
  // the resulting FLAG value still needs `patch.payload.<key>` to read
  // through, so this recognizes the one-binding jsonb-merge call shape and
  // hands back the parsed patch object directly instead of the opaque
  // {sql,bindings,rows} wrapper every other raw() caller here still gets.
  conn.raw = (sql, bindings) => {
    if (Array.isArray(bindings) && bindings.length === 1 && typeof bindings[0] === 'string' && /COALESCE\(payload/.test(sql)) {
      try { return JSON.parse(bindings[0]); } catch { /* not the merge idiom after all — fall through */ }
    }
    return { sql, bindings, rows: [{ now: new Date() }] };
  };
  conn.transaction = async (fn) => fn(conn);
  return { conn, seen };
}

const sentRow = { id: 'outbox', status: 'sent', commitment_id: 'commitment', related_call_log_id: 'call',
  related_scheduled_service_id: 'visit', sent_at: new Date('2030-01-07T12:00:00Z') };

test('promised-link delivery evidence requires the provider\'s own id, not merely an accepted-looking status', async () => {
  // Two SID-less sms_log shapes otherwise pass the status allowlist:
  // push-channel-routing's own App-notification proof row (status 'sent',
  // from_phone 'push', twilio_sid always null — codex #4293 P2 r8), and a
  // scheduled operator text that claimDueScheduledSms (scheduler.js:286-313)
  // has already moved to 'sending' BEFORE the provider call — if that send
  // is then blocked or returned to 'scheduled', twilio_sid is still null
  // (codex #4293 P2 r3). Requiring the provider's own sid — the one thing
  // every real send carries (twilio.js writes twilio_sid: message.sid after
  // the handoff) — covers both in one predicate; neither counts as evidence.
  const linkBody = `Your reschedule link: ${portalUrl(`/reschedule/${visit.reschedule_token}`)}`;
  const noEvidence = [
    { id: 'push', status: 'sent', twilio_sid: null, message_body: linkBody },
    { id: 'presend', status: 'sending', twilio_sid: null, message_body: linkBody },
  ];
  const { conn: withoutSid } = fakeConn({ smsRows: noEvidence });
  expect(await links.matchingSend(withoutSid, { visit, customer }, new Date('2030-01-07T12:00:00Z'))).toBeNull();

  // The identical shape WITH a provider sid IS evidence.
  const withSid = [{ id: 'real', status: 'sent', twilio_sid: 'SM123', message_body: linkBody }];
  const { conn: withEvidence } = fakeConn({ smsRows: withSid });
  const result = await links.matchingSend(withEvidence, { visit, customer }, new Date('2030-01-07T12:00:00Z'));
  expect(result?.id).toBe('real');
});

// A dedicated stand-in for stagePromises' own tables (call_commitments /
// call_log / outbox_messages) — the main fakeConn above is shaped around
// outbox_messages/triage_items/reschedule_log/sms_log for the sweep and
// reconcile paths, a different join entirely. `commitments` and `outbox`
// stand in for "what the query would find": eligible commitments needing a
// fresh row are exactly those with no existing outbox row whose
// commitment_generation is already at or past the commitment's own current
// processing_generation — the same predicate stagePromises' own NOT EXISTS
// subquery encodes.
function fakeStageConn({ commitments = [], outbox = [] } = {}) {
  const inserts = [];
  const updates = [];
  const state = { generationAware: false, uncertaintyAware: false };
  // A staff Confirm ('confirmed') is an affirmative review, not a claim —
  // it stays eligible for staging exactly like a never-touched (NULL) row;
  // only a genuinely terminal human_state ('dismissed', say) excludes it
  // (codex #4293 P1 r4).
  const base = (cc) => cc.kind === 'send_reschedule_link' && cc.party === 'waves' && cc.status === 'open'
    && (cc.human_state == null || cc.human_state === 'confirmed');
  // An older-generation row's own send outcome is "genuinely unknown" ONLY
  // when its payload carries the dedicated delivery_outcome_uncertain flag —
  // never inferred from status/last_error, which a context error (a
  // stale_extraction reprocess, say) churns on every unrelated pass and
  // would otherwise erase the very signal this predicate exists to protect
  // (codex #4293 P1). It might already have reached the customer with no
  // evidence recorded yet.
  const uncertain = (cc) => outbox.some((o) => o.commitment_id === cc.id && (o.commitment_generation ?? -1) < (cc.processing_generation ?? 0)
    && o.payload?.delivery_outcome_uncertain === true);
  // If the query never asks a generation-aware question at all (whereRaw
  // mentioning commitment_generation), fall back to the OLD "any existing
  // row at all counts as staged" reading — the exact bug: this excludes a
  // reopened commitment whose only outbox row is for a stale generation,
  // proving a regression back to that shape would leave it unstaged again.
  const eligible = () => commitments.filter((cc) => base(cc) && (state.generationAware
    ? !outbox.some((o) => o.commitment_id === cc.id && (o.commitment_generation ?? -1) >= (cc.processing_generation ?? 0))
    : !outbox.some((o) => o.commitment_id === cc.id))
    // If the query never asks the uncertainty question either, nothing is
    // held back on that basis — a regression that dropped the second
    // whereRaw entirely would still stage over an uncertain older attempt,
    // which is exactly the bug this predicate exists to catch.
    && (!state.uncertaintyAware || !uncertain(cc)));
  const conn = (table) => {
    const name = String(table).split(' ')[0];
    const b = {};
    const pass = () => (...args) => b;
    Object.assign(b, {
      join: pass(), leftJoin: pass(), where: pass(), whereNull: pass(), whereIn: pass(), limit: pass(), select: pass(),
      whereRaw: (sql) => {
        if (name === 'call_commitments' && /commitment_generation/.test(sql)) {
          // The predicate must read the payload flag itself, never
          // status/last_error — a regression back to inferring uncertainty
          // from those two churny fields is exactly codex #4293 P1's bug.
          if (/delivery_outcome_uncertain/.test(sql)) state.uncertaintyAware = true;
          else state.generationAware = true;
        }
        return b;
      },
      then: (resolve, reject) => Promise.resolve()
        .then(() => (name === 'call_commitments' ? eligible().map((cc) => ({ ...cc })) : []))
        .then(resolve, reject),
      update: async (patch) => {
        // The retire step (unattempted older-generation rows, cancelled
        // before the fresh row for the same commitment is inserted).
        updates.push({ table: name, patch });
        return 0;
      },
      insert: (data) => {
        inserts.push({ table: name, data });
        return {
          // Records the conflict target exactly as the caller named it — a
          // bare column-list target here would silently be the wrong shape
          // for a partial index (Postgres itself would refuse it), so this
          // is what proves the fix names the SAME predicate as the index.
          onConflict: (target) => ({
            ignore: async () => {
              inserts[inserts.length - 1].conflictTarget = target;
              if (name === 'outbox_messages') outbox.push({ commitment_id: data.commitment_id, commitment_generation: data.commitment_generation });
              return 1;
            },
          }),
        };
      },
    });
    return b;
  };
  conn.raw = (sql) => ({ __raw: sql });
  return { conn, inserts, updates, outbox };
}

test('a replacement recording reopening a delivered commitment stages a fresh outbox row', async () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
    // upsertCommitments reset this commitment to open and stamped generation
    // 2 on the reprocess pass — but generation 1 already has a delivered
    // outbox row, and the OLD whereNull('o.id') join would have treated that
    // as "already staged," leaving the reopened promise with nothing left
    // driving it toward delivery (codex #4293 P1, missed on 5ce420509).
    const reopened = { id: 'commitment', call_log_id: 'call', customer_id: 'customer', created_at: new Date('2030-01-08T00:00:00Z'),
      processing_generation: 2, kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: null };
    const { conn, inserts } = fakeStageConn({
      commitments: [reopened],
      outbox: [{ commitment_id: 'commitment', commitment_generation: 1 }],
    });
    const staged = await links.stagePromises(conn);
    expect(staged).toBe(1);
    const staging = inserts.find((i) => i.table === 'outbox_messages');
    expect(staging).toBeDefined();
    expect(staging.data).toMatchObject({ commitment_id: 'commitment', commitment_generation: 2 });
    // The conflict target must name EXACTLY the same columns and predicate
    // as the partial unique index (migration 20260911000030) — a bare
    // column-list target does not match a partial index at all, and
    // Postgres refuses the insert outright rather than silently ignoring a
    // real duplicate (codex #4293 P1, round 2 on baa4cf295).
    expect(staging.conflictTarget).toEqual({ __raw: '(commitment_id, commitment_generation) WHERE commitment_id IS NOT NULL' });
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});

test('the same generation already staged is never restaged', async () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
    const unchanged = { id: 'commitment', call_log_id: 'call', customer_id: 'customer', created_at: new Date('2030-01-08T00:00:00Z'),
      processing_generation: 1, kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: null };
    const { conn, inserts } = fakeStageConn({
      commitments: [unchanged],
      outbox: [{ commitment_id: 'commitment', commitment_generation: 1 }],
    });
    expect(await links.stagePromises(conn)).toBe(0);
    expect(inserts).toEqual([]);
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});

describe('a reprocess must not double up on an older attempt whose outcome is unknown (codex #4293 P1)', () => {
  test.each([
    ['sending', null],
    ['review', 'provider_outcome_unknown'],
    // The exact regression this round fixes: a stale_extraction (or any
    // other context error) reprocess overwrites last_error on its way
    // through parkReview, but the row is STILL genuinely uncertain — only
    // the dedicated payload flag says so now, and it is what the guard must
    // actually read.
    ['review', 'stale_extraction'],
  ])('an older-generation row still %s (last_error %s) blocks a fresh dispatch while delivery_outcome_uncertain is set', async (status, last_error) => {
    const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
    try {
      gates.callCommitments = true;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
      // upsertCommitments bumped this commitment to generation 2 on a
      // reprocess pass, but generation 1's own attempt never reached a
      // known outcome — it might already have reached the customer with no
      // sms_log evidence recorded. Staging a second row here would risk
      // sending the same promised link twice.
      const reopened = { id: 'commitment', call_log_id: 'call', customer_id: 'customer', created_at: new Date('2030-01-08T00:00:00Z'),
        processing_generation: 2, kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: null };
      const { conn, inserts, updates } = fakeStageConn({
        commitments: [reopened],
        outbox: [{ commitment_id: 'commitment', commitment_generation: 1, status, last_error, payload: { delivery_outcome_uncertain: true } }],
      });
      expect(await links.stagePromises(conn)).toBe(0);
      expect(inserts).toEqual([]);
      // The uncertain row is left exactly as it was — held, not touched.
      expect(updates).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
      gates.callCommitments = priorCommitments;
    }
  });

  test('a pre-fix older-generation row with no delivery_outcome_uncertain flag does not retroactively block, even mid-"sending"', async () => {
    // A row already in flight when this fix deploys never got the flag
    // stamped at claim time — behaves exactly as it did before this round,
    // not as a NEW hold (codex #4293 P1 requirement: no retroactive
    // blocking of historical rows).
    const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
    try {
      gates.callCommitments = true;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
      const reopened = { id: 'commitment', call_log_id: 'call', customer_id: 'customer', created_at: new Date('2030-01-08T00:00:00Z'),
        processing_generation: 2, kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: null };
      const { conn, inserts } = fakeStageConn({
        commitments: [reopened],
        outbox: [{ commitment_id: 'commitment', commitment_generation: 1, status: 'sending', last_error: null, payload: {} }],
      });
      expect(await links.stagePromises(conn)).toBe(1);
      expect(inserts.find((i) => i.table === 'outbox_messages')).toMatchObject({ data: { commitment_id: 'commitment', commitment_generation: 2 } });
    } finally {
      if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
      gates.callCommitments = priorCommitments;
    }
  });

  test('an older-generation row that was NEVER attempted is retired and the new one proceeds', async () => {
    const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
    try {
      gates.callCommitments = true;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
      const reopened = { id: 'commitment', call_log_id: 'call', customer_id: 'customer', created_at: new Date('2030-01-08T00:00:00Z'),
        processing_generation: 2, kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: null };
      // Generation 1's row never got past claimForDispatch — still
      // 'pending' — so it is stale, not uncertain: the reprocess superseded
      // it before it ever reached the provider.
      const { conn, inserts, updates } = fakeStageConn({
        commitments: [reopened],
        outbox: [{ commitment_id: 'commitment', commitment_generation: 1, status: 'pending', last_error: null }],
      });
      expect(await links.stagePromises(conn)).toBe(1);
      const retire = updates.find((u) => u.table === 'outbox_messages');
      expect(retire).toMatchObject({ patch: { status: 'cancelled', last_error: 'superseded_generation' } });
      const staging = inserts.find((i) => i.table === 'outbox_messages');
      expect(staging).toMatchObject({ data: { commitment_id: 'commitment', commitment_generation: 2 } });
    } finally {
      if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
      gates.callCommitments = priorCommitments;
    }
  });
});

describe('a staff Confirm is an affirmative review, not a claim (codex #4293 P1 r4)', () => {
  test('stagePromises still stages a confirmed commitment exactly like an untouched one', async () => {
    const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
    try {
      gates.callCommitments = true;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
      const confirmed = { id: 'commitment', call_log_id: 'call', customer_id: 'customer', created_at: new Date('2030-01-08T00:00:00Z'),
        processing_generation: 1, kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: 'confirmed' };
      const { conn, inserts } = fakeStageConn({ commitments: [confirmed], outbox: [] });
      expect(await links.stagePromises(conn)).toBe(1);
      expect(inserts.find((i) => i.table === 'outbox_messages')).toBeDefined();

      // A genuinely terminal human_state stays excluded.
      const dismissed = { ...confirmed, human_state: 'dismissed' };
      const { conn: dismissedConn, inserts: dismissedInserts } = fakeStageConn({ commitments: [dismissed], outbox: [] });
      expect(await links.stagePromises(dismissedConn)).toBe(0);
      expect(dismissedInserts).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
      gates.callCommitments = priorCommitments;
    }
  });

  // A minimal call_commitments-only fake, distinct from the shared fakeConn
  // above (shaped around outbox_messages/triage_items) — contextFor's first
  // gate is judged entirely against the commitment row itself, before any
  // call/customer/visit lookup runs.
  function fakeContextConn(commitment) {
    const conn = (table) => {
      const name = String(table).split(' ')[0];
      const b = {};
      const pass = () => (...a) => b;
      Object.assign(b, {
        where: pass(), whereNull: pass(), leftJoin: pass(), join: pass(), select: pass(), whereIn: pass(),
        first: async () => (name === 'call_commitments' ? commitment : null),
      });
      return b;
    };
    return conn;
  }

  test('contextFor keeps a confirmed promise eligible; a genuinely terminal human_state still closes it', async () => {
    const open = { id: 'commitment', call_log_id: 'call', status: 'open', human_state: null, source: 'ai', last_seen_generation: 1, evidence: '[]', subject: null };
    // With no call_log row behind either, both null and 'confirmed' fall
    // through the human_state gate to the NEXT check (stale_extraction) —
    // never 'promise_closed'.
    expect((await links.contextFor(fakeContextConn(open), 'commitment', new Date())).reason).toBe('stale_extraction');
    expect((await links.contextFor(fakeContextConn({ ...open, human_state: 'confirmed' }), 'commitment', new Date())).reason).toBe('stale_extraction');
    expect((await links.contextFor(fakeContextConn({ ...open, human_state: 'dismissed' }), 'commitment', new Date())).reason).toBe('promise_closed');
    // A non-open status is terminal regardless of human_state.
    expect((await links.contextFor(fakeContextConn({ ...open, status: 'fulfilled', human_state: 'confirmed' }), 'commitment', new Date())).reason).toBe('promise_closed');
  });

  // A minimal call_commitments-only fake for fulfilPromise: the row lives in
  // `state`, mutated in place by a matching update — an unmatched update
  // (the exact WHERE-filter bug this proves) returns 0 and leaves it alone.
  function fakeFulfilConn(commitment) {
    const state = { ...commitment };
    function commitmentsBuilder() {
      const eq = {};
      const orMatchers = [];
      const b = {
        where(a) {
          if (typeof a === 'function') {
            const sub = {
              whereNull: (col) => { orMatchers.push((row) => row[col] == null); return sub; },
              orWhere: (col, val) => { orMatchers.push((row) => row[col] === val); return sub; },
            };
            a(sub, sub);
          } else Object.assign(eq, a);
          return b;
        },
        forUpdate: () => b,
        first: async () => (Object.entries(eq).every(([k, v]) => state[k] === v) ? { ...state } : null),
        update: async (patch) => {
          const eqMatches = Object.entries(eq).every(([k, v]) => state[k] === v);
          const orMatches = orMatchers.length === 0 || orMatchers.some((fn) => fn(state));
          if (!eqMatches || !orMatches) return 0;
          Object.assign(state, patch);
          return 1;
        },
      };
      return b;
    }
    function noopBuilder() {
      const b = {};
      const pass = () => (...a) => b;
      Object.assign(b, { where: pass(), whereIn: pass(), whereNotIn: pass(), forUpdate: pass(), forShare: pass(),
        select: async () => [], first: async () => null, update: async () => 0 });
      return b;
    }
    const conn = (table) => (String(table).split(' ')[0] === 'call_commitments' ? commitmentsBuilder() : noopBuilder());
    return { conn, state };
  }

  test.each([
    [null, 'fulfilled'],
    ['confirmed', 'fulfilled'],
    ['dismissed', 'open'],
  ])('fulfilPromise on a delivery receipt racing a Confirm: human_state=%p -> %s', async (humanState, expectedStatus) => {
    const { conn, state } = fakeFulfilConn({ id: 'commitment', status: 'open', human_state: humanState });
    await links.fulfilPromise(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call' },
      { id: 'sms1' }, { id: 'call' });
    expect(state.status).toBe(expectedStatus);
  });

  // A minimal call_commitments + triage_items/call_log stand-in for
  // clearPromiseException's own resync, distinct from fakeFulfilConn's
  // commitments-only noop tables — the P1-2 tests below need to prove the
  // card is left INTACT, not merely that the commitment status is
  // untouched.
  function fakeFulfilConnWithCard(commitment, card) {
    const state = { ...commitment };
    const cardState = card ? { ...card } : null;
    function commitmentsBuilder() {
      const eq = {};
      const orMatchers = [];
      const b = {
        where(a) {
          if (typeof a === 'function') {
            const sub = {
              whereNull: (col) => { orMatchers.push((row) => row[col] == null); return sub; },
              orWhere: (col, val) => { orMatchers.push((row) => row[col] === val); return sub; },
            };
            a(sub, sub);
          } else Object.assign(eq, a);
          return b;
        },
        forUpdate: () => b,
        first: async (...cols) => {
          if (!Object.entries(eq).every(([k, v]) => state[k] === v)) return null;
          if (!cols.length) return { ...state };
          const picked = {};
          for (const col of cols) picked[col] = state[col];
          return picked;
        },
        update: async (patch) => {
          const eqMatches = Object.entries(eq).every(([k, v]) => state[k] === v);
          const orMatches = orMatchers.length === 0 || orMatchers.some((fn) => fn(state));
          if (!eqMatches || !orMatches) return 0;
          Object.assign(state, patch);
          return 1;
        },
      };
      return b;
    }
    function triageBuilder() {
      const eq = {};
      const inFilters = [];
      const b = {
        where(a) { Object.assign(eq, a); return b; },
        whereIn(col, vals) { inFilters.push([col, vals]); return b; },
        select: async (...cols) => {
          if (!cardState) return [];
          if (!Object.entries(eq).every(([k, v]) => cardState[k] === v)) return [];
          if (!inFilters.every(([col, vals]) => vals.includes(cardState[col]))) return [];
          const picked = {};
          for (const col of cols) picked[col] = cardState[col];
          return [picked];
        },
        update: async (patch) => { if (cardState) Object.assign(cardState, patch); return cardState ? 1 : 0; },
        first: async () => (cardState && cardState.status && ['open', 'in_progress'].includes(cardState.status) ? { id: cardState.id } : null),
      };
      return b;
    }
    function callLogBuilder() {
      const b = {};
      const pass = () => (...a) => b;
      Object.assign(b, { where: pass(), update: async () => 1 });
      return b;
    }
    function noopBuilder() {
      const b = {};
      const pass = () => (...a) => b;
      Object.assign(b, { where: pass(), whereIn: pass(), whereNotIn: pass(), forUpdate: pass(), forShare: pass(),
        select: async () => [], first: async () => null, update: async () => 0 });
      return b;
    }
    const conn = (table) => {
      const name = String(table).split(' ')[0];
      if (name === 'call_commitments') return commitmentsBuilder();
      if (name === 'triage_items') return triageBuilder();
      if (name === 'call_log') return callLogBuilder();
      return noopBuilder();
    };
    return { conn, state, cardState };
  }

  test('a late delivery receipt for a SUPERSEDED generation settles its own outbox row but leaves the replacement commitment open with its card intact (codex #4293 P1)', async () => {
    // A replacement recording reopened this same commitment under
    // generation 2 after the customer used the generation-1 link — the
    // outbox row's own payload still carries the generation it was
    // actually claimed and settled under.
    const { conn, state, cardState } = fakeFulfilConnWithCard(
      { id: 'commitment', status: 'open', human_state: null, last_seen_generation: 2 },
      { id: 'card', call_log_id: 'call', reason_code: 'reschedule_link_promise', status: 'open', payload: { reschedule_link_promise: { commitment_ids: ['commitment'] } } },
    );
    await links.fulfilPromise(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call', payload: { call_generation: 1 } },
      { id: 'sms1' }, { id: 'call' });
    // The commitment (the REPLACEMENT obligation) is untouched — still open.
    expect(state.status).toBe('open');
    expect(state.fulfilled_at).toBeUndefined();
    // ...and its exception card is still intact, not cleared.
    expect(cardState.status).toBe('open');
  });

  test('a late delivery receipt for the CURRENT generation still fulfils the commitment and clears its card', async () => {
    const { conn, state, cardState } = fakeFulfilConnWithCard(
      { id: 'commitment', status: 'open', human_state: null, last_seen_generation: 1 },
      { id: 'card', call_log_id: 'call', reason_code: 'reschedule_link_promise', status: 'open', payload: { reschedule_link_promise: { commitment_ids: ['commitment'] } } },
    );
    await links.fulfilPromise(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call', payload: { call_generation: 1 } },
      { id: 'sms1' }, { id: 'call' });
    expect(state.status).toBe('fulfilled');
    expect(cardState.status).toBe('resolved');
  });

  test('a row with no recorded generation falls back to the old, ungated behavior', async () => {
    const { conn, state } = fakeFulfilConnWithCard({ id: 'commitment', status: 'open', human_state: null, last_seen_generation: 9 }, null);
    await links.fulfilPromise(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call', payload: {} },
      { id: 'sms1' }, { id: 'call' });
    expect(state.status).toBe('fulfilled');
  });

  // markLinkUsed's own generation fence (codex #4293 P1 — this round's sweep):
  // fulfilPromise's fence protects the DELIVERY path from a stale generation
  // fulfilling a replacement commitment's live obligation; this is the
  // identical hole at the USED-LINK path. The reschedule token lives on the
  // VISIT, not on any one outbox generation, so a customer can click an
  // OLDER attempt's link after a replacement recording has already reopened
  // the same commitment_id and parked a fresh attempt of its own. Clearing
  // the shared exception card on that stale click would erase the office's
  // only visibility into the replacement's still-open obligation. A
  // dedicated fake connection is needed here (unlike fakeFulfilConnWithCard
  // above) because markLinkUsed, unlike fulfilPromise, itself reads and
  // writes outbox_messages — its own reconciliation stamp — inside the same
  // transaction as the card check.
  function fakeMarkLinkUsedConn({ commitment, outboxPayload, cardPayload }) {
    const commitmentState = { ...commitment };
    const outboxState = { status: 'review', payload: outboxPayload };
    const cardState = cardPayload ? { id: 'card', call_log_id: 'call', reason_code: 'reschedule_link_promise', status: 'open', payload: cardPayload } : null;
    const callLogState = { id: 'call', review_status: 'open' };
    function commitmentsBuilder() {
      const eq = {};
      const b = {
        where(a) { Object.assign(eq, a); return b; },
        forUpdate: () => b,
        first: async (...cols) => {
          if (!Object.entries(eq).every(([k, v]) => commitmentState[k] === v)) return null;
          if (!cols.length) return { ...commitmentState };
          const picked = {};
          for (const col of cols) picked[col] = commitmentState[col];
          return picked;
        },
      };
      return b;
    }
    function outboxBuilder() {
      const eq = {};
      const b = {
        where(a) { Object.assign(eq, a); return b; },
        first: async (...cols) => {
          if (eq.id !== 'outbox') return null;
          if (!cols.length) return { ...outboxState };
          const picked = {};
          for (const col of cols) picked[col] = outboxState[col];
          return picked;
        },
        update: async (patch) => {
          // markLinkUsed's own reconciliation stamp is a raw jsonb merge
          // (`COALESCE(payload, '{}'::jsonb) || ?::jsonb`) — replay it for
          // real against the in-memory payload rather than clobbering it.
          if (patch.payload && patch.payload.__rawMerge) {
            outboxState.payload = { ...outboxState.payload, ...patch.payload.__rawMerge };
            const { payload: _payload, ...rest } = patch;
            Object.assign(outboxState, rest);
          } else Object.assign(outboxState, patch);
          return 1;
        },
      };
      return b;
    }
    function triageBuilder() {
      const eq = {};
      const inFilters = [];
      const b = {
        where(a) { Object.assign(eq, a); return b; },
        whereIn(col, vals) { inFilters.push([col, vals]); return b; },
        select: async (...cols) => {
          if (!cardState) return [];
          if (!Object.entries(eq).every(([k, v]) => cardState[k] === v)) return [];
          if (!inFilters.every(([col, vals]) => vals.includes(cardState[col]))) return [];
          const picked = {};
          for (const col of cols) picked[col] = cardState[col];
          return [picked];
        },
        update: async (patch) => { if (cardState) Object.assign(cardState, patch); return cardState ? 1 : 0; },
        first: async () => (cardState && ['open', 'in_progress'].includes(cardState.status) ? { id: cardState.id } : null),
      };
      return b;
    }
    function callLogBuilder() {
      const b = {};
      const pass = () => (...a) => b;
      Object.assign(b, { where: pass(), update: async (patch) => { Object.assign(callLogState, patch); return 1; } });
      return b;
    }
    const conn = (table) => {
      const name = String(table).split(' ')[0];
      if (name === 'call_commitments') return commitmentsBuilder();
      if (name === 'outbox_messages') return outboxBuilder();
      if (name === 'triage_items') return triageBuilder();
      if (name === 'call_log') return callLogBuilder();
      return { where: () => ({ update: async () => 0, first: async () => null, whereIn: () => ({ select: async () => [] }) }) };
    };
    conn.transaction = async (fn) => fn(conn);
    conn.raw = (sql, bindings) => ({ __rawMerge: bindings ? JSON.parse(bindings[0]) : undefined });
    return { conn, commitmentState, outboxState, cardState, callLogState };
  }

  test('the customer using an OLDER attempt\'s link after a replacement recording reopened the commitment leaves the replacement\'s card intact (codex #4293 P1)', async () => {
    const { conn, cardState, outboxState } = fakeMarkLinkUsedConn({
      commitment: { id: 'commitment', last_seen_generation: 2 },
      outboxPayload: { call_generation: 1 },
      cardPayload: { reschedule_link_promise: { commitment_id: 'commitment', commitment_ids: ['commitment'] } },
    });
    await links.markLinkUsed(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call', related_scheduled_service_id: 'visit' });
    // The row is stamped reconciled regardless — the customer really did use
    // THIS attempt's link.
    expect(outboxState.payload.link_used_reconciled_at).toBeDefined();
    // But the shared card, which the REPLACEMENT generation's still-open
    // attempt also depends on, is left exactly as it was.
    expect(cardState.status).toBe('open');
  });

  test('the customer using the link with no replacement generation in play clears the card exactly as before', async () => {
    const { conn, cardState, outboxState } = fakeMarkLinkUsedConn({
      commitment: { id: 'commitment', last_seen_generation: 1 },
      outboxPayload: { call_generation: 1 },
      cardPayload: { reschedule_link_promise: { commitment_id: 'commitment', commitment_ids: ['commitment'] } },
    });
    await links.markLinkUsed(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call', related_scheduled_service_id: 'visit' });
    expect(outboxState.payload.link_used_reconciled_at).toBeDefined();
    expect(cardState.status).toBe('resolved');
  });

  test('a row with no recorded generation falls back to the old, ungated behavior for markLinkUsed too', async () => {
    const { conn, cardState } = fakeMarkLinkUsedConn({
      commitment: { id: 'commitment', last_seen_generation: 9 },
      outboxPayload: {},
      cardPayload: { reschedule_link_promise: { commitment_id: 'commitment', commitment_ids: ['commitment'] } },
    });
    await links.markLinkUsed(conn, { id: 'outbox', commitment_id: 'commitment', related_call_log_id: 'call', related_scheduled_service_id: 'visit' });
    expect(cardState.status).toBe('resolved');
  });
});

test('a customer relink between staging and dispatch rebinds the row under the claim transaction', async () => {
  // The office relinked this call to a different customer after the row was
  // staged but before it was planned — contextFor already resolved the
  // NEW customer's visit, but related_customer_id on the row still names
  // the OLD one. Without the rebind, the send goes out fine but a later
  // carrier receipt fails deliveryIdentityMatches (call.customer_id no
  // longer equals the row's stale related_customer_id) and the delivered
  // promise parks as delivery_scope_changed for no reason the office can
  // act on (codex #4293 P2).
  const row = promiseRow('outbox', 'commitment', { related_customer_id: 'old-customer', payload: { kind: 'send_reschedule_link' } });
  const { conn, seen } = fakeConn({ outbox: [row] });
  const context = { call: { processing_generation: 3 }, customer: { id: 'new-customer' }, visit: { id: 'visit' } };
  const now = new Date('2030-01-07T12:00:00Z');
  const link = { url: 'https://example.com/reschedule/token' };
  const result = await links.claimForDispatch(conn, row, context, { now, planned: { id: 'visit' }, link });
  expect(result).toMatchObject({ claimed: 1, relinked: true });
  const claim = seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'outbox');
  expect(claim.patch).toMatchObject({ status: 'sending', related_customer_id: 'new-customer', related_scheduled_service_id: 'visit' });
  // The rebind is recorded, not silent — an auditor can see the row moved.
  expect(claim.patch.payload).toMatchObject({ rebound_from_customer_id: 'old-customer', link: link.url });
  expect(claim.patch.payload.rebound_at).toBeDefined();
  // From the moment of claim, this attempt might reach the provider with no
  // persisted trace — the payload flag stagePromises later blocks a
  // duplicate generation on (codex #4293 P1).
  expect(claim.patch.payload.delivery_outcome_uncertain).toBe(true);
});

test('no rebind marker when the staged and revalidated customer already match', async () => {
  const row = promiseRow('outbox', 'commitment', { related_customer_id: 'customer', payload: {} });
  const { conn, seen } = fakeConn({ outbox: [row] });
  const context = { call: { processing_generation: 1 }, customer: { id: 'customer' }, visit: { id: 'visit' } };
  const result = await links.claimForDispatch(conn, row, context,
    { now: new Date('2030-01-07T12:00:00Z'), planned: { id: 'visit' }, link: { url: 'https://example.com/x' } });
  expect(result).toMatchObject({ claimed: 1, relinked: false });
  const claim = seen.updates.find((u) => u.table === 'outbox_messages');
  expect(claim.patch.related_customer_id).toBe('customer');
  expect(claim.patch.payload.rebound_from_customer_id).toBeUndefined();
});

test('a claim that cannot rebind atomically refuses dispatch with a distinct reason, not a half-updated row', async () => {
  const row = promiseRow('outbox', 'commitment', { related_customer_id: 'old-customer' });
  const { conn, seen } = fakeConn({ outbox: [row], throwOn: 'outbox' });
  const context = { call: { processing_generation: 1 }, customer: { id: 'new-customer' }, visit: { id: 'visit' } };
  const result = await links.claimForDispatch(conn, row, context,
    { now: new Date('2030-01-07T12:00:00Z'), planned: { id: 'visit' }, link: { url: 'https://example.com/x' } });
  expect(result.claimed).toBe(0);
  expect(result.error).toBeInstanceOf(Error);
  // Nothing was left half-claimed — no update was ever recorded for this row.
  expect(seen.updates).toEqual([]);
});

test('a replay that moved nothing closes no cards; a real self-serve move does', async () => {
  const none = fakeConn({ outbox: [sentRow], selfServe: null });
  expect(await links.resolveUsedLink(none.conn, 'visit')).toBe(0);
  expect(resolveRescheduleCards).not.toHaveBeenCalled();
  expect(none.seen.updates).toEqual([]);
  // The proof is a customer_self_serve reschedule_log row created after the
  // link went out — not the POST itself.
  expect(none.seen.logFilters[0].eq).toMatchObject({ scheduled_service_id: 'visit', initiated_by: 'customer_self_serve' });
  expect(none.seen.logFilters[0].ranges).toContainEqual({ col: 'created_at', op: '>=', value: sentRow.sent_at });

  const moved = fakeConn({ outbox: [sentRow], selfServe: { id: 'log' } });
  expect(await links.resolveUsedLink(moved.conn, 'visit')).toBe(1);
  expect(resolveRescheduleCards).toHaveBeenCalledWith(moved.conn, 'call', expect.any(String), 'visit');
  expect(moved.seen.updates).toEqual([expect.objectContaining({ table: 'outbox_messages', eq: { id: 'outbox' } })]);
});

test('a link used after the row was parked still closes its cards and the call', async () => {
  const parked = { ...sentRow, status: 'review' };
  const { conn, seen } = fakeConn({ outbox: [parked], selfServe: { id: 'log' }, cards: [{ id: 'card', payload: { reschedule_link_promise: { commitment_id: 'commitment', commitment_ids: ['commitment'] } } }] });
  expect(await links.reconcileUsedLinks(conn)).toBe(1);
  // Parked rows are inside the reconciliation allowlist (an attempt was made
  // even though the carrier receipt never arrived).
  expect(seen.statusAllowlist).toContain('review');
  expect(resolveRescheduleCards).toHaveBeenCalledWith(conn, 'call', expect.any(String), 'visit');
  // The promise's own exception card closes, and review_status resyncs.
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'triage_items', patch: expect.objectContaining({ status: 'resolved' }) }));
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ review_status: 'resolved' }) }));
});

test('markLinkUsed re-reads the row status FRESH under the lock — a stale caller snapshot cannot skip the card cleanup (codex #4293 P2 r4)', async () => {
  // The caller's own `row` argument still says 'sent' — that snapshot was
  // taken before this call started — but a concurrent sweep pass has since
  // parked the row to 'review' in the store this shares one call-locked
  // transaction with. Trusting the stale argument (the old code's `if
  // (row.status === 'review')`) would skip clearPromiseException and leave
  // the recreated exception card open forever.
  const stale = { ...sentRow, status: 'sent' };
  const currentlyParked = { ...sentRow, status: 'review' };
  const { conn, seen } = fakeConn({ outbox: [currentlyParked],
    cards: [{ id: 'card', payload: { reschedule_link_promise: { commitment_id: 'commitment', commitment_ids: ['commitment'] } } }] });
  await links.markLinkUsed(conn, stale);
  expect(resolveRescheduleCards).toHaveBeenCalledWith(conn, 'call', expect.any(String), 'visit');
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'triage_items', patch: expect.objectContaining({ status: 'resolved' }) }));
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ review_status: 'resolved' }) }));
  // The reconciliation stamp still lands, in the SAME transaction.
  expect(seen.updates.some((u) => u.table === 'outbox_messages' && u.eq.id === 'outbox')).toBe(true);
});

test('a visit with no self-serve move on record is never scanned by the reconcile sweep', async () => {
  // A row whose link was simply never used has no reschedule_log evidence at
  // all. An earlier round answered the starvation problem (a backlog of
  // untouched rows filling the LIMIT 100 forever, since nothing about them
  // ever changes their updated_at — codex #4293 P1) by plucking EVERY visit
  // id reschedule_log has ANY self-serve move for, the whole table's history
  // materialized on every tick and pushed back as an unbounded WHERE IN list
  // (codex #4293 P2 r3). The evidence check now lives INSIDE the bounded
  // query itself, as a correlated EXISTS against reschedule_log evaluated
  // per candidate row — nothing about the log's size is ever fetched, so a
  // regression back to the bulk-pluck shape is exactly what the first
  // assertion below catches.
  const untouched = { ...sentRow, id: 'untouched' };
  const { conn, seen } = fakeConn({ outbox: [untouched], selfServe: null, selfServeVisitIds: [] });
  expect(await links.reconcileUsedLinks(conn)).toBe(0);
  // No bulk pluck('scheduled_service_id') against reschedule_log at all.
  expect(seen.visitIdFilters).toEqual([]);
  const evidenceQuery = seen.whereRawCalls.find((c) => c.table === 'outbox_messages' && /reschedule_log/.test(c.sql));
  expect(evidenceQuery).toBeDefined();
  expect(evidenceQuery.sql).toMatch(/EXISTS/);
  expect(evidenceQuery.bindings).toEqual(['customer_self_serve']);
  // No self-serve evidence at all means the per-row check never runs either.
  expect(seen.logFilters).toEqual([]);

  // A visit that DOES have evidence on record still reconciles exactly as
  // before, through the same bounded query.
  const { conn: withEvidence, seen: seenWithEvidence } = fakeConn({ outbox: [sentRow], selfServe: { id: 'log' }, selfServeVisitIds: ['visit'] });
  const scanTime = new Date('2030-01-09T00:00:00Z');
  expect(await links.reconcileUsedLinks(withEvidence, scanTime)).toBe(1);
  expect(seenWithEvidence.visitIdFilters).toEqual([]);
  // The reconcile sweep shares the SAME fairness ordering as the send-queue
  // sweep, and stamps every row it examines, matched or not.
  expect(seenWithEvidence.orderByCalls.find((c) => c.table === 'outbox_messages').arg)
    .toEqual([{ column: 'last_scanned_at', order: 'asc', nulls: 'first' }, { column: 'updated_at', order: 'asc' }]);
  const evidenceStamp = seenWithEvidence.updates.find((u) => u.table === 'outbox_messages' && u.patch && 'last_scanned_at' in u.patch);
  expect(evidenceStamp.whereIn).toContainEqual({ col: 'id', values: ['outbox'] });
  expect(evidenceStamp.patch.last_scanned_at).toEqual(scanTime);
});

test('a large, unrelated reschedule_log history never changes what the bounded reconcile scan returns', async () => {
  // The evidence-before-LIMIT query used to pull every visit id with ANY
  // self-serve move at all, unrelated backlog included, before filtering
  // (codex #4293 P2 r3). The correlated EXISTS is scoped per candidate row,
  // so a large history for visits this sweep's own rows have nothing to do
  // with can never widen (or narrow) the result — modelling a thousand of
  // them here changes nothing about which rows reconcile.
  const manyUnrelatedVisits = Array.from({ length: 1000 }, (_, i) => `unrelated-visit-${i}`);
  const untouched = { ...sentRow, id: 'untouched' };
  const { conn: withNoise, seen: seenWithNoise } = fakeConn({ outbox: [untouched], selfServeVisitIds: manyUnrelatedVisits });
  expect(await links.reconcileUsedLinks(withNoise)).toBe(0);
  expect(seenWithNoise.visitIdFilters).toEqual([]);

  const matching = [...manyUnrelatedVisits, 'visit'];
  const { conn: withMatch } = fakeConn({ outbox: [sentRow], selfServe: { id: 'log' }, selfServeVisitIds: matching });
  expect(await links.reconcileUsedLinks(withMatch)).toBe(1);
});

const promiseRow = (id, commitmentId, extra = {}) => ({ id, status: 'pending', commitment_id: commitmentId,
  related_call_log_id: 'call', related_customer_id: 'customer', related_scheduled_service_id: 'visit', payload: {}, ...extra });

// Drive one sweep tick with the gate in shadow so nothing can reach a
// customer, and return what the tick did.
async function sweepWith(options, mode = 'shadow') {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  const fake = fakeConn(options);
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = mode;
    return { ...fake, result: await links.sweep(fake.conn, { now }) };
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
}

describe('delivery uncertainty is retired only by definitive provider evidence or an office verdict (codex #4293 P1)', () => {
  test('a real twilio_sid-bearing sms_log row showing the send failed clears the flag', async () => {
    // The row reached the provider (status 'sending', a real SID already
    // assigned) and was left genuinely uncertain — until reconcileAttempt's
    // own sms_log lookup comes back with a definitive 'failed' outcome.
    const row = promiseRow('outbox', 'commitment', { status: 'sending', provider_message_id: 'SM123',
      sent_at: now, payload: { delivery_outcome_uncertain: true } });
    const { seen } = await sweepWith({ outbox: [row], smsLog: { id: 'sms1', status: 'failed' } });
    // retireDeliveryUncertainty writes the flag as its own independent
    // update, separate from parkReview's status/last_error transition — see
    // the block comment on retireDeliveryUncertainty for why the clear must
    // never ride along on that other write.
    const clearPatch = seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'outbox' && u.patch.payload);
    const parkPatch = seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'outbox' && u.patch.status === 'review');
    expect(parkPatch.patch).toMatchObject({ status: 'review', last_error: 'delivery_failed' });
    expect(clearPatch.patch.payload.delivery_outcome_uncertain).toBe(false);
  });

  test('a definitive failure receipt reconciles even after the attempt already sits parked for an unrelated reason (codex #4293 P1)', async () => {
    // The row already parked for a transient context error (stale_extraction,
    // unrelated to delivery) when a REAL twilio_sid-bearing sms_log row later
    // proves the provider itself rejected this exact attempt — a definitive
    // failure exactly as conclusive as the still-live case above. The pre-fix
    // `failed && unparked` guard ignored this because the row was already
    // parked, leaving the flag stuck true and stagePromises blocking a
    // replacement generation FOREVER despite proof delivery failed.
    const row = promiseRow('outbox', 'commitment', { status: 'review', last_error: 'stale_extraction',
      provider_message_id: 'SM123', payload: { delivery_outcome_uncertain: true } });
    const { seen } = await sweepWith({ outbox: [row], smsLog: { id: 'sms1', status: 'failed' } });
    const patch = seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'outbox' && u.patch.payload);
    expect(patch).toBeDefined();
    // The existing review reason is left exactly as it was — only the flag moves.
    expect(patch.patch.status).toBeUndefined();
    expect(patch.patch.last_error).toBeUndefined();
    expect(patch.patch.payload.delivery_outcome_uncertain).toBe(false);
  });

  test('an office verdict (the commitment itself closed) clears the flag on the outbox row it cancels', async () => {
    // contextFor reads 'promise_closed' straight off the commitment row —
    // simulate a commitment the office already dismissed by hand, with no
    // provider id yet on this row (so reconcileAttempt is skipped and
    // applyContextSkip's own cancel path runs).
    const row = promiseRow('outbox', 'commitment', { status: 'review', last_error: 'provider_outcome_unknown',
      payload: { delivery_outcome_uncertain: true } });
    const { seen } = await sweepWith({ outbox: [row], cards: [], filterStatus: false });
    // This generic fakeConn always resolves call_commitments to no row,
    // which contextFor itself already reads as 'promise_closed' — exactly
    // the office-verdict branch this test targets.
    const patch = seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'outbox' && u.patch.status === 'cancelled');
    expect(patch).toBeDefined();
    expect(patch.patch.payload.delivery_outcome_uncertain).toBe(false);
  });
});

test('one unprocessable row cannot starve the rest of the sweep', async () => {
  // matchingSend throws outright for a customer with more than 200 matching
  // link messages, and that row is by definition the oldest unchanged item —
  // an unguarded loop would abort every later promise and the used-link
  // reconciliation on every tick, forever.
  // selfServeVisitIds carries evidence for 'visit' so the reconcile step's
  // bulk pre-filter still admits both rows into the per-row loop below —
  // selfServe stays null so neither actually matches, keeping reconciled: 0.
  const { seen, result } = await sweepWith({ outbox: [promiseRow('boom', 'first'), promiseRow('ok', 'second')],
    throwOn: 'boom', selfServeVisitIds: ['visit'] });
  expect(result).toMatchObject({ processed: 2, failed: 1, reconciled: 0 });
  // The failing row parks for the office instead of retrying invisibly...
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'boom' },
    patch: expect.objectContaining({ status: 'review', last_error: 'worker_error' }) }));
  // ...the later row is still processed...
  expect(seen.updates.some((u) => u.table === 'outbox_messages' && u.eq.id === 'ok')).toBe(true);
  // ...and used-link reconciliation still runs for both rows.
  expect(seen.logFilters).toHaveLength(2);
});

test('a backlog of delivered rows cannot occupy the primary sweep — a pending row is still picked on the first tick', async () => {
  // Delivered (and any other terminal) rows stay in outbox_messages for
  // good, and runOne already returns immediately for them — but leaving them
  // in the primary LIMIT-100 SELECT and its last_scanned_at stamp lets a
  // backlog of them occupy every scan slot, so a retried pending row behind
  // them would wait a full rotation for a send it is due right now (codex
  // #4293 P2 r3). reconcileUsedLinks looks at delivered rows separately.
  const delivered = Array.from({ length: 150 }, (_, i) => promiseRow(`delivered-${i}`, `commitment-${i}`, { status: 'delivered' }));
  const { seen, result } = await sweepWith({ outbox: [...delivered, promiseRow('pending', 'pending-commitment')],
    selfServeVisitIds: [], filterStatus: true });
  expect(result.processed).toBe(1);
  const scanStamp = seen.updates.find((u) => u.table === 'outbox_messages' && u.patch && 'last_scanned_at' in u.patch);
  expect(scanStamp).toBeDefined();
  expect(scanStamp.whereIn.find((w) => w.col === 'id').values).toEqual(['pending']);
});

test('a review row parked for the same unchanging reason is still stamped scanned, so it cannot starve the send queue', async () => {
  // A review row whose context stays invalid on every pass has nothing about
  // it that ever changes on its own — parkReview's own guard skips the write
  // once status/last_error already match — so an oldest-updated-first LIMIT
  // 100 would keep re-selecting it forever once 100 such rows accumulated,
  // starving every newer row behind it (codex #4293 P1, the send-queue
  // sweep's own version of the reconcile-sweep starvation above). The OUTER
  // stamp below fires for every selected row up front, independent of
  // whatever its own (here unmodelled) downstream processing does.
  const stuck = { ...promiseRow('stuck', 'first'), status: 'review', last_error: 'discussed_visit_unavailable' };
  const { seen, result } = await sweepWith({ outbox: [stuck], selfServeVisitIds: [] });
  expect(result.processed).toBe(1);
  const stamp = seen.updates.find((u) => u.table === 'outbox_messages' && u.patch && 'last_scanned_at' in u.patch);
  expect(stamp).toBeDefined();
  expect(stamp.whereIn).toContainEqual({ col: 'id', values: ['stuck'] });
  expect(stamp.patch.last_scanned_at).toEqual(now);
  expect(seen.orderByCalls.find((c) => c.table === 'outbox_messages').arg)
    .toEqual([{ column: 'last_scanned_at', order: 'asc', nulls: 'first' }, { column: 'updated_at', order: 'asc' }]);
});

test('a reconciled row is never re-planned or re-parked by the send sweep, and its card stays closed', async () => {
  // markLinkUsed stamps link_used_reconciled_at and clears the row's
  // exception card, but deliberately leaves status alone (a missing carrier
  // receipt is still not proof of delivery). Without the runOne
  // short-circuit, the NEXT sweep would re-enter contextFor, find the (now
  // self-served) visit's date no longer matches the original promise, and
  // re-park it — recreating the very card just closed, and permanently:
  // unreconciledPromiseRows never revisits a row once this stamp is set, so
  // nothing would ever close it again (codex #4293 P1 r4).
  const reconciled = promiseRow('reconciled', 'first', { status: 'review',
    payload: { link_used_reconciled_at: '2030-01-08T00:00:00.000Z' } });
  const { seen, result } = await sweepWith({ outbox: [reconciled], selfServeVisitIds: [] });
  expect(result.processed).toBe(1);
  // The row was still scanned (fairness bookkeeping still applies to it)...
  const stamp2 = seen.updates.find((u) => u.table === 'outbox_messages' && u.patch && 'last_scanned_at' in u.patch);
  expect(stamp2.whereIn).toContainEqual({ col: 'id', values: ['reconciled'] });
  // ...but nothing else touched it: no status change (no re-plan, no
  // re-park, no cancel), no re-opened or new triage card, no call_log write.
  const otherUpdates = seen.updates.filter((u) => !(u.table === 'outbox_messages' && u.patch && 'last_scanned_at' in u.patch));
  expect(otherUpdates).toEqual([]);
  expect(seen.inserts).toEqual([]);
});

test('a reconciled row with a pending receipt still settles it, without re-parking or touching its card', async () => {
  // reconcileAttempt's own branches (delivery_failed / delivery_receipt_unavailable
  // / settleDelivery's scope-changed escape hatch) all call parkReview, which
  // would recreate the very card markLinkUsed just closed just as surely as
  // the contextFor path does — the receipt-path sibling of the r4 bug (codex
  // #4293 P1 r5). The row was awaiting a carrier receipt when the customer
  // self-served; this sweep is the one where that receipt finally arrives.
  const reconciled = promiseRow('reconciled', 'first', { status: 'review', provider_message_id: 'sid1',
    payload: { link_used_reconciled_at: '2030-01-08T00:00:00.000Z' } });
  const { seen, result } = await sweepWith({ outbox: [reconciled], selfServeVisitIds: [], smsLog: { status: 'delivered' } });
  expect(result.processed).toBe(1);
  // The late carrier confirmation still lands as accurate bookkeeping...
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'reconciled' },
    patch: expect.objectContaining({ status: 'delivered' }) }));
  // ...and, being a genuine delivery, fulfils the commitment exactly as the
  // normal settleDelivery path does (fulfilPromise, reused not copied) —
  // but nothing about it REOPENS office work: no triage insert, no
  // triage_items update. This promise was never parked (no card was ever
  // raised for it), so clearPromiseException's card-clear query matches
  // nothing — and, per the fix below, that means it must NOT touch
  // call_log.review_status at all: forcing it to 'resolved' regardless
  // would clobber an intentional null or a 'dismissed' the office set for
  // reasons of its own (codex #4293 P2).
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_commitments',
    patch: expect.objectContaining({ status: 'fulfilled' }) }));
  expect(seen.inserts).toEqual([]);
  expect(seen.updates.some((u) => u.table === 'triage_items')).toBe(false);
  expect(seen.updates.some((u) => u.table === 'call_log')).toBe(false);
});

test('a failed receipt on a reconciled row stays bookkeeping — the commitment is not fulfilled', async () => {
  const reconciled = promiseRow('reconciled', 'first', { status: 'review', provider_message_id: 'sid1',
    payload: { link_used_reconciled_at: '2030-01-08T00:00:00.000Z' } });
  const { seen, result } = await sweepWith({ outbox: [reconciled], selfServeVisitIds: [], smsLog: { status: 'failed' } });
  expect(result.processed).toBe(1);
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'reconciled' },
    patch: expect.objectContaining({ status: 'failed', last_error: 'failed' }) }));
  // No fulfilment, no exception-card activity of any kind — a failed carrier
  // outcome is bookkeeping only, exactly as it was before this fix.
  expect(seen.updates.some((u) => u.table === 'call_commitments')).toBe(false);
  expect(seen.updates.some((u) => u.table === 'triage_items' || u.table === 'call_log')).toBe(false);
  expect(seen.inserts).toEqual([]);
});

test('a promise recorded before an explicit activation boundary is cancelled without a card; one recorded after is staged normally', async () => {
  const prior = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
  try {
    process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = '2030-01-05T00:00:00.000Z';
    // The extractor has been building send_reschedule_link commitments the
    // whole time GATE_CALL_COMMITMENTS was on, independent of this delivery
    // gate — the first live sweep must not text a backlog of days-old
    // promises just because they are still open (codex #4293 P1 r8).
    const stale = promiseRow('stale', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2030-01-01T00:00:00.000Z' } });
    const { seen, result } = await sweepWith({ outbox: [stale], selfServeVisitIds: [] }, 'true');
    expect(result.processed).toBe(1);
    expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'stale' },
      patch: expect.objectContaining({ status: 'cancelled', last_error: 'pre_activation' }) }));
    // Terminal and quiet: no card raised or reopened for a historical
    // observation nobody asked this feature to act on.
    expect(seen.inserts).toEqual([]);
    expect(seen.updates.some((u) => u.table === 'triage_items' || u.table === 'call_log')).toBe(false);

    // A commitment recorded AFTER the boundary is staged as usual — it
    // reaches contextFor, which this shallow mock resolves to
    // 'promise_closed' (no call_commitments row exists in it) rather than
    // 'pre_activation', proving the boundary check let it through.
    const fresh = promiseRow('fresh', 'second', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2030-01-06T00:00:00.000Z' } });
    const after = await sweepWith({ outbox: [fresh], selfServeVisitIds: [] }, 'true');
    const freshUpdate = after.seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'fresh');
    expect(freshUpdate.patch.status).toBe('cancelled');
    expect(freshUpdate.patch.last_error).not.toBe('pre_activation');
  } finally {
    if (prior === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = prior;
  }
});

test('with no env set, nothing persisted yet writes now() under the stored key and uses it immediately', async () => {
  const prior = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
  try {
    delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    // A bare gate flip with nothing stored yet must never promote real
    // history — a commitment recorded long before this test's own
    // (real-clock) run time has to read as pre-activation against whatever
    // instant gets written, not against this process's own start time.
    const systemSettings = {};
    const ancient = promiseRow('ancient', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2000-01-01T00:00:00.000Z' } });
    const { seen } = await sweepWith({ outbox: [ancient], selfServeVisitIds: [], systemSettings }, 'true');
    expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'ancient' },
      patch: expect.objectContaining({ status: 'cancelled', last_error: 'pre_activation' }) }));
    // The instant is durable — written where every future process (this one
    // after a restart, or any other) will find it, not kept in memory.
    expect(seen.inserts).toContainEqual(expect.objectContaining({ table: 'system_settings',
      data: expect.objectContaining({ key: 'reschedule_link_promise_activated_at' }) }));
    expect(systemSettings.reschedule_link_promise_activated_at).toBeDefined();
  } finally {
    if (prior === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = prior;
  }
});

test('a restart (a fresh sweep against the same stored row) reuses the SAME boundary, not a new one', async () => {
  // The stored instant, not this process's own uptime, is authoritative —
  // an earlier round's process-start fallback moved the boundary forward on
  // every restart, silently cancelling a commitment created after the last
  // sweep but before a routine deploy (codex #4293 P1 r9). Simulating a
  // restart is exactly this: a sweep that finds the row ALREADY there.
  const systemSettings = { reschedule_link_promise_activated_at: '2030-01-05T00:00:00.000Z' };
  const stale = promiseRow('stale', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2030-01-01T00:00:00.000Z' } });
  const fresh = promiseRow('fresh', 'second', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2030-01-06T00:00:00.000Z' } });
  const { seen } = await sweepWith({ outbox: [stale, fresh], selfServeVisitIds: [], systemSettings }, 'true');
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'stale' },
    patch: expect.objectContaining({ status: 'cancelled', last_error: 'pre_activation' }) }));
  const freshUpdate = seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'fresh');
  expect(freshUpdate.patch.last_error).not.toBe('pre_activation');
  // The row already existed — nothing about it was rewritten.
  expect(seen.inserts.some((i) => i.table === 'system_settings')).toBe(false);
  expect(systemSettings.reschedule_link_promise_activated_at).toBe('2030-01-05T00:00:00.000Z');
});

test('an explicit activation env overrides the persisted stored value', async () => {
  const prior = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
  try {
    process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = '2030-01-10T00:00:00.000Z'; // later than stored
    const systemSettings = { reschedule_link_promise_activated_at: '2030-01-01T00:00:00.000Z' }; // earlier
    // Between the two boundaries: post-activation under the stored value,
    // pre-activation under the env — proving which one actually won.
    const between = promiseRow('between', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2030-01-05T00:00:00.000Z' } });
    const { seen } = await sweepWith({ outbox: [between], selfServeVisitIds: [], systemSettings }, 'true');
    expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'between' },
      patch: expect.objectContaining({ status: 'cancelled', last_error: 'pre_activation' }) }));
    // The env path never even touches the stored row.
    expect(seen.inserts.some((i) => i.table === 'system_settings')).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = prior;
  }
});

test('a shadow sweep never touches the persisted boundary or cancels anything as pre_activation; the first live sweep does both', async () => {
  // Shadow walks every open commitment through runOne exactly like a live
  // sweep, so without this the FIRST shadow run anywhere — routinely used
  // for a long trial period before anyone actually goes live — would fix
  // the activation instant at whatever moment shadow testing happened to
  // start, weeks before go-live: shadow only observes, it must never
  // establish or enforce the boundary (codex #4293 P1, round 2 on baa4cf295).
  const systemSettings = {};
  const stale = promiseRow('stale', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: '2000-01-01T00:00:00.000Z' } });

  const shadow = await sweepWith({ outbox: [stale], selfServeVisitIds: [], systemSettings }, 'shadow');
  expect(shadow.seen.inserts.some((i) => i.table === 'system_settings')).toBe(false);
  expect(systemSettings.reschedule_link_promise_activated_at).toBeUndefined();
  expect(shadow.seen.updates.some((u) => u.table === 'outbox_messages' && u.patch.last_error === 'pre_activation')).toBe(false);

  // The SAME row, the SAME (still-empty) settings store — only the mode
  // changes. The first LIVE sweep is the one that both establishes the
  // boundary and cancels the pre-existing row against it.
  const live = await sweepWith({ outbox: [stale], selfServeVisitIds: [], systemSettings }, 'true');
  expect(live.seen.inserts).toContainEqual(expect.objectContaining({ table: 'system_settings',
    data: expect.objectContaining({ key: 'reschedule_link_promise_activated_at' }) }));
  expect(systemSettings.reschedule_link_promise_activated_at).toBeDefined();
  expect(live.seen.updates).toContainEqual(expect.objectContaining({ table: 'outbox_messages', eq: { id: 'stale' },
    patch: expect.objectContaining({ status: 'cancelled', last_error: 'pre_activation' }) }));
});

test('an empty first live sweep still fixes the activation boundary; a promise made after it is staged normally next tick', async () => {
  // stagePromises' own query can come back empty on the very first live
  // tick (nothing has been extracted since the gate went on yet) — if the
  // boundary were only established as a side effect of judging a row, an
  // empty queue would defer the write to whatever LATER sweep finally sees
  // one, and every commitment made in between reads as pre_activation
  // against a boundary that arrived too late (codex #4293 P1, folded into
  // round 2 on baa4cf295).
  const systemSettings = {};
  const empty = await sweepWith({ outbox: [], selfServeVisitIds: [], systemSettings }, 'true');
  expect(empty.result.processed).toBe(0);
  expect(empty.seen.inserts).toContainEqual(expect.objectContaining({ table: 'system_settings',
    data: expect.objectContaining({ key: 'reschedule_link_promise_activated_at' }) }));
  expect(systemSettings.reschedule_link_promise_activated_at).toBeDefined();

  // A promise created any time after the now-persisted boundary must NOT
  // read as pre-activation on the very next sweep.
  const boundary = new Date(systemSettings.reschedule_link_promise_activated_at);
  const after = new Date(boundary.getTime() + 60000).toISOString();
  const fresh = promiseRow('fresh', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: after } });
  const next = await sweepWith({ outbox: [fresh], selfServeVisitIds: [], systemSettings }, 'true');
  const freshUpdate = next.seen.updates.find((u) => u.table === 'outbox_messages' && u.eq.id === 'fresh');
  expect(freshUpdate.patch.last_error).not.toBe('pre_activation');
});

test('a call extracted live before any sweep fixes the boundary immediately, so the very next sweep never parks it as pre_activation', async () => {
  // With the gate live and no env set, a call processed between the gate
  // flip and the NEXT five-minute sweep tick creates a legitimate live
  // commitment before anything has persisted the boundary. Establishing the
  // instant only as a side effect of a sweep running defers it to whatever
  // sweep happens to run next, and that sweep then reads every commitment
  // made in between as pre_activation and cancels it silently (codex #4293
  // P1 r3). recordLiveActivation is call-commitments.recordCallCommitments'
  // own call, made inline in the live-extraction path the moment a live pass
  // can begin — well before either the commitment or its outbox row exist —
  // so the boundary is already on record by the time the first sweep ever
  // looks at it.
  const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
  const priorEnv = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
  const priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
    delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    const systemSettings = {};
    const { conn } = fakeConn({ systemSettings });
    await links.recordLiveActivation(conn);
    const boundary = systemSettings.reschedule_link_promise_activated_at;
    expect(boundary).toBeDefined();

    // A commitment "created" at that same fixed instant — the closest a live
    // extraction and the boundary it just wrote can ever be — must still
    // read as on-or-after the boundary, not before it.
    const justInTime = promiseRow('just-in-time', 'first', { payload: { kind: 'send_reschedule_link', commitment_created_at: boundary } });
    const { conn: sweepConn, seen } = fakeConn({ outbox: [justInTime], selfServeVisitIds: [], systemSettings });
    const result = await links.sweep(sweepConn, { now: new Date(boundary) });
    expect(result.processed).toBe(1);
    expect(seen.updates.some((u) => u.table === 'outbox_messages' && u.eq.id === 'just-in-time'
      && u.patch.last_error === 'pre_activation')).toBe(false);
    // The boundary already existed — the sweep's own fallback write (still
    // in place as the safety net) never had to fire.
    expect(seen.inserts.some((i) => i.table === 'system_settings')).toBe(false);
  } finally {
    if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
    if (priorEnv === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorEnv;
    gates.callCommitments = priorCommitments;
  }
});

test('recordLiveActivation is a no-op outside live mode — shadow and off never touch the persisted boundary', async () => {
  const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
  const priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    for (const mode of ['shadow', '']) {
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = mode;
      const systemSettings = {};
      const { conn, seen } = fakeConn({ systemSettings });
      await links.recordLiveActivation(conn);
      expect(seen.inserts).toEqual([]);
      expect(systemSettings.reschedule_link_promise_activated_at).toBeUndefined();
    }
  } finally {
    if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
    gates.callCommitments = priorCommitments;
  }
});

test('one call-level card speaks for every promise parked against the call', async () => {
  const card = { id: 'card', payload: { reschedule_link_promise: { commitment_id: 'first', commitment_ids: ['first'], reason: 'delivery_failed' } } };
  const { seen } = await sweepWith({ outbox: [promiseRow('boom', 'second')], throwOn: 'boom', cards: [card] });
  // A second parked promise joins the existing card rather than vanishing
  // behind the first one's id.
  const merged = seen.updates.find((u) => u.table === 'triage_items');
  expect(merged.patch.payload.reschedule_link_promise.commitment_ids).toEqual(['first', 'second']);
  expect(merged.patch.status).toBeUndefined();
  expect(seen.inserts.filter((i) => i.table === 'triage_items')).toHaveLength(0);
});

test('settling one promise leaves the card open for the promise still parked', async () => {
  const card = { id: 'card', payload: { reschedule_link_promise: { commitment_id: 'first', commitment_ids: ['first', 'second'] } } };
  const parked = { id: 'outbox', status: 'review', commitment_id: 'first', related_call_log_id: 'call',
    related_scheduled_service_id: 'visit', sent_at: new Date('2030-01-07T12:00:00Z') };
  const { conn, seen } = fakeConn({ outbox: [parked], selfServe: { id: 'log' }, cards: [card] });
  expect(await links.reconcileUsedLinks(conn)).toBe(1);
  const patched = seen.updates.find((u) => u.table === 'triage_items');
  expect(patched.patch.payload.reschedule_link_promise.commitment_ids).toEqual(['second']);
  expect(patched.patch.status).toBeUndefined();
  // The call stays in review while the second promise is still parked.
  expect(seen.updates).toContainEqual(expect.objectContaining({ table: 'call_log', patch: expect.objectContaining({ review_status: 'open' }) }));
});

test('a busy send interlock is a retryable block, and the gate off is a pass-through', async () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  const priorClient = db.client;
  const core = jest.fn(async () => ({ sent: true }));
  const input = { customerId: 'customer', body: 'x', metadata: { followThroughCommitmentId: 'commitment' } };
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
    const connection = { query: jest.fn(async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); }) };
    db.client = { acquireRawConnection: jest.fn(async () => connection), destroyRawConnection: jest.fn(async () => {}) };
    // No provider attempt was made, so this is a retry — never an unknown
    // provider outcome for the office.
    expect(await links.withSendLock(input, core)).toMatchObject({ sent: false, blocked: true, retryable: true, code: 'LINK_LOCK_BUSY' });
    expect(core).not.toHaveBeenCalled();
    expect(db.client.destroyRawConnection).toHaveBeenCalledWith(connection);

    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow';
    expect(await links.withSendLock(input, core)).toEqual({ sent: true });
    expect(core).toHaveBeenCalledWith(input);
    expect(db.client.acquireRawConnection).toHaveBeenCalledTimes(1);
  } finally {
    if (priorClient === undefined) delete db.client; else db.client = priorClient;
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});

// Run one send with the gate live and the module-level db answering from a
// fake, restoring both afterwards.
async function withLiveGate({ outbox = [], commitments = [], calls = [], client }, fn) {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  const priorClient = db.client;
  try {
    gates.callCommitments = true;
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
    db.client = client;
    db.mockImplementation(fakeConn({ outbox, commitments, calls }).conn);
    return await fn();
  } finally {
    db.mockReset();
    if (priorClient === undefined) delete db.client; else db.client = priorClient;
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
}

const fakeInterlock = () => {
  const handlers = {};
  const connection = { query: jest.fn(async () => ({})), on: jest.fn((event, fn) => { handlers[event] = fn; }) };
  const client = { acquireRawConnection: jest.fn(async () => connection), destroyRawConnection: jest.fn(async () => {}) };
  return { handlers, connection, client };
};

test('an operator text only pays for the interlock when a promised link is live', async () => {
  const core = jest.fn(async () => ({ sent: true }));
  const admin = { customerId: 'customer', body: 'On our way.', metadata: { adminUserId: 'admin' } };

  // With the gate on, EVERY staff text reaches withSendLock. A customer with
  // no live promise must never pay for an unpooled connection or an advisory
  // lock — one cheap pooled lookup decides.
  const quiet = fakeInterlock();
  expect(await withLiveGate({ outbox: [], client: quiet.client }, () => links.withSendLock(admin, core))).toEqual({ sent: true });
  expect(quiet.client.acquireRawConnection).not.toHaveBeenCalled();
  expect(core).toHaveBeenCalledWith(admin);

  // A promise still waiting for the sweep does serialize.
  const live = fakeInterlock();
  expect(await withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client: live.client },
    () => links.withSendLock(admin, core))).toEqual({ sent: true });
  expect(live.client.acquireRawConnection).toHaveBeenCalledTimes(1);
  expect(live.connection.query).toHaveBeenCalledWith(expect.stringContaining('statement_timeout'));
  expect(live.client.destroyRawConnection).toHaveBeenCalledWith(live.connection);
});

test('an operator text serializes against a promise not yet staged — an open call_commitments row with NO outbox row at all (codex #4293 P1)', async () => {
  // stagePromises runs on its own sweep cadence: a manual send landing in
  // the gap between the office's promise being recorded and the next
  // staging pass would previously find no outbox row (LIVE_PROMISE_STATUSES
  // check alone) and skip the interlock entirely, racing the worker's own
  // uncontended lock once it stages and dispatches minutes later — the same
  // link could go out twice. needsSendInterlock must also check the
  // commitment directly, not only its derived outbox row.
  const core = jest.fn(async () => ({ sent: true }));
  const admin = { customerId: 'customer', body: 'On our way.', metadata: { adminUserId: 'admin' } };
  const calls = [{ id: 'call', customer_id: 'customer' }];
  const commitments = [{ id: 'commitment', kind: 'send_reschedule_link', party: 'waves', status: 'open', human_state: null, call_log_id: 'call' }];

  const live = fakeInterlock();
  expect(await withLiveGate({ outbox: [], commitments, calls, client: live.client }, () => links.withSendLock(admin, core)))
    .toEqual({ sent: true });
  expect(live.client.acquireRawConnection).toHaveBeenCalledTimes(1);
  expect(live.connection.query).toHaveBeenCalledWith(expect.stringContaining('statement_timeout'));
  expect(core).toHaveBeenCalled();

  // A commitment some OTHER customer's call holds must never engage this
  // customer's interlock.
  const quiet = fakeInterlock();
  expect(await withLiveGate({ outbox: [], commitments, calls: [{ id: 'other-call', customer_id: 'someone-else' }], client: quiet.client },
    () => links.withSendLock(admin, core))).toEqual({ sent: true });
  expect(quiet.client.acquireRawConnection).not.toHaveBeenCalled();
});

test('an interlock that dies mid-send blocks at the provider boundary', async () => {
  const { handlers, client } = fakeInterlock();
  const input = { customerId: 'customer', body: 'x', metadata: { adminUserId: 'admin' }, preProviderCheck: async () => ({ ok: true }) };
  let healthy, afterLoss;
  await withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client }, () => links.withSendLock(input, async (locked) => {
    healthy = await locked.preProviderCheck({});
    // The unpooled connection dies while the provider call is being prepared.
    handlers.error(new Error('connection terminated unexpectedly'));
    afterLoss = await locked.preProviderCheck({});
    return { sent: true };
  }));
  expect(healthy).toEqual({ ok: true });
  // Reading knex's private __knex__disposed returned undefined here on any
  // other pool build, and the send went to the provider anyway.
  expect(afterLoss).toMatchObject({ ok: false, code: 'LINK_LOCK_LOST' });
});

test('a timed-out interlock attempt keeps its slot until the connection actually settles', async () => {
  // Releasing the connection cap's count on the TIMER firing (rather than
  // the underlying connect actually resolving or rejecting) let a burst of
  // slow connects each free their slot while the real sockets stayed open
  // underneath, so the cap no longer bounded the true number of concurrent
  // raw connections (codex #4293 P1 r8). Every acquireRawConnection() here
  // hangs forever, so nothing ever settles on its own — proving the cap
  // stays occupied is the only way to prove the slot was never freed early.
  const core = jest.fn(async () => ({ sent: true }));
  const admin = { customerId: 'customer', body: 'On our way.', metadata: { adminUserId: 'admin' } };
  const client = { acquireRawConnection: jest.fn(() => new Promise(() => {})), destroyRawConnection: jest.fn(async () => {}) };
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    await withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client }, async () => {
      // Fill every one of the 4 slots with a connect that will never settle.
      // Poll (rather than a fixed number of microtask ticks) until each
      // attempt has actually reached acquireRawConnection before starting
      // the next — the exact tick count through needsSendInterlock's own DB
      // round trip is an implementation detail this test must not depend on.
      const filling = [];
      for (let i = 0; i < 4; i += 1) {
        filling.push(links.withSendLock(admin, core));
        while (client.acquireRawConnection.mock.calls.length <= i) await Promise.resolve(); // deliberately serialized
      }
      // A 5th attempt hits the cap immediately — no new connect is even tried.
      logger.warn.mockClear();
      expect(await links.withSendLock(admin, core)).toEqual({ sent: true });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('at its connection cap'));
      expect(client.acquireRawConnection).toHaveBeenCalledTimes(4);

      // Let all four give up waiting — each one's SEND still proceeds...
      await jest.advanceTimersByTimeAsync(6000);
      await Promise.all(filling);

      // ...but none of the underlying connects ever actually resolved, so a
      // NEW attempt right after must STILL see the cap occupied. Freeing the
      // slot on the timer alone would instead let this one through to try
      // acquireRawConnection a 5th time.
      logger.warn.mockClear();
      expect(await links.withSendLock(admin, core)).toEqual({ sent: true });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('at its connection cap'));
      expect(client.acquireRawConnection).toHaveBeenCalledTimes(4);
    });
  } finally {
    jest.useRealTimers();
  }
});

test('an interlock connection that never arrives does not block an admin send', async () => {
  const core = jest.fn(async () => ({ sent: true }));
  const client = { acquireRawConnection: jest.fn(() => new Promise(() => {})), destroyRawConnection: jest.fn(async () => {}) };
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const admin = { customerId: 'customer', body: 'On our way.', metadata: { adminUserId: 'admin' } };
    const sending = withLiveGate({ outbox: [promiseRow('outbox', 'commitment')], client }, () => links.withSendLock(admin, core));
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(6000);
    expect(await sending).toEqual({ sent: true });
    expect(core).toHaveBeenCalledWith(admin);
  } finally {
    jest.useRealTimers();
  }
});

test('the commitment gate and explicit shadow/true modes are required', () => {
  const prior = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
  try {
    gates.callCommitments = true;
    for (const value of ['', 'false', 'on']) { process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = value; expect(links.mode()).toBe('off'); }
    process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'shadow'; expect(links.mode()).toBe('shadow');
    gates.callCommitments = false; expect(links.mode()).toBe('off');
  } finally {
    if (prior === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = prior;
    gates.callCommitments = priorCommitments;
  }
});

// codex #4293 P1: this used to try to tell a REQUESTED time ("tomorrow
// morning") apart from a DEADLINE ("by Friday") by reading the shape back
// out of the agent's free-text evidence quote, because the extractor never
// persists which one the model meant. That inference went through three
// rounds and was wrong a third distinct way each time — round 2's stray
// "before Friday" qualifying the appointment, not the send, then round 3's
// SECOND clause with its own send tense that was about a phone CALL, not
// the link ("I'll text the reschedule link tomorrow morning, and I'll call
// you before Friday" — the second clause's "I'll" and "before Friday" are
// about the call, but the old clause-scoped check still read it as the
// link's own deadline and allowed an immediate send). A fourth regex patch
// buys a fourth failure of the same shape, so the distinction is removed
// instead: every stated due_at is now a FLOOR, full stop — never send
// before the promised instant. Recovering true deadline semantics needs a
// persisted due_type set by the model at extraction time (see the doc
// comment on isPromisedFloor); until then this is a deliberate, safe-side
// simplification, not a bug.
describe('every stated due_at is a floor — the deadline/floor distinction is gone, not re-patched (codex #4293 P1)', () => {
  const dueAt = new Date('2030-01-08T14:00:00Z');
  const commitmentWith = (quote) => ({ due_at: dueAt.toISOString(), evidence: [{ quote, speaker: 'agent' }] });

  test.each([
    "I'll text you the link tomorrow morning.",
    "I'll send that over this evening.",
    "I'll get you that link on Monday.",
    "I'll get that to you by Friday.",
    "I'll send it before the weekend.",
    "I'll have that over within a couple of days.",
  ])('any stated delivery time (%s) is a floor — requested time and deadline wording are no longer distinguished', (quote) => {
    expect(links.isPromisedFloor(commitmentWith(quote))).toBe(true);
  });

  // The exact third-round failure: a second clause carries its own
  // first-person send tense, but about a PHONE CALL rather than the link.
  // The old clause-scoped deadline check still credited "before Friday" as
  // the link's own deadline and waved the floor off — with the distinction
  // gone entirely there is nothing left for that clause to mis-qualify.
  test("a second clause about an unrelated commitment (a phone call) does not stop the link's due_at from being a floor", () => {
    const commitment = commitmentWith("I'll text the reschedule link tomorrow morning, and I'll call you before Friday.");
    expect(links.isPromisedFloor(commitment)).toBe(true);
    expect(links.promisedFloorAt(commitment, new Date('2030-01-07T14:00:00Z'))).toEqual(dueAt);
  });

  test('no stated due_at is never a floor, regardless of wording', () => {
    expect(links.isPromisedFloor({ due_at: null, evidence: [{ quote: 'tomorrow morning', speaker: 'agent' }] })).toBe(false);
  });

  test('a due_at with no evidence at all is still a floor', () => {
    expect(links.isPromisedFloor({ due_at: dueAt.toISOString(), evidence: [] })).toBe(true);
  });

  test('promisedFloorAt is null once the floor has already passed, and equals due_at while it is still ahead', () => {
    const commitment = commitmentWith("I'll text you the link tomorrow morning.");
    expect(links.promisedFloorAt(commitment, new Date('2030-01-07T14:00:00Z'))).toEqual(dueAt);
    expect(links.promisedFloorAt(commitment, new Date('2030-01-09T00:00:00Z'))).toBeNull();
  });

  // A promise phrased as a deadline now waits until due_at too — the small,
  // deliberate cost of removing the heuristic: sending later than strictly
  // necessary is always safe, sending earlier than promised never is.
  test('a promise phrased as a deadline ("by Friday") is now held to due_at exactly like a requested time', () => {
    const commitment = commitmentWith("I'll get that to you by Friday.");
    expect(links.promisedFloorAt(commitment, new Date('2030-01-07T14:00:00Z'))).toEqual(dueAt);
  });
});
