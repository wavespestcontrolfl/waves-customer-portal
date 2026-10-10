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
 *
 * A snapshot with no source is the old by-city finder's.
 */
module.exports = Object.freeze({
  SCHEDULER_OFFER_SOURCE: 'scheduler',
  ESTIMATE_OFFER_SOURCE: 'estimate',
  BOOK_OFFER_SOURCE: 'book',
  WEBSITE_OFFER_SOURCE: 'website_engine',
});
