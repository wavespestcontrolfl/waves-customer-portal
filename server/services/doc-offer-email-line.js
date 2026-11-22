/**
 * One closing line in a customer email about the add-a-service and referral
 * cards (GATE_DOC_CROSS_SELL_EMAIL, owner 2026-11-21). It names only what
 * the customer will find behind the link (the caller passes the cards that
 * place shows right now) and never a price: an emailed price outlives the
 * property and pricing data behind it, so the place shows the current one.
 *
 * Two shapes:
 *   - a PAGE that holds both cards (the service report): `url` + `place`,
 *     one link.
 *   - the Waves app (the receipt email, owner 2026-11-22): `appUrls`
 *     { offer, referral }, one link for each card's tab. The app's sign-in
 *     decides who may act, so the line carries no token.
 *
 * Returns a sendTemplate `bodyAppend` ({ html, text }) or null.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const link = (url, words) => `<a class="dm-link" href="${escapeHtml(url)}" style="color:#0A7EC2;text-decoration:underline;">${escapeHtml(words)}</a>`;

// Can the customer add or start this offer where the link goes, or only ask
// for a quote? The report's offer says so in `mode`; a link page's card says
// so by carrying a per-application price or none.
function offerIsPriced(crossSell) {
  if (crossSell.mode !== undefined) return crossSell.mode === 'priced';
  return Number(crossSell.perApplication) > 0;
}

// The line must not promise more than its link gives: a quote-only offer is
// asked for, never added or started. relationship 'start': the customer has
// no recurring plan to add to (the card says the same).
function offerAsk(crossSell) {
  const label = crossSell?.label ? String(crossSell.label).toLowerCase() : '';
  if (!label) return '';
  if (!offerIsPriced(crossSell)) return `Get a quote for ${label}`;
  return crossSell.relationship === 'start' ? `Start ${label}` : `Add ${label} to your plan`;
}

function appLine(ask, offerLinkWords, referral, appUrls) {
  const offerUrl = ask ? appUrls.offer : null;
  const referralUrl = referral ? appUrls.referral : null;
  if (offerUrl && referralUrl) {
    return {
      html: `${escapeHtml(ask)} in the Waves app: ${link(offerUrl, offerLinkWords)}. To refer a friend, ${link(referralUrl, 'get your referral link')}.`,
      text: `${ask} in the Waves app: ${offerUrl}\nTo refer a friend, get your referral link: ${referralUrl}`,
    };
  }
  if (offerUrl) {
    return {
      html: `${escapeHtml(ask)} in the Waves app: ${link(offerUrl, offerLinkWords)}.`,
      text: `${ask} in the Waves app: ${offerUrl}`,
    };
  }
  if (referralUrl) {
    return {
      html: `Know someone who could use Waves? ${link(referralUrl, 'Get your referral link in the Waves app')}.`,
      text: `Know someone who could use Waves? Get your referral link in the Waves app: ${referralUrl}`,
    };
  }
  return null;
}

// place: the page the link opens, as the customer knows it ('report').
function docOfferEmailLine({ crossSell = null, referral = null, url = null, place = null, appUrls = null }) {
  if (!require('../config/feature-gates').isEnabled('docCrossSellEmail')) return null;
  const ask = offerAsk(crossSell);
  if (appUrls) return appLine(ask, ask && !offerIsPriced(crossSell) ? 'ask for a quote' : 'see your offer', referral, appUrls);
  if (!url || !place) return null;
  let lead;
  if (ask && referral) lead = `${ask} or refer a friend from your ${place}`;
  else if (ask) lead = `${ask} from your ${place}`;
  else if (referral) lead = `Know someone who could use Waves? Share your referral link from your ${place}`;
  else return null;
  return {
    html: `${escapeHtml(lead)}: ${link(url, `open your ${place}`)}.`,
    text: `${lead}: ${url}`,
  };
}

// sendTemplate takes one bodyAppend; join two closing lines in order.
function joinBodyAppends(...appends) {
  const present = appends.filter((a) => a && (a.html || a.text));
  if (!present.length) return null;
  if (present.length === 1) return present[0];
  return {
    html: present.map((a) => a.html).filter(Boolean).join('<br><br>'),
    text: present.map((a) => a.text).filter(Boolean).join('\n\n'),
  };
}

module.exports = { docOfferEmailLine, joinBodyAppends };
