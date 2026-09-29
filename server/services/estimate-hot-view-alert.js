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
const db = require('../models/db');
const { isEnabled, alertEpisodesLive } = require('../config/feature-gates');
const { TERMINAL_ESTIMATE_STATUSES } = require('../utils/estimate-claim-sql');
const NotificationService = require('./notification-service');
const alertEpisodes = require('./admin-alert-episodes');
const bellPolicy = require('./notification-bell-policy');

const HOT_VIEW_CATEGORY = 'estimate_hot_view';
const HOT_VIEW_DEDUPE_HOURS = 24;
// Engine defaults, mirrored from estimate-engagement-engine DEFAULT_RULE_PARAMS
// so a rule row missing a knob still behaves like the engine's own match.
const DEFAULT_MIN_SESSIONS = 3;
const DEFAULT_WINDOW_HOURS = 72;
const HOT_VIEW_KEY_PREFIX = `${HOT_VIEW_CATEGORY}:`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Maps the raise result to the caller's { raised, reason }. Under the wrapper
// `rang` says whether the call created a row or re-rang one; a reopen reports
// deduped from notifyAdmin (it refreshed the standing row) yet is a real ring.
// Without the wrapper `rang` is absent and `deduped` alone decides, as before.
function outcomeOf(result, episodes) {
  if (!result) return { raised: false, reason: 'notify_failed' };
  if (result.deduped && !(episodes && result.rang === true)) return { raised: false, reason: 'deduped' };
  if (result.suppressed) return { raised: true, reason: 'suppressed' };
  return { raised: true, reason: result.deduped ? 'reopened' : 'sent' };
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
 * @param {function} raise   alertEpisodes.raiseAdminAlertWithReopen
 *                           (injectable); used instead of `notify` while
 *                           ALERT_EPISODES is live
 */
async function maybeRaiseHotViewAlert({
  estimate,
  sessions,
  rule,
  now = new Date(),
  notify = (...args) => NotificationService.notifyAdmin(...args),
  raise = (...args) => alertEpisodes.raiseAdminAlertWithReopen(...args),
  episodesLive = () => alertEpisodesLive(),
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
    // Episodes (ALERT_EPISODES): the reopen wrapper — a bell the settle pass
    // auto-cleared (accepted / declined / expired / archived) rings again on
    // a new hot streak, while a standing row stays a silent dedupe. Killed:
    // exactly the pre-episode notifyAdmin call.
    const episodes = episodesLive();
    const result = episodes
      ? await raise(HOT_VIEW_CATEGORY, title, body, opts)
      : await notify(HOT_VIEW_CATEGORY, title, body, opts);
    const outcome = outcomeOf(result, episodes);
    if (outcome.raised) {
      logger.info(`[est-hot-view] raised for estimate ${estimate.id} (${recent} sessions / ${windowHours}h)`);
    }
    return outcome;
  } catch (err) {
    logger.warn(`[est-hot-view] alert failed for estimate ${estimate?.id}: ${err.message}`);
    return { raised: false, reason: 'error' };
  }
}

// Why an estimate's hot bell is done, or null while the estimate is still open.
// A missing row is gone; a terminal status wins over an archive stamp.
function settledReason(row) {
  if (!row) return 'estimate gone';
  const status = String(row.status || '').toLowerCase();
  if (TERMINAL_ESTIMATE_STATUSES.includes(status)) return `estimate ${status}`;
  return row.archived_at ? 'estimate archived' : null;
}

/**
 * Episodes close pass: mark read + auto-cleared every open hot-estimate bell
 * whose estimate has settled — accepted, declined, expired, archived, or gone
 * — so it stops standing unread, and a later hot streak (an estimate
 * unarchived and viewed again) rings a fresh episode through
 * raiseAdminAlertWithReopen. An open estimate's bell is never touched. Runs
 * only while ALERT_EPISODES is live AND the hot-view gate is on (gate off =
 * nothing at all, as before). Read-only against `estimates`; the only write
 * is the notification close. Never throws (the scheduler tick calls it
 * best-effort after the engine's own work).
 *
 * @returns {Promise<{ran: boolean, open: number, closed: number, reasons: object}>}
 */
async function closeSettledHotViewAlerts({
  now = new Date(),
  conn = db,
  gateOn = () => isEnabled('estimateHotViewAlert'),
  episodesLive = () => alertEpisodesLive(),
} = {}) {
  const result = { ran: false, open: 0, closed: 0, reasons: {} };
  try {
    if (!episodesLive() || !gateOn()) return result;
    result.ran = true;
    const keys = await alertEpisodes.openAdminAlertKeys(conn, HOT_VIEW_KEY_PREFIX);
    result.open = keys.length;
    if (!keys.length) return result;

    // Key -> estimate id. A key whose id is not a uuid cannot name an
    // estimate row (and would fail the uuid comparison), so it closes as gone.
    const idOf = (key) => String(key).slice(HOT_VIEW_KEY_PREFIX.length);
    const ids = [...new Set(keys.map(idOf).filter((id) => UUID_RE.test(id)))];
    const rows = ids.length
      ? await conn('estimates').whereIn('id', ids).select('id', 'status', 'archived_at')
      : [];
    const byId = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));

    // Each settled key closes in its own transaction, under the same per-key
    // advisory lock raiseAdminAlertWithReopen takes, after reading its
    // estimate AGAIN: an estimate made active and viewed hot since the read
    // above either raised first (the re-read sees it open, and nothing closes)
    // or raises after the close (the bell is auto-cleared, so it rings again).
    const settled = keys.filter((key) => settledReason(UUID_RE.test(idOf(key)) ? byId.get(idOf(key).toLowerCase()) : null));
    for (const key of settled) {
      const reason = await conn.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${key}`]);
        const id = idOf(key);
        const why = settledReason(UUID_RE.test(id) ? await trx('estimates').where({ id }).first('id', 'status', 'archived_at') : null);
        const closed = why ? Number(await alertEpisodes.closeAdminAlertKeys(trx, [key], why, { now })) || 0 : 0;
        return closed > 0 ? why : null;
      });
      if (!reason) continue;
      result.closed += 1;
      result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    }
    if (result.closed > 0) {
      logger.info(`[est-hot-view] closed ${result.closed} settled hot-estimate alert(s): ${JSON.stringify(result.reasons)}`);
    }
    return result;
  } catch (err) {
    logger.warn(`[est-hot-view] settle pass failed: ${err.message}`);
    return result;
  }
}

module.exports = {
  HOT_VIEW_CATEGORY,
  HOT_VIEW_DEDUPE_HOURS,
  maybeRaiseHotViewAlert,
  closeSettledHotViewAlerts,
  _private: { ordinal, moneyPerMonth },
};
