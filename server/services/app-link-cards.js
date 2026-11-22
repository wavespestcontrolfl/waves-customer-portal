/**
 * The add-a-service card and the referral card on a public LINK page: the
 * paid receipt and the completed-visit tracker (GATE_DOC_CROSS_SELL, owner
 * 2026-11-21).
 *
 * Each card is a link into the Waves app (owner 2026-11-22, the "app"
 * option). Nothing on a link page acts for the customer: these pages have no
 * card tap route. The receipt link is the pay link, and the tracker link is
 * texted to the visit's contacts, so a link can reach a payer, a bookkeeper,
 * a tenant or anyone it is forwarded to. That person sees a card and can do
 * nothing with it. The app's sign-in decides who may buy, ask for a quote or
 * get a referral link.
 *
 * So what is here are DISPLAY rules, not an authorization boundary. A page
 * shows no card when its link goes to other people by the account's own
 * setup (linkReachesOnlyAccountHolder); a forwarded link is not tracked.
 *
 * The offer is the app's own (appOfferForCustomer): the page names an offer
 * only when the app's Billing tab shows one, and the same one. A card carries
 * only what the page prints.
 */
const db = require('../models/db');

// Does this account send its links only to the account holder? An account
// with a service contact (tenant, home buyer, property manager) or a
// third-party payer also sends them to that person. `row` carries the
// customer's service contact columns (SERVICE_CONTACT_COLUMNS).
function linkReachesOnlyAccountHolder(row, payerIds = []) {
  if (!row || payerIds.some(Boolean)) return false;
  const { getServiceContactSlots } = require('./customer-contact');
  return !getServiceContactSlots(row).some((slot) => slot.phone || slot.email);
}

// What the link page prints of the app's offer: the service, start or add,
// and the per-application price of a priced offer. No option id and no
// fingerprint: the page has nothing to send back.
function publicOfferCard(offer) {
  if (!offer?.serviceKey || !offer.label) return null;
  const perVisit = Number(offer.option?.perVisit);
  const priced = offer.mode === 'priced' && Number.isFinite(perVisit) && perVisit > 0;
  return {
    label: offer.label,
    relationship: offer.relationship === 'start' ? 'start' : 'add',
    ...(priced ? { perApplication: perVisit } : {}),
  };
}

// → { crossSell?, referral? } for a customer whose link page may show the
// cards. Reads only: nothing here enrolls a promoter or files a request.
async function appLinkCardsForCustomer(customerId, database = db) {
  const cards = {};
  const { appOfferForCustomer } = require('./property-recommendations');
  const crossSell = publicOfferCard(await appOfferForCustomer(customerId, { knex: database }));
  if (crossSell) cards.crossSell = crossSell;
  // The customer's own card: with GATE_REFERRAL_STEP2 on, the per-customer
  // reward line. No card while the program is off.
  const referral = await require('./referral-share').composeReferralCard({ customerId });
  if (referral) cards.referral = referral;
  return cards;
}

module.exports = { linkReachesOnlyAccountHolder, publicOfferCard, appLinkCardsForCustomer };
