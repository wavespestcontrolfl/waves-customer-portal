/**
 * MOVE PROOFREADER — the customer record.
 *
 * Owner 2026-10-05: the dispatch check must read all customer messages for
 * time promises. Owner 2026-10-09 ("proofreader yes"): a model reads the full
 * record before an automatic move. This file builds that record with code, so
 * the model never searches for anything: every stored text, email, call
 * transcript and note for one customer, written before `asOf`, oldest first.
 *
 * Read-only. Each source is read by itself: a source that cannot be read is
 * listed in `unread` (the verdict is then never "allow"), it does not fail
 * the record. A call with a recording and no transcript is unread too.
 *
 * Nothing is cut. A text longer than MAX_ENTRY_CHARS becomes several entries
 * (`split` counts them), each starting a little before the last one ended, so
 * a statement near the end of a long call is still read. Every `at` is an
 * Eastern time with its offset, as the prompt tells the model.
 *
 * `asOf` exists for the replay: a past move is judged on the words that
 * existed before it. The nightly run passes the run's own time.
 *
 * Undated notes (the customer's file notes, the visit's notes) have no
 * written-at time in the database, so they are read as they are NOW, in the
 * replay too. They come first and are marked undated.
 *
 * Access codes and card / SSN numbers never reach a provider
 * (redactAccessCodes).
 */
const logger = require('../../logger');
const { redactAccessCodes } = require('../../context-aggregator');
const { excludeUnresolvedSendReservations } = require('../../messaging/review-ask-reservation');
const { resolveEmailCustomerLink, personSentFilter } = require('../../email/email-customer-link');
const { emailPlainText } = require('../../email/email-strip');
const { etOffsetIso } = require('../../../utils/datetime-et');

// One entry's longest text. A longer one is split into parts, never cut
// (Codex #6258 r1: a restriction near the end of a long call was dropped).
const MAX_ENTRY_CHARS = 12000;
// Each part repeats this much of the part before it, so a statement that
// falls on a boundary is whole in one of the two.
const PART_OVERLAP_CHARS = 600;
// The whole record's limit. Past it no model is asked and the verdict is
// "unknown" (measured 2026-10-09 over 112 customers: median 6k, max 56k).
const MAX_RECORD_CHARS = 300000;

// Our own interaction rows that only repeat a text or an email already read
// from its source table.
const INTERACTION_COPIES = ['sms_outbound', 'email_outbound'];
// reschedule_log rows written by code: their notes are program text.
const PROGRAM_RESCHEDULERS = ['system', 'auto_dispatch'];

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
// Eastern wall time with its offset: the prompt says every time is Eastern,
// so "this Friday" in an evening text is read against the right day.
const eastern = (value) => (value ? etOffsetIso(value) : null);
const msOf = (value) => (value ? new Date(value).getTime() : null);

function partsOf(body) {
  if (body.length <= MAX_ENTRY_CHARS) return [body];
  const parts = [];
  for (let from = 0; from < body.length; from += MAX_ENTRY_CHARS - PART_OVERLAP_CHARS) {
    parts.push(body.slice(from, from + MAX_ENTRY_CHARS));
    if (from + MAX_ENTRY_CHARS >= body.length) break;
  }
  return parts;
}

// The entries of one stored text: one, or its parts when it is long. `ms`
// (sort key) and `split` are dropped before the record is returned.
function entry(channel, from, at, text) {
  const body = redactAccessCodes(clean(text));
  if (!body) return [];
  const parts = partsOf(body);
  return parts.map((part, i) => ({
    channel, from, at: eastern(at), ms: msOf(at), text: parts.length > 1 ? `[part ${i + 1} of ${parts.length}] ${part}` : part, ...(parts.length > 1 && i > 0 ? { split: true } : {}),
  }));
}

async function readTexts(conn, { customerId, asOf }) {
  const rows = await excludeUnresolvedSendReservations(conn('sms_log'))
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    .whereNotNull('message_body')
    // Only a text that reached the customer can have promised anything.
    .where(function reached() { this.where('direction', 'inbound').orWhereIn('status', ['sent', 'delivered']); })
    .orderBy('created_at')
    .select('direction', 'message_body', 'message_type', 'admin_user_id', 'created_at');
  return rows.map((row) => {
    const person = row.message_type === 'manual' || !!row.admin_user_id;
    const from = row.direction === 'inbound' ? 'customer' : (person ? 'staff' : 'system');
    return entry('text', from, row.created_at, row.message_body);
  });
}

// Mail the sync linked to the customer, plus our own replies. A sent mail is
// stored with no customer (measured 2026-10-09: 3,062 sent mails, none
// linked), so each unlinked SENT mail (personSentFilter: never a draft) of
// the customer's threads, or one that names the customer's address, is put
// to the ONE linkage rule the mail lanes share (email-customer-link.js: To,
// Cc and Bcc parsed as addresses; a mixed thread or a second customer among
// the recipients links to nobody). Only a mail that rule gives to this
// customer is read (Codex #6258 r1).
//
// A mail synced before Cc/Bcc were captured cannot be linked by that rule
// (who else it reached is unknown), and it is not guessed here (r2). When
// such a mail sits in one of the customer's own threads it is very likely
// our reply (196 of the 211 unlinked mails in customer threads, 2026-10-09),
// so the record says it could not read it: the verdict is then never allow.
//
// The body is the shared reader's (email-strip.js emailPlainText): an
// HTML-only mail is converted, never replaced by Gmail's short snippet.
async function readEmails(conn, { customerId, asOf, customerEmail }, unread) {
  const columns = ['id', 'gmail_thread_id', 'customer_id', 'from_address', 'to_address', 'cc_address', 'bcc_address', 'subject', 'body_text', 'body_html', 'snippet', 'received_at'];
  const live = (query) => query.where('received_at', '<', asOf).whereNull('quarantined_at')
    .whereRaw("COALESCE(classification, '') <> 'spam'");
  const linked = await live(conn('emails').where({ customer_id: customerId })).select(columns);
  const threads = new Set(linked.map((row) => row.gmail_thread_id).filter(Boolean));
  const address = clean(customerEmail).toLowerCase();
  let candidates = [];
  if (threads.size || address) {
    candidates = await live(conn('emails').whereNull('customer_id')).whereRaw(personSentFilter('emails'))
      .where(function ours() {
        if (threads.size) this.whereIn('gmail_thread_id', [...threads]);
        // A coarse pre-filter only; resolveEmailCustomerLink decides.
        if (address) this.orWhereRaw("position(? in lower(concat_ws(' ', to_address, cc_address, bcc_address))) > 0", [address]);
      })
      .select(columns);
  }
  const replies = [];
  for (const row of candidates) {
    if (row.cc_address == null || row.bcc_address == null) {
      if (threads.has(row.gmail_thread_id)) unread.push({ channel: 'email', at: eastern(row.received_at), reason: 'recipients_not_captured' });
      continue;
    }
    const owner = await resolveEmailCustomerLink(conn, row);
    if (owner != null && String(owner) === String(customerId)) replies.push(row);
  }
  const mail = (row, from) => {
    const body = clean(emailPlainText(row));
    return entry('email', from, row.received_at, body ? `${clean(row.subject)}: ${body}` : '');
  };
  return [...linked.map((row) => mail(row, 'customer')), ...replies.map((row) => mail(row, 'staff'))];
}

async function readCalls(conn, { customerId, asOf }, unread) {
  const rows = await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    .whereRaw("COALESCE(processing_status, '') <> 'spam'")
    .select('direction', 'transcription', 'recording_sid', 'created_at');
  return rows.map((row) => {
    const said = entry('call', 'both', row.created_at, row.transcription);
    // A recording nobody has turned into words yet: the record is incomplete.
    if (!said.length && row.recording_sid) unread.push({ channel: 'call', at: eastern(row.created_at), reason: 'not_transcribed' });
    return said;
  });
}

async function readInteractions(conn, { customerId, asOf }) {
  const rows = await conn('customer_interactions')
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    .whereNotIn('interaction_type', INTERACTION_COPIES)
    .select('interaction_type', 'subject', 'body', 'created_at');
  return rows.map((row) => entry(
    'note', row.interaction_type === 'service_request' ? 'customer' : 'staff', row.created_at,
    clean(row.body) ? [clean(row.subject), clean(row.body)].filter(Boolean).join(': ') : '',
  ));
}

async function readStaffNotes(conn, { customerId, asOf }) {
  const rows = await conn('admin_notes').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('note_text', 'created_at');
  return rows.map((row) => entry('note', 'staff', row.created_at, row.note_text));
}

async function readTechNotes(conn, { customerId, asOf }) {
  const rows = await conn('service_records').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('technician_notes', 'created_at');
  return rows.map((row) => entry('technician_note', 'staff', row.created_at, row.technician_notes));
}

// The offer row is written when the offer is sent; the customer's reply
// lands on it later, at sms_responded_at. Each is bounded by its own time
// (Codex #6258 r1: a replay read replies that did not exist yet).
async function readRescheduleReplies(conn, { customerId, asOf }) {
  const rows = await conn('reschedule_log').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('initiated_by', 'customer_response_text', 'sms_responded_at', 'notes', 'created_at');
  const before = (at) => !!at && new Date(at).getTime() < new Date(asOf).getTime();
  return rows.flatMap((row) => [
    before(row.sms_responded_at) ? entry('reschedule_reply', 'customer', row.sms_responded_at, row.customer_response_text) : [],
    PROGRAM_RESCHEDULERS.includes(row.initiated_by) ? [] : entry('note', 'staff', row.created_at, row.notes),
  ]);
}

// What the customer wrote in the portal's request form ("schedule_change"
// is one of its categories). These rows are not copied anywhere else. An
// open request can be revised in place (routes/schedule.js appends to it and
// stamps updated_at), so a request changed at or after `asOf` is not the text
// that existed then: it is unread, not read (Codex #6258 r2). The nightly
// run passes its own time, so nothing is ever "later" there.
async function readPortalRequests(conn, { customerId, asOf }, unread) {
  const rows = await conn('service_requests').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('category', 'subject', 'description', 'created_at', 'updated_at');
  return rows.map((row) => {
    if (row.updated_at && new Date(row.updated_at).getTime() >= new Date(asOf).getTime()) {
      unread.push({ channel: 'portal_request', at: eastern(row.created_at), reason: 'revised_later' });
      return [];
    }
    return entry(
      'portal_request', 'customer', row.created_at,
      [clean(row.category), clean(row.subject), clean(row.description)].filter(Boolean).join(': '),
    );
  });
}

// What the customer told the portal assistant, and what it answered. A
// signed-in chat is stored only here (agent_messages under the customer's
// agent_sessions); the text channel's turns are in sms_log already.
async function readAssistantChat(conn, { customerId, asOf }) {
  const rows = await conn('agent_messages')
    .join('agent_sessions', 'agent_sessions.id', 'agent_messages.conversation_id')
    .where('agent_sessions.customer_id', customerId)
    .where('agent_messages.created_at', '<', asOf)
    .whereIn('agent_messages.role', ['user', 'assistant'])
    .whereRaw("COALESCE(agent_sessions.channel, '') <> 'sms'")
    .select('agent_messages.role', 'agent_messages.content', 'agent_messages.created_at');
  return rows.map((row) => entry('portal_chat', row.role === 'user' ? 'customer' : 'system', row.created_at, row.content));
}

// The customer's file notes and the notes on the visit and its series.
async function readUndatedNotes(conn, { customer, serviceId }) {
  const out = [
    entry('customer_file_note', 'staff', null, customer && customer.crm_notes),
    entry('customer_file_note', 'staff', null, customer && customer.internal_notes),
    entry('customer_file_note', 'staff', null, customer && customer.follow_up_notes),
    entry('customer_file_note', 'staff', null, customer && customer.access_notes),
  ];
  if (!serviceId) return out;
  const visit = await conn('scheduled_services').where({ id: serviceId }).first('id', 'recurring_parent_id');
  if (!visit) return out;
  const parentId = visit.recurring_parent_id || visit.id;
  const series = await conn('scheduled_services')
    .where(function sameSeries() { this.where('id', parentId).orWhere('recurring_parent_id', parentId); })
    .select('notes', 'internal_notes');
  const texts = new Set();
  for (const row of series) for (const text of [row.notes, row.internal_notes]) if (clean(text)) texts.add(clean(text));
  return out.concat([...texts].map((text) => entry('visit_note', 'staff', null, text)));
}

const SOURCES = [
  ['text', readTexts], ['email', readEmails], ['call', readCalls], ['note', readInteractions],
  ['note', readStaffNotes], ['technician_note', readTechNotes], ['reschedule_reply', readRescheduleReplies],
  ['portal_request', readPortalRequests], ['portal_chat', readAssistantChat], ['customer_file_note', readUndatedNotes],
];

/**
 * @returns {{ entries: Array<{id,channel,from,at,text}>, unread: Array<{channel,at?,reason}>, split: number, chars: number, tooLong: boolean }}
 */
async function buildCustomerRecord(conn, { customerId, serviceId = null, asOf = new Date() }) {
  const unread = [];
  const found = [];
  let customer = null;
  try {
    customer = await conn('customers').where({ id: customerId })
      .first('email', 'crm_notes', 'internal_notes', 'follow_up_notes', 'access_notes');
  } catch (err) {
    logger.warn(`[auto-dispatch] proofreader could not read the customer file: ${err.message}`);
  }
  // No customer row: its notes and its mail address are both unread.
  if (!customer) unread.push({ channel: 'customer_file_note', reason: 'read_failed' });
  const args = {
    customerId, serviceId, asOf, customer, customerEmail: customer && customer.email,
  };
  for (const [channel, read] of SOURCES) {
    try {
      found.push(...(await read(conn, args, unread)).flat(2));
    } catch (err) {
      unread.push({ channel, reason: 'read_failed' });
      logger.warn(`[auto-dispatch] proofreader could not read ${channel}: ${err.message}`);
    }
  }
  // Undated notes first, then oldest to newest.
  found.sort((a, b) => (a.ms ?? -1) - (b.ms ?? -1));
  const entries = found.map(({ split: _split, ms: _ms, ...rest }, i) => ({ id: `E${i + 1}`, ...rest }));
  const chars = entries.reduce((sum, row) => sum + row.text.length, 0);
  return {
    entries, unread, split: found.filter((row) => row.split).length, chars, tooLong: chars > MAX_RECORD_CHARS,
  };
}

module.exports = { buildCustomerRecord, MAX_ENTRY_CHARS, MAX_RECORD_CHARS };
