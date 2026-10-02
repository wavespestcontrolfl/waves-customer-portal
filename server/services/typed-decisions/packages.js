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

const PACKAGES = deepFreeze({
  [CALL_JUDGE.id]: CALL_JUDGE,
  [SMS_COURTESY.id]: SMS_COURTESY,
  [SMS_RESCHEDULE.id]: SMS_RESCHEDULE,
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

// How much of a call transcript call_judge is given (call-self-audit.js). The
// admin review route shows the reviewer the same span.
const CALL_TRANSCRIPT_CHARS = 5000;

module.exports = { PACKAGES, packageFor, packageHash, OUTCOME_SOURCES, answerInDomain, CALL_TRANSCRIPT_CHARS, DECISION_PROVIDERS, DEFAULT_DECISION_PROVIDER };
