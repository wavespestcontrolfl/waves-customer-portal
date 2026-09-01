/**
 * Owner-side "reading it now" bell (GATE_ESTIMATE_HOT_VIEW_ALERT).
 *
 * The engagement engine already computes multi_view_high_intent on every
 * page open (>= minSessions sittings inside windowHours, both DB-tunable in
 * estimate_followup_rules.params) — and today the only thing it does with a
 * match is queue a customer email. Accepters revisit their estimate about
 * five times over five days (prod read 2026-09-01); the third sitting is the
 * highest-intent moment the business has, and the owner learns about it
 * hours later, if at all. This module turns that same match into ONE admin
 * notification per estimate per 24h so the owner can call while the page is
 * open in front of the customer.
 *
 * Contract:
 * - NOT a customer message. Nothing here reaches the customer; the email
 *   job path and shadow accounting in the engine are untouched.
 * - Rule 14 caveat: this IS a bell. It is scoped to one per estimate per
 *   day, durably deduped through notifyAdmin's shared rolling-window
 *   dedupe (never in memory, never a service-local lock),
 *   and its category is silent by default: the owner turns it on under push
 *   settings (category:estimate_hot_view). That default is enforced HERE,
 *   not only by the admin bell policy gate, which ships off.
 * - Never throws: a failure here must not break the view hook.
 */

const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const NotificationService = require('./notification-service');
const bellPolicy = require('./notification-bell-policy');

const HOT_VIEW_CATEGORY = 'estimate_hot_view';
const HOT_VIEW_DEDUPE_HOURS = 24;
// Engine defaults, mirrored from estimate-engagement-engine DEFAULT_RULE_PARAMS
// so a rule row missing a knob still behaves like the engine's own match.
const DEFAULT_MIN_SESSIONS = 3;
const DEFAULT_WINDOW_HOURS = 72;

function ordinal(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0) return `${n}`;
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th';
  return `${v}${suffix}`;
}

function moneyPerMonth(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n % 1 === 0 ? n : n.toFixed(2)}/mo`;
}

/**
 * Decide + dedupe + send. Returns { raised, reason } for the caller's log
 * line; resolves (never rejects) on every path.
 *
 * @param {object} estimate  the estimates row (id, customer_id, customer_name,
 *                           address, monthly_total)
 * @param {Array}  sessions  sessionized views (estimate-engagement-sessions)
 * @param {object} rule      the multi_view_high_intent rule row incl. params
 * @param {Date}   now
 * @param {function} notify  NotificationService.notifyAdmin (injectable)
 */
async function maybeRaiseHotViewAlert({
  estimate,
  sessions,
  rule,
  now = new Date(),
  notify = (...args) => NotificationService.notifyAdmin(...args),
  gateOn = () => isEnabled('estimateHotViewAlert'),
  categoryAllowed = () => bellPolicy.bellAllowed({ category: HOT_VIEW_CATEGORY }),
} = {}) {
  try {
    if (!gateOn()) return { raised: false, reason: 'gate_off' };
    if (!estimate || !estimate.id) return { raised: false, reason: 'no_estimate' };
    // "Silent until the owner enables the category" must hold REGARDLESS of
    // GATE_ADMIN_BELL_POLICY (pre-push codex P1): notifyAdmin only consults
    // the category override while that gate is on, and it ships off, so
    // enabling this feature alone would ring every match. Read the same
    // owner override the policy reads (category:estimate_hot_view in
    // notification_preferences; not on the allowlist, so absent = silent)
    // and stay out of the table entirely until it is true. With the policy
    // gate on, notifyAdmin applies the identical verdict a second time.
    if (!(await categoryAllowed())) return { raised: false, reason: 'category_silent' };
    const params = (rule && rule.params) || {};
    const minSessions = Number(params.minSessions) > 0 ? Number(params.minSessions) : DEFAULT_MIN_SESSIONS;
    const windowHours = Number(params.windowHours) > 0 ? Number(params.windowHours) : DEFAULT_WINDOW_HOURS;
    const windowStart = now.getTime() - windowHours * 3600000;
    const recent = (Array.isArray(sessions) ? sessions : [])
      .filter((s) => s && s.startedAt && new Date(s.startedAt).getTime() >= windowStart).length;
    if (recent < minSessions) return { raised: false, reason: 'below_threshold' };

    const who = String(estimate.customer_name || '').trim() || 'A customer';
    const bodyParts = [`${ordinal(recent)} visit in ${windowHours}h`];
    const money = moneyPerMonth(estimate.monthly_total);
    const tail = [money, String(estimate.address || '').trim() || null].filter(Boolean).join(', ');
    if (tail) bodyParts.push(tail);
    const title = `${who} is reading their estimate again`;
    const body = bodyParts.join(' — ');
    // Durable ROLLING 24h dedupe through the SHARED admin mechanism
    // (NotificationService.notifyAdmin dedupeKey + dedupeWindowMs): one
    // stable per-estimate key, so two opens straddling a day boundary
    // contend on the same advisory lock inside notifyAdmin's own transaction
    // and the insert rides that transaction (GH codex P1 on #3709 — no
    // service-local lock/existence implementation to drift from the shared
    // one). notifyAdmin fails CLOSED (null) when the lock or read fails.
    const opts = {
      // Same deep-link the estimate bells already use; EstimatesPageV2
      // scrolls to ?estimateId=<id>.
      link: `/admin/estimates?estimateId=${estimate.id}`,
      metadata: { estimateId: estimate.id, customerId: estimate.customer_id || null, sessions: recent },
      dedupeKey: `${HOT_VIEW_CATEGORY}:${estimate.id}`,
      dedupeWindowMs: HOT_VIEW_DEDUPE_HOURS * 3600000,
    };
    const result = await notify(HOT_VIEW_CATEGORY, title, body, opts);
    const outcome = !result
      ? { raised: false, reason: 'notify_failed' }
      : result.deduped
        ? { raised: false, reason: 'deduped' }
        : { raised: true, reason: result.suppressed ? 'suppressed' : 'sent' };
    if (outcome.raised) {
      logger.info(`[est-hot-view] raised for estimate ${estimate.id} (${recent} sessions / ${windowHours}h)`);
    }
    return outcome;
  } catch (err) {
    logger.warn(`[est-hot-view] alert failed for estimate ${estimate?.id}: ${err.message}`);
    return { raised: false, reason: 'error' };
  }
}

module.exports = {
  HOT_VIEW_CATEGORY,
  HOT_VIEW_DEDUPE_HOURS,
  maybeRaiseHotViewAlert,
  _private: { ordinal, moneyPerMonth },
};
