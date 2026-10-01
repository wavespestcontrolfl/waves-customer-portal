/**
 * Customer activity in the logged-in portal and the mobile app
 * (GATE_PORTAL_ACTIVITY, dark by default). Three signals, all comms-free:
 *
 *   1. customers.last_seen_at — stampLastSeen(), called fire-and-forget from
 *      the foreground beacon routes only (page-view, heartbeat, and a confirmed push-open) — NOT from the
 *      auth middleware, so background polling never counts. The throttle lives in the UPDATE's
 *      WHERE clause (only rows older than LAST_SEEN_THROTTLE_MINUTES move),
 *      so it holds across pods and a busy tab costs one cheap no-op UPDATE.
 *   2. portal tab views — customer_page_views rows with page 'portal:<tab>'.
 *   3. app opens from a push notification — page 'push:open', recorded ONLY
 *      for a bell notification the server can prove belongs to the signed-in
 *      customer (see recordPushOpen).
 *
 * Both view kinds go through the shared recorder (customer-page-views.js), so
 * they inherit its bot / staff-browser / WAVES_ADMIN_IPS skip, IP hashing and
 * SQL dedupe (page + subject + ip + customer, so two customers behind one
 * public IP never collapse into one event). There is no separate "staff viewing as a customer" session in
 * this codebase (customer JWTs are minted only by the customer login and
 * refresh routes), so the only staff signal is the signed waves_admin marker
 * cookie plus WAVES_ADMIN_IPS — exactly what the recorder already checks, and
 * exactly what the last_seen stamp checks too.
 *
 * customer_page_views column conventions for these two pages:
 *
 *   portal:<tab>  subject_type = platform ('web' | 'ios' | 'android', the
 *                 client's Capacitor platform hint), subject_id = null.
 *   push:open     subject_type = platform; subject_id =
 *                 'notification:<uuid>' — the bell notification id that
 *                 notifyCustomer puts in the push payload — deduped forever
 *                 per customer (no ip or time window), so a duplicate
 *                 delivery collapses. Pushes with no such id (routed-SMS
 *                 pushes carry only a type tag, and their sms_log row is
 *                 written after delivery) are NOT counted: an open that
 *                 cannot be tied to this customer records nothing.
 *
 * <tab> is the portal's tab id (the customer portal is one page whose
 * tabs — dashboard, plan, visits, billing, refer, documents, property,
 * learn — are the "routes"); never a raw path, id, token or query string.
 */
const db = require('../models/db');
const logger = require('./logger');
const { portalActivityLive } = require('../config/feature-gates');
const { recordPageView, shouldRecord } = require('./customer-page-views');

const LAST_SEEN_THROTTLE_MINUTES = 5;
const PLATFORMS = ['web', 'ios', 'android'];
const ROUTE_RE = /^[a-z][a-z-]{0,29}$/;
// The customer portal's real tabs (client/src/pages/PortalPage.jsx
// PRIMARY_TABS + MORE_TABS). Anything else is refused so a client cannot
// invent page categories and defeat the page-based dedupe (Codex #5335).
const PORTAL_TABS = new Set(['dashboard', 'plan', 'visits', 'billing', 'refer', 'documents', 'property', 'learn']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stamp customers.last_seen_at for a foreground activity beacon. Skips a
 * soft-deleted (merged-away) customer in the same UPDATE: executeMerge holds
 * the loser row FOR UPDATE, so a racing stamp waits, re-reads deleted_at and
 * matches nothing.
 * Never throws, never awaited by the caller. No-op while the gate is off or
 * for staff browsers / bots.
 */
function stampLastSeen(req, customerId) {
  try {
    if (!customerId || !portalActivityLive() || !shouldRecord(req)) return;
    Promise.resolve(db.raw(
      `UPDATE customers SET last_seen_at = now()
        WHERE id = ?::uuid
          AND deleted_at IS NULL
          AND (last_seen_at IS NULL OR last_seen_at < now() - (?::int * interval '1 minute'))`,
      [customerId, LAST_SEEN_THROTTLE_MINUTES],
    )).catch((err) => logger.warn(`[activity] last_seen stamp failed: ${err.message}`));
  } catch (err) {
    try { logger.warn(`[activity] last_seen stamp failed: ${err.message}`); } catch { /* never throw */ }
  }
}

/**
 * The portal tab name from whatever the client sent: only the first path
 * segment survives ('visits/:id' -> 'visits'; query, hash and id-looking
 * later segments are dropped), and it must be 1-30 lowercase letters or
 * hyphens AND one of the real portal tabs. A segment with digits, underscores, colons or anything long
 * (ids, tokens, uuids) is refused, not truncated. Returns null when unusable.
 */
function sanitizeRouteName(raw) {
  if (typeof raw !== 'string') return null;
  const first = raw.split(/[?#]/)[0].trim().toLowerCase().replace(/^\/+/, '').split('/')[0];
  return ROUTE_RE.test(first) && PORTAL_TABS.has(first) ? first : null;
}

function sanitizePlatform(raw) {
  return PLATFORMS.includes(raw) ? raw : 'web';
}

/** Record one portal tab view. Resolves like recordPageView (never throws). */
function recordPortalView(req, { customerId, route, platform }) {
  const name = sanitizeRouteName(route);
  if (!name) return Promise.resolve(false);
  return recordPageView({
    req,
    page: `portal:${name}`,
    customerId,
    subjectType: sanitizePlatform(platform),
  });
}

/** subject_id for a push open: 'notification:<uuid>' for a real uuid, else null. */
function pushSubjectId(notificationId) {
  if (typeof notificationId === 'string' && UUID_RE.test(notificationId.trim())) {
    return `notification:${notificationId.trim().toLowerCase()}`;
  }
  return null;
}

// True only when this bell notification is addressed to this customer
// (notifications.recipient_type = 'customer', recipient_id = the customer).
async function customerOwnsNotification(customerId, notificationUuid) {
  const res = await db.raw(
    `SELECT 1 FROM notifications
      WHERE id = ?::uuid AND recipient_type = 'customer' AND recipient_id = ?::uuid
      LIMIT 1`,
    [notificationUuid, customerId],
  );
  return Array.isArray(res?.rows) && res.rows.length > 0;
}

/**
 * Record one app open from a push notification, server-attributed. A row is
 * written (and last_seen_at stamped) ONLY when the payload carries a
 * notification uuid AND that notification belongs to `customerId`; anything
 * else (no id, a routed-SMS push, a notification owned by another profile of
 * the account) records nothing, so an open is never filed under the wrong
 * profile. The row dedupes forever per customer + notification. Resolves
 * true when a row was written; never throws.
 */
async function recordPushOpen(req, { customerId, platform, notificationId }) {
  try {
    if (!customerId || !portalActivityLive() || !shouldRecord(req)) return false;
    const subjectId = pushSubjectId(notificationId);
    if (!subjectId) return false;
    if (!(await customerOwnsNotification(customerId, subjectId.slice('notification:'.length)))) return false;
    stampLastSeen(req, customerId);
    return await recordPageView({
      req,
      page: 'push:open',
      customerId,
      subjectType: sanitizePlatform(platform),
      subjectId,
      dedupeForever: true,
    });
  } catch (err) {
    try { logger.warn(`[activity] push-open failed: ${err.message}`); } catch { /* never throw */ }
    return false;
  }
}

module.exports = {
  stampLastSeen, sanitizeRouteName, pushSubjectId, recordPortalView, recordPushOpen, customerOwnsNotification,
  LAST_SEEN_THROTTLE_MINUTES,
};
