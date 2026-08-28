'use strict';
const crypto = require('crypto');

/**
 * Identity of the review CONTENT a draft or reply was written for: rating,
 * text, reviewer identity AND customer attribution (the account facts in
 * the grounding derive from customer_id, so a re-attribution makes a draft
 * stale too). Leaf module: used by the runner, the publisher and the list
 * API (browser-observed review token) without a require cycle.
 */
function reviewFingerprint(row) {
  // An unconfirmed click_auto link grounds review-only (grounding.js
  // groundingCustomerId), so it is not part of the identity either: a delayed
  // click auto-link landing after a draft was stored must not invalidate a
  // draft whose facts did not change (codex r57). A manual confirmation
  // (link_source moves off click_auto) does change the identity.
  const grounded = row.link_source === 'click_auto' ? '' : (row.customer_id || '');
  return crypto.createHash('sha1').update(`${Number(row.star_rating) || 0}|${String(row.review_text || '').trim()}|${String(row.reviewer_name || '').trim().toLowerCase()}|${grounded}`).digest('hex');
}

module.exports = { reviewFingerprint };
