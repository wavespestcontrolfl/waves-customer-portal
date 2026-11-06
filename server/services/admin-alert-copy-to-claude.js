'use strict';

// "Send a copy to Claude (read-only)" (step 3; owner 2026-11-03, decision 1 = A: "customer alerts = a COPY, read-only
// until approval"; GATE_ALERT_SEND_TO_CLAUDE_COPY). Step 1 ("Send to Claude", admin-alert-send-to-claude.js) refuses a bell
// row that is customer contact or whose words our own code did not write, because a customer's own words must never reach a
// Claude tab that can change code. For those rows the owner login gets a COPY instead: ONE new owner-only row in Claude's
// queue that names the alert by id, kind and category and holds no customer word at all. A locked Mac tab (launcher v2b,
// outside this repo) reads the parent alert itself, as data, and writes a plan; the plan comes back to the owner's bell as an
// owner-only row. The owner then acts with his own words (step 1 or step 2). Nothing here sends anything to anyone or makes a
// model call, and the parent row is never changed: it stays in the bell, because a reply may be owed.
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { SENT_TO_CLAUDE_CLASS } = require('./admin-alert-routing');
const { alertRecordRefs } = require('./admin-alert-customer');
const {
  sendRefusal, cleanNote, byStamp, uuidOrNull, UUID_RE,
} = require('./admin-alert-send-to-claude');

const KIND = 'guarded-copy';
// A stamp kind that is already a copy of something: a guarded copy, or the owner's own idea. Neither can be copied again.
const COPY_KINDS = new Set([KIND, 'owner-idea']);
const CATEGORY_RE = /^[a-z0-9_]{1,40}$/;
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TITLE = 'Copy for Claude';
const BODY = 'A copy of an alert. Claude reads it in a locked tab and writes a plan for you.';
const SENT_MESSAGE = 'Copy sent to Claude. A locked Claude tab opens on the Mac within about 10 minutes.';

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};
const stampOf = (meta) => (meta.sentToClaude && typeof meta.sentToClaude === 'object' ? meta.sentToClaude : null);

// GATE_ALERT_SEND_TO_CLAUDE_COPY, read at call time; a missing or throwing reader reads as off.
function copyLive() {
  try { return require('../config/feature-gates').alertSendToClaudeCopyLive?.() === true; } catch { return false; }
}

// Why this row cannot be copied, or null when it can. null means step 1 refused it as customer contact or as words our
// code did not write: exactly the rows a copy is for. 'sendable' means step 1 covers it (send the alert itself).
function copyRefusal(row) {
  if (!row || String(row.id || '').startsWith('live:')) return 'not_found';
  if (row.done_at != null) return 'done';
  const meta = metaOf(row.metadata);
  if (COPY_KINDS.has(stampOf(meta)?.kind)) return 'is_copy';
  if (meta.feed === 'activity') return 'not_in_bell';
  const refusal = sendRefusal(row);
  if (refusal === null) return 'sendable';
  return refusal === 'customer_contact' || refusal === 'not_system_written' ? null : refusal;
}

// The bell list's persisted rows, marked `sendCopyToClaude: true` where a copy may be sent, for the owner login
// (`fullAccess`: ib-access ibFullAccess) while GATE_ALERT_SEND_TO_CLAUDE_COPY is on; otherwise the rows as they are. A row
// step 1 already marked `sendToClaude` is left alone. Never throws: a row whose check throws stays unmarked.
function withSendCopyToClaudeFields(rows, { role, fullAccess = false } = {}) {
  if (!Array.isArray(rows) || role !== 'admin' || fullAccess !== true || !copyLive()) return rows;
  return rows.map((row) => {
    try { return row.sendToClaude || copyRefusal(row) !== null ? row : { ...row, sendCopyToClaude: true }; } catch { return row; }
  });
}

// The parent's category and kind as the stamp keeps them: a plain lowercase name or null, never free text.
const categoryOrNull = (category) => (CATEGORY_RE.test(String(category || '')) ? category : null);
function kindOrNull(meta) {
  const key = String(meta.dedupeKey || '');
  const kind = meta.triggerKey || (key.includes(':') ? key.split(':')[0] : null);
  return KIND_RE.test(String(kind || '')) ? kind : null;
}
// The ids of the records the parent names (UUID-shaped only).
const recordsOf = (parent) => Object.fromEntries(Object.entries(alertRecordRefs(parent)).filter(([, id]) => uuidOrNull(id)));

// The send for one parent row the owner saw at `version`: { status, body }. 404 when the row is gone or out of scope,
// 400 for a bad note, 409 when its text changed since the bell read it or it cannot be copied, 422 when the service
// suppresses the row. The parent is not written.
async function sendAlertCopyToClaude(id, { version, note, by, role, technicianId = null } = {}) {
  const parent = await NotificationService.getAdminNotificationForExplainer(id, { role, technicianId });
  if (!parent) return { status: 404, body: { error: 'not_found' } };
  if (parent.version !== version) return { status: 409, body: { error: 'changed' } };
  const refusal = copyRefusal(parent);
  if (refusal) return { status: 409, body: { error: refusal } };
  const cleaned = cleanNote(note);
  if (cleaned.error) return { status: 400, body: { error: cleaned.error } };
  const parentMeta = metaOf(parent.metadata);
  const dedupeKey = `claude-copy:${parent.id}`;
  const at = new Date().toISOString();
  // A raw notifyAdmin on purpose (the one baseline entry for this file in admin-alert-raw-callsites.json): this row is not an
  // alert, and the Mac launcher reads this exact row shape. NO customer words in title, body, detail or the stamp: the
  // parent keeps them and the locked tab reads them from the parent. `claudeQueue` must be in the metadata at insert, or
  // the bell policy silences the row; `ownerOnly` keeps it away from every login but the owner.
  const result = await NotificationService.notifyAdmin('system', TITLE, BODY, {
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
        guarded: true,
        parentId: String(parent.id),
        parentKind: kindOrNull(parentMeta),
        parentCategory: categoryOrNull(parent.category),
        records: recordsOf(parent),
        ...(cleaned.note ? { note: cleaned.note } : {}),
      },
    },
  });
  if (!result) return { status: 500, body: { error: 'not_sent' } };
  if (result.suppressed) return { status: 422, body: { error: 'not_sent' } };
  if (result.deduped) return { status: 200, body: { duplicate: true, id: result.id } };
  logger.info('[claude-copy] sent', { id: result.id, parentId: parent.id });
  return { status: 200, body: { sent: true, id: result.id, at, message: SENT_MESSAGE } };
}

// Why a copy row cannot be cancelled at `at`, or null when it can: done, a different send (or not a guarded copy), or a Mac
// tab already started.
function cancelRefusal(row, at) {
  if (row.done_at != null) return 'done';
  const stamp = stampOf(metaOf(row.metadata));
  if (metaOf(row.metadata).claudeQueue !== SENT_TO_CLAUDE_CLASS || !stamp || stamp.kind !== KIND || stamp.at !== at) return 'changed';
  return stamp.startedAt ? 'started' : null;
}

// The 10-second Undo: { status, body }, on the COPY's id. Closes the copy row as done by the owner while it is open, still
// the send stamped at `at`, and no Mac tab has started on it. 404 when the row is gone, 409 `started`, `changed` or `done`.
// The parent alert was never changed, so there is nothing to put back.
async function cancelAlertCopy(copyId, { at, by, role, technicianId = null } = {}) {
  const row = await NotificationService.getAdminNotificationForExplainer(copyId, { role, technicianId });
  if (!row) return { status: 404, body: { error: 'not_found' } };
  const refusal = cancelRefusal(row, at);
  if (refusal) return { status: 409, body: { error: refusal } };
  if (!(await NotificationService.markAdminIdeaCancelled(row.id, at, byStamp(by), 'Cancelled by the owner.', KIND))) {
    // Started, closed or changed between the read and the write: say which.
    const now = await NotificationService.getAdminNotificationForExplainer(copyId, { role, technicianId });
    if (!now) return { status: 404, body: { error: 'not_found' } };
    return { status: 409, body: { error: cancelRefusal(now, at) || 'changed' } };
  }
  logger.info('[claude-copy] cancelled', { id: row.id });
  return { status: 200, body: { cancelled: true } };
}

module.exports = {
  copyLive, copyRefusal, withSendCopyToClaudeFields, sendAlertCopyToClaude, cancelAlertCopy, UUID_RE, KIND,
};
