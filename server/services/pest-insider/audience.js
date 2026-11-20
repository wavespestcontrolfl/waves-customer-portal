/**
 * Who gets a Waves Pest Insider issue.
 *
 * Warm phase: a new email stream starts with the readers whose mailbox opened a Waves email
 * in the last 90 days, so the first issues go to people who read Waves mail. The opens come
 * from the SendGrid webhook's event log (sendgrid_webhook_events), which keeps one row for
 * every event on a tracked Waves email: a Waves newsletter, an automation step, a template
 * message. So a repeat open counts (the delivery and message rows keep only the FIRST open),
 * and the open belongs to the address that opened it: an open by a former address, before an
 * address correction, never qualifies the new one. The window is on the open's own time
 * (occurred_at, SendGrid's event timestamp); a row logged before that column existed uses the
 * time the webhook logged it. An open SendGrid marks as a machine open (sg_machine_open: Apple
 * Mail Privacy Protection fetched the email, whether or not a person read it) never qualifies;
 * a row logged before that flag was kept has none and still counts, as nothing tells it apart.
 * A later phase widens this to every opted-in reader.
 *
 * The plan keeps, for each reader, a key of the address that qualified (address_keys), and the
 * sender mails a reader only at that address: if the subscriber's address changes before the
 * send, on a first send or a resume, that reader is skipped.
 *
 * Holdout: a fixed 10% of customers never get an issue, so the issues' effect on renewals and
 * add-ons can be measured against them. Membership is a hash of the customer id with a fixed
 * salt, so the same customers are held out every issue. The holdout covers a whole mailbox: a
 * reader is held out when its own customer link, or any customer behind its mailbox (linked to
 * another subscriber row on it, an alias included, or whose own email is on it), is held out
 * (withMailboxCustomers in the sender, read in the same query as the reader). A lead with no
 * customer behind its mailbox is never held out. The plan drops held-out readers, and the
 * sender checks the holdout again right before each batch, on the links at that moment
 * (segment_filter.holdout): a lead that became a held-out customer after the plan, or a
 * relink, never gets the issue, on a first send or a resume.
 *
 * The audience starts from the send path's own subscriber query (buildSubscriberQuery: active,
 * not suppressed, not archived, mailable), after the same archived-link relink sweep the send
 * path runs first. The sender applies those rules again at send time, so a reader who
 * unsubscribes after the issue is planned still gets nothing.
 *
 * The issue's newsletter_sends row carries the result as segment_filter { subscriber_ids,
 * holdout, address_keys } (audienceSegmentFilter); buildSubscriberQuery mails only those ids
 * and fails closed on a malformed, empty or missing list, or on a holdout name it does not know.
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
// Changing the prefix gives every address a new key: a queued issue would then skip everyone.
const ADDRESS_KEY_PREFIX = 'waves-pest-insider-address-v1';

/** True when this customer is in the fixed holdout group. A subscriber with no customer never is. */
function isHeldOut(customerId) {
  if (customerId == null || customerId === '') return false;
  const digest = crypto.createHash('sha256').update(`${HOLDOUT_SALT}:${customerId}`).digest();
  return digest.readUInt32BE(0) % 100 < HOLDOUT_PERCENT;
}

/**
 * A fixed key for a mailbox address (trimmed, lower-cased), or null for an empty one. The plan
 * stores it per reader instead of the address; the sender compares it with the address it is
 * about to mail.
 */
function addressKey(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(`${ADDRESS_KEY_PREFIX}:${normalized}`).digest('hex').slice(0, 32);
}

/** True when `value` has addressKey's form (32 lower-case hex characters). */
function isAddressKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/**
 * The warm readers as a query: every subscriber the send path would mail whose CURRENT address
 * has an open event in the SendGrid webhook log from `since` through `until` (both inclusive,
 * on the open's own time), so a plan made for a past moment counts only the opens before it,
 * and that SendGrid did not mark as a machine open.
 * Ordered by id; selects the id, the linked customer, the address and the customers behind the
 * mailbox (mailbox_customer_ids), in one snapshot.
 */
function warmAudienceQuery({ since, until }) {
  // Lazy: the sender pulls the whole newsletter stack; the planner loads this only when it runs.
  const db = require('../../models/db');
  const { buildSubscriberQuery, withMailboxCustomers } = require('../newsletter-sender');
  return withMailboxCustomers(buildSubscriberQuery(null)
    // Grouped, so the check is ANDed with every send-path rule before it.
    .where(function openedWavesEmail() {
      this.whereExists(function openEvent() {
        this.select(db.raw('1'))
          .from('sendgrid_webhook_events as opened')
          .where('opened.event_type', 'open')
          .whereRaw('lower(opened.email) = lower(newsletter_subscribers.email)')
          .whereRaw('coalesce(opened.occurred_at, opened.created_at) >= ?', [since])
          .whereRaw('coalesce(opened.occurred_at, opened.created_at) <= ?', [until])
          // An open Apple Mail Privacy Protection made is not a reader. A row logged before the
          // flag was kept (NULL) still counts: nothing tells it apart.
          .whereRaw('opened.machine_open IS NOT TRUE');
      });
    }))
    .orderBy('newsletter_subscribers.id', 'asc');
}

/**
 * The issue's audience as of `asOf`: subscriber ids (ascending) and the counts behind them.
 * Runs the send path's archived-link relink sweep first, as every audience read does.
 * addressKeys holds, by subscriber id, the key of the address that qualified.
 * @returns {Promise<{ subscriberIds: number[], addressKeys: Object<string, string>, counts: { warm: number, heldOut: number, recipients: number } }>}
 */
async function selectIssueAudience({ asOf = new Date() } = {}) {
  const db = require('../../models/db');
  const NewsletterSubscribers = require('../newsletter-subscribers');

  await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);
  const warm = await warmAudienceQuery({ since: new Date(asOf.getTime() - WARM_DAYS * DAY_MS), until: asOf });

  const subscriberIds = [];
  const addressKeys = {};
  let heldOut = 0;
  for (const row of warm) {
    const customers = [row.customer_id, ...(Array.isArray(row.mailbox_customer_ids) ? row.mailbox_customer_ids : [])];
    if (customers.some((customerId) => isHeldOut(customerId))) {
      heldOut += 1;
    } else {
      const id = Number(row.id);
      subscriberIds.push(id);
      addressKeys[id] = addressKey(row.email);
    }
  }
  return { subscriberIds, addressKeys, counts: { warm: warm.length, heldOut, recipients: subscriberIds.length } };
}

/**
 * The segment_filter that makes the send path mail exactly this audience, each reader at the
 * address that qualified, with the holdout checked again at send time.
 */
function audienceSegmentFilter(audience) {
  return { subscriber_ids: [...audience.subscriberIds], holdout: HOLDOUT_NAME, address_keys: { ...audience.addressKeys } };
}

module.exports = {
  isHeldOut, addressKey, isAddressKey, warmAudienceQuery, selectIssueAudience, audienceSegmentFilter,
  WARM_DAYS, HOLDOUT_PERCENT, HOLDOUT_SALT, HOLDOUT_NAME,
};
