// The admin bell's daily ring budget (GATE_ALERT_RING_BUDGET, owner 2026-11-05, decision D2; it carries out the owner's
// 2026-09-30 rule "at most 10 non-customer-contact rings a day"; docs/admin-notifications.md section 3, Budget).
//
// After 10 budgeted alerts rang in one Eastern day, each later one is written Activity-only (metadata.feed 'activity',
// quiet, stamped ringBudgetHeld with its Eastern day): no bell row, no phone banner, no sound. ONE count row in the bell
// ("System — 3 more alerts held today", dedupe key ring-budget:<day>) says how many were held and lists them.
//
// Always rings, never counted and never held:
//   - customer contact: the scorecard's customer lists below, a registry rule or alert that declares `contact: true`, and
//     the customer-comms triggers the bell policy always admits;
//   - a promise we owe a customer: `promise: true` (declared or in the registry rule) and the promise triggers;
//   - a tech-visible row: a registry trigger flagged techVisible (the flag NotificationService.scopeAdminFeedToRole reads)
//     shows in a technician's bell, and a technician cannot open the Activity feed, so the owner's budget must not take it away;
//   - an auto-dispatch notice (category schedule_conflict, or a dedupe key in DISPATCH_KEY_PREFIXES);
//   - time-critical field work: the combined-booking check's urgent case (a visit today or tomorrow with no time or
//     technician) stamps metadata.timeCritical true, and docs/admin-notifications.md section 3 says it always rings;
//   - an owner-only row (metadata.ownerOnly, a Claude plan or copy): the count row is shared by every admin login, and
//     holding such a row would copy its title into it. An owner-only row is never held, so its words never reach the count
//     row or the Activity "Held alerts" list; it rings as it does without the budget;
//   - an ops digest (category ops_digest: the Mac checks' ACT/FIX findings). Owner ruling 2026-09-11: ACT/FIX findings stay
//     in the bell. Each digest also supersedes its older copies by key (ops-digest.js supersedeOlderDigests), which reads a
//     quiet row as an unchanged repeat, so a held digest would close the newest finding and keep the stale one;
//   - the count row itself.
// A `bell: true` site tag is NOT an exemption: those rows are budgeted unless they are one of the above (a tag only says
// "this belongs in the bell", not "this is a customer").
//
// A row is budgeted only when it is a NEW admin row that would be written to the bell. Not budgeted: an Activity-only or
// quiet row, a row routed to Claude's queue (it never rings), and a dedupe hit or refresh of a standing row (NotificationService
// create() sees fresh inserts only).
//
// Counting: every budgeted row that rings is stamped metadata.ringBudgetDay = its Eastern day (etDateString). The count of a
// day is the number of admin rows carrying that stamp. The read is not locked, so several budgeted writes in flight at the same
// instant (or inside one open caller transaction) can each read "9" and all ring: the day can overshoot by the number of
// writes that raced, normally 1 to 3. A write is never blocked or failed by the budget; a count that cannot be read rings the
// row as before (one warning, no text of the alert).
//
// This module is pure except for the gate read and the queries named above. It never contacts a customer.
const logger = require('./logger');
const { etDateString, formatETTime } = require('../utils/datetime-et');

const DAILY_BUDGET = 10;
const DAY_KEY = 'ringBudgetDay';
const HELD_KEY = 'ringBudgetHeld';
const MARK_KEY = 'ringBudget';
const COUNT_MARK = 'count';
const PUSH_ONLY_KEY = 'ringBudgetPushOnly';
const COUNT_KEY_PREFIX = 'ring-budget:';
const COUNT_CATEGORY = 'system';
const ACTIVITY_LINK = '/admin/agents?tab=activity';
// An Eastern day is at most 25 hours (the fall-back day); the stamp does the real work, this only lets the query use the
// created_at index.
const WINDOW_HOURS = 36;
const DETAIL_LIST_MAX = 20;
const DETAIL_TITLE_MAX = 90;

// The weekly scorecard's definition of "customer" (category list, trigger list, metadata.contact), so the scorecard's number
// falls to the budget. Kept in one place; ring-budget tests pin every entry.
const CUSTOMER_CATEGORIES = Object.freeze([
  'inbound_sms', 'inbound_email', 'missed_call', 'voicemail_callback', 'new_lead', 'estimate_hot_view',
]);
const SCORECARD_TRIGGER_KEYS = Object.freeze([
  'sms_reply', 'new_lead', 'customer_missed_call', 'customer_email_received', 'customer_voicemail_callback',
  'customer_landline_from_call', 'repeat_caller', 'appointment_reschedule_intent', 'reservice_self_booked',
  'bundle_quote_requested', 'estimate_hot_view',
]);
// The customer lanes the bell policy always admits that the scorecard list leaves out (notification-bell-policy.js
// TRIGGER_BELL_ALLOWLIST), a customer's failed payment, and the Facebook / email lead banners (bell-banners.js).
const POLICY_CUSTOMER_TRIGGER_KEYS = Object.freeze([
  'relay_unbooked_call', 'relay_hot_lead', 'relay_reservice_filed', 'portal_ask', 'payment_failed', 'bill_payment_error',
  'messenger_reply', 'new_lead_email',
]);
// A promise we owe a customer (the registry rules that say `promise: true`; listed too so the answer never depends on the
// registry loading).
const PROMISE_TRIGGER_KEYS = Object.freeze([
  'promise_chaser', 'sms_operational_followup', 'call_commitment_overdue',
]);
const CUSTOMER_TRIGGER_KEYS = Object.freeze([...SCORECARD_TRIGGER_KEYS, ...POLICY_CUSTOMER_TRIGGER_KEYS]);

// The auto-dispatch emitters (server/services/auto-dispatch/*): every notice there is raised under category
// schedule_conflict (the move-check-down notice, category system, is the one exception) with one of these dedupe keys.
const DISPATCH_CATEGORIES = Object.freeze(['schedule_conflict']);
const DISPATCH_KEY_PREFIXES = Object.freeze([
  'rain-pass:', 'auto-dispatch-', 'recurring-dispatch:', 'recurring-no-window:',
]);

// GATE_ALERT_RING_BUDGET, read defensively: a test that mocks feature-gates without the reader, or a read that throws, leaves
// every row where it was.
function enabled() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.alertRingBudgetLive === 'function' && gates.alertRingBudgetLive() === true;
  } catch { return false; }
}

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};

// A trigger's registry entry (its rule's `contact` / `promise` declaration and its `techVisible` flag), or null when the
// registry cannot be read.
function registryTrigger(triggerKey) {
  if (!triggerKey) return null;
  try {
    return require('./notification-triggers').TRIGGER_REGISTRY?.[triggerKey] || null;
  } catch { return null; }
}

const isOwnerOnly = (meta) => meta.ownerOnly === true || meta.ownerOnly === 'true';

// Why a row is exempt from the budget, or null when it is budgeted. Pure apart from the registry read.
function exemptReason({ category, metadata, dedupeKey } = {}) {
  const meta = metaOf(metadata);
  if (meta[MARK_KEY] === COUNT_MARK) return 'count_row';
  if (isOwnerOnly(meta)) return 'owner_only';
  if (category === 'ops_digest') return 'ops_digest';
  const triggerKey = meta.triggerKey || null;
  const trigger = registryTrigger(triggerKey);
  const rule = trigger?.rule;
  return customerReason(category, meta, triggerKey, rule)
    || promiseReason(meta, triggerKey, rule)
    || (trigger?.techVisible ? 'tech_visible' : null)
    || (meta.timeCritical === true ? 'time_critical' : null)
    || dispatchReason(category, String(dedupeKey ?? meta.dedupeKey ?? ''));
}

function customerReason(category, meta, triggerKey, rule) {
  const declared = meta.contact === true || rule?.contact === true;
  return declared || CUSTOMER_CATEGORIES.includes(category) || (triggerKey && CUSTOMER_TRIGGER_KEYS.includes(triggerKey)) ? 'customer_contact' : null;
}

function promiseReason(meta, triggerKey, rule) {
  const declared = meta.promise === true || rule?.promise === true;
  return declared || (triggerKey && PROMISE_TRIGGER_KEYS.includes(triggerKey)) ? 'promise' : null;
}

const dispatchReason = (category, key) => (DISPATCH_CATEGORIES.includes(category) || DISPATCH_KEY_PREFIXES.some((p) => key.startsWith(p)) ? 'dispatch' : null);

// Rings stamped for one Eastern day. Reads on the writer's own connection, so a row written earlier in the same open
// transaction counts.
async function countRung(connection, day) {
  const row = await connection('notifications')
    .where({ recipient_type: 'admin' })
    .where('created_at', '>', connection.raw(`now() - interval '${WINDOW_HOURS} hours'`))
    .whereRaw(`metadata->>'${DAY_KEY}' = ?`, [day])
    .count('* as n')
    .first();
  return Number(row?.n) || 0;
}

// The day count, isolated from a caller's transaction: there a failed count (a statement timeout, say) would abort the whole
// transaction, and the insert after it would fail with 25P02 and take the caller's other work with it. So inside a
// transaction the count runs in its own savepoint (knex's nested transaction), which a failure rolls back alone. `impl`
// lets a test make the count fail on the savepoint itself.
const impl = { countRung };
async function countRungIsolated(connection, day) {
  if (connection?.isTransaction === true && typeof connection.transaction === 'function') {
    return connection.transaction((savepoint) => impl.countRung(savepoint, day));
  }
  return impl.countRung(connection, day);
}

/**
 * The budget verdict for one admin row about to be inserted (NotificationService.create). Never throws.
 * Returns { outcome, metadata, day? }:
 *   skip   - not a bell ring (Activity-only, quiet, Claude's queue): metadata unchanged
 *   exempt - customer contact, promise, dispatch notice or the count row: metadata unchanged
 *   ring   - budgeted and within the budget: metadata stamped with ringBudgetDay
 *   hold   - budgeted and past the budget: metadata rewritten Activity-only and stamped ringBudgetHeld
 */
async function applyBudget({ connection, category, metadata, now = new Date() } = {}) {
  try {
    const meta = metaOf(metadata);
    if (meta.feed === 'activity' || meta.quiet === true || meta.claudeQueue) return { outcome: 'skip', metadata };
    if (exemptReason({ category, metadata: meta })) return { outcome: 'exempt', metadata };
    const day = etDateString(now);
    let used = 0;
    try {
      used = await countRungIsolated(connection, day);
    } catch (err) {
      // Ring as before, but stamp the day so this ring still counts for the rows after it.
      logger.warn(`[ring-budget] count unreadable, ringing as before: ${err?.code || err?.name || 'error'}`);
    }
    if (used >= DAILY_BUDGET) {
      const { [DAY_KEY]: _day, ...rest } = meta;
      return { outcome: 'hold', day, metadata: { ...rest, feed: 'activity', quiet: true, [HELD_KEY]: day } };
    }
    return { outcome: 'ring', day, metadata: { ...meta, [DAY_KEY]: day } };
  } catch (err) {
    logger.warn(`[ring-budget] verdict failed, ringing as before: ${err?.code || err?.name || 'error'}`);
    return { outcome: 'skip', metadata };
  }
}

// True when a write's result is a row the budget held (the registry push and the banners must stay quiet for it).
function isHeld(result) {
  return Boolean(result && !result.suppressed && metaOf(result.metadata)[HELD_KEY]);
}

// A standing row held earlier TODAY: a refresh of it stays quiet (and held) instead of ringing past the budget. A row held on
// an earlier day is a new ring today; it takes the ordinary refresh. `incoming` ({ category, metadata }, optional) is the
// emission doing the refresh: one that is exempt (it became time-critical, say) rings as the exempt row it is.
function heldToday(existingMeta, incoming = null, now = new Date()) {
  const held = metaOf(existingMeta)[HELD_KEY];
  if (!held || !enabled() || held !== etDateString(now)) return false;
  return !(incoming && exemptReason({ category: incoming.category, metadata: incoming.metadata }));
}

// A standing row the budget held, refreshed by an emission that is time-critical now (the combined-booking check's urgent
// case): it must come back into the bell and ring whether or not the problem or its words changed. Held on any day.
function promotesHeld(existingMeta, incomingMeta) {
  return enabled() && Boolean(metaOf(existingMeta)[HELD_KEY]) && metaOf(incomingMeta).timeCritical === true;
}

// ---- the count row ----

async function readHeld(connection, day) {
  const rows = await connection('notifications')
    .where({ recipient_type: 'admin' })
    .where('created_at', '>', connection.raw(`now() - interval '${WINDOW_HOURS} hours'`))
    .whereRaw(`metadata->>'${HELD_KEY}' = ?`, [day])
    // The count row is shared by every admin login: an owner-only row's title never goes into it (it is never held; this is
    // the second lock, for a row stamped by other means).
    .whereRaw("COALESCE(metadata->>'ownerOnly', '') <> 'true'")
    .orderBy('created_at', 'asc')
    .limit(1000)
    .select('title', 'created_at');
  return rows;
}

const cutTitle = (title) => {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  return text.length > DETAIL_TITLE_MAX ? `${text.slice(0, DETAIL_TITLE_MAX - 1).trimEnd()}…` : text;
};

// The detail lists the held alerts, oldest first: Eastern time and title, 20 at most, then "+N more".
function detailFor(rows) {
  const lines = rows.slice(0, DETAIL_LIST_MAX).map((r) => `${formatETTime(new Date(r.created_at))} — ${cutTitle(r.title)}`);
  if (rows.length > DETAIL_LIST_MAX) lines.push(`+${rows.length - DETAIL_LIST_MAX} more`);
  return lines.join('\n');
}

// The composed alert for n held rows. Severity fyi: the bell order (needs-you first) never pins it to the top, the morning
// banner (needs-you / broken only) does not count it, and retention retires an idle fyi row after 7 days.
function countSpec(day, n) {
  return {
    area: 'System',
    action: `${n} more alert${n === 1 ? '' : 's'} held today`,
    why: `Alerts past the daily limit of ${DAILY_BUDGET} wait in Activity instead of ringing.`,
    severity: 'fyi',
    who: 'person',
    subject: { type: 'check', id: `${COUNT_KEY_PREFIX}${day}` },
    doneWhen: 'held_alerts_seen',
    link: ACTIVITY_LINK,
  };
}

// Write or refresh the day's one count row. Its first write rings; later writes rewrite the count and the list quietly
// (standingRefresh runs inside the key's lock and re-reads the held rows, so two writers cannot leave a stale count).
// The row is exempt from the budget (metadata.ringBudget 'count') and carries no ringBudgetDay stamp.
async function writeCountRow(day, connection = dbHandle()) {
  const { composeAdminAlert, raiseAdminAlert } = require('./admin-alert-compose');
  const rows = await readHeld(connection, day);
  if (!rows.length) return null;
  return raiseAdminAlert(COUNT_CATEGORY, countSpec(day, rows.length), {
    fyiRow: true,
    bell: true,
    dedupeKey: `${COUNT_KEY_PREFIX}${day}`,
    detail: detailFor(rows),
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    // notifyAdmin passes the transaction that holds the key's lock: the read runs on it, never on the pool (writers waiting for
    // the lock would otherwise starve the holder of a connection).
    standingRefresh: async (_existing, _existingMeta, trx) => {
      const current = await readHeld(trx || connection, day);
      if (!current.length) return null;
      const composed = composeAdminAlert(countSpec(day, current.length));
      return { title: composed.headline, body: composed.why, link: composed.link, detail: detailFor(current), metadata: { heldCount: current.length }, quiet: true };
    },
    metadata: { [MARK_KEY]: COUNT_MARK, heldCount: rows.length },
  });
}

const dbHandle = () => require('../models/db');

// An alert with no bell row because every admin turned bell entries off (their phone pushes stay on): the push is the ring,
// so it takes the same budget. `write(metadata)` writes the row that records the decision; it is Activity-only either way, so
// no bell entry is enabled against a preference.
//   ring - within the budget: the push goes as before, and an Activity-only record stamped with the day (severity fyi, so
//          retention retires it) counts it toward the day's ten;
//   hold - past the budget: the held row is written (Held alerts in Activity, one count row), and the caller sends no push.
// Exempt rows (customer contact and the rest) are untouched. A write that fails reads as "not held": the push goes.
// Returns { held, created } (created: the write's result, so the caller can read a dedupe hit). Never throws.
async function budgetPushOnly({ connection, category, metadata, write }) {
  try {
    const verdict = await applyBudget({ connection, category, metadata });
    if (verdict.outcome !== 'ring' && verdict.outcome !== 'hold') return { held: false };
    const held = verdict.outcome === 'hold';
    const row = held ? verdict.metadata : { ...verdict.metadata, feed: 'activity', quiet: true, severity: 'fyi', [PUSH_ONLY_KEY]: true };
    const created = await write(row);
    if (!created || created.suppressed) return { held: false, created: null };
    // A dedupe hit writes no new row: nothing new to count or list (the caller decides whether its push already went).
    const hit = created.deduped && !created.refreshed;
    if (held && !hit) await afterHeldInsert(connection, verdict.day);
    return { held, created };
  } catch (err) {
    logger.warn(`[ring-budget] push-only verdict failed, pushing as before: ${err?.code || err?.name || 'error'}`);
    return { held: false, created: null };
  }
}

// The outermost transaction of a knex transaction handle (a savepoint resolves before the outer commit).
function outermost(trx) {
  let scope = trx;
  for (let depth = 0; scope?.parentTransaction && depth < 32; depth += 1) scope = scope.parentTransaction;
  return scope;
}

async function runCountRow(day) {
  try {
    await writeCountRow(day);
  } catch (err) {
    // The held row is already written; only the count row is late. Never reaches the caller.
    logger.warn(`[ring-budget] count row not written: ${err?.code || err?.name || 'error'}`);
  }
}

const inTransaction = (connection) => Boolean(connection && connection.isTransaction === true);

/**
 * After a held row was inserted: write or refresh the day's count row. A held row written on a caller's open transaction
 * waits for the OUTERMOST commit (the count row reads committed rows and a failure there must never doom the caller's
 * transaction); a rollback writes nothing. Returns the pending write. Never throws.
 */
function noteHeld(connection, day) {
  try {
    if (!inTransaction(connection)) return runCountRow(day);
    const scope = outermost(connection);
    if (!scope?.executionPromise) {
      logger.warn('[ring-budget] caller transaction has no commit hook, count row skipped');
      return Promise.resolve(null);
    }
    return scope.executionPromise.then(() => runCountRow(day), () => null);
  } catch (err) {
    logger.warn(`[ring-budget] count row scheduling failed: ${err?.code || err?.name || 'error'}`);
    return Promise.resolve(null);
  }
}

// What NotificationService.create calls after a held row was inserted. On a direct write it waits for the count row (a few
// queries, held rows only); on a caller's transaction it only schedules it for the commit, because that promise settles after
// create() returns. Never throws.
async function afterHeldInsert(connection, day) {
  const pending = noteHeld(connection, day);
  if (!inTransaction(connection)) await pending;
}

module.exports = {
  DAILY_BUDGET,
  DAY_KEY,
  HELD_KEY,
  MARK_KEY,
  COUNT_KEY_PREFIX,
  CUSTOMER_CATEGORIES,
  CUSTOMER_TRIGGER_KEYS,
  SCORECARD_TRIGGER_KEYS,
  PROMISE_TRIGGER_KEYS,
  DISPATCH_CATEGORIES,
  DISPATCH_KEY_PREFIXES,
  enabled,
  exemptReason,
  applyBudget,
  isHeld,
  heldToday,
  promotesHeld,
  noteHeld,
  afterHeldInsert,
  budgetPushOnly,
  writeCountRow,
  countSpec,
  detailFor,
  _private: { impl },
};
