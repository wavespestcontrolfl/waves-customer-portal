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
 * setup (linkReachesOnlyAccountHolder), or when the app would not open the
 * card's tab for the customer (appOpensForCustomer); a forwarded link is not
 * tracked.
 *
 * The offer is the app's own (appOfferForCustomer): the page names an offer
 * only when the app's Billing tab shows one, and the same one, on the same
 * profile (appLinksForCustomer). A card carries only what the page prints,
 * and its link.
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

// The cards open the Waves app, so a page shows them only to a customer the
// app opens those tabs for: an ACTIVE customer. A cancelled customer signs in
// to a read-only app with no Refer tab and no offer (middleware/auth.js
// sessionCustomerAdmitted; the app's CANCELLED_TABS), and any other inactive
// or removed customer cannot sign in at all. `row` carries customers.active
// as customer_active and customers.deleted_at as customer_deleted_at.
function appOpensForCustomer(row) {
  return row?.customer_active === true && !row.customer_deleted_at;
}

// Where each card goes in the app. A login account can hold more than one
// customer profile (one login, several homes), and the app opens on the
// profile the holder last used. So each link names the profile the card was
// composed for, in the app's own way (qualifyNotificationLink): the app's
// route guard switches to that profile before the tab opens, and
// /auth/select-property refuses a profile the signed-in account does not
// own. The id is no credential: nothing answers to it without a session.
function appLinksForCustomer(customerId) {
  const { qualifyNotificationLink } = require('./notification-links');
  return {
    offer: qualifyNotificationLink('/?tab=billing', customerId),
    referral: qualifyNotificationLink('/?tab=refer', customerId),
  };
}

// What the link page prints of the app's offer: the service, start or add,
// and the per-application price when the APP shows that price. The app
// prints a price only on its one-tap purchase button; without one-tap its
// card asks for an estimate and names no price (owner 2026-08-28), so the
// page's card is then a quote request too. No option id and no fingerprint:
// the page has nothing to send back.
function publicOfferCard(offer, { oneTap = false } = {}) {
  if (!offer?.serviceKey || !offer.label) return null;
  const perVisit = Number(offer.option?.perVisit);
  const priced = oneTap === true && offer.mode === 'priced' && Number.isFinite(perVisit) && perVisit > 0;
  return {
    label: offer.label,
    relationship: offer.relationship === 'start' ? 'start' : 'add',
    ...(priced ? { perApplication: perVisit } : {}),
  };
}

// → { crossSell?, referral? } for a customer whose link page may show the
// cards, each with the `href` of its tab in the app. Reads only: nothing
// here enrolls a promoter or files a request.
async function appLinkCardsForCustomer(customerId, database = db) {
  const cards = {};
  const links = appLinksForCustomer(customerId);
  const { appOfferForCustomer } = require('./property-recommendations');
  const offer = await appOfferForCustomer(customerId, { knex: database });
  const oneTap = offer ? await require('./one-tap-purchase').oneTapShownTo(customerId, database) : false;
  const crossSell = publicOfferCard(offer, { oneTap });
  if (crossSell) cards.crossSell = { ...crossSell, href: links.offer };
  // The customer's own card: with GATE_REFERRAL_STEP2 on, the per-customer
  // reward line. No card while the program is off.
  const referral = await require('./referral-share').composeReferralCard({ customerId });
  if (referral) cards.referral = { ...referral, href: links.referral };
  return cards;
}

module.exports = {
  linkReachesOnlyAccountHolder, appOpensForCustomer, appLinksForCustomer, publicOfferCard, appLinkCardsForCustomer,
};
