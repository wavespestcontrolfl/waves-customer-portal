/**
 * Witnesses for the customer-contact classes of admin-alert-relevance.js
 * (GATE_ALERT_CONTACT_CLOSE; owner 2026-10-24: "most of these should close
 * automatically ... text sent, agent confirms resolved, appt booked,
 * rescheduled"). A bell about a customer reaching out is done once a person
 * answered. Every "it was handled" fact below is the repo's existing
 * definition, read here and never re-derived:
 *   - a text that needs no (more) reply: loadPendingSmsConversations
 *     (sms-pending-conversations.js, the Messages badge and Unanswered filter:
 *     it already counts a person's reply, a person's call after the text and a
 *     courtesy text);
 *   - a text a person sent: operatorReplySql + smsDeliveredSql
 *     (staff-contact.js), minus a proactive draft (call-commitments.js
 *     withoutProactiveDraft), the call-contact check's own text witness;
 *   - a call a person placed and spoke on: personCallBackSql (staff-contact.js);
 *     every call is judged by when it ENDED (callEndedAtSql, the Messages
 *     reader's definition): a row inserted after the call was over and carrying
 *     no end stamp from Twilio has no trustworthy end and counts for nothing;
 *     an inbound call a human answered: answered_by = 'human', as the Messages
 *     reader reads it. Never a bare call_log row, bridged_at or a duration;
 *   - a quote that reached the customer: handedOffWithin +
 *     whereEstimateCustomerOwnership (call-commitments.js), never sent_at;
 *   - a visit booked: the new-lead class's live top-level visit predicate,
 *     passed in as `bookedVisits`;
 *   - an email a person answered: a Gmail SENT row in the customer's thread
 *     (personSentFilter + resolveEmailCustomerLink, email-customer-link.js).
 * read_at is never evidence. Read-only: nothing here writes, locks or sends.
 *
 * Each item is judged only by events AFTER its own anchor: the text, call or
 * email the bell is about (its own time), else the bell's. Callers pass plain
 * references (ids, a phone); this module knows no notification metadata shape.
 */

const { phoneIdentityKey } = require('../utils/phone');
const { callStartedAt } = require('../utils/call-timeline');
const { phoneIdentitySql } = require('./sms-response-policy');
const { operatorReplySql, smsDeliveredSql, personCallBackSql } = require('./staff-contact');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { personSentFilter, resolveEmailCustomerLink } = require('./email/email-customer-link');

const DAY_MS = 24 * 60 * 60 * 1000;
const asDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const later = (a, b) => (!b || (a && a.getTime() >= b.getTime()) ? a : b);
const unique = (list) => [...new Set(list.filter(Boolean))];

// The newest time among grouped witness rows ({customer_id, peer, at}) that
// name this item by customer or by phone identity.
function latestFor(rows, item) {
  let best = null;
  for (const row of rows) {
    const byCustomer = !!item.customerId && !!row.customer_id && String(row.customer_id) === item.customerId;
    const byPhone = !!row.peer && item.peers.has(row.peer);
    if (byCustomer || byPhone) best = later(best, asDate(row.at));
  }
  return best;
}

// WHERE (customer_id IN ids OR peer = ANY peers) over the given columns.
function whereIdentity(query, customerColumn, peerSql, customerIds, peers) {
  return query.where((w) => {
    if (customerIds.length) w.whereIn(customerColumn, customerIds);
    if (peers.length) w.orWhereRaw(`${peerSql} = ANY(?)`, [peers]);
  });
}

// The inbound text each sms item is about: its message (canonical unified row
// first, the legacy sms_log row beside it), giving the sender's phone, the
// customer and the time it arrived.
async function resolveTexts(conn, sids) {
  const found = new Map();
  if (!sids.length) return found;
  const add = (sid, row, phone) => {
    const at = asDate(row.created_at);
    const entry = found.get(sid) || { at: null, customerId: null, phones: [] };
    if (at && (!entry.at || at.getTime() < entry.at.getTime())) entry.at = at;
    if (row.customer_id && !entry.customerId) entry.customerId = String(row.customer_id);
    if (phone) entry.phones.push(phone);
    found.set(sid, entry);
  };
  const canonical = await conn('messages as m').join('conversations as c', 'c.id', 'm.conversation_id')
    .where('m.channel', 'sms').where('m.direction', 'inbound').whereIn('m.twilio_sid', sids)
    .select('m.twilio_sid', 'm.created_at', 'c.customer_id',
      conn.raw("COALESCE(NULLIF(m.metadata->>'sms_contact_phone', ''), NULLIF(c.contact_phone, '')) as phone"));
  for (const row of canonical) add(String(row.twilio_sid), row, row.phone);
  // The shared reservation filter (sms-log-general-reader-source-guard): an inbound row by its own sid is never a
  // send reservation, so it changes nothing here; it keeps this reader on the one definition.
  const legacy = await excludeUnresolvedSendReservations(conn('sms_log').where('direction', 'inbound').whereIn('twilio_sid', sids))
    .select('twilio_sid', 'created_at', 'customer_id', 'from_phone');
  for (const row of legacy) add(String(row.twilio_sid), row, row.from_phone);
  return found;
}

// Who and when, per kind of item: the customer, the phones and the anchor, or
// null when the subject is not on file (its text or email is missing).
const SUBJECT_OF = {
  sms: ({ refs }, { texts }) => {
    const text = refs.sid ? texts.get(String(refs.sid)) : null;
    return text && text.at ? { anchor: text.at, customerId: text.customerId, phones: text.phones } : null;
  },
  voice: ({ refs }, { calls }) => {
    const call = refs.callLogId ? calls.get(String(refs.callLogId)) : null;
    return {
      // When the customer placed the call (call-timeline.js callStartedAt): a row
      // inserted after the call was over carries a post-call created_at.
      anchor: call ? callStartedAt(call) : null,
      customerId: call?.customer_id ? String(call.customer_id) : null,
      phones: [call?.direction === 'inbound' ? call.from_phone : null, refs.phone],
    };
  },
  email: ({ refs }, { emails }) => {
    const email = refs.emailId ? emails.get(String(refs.emailId)) : null;
    return email ? { anchor: asDate(email.received_at), customerId: email.customer_id ? String(email.customer_id) : null, phones: [], email } : null;
  },
  lead: ({ refs }) => ({ anchor: null, customerId: null, phones: [refs.phone] }),
};

// An item that cannot be identified is dropped: unknown, never judged.
function identify(item, lookups) {
  const found = SUBJECT_OF[item.kind](item, lookups);
  if (!found) return null;
  const customerId = item.refs.customerId || found.customerId || null;
  const anchor = found.anchor || item.bellAt;
  const peers = new Set(found.phones.map((p) => phoneIdentityKey(p)).filter(Boolean));
  if (!anchor || (!customerId && !peers.size)) return null;
  return { item, customerId, peers, anchor, email: found.email || null };
}

// What a person did, newest per customer / phone, after `since`: texts, calls
// they placed and spoke on, and calls in that a human answered.
async function personWitnesses(conn, { customerIds, peers, since }) {
  if (!customerIds.length && !peers.length) return { textRows: [], backRows: [], inRows: [] };
  const { withoutProactiveDraft } = require('./call-commitments');
  const textPeer = phoneIdentitySql('os.to_phone');
  const textRows = await whereIdentity(
    excludeUnresolvedSendReservations(conn('sms_log as os').where('os.direction', 'outbound'), 'os')
      .whereRaw(operatorReplySql('os')).whereRaw(smsDeliveredSql('os'))
      .modify(withoutProactiveDraft).where('os.created_at', '>', since),
    'os.customer_id', textPeer, customerIds, peers,
  ).select('os.customer_id', conn.raw(`${textPeer} as peer`)).max('os.created_at as at').groupByRaw('1, 2');
  // A call is judged by when it ENDED (the Messages reader's definition,
  // callEndedAtSql): a row inserted after the call was over (recovered or
  // status-callback rows) says nothing about when it happened, so without
  // Twilio's own end stamp it has no end and counts for nothing. The created_at
  // bound is only a prefilter for the index (no call runs a day).
  const { callEndedAtSql } = require('./sms-pending-conversations');
  const endedAt = callEndedAtSql('cl');
  const callQuery = (direction, peerColumn) => {
    const peerSql = phoneIdentitySql(peerColumn);
    return whereIdentity(
      conn('call_log as cl').where('cl.direction', direction).where('cl.status', 'completed')
        .modify((q) => whereNotSandboxCall(q, 'cl.source'))
        .where('cl.created_at', '>', new Date(since.getTime() - DAY_MS))
        .whereRaw(`${endedAt} > ?`, [since]),
      'cl.customer_id', peerSql, customerIds, peers,
    ).select('cl.customer_id', conn.raw(`${peerSql} as peer`), conn.raw(`MAX(${endedAt}) as at`)).groupByRaw('1, 2');
  };
  const backRows = await callQuery('outbound', 'cl.to_phone').whereRaw(personCallBackSql('cl'));
  const inRows = await callQuery('inbound', 'cl.from_phone').where('cl.answered_by', 'human');
  return { textRows, backRows, inRows };
}

// A quote handed off to the customer after the event: the promise lane's own
// witness. One small query per item, only for the call and email bells and
// only while nothing cheaper has settled the item.
async function quoteHandedOff(conn, ident, bundle) {
  const { item, customerId, anchor } = ident;
  if (!customerId || (item.kind !== 'voice' && item.kind !== 'email')) return false;
  const settled = [bundle.textAt, bundle.backAt, bundle.inAt, bundle.visitAt].some((at) => at && at.getTime() > anchor.getTime());
  if (settled) return false;
  const { handedOffWithin, whereEstimateCustomerOwnership } = require('./call-commitments');
  return !!(await whereEstimateCustomerOwnership(handedOffWithin(conn('estimates'), anchor), customerId).first('estimates.id'));
}

// An email a person answered: a Gmail SENT row in its thread that reaches the customer.
async function attachEmailReplies(conn, idents, bundles) {
  const emailIdents = idents.filter((i) => i.item.kind === 'email' && i.customerId && i.email?.gmail_thread_id);
  if (!emailIdents.length) return;
  const sent = await conn('emails as er').whereRaw(personSentFilter('er'))
    .whereIn('er.gmail_thread_id', unique(emailIdents.map((i) => i.email.gmail_thread_id)))
    .select('er.id', 'er.gmail_thread_id', 'er.to_address', 'er.cc_address', 'er.bcc_address', 'er.received_at');
  for (const row of sent) {
    const at = asDate(row.received_at);
    const owners = emailIdents.filter((i) => i.email.gmail_thread_id === row.gmail_thread_id && at && at.getTime() > i.anchor.getTime());
    if (!owners.length) continue;
    const linked = await resolveEmailCustomerLink(conn, row);
    for (const owner of owners.filter((o) => String(linked) === o.customerId)) {
      const bundle = bundles.get(String(owner.item.id));
      bundle.replyAt = later(bundle.replyAt, at);
    }
  }
}

/**
 * @param {Array<{id, kind: 'sms'|'voice'|'email'|'lead', bellAt: Date|null, refs: object}>} items
 *   refs by kind: sms {sid, customerId}; voice {callLogId, customerId, phone};
 *   email {emailId, customerId}; lead {customerId, phone}.
 * @param {{conn, bookedVisits: (customerIds: string[]) => Promise<Map>}} deps
 * @returns {Promise<Map<string, object>>} notification id -> bundle
 *   { anchor, pending (sms), textAt, backAt, inAt, visitAt, quote, replyAt };
 *   an item whose subject cannot be identified is absent (never judged).
 */
async function loadContactBundles(items, { conn, bookedVisits }) {
  const bundles = new Map();
  if (!items.length) return bundles;

  const byIds = async (table, ids, columns) => new Map((ids.length ? await conn(table).whereIn('id', ids).select(...columns) : []).map((r) => [String(r.id), r]));
  const lookups = {
    texts: await resolveTexts(conn, unique(items.filter((i) => i.kind === 'sms').map((i) => i.refs.sid))),
    calls: await byIds('call_log', unique(items.filter((i) => i.kind === 'voice').map((i) => i.refs.callLogId)), ['id', 'created_at', 'customer_id', 'from_phone', 'direction', 'metadata', 'duration_seconds', 'recording_duration_seconds']),
    emails: await byIds('emails', unique(items.filter((i) => i.kind === 'email').map((i) => i.refs.emailId)), ['id', 'gmail_thread_id', 'received_at', 'customer_id']),
  };
  const idents = items.map((item) => identify(item, lookups)).filter(Boolean);
  if (!idents.length) return bundles;

  // A known customer's own phone also names them (a text or call that carries no customer id).
  const customerIds = unique(idents.map((i) => i.customerId));
  if (customerIds.length) {
    const owners = await conn('customers').whereIn('id', customerIds).whereNull('deleted_at').select('id', 'phone');
    for (const owner of owners) {
      const peer = phoneIdentityKey(owner.phone);
      if (peer) idents.filter((i) => i.customerId === String(owner.id)).forEach((i) => i.peers.add(peer));
    }
  }
  const peers = unique(idents.flatMap((i) => [...i.peers]));
  const since = new Date(Math.min(...idents.map((i) => i.anchor.getTime())));

  // The Messages reader's own list of texts still waiting for a reply.
  let pendingPeers = new Set();
  const smsIdents = idents.filter((i) => i.item.kind === 'sms');
  if (smsIdents.length) {
    const { loadPendingSmsConversations } = require('./sms-pending-conversations');
    const sinceSms = new Date(Math.min(...smsIdents.map((i) => i.anchor.getTime())) - 1000);
    const pending = await loadPendingSmsConversations({ includeLegacyOnly: true, since: sinceSms.toISOString() });
    pendingPeers = new Set(pending.map((row) => row.peer));
  }

  const { textRows, backRows, inRows } = await personWitnesses(conn, { customerIds, peers, since });
  const visits = await bookedVisits(customerIds);
  for (const ident of idents) {
    const { item, customerId } = ident;
    const bundle = {
      anchor: ident.anchor,
      pending: item.kind === 'sms' ? [...ident.peers].some((peer) => pendingPeers.has(peer)) : null,
      textAt: latestFor(textRows, ident),
      backAt: latestFor(backRows, ident),
      inAt: latestFor(inRows, ident),
      visitAt: customerId ? asDate(visits.get(customerId)) : null,
      quote: false,
      replyAt: null,
    };
    bundle.quote = await quoteHandedOff(conn, ident, bundle);
    bundles.set(String(item.id), bundle);
  }
  await attachEmailReplies(conn, idents, bundles);
  return bundles;
}

module.exports = { loadContactBundles };
