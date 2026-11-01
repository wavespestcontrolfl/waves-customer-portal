/**
 * Portal inbox (GATE_PORTAL_INBOX, owner 2026-10-31, option A).
 *
 * What customers asked for inside the customer portal and nobody answered:
 *   1. portal chat hand-offs: ai_escalations rows still `pending` whose
 *      conversation is a `portal_chat` agent_sessions row;
 *   2. customer service requests that are not resolved / closed / cancelled and
 *      were not made by staff (source 'admin').
 * The Communications Portal tab shows the last 14 days. Older open items are
 * only counted; `closeOlder` closes them and sends NOTHING to a customer.
 *
 * This module never sends an email, text or call. The route files pass in the
 * actor and call these helpers; the gate is read at call time.
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalInboxLive } = require('../config/feature-gates');
const { requestProperty } = require('./service-request-property');

const WINDOW_DAYS = 14;
const LIST_CAP = 200;
const TEXT_CAP = 300;
const TERMINAL_REQUEST_STATUSES = ['resolved', 'closed', 'cancelled'];
const ALERT_KEYS = ['escalationId', 'requestId'];
const CHAT_CLOSE_NOTE = 'Closed as older than 14 days from Communications → Portal. No customer message.';
const REQUEST_CLOSE_NOTE = 'Closed as older than 14 days (Portal tab). No email sent.';
const ALERT_CLOSE_RESOLUTION = 'Closed as older than 14 days (Portal tab)';

// An escalation's admin bell alert marked Done = somebody already dealt with
// it. Hide the chat then. No alert at all (before Oct 2) = keep it listed.
const CHAT_NOT_DONE_SQL = `NOT (
  EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.metadata->>'escalationId' = e.id::text
  ) AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.metadata->>'escalationId' = e.id::text AND n.done_at IS NULL
  )
)`;

function windowCutoff(now = new Date()) {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function cut(text, max = TEXT_CAP) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function openChats(conn = db) {
  return conn('ai_escalations as e')
    .join('agent_sessions as s', 's.id', 'e.conversation_id')
    .where('s.channel', 'portal_chat')
    .where('e.status', 'pending')
    .whereRaw(CHAT_NOT_DONE_SQL);
}

function openRequests(conn = db) {
  return conn('service_requests as r')
    .whereRaw("coalesce(r.status, 'new') not in (?, ?, ?)", TERMINAL_REQUEST_STATUSES)
    .whereRaw("coalesce(r.source, '') <> 'admin'");
}

async function countOf(query) {
  const row = await query.clone().count({ n: '*' }).first();
  return Number(row?.n || 0);
}

async function summary(cutoff = windowCutoff()) {
  const [chats, requests] = await Promise.all([
    countOf(openChats().where('e.created_at', '>', cutoff)),
    countOf(openRequests().where('r.created_at', '>', cutoff)),
  ]);
  return { count: chats + requests };
}

// The assistant's reply right after the customer's hand-off message: the first
// assistant message at or after the customer's own message (found by its text),
// else at or after one minute before the escalation was filed.
const REPLY_SQL = `(
  SELECT m2.content FROM agent_messages m2
  WHERE m2.conversation_id = e.conversation_id
    AND m2.role = 'assistant'
    AND coalesce(m2.content, '') <> ''
    AND m2.created_at >= coalesce(
      (SELECT max(m1.created_at) FROM agent_messages m1
        WHERE m1.conversation_id = e.conversation_id AND m1.role = 'user'
          AND m1.content = e.customer_message AND m1.created_at <= e.created_at),
      e.created_at - interval '1 minute')
  ORDER BY m2.created_at ASC LIMIT 1
)`;

// hasTexts: the customer has an SMS thread, so Reply by text can open it;
// otherwise the tab opens a new text to `phone` (the Customer 360 SMS panel rule).
const HAS_TEXTS_SQL = '(c.id IS NOT NULL AND EXISTS (SELECT 1 FROM sms_log sl WHERE sl.customer_id = c.id)) AS has_texts';

function customerOf(row) {
  return {
    id: row.customer_id || null,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    phone: row.phone || '',
    hasTexts: row.has_texts === true,
  };
}

function chatItem(row) {
  return {
    kind: 'chat',
    id: row.id,
    createdAt: row.created_at,
    customer: customerOf(row),
    customerMessage: String(row.customer_message || ''),
    summary: row.summary || '',
    reason: row.reason || '',
    assistantReply: cut(row.assistant_reply),
  };
}

function requestItem(row) {
  const property = requestProperty(row.metadata);
  return {
    kind: 'request',
    id: row.id,
    createdAt: row.created_at,
    customer: customerOf(row),
    category: row.category || '',
    subject: row.subject || '',
    description: cut(row.description),
    requestedService: row.requested_service || '',
    source: row.source || '',
    urgency: row.urgency || '',
    status: row.status || '',
    ...(property ? { property } : {}),
  };
}

async function listRecent(cutoff) {
  const chatRows = await openChats()
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .where('e.created_at', '>', cutoff)
    .orderBy('e.created_at', 'desc')
    .limit(LIST_CAP)
    .select('e.id', 'e.created_at', 'e.customer_id', 'e.customer_message', 'e.summary', 'e.reason',
      'c.first_name', 'c.last_name', 'c.phone', db.raw(HAS_TEXTS_SQL), db.raw(`${REPLY_SQL} AS assistant_reply`));
  const requestRows = await openRequests()
    .leftJoin('customers as c', 'c.id', 'r.customer_id')
    .where('r.created_at', '>', cutoff)
    .orderBy('r.created_at', 'desc')
    .limit(LIST_CAP)
    .select('r.id', 'r.created_at', 'r.customer_id', 'r.category', 'r.subject', 'r.description',
      'r.requested_service', 'r.source', 'r.urgency', 'r.status', 'r.metadata', 'c.first_name', 'c.last_name', 'c.phone', db.raw(HAS_TEXTS_SQL));
  return [...chatRows.map(chatItem), ...requestRows.map(requestItem)]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// `total` is every open item in the window; `items` holds at most LIST_CAP of
// each kind, so the tab shows "N of total" and reloads when it runs out.
async function list(now = new Date()) {
  const cutoff = windowCutoff(now);
  const [items, recent, chats, requests] = await Promise.all([
    listRecent(cutoff),
    summary(cutoff),
    countOf(openChats().where('e.created_at', '<=', cutoff)),
    countOf(openRequests().where('r.created_at', '<=', cutoff)),
  ]);
  return { cutoff: cutoff.toISOString(), items, total: recent.count, older: { chats, requests } };
}

// Close the open admin bell alerts raised for these ids. `key` is the metadata
// field the alert carries: 'escalationId' (chat hand-off) or 'requestId'.
async function closeAlerts(key, ids, { by, role, technicianId = null, resolution }, conn = db) {
  if (!ALERT_KEYS.includes(key)) throw new Error(`unknown alert key ${key}`);
  const list = [...new Set([].concat(ids ?? []).filter(Boolean).map(String))];
  if (!list.length || !by) return 0;
  const alertIds = await conn('notifications')
    .where({ recipient_type: 'admin' })
    .whereNull('done_at')
    .whereIn(conn.raw(`metadata->>'${key}'`), list)
    .pluck('id');
  if (!alertIds.length) return 0;
  const NotificationService = require('./notification-service');
  return NotificationService.markAdminDone(alertIds, { by, resolution, role, technicianId }, conn);
}

// Mark-handled hook for the two existing update routes. Gate off: nothing.
// Never throws: closing a bell must not fail the staff action.
async function closeAlertsWhenHandled(key, id, actor) {
  if (!portalInboxLive()) return 0;
  try {
    return await closeAlerts(key, [id], {
      by: String(actor.technicianId),
      role: actor.role,
      technicianId: actor.technicianId,
      resolution: 'Handled in Communications → Portal',
    });
  } catch (err) {
    logger.warn(`[portal-inbox] could not close alerts for ${key} ${id}: ${err.message}`);
    return 0;
  }
}

// PATCH /api/admin/requests/:id hook: only the writer that won the move to
// 'resolved' closes the request's alerts.
async function closeRequestAlertsOnResolve(request, statusChanged, actor) {
  if (!statusChanged || request.status !== 'resolved') return 0;
  return closeAlertsWhenHandled('requestId', request.id, actor);
}

// A request whose admin bell was settled by the alert-relevance sweep (GATE_PORTAL_ITEM_CLOSE: a person
// answered the customer, or an estimate went out) is resolved to match, quietly: the same write as
// closeRequestsOlder for one row, and NO customer email. Only a request still open, and only the
// customer's own. `note` goes on the request as an admin note. Returns the number of rows resolved.
// `notAfter` is the closing bell's ask time: a request touched after it (the shared CTA writer refreshes the
// same request id with a new offer snapshot and bumps updated_at, and rings another bell) is a newer
// revision the old answer does not cover, so the same UPDATE refuses it. No usable boundary, no write.
async function resolveRequestQuietly(requestId, customerId, note, { notAfter = null, conn = db, now = new Date() } = {}) {
  if (!requestId || !customerId) return 0;
  const boundary = notAfter ? new Date(notAfter) : null;
  if (!boundary || Number.isNaN(boundary.getTime())) return 0;
  const cleaned = cut(note, 200);
  const rows = await conn('service_requests')
    .where({ id: requestId, customer_id: customerId })
    // Only a row nobody has moved since it was filed: a staff status change
    // (acknowledged, scheduled) is a newer revision the sweep must not
    // overwrite, and a terminal row is already done.
    .whereRaw("coalesce(status, 'new') = 'new'")
    .where('updated_at', '<=', boundary)
    .update({
      status: 'resolved',
      resolved_at: now,
      status_version: conn.raw('status_version + 1'),
      admin_notes: conn.raw(
        "CASE WHEN coalesce(admin_notes, '') = '' THEN ?::text ELSE admin_notes || E'\\n' || ?::text END",
        [cleaned, cleaned],
      ),
      updated_at: now,
    })
    .returning('id');
  return rows.length;
}

function parseCloseCutoff(raw, now = new Date()) {
  const when = new Date(raw);
  if (!raw || Number.isNaN(when.getTime())) return { error: 'cutoff must be an ISO date' };
  if (when.getTime() > windowCutoff(now).getTime()) return { error: 'cutoff must be at least 14 days ago' };
  return { cutoff: when };
}

async function closeChatsOlder(trx, cutoff, now) {
  const ids = await openChats(trx).where('e.created_at', '<=', cutoff).pluck('e.id');
  if (!ids.length) return [];
  return trx('ai_escalations')
    .whereIn('id', ids)
    .where({ status: 'pending' })
    .update({ status: 'dismissed', resolution_notes: CHAT_CLOSE_NOTE, updated_at: now })
    .returning('id')
    .then((rows) => rows.map((r) => r.id || r));
}

async function closeRequestsOlder(trx, cutoff, now) {
  const rows = await openRequests(trx)
    .where('r.created_at', '<=', cutoff)
    .update({
      status: 'resolved',
      resolved_at: now,
      status_version: trx.raw('status_version + 1'),
      admin_notes: trx.raw(
        "CASE WHEN coalesce(admin_notes, '') = '' THEN ?::text ELSE admin_notes || E'\\n' || ?::text END",
        [REQUEST_CLOSE_NOTE, REQUEST_CLOSE_NOTE],
      ),
      updated_at: now,
    })
    .returning('id');
  return rows.map((r) => r.id || r);
}

// Close every open item at or before `cutoff` in ONE transaction. Sends no
// email or text: it writes rows and marks the matching admin alerts Done.
async function closeOlder(cutoff, actor, now = new Date()) {
  return db.transaction(async (trx) => {
    const chatIds = await closeChatsOlder(trx, cutoff, now);
    const requestIds = await closeRequestsOlder(trx, cutoff, now);
    const alertActor = { by: String(actor.technicianId), role: actor.role, technicianId: actor.technicianId, resolution: ALERT_CLOSE_RESOLUTION };
    await closeAlerts('escalationId', chatIds, alertActor, trx);
    await closeAlerts('requestId', requestIds, alertActor, trx);
    await require('./audit-log').recordAuditEvent({
      actor_type: 'technician',
      actor_id: actor.technicianId || null,
      action: 'portal_inbox.close_older',
      resource_type: 'portal_inbox',
      metadata: { cutoff: cutoff.toISOString(), chats: chatIds.length, requests: requestIds.length },
      critical: true,
      trx,
    });
    return { chats: chatIds.length, requests: requestIds.length };
  });
}

module.exports = {
  WINDOW_DAYS,
  windowCutoff,
  summary,
  list,
  closeOlder,
  closeAlerts,
  closeAlertsWhenHandled,
  closeRequestAlertsOnResolve,
  resolveRequestQuietly,
  parseCloseCutoff,
};
