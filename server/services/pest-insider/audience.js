/**
 * Who gets a Waves Pest Insider issue.
 *
 * Warm phase: a new email stream starts with the readers whose mailbox opened a Waves email
 * in the last 90 days, so the first issues go to people who read Waves mail. The opens come
 * from the SendGrid webhook's event log (sendgrid_webhook_events), which keeps one row for
 * every event on a tracked Waves email: a Waves newsletter, an automation step, a template
 * message. So a repeat open counts (the delivery and message rows keep only the FIRST open),
 * and the open belongs to the address that opened it: an open by a former address, before an
 * address correction, never qualifies the new one. A later phase widens this to every
 * opted-in reader.
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
 * The warm readers as a query: every subscriber the send path would mail whose CURRENT address
 * has an open event in the SendGrid webhook log from `since` through `until` (both inclusive),
 * so a plan made for a past moment counts only the opens before it. The log's time is when the
 * webhook recorded the event, seconds after the open. Ordered by id; selects the id and the
 * linked customer only.
 */
function warmAudienceQuery({ since, until }) {
  // Lazy: the sender pulls the whole newsletter stack; the planner loads this only when it runs.
  const db = require('../../models/db');
  const { buildSubscriberQuery } = require('../newsletter-sender');
  return buildSubscriberQuery(null)
    // Grouped, so the check is ANDed with every send-path rule before it.
    .where(function openedWavesEmail() {
      this.whereExists(function openEvent() {
        this.select(db.raw('1'))
          .from('sendgrid_webhook_events as opened')
          .where('opened.event_type', 'open')
          .whereRaw('lower(opened.email) = lower(newsletter_subscribers.email)')
          .where('opened.created_at', '>=', since)
          .where('opened.created_at', '<=', until);
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
