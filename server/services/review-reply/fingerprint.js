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
  return crypto.createHash('sha1').update(`${Number(row.star_rating) || 0}|${String(row.review_text || '').trim()}|${String(row.reviewer_name || '').trim().toLowerCase()}|${row.customer_id || ''}`).digest('hex');
}

module.exports = { reviewFingerprint };
