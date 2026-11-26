/**
 * The warm readers: the part of the list that opened a Waves email in the last 90 days.
 *
 * Shared by the Waves Pest Insider planner (pest-insider/audience.js) and the weekly events
 * email's first-readers step (newsletter-weekly-audience.js). A new email stream, or one that
 * went silent for a long time, starts with these readers so the first issues go to people who
 * read Waves mail. The opens come from the SendGrid webhook's event log
 * (sendgrid_webhook_events), which keeps one row for every event on a tracked Waves email: a
 * Waves newsletter, an automation step, a template message. So a repeat open counts (the
 * delivery and message rows keep only the FIRST open), and the open belongs to the address that
 * opened it: an open by a former address, before an address correction, never qualifies the new
 * one. The window is on the open's own time (occurred_at, SendGrid's event timestamp); a row
 * logged before that column existed uses the time the webhook logged it. An open SendGrid marks
 * as a machine open (sg_machine_open: Apple Mail Privacy Protection fetched the email, whether
 * or not a person read it) never qualifies; a row logged before that flag was kept has none and
 * still counts, as nothing tells it apart.
 *
 * A planned audience keeps, for each reader, a key of the address that qualified (addressKey),
 * and the sender mails a reader only at that address: if the subscriber's address changes before
 * the send, on a first send or a resume, that reader is skipped.
 */
'use strict';

const crypto = require('crypto');

const WARM_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// Changing the prefix gives every address a new key: a queued issue would then skip everyone.
const ADDRESS_KEY_PREFIX = 'waves-pest-insider-address-v1';

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
  const db = require('../models/db');
  const { buildSubscriberQuery, withMailboxCustomers } = require('./newsletter-sender');
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

module.exports = { WARM_DAYS, DAY_MS, addressKey, isAddressKey, warmAudienceQuery };
