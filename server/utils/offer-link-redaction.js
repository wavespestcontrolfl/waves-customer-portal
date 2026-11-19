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

// A browser also opens spellings the literal pattern misses, because it cleans the path first: dot segments
// (/careers/offer/./<token>, /careers/x/../offer/<token>, %2e), backslashes (\careers\offer\<token>). None of those steps
// adds a letter, and the page refuses a path that still holds a percent sign, so every spelling that opens the offer
// keeps "careers", "offer" (any case) and the token in one unbroken run of text. In such a run every 64-hex token is
// hidden too. An /careers/interview/ link has no "offer" and is left alone. Out of reach of any pattern: a token a
// person has to put back together (split by spaces or line breaks); it is not a link, and it is not covered here.
const UNBROKEN_RUN_RE = /\S+/g;
const TOKEN_RUN_RE = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
const hideTokensInOfferRun = (run) => (/careers/i.test(run) && /offer/i.test(run) ? run.replace(TOKEN_RUN_RE, HIDDEN) : run);

function redactOfferLinks(text) {
  if (typeof text !== 'string' || !text) return text;
  // The literal pass first: it keeps the /careers/offer/[link hidden] marker the deferred replay rebuilds from.
  return text.replace(OFFER_LINK_TOKEN_RE, `$1${HIDDEN}`).replace(UNBROKEN_RUN_RE, hideTokensInOfferRun);
}

// The link tokens in `text`, in the order they appear (lowercase hex, as job_offers.token stores them).
function offerLinkTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  return Array.from(text.matchAll(OFFER_LINK_TOKEN_RE), (m) => m[0].slice(-64).toLowerCase());
}

module.exports = { redactOfferLinks, offerLinkTokens, OFFER_LINK_HIDDEN: HIDDEN };
