const db = require('../models/db');
const logger = require('./logger');
const { isInternalTestCustomerId } = require('./internal-test-customers');

const CUSTOMER_PREFERENCE_KEYS = new Set([
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'tech_arrived',
  'service_completed',
  'payment_confirmation_sms',
  // Weather/property advisories (property-alerts engine). Column exists
  // since 20260401000104_notification_prefs_enhanced, default true.
  'weather_alerts',
]);

// Admin-feed role scoping, FAIL CLOSED: the persisted admin bell is shared
// (one recipient-less row) and carries owner-only content — estimate and
// finance alerts with customer names and amounts, plus adminRoleOnly
// triggers linking to requireAdmin surfaces. A NON-ADMIN reader therefore
// sees ONLY rows whose triggerKey is explicitly marked techVisible in the
// registry; everything else — including legacy rows with no metadata — is
// hidden and its read state untouchable. Lazy require avoids the
// notification-triggers ↔ notification-service cycle. A caller that passes
// no role (internal jobs, tests) sees the full feed, unchanged.
function scopeAdminFeedToRole(query, role) {
  if (!role || role === 'admin') return query;
  let keys = [];
  try {
    const { TRIGGER_REGISTRY } = require('./notification-triggers');
    keys = Object.entries(TRIGGER_REGISTRY)
      .filter(([, trigger]) => trigger.techVisible)
      .map(([key]) => key);
  } catch (err) {
    logger.warn(`[notifications] role-scope registry load failed: ${err.message}`);
  }
  if (!keys.length) {
    // No tech-visible triggers resolvable → non-admin sees nothing.
    return query.whereRaw('1 = 0');
  }
  return query.whereRaw(
    `COALESCE(metadata->>'triggerKey', '') IN (${keys.map(() => '?').join(', ')})`,
    keys,
  );
}

async function customerPreferenceEnabled(customerId, preferenceKey) {
  if (!preferenceKey) return true;
  if (!CUSTOMER_PREFERENCE_KEYS.has(preferenceKey)) {
    logger.error(`[notifications] Unknown customer preference key: ${preferenceKey}`);
    return false;
  }

  try {
    const prefs = await db('notification_prefs')
      .where({ customer_id: customerId })
      .first(preferenceKey);
    return !prefs || prefs[preferenceKey] !== false;
  } catch (err) {
    // Preference lookup uncertainty must not become an unwanted native push.
    logger.warn(`[notifications] Customer preference lookup failed (${preferenceKey}): ${err.message}`);
    return false;
  }
}

async function existingCustomerNotification(customerId, dedupeKey, connection = db) {
  if (!dedupeKey) return null;
  return connection('notifications')
    .where({ recipient_type: 'customer', recipient_id: customerId })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first();
}

// No emojis in admin notification text (owner ruling 2026-07-30) — enforced
// centrally here so every call site (trigger registry, direct notifyAdmin,
// legacy alert strings, quoted customer text) is covered without a per-site
// sweep. Customer-facing notifications are untouched.
const { stripEmoji } = require('../utils/strip-emoji');

const NotificationService = {
  // Create a notification.
  // `bell` (admin recipients only) is an explicit site-level policy tag:
  // true always rings, false never rings — see notification-bell-policy.js.
  // It only has effect while GATE_ADMIN_BELL_POLICY is on.
  async create({ recipientType, recipientId, category, title, body, icon, link, metadata, bell, bellDefault, connection = db }) {
    try {
      // Demo/internal test accounts (App Store review account) must not ring
      // the admin bell — their bounce alerts and junk service requests are
      // noise. Central gate: emitters carry the customer id in metadata,
      // either top-level or nested under a trigger payload (sms_reply uses
      // threadId = customer id). Push dispatch for triggers is separately
      // gated in notification-triggers.js.
      const metaCid = metadata?.customerId || metadata?.customer_id
        || metadata?.payload?.customerId || metadata?.payload?.customer_id
        || metadata?.payload?.threadId;
      if (recipientType === 'admin' && isInternalTestCustomerId(metaCid)) {
        logger.info(`[notifications] Suppressed admin notification for internal test customer (${category})`);
        // TRUTHY sentinel, not null: callers treat null as "insert failed"
        // (requests.js logs an ops error; the estimate-extension route
        // releases its claim and 500s). Intentional suppression must read
        // as success-without-a-row.
        return { id: null, suppressed: true };
      }
      // Admin bell policy (GATE_ADMIN_BELL_POLICY, default off): when the
      // gate is on, only allowlisted lanes ring the shared admin bell —
      // everything else is silenced HERE (no row) so every path through the
      // service is covered: direct notifyAdmin sites, the trigger registry
      // (its bell write lands here with metadata.triggerKey), and the
      // converted ex-raw-insert sites. Same truthy sentinel as the internal
      // test-customer gate above: intentional suppression must read as
      // success-without-a-row, never as an insert failure.
      if (recipientType === 'admin') {
        try {
          const bellPolicy = require('./notification-bell-policy');
          if (bellPolicy.isBellPolicyEnabled()) {
            const allowed = await bellPolicy.bellAllowed({
              category,
              triggerKey: metadata?.triggerKey || null,
              options: { bell, bellDefault },
            });
            if (!allowed) {
              // Category + triggerKey only — titles/bodies carry customer
              // names and addresses, which must not leak into logs.
              logger.info('[bell-policy] silenced', {
                category,
                triggerKey: metadata?.triggerKey || null,
              });
              return { id: null, suppressed: true, reason: 'bell_policy' };
            }
          }
        } catch (err) {
          // Policy failure must never break notifications — fall through
          // and insert (fail-open matches gate-off behavior).
          logger.warn(`[notifications] bell policy check failed: ${err.message}`);
        }
      }
      // A title that was ONLY emoji falls back to the original rather than
      // inserting an empty string.
      const isAdmin = recipientType === 'admin';
      const [notif] = await connection('notifications').insert({
        recipient_type: recipientType,
        recipient_id: recipientId || null,
        category,
        title: isAdmin ? (stripEmoji(title) || title) : title,
        body: (isAdmin ? stripEmoji(body) : body) || null,
        icon: icon || getCategoryIcon(category),
        link: link || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      }).returning('*');
      return notif;
    } catch (err) {
      logger.error(`[notifications] Create failed: ${err.message}`);
      return null;
    }
  },

  // Create admin notification (no recipient_id needed)
  async notifyAdmin(category, title, body, opts = {}) {
    // Opt-in dedupe, mirroring notifyCustomer's mechanism (PR #3496 review
    // P1: replayed emitters — e.g. repeated recap edits re-detecting the
    // same stranded card hold — must not crowd the billing feed with
    // identical bells). Same advisory-lock + metadata dedupeKey shape so
    // both recipient types share one mechanism; no dedupeKey = unchanged
    // behavior for every existing caller. Fail closed: an unprovably-new
    // event skips the bell rather than risking a duplicate.
    // refreshOnDedupe (opt-in): when the keyed bell already exists and this
    // emission's CONTENT differs (a retried run whose failure set changed),
    // rewrite the standing row's title/body/metadata and surface it unread
    // again — the office must never keep reading an obsolete error list
    // while the response says the alert has the details. Identical content
    // stays a plain dedupe (no re-bell).
    // dedupeWindowMs (optional, with dedupeKey): a ROLLING window instead of
    // forever — the key dedupes only against rows younger than the window,
    // so a recurring signal (an estimate re-opened again tomorrow) can ring
    // again once the window passes while two opens inside it contend on the
    // same stable lock. One mechanism for every admin emitter (rule 15).
    // trx (optional, with dedupeKey): run the lock + probe + insert on the
    // CALLER's open transaction instead of one of our own, so a caller that
    // retires earlier rows and raises the replacement commits both together
    // (termite station retrieval: staff must never see the old instruction
    // unread beside the new one). Errors then PROPAGATE — swallowing one
    // inside a caller's transaction would leave it aborted and doom the
    // commit — so the caller owns containment.
    const { dedupeKey, dedupeWindowMs, refreshOnDedupe = false, trx: callerTrx = null, relayFailureCall = null, ...createOpts } = opts;
    if (!dedupeKey) {
      return this.create({ recipientType: 'admin', category, title, body, ...createOpts, ...(callerTrx ? { connection: callerTrx } : {}) });
    }
    const windowMs = Number(dedupeWindowMs);
    const metadata = { ...(createOpts.metadata || {}), dedupeKey };
    const dedupeAndInsert = async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
        let existingQuery = trx('notifications')
          .where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
        if (Number.isFinite(windowMs) && windowMs > 0) {
          existingQuery = existingQuery.where('created_at', '>', trx.raw("NOW() - (? * interval '1 millisecond')", [Math.round(windowMs)]));
        }
        const existing = await existingQuery.first();
        if (existing) {
          // Compared and stored in create()'s admin form (emoji-stripped),
          // or an emoji title would read as "changed" on every emission.
          const nextTitle = stripEmoji(title) || title;
          const nextBody = stripEmoji(body) || null;
          if (refreshOnDedupe && (existing.title !== nextTitle || existing.body !== nextBody)) {
            const existingMeta = typeof existing.metadata === 'string'
              ? (() => { try { return JSON.parse(existing.metadata); } catch { return {}; } })()
              : (existing.metadata || {});
            const refreshed = { title: nextTitle, body: nextBody, metadata: JSON.stringify({ ...existingMeta, ...metadata }), read_at: null };
            await trx('notifications').where({ id: existing.id }).update(refreshed);
            return { notification: { ...existing, ...refreshed, metadata: { ...existingMeta, ...metadata } }, deduped: true, refreshed: true };
          }
          return { notification: existing, deduped: true };
        }
        const created = await this.create({
          recipientType: 'admin', category, title, body, ...createOpts, metadata, connection: trx,
        });
        // create() returns null on an insert failure (PR #3496 review P1):
        // spreading that null would report {deduped:false} as if a row
        // landed. Throw inside the transaction so the failure surfaces as
        // the null return below, never as success.
        if (!created) throw new Error('admin notification insert failed');
        return { notification: created, deduped: false };
    };
    const shape = (persisted) => ({ ...persisted.notification, deduped: persisted.deduped, ...(persisted.refreshed ? { refreshed: true } : {}) });
    if (callerTrx) return shape(await dedupeAndInsert(callerTrx));
    try {
      let callbackStamp;
      const persisted = await db.transaction(async (trx) => {
        if (!relayFailureCall) return dedupeAndInsert(trx);
        // Extend the existing notification transaction: shared callback claims
        // are final delivery evidence, never a durable pending lease. Holding
        // the call row also fences session takeover until the bell commits.
        await trx.raw("SET LOCAL statement_timeout = '3s'");
        await trx.raw("SET LOCAL idle_in_transaction_session_timeout = '5s'");
        const call = await trx('call_log').where('twilio_call_sid', relayFailureCall.callSid).forUpdate().first('id', 'metadata', 'voicemail_callback_alerted_at');
        let meta = call?.metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
        if (!call || call.voicemail_callback_alerted_at || ((meta?.relay_session_claim_owner ?? null) !== relayFailureCall.owner)) {
          return { notification: { suppressed: true }, deduped: true };
        }
        if (relayFailureCall.isActive?.() === false) throw new Error('relay callback cancelled');
        const persisted = await dedupeAndInsert(trx);
        if (!persisted.notification.suppressed) {
          const [stamped] = await trx('call_log').where('id', call.id).update({
            voicemail_callback_alerted_at: trx.fn.now(),
            metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_failure_callback_filed_at', now()::text)"),
          }).returning('metadata');
          callbackStamp = stamped.metadata.relay_failure_callback_filed_at;
        }
        if (relayFailureCall.isActive?.() === false) throw new Error('relay callback cancelled');
        return persisted;
      });
      const receipt = callbackStamp && !persisted.deduped ? {
        callSid: relayFailureCall.callSid, callbackStamp, notificationId: persisted.notification.id,
      } : null;
      // The same conditional compensation handles close during COMMIT and an
      // end-frame failure after the bell result reaches the conversation.
      if (receipt && relayFailureCall.isActive?.() === false) {
        await this.revertRelayFailureCallback(receipt);
        return null;
      }
      if (receipt) relayFailureCall.onCommitted?.(receipt);
      return shape(persisted);
    } catch (err) {
      logger.warn(`[notifications] Admin notification dedupe failed: ${err.message}`);
      return null;
    }
  },

  async revertRelayFailureCallback({ callSid, callbackStamp, notificationId }) {
    return db.transaction(async (trx) => {
      await trx.raw("SET LOCAL statement_timeout = '2s'");
      await trx.raw("SET LOCAL idle_in_transaction_session_timeout = '5s'");
      const call = await trx('call_log').where('twilio_call_sid', callSid).forUpdate().first('id');
      if (!call) return;
      const cleared = await trx('call_log').where('id', call.id)
        .whereRaw("metadata->>'relay_failure_callback_filed_at' = ?", [callbackStamp])
        .update({ voicemail_callback_alerted_at: null, metadata: trx.raw("metadata - 'relay_failure_callback_filed_at'") });
      if (cleared) await trx('notifications').where('id', notificationId).delete();
    });
  },

  // Create customer notification
  async notifyCustomer(customerId, category, title, body, opts = {}) {
    const { preferenceKey, dedupeKey, ...createOpts } = opts;

    if (!(await customerPreferenceEnabled(customerId, preferenceKey))) {
      return { id: null, suppressed: true, reason: 'preference_disabled' };
    }

    const metadata = {
      ...(createOpts.metadata || {}),
      ...(dedupeKey ? { dedupeKey } : {}),
    };
    const createArgs = {
      recipientType: 'customer',
      recipientId: customerId,
      category,
      title,
      body,
      ...createOpts,
      metadata,
    };

    let notification;
    if (dedupeKey) {
      try {
        const persisted = await db.transaction(async (trx) => {
          // Serialize this customer's event key across pods. The lock lives
          // only for the transaction; the provider call happens after commit.
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${customerId}:${dedupeKey}`]);
          const existing = await existingCustomerNotification(customerId, dedupeKey, trx);
          if (existing) return { notification: existing, deduped: true };
          return {
            notification: await this.create({ ...createArgs, connection: trx }),
            deduped: false,
          };
        });
        if (persisted.deduped) return { ...persisted.notification, deduped: true, push: null };
        notification = persisted.notification;
      } catch (err) {
        // A failed lock/read cannot safely prove this event is new. Fail closed
        // instead of risking a duplicate bell + native push.
        logger.warn(`[notifications] Customer notification dedupe failed: ${err.message}`);
        return null;
      }
    } else {
      notification = await this.create(createArgs);
    }
    if (!notification || notification.suppressed) return notification;

    let pushQueued = false;
    try {
      const PushService = require('./push-notifications');
      const dispatch = PushService.sendToCustomer(customerId, {
        title,
        body: body || '',
        url: createOpts.link || '/',
        category,
        notificationId: String(notification.id),
        tag: dedupeKey || `customer-notification:${notification.id}`,
      });
      pushQueued = true;
      // The bell is already durable, and request paths such as status changes
      // and estimate acceptance must not wait on external push providers.
      void Promise.resolve(dispatch).catch((err) => {
        logger.warn(`[notifications] Customer push dispatch failed: ${err.message}`);
      });
    } catch (err) {
      // Preserve the successful bell even if dispatch fails synchronously.
      logger.warn(`[notifications] Customer push dispatch failed: ${err.message}`);
    }
    return { ...notification, push: { queued: pushQueued } };
  },

  // Get notifications for admin
  async getAdminNotifications(limit = 50, offset = 0, { role } = {}) {
    return scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin' }),
      role,
    )
      .orderBy('created_at', 'desc')
      .limit(limit).offset(offset);
  },

  // Get unread count for admin
  // trx (optional): run on an existing transaction's connection — the
  // badge ordering section (admin-unread.js) computes counts inside its
  // advisory-lock transaction and must not borrow a second pool
  // connection while holding one.
  async getAdminUnreadCount({ role } = {}, trx = null) {
    const [{ count }] = await scopeAdminFeedToRole(
      (trx || db)('notifications').where({ recipient_type: 'admin' }),
      role,
    )
      .whereNull('read_at')
      .count('* as count');
    return parseInt(count);
  },

  // Get notifications for a customer
  async getCustomerNotifications(customerId, limit = 50, offset = 0) {
    return db('notifications')
      .where({ recipient_type: 'customer', recipient_id: customerId })
      .orderBy('created_at', 'desc')
      .limit(limit).offset(offset);
  },

  // Get unread count for customer
  async getCustomerUnreadCount(customerId) {
    const [{ count }] = await db('notifications')
      .where({ recipient_type: 'customer', recipient_id: customerId })
      .whereNull('read_at')
      .count('* as count');
    return parseInt(count);
  },

  // Mark as read
  async markRead(notificationId, customerId = null) {
    let q = db('notifications').where({ id: notificationId });
    if (customerId) q = q.where({ recipient_type: 'customer', recipient_id: customerId });
    const updated = await q.update({ read_at: new Date() });
    return updated > 0;
  },

  // Mark a single admin notification read — scoped to recipient_type 'admin' so
  // the admin endpoint can't clear a customer's notification by supplying its id
  // (admin notifications are the shared admin queue; customer rows are off-limits).
  async markReadAdmin(notificationId, { role } = {}) {
    // Same role predicate as the reads: a technician must not be able to
    // mark a hidden adminRoleOnly row read before the owner sees it.
    const updated = await scopeAdminFeedToRole(
      db('notifications').where({ id: notificationId, recipient_type: 'admin' }),
      role,
    ).update({ read_at: new Date() });
    return updated > 0;
  },

  // Mark all read for admin
  async markAllReadAdmin({ role } = {}) {
    await scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin' }),
      role,
    ).whereNull('read_at').update({ read_at: new Date() });
  },

  // Mark a customer's inbound_sms admin bells read — the ONE writer for
  // thread-scoped bell reads (thread open in Communications, and the webhook's
  // "thread was read while the bell was being written" post-check). Same
  // recipient/role scoping as every other admin read. `before` bounds to bells
  // that existed when the read request entered; `twilioSid` narrows to the
  // single bell written for one inbound message.
  async markInboundSmsReadAdmin({ customerId, before = new Date(), twilioSid = null, role } = {}) {
    if (!customerId) return 0;
    let q = scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin', category: 'inbound_sms' }),
      role,
    )
      .whereNull('read_at')
      .where('link', `/admin/communications?thread=${customerId}`)
      .where('created_at', '<=', before);
    if (twilioSid) q = q.whereRaw("metadata->'payload'->>'twilioSid' = ?", [twilioSid]);
    return q.update({ read_at: new Date() });
  },

  // A voicemail landed for a call the missed-call lane already rang for
  // (the recording callback can persist after the 2-minute missed-call
  // claim): the voicemail bell supersedes — retire the missed-call bell so
  // the owner never holds two contradictory alerts for one call. System
  // writer (no role scoping): every admin copy of that bell is retired.
  async supersedeMissedCallAdmin({ callLogId, callSid } = {}) {
    if (!callLogId && callSid) {
      const row = await db('call_log').where('twilio_call_sid', callSid).first('id');
      callLogId = row?.id || null;
    }
    if (!callLogId) return 0;
    return db('notifications')
      .where({ recipient_type: 'admin', category: 'missed_call' })
      .whereNull('read_at')
      .whereRaw("metadata->'payload'->>'callLogId' = ?", [String(callLogId)])
      .update({ read_at: new Date() });
  },

  // Mark all read for customer
  async markAllReadCustomer(customerId) {
    await db('notifications').where({ recipient_type: 'customer', recipient_id: customerId }).whereNull('read_at').update({ read_at: new Date() });
  },
};

function getCategoryIcon(category) {
  const icons = {
    inbound_sms: '\u{1F4AC}', approval: '\u2705', new_lead: '\u{1F514}', estimate: '\u{1F4CB}',
    payment: '\u{1F4B0}', review: '\u2B50', schedule: '\u{1F4C5}', churn_risk: '\u26A0\uFE0F',
    token_alert: '\u{1F511}', system: '\u{1F527}',
    knowledge: '\u{1F4DA}',
    service: '\u{1F3E0}', appointment: '\u{1F4C5}', billing: '\u{1F4B3}', document: '\u{1F4C4}',
    lawn_health: '\u{1F331}', referral: '\u{1F381}', account: '\u{1F464}',
  };
  return icons[category] || '\u{1F514}';
}

module.exports = NotificationService;
module.exports._private = {
  CUSTOMER_PREFERENCE_KEYS,
  customerPreferenceEnabled,
  existingCustomerNotification,
};
