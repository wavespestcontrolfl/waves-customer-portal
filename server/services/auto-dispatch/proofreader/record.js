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
const contextAggregator = require('../../context-aggregator');

const { redactAccessCodes } = contextAggregator;
const { excludeUnresolvedSendReservations } = require('../../messaging/review-ask-reservation');
const { resolveEmailCustomerLink, personSentFilter, extractEmailAddresses } = require('../../email/email-customer-link');
const { emailPlainText, stripQuotedAndSignature, ownReplySubject } = require('../../email/email-strip');
const { operatorReply, smsContactSelects } = require('../../staff-contact');
const { etOffsetIso } = require('../../../utils/datetime-et');
const { whereNotSandboxCall } = require('../../voice-agent/relay-protocol');
const { RETAINED_HISTORY_STATUSES } = require('../../visit-context/statuses');

// One entry's longest text. A longer one is split into parts, never cut
// (Codex #6258 r1: a restriction near the end of a long call was dropped).
const MAX_ENTRY_CHARS = 12000;
// Each part repeats this much of the part before it, so a statement that
// falls on a boundary is whole in one of the two.
const PART_OVERLAP_CHARS = 600;
// The whole record's limit. Past it no model is asked and the verdict is
// "unknown" (measured 2026-10-09 over 112 customers: median 6k, max 56k).
const MAX_RECORD_CHARS = 300000;

// Interaction rows that only repeat a text or an email already read from its
// source table, and the 'call' row the recording processor writes: its body
// is a model's summary of a call whose own words come from the call log table, and
// a paraphrase must never stand as a quote (Codex #6258 r4).
// 'inbound_call' is the raw transcript copied again when staff tag a call
// (admin-call-recordings.js), dated at the tagging (r8).
const INTERACTION_COPIES = ['sms_outbound', 'email_outbound', 'call', 'inbound_call'];
// A call the voice webhook linked by caller ID and the extractor then found
// was not this customer (context-aggregator.js isExcludedCall is the rule).
const NOT_THIS_CUSTOMER_OUTCOMES = ['wrong_number', 'spam'];
const SUBJECT_SETTLE_MS = 15 * 60 * 1000;
// reschedule_log rows written by code: their notes are program text.
const PROGRAM_RESCHEDULERS = ['system', 'auto_dispatch'];

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
// Eastern wall time with its offset: the prompt says every time is Eastern,
// so "this Friday" in an evening text is read against the right day.
const eastern = (value) => (value ? etOffsetIso(value) : null);
const msOf = (value) => (value ? new Date(value).getTime() : null);

// A row whose text can be edited in place carries the time of its last edit.
// Edited at or after `asOf`, its text is not the text that existed then: the
// replay lists it as unread instead of reading it (Codex #6258 r2, r3). The
// nightly run passes its own time, so nothing is ever "later" there.
function revisedLater(row, asOf, channel, unread) {
  if (!row.updated_at || msOf(row.updated_at) < msOf(asOf)) return false;
  unread.push({ channel, at: eastern(row.created_at), reason: 'revised_later' });
  return true;
}

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

// sms_log keeps no time for its status changes. An outbound text created in
// the minutes before the move may have been only reserved then and sent
// after: whether the customer had it at the move is unknown (r7).
const SMS_SETTLE_MS = 10 * 60 * 1000;

async function readTexts(conn, { customerId, asOf }, unread) {
  const rows = await excludeUnresolvedSendReservations(conn('sms_log'))
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    .whereNotNull('message_body')
    // Only a text that reached the customer can have promised anything.
    .where(function reached() { this.where('direction', 'inbound').orWhereIn('status', ['sent', 'delivered']); })
    .orderBy('created_at')
    .select('direction', 'message_body', 'message_type', 'created_at', ...smsContactSelects(conn));
  return rows.map((row) => {
    if (row.direction !== 'inbound' && msOf(asOf) - msOf(row.created_at) < SMS_SETTLE_MS) {
      unread.push({ channel: 'text', at: eastern(row.created_at), reason: 'delivery_not_settled' });
      return [];
    }
    // The one operator-provenance rule (staff-contact.js): message_type
    // 'manual' alone is reused by automated senders (Codex #6258 r6).
    const from = row.direction === 'inbound' ? 'customer' : (operatorReply(row) ? 'staff' : 'system');
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
// Each entry holds only the words that mail added: the quoted thread and the
// signature are stripped, and a subject counts only when it is new in its
// thread (stripQuotedAndSignature, ownSubjectsInThreads). Otherwise an old
// "Tuesdays only" would be read again at the date of every later reply (r3).
// Which subjects are new words in their thread, judged as the thread stood at
// `asOf` (email-strip.js ownSubjectsInThreads asks the same of the thread as
// it stands NOW, on the database clock: a replay needs the move's clock, r6).
// Only mail stored and received before `asOf` counts as a thread partner. A
// mail stored in the 15 minutes before `asOf` had no settled thread yet (its
// partners could still be syncing): its subject is unread, not absent.
async function ownSubjectsAsOf(conn, rows, asOf, live, unread) {
  const own = new Map();
  const withSubject = rows.filter((row) => clean(row.subject));
  const threadIds = [...new Set(withSubject.map((row) => row.gmail_thread_id).filter(Boolean))];
  const stored = threadIds.length ? await live(conn('emails').whereIn('gmail_thread_id', threadIds)).whereNotNull('subject')
    .whereRaw("NOT COALESCE(jsonb_exists(label_ids::jsonb, 'DRAFT'), false)")
    .select('id', 'gmail_thread_id', 'subject', 'received_at') : [];
  for (const row of withSubject) {
    if (row.created_at && msOf(asOf) - msOf(row.created_at) < SUBJECT_SETTLE_MS) {
      unread.push({ channel: 'email', at: eastern(row.received_at), reason: 'subject_not_settled' });
      continue;
    }
    const at = msOf(row.received_at);
    const earlier = stored.filter((o) => o.gmail_thread_id && o.gmail_thread_id === row.gmail_thread_id && String(o.id) !== String(row.id)
      && (msOf(o.received_at) < at || (msOf(o.received_at) === at && String(o.id) < String(row.id))));
    own.set(row.id, ownReplySubject(row.subject, earlier.map((o) => o.subject)));
  }
  return own;
}

async function readEmails(conn, { customerId, asOf, customerEmail }, unread) {
  const columns = ['id', 'gmail_thread_id', 'customer_id', 'from_address', 'to_address', 'cc_address', 'bcc_address', 'subject', 'body_text', 'body_html', 'snippet', 'received_at', 'created_at'];
  // received_at is Gmail's time; a backfill stores an old mail later, so the
  // row's own created_at is bounded too (Codex #6258 r5).
  const live = (query) => query.where('received_at', '<', asOf).where('created_at', '<', asOf).whereNull('quarantined_at')
    .whereRaw("COALESCE(classification, '') <> 'spam'");
  // The mail sync also links an inbound mail by the sender's display name
  // alone (email-actions.js), and a display name is whatever the sender
  // typed. Only a mail FROM the customer's own address is the customer's
  // words; any other linked mail is unread, never quoted (r8).
  const stored = await live(conn('emails').where({ customer_id: customerId })).select(columns);
  const own = clean(customerEmail).toLowerCase();
  const linked = stored.filter((row) => own && extractEmailAddresses(row.from_address).includes(own));
  for (const row of stored) {
    if (!linked.includes(row)) unread.push({ channel: 'email', at: eastern(row.received_at), reason: 'sender_not_verified' });
  }
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
    const owner = await resolveEmailCustomerLink(conn, row, { asOf });
    if (owner != null && String(owner) === String(customerId)) replies.push(row);
  }
  const subjects = await ownSubjectsAsOf(conn, [...linked, ...replies], asOf, live, unread);
  const mail = (row, from) => entry(
    'email', from, row.received_at,
    [clean(subjects.get(row.id)), clean(stripQuotedAndSignature(emailPlainText(row)))].filter(Boolean).join(': '),
  );
  return [...linked.map((row) => mail(row, 'customer')), ...replies.map((row) => mail(row, 'staff'))];
}

async function readCalls(conn, { customerId, asOf }, unread) {
  const rows = await conn('call_log')
    .where({ customer_id: customerId })
    .where('created_at', '<', asOf)
    // A sandbox test call is nobody's words (relay-protocol.js).
    .modify((qb) => whereNotSandboxCall(qb))
    .select('direction', 'transcription', 'recording_sid', 'created_at', 'updated_at', 'call_outcome', 'processing_status', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status');
  const ours = rows.filter((row) => !NOT_THIS_CUSTOMER_OUTCOMES.includes(row.call_outcome) && !contextAggregator.isExcludedCall(row));
  return ours.map((row) => {
    // The transcript is written, and can be replaced or purged, after the
    // call row: a row touched after the move is unread whatever it holds now (r10).
    if (revisedLater(row, asOf, 'call', unread)) return [];
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
  // A note can be its subject alone ("Afternoons only", no body).
  return rows.map((row) => entry(
    'note', row.interaction_type === 'service_request' ? 'customer' : 'staff', row.created_at,
    [clean(row.subject), clean(row.body)].filter(Boolean).join(': '),
  ));
}

async function readStaffNotes(conn, { customerId, asOf }, unread) {
  const rows = await conn('admin_notes').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('note_text', 'created_at', 'updated_at');
  // Before any content test: a note cleared after the move reads empty today (r8).
  return rows.map((row) => (revisedLater(row, asOf, 'note', unread)
    ? [] : entry('note', 'staff', row.created_at, row.note_text)));
}

// A recap edit overwrites technician_notes and stamps updated_at.
async function readTechNotes(conn, { customerId, asOf }, unread) {
  const rows = await conn('service_records').where({ customer_id: customerId }).where('created_at', '<', asOf)
    .select('technician_notes', 'service_type', 'created_at', 'updated_at');
  // The note names the service it was written on: a statement about another
  // service is not a hold (prompt.js), and the model needs to see which (r9).
  return rows.map((row) => (revisedLater(row, asOf, 'technician_note', unread)
    ? [] : entry('technician_note', 'staff', row.created_at, clean(row.technician_notes) && clean(row.service_type) ? `[${clean(row.service_type)} visit] ${row.technician_notes}` : row.technician_notes)));
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
// open request can be revised in place (routes/schedule.js appends to it).
async function readPortalRequests(conn, { customerId, asOf }, unread) {
  const rows = await conn('service_requests').where({ customer_id: customerId }).where('created_at', '<', asOf)
    // source 'admin' is an operator's own record (admin-cancellation.js): staff
    // words in the same table, never the customer's (r8).
    // 'voice_agent' is the phone assistant's paraphrase of a call whose own
    // words come from the call log table (r9).
    .whereRaw("COALESCE(source, '') NOT IN ('admin', 'voice_agent')")
    .select('category', 'subject', 'description', 'created_at', 'updated_at');
  // updated_at moves on a status or assignment change too, so it does not
  // say when the customer's words were written. A row touched since it was
  // made carries no date: undated, it is never "the newest statement" (r8).
  const statedAt = (row) => (row.updated_at && msOf(row.updated_at) > msOf(row.created_at) ? null : row.created_at);
  return rows.map((row) => (revisedLater(row, asOf, 'portal_request', unread) ? [] : entry(
    'portal_request', 'customer', statedAt(row),
    [clean(row.category), clean(row.subject), clean(row.description)].filter(Boolean).join(': '),
  )));
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

// What the customer wrote about the property in the portal. Auto-dispatch
// enforces only the structured day/time fields of this row (preferences.js);
// a "never Fridays" in the free text is for the proofreader. One row per
// customer, edited in place, so it is undated like the file notes.
// Every free-text field of the row that can hold a day or time rule (r8).
const PROPERTY_NOTE_FIELDS = ['special_instructions', 'access_notes', 'hoa_timing_restrictions', 'hoa_restrictions', 'mowing_notes', 'irrigation_schedule_notes'];

async function readPropertyNotes(conn, { customerId, asOf }, unread) {
  const row = await conn('property_preferences').where({ customer_id: customerId }).first(...PROPERTY_NOTE_FIELDS, 'created_at', 'updated_at');
  if (!row) return [];
  // Before the content test: a note cleared after the move reads empty today (r6).
  if (revisedLater(row, asOf, 'property_note', unread)) return [];
  return PROPERTY_NOTE_FIELDS.map((field) => entry('property_note', 'customer', null, clean(row[field]) ? `${field.replace(/_/g, ' ')}: ${row[field]}` : ''));
}

// The customer's file notes and the notes on the visit and its series. A
// visit that is not given, or is gone (a replay of a move whose visit was
// deleted since), has notes nobody can read: the record says so (r3).
// A grouped stop moves as one: the notes of every member's series are read,
// and `args.serviceTypes` names every service the move takes with it (r5).
async function readUndatedNotes(conn, args, unread) {
  const { customer, serviceId } = args;
  const out = [
    entry('customer_file_note', 'staff', null, customer && customer.crm_notes),
    entry('customer_file_note', 'staff', null, customer && customer.internal_notes),
    entry('customer_file_note', 'staff', null, customer && customer.follow_up_notes),
    entry('customer_file_note', 'staff', null, customer && customer.access_notes),
  ];
  const visit = serviceId ? await conn('scheduled_services').where({ id: serviceId }).first('id', 'recurring_parent_id', 'visit_id', 'service_type') : null;
  if (!visit) {
    unread.push({ channel: 'visit_note', reason: 'visit_not_found' });
    return out;
  }
  const members = visit.visit_id
    // Not the rows a frozen visit keeps only as history (statuses.js): they did not move.
    ? await conn('scheduled_services').where({ visit_id: visit.visit_id }).whereNotIn('status', RETAINED_HISTORY_STATUSES).select('id', 'recurring_parent_id', 'service_type')
    : [visit];
  const unit = members.length ? members : [visit];
  args.serviceTypes = [...new Set(unit.map((row) => clean(row.service_type)).filter(Boolean))];
  const parentIds = [...new Set(unit.map((row) => row.recurring_parent_id || row.id))];
  // The moved rows and their series parents only. A note on another
  // occurrence of the series is about that visit, not this one (r8).
  const series = await conn('scheduled_services')
    .whereIn('id', [...new Set([...parentIds, ...unit.map((row) => row.id)])])
    .select('notes', 'internal_notes');
  const texts = new Set();
  for (const row of series) for (const text of [row.notes, row.internal_notes]) if (clean(text)) texts.add(clean(text));
  return out.concat([...texts].map((text) => entry('visit_note', 'staff', null, text)));
}

const SOURCES = [
  ['text', readTexts], ['email', readEmails], ['call', readCalls], ['note', readInteractions],
  ['note', readStaffNotes], ['technician_note', readTechNotes], ['reschedule_reply', readRescheduleReplies],
  ['portal_request', readPortalRequests], ['portal_chat', readAssistantChat], ['property_note', readPropertyNotes], ['customer_file_note', readUndatedNotes],
];

/**
 * @returns {{ entries: Array<{id,channel,from,at,text}>, unread: Array<{channel,at?,reason}>, split: number, chars: number, tooLong: boolean, serviceTypes: string[] }}
 * `serviceTypes`: every service the visit's stop holds today (one, or the
 * members of a grouped stop); empty when the visit could not be read.
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
    entries, unread, split: found.filter((row) => row.split).length, chars, tooLong: chars > MAX_RECORD_CHARS, serviceTypes: args.serviceTypes || [],
  };
}

module.exports = { buildCustomerRecord, MAX_ENTRY_CHARS, MAX_RECORD_CHARS };
