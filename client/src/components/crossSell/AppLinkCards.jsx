/**
 * The add-a-service card and the referral card on a public LINK page: the
 * paid receipt and the completed-visit tracker (GATE_DOC_CROSS_SELL, owner
 * 2026-11-21).
 *
 * Each card is a plain link into the Waves app (owner 2026-11-22): the offer
 * opens the Billing tab, the referral opens the Refer tab. Nothing here posts
 * anything. A receipt or tracker link can reach people other than the
 * customer, so the app's sign-in decides who may act, and the links carry no
 * token.
 *
 * The server composes what a card names (services/app-link-cards.js): the
 * offer the app shows that customer, with its per-application price when the
 * app sells that offer in one tap (AGENTS.md: "per application" is the only
 * unit; never a monthly or plan total), and the referral program's own words.
 * It also sends each card's link (`href`): the tab plus the customer profile
 * the card was composed for, so the app opens that profile and not the one
 * the holder last used (App.jsx resolveNotificationTarget).
 *
 * Props:
 *   offer     — the payload's crossSell { label, relationship, perApplication?,
 *               href? }; null → no offer card
 *   referral  — the payload's referral { headline, cta, offer?, href? }; null
 *               → no referral card
 *   style / styles — inline styles { heading, price, copy, button } for the
 *               host page
 */
export const APP_OFFER_PATH = '/?tab=billing';
export const APP_REFERRAL_PATH = '/?tab=refer';

// A card's link: the server's `href` when it is this tab's own link with a
// profile named, else the bare tab (an older payload, or anything else).
export function appCardHref(card, tabPath) {
  const href = card?.href;
  return typeof href === 'string' && href.startsWith(`${tabPath}&notificationProperty=`) ? href : tabPath;
}

export function appOfferPriceLine(offer) {
  const perApplication = Number(offer?.perApplication);
  if (!Number.isFinite(perApplication) || perApplication <= 0) return null;
  const amount = Number.isInteger(perApplication) ? String(perApplication) : perApplication.toFixed(2);
  return `$${amount} per application`;
}

function OfferCard({ offer, style, styles }) {
  const label = String(offer.label).toLowerCase();
  const priceLine = appOfferPriceLine(offer);
  // relationship 'start': the customer has no recurring plan to add to.
  const pricedHeading = offer.relationship === 'start' ? `Start ${label}` : `Add ${label} to your plan`;
  return (
    <section data-section="cross-sell" style={style || undefined}>
      <h2 style={styles.heading || undefined}>
        {priceLine ? pricedHeading : `Want a quote for ${label}?`}
      </h2>
      {priceLine && (
        <p style={styles.price || undefined}>{`${priceLine}, priced for your home`}</p>
      )}
      <p style={styles.copy || undefined}>
        {priceLine
          ? 'See this offer in the Waves app. Nothing is booked or charged until you confirm it there.'
          : 'Ask for it in the Waves app. Nothing is booked or charged.'}
      </p>
      <a href={appCardHref(offer, APP_OFFER_PATH)} style={styles.button || undefined}>Open the Waves app</a>
    </section>
  );
}

function ReferralCard({ referral, style, styles }) {
  return (
    <section data-section="referral" style={style || undefined}>
      <h2 style={styles.heading || undefined}>{referral.headline}</h2>
      {referral.offer ? <p style={styles.copy || undefined}>{referral.offer}</p> : null}
      <p style={styles.copy || undefined}>Your referral link is in the Waves app.</p>
      <a href={appCardHref(referral, APP_REFERRAL_PATH)} style={styles.button || undefined}>{referral.cta || 'Refer a friend'}</a>
    </section>
  );
}

export default function AppLinkCards({ offer = null, referral = null, style = null, styles = {} }) {
  const showOffer = Boolean(offer?.label);
  const showReferral = Boolean(referral?.headline);
  if (!showOffer && !showReferral) return null;
  return (
    <>
      {showOffer ? <OfferCard offer={offer} style={style} styles={styles} /> : null}
      {showReferral ? <ReferralCard referral={referral} style={style} styles={styles} /> : null}
    </>
  );
}
