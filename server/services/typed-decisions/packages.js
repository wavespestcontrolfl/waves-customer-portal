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
  id: 'call_judge.v1',
  capability: 'call_judge',
  version: 1,
  description: 'Six yes/no judgements over one phone call: lead, spam, voicemail, agreed appointment, promised quote, complaint.',
  stateShape: ['call_direction', 'duration_seconds', 'transcript'],
  thresholds: { ...THRESHOLDS },
  questions: {
    is_lead: noul('Is the caller a NEW prospective customer (not an existing customer, vendor, spam or wrong number)?'),
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

module.exports = { PACKAGES, packageFor, packageHash };
