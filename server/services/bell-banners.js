/**
 * Phone banners for bell-only admin alerts (GATE_BELL_BANNERS, owner 2026-11-03, "ok add", choices A and B).
 *
 * Three kinds of admin alert reached only the portal bell. With the gate on, a write that RANG also sends one phone
 * banner (APNs push) through triggerNotification, pushOnly: the bell row is already written by the caller.
 *   A. sms_operational_followup ("text follow-up due") and call_commitment_overdue ("promise to a caller overdue")
 *      push only between 7:00 AM and 9:00 PM Eastern. Outside those hours the bell row stays and no banner is sent
 *      (the 8 AM summary banner covers them).
 *   B. messenger_reply (a Facebook message) pushes at any hour, like a text.
 *
 * NotificationService.notifyAdmin calls bannerAfterWrite(result, { metadata, trx }) once per write. The banner goes
 * out only after the bell row is durable: a write on the caller's transaction waits for the OUTERMOST commit (a
 * rollback sends nothing). Nothing here changes a bell row, and a failure only logs: it never reaches the caller.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');

// nightQuiet: no banner at night (9:00 PM to 7:00 AM Eastern).
const BELL_BANNER_KINDS = Object.freeze({
  sms_operational_followup: Object.freeze({ nightQuiet: true }),
  call_commitment_overdue: Object.freeze({ nightQuiet: true }),
  messenger_reply: Object.freeze({ nightQuiet: false }),
});

const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 7;

// True from 9:00 PM up to 7:00 AM Eastern. The hour is read in America/New_York for the instant given (etParts),
// never from a fixed UTC offset, so the daylight-saving change moves nothing.
function isNightQuiet(date = new Date()) {
  const { hour } = etParts(date);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

// GATE_BELL_BANNERS, read at call time. A missing reader (a test that mocks feature-gates) or a throw reads as off.
function bannersLive() {
  try {
    return require('../config/feature-gates').bellBannersLive?.() === true;
  } catch {
    return false;
  }
}

const isBannerKind = (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(BELL_BANNER_KINDS, key);

function metaOf(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// The row a write rang, or null. A fresh insert rings when it is unread; a refreshed standing row rings only when
// notifyAdmin cleared its read state (`rung`). An identical repeat, a withheld bell and a failed write ring nothing.
function ringedRow(result) {
  if (!result || result.suppressed || !result.id) return null;
  if (result.refreshed) return result.rung === true ? result : null;
  if (result.deduped) return null;
  return result.read_at ? null : result;
}

// Why no banner for this write, or null when it should go. Pure apart from the gate read.
function skipReason(result, metadata) {
  const row = ringedRow(result);
  const caller = metaOf(metadata);
  if (!isBannerKind(caller.triggerKey)) return 'not_banner_kind';
  if (!bannersLive()) return 'gate_off';
  if (!row) return 'did_not_ring';
  const meta = { ...caller, ...metaOf(row.metadata) };
  // An Activity-only or quiet row is no ring (the watchdog's backlog summary is one); a row routed to Claude's queue
  // never pages a phone.
  if (meta.feed === 'activity' || meta.quiet === true) return 'activity_only';
  if (meta.claudeQueue || caller.claudeQueue) return 'claude_queue';
  return null;
}

// The row must still be an open, unread ring when the banner is about to go: the writer's own transaction may have
// read or closed it after the write (the watchdog marks a promise it already summarised read). Fails open.
async function rowStillRinging(rowId) {
  try {
    const row = await db('notifications').where({ id: rowId }).first('read_at', 'done_at');
    return Boolean(row) && !row.read_at && !row.done_at;
  } catch {
    return true;
  }
}

async function sendBanner(row, triggerKey, caller) {
  try {
    // The hour is judged now, when the banner would go, not when the row was written.
    if (BELL_BANNER_KINDS[triggerKey].nightQuiet && isNightQuiet(new Date())) return null;
    const { triggerNotification } = require('./notification-triggers');
    // The row's own words and link; alertRowId tags the banner per row so a refresh ring replaces it.
    const payload = {
      alertRowId: row.id, alertTitle: row.title, alertBody: row.body, alertLink: row.link,
      ...(caller.customerId || caller.customer_id ? { customerId: caller.customerId || caller.customer_id } : {}),
    };
    return await triggerNotification(triggerKey, payload, {
      pushOnly: true, adminOnly: true,
      beforePush: () => rowStillRinging(row.id),
    });
  } catch (err) {
    logger.warn(`[bell-banners] banner failed for ${triggerKey}: ${err?.code || err?.name || 'error'}`);
    return null;
  }
}

// The outermost transaction: a savepoint's executionPromise resolves on RELEASE, before the outer commit.
function outermostTransaction(trx) {
  let scope = trx;
  for (let depth = 0; scope?.parentTransaction && depth < 32; depth += 1) scope = scope.parentTransaction;
  return scope;
}

/**
 * Decide and schedule the banner for one notifyAdmin write. Returns the pending send (tests await it; notifyAdmin
 * does not), or null when no banner is due. Never throws.
 *
 * @param {object} result   what notifyAdmin is about to return
 * @param {object} context  { metadata: the caller's own metadata, trx: the caller's open transaction or null }
 */
function bannerAfterWrite(result, { metadata = null, trx = null } = {}) {
  try {
    if (skipReason(result, metadata)) return null;
    const caller = metaOf(metadata);
    const row = ringedRow(result);
    if (!trx || trx === db) return sendBanner(row, caller.triggerKey, caller);
    const scope = outermostTransaction(trx);
    if (!scope?.executionPromise) {
      // Without a commit hook the row's fate is unknown: no banner (the bell row stays), never one for a rollback.
      logger.warn(`[bell-banners] caller transaction has no commit hook, banner skipped for ${caller.triggerKey}`);
      return null;
    }
    // A rollback rejects executionPromise: the row never existed, so nothing is sent.
    return scope.executionPromise.then(() => sendBanner(row, caller.triggerKey, caller), () => null);
  } catch (err) {
    logger.warn(`[bell-banners] banner scheduling failed: ${err?.code || err?.name || 'error'}`);
    return null;
  }
}

module.exports = { BELL_BANNER_KINDS, isNightQuiet, bannerAfterWrite, __private: { skipReason, ringedRow, outermostTransaction } };
