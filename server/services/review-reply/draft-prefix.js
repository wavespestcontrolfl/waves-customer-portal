/**
 * The "[DRAFT]" convention on google_reviews.review_reply.
 *
 * A reply stored with this prefix is a LOCAL draft that has never reached
 * Google: the hourly sync refuses to overwrite it with Google's (empty)
 * owner reply, the dashboard / Agent Ops / Intelligence Bar all count it as
 * "still needs a real reply", and the ReviewsPage offers it as "Use Draft".
 *
 * This was copy-pasted into six files before the auto-reply lane; every
 * reader now imports it from here so the prefix can never drift.
 */

const DRAFT_REPLY_PREFIX = '[DRAFT]';

function isDraftReply(reply) {
  return typeof reply === 'string' && reply.trim().startsWith(DRAFT_REPLY_PREFIX);
}

function hasRealReply(reply) {
  return Boolean(reply) && !isDraftReply(reply);
}

function stripDraftPrefix(reply) {
  if (!isDraftReply(reply)) return typeof reply === 'string' ? reply : '';
  return reply.trim().slice(DRAFT_REPLY_PREFIX.length).trim();
}

function asDraft(text) {
  return `${DRAFT_REPLY_PREFIX} ${String(text || '').trim()}`;
}

// knex modifiers. `column` may be qualified ('google_reviews.review_reply')
// when the query joins.
function whereNeedsRealReply(qb, column = 'review_reply') {
  qb.where(function needsRealReply() {
    this.whereNull(column).orWhere(column, 'like', `${DRAFT_REPLY_PREFIX}%`);
  });
}

function whereHasRealReply(qb, column = 'review_reply') {
  qb.whereNotNull(column).where(column, 'not like', `${DRAFT_REPLY_PREFIX}%`);
}

module.exports = {
  DRAFT_REPLY_PREFIX,
  isDraftReply,
  hasRealReply,
  stripDraftPrefix,
  asDraft,
  whereNeedsRealReply,
  whereHasRealReply,
};
