/**
 * Who gets a Waves Pest Insider issue.
 *
 * Warm phase: a new email stream starts with the readers whose mailbox opened a Waves email
 * in the last 90 days (email_messages.opened_at), so the first issues go to people who read
 * Waves mail. A later phase widens this to every opted-in reader.
 *
 * Holdout: a fixed 10% of customer-linked subscribers never get an issue, so the issues'
 * effect on renewals and add-ons can be measured against them. Membership is a hash of the
 * customer id with a fixed salt, so the same customers are held out every issue. A subscriber
 * with no customer (a lead) is never held out.
 *
 * The audience starts from the send path's own subscriber query (buildSubscriberQuery: active,
 * not suppressed, not archived, mailable), after the same archived-link relink sweep the send
 * path runs first. The sender applies those rules again at send time, so a reader who
 * unsubscribes after the issue is planned still gets nothing.
 *
 * The issue's newsletter_sends row carries the result as segment_filter { subscriber_ids }
 * (audienceSegmentFilter); buildSubscriberQuery mails only those ids and fails closed on a
 * malformed or empty list.
 */
'use strict';

const crypto = require('crypto');

const WARM_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOLDOUT_PERCENT = 10;
// Changing the salt picks a different holdout group: keep it fixed while a measurement runs.
const HOLDOUT_SALT = 'waves-pest-insider-holdout-v1';

/** True when this customer is in the fixed holdout group. A subscriber with no customer never is. */
function isHeldOut(customerId) {
  if (customerId == null || customerId === '') return false;
  const digest = crypto.createHash('sha256').update(`${HOLDOUT_SALT}:${customerId}`).digest();
  return digest.readUInt32BE(0) % 100 < HOLDOUT_PERCENT;
}

/**
 * The warm readers as a query: every subscriber the send path would mail whose address opened
 * a Waves email at or after `since`. Ordered by id; selects the id and the linked customer only.
 */
function warmAudienceQuery({ since }) {
  // Lazy: the sender pulls the whole newsletter stack; the planner loads this only when it runs.
  const db = require('../../models/db');
  const { buildSubscriberQuery } = require('../newsletter-sender');
  return buildSubscriberQuery(null)
    .whereExists(function openedWavesEmail() {
      this.select(db.raw('1'))
        .from('email_messages as opened')
        .whereRaw('lower(opened.recipient_email_snapshot) = lower(newsletter_subscribers.email)')
        .where('opened.opened_at', '>=', since);
    })
    .select('newsletter_subscribers.id', 'newsletter_subscribers.customer_id')
    .orderBy('newsletter_subscribers.id', 'asc');
}

/**
 * The issue's audience as of `asOf`: subscriber ids (ascending) and the counts behind them.
 * Runs the send path's archived-link relink sweep first, as every audience read does.
 * @returns {Promise<{ subscriberIds: number[], counts: { warm: number, heldOut: number, recipients: number } }>}
 */
async function selectIssueAudience({ asOf = new Date() } = {}) {
  const db = require('../../models/db');
  const NewsletterSubscribers = require('../newsletter-subscribers');

  await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);
  const warm = await warmAudienceQuery({ since: new Date(asOf.getTime() - WARM_DAYS * DAY_MS) });

  const subscriberIds = [];
  let heldOut = 0;
  for (const row of warm) {
    if (isHeldOut(row.customer_id)) heldOut += 1;
    else subscriberIds.push(Number(row.id));
  }
  return { subscriberIds, counts: { warm: warm.length, heldOut, recipients: subscriberIds.length } };
}

/** The segment_filter that makes the send path mail exactly this audience. */
function audienceSegmentFilter(audience) {
  return { subscriber_ids: [...audience.subscriberIds] };
}

module.exports = {
  isHeldOut, warmAudienceQuery, selectIssueAudience, audienceSegmentFilter,
  WARM_DAYS, HOLDOUT_PERCENT, HOLDOUT_SALT,
};
