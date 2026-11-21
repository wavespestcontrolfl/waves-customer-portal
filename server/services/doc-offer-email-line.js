/**
 * One closing line in a customer email pointing at the add-a-service and
 * referral cards on the page the email links to (GATE_DOC_CROSS_SELL_EMAIL,
 * owner 2026-11-21). It names only what that page will actually show — the
 * caller passes the cards the page would render right now — and never a
 * price: an emailed price outlives the property and pricing data behind it,
 * so the page shows the current one.
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

// place: the page the link opens, as the customer knows it ('receipt',
// 'report').
function docOfferEmailLine({ crossSell = null, referral = null, url, place }) {
  if (!require('../config/feature-gates').isEnabled('docCrossSellEmail') || !url || !place) return null;
  const label = crossSell?.serviceKey ? String(crossSell.label || '').toLowerCase() : '';
  let lead;
  if (label && referral) lead = `Add ${label} to your plan or refer a friend from your ${place}`;
  else if (label) lead = `Add ${label} to your plan from your ${place}`;
  else if (referral) lead = `Know someone who could use Waves? Share your referral link from your ${place}`;
  else return null;
  return {
    html: `${escapeHtml(lead)}: <a class="dm-link" href="${escapeHtml(url)}" style="color:#0A7EC2;text-decoration:underline;">open your ${escapeHtml(place)}</a>.`,
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
