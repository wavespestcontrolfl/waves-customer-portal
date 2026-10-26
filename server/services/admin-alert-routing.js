// Which admin rows belong to Claude's queue instead of the owner's bell (owner ruling 2026-10-26,
// "ok go"; docs/admin-notifications.md section 5, GATE_ALERT_CLAUDE_QUEUE).
//
// Two kinds of row go to Claude:
//   1. A reminder bell from a Claude job on the owner's Mac (~/ops-oneshots/lib/bell.js stamps
//      metadata.opsJob). The job marks an owner ask with metadata.opsWho = 'person'; that one stays
//      in the bell (a gate flip for the owner's gates, a money ask). Every other opsJob row is Claude's.
//   2. An engineering fault of ours: a table of named classes below, matched by category plus the
//      emitter's dedupeKey prefix (or a metadata field when the emitter writes no dedupeKey).
//
// A routed row is written Activity-only (metadata.feed = 'activity', the marker
// NotificationService.excludeActivityOnlyFromBell reads), so it never rings or counts in the bell, and
// is stamped who = 'claude', so `needs-me --who claude` lists it. NotificationService.create and
// notifyAdmin call stampClaudeQueue; the Mac code and the emitters are not touched.
//
// This module is pure except for the gate read. It never contacts a customer.
const logger = require('./logger');

// Rows a customer reached us through, or that carry a customer's own words, are never routed.
// Nor is an ops_digest row (owner 2026-09-11: ACT/FIX exceptions from the Mac ops checks stay in the bell).
const CUSTOMER_CONTACT_CATEGORIES = new Set([
  'inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'new_lead',
]);

// Engineering-fault classes. Small and named on purpose: the seed of a later alert catalog.
// A class matches when the row's category equals `category` and either its dedupeKey starts with
// `dedupeKeyPrefix` or every `meta` field equals the row's metadata field.
const CLAUDE_QUEUE_CLASSES = Object.freeze([
  {
    name: 'sms-draft-canary',
    // sms-draft-canary.js raiseFailing: raiseAdminAlert('system', ..., { dedupeKey: 'sms-draft-canary:<route>' })
    category: 'system',
    dedupeKeyPrefix: 'sms-draft-canary:',
  },
  {
    name: 'ops-reminder-broken',
    // ~/ops-oneshots/lib/fail-bell.js: "Reminder job failed: <job>", dedupeKey 'ops-reminder-broken:<job>:<date>'
    category: 'system',
    dedupeKeyPrefix: 'ops-reminder-broken:',
  },
  {
    name: 'gbp-sync-degraded',
    // google-business.js _notifyDegradedSync: "Google review sync degraded for X", "Google review removal
    // reconcile failing for X", "Google reviews: some rows did not save at X". No dedupeKey; one metadata.reason.
    category: 'review',
    meta: { reason: 'gbp_sync_degraded' },
  },
  {
    name: 'gbp-sync-health-escalation',
    // google-business.js _maybeEscalateReviewSyncHealth: the "Review sync health escalation [...]" marker row.
    // Its ops_digest twin (category ops_digest) is NOT matched: ops_digest rows stay where they are.
    category: 'review',
    meta: { opsKey: 'gbp-sync-health' },
  },
]);

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};

// A row about a customer: the ids a customer-tied emitter writes (top level or in a trigger payload).
function carriesCustomer(meta) {
  const payload = metaOf(meta.payload);
  return [meta.customerId, meta.customer_id, meta.threadId, payload.customerId, payload.customer_id, payload.threadId]
    .some((v) => v !== undefined && v !== null && String(v).trim() !== '');
}

// The routing verdict for one row about to be written (or already open): null = stays in the bell,
// else { className, severity }. Pure: no gate read. `dedupeKey` defaults to metadata.dedupeKey.
function classifyClaudeQueue({ category, metadata, dedupeKey } = {}) {
  const meta = metaOf(metadata);
  if (CUSTOMER_CONTACT_CATEGORIES.has(category) || category === 'ops_digest') return null;
  // A registry event (triggerKey) or a customer-tied row is never Claude's, whatever stamps it carries.
  if (meta.triggerKey || carriesCustomer(meta)) return null;
  const key = String(dedupeKey ?? meta.dedupeKey ?? '');

  if (typeof meta.opsJob === 'string' && meta.opsJob.trim() && meta.opsWho !== 'person') {
    // A reminder that asks someone to act is work (needs-you); a report with nothing to do is fyi.
    return { className: 'ops-job', severity: meta.opsKind === 'fyi' ? 'fyi' : 'needs-you' };
  }
  const hit = CLAUDE_QUEUE_CLASSES.find((c) => c.category === category && (
    (c.dedupeKeyPrefix && key.startsWith(c.dedupeKeyPrefix))
    || (c.meta && Object.entries(c.meta).every(([k, v]) => meta[k] === v))
  ));
  return hit ? { className: hit.name, severity: 'broken' } : null;
}

// GATE_ALERT_CLAUDE_QUEUE, read defensively: a test that mocks feature-gates without this reader,
// or a read that throws, leaves every row where it was.
function claudeQueueEnabled() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.alertClaudeQueueLive === 'function' && gates.alertClaudeQueueLive() === true;
  } catch { return false; }
}

// The fields a routed row carries. `claudeQueue` names the class (audit, and the marker the refresh merge reads).
const claudeQueuePatch = ({ className, severity }) => ({ feed: 'activity', who: 'claude', severity, claudeQueue: className });

// Already stamped by an earlier step of the same write (notifyAdmin, then create).
const isStamped = (meta) => Boolean(meta && meta.claudeQueue && meta.feed === 'activity');

// The metadata to write for an admin row: the same object when the row stays in the bell (gate off, no
// match, already stamped), else a copy with the Claude-queue fields. Never throws.
function stampClaudeQueue({ category, metadata, dedupeKey }) {
  try {
    if (!metadata || typeof metadata !== 'object' || isStamped(metadata) || !claudeQueueEnabled()) return metadata;
    const verdict = classifyClaudeQueue({ category, metadata, dedupeKey });
    if (!verdict) return metadata;
    logger.info('[claude-queue] routed', { category, className: verdict.className });
    return { ...metadata, ...claudeQueuePatch(verdict) };
  } catch { return metadata; }
}

const PAGE = 500;
const SAMPLE = 5;

// The one-time mover: open (done_at empty) admin rows the routing above would send to Claude, written
// before the gate went on. Visibility only: it sets the same fields a new row gets and leaves read state,
// done state, title, body and link alone, so nothing rings. A row already off the bell (feed 'activity')
// is stamped for Claude without moving. Dry run by default. Refuses when the gate is off.
async function rerouteOpenRows(conn, { execute = false } = {}) {
  if (!claudeQueueEnabled()) throw new Error('GATE_ALERT_CLAUDE_QUEUE is off: the mover only runs while the gate is on');
  const byClass = {};
  const samples = {};
  const patches = new Map(); // JSON patch -> ids
  let scanned = 0;
  let after = null;
  // Cheap SQL pre-filter (an ops job stamp, or a category a fault class uses); classifyClaudeQueue decides.
  const classCategories = [...new Set(CLAUDE_QUEUE_CLASSES.map((c) => c.category))];
  for (;;) {
    const query = conn('notifications')
      .where({ recipient_type: 'admin' }).whereNull('done_at')
      .whereRaw("COALESCE(metadata->>'claudeQueue', '') = ''")
      .where((q) => q.whereRaw("COALESCE(metadata->>'opsJob', '') <> ''").orWhereIn('category', classCategories))
      .orderBy('id', 'asc').limit(PAGE)
      .select('id', 'category', 'title', 'metadata');
    if (after) query.where('id', '>', after);
    const page = await query;
    for (const row of page) {
      scanned += 1;
      const verdict = classifyClaudeQueue({ category: row.category, metadata: row.metadata });
      if (!verdict) continue;
      byClass[verdict.className] = (byClass[verdict.className] || 0) + 1;
      (samples[verdict.className] = samples[verdict.className] || []);
      if (samples[verdict.className].length < SAMPLE) samples[verdict.className].push({ id: row.id, title: String(row.title).slice(0, 80) });
      const patch = JSON.stringify(claudeQueuePatch(verdict));
      patches.set(patch, [...(patches.get(patch) || []), row.id]);
    }
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  const total = [...patches.values()].reduce((n, ids) => n + ids.length, 0);
  let moved = 0;
  if (execute && total) {
    await conn.transaction(async (trx) => {
      for (const [patch, ids] of patches) {
        // Fenced like the read: a row closed or stamped since is left alone.
        moved += await trx('notifications').whereIn('id', ids).whereNull('done_at')
          .whereRaw("COALESCE(metadata->>'claudeQueue', '') = ''")
          .update({ metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [patch]) });
      }
    });
  }
  return { execute, scanned, matched: total, moved, byClass, samples };
}

module.exports = {
  CLAUDE_QUEUE_CLASSES,
  CUSTOMER_CONTACT_CATEGORIES,
  classifyClaudeQueue,
  claudeQueueEnabled,
  stampClaudeQueue,
  rerouteOpenRows,
};
