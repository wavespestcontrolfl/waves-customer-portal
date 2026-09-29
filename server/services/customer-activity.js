/**
 * Customer activity in the logged-in portal and the mobile app
 * (GATE_PORTAL_ACTIVITY, dark by default). Three signals, all comms-free:
 *
 *   1. customers.last_seen_at — stampLastSeen(), called fire-and-forget from
 *      the foreground beacon routes only (page-view, push-open, heartbeat) — NOT from the
 *      auth middleware, so background polling never counts. The throttle lives in the UPDATE's
 *      WHERE clause (only rows older than LAST_SEEN_THROTTLE_MINUTES move),
 *      so it holds across pods and a busy tab costs one cheap no-op UPDATE.
 *   2. portal tab views — customer_page_views rows with page 'portal:<tab>'.
 *   3. app opens from a push notification — page 'push:open'.
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
 *   push:open     subject_type = platform; subject_id = 'notification:<id>'
 *                 when the push carried a bell notification id (the
 *                 notifyCustomer path sends notificationId), else
 *                 'tap:<uuid>' — a per-tap id the client generates when the
 *                 tap happens and reuses on every retry of that tap, so a
 *                 retry dedupes but two genuine opens of the same push type do
 *                 not collapse (routed-SMS pushes have no stable id at send
 *                 time: push-channel-routing's sendPush writes its sms_log row
 *                 after delivery). 'type:<name>' (routed tag / category) is
 *                 only the fallback for an older client that sends no tap id.
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
const TYPE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTED_TAG_PREFIX = 'push-routed:';

/**
 * Stamp customers.last_seen_at for a foreground activity beacon.
 * Never throws, never awaited by the caller. No-op while the gate is off or
 * for staff browsers / bots.
 */
function stampLastSeen(req, customerId) {
  try {
    if (!customerId || !portalActivityLive() || !shouldRecord(req)) return;
    Promise.resolve(db.raw(
      `UPDATE customers SET last_seen_at = now()
        WHERE id = ?::uuid
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
 * hyphens. A segment with digits, underscores, colons or anything long
 * (ids, tokens, uuids) is refused, not truncated. Returns null when unusable.
 */
function sanitizeRouteName(raw) {
  if (typeof raw !== 'string') return null;
  const first = raw.split(/[?#]/)[0].trim().toLowerCase().replace(/^\/+/, '').split('/')[0];
  return ROUTE_RE.test(first) ? first : null;
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

/**
 * subject_id for a push open: the bell notification id when the client has a
 * real uuid, else the per-tap uuid, else the notification type (routed tag,
 * then category), else null when nothing usable was sent.
 */
function pushSubjectId({ notificationId, tapId, tag, category } = {}) {
  if (typeof notificationId === 'string' && UUID_RE.test(notificationId.trim())) {
    return `notification:${notificationId.trim().toLowerCase()}`;
  }
  if (typeof tapId === 'string' && UUID_RE.test(tapId.trim())) {
    return `tap:${tapId.trim().toLowerCase()}`;
  }
  if (typeof tag === 'string' && tag.startsWith(ROUTED_TAG_PREFIX)) {
    const t = tag.slice(ROUTED_TAG_PREFIX.length).toLowerCase();
    if (TYPE_RE.test(t)) return `type:${t}`;
  }
  if (typeof category === 'string') {
    const c = category.trim().toLowerCase();
    if (TYPE_RE.test(c)) return `type:${c}`;
  }
  return null;
}

/** Record one app open from a push notification. */
function recordPushOpen(req, { customerId, platform, notificationId, tapId, tag, category }) {
  return recordPageView({
    req,
    page: 'push:open',
    customerId,
    subjectType: sanitizePlatform(platform),
    subjectId: pushSubjectId({ notificationId, tapId, tag, category }),
  });
}

module.exports = {
  stampLastSeen, sanitizeRouteName, pushSubjectId, recordPortalView, recordPushOpen, LAST_SEEN_THROTTLE_MINUTES,
};
