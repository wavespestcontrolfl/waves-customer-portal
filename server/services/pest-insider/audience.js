/**
 * Who gets a Waves Pest Insider issue.
 *
 * Warm phase: a new email stream starts with the readers whose mailbox opened a Waves email
 * in the last 90 days (the rule, and the SendGrid open-event details behind it, live in
 * services/newsletter-warm-audience.js, which the weekly events email shares). A later phase
 * widens this to every opted-in reader.
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
const { WARM_DAYS, DAY_MS, addressKey, isAddressKey, warmAudienceQuery } = require('../newsletter-warm-audience');

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
