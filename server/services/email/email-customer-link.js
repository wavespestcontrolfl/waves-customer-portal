'use strict';

// Shared customer-linkage helper for a Gmail SENT row (a person's reply, not
// an automated send — email-sync.js never classifies or links these at sync
// time; see upsertEmail's outbound branch). Used by BOTH email-operational-
// actions.js (intake: is this SENT row a staff promise, and to whom?) and
// sms-commitment-fulfillment.js's evidence loader (is this SENT row a
// person's reply to THIS customer's ask?) so the linkage rule has exactly
// one definition (coordinator correction #2, 2026-09-29).
//
// A SENT row belongs to a customer when EITHER:
//   (a) its gmail_thread_id has an inbound row already linked to that
//       customer (the sync's own from_address match, run at insert time for
//       every INBOUND row) — the normal case, since both real send paths
//       (admin Email tab, the Intelligence Bar's approved sendEmailReply)
//       reply into the SAME Gmail thread as the customer's own message; or
//   (b) its to_address equals — case/trim-insensitive — exactly one active
//       customer's own email (customers.email is UNIQUE, so this can only
//       be ambiguous if a thread mixes customers, never from the email
//       column itself).
// Either branch returning more than one distinct customer is ambiguous and
// resolves to NO customer — never a guess.
//
// SEO outreach (server/services/seo/link-prospect-outreach.js) also sends
// SENT rows, but to prospects' own domains, which are neither threaded with
// a customer's inbound mail nor equal to any active customer's email — this
// linkage rule excludes them by construction, with no separate marker
// needed (design note §1, and coordinator correction #1).
function personSentFilter(alias) {
  // label_ids is stored as a JSON array of Gmail label strings (email-
  // sync.js upsertEmail). SENT + INBOX is a self-addressed control message,
  // which the sync itself keeps classified as ordinary inbound mail — this
  // filter matches that same carve-out (email-sync.js:395-403) so a self-
  // addressed row is never read as a person's reply here either.
  // jsonb_exists(), not the `?` operator: knex's own raw-query placeholder
  // syntax also uses `?`, so a literal `?` in whereRaw collides with it.
  return `jsonb_exists(${alias}.label_ids::jsonb, 'SENT') AND NOT jsonb_exists(${alias}.label_ids::jsonb, 'INBOX')`;
}

// Gmail's own to_address column is the raw header VALUE, never a bare
// address — "Jamie Fixture <jamie@example.invalid>", or a comma-separated
// list for multiple recipients (owner diagnostic, 2026-09-29: 23 SENT rows
// to gmail.com resolved to no one because of this — the raw value was
// compared directly against customers.email). Pull every email-shaped
// substring out, regardless of a display name or how many recipients —
// this also naturally ignores a display name that happens to contain a
// comma ("Fixture, Jamie <jamie@example.invalid>").
function extractEmailAddresses(raw) {
  const matches = String(raw || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  return [...new Set(matches.map((a) => a.toLowerCase()))];
}

// A send in the customer's thread counts as reaching THAT customer only
// when its own recipients prove it: some to_address is the customer's email
// or an address the customer wrote to us from in this thread, and none is
// another active customer's email. Forwarding the thread internally, or
// replying to someone else on it, never closes the customer's ask
// (pre-push audit, 2026-09-30).
async function threadSendReachesCustomer(conn, row, customerId) {
  const toAddresses = extractEmailAddresses(row.to_address);
  if (!toAddresses.length) return false;
  const customer = await conn('customers').where({ id: customerId }).whereNull('deleted_at').first('email');
  if (!customer) return false;
  const inboundFrom = await conn('emails')
    .where({ gmail_thread_id: row.gmail_thread_id, customer_id: customerId })
    .whereNotNull('from_address').pluck('from_address');
  const customerAddresses = new Set([customer.email, ...inboundFrom].flatMap(extractEmailAddresses));
  if (!toAddresses.some((a) => customerAddresses.has(a))) return false;
  const others = await conn('customers').whereNull('deleted_at').whereNotNull('email')
    .whereNot('id', customerId)
    .whereIn(conn.raw('LOWER(TRIM(email))'), toAddresses).first('id');
  return !others;
}

async function resolveEmailCustomerLink(conn, row) {
  if (!row?.gmail_thread_id && !row?.to_address) return null;
  if (row.gmail_thread_id) {
    const threadCustomers = await conn('emails')
      .where({ gmail_thread_id: row.gmail_thread_id })
      .whereNotNull('customer_id')
      .modify((q) => { if (row.id) q.whereNot('id', row.id); })
      .distinct('customer_id').pluck('customer_id');
    if (threadCustomers.length > 1) return null; // a mixed thread never guesses
    if (threadCustomers.length === 1) {
      return (await threadSendReachesCustomer(conn, row, threadCustomers[0])) ? threadCustomers[0] : null;
    }
  }
  const toAddresses = extractEmailAddresses(row.to_address);
  if (!toAddresses.length) return null;
  // Multiple recipients: resolve only when the addresses collectively name
  // exactly one distinct active customer — never "the first one," and
  // never guess between two different customers on the same send.
  const matches = await conn('customers').whereNull('deleted_at').whereNotNull('email')
    .whereIn(conn.raw('LOWER(TRIM(email))'), toAddresses).pluck('id');
  const distinct = [...new Set(matches)];
  return distinct.length === 1 ? distinct[0] : null;
}

module.exports = { personSentFilter, resolveEmailCustomerLink, extractEmailAddresses };
