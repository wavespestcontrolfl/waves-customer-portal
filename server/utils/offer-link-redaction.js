/**
 * The job-offer link (/careers/offer/<64-hex token>) is the applicant's signing credential: whoever holds it can read the
 * offer and sign, decline or ask for another date as the applicant (GATE_JOB_OFFERS). The provider gets the full body,
 * but every STORED copy of an offer text or email (sms_log, the unified messages rows, the messaging audit preview, the
 * email ledger, the deferred queue row, comms_history) keeps the path with the token hidden, so no staff reader, shared
 * inbox, scheduled-message list or tool can show it. Applied at each write point; a body with no offer link is returned
 * unchanged, so no other message is affected. A deferred offer text is rebuilt with the real link from the job_offers
 * row at replay time (messaging/deferred-replay-registry.js replayBodyFor).
 */

const OFFER_LINK_TOKEN_RE = /(\/careers\/offer\/)[0-9a-f]{64}/gi;
const HIDDEN = '[link hidden]';

function redactOfferLinks(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(OFFER_LINK_TOKEN_RE, `$1${HIDDEN}`);
}

module.exports = { redactOfferLinks, OFFER_LINK_HIDDEN: HIDDEN };
