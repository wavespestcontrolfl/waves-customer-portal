/**
 * Who gets a Waves Pest Insider issue.
 *
 * Warm phase: a new email stream starts with the readers whose mailbox opened a Waves email
 * in the last 90 days, so the first issues go to people who read Waves mail. A Waves email is
 * any email Waves sent: a transactional or automated one (email_messages.opened_at) or a Waves
 * newsletter (newsletter_send_deliveries.opened_at, where SendGrid records newsletter opens).
 * A later phase widens this to every opted-in reader.
 *
 * Holdout: a fixed 10% of customer-linked subscribers never get an issue, so the issues'
 * effect on renewals and add-ons can be measured against them. Membership is a hash of the
 * customer id with a fixed salt, so the same customers are held out every issue. A subscriber
 * with no customer (a lead) is never held out. The plan drops held-out customers, and the
 * sender checks the holdout again right before each batch, on the subscriber's customer link
 * at that moment (segment_filter.holdout): a lead that became a held-out customer after the
 * plan, or a relink to another customer, never gets the issue, on a first send or a resume.
 *
 * The audience starts from the send path's own subscriber query (buildSubscriberQuery: active,
 * not suppressed, not archived, mailable), after the same archived-link relink sweep the send
 * path runs first. The sender applies those rules again at send time, so a reader who
 * unsubscribes after the issue is planned still gets nothing.
 *
 * The issue's newsletter_sends row carries the result as segment_filter { subscriber_ids,
 * holdout } (audienceSegmentFilter); buildSubscriberQuery mails only those ids and fails
 * closed on a malformed or empty list, or on a holdout name it does not know.
 */
'use strict';

const crypto = require('crypto');

const WARM_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOLDOUT_PERCENT = 10;
// Changing the salt picks a different holdout group: keep it fixed while a measurement runs.
const HOLDOUT_SALT = 'waves-pest-insider-holdout-v1';
// The name the send's segment_filter gives this holdout (newsletter-sender.js SEND_HOLDOUTS).
const HOLDOUT_NAME = 'pest-insider';

/** True when this customer is in the fixed holdout group. A subscriber with no customer never is. */
function isHeldOut(customerId) {
  if (customerId == null || customerId === '') return false;
  const digest = crypto.createHash('sha256').update(`${HOLDOUT_SALT}:${customerId}`).digest();
  return digest.readUInt32BE(0) % 100 < HOLDOUT_PERCENT;
}

/**
 * The warm readers as a query: every subscriber the send path would mail whose address opened
 * a Waves email (an email_messages row, or a Waves newsletter delivered to this subscriber or
 * this address) from `since` through `until` (both inclusive), so a plan made for a past moment
 * counts only the opens before it. Ordered by id; selects the id and the linked customer only.
 */
function warmAudienceQuery({ since, until }) {
  // Lazy: the sender pulls the whole newsletter stack; the planner loads this only when it runs.
  const db = require('../../models/db');
  const { buildSubscriberQuery } = require('../newsletter-sender');
  return buildSubscriberQuery(null)
    .where(function openedWavesEmail() {
      this.whereExists(function openedEmail() {
        this.select(db.raw('1'))
          .from('email_messages as opened')
          .whereRaw('lower(opened.recipient_email_snapshot) = lower(newsletter_subscribers.email)')
          .where('opened.opened_at', '>=', since)
          .where('opened.opened_at', '<=', until);
      }).orWhereExists(function openedNewsletter() {
        this.select(db.raw('1'))
          .from('newsletter_send_deliveries as nl_open')
          .whereRaw('(nl_open.subscriber_id = newsletter_subscribers.id or lower(nl_open.email) = lower(newsletter_subscribers.email))')
          .where('nl_open.opened_at', '>=', since)
          .where('nl_open.opened_at', '<=', until);
      });
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
  const warm = await warmAudienceQuery({ since: new Date(asOf.getTime() - WARM_DAYS * DAY_MS), until: asOf });

  const subscriberIds = [];
  let heldOut = 0;
  for (const row of warm) {
    if (isHeldOut(row.customer_id)) heldOut += 1;
    else subscriberIds.push(Number(row.id));
  }
  return { subscriberIds, counts: { warm: warm.length, heldOut, recipients: subscriberIds.length } };
}

/**
 * The segment_filter that makes the send path mail exactly this audience, with the holdout
 * checked again at send time.
 */
function audienceSegmentFilter(audience) {
  return { subscriber_ids: [...audience.subscriberIds], holdout: HOLDOUT_NAME };
}

module.exports = {
  isHeldOut, warmAudienceQuery, selectIssueAudience, audienceSegmentFilter,
  WARM_DAYS, HOLDOUT_PERCENT, HOLDOUT_SALT, HOLDOUT_NAME,
};
