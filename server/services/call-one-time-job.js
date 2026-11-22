'use strict';

// What "ONE one-time job" means in the stored reading of a call (the V2 extraction). Two readers share it, so
// they cannot disagree about the same call:
//   - the call booking check's price bell (call-booking-check.js): a stated price is tied to a visit only for
//     such a call;
//   - the call booker's agreed-one-time-job hold (call-recording-processor.js callAgreedOneTimeJob,
//     GATE_CALL_AGREED_ONE_TIME_JOB): the one-time service the reading named is kept only for such a call.
// Pure: it reads the extraction and nothing else.

// One service name, as both readers compare names: case and runs of spaces do not count, and nothing else is
// bridged (no short name, no key, no renamed label). The price bell ties a stated price to a visit only when
// the reading, the visit's catalog row and the visit's label carry one name by this key; the hold keeps a
// service only when the reading carries its catalog row's own name by this key.
const serviceNameKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The intents of a call about a one-time job.
const ONE_TIME_JOB_INTENTS = new Set(['active_infestation_treatment', 'preventative_one_time']);

// Flags by which the reading itself says the job is not settled: a second property, or a service it could not
// tell (the call pipeline sends such a call to a person).
const UNSETTLED_JOB_FLAGS = Object.freeze(['multi_property_call', 'ambiguous_pest_or_service']);

// Whether the reading says the call was about ONE one-time job and nothing else. The reading's price block is
// call-wide: it does not say which job a price covers. So a price counts for the visit only when the reading
// holds no other job, no other property and no plan. The intent is a list of what counts, not of what does not:
// a plan ask, an inspection, a quote, a follow-up, a complaint, a cancellation and no intent all fail. A plan
// shows as a bundle category, a tier the caller named, a billing choice, or a tier or an annual prepay on any
// stored price entry (the caller's own number, and an entry with no amount, too). A flag that says the reading
// could not tell the service, or that the call spoke of a second property, fails too.
function readsAsOneOneTimeJob(reading) {
  const request = reading.service_request;
  const entries = [request.price, ...(Array.isArray(request.prices) ? request.prices : [])].filter((entry) => entry && typeof entry === 'object');
  const flags = Array.isArray(reading.triage_flags) ? reading.triage_flags : [];
  const others = [request.secondary_categories, reading.property && reading.property.additional_properties];
  return ONE_TIME_JOB_INTENTS.has(request.service_intent)
    && request.primary_service_category !== 'bundled_waveguard'
    && !request.waveguard_tier_mentioned
    && !require('./call-prepay-choice').billingChoiceOf(reading)
    && !entries.some((entry) => entry.tier_mentioned || entry.prepay_term === 'annual')
    && !others.some((list) => Array.isArray(list) && list.length)
    && !flags.some((flag) => UNSETTLED_JOB_FLAGS.includes(flag));
}

module.exports = { readsAsOneOneTimeJob, serviceNameKey, ONE_TIME_JOB_INTENTS, UNSETTLED_JOB_FLAGS };
