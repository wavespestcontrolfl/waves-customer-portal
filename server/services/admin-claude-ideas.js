'use strict';

// "Send to Claude" for an idea (owner 2026-11-03: "it should be for any issue, even ones that dont have an issue mid day,
// but ideas"; GATE_IB_SEND_TO_CLAUDE). The owner types or dictates an idea in the Intelligence Bar box and taps a free
// button beside Ask. It makes NO model call: it writes one admin notification row straight into Claude's queue (Activity-only,
// who 'claude', class 'sent-to-claude', kind 'owner-idea'). The Mac launcher (com.waves.notif-dispatch, outside this repo)
// opens a Claude tab that scopes the idea and asks the owner. The owner is the only admin login.
//
// Trusted facts only, as in services/admin-alert-send-to-claude.js: the idea is the admin's own typed text (title, body and
// detail carry it, cleaned of control, format and tag characters); the stamp holds when, who sent it, the page route (it must
// match the admin route shape) and the ids of the records on screen (UUID-shaped only). Sends nothing to anyone.
const crypto = require('crypto');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { SENT_TO_CLAUDE_CLASS } = require('./admin-alert-routing');
const { plainText, byStamp, uuidOrNull } = require('./admin-alert-send-to-claude');

const IDEA_MAX = 4000;
const KIND = 'owner-idea';
const ROUTE_RE = /^\/admin(\/[A-Za-z0-9_-]{1,64}){0,6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SENT_MESSAGE = 'Sent to Claude. A Claude tab opens on the Mac within about 10 minutes.';

// GATE_IB_SEND_TO_CLAUDE, read at call time; a missing or throwing reader reads as off.
function ideaSendLive() {
  try { return require('../config/feature-gates').ibSendToClaudeLive?.() === true; } catch { return false; }
}

// GATE_IB_ANSWER_SEND_TO_CLAUDE (it needs GATE_IB_SEND_TO_CLAUDE too), read at call time; a missing or throwing reader reads as off.
function answerSendLive() {
  try { return require('../config/feature-gates').ibAnswerSendToClaudeLive?.() === true; } catch { return false; }
}

// The cleaned idea: { idea } or { error }. Required, 4,000 characters at most (code points).
function cleanIdea(raw) {
  if (raw === undefined || raw === null || raw === '') return { error: 'idea_required' };
  if (typeof raw !== 'string') return { error: 'invalid_idea' };
  const idea = plainText(raw);
  if (!idea) return { error: 'idea_required' };
  if ([...idea].length > IDEA_MAX) return { error: 'idea_too_long' };
  return { idea };
}

// The page the idea was typed on: only a plain admin route is kept.
const routeOrNull = (route) => (typeof route === 'string' && ROUTE_RE.test(route) ? route : null);

// The records on screen, as the stamp keeps them (known keys, UUID-shaped values only; absent ones are left out).
const RECORD_KEYS = [
  ['customer_id', 'customerId'], ['property_id', 'propertyId'], ['estimate_id', 'estimateId'],
  ['appointment_id', 'appointmentId'], ['product_id', 'productId'],
];
function cleanRecords(ids) {
  const source = ids && typeof ids === 'object' ? ids : {};
  return Object.fromEntries(RECORD_KEYS.map(([from, to]) => [to, uuidOrNull(source[from])]).filter(([, id]) => id));
}

// The same idea sent twice shares a key: case and spacing do not make a new idea.
function ideaDedupeKey(idea) {
  const norm = idea.toLowerCase().replace(/\s+/g, ' ').trim();
  return `owner-idea:${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)}`;
}

// The send: { status, body }. 400 for a missing, over-long or malformed idea; 200 `duplicate` when the same idea is still
// open in Claude's queue (nothing written); 422 when the service suppresses the row.
async function sendIdeaToClaude({ text, page, ids, pasted, by } = {}) {
  const { idea, error } = cleanIdea(text);
  if (error) return { status: 400, body: { error } };
  const route = routeOrNull(page?.route);
  const viewedDate = typeof ids?.viewed_date === 'string' && DATE_RE.test(ids.viewed_date) ? ids.viewed_date : null;
  const dedupeKey = ideaDedupeKey(idea);
  const at = new Date().toISOString();
  // A raw notifyAdmin on purpose (the one baseline entry for this file in admin-alert-raw-callsites.json): this row is not an
  // alert, and the Mac launcher reads this exact row shape. The idea's words stay OUT of title, body and detail (Codex
  // security review round 4): the shared admin feeds (Activity, Recently done) serve those columns to every admin login, and
  // the idea is the owner's alone. It rides in the stamp (`sentToClaude.idea`), and `ownerOnly` keeps the row out of the
  // Activity feed and the done list, and refuses Done and Reopen, for any login that is not the owner.
  const result = await NotificationService.notifyAdmin('system', 'Idea for Claude', 'An idea from the owner.', {
    link: '/admin',
    dedupeKey,
    dedupeOpenOnly: true,
    metadata: {
      feed: 'activity',
      who: 'claude',
      severity: 'needs-you',
      claudeQueue: SENT_TO_CLAUDE_CLASS,
      ownerOnly: true,
      dedupeKey,
      sentToClaude: {
        at,
        by: byStamp(by),
        kind: KIND,
        idea,
        records: cleanRecords(ids),
        page: { route },
        ...(viewedDate ? { viewedDate } : {}),
        pasted: pasted === true,
        was: { who: null, severity: null },
      },
    },
  });
  if (!result) return { status: 500, body: { error: 'not_sent' } };
  if (result.suppressed) return { status: 422, body: { error: 'not_sent' } };
  if (result.deduped) return { status: 200, body: { duplicate: true, id: result.id } };
  logger.info('[claude-ideas] sent', { id: result.id });
  return { status: 200, body: { sent: true, id: result.id, at, message: SENT_MESSAGE } };
}

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};

// Why an idea row cannot be cancelled at `at`, or null when it can: done, a different send (or not an idea), or a Mac tab
// already started.
function cancelRefusal(row, at) {
  if (row.done_at != null) return 'done';
  const meta = metaOf(row.metadata);
  const stamp = meta.sentToClaude && typeof meta.sentToClaude === 'object' ? meta.sentToClaude : null;
  if (meta.claudeQueue !== SENT_TO_CLAUDE_CLASS || !stamp || stamp.kind !== KIND || stamp.at !== at) return 'changed';
  return stamp.startedAt ? 'started' : null;
}

// The 10-second Undo: { status, body }. Closes the idea row as done by the admin while it is open, still the send stamped
// at `at`, and no Mac tab has started on it. 404 when the row is gone, 409 `started`, `changed` or `done`.
async function cancelClaudeIdea(id, { at, by, role, technicianId = null } = {}) {
  const row = await NotificationService.getAdminNotificationForExplainer(id, { role, technicianId });
  if (!row) return { status: 404, body: { error: 'not_found' } };
  const refusal = cancelRefusal(row, at);
  if (refusal) return { status: 409, body: { error: refusal } };
  if (!(await NotificationService.markAdminIdeaCancelled(row.id, at, byStamp(by), 'Cancelled by the owner.'))) {
    // Started, closed or changed between the read and the write: say which.
    const now = await NotificationService.getAdminNotificationForExplainer(id, { role, technicianId });
    if (!now) return { status: 404, body: { error: 'not_found' } };
    return { status: 409, body: { error: cancelRefusal(now, at) || 'changed' } };
  }
  logger.info('[claude-ideas] cancelled', { id: row.id });
  return { status: 200, body: { cancelled: true } };
}

module.exports = { sendIdeaToClaude, cancelClaudeIdea, cleanIdea, ideaSendLive, answerSendLive, ideaDedupeKey, cleanRecords, routeOrNull };
