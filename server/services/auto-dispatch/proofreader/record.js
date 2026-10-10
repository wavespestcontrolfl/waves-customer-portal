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

// One entry's longest text. An email body past this is almost always the
// quoted thread, whose messages are entries of their own; a cut is counted.
const MAX_ENTRY_CHARS = 12000;
// The whole record's limit. Past it no model is asked and the verdict is
// "unknown" (measured 2026-10-09 over 112 customers: median 6k, max 56k).
const MAX_RECORD_CHARS = 300000;

// Our own interaction rows that only repeat a text or an email already read
// from its source table.
const INTERACTION_COPIES = ['sms_outbound', 'email_outbound'];
// reschedule_log rows written by code: their notes are program text.
const PROGRAM_RESCHEDULERS = ['system', 'auto_dispatch'];

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
const iso = (value) => (value ? new Date(value).toISOString() : null);

function entry(channel, from, at, text) {
  const body = redactAccessCodes(clean(text));
  if (!body) return null;
  const cut = body.length > MAX_ENTRY_CHARS;
  return {
    channel, from, at: iso(at), text: cut ? `${body.slice(0, MAX_ENTRY_CHARS)} [cut]` : body, ...(cut ? { cut: true } : {}),
  };
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

// Mail the sync linked to the customer, plus the unlinked mail of the same
// threads and mail sent to the customer's address: our own replies are stored
// with no customer (measured 2026-10-09: 3,062 sent mails, none linked).
async function readEmails(conn, { customerId, asOf, customerEmail }) {
  const columns = ['id', 'gmail_thread_id', 'customer_id', 'from_address', 'subject', 'body_text', 'snippet', 'received_at'];
  const live = (query) => query.where('received_at', '<', asOf).whereNull('quarantined_at')
    .whereRaw("COALESCE(classification, '') <> 'spam'");
  const linked = await live(conn('emails').where({ customer_id: customerId })).select(columns);
  const threads = [...new Set(linked.map((row) => row.gmail_thread_id).filter(Boolean))];
  const address = clean(customerEmail).toLowerCase();
  let replies = [];
  if (threads.length || address) {
    replies = await live(conn('emails').whereNull('customer_id'))
      .where(function ours() {
        if (threads.length) this.whereIn('gmail_thread_id', threads);
        if (address) this.orWhereRaw("position(? in lower(COALESCE(to_address, ''))) > 0", [address]);
      })
      .select(columns);
  }
  const seen = new Set();
  return [...linked, ...replies]
    .filter((row) => (seen.has(row.id) ? false : seen.add(row.id)))
    .map((row) => {
      const fromCustomer = !!row.customer_id || (!!address && clean(row.from_address).toLowerCase().includes(address));
      const body = clean(row.body_text) || clean(row.snippet);
      return entry('email', fromCustomer ? 'customer' : 'staff', row.received_at, body ? `${clean(row.subject)}: ${body}` : '');
    });
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
    if (!said && row.recording_sid) unread.push({ channel: 'call', at: iso(row.created_at), reason: 'not_transcribed' });
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

async function readRescheduleReplies(conn, { customerId, asOf }) {
  const rows = await conn('reschedule_log').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('initiated_by', 'customer_response_text', 'notes', 'created_at');
  return rows.flatMap((row) => [
    entry('reschedule_reply', 'customer', row.created_at, row.customer_response_text),
    PROGRAM_RESCHEDULERS.includes(row.initiated_by) ? null : entry('note', 'staff', row.created_at, row.notes),
  ]);
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
  ['customer_file_note', readUndatedNotes],
];

/**
 * @returns {{ entries: Array<{id,channel,from,at,text}>, unread: Array<{channel,at?,reason}>, cut: number, chars: number, tooLong: boolean }}
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
      found.push(...(await read(conn, args, unread)).filter(Boolean));
    } catch (err) {
      unread.push({ channel, reason: 'read_failed' });
      logger.warn(`[auto-dispatch] proofreader could not read ${channel}: ${err.message}`);
    }
  }
  // Undated notes first, then oldest to newest.
  found.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  const entries = found.map(({ cut: _cut, ...rest }, i) => ({ id: `E${i + 1}`, ...rest }));
  const chars = entries.reduce((sum, row) => sum + row.text.length, 0);
  return {
    entries, unread, cut: found.filter((row) => row.cut).length, chars, tooLong: chars > MAX_RECORD_CHARS,
  };
}

module.exports = { buildCustomerRecord, MAX_ENTRY_CHARS, MAX_RECORD_CHARS };
