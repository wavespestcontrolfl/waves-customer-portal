/**
 * The pickers a texted appointment offer can come from: the value stored as
 * open_times_snapshot.lookup.source. One module so the drafter that stamps a
 * snapshot and every consumer that switches on it (sms-suggest-mode's picker
 * classifier, sms-offers' ledger kind) read the same constants.
 *
 *   scheduler       a visit's own reschedule-link picker
 *   estimate        an estimate's public page picker
 *   book            the /book funnel for the customer's own pin
 *   website_engine  the website booking engine for the city-based fallback
 *                   (GATE_MULTI_TECH_TEXT_TIMES): the customer's pin or the
 *                   city centre, for the text's funnel service
 *   route_times    the customer pages' time list for the customer's own pin, for
 *                   the city-based fallback (GATE_ASSISTANT_ROUTE_TIMES=true). It
 *                   replaces the old by-city finder's quote, so it counts in the
 *                   offer ledger as an unknown kind exactly like that finder's
 *                   snapshot (never acted on), and the send-time recheck asks
 *                   this list again whatever the gate says by then.
 *   reservice       the free re-service booking page's own openings
 *                   (GATE_SMS_PROMPT_B1): a covered pest report is offered the
 *                   times its re-service link shows; a person books the pick,
 *                   so the offer ledger counts it and never acts on it
 *
 * A snapshot with no source is the old by-city finder's.
 */
module.exports = Object.freeze({
  SCHEDULER_OFFER_SOURCE: 'scheduler',
  ESTIMATE_OFFER_SOURCE: 'estimate',
  BOOK_OFFER_SOURCE: 'book',
  WEBSITE_OFFER_SOURCE: 'website_engine',
  RESERVICE_OFFER_SOURCE: 'reservice',
  ROUTE_TIMES_OFFER_SOURCE: 'route_times',
});
