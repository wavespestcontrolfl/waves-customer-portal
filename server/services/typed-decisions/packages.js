/**
 * Typed-decision packages: immutable, versioned question sets for TypeSafe Jev
 * (services/llm/call.js#callTypeSafe via ROUTES.typedDecision).
 *
 * A package is `{ id, capability, version, description, questions, stateShape,
 * thresholds }` with id === `<capability>.v<version>`. Once a package is
 * published its questions, stateShape and thresholds NEVER change: the wording
 * IS the decision, and every stored decision_reviews row names the package id
 * and hash it was answered under. To change a question, add a new version
 * (`call_judge.v2`) and leave v1 as it is.
 * tests/typed-decisions-packages.test.js pins each id to a hash in
 * fixtures/typed-decisions/package-hashes.json, so an in-place edit fails CI.
 *
 * Question ids are the keys of `questions` (Jev answers by id). A `noul`
 * question answers a 0..1 probability that the statement is true.
 */
const crypto = require('crypto');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const THRESHOLDS = { confident_low: 0.15, confident_high: 0.85 };

const noul = (instructions, criteria) => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions });

const CALL_JUDGE = {
  id: 'call_judge.v2',
  capability: 'call_judge',
  version: 2,
  description: 'Six yes/no judgements over one phone call: lead, spam, voicemail, agreed appointment, promised quote, complaint.',
  stateShape: ['call_direction', 'duration_seconds', 'transcript'],
  thresholds: { ...THRESHOLDS },
  questions: {
    // v2 (Codex #5476): the production extraction counts an existing customer
    // asking about a NEW, different service as a lead; only coordinating an
    // existing service, billing, complaints and re-service are excluded.
    is_lead: noul('Is this call a sales lead: a new prospective customer, or an existing customer asking about a new or different service they do not already have?', {
      true: 'A prospect, or an existing customer inquiring about an additional service (a cross-sell).',
      false: 'An existing customer coordinating a visit they already have, billing, a complaint or a re-service; or a vendor, spam, robocall or wrong number.',
    }),
    is_spam: noul('Is this call spam, a robocall, or a vendor solicitation?', {
      true: 'Robocall, solicitation, or junk.',
      false: 'A real customer, prospect, or legitimate business contact. A caller with a service request, address, or quoted price is never spam.',
    }),
    is_voicemail: noul('Is this a voicemail message rather than a two-way conversation?', {
      true: 'One party leaves a message; no back-and-forth.',
      false: 'Both parties speak in turns (3+ turns each).',
    }),
    appointment_agreed: noul('Did both parties agree on a specific appointment (a date or day and a time or window)?'),
    quote_promised: noul('Did Waves staff promise to send or follow up with a quote/estimate/price later?'),
    complaint: noul('Does the caller express a complaint or dissatisfaction with Waves service?'),
  },
};

const SMS_COURTESY = {
  id: 'sms_courtesy.v1',
  capability: 'sms_courtesy',
  version: 1,
  description: 'Is a customer text only a courtesy closer (thanks, ok) that needs no reply?',
  stateShape: ['previous_waves_text', 'customer_text'],
  thresholds: { ...THRESHOLDS },
  questions: {
    is_courtesy_only: noul('Is the customer text ONLY a courtesy closer (thanks, ok, sounds good, \u{1F44D}) with no question and no new information?', {
      true: 'It is purely an acknowledgement or thanks.',
      false: 'It asks something, states something new, or needs a reply.',
    }),
  },
};

const SMS_RESCHEDULE = {
  id: 'sms_reschedule.v1',
  capability: 'sms_reschedule',
  version: 1,
  description: 'Is a customer text asking to move, skip or cancel an upcoming visit (or saying they will be away)?',
  stateShape: ['previous_waves_text', 'customer_text'],
  thresholds: { ...THRESHOLDS },
  questions: {
    wants_visit_change: noul('Is the customer asking to move, skip or cancel an upcoming service visit, or telling us they will be away or the property will be inaccessible?', {
      true: 'They ask to reschedule, cancel or skip a visit, or say they will be away / gone / out of town for it.',
      false: 'They are not asking to change any visit (including: confirming a visit, asking when it is, or past-tense remarks).',
    }),
  },
};

// Evidence for three dark call gates (Clef second wave, idea 8, owner order
// 2026-10-02): each question is the yes/no a gate acts on, recorded beside
// that gate's OWN decision (call-self-audit.js gateCheckBaselines), so its
// flip pack can show how often the rule and the models agree on real calls.
// The gates' actions never change. Yes/no only: the Clef replay showed
// multi-way choices are weak, so service clarity is one noul, not a choice.
const CALL_GATE_CHECKS = {
  id: 'call_gate_checks.v1',
  capability: 'call_gate_checks',
  version: 1,
  description: 'Three yes/no checks behind dark call gates: unclear service (Assessment), a committed reschedule, an open Waves promise.',
  stateShape: ['call_direction', 'duration_seconds', 'transcript'],
  thresholds: { ...THRESHOLDS },
  questions: {
    // GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT: the extraction's ambiguous_pest_or_service flag.
    service_unclear: noul('Did the caller want service but leave it unclear WHICH service they need (pest, termite, lawn, mosquito, rodent, wildlife or other), so a technician would have to look before it could be named or priced?', {
      true: 'They describe a problem or ask for help but the service cannot be named from the call (e.g. "something is eating my plants", "bugs, not sure what kind").',
      false: 'The service is clear from the call, or no service was requested (billing, scheduling an existing visit, spam, voicemail with no request).',
    }),
    // GATE_CALL_RESCHEDULE_APPLY: the extraction's committed reschedule the caller accepted (reschedule_requested + agent_committed_booking + caller_accepted_slot + confirmed_start_at).
    reschedule_committed: noul('Did Waves staff and the caller agree to move an existing, already booked visit to a specific new day and time?', {
      true: 'An existing visit is moved and both sides settle on the new day and time on the call: staff commit to it and the caller accepts it.',
      false: 'No existing visit is moved, the new time is only proposed or left open, it is a cancellation, or it is a first booking.',
    }),
    // GATE_PROMISE_CHASER_BELL: the extracted Waves commitments of the kinds the chaser acts on (followup-sla-watcher SLA_KINDS), party waves, not stale.
    promise_open: noul('Did Waves staff promise the caller, for AFTER this call, to call back, to send a quote or estimate, or to set a time to come out?', {
      true: 'Staff commit to one of those three follow-ups and the call itself does not complete it.',
      false: 'None of those three is promised for after the call (other promises, such as sending a report, paperwork or a confirmation, do not count), or it was done during the call.',
    }),
  },
};

// Evidence for GATE_SMS_SPAM_CLASSIFIER (Clef second wave, idea 8): a text
// from an UNKNOWN sender (the same messages its screen sees) recorded beside
// the screen's regex marker (`rules`) and, when the classifier ran, its own
// model verdict (`production`). Wording follows sms-solicitation-classifier's
// prompt so the model and the gate judge the same thing. Same state shape as
// the other SMS packages (an unknown sender's previous Waves text is usually
// none), so the review route and the labeling tools need nothing new.
const SMS_SOLICITATION = {
  id: 'sms_solicitation.v1',
  capability: 'sms_solicitation',
  version: 1,
  description: 'Is a text from an unknown sender a business pitching something to Waves (a solicitation)?',
  stateShape: ['previous_waves_text', 'customer_text'],
  thresholds: { ...THRESHOLDS },
  questions: {
    is_solicitation: noul('Is the sender a business pitching something TO Waves (lead generation, marketing or ads, review tools, software, an AI receptionist, staffing, financing, insurance, or a contractor offering services or a partnership)?', {
      true: 'A pitch, offer or sales outreach aimed at Waves as a business.',
      false: 'Someone asking Waves for service, a quote, pricing or an appointment (even a business or property manager), a question about a job or bill, a wrong number, or a personal message.',
    }),
  },
};

const PACKAGES = deepFreeze({
  [CALL_JUDGE.id]: CALL_JUDGE,
  [CALL_GATE_CHECKS.id]: CALL_GATE_CHECKS,
  [SMS_COURTESY.id]: SMS_COURTESY,
  [SMS_RESCHEDULE.id]: SMS_RESCHEDULE,
  [SMS_SOLICITATION.id]: SMS_SOLICITATION,
});

function packageFor(id) {
  return Object.prototype.hasOwnProperty.call(PACKAGES, id) ? PACKAGES[id] : null;
}

// Canonical JSON: object keys sorted at every depth, arrays in order.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// sha256 over the parts that define the decision: questions + stateShape +
// thresholds. The description is prose and may be edited without a new version.
function packageHash(pkg) {
  const body = canonical({ questions: pkg.questions, stateShape: pkg.stateShape, thresholds: pkg.thresholds });
  return crypto.createHash('sha256').update(body).digest('hex');
}

// The closed set of machine outcome-evidence sources, each with its one window.
// Outcome evidence is written only by code (services/typed-decisions/
// outcome-evidence.js); the fixture exporter keeps a source only when it is a
// key here and its window matches, so no stored string can reach a fixture.
const OUTCOME_SOURCES = deepFreeze({
  scheduled_services: '24h',
  estimates: '48h',
  leads_customers: '7d',
  job_status_history: '7d',
  sms_log: '24h',
});

// True when `v` is a valid answer to `question`: a noul takes a boolean, a
// choice one of its own criteria keys, a score a finite number. The label route
// and the fixture exporter both judge a correct_value with this.
function answerInDomain(question, v) {
  if (!question) return false;
  if (question.type === 'noul') return typeof v === 'boolean';
  if (question.type === 'choice') return typeof v === 'string' && Object.prototype.hasOwnProperty.call(question.criteria || {}, v);
  if (question.type === 'score') return typeof v === 'number' && Number.isFinite(v);
  return false;
}

// The closed set of providers a decision_reviews row may come from (the
// table's provider CHECK, migration 20261002010000, mirrors it). typesafe is
// Jev; a provider is added here and by a new migration together.
const DECISION_PROVIDERS = Object.freeze(['typesafe', 'cloudflare']);
const DEFAULT_DECISION_PROVIDER = 'typesafe';
// What the review workflow calls each provider's model: the queue, the daily
// item and the Typed tab name whose answer a row holds (Codex r1 on #5555).
const DECISION_PROVIDER_LABELS = Object.freeze({ typesafe: 'Jev', cloudflare: 'Clef' });
// provider is NOT NULL and registry-constrained on the table, so a value this
// does not know is malformed data, refused rather than shown as Jev's (Codex r8).
function providerLabel(provider) {
  if (!Object.prototype.hasOwnProperty.call(DECISION_PROVIDER_LABELS, provider)) throw new Error(`unknown decision provider: ${provider}`);
  return DECISION_PROVIDER_LABELS[provider];
}

// How much of a call transcript call_judge is given (call-self-audit.js). The
// admin review route shows the reviewer the same span.
const CALL_TRANSCRIPT_CHARS = 5000;

module.exports = { PACKAGES, packageFor, packageHash, OUTCOME_SOURCES, answerInDomain, CALL_TRANSCRIPT_CHARS, DECISION_PROVIDERS, DEFAULT_DECISION_PROVIDER, DECISION_PROVIDER_LABELS, providerLabel };
