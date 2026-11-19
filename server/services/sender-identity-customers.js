/**
 * The live customers a texting phone belongs to, by ONE shared rule.
 *
 * Text-origin estimator bells are about a sender identified by
 * `phoneIdentityKey` (utils/phone.js: a NANP number is its 10 digits, any other
 * country `+<digits>`), whose SQL twin is `phoneIdentitySql`
 * (sms-response-policy.js). The bell emitter names the sender with it, and the
 * relevance sweep judges the bell with it, so the two can never disagree about
 * who a number belongs to. Matching on the last 10 digits alone would let an
 * international sender collide with a US customer who shares them.
 *
 * A customer belongs to an identity when the identity is on its phone or on any
 * of its three service-contact phones (a number that is primary on one account
 * and a service contact on another is shared there), or when a live lead with
 * that phone points at it. The customer must be live (not soft-deleted).
 */
const db = require('../models/db');

const PHONE_COLUMNS = ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'];

// identity list -> Map(identity -> Set of live customer ids). `timeoutMs`, when
// given, cancels each query that runs longer (the awaited webhook phase).
async function customerIdsBySenderIdentity(conn, identities, { timeoutMs = null } = {}) {
  const { phoneIdentitySql } = require('./sms-response-policy');
  const handle = conn || db;
  const bounded = (q) => (timeoutMs ? q.timeout(timeoutMs, { cancel: true }) : q);
  const peers = new Map(identities.map((d) => [d, new Set()]));
  const tie = (peer, id) => { if (id && peers.has(peer)) peers.get(peer).add(String(id)); };
  const identity = (column) => phoneIdentitySql(`customers.${column}`);
  for (const c of await bounded(handle('customers').whereNull('deleted_at')
    .whereRaw(`(${PHONE_COLUMNS.map((column) => `${identity(column)} = ANY(?)`).join(' OR ')})`, PHONE_COLUMNS.map(() => identities))
    .select('id', handle.raw(`ARRAY[${PHONE_COLUMNS.map(identity).join(', ')}]::text[] as peers`)))) {
    for (const peer of new Set(c.peers || [])) tie(peer, c.id);
  }
  const leads = await bounded(handle('leads').whereNull('deleted_at').whereNotNull('customer_id').whereRaw(`${phoneIdentitySql('leads.phone')} = ANY(?)`, [identities])
    .select('customer_id', handle.raw(`${phoneIdentitySql('leads.phone')} as peer`)));
  const leadCustomerIds = [...new Set(leads.map((l) => String(l.customer_id)))];
  const live = new Set(leadCustomerIds.length
    ? (await bounded(handle('customers').whereIn('id', leadCustomerIds).whereNull('deleted_at').select('id'))).map((c) => String(c.id))
    : []);
  for (const l of leads) if (live.has(String(l.customer_id))) tie(l.peer, l.customer_id);
  return peers;
}

module.exports = { customerIdsBySenderIdentity, PHONE_COLUMNS };
