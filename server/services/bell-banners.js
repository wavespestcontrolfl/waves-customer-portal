/**
 * Phone banners for bell-only admin alerts (GATE_BELL_BANNERS, owner 2026-11-03, "ok add", choices A and B).
 *
 * Three kinds of admin alert reached only the portal bell. With the gate on, a write that RANG also sends one phone
 * banner (APNs push) through triggerNotification, pushOnly: the bell row is already written by the caller.
 *   A. sms_operational_followup ("text follow-up due") and call_commitment_overdue ("promise to a caller overdue")
 *      push only between 7:00 AM and 9:00 PM Eastern. Outside those hours the bell row stays and no banner is sent
 *      (the 8 AM summary banner covers them).
 *   B. messenger_reply (a Facebook message) pushes at any hour, like a text.
 *   C. new_lead_email (a lead created from an email, or an email that completed a quote request) pushes at any hour, like
 *      a text, behind its own gate GATE_RING_NEW_CONTACTS instead of GATE_BELL_BANNERS (owner 2026-11-04, "ring new"). Its
 *      writer names the kind with notifyAdmin's `bannerKind` option, which is never stored on the row.
 *
 * NotificationService.notifyAdmin calls bannerAfterWrite(result, { metadata, trx }) once per write. The banner goes
 * out only after the bell row is durable: a write on the caller's transaction waits for the OUTERMOST commit (a
 * rollback sends nothing), and the COMMITTED row must still be this write's ring (same rungAt stamp, unread, open), so
 * a savepoint that rolled the write back sends nothing even when the outer transaction commits. The banner carries the
 * committed row's words. Nothing here changes a bell row, and a failure only logs: it never reaches the caller.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');

// nightQuiet: no banner at night (9:00 PM to 7:00 AM Eastern). gate: the feature-gates reader that turns the kind on,
// GATE_BELL_BANNERS (bellBannersLive) unless the kind names its own.
const BELL_BANNER_KINDS = Object.freeze({
  sms_operational_followup: Object.freeze({ nightQuiet: true }),
  call_commitment_overdue: Object.freeze({ nightQuiet: true }),
  messenger_reply: Object.freeze({ nightQuiet: false }),
  new_lead_email: Object.freeze({ nightQuiet: false, gate: 'ringNewContactsLive' }),
  // A customer stuck booking from an estimate (estimate-stuck-alert.js, owner 2026-11-05 "1, 2 and 3").
  estimate_stuck: Object.freeze({ nightQuiet: true }),
});

const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 7;

// True from 9:00 PM up to 7:00 AM Eastern. The hour is read in America/New_York for the instant given (etParts),
// never from a fixed UTC offset, so the daylight-saving change moves nothing.
function isNightQuiet(date = new Date()) {
  const { hour } = etParts(date);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

// The kind's gate (GATE_BELL_BANNERS, or the kind's own), read at call time. A missing reader (a test that mocks
// feature-gates) or a throw reads as off.
function bannersLive(kind) {
  try {
    return require('../config/feature-gates')[BELL_BANNER_KINDS[kind]?.gate || 'bellBannersLive']?.() === true;
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
  if (!bannersLive(caller.triggerKey)) return 'gate_off';
  if (!row) return 'did_not_ring';
  const meta = { ...caller, ...metaOf(row.metadata) };
  // An Activity-only or quiet row is no ring (the watchdog's backlog summary is one); a row routed to Claude's queue
  // never pages a phone.
  if (meta.feed === 'activity' || meta.quiet === true) return 'activity_only';
  if (meta.claudeQueue || caller.claudeQueue) return 'claude_queue';
  // A refresh that rang stamped metadata.rungAt; without it the committed row cannot be matched to this ring.
  if (row.refreshed && !ringStamp(row)) return 'no_ring_stamp';
  return null;
}

// The ring stamp (metadata.rungAt, set by notifyAdmin on every refresh that rings) the write returned, or null. A
// fresh insert carries none unless a ring gate stamped it; its identity is the new row's id.
function ringStamp(written) {
  return metaOf(written.metadata).rungAt || null;
}

// The COMMITTED row this write rang, or null. The outer commit alone does not prove it: a savepoint inside the
// transaction may have rolled back this write (knex resolves executionPromise for an explicit rollback() without an
// error), leaving the older row, or no row, behind. So the stored row must still carry exactly this write's ring stamp
// (none for an unstamped fresh insert: a refresh that rang since stamped one, and that ring sends its own banner), be
// unread and be open. A lookup that fails reads as unverified: no banner (the bell row stays).
async function committedRing({ id, rungAt }) {
  try {
    const stored = await db('notifications').where({ id }).first('id', 'title', 'body', 'link', 'read_at', 'done_at', 'metadata');
    if (!stored || stored.read_at || stored.done_at) return null;
    if ((metaOf(stored.metadata).rungAt || null) !== (rungAt || null)) return null;
    return stored;
  } catch (err) {
    logger.warn(`[bell-banners] committed row check failed: ${err?.code || err?.name || 'error'}`);
    return null;
  }
}

async function sendBanner(ring, triggerKey, caller) {
  try {
    // The hour is judged now, when the banner would go, not when the row was written.
    if (BELL_BANNER_KINDS[triggerKey].nightQuiet && isNightQuiet(new Date())) return null;
    const stored = await committedRing(ring);
    if (!stored) return null;
    const { triggerNotification } = require('./notification-triggers');
    // The committed row's own words and link; alertRowId tags the banner per row so a refresh ring replaces it.
    const payload = {
      alertRowId: stored.id, alertTitle: stored.title, alertBody: stored.body, alertLink: stored.link,
      ...(caller.customerId || caller.customer_id ? { customerId: caller.customerId || caller.customer_id } : {}),
    };
    // Looked at again just before the send: the row may be read or closed while the push is prepared.
    return await triggerNotification(triggerKey, payload, {
      // bellAuthorized: the row rang, so its writer's bell authorization (bell: true) carries to the banner.
      pushOnly: true, adminOnly: true, bellAuthorized: true,
      beforePush: async () => Boolean(await committedRing(ring)),
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
    const written = ringedRow(result);
    const ring = { id: written.id, rungAt: ringStamp(written) };
    if (!trx || trx === db) return sendBanner(ring, caller.triggerKey, caller);
    const scope = outermostTransaction(trx);
    if (!scope?.executionPromise) {
      // Without a commit hook the row's fate is unknown: no banner (the bell row stays), never one for a rollback.
      logger.warn(`[bell-banners] caller transaction has no commit hook, banner skipped for ${caller.triggerKey}`);
      return null;
    }
    // A rollback usually rejects executionPromise; an explicit rollback() without an error resolves it (knex's
    // doNotRejectOnRollback default). committedRing is what catches that case and a rolled-back savepoint.
    return scope.executionPromise.then(() => sendBanner(ring, caller.triggerKey, caller), () => null);
  } catch (err) {
    logger.warn(`[bell-banners] banner scheduling failed: ${err?.code || err?.name || 'error'}`);
    return null;
  }
}

module.exports = { BELL_BANNER_KINDS, isNightQuiet, bannerAfterWrite, __private: { skipReason, ringedRow, outermostTransaction, committedRing } };
