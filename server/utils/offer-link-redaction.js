/**
 * The job-offer link (/careers/offer/<64-hex token>) is the applicant's signing credential: whoever holds it can read the
 * offer and sign, decline or ask for another date as the applicant (GATE_JOB_OFFERS). The provider gets the full body,
 * but every STORED copy of an offer text or email (sms_log, the unified messages rows, the messaging audit preview, the
 * email ledger, the deferred queue row, comms_history) keeps the path with the token hidden, so no staff reader, shared
 * inbox, scheduled-message list or tool can show it. Applied at each write point; a body with no offer link is returned
 * unchanged, so no other message is affected. A deferred text is rebuilt with the real links from the job_offers rows
 * at replay time (messaging/deferred-replay-registry.js replayBodyFor): the offer text by its pinned offer, any other
 * held text (an owner reply that pastes a link) by the offers its links were pinned to when it was queued.
 */

const OFFER_LINK_TOKEN_RE = /(\/careers\/offer\/)[0-9a-f]{64}/gi;
const HIDDEN = '[link hidden]';

function redactOfferLinks(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(OFFER_LINK_TOKEN_RE, `$1${HIDDEN}`);
}

// The link tokens in `text`, in the order they appear (lowercase hex, as job_offers.token stores them).
function offerLinkTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  return Array.from(text.matchAll(OFFER_LINK_TOKEN_RE), (m) => m[0].slice(-64).toLowerCase());
}

module.exports = { redactOfferLinks, offerLinkTokens, OFFER_LINK_HIDDEN: HIDDEN };
