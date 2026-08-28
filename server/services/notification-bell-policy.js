/**
 * Admin bell policy — GATE_ADMIN_BELL_POLICY (default OFF, byte-identical
 * behavior when off).
 *
 * When ON, the shared admin bell rings ONLY for the lanes the owner actually
 * acts on: new leads, inbound SMS, voicemail callbacks, accepted estimates,
 * and money failures (payment failures, billing exceptions, disputes, refund
 * failures, PCI events) — plus twilio_failure (infra-down must keep ringing).
 * Everything else is silenced at the NotificationService.create chokepoint
 * (no row inserted), with a per-category owner override so any silenced
 * category can be re-enabled from Settings → Notifications.
 *
 * Decision order (first match wins):
 *   1. Explicit site-level tag: options.bell === true / false
 *   2. triggerKey allowlist (registry-routed events that must ring)
 *   3. triggerKey denylist — beats the category allowlist (payment FYIs and
 *      the alert firehose share categories with events that must ring)
 *   4. Owner category override: notification_preferences rows with
 *      trigger_key = 'category:<category>' (any active admin's row counts —
 *      the bell is global, matching bellWritten semantics; true wins over
 *      false when admins disagree, same as the per-trigger bell loop)
 *   5. category allowlist (covers the 79 direct notifyAdmin call sites)
 *   6. default: denied
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const TRIGGER_BELL_ALLOWLIST = new Set([
  'new_lead',
  'sms_reply',
  // A reschedule/away text with a visit still armed is time-critical — its
  // 'schedule' category is silenced-by-default, so the key must ring here.
  'appointment_reschedule_intent',
  'customer_voicemail_callback',
  // An email from someone on the customer list — same class as sms_reply.
  'customer_email_received',
  'payment_failed',
  'bill_payment_error',
  // Owner ruling 2026-08-28: the bell is for what Adam ACTS on today, and
  // push follows the bell (one routing decision per event). Removed from the
  // ring list — silent on BOTH surfaces by default: twilio_failure (infra;
  // the canaries' direct internal_alert SMS to the owner is unaffected) and
  // estimate_deposit_reconcile_needed (deposit ledger mismatch). Both are
  // re-enabled together through the 'system' category override.
]);

const TRIGGER_BELL_DENYLIST = new Set([
  'payment_succeeded',
  'payment_refunded',
  'dashboard_alert',
  'internal_admin_alert',
]);

const CATEGORY_BELL_ALLOWLIST = new Set([
  'new_lead',
  'inbound_sms',
  'inbound_email',
  'voicemail_callback',
  'payment',
  'billing',
  'dispute',
]);

// Fixed list of silenced-by-default categories the owner may re-enable via
// the 'category:<cat>' pseudo-keys in notification_preferences. Also the
// validation list for PUT /api/admin/push/preferences — unknown category
// keys are rejected. Longest entry ('category:social_compliance_rejected',
// 35 chars) fits trigger_key varchar(50).
// INVARIANT: every admin category the portal emits that is NOT on
// CATEGORY_BELL_ALLOWLIST must appear here — a suppressible category the
// owner cannot re-enable is a dead letterbox. When adding a new admin
// notification category, add it to one of the two lists (and to
// BELL_CATEGORY_LABELS in client PushSettingsV2.jsx if it lands here).
const OVERRIDABLE_CATEGORIES = [
  // Owner ruling 2026-08-28: no longer ring by default (accepted estimates
  // still ring via their explicit bell:true site tag).
  'estimate_converted',
  'estimate_measurement_review',
  'alert',
  'system',
  'service',
  'lead',
  'estimate',
  'agents',
  'newsletter',
  'content',
  'knowledge',
  'review',
  'credential',
  'stale_visit_sweep',
  'wdo_report_attention',
  'schedule',
  'schedule_conflict',
  'email_digest',
  'token_alert',
  'tax',
  'payout',
  'call_pipeline_drift',
  'social_compliance_rejected',
  'customer',
  'eval_regression',
  'service-prefs',
  'email_alert',
  'email_rescue',
  'email_rescue_review',
];
const OVERRIDABLE_CATEGORY_SET = new Set(OVERRIDABLE_CATEGORIES);

function isBellPolicyEnabled() {
  return isEnabled('adminBellPolicy');
}

// ~60s cache so the policy check doesn't add a query per notification.
// On query failure the STALE map (or an empty one) is used — the static
// lists still apply, notifications never break on a flaky prefs read.
const OVERRIDE_CACHE_MS = 60 * 1000;
let overrideCache = { at: 0, map: null };

async function loadCategoryOverrides() {
  const now = Date.now();
  if (overrideCache.map && (now - overrideCache.at) < OVERRIDE_CACHE_MS) {
    return overrideCache.map;
  }
  try {
    const rows = await db('notification_preferences')
      .join('technicians', 'technicians.id', 'notification_preferences.admin_user_id')
      .where('technicians.active', true)
      // Category overrides are OWNER controls on the shared bell — only
      // admin-role rows count. A field tech's row (whether written before
      // the PUT-side role gate existed, or via any other path) must never
      // re-open a silenced category globally.
      .where('technicians.role', 'admin')
      .where('notification_preferences.trigger_key', 'like', 'category:%')
      .select('notification_preferences.trigger_key', 'notification_preferences.bell_enabled');
    const map = new Map();
    for (const row of rows) {
      const cat = String(row.trigger_key).slice('category:'.length);
      // true wins over false across admins (bell is global — one admin
      // opting a category back in rings the shared bell).
      if (row.bell_enabled === true) map.set(cat, true);
      else if (!map.has(cat)) map.set(cat, false);
    }
    overrideCache = { at: now, map };
    return map;
  } catch (err) {
    logger.warn(`[bell-policy] category override query failed: ${err.message}`);
    return overrideCache.map || new Map();
  }
}

// Called by the preferences PUT so a toggle applies immediately instead of
// up to 60s later.
function clearOverrideCache() {
  overrideCache = { at: 0, map: null };
}

/**
 * Should this admin-recipient notification be inserted into the bell?
 * Only meaningful when isBellPolicyEnabled() — callers check the gate first.
 * Never throws.
 */
async function bellAllowed({ category, triggerKey, options = {} } = {}) {
  if (options.bell === true) return true;
  if (options.bell === false) return false;
  if (triggerKey && TRIGGER_BELL_ALLOWLIST.has(triggerKey)) return true;
  if (triggerKey && TRIGGER_BELL_DENYLIST.has(triggerKey)) return false;
  const overrides = await loadCategoryOverrides();
  if (category && overrides.has(category)) return overrides.get(category) === true;
  if (category && CATEGORY_BELL_ALLOWLIST.has(category)) return true;
  return false;
}

module.exports = {
  isBellPolicyEnabled,
  bellAllowed,
  clearOverrideCache,
  OVERRIDABLE_CATEGORIES,
  OVERRIDABLE_CATEGORY_SET,
  _private: {
    TRIGGER_BELL_ALLOWLIST,
    TRIGGER_BELL_DENYLIST,
    CATEGORY_BELL_ALLOWLIST,
    loadCategoryOverrides,
  },
};
