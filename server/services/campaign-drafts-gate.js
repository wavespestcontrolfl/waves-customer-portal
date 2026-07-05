/**
 * Campaign pre-send gate — the ONE guard stack for the existing-customer
 * campaign lane, shared by BOTH moments a draft can move (mirrors the
 * click-tracking lane's services/click-followup-gate.js):
 *
 *   1. DRAFT time — the generators (campaign-drafts.js daily upsell cron,
 *      workflows/seasonal-reactivation.js Monday cron) evaluate the gate per
 *      candidate before writing a pending message_drafts row, and
 *   2. SEND time  — routes/admin-drafts.js approve/revise re-evaluates the
 *      SAME gate before an owner-approved campaign draft reaches the
 *      provider, because every one of these conditions can change while a
 *      draft sits pending (the customer rebooks or churns, another campaign
 *      lane sends, the linked opportunity gets pitched elsewhere, prefs
 *      flip, a prepay notice fires).
 *
 * Sharing one module is the point: a guard added here protects both moments
 * automatically — there is no way to fix the generators and forget the
 * approval path again.
 *
 * evaluateCampaignSendGate(input)
 *   → { ok: true, customer } | { ok: false, code, reason?, customer? }
 *
 * Codes and how callers are expected to map them:
 *   TERMINAL (TERMINAL_CODES) — approval: retire the draft (status
 *   'rejected' + flags.campaign_rejected_reason). Generators: skip candidate.
 *     customer_not_found   no resolvable customer row
 *     customer_deleted     soft-deleted since drafting
 *     customer_not_live    (upsell) no longer active + in a live stage
 *     not_lapsed           (reactivation) rebooked / promoted to a live
 *                          stage while pending — retire; if they lapse
 *                          again the next weekly run writes a FRESH draft
 *     opportunity_missing  (upsell) source_ref row no longer exists
 *     opportunity_closed   (upsell) opportunity left status='identified'
 *                          (pitched/accepted/declined/deferred elsewhere —
 *                          retention agent or the customer-intel route)
 *     prefs_opted_out      sms_enabled / seasonal_tips explicitly false
 *   HOLD (HOLD_CODES) — approval: 409, claim released, draft LEFT PENDING
 *   with a retry hint. Generators: skip candidate.
 *     cooldown_active      unified 30d cross-lane cooldown — another
 *                          campaign draft, a campaign-grade SMS
 *                          (upsell/renewal/reactivation/retention_outreach
 *                          from any still-live auto lane), or a prepay
 *                          renewal notice inside the window. `reason`
 *                          carries the specific trigger.
 *   TRANSIENT — approval: 503, claim released, draft stays pending.
 *   Generators: skip candidate.
 *     guard_error          a lookup failed — fail CLOSED.
 *
 * THIS MODULE NEVER SENDS AND NEVER WRITES — it only reads state and
 * returns a verdict.
 */

const db = require('../models/db');
const logger = require('./logger');
const { CUSTOMER_STAGES } = require('./customer-stages');

const COOLDOWN_DAYS = 30;
const COOLDOWN_INTERVAL = `NOW() - INTERVAL '${COOLDOWN_DAYS} days'`;

// message_type values written by the four existing campaign-grade senders:
// upsell-trigger ('upsell'), renewal-reminder ('renewal'), legacy
// seasonal-reactivation sends + approved reactivation drafts ('reactivation'),
// retention agent ('retention_outreach'). Approved campaign drafts log the
// same values (admin-drafts CAMPAIGN_MESSAGE_TYPES), so this filter sees them.
const CAMPAIGN_SMS_TYPES = ['upsell', 'renewal', 'reactivation', 'retention_outreach'];

const TERMINAL_CODES = new Set([
  'customer_not_found',
  'customer_deleted',
  'customer_not_live',
  'not_lapsed',
  'opportunity_missing',
  'opportunity_closed',
  'prefs_opted_out',
]);
const HOLD_CODES = new Set(['cooldown_active']);
const TRANSIENT_CODES = new Set(['guard_error']);
const VERDICT_CODES = [...TERMINAL_CODES, ...HOLD_CODES, ...TRANSIENT_CODES];

// Live customer (upsell targets): mirrors whereLiveCustomer semantics on a
// single row.
function isLiveCustomerRow(c) {
  return !!c && c.active === true && CUSTOMER_STAGES.includes(c.pipeline_stage);
}

// Lapsed customer (reactivation targets): the branched predicate the audience
// query uses — churned requires the cancellation-processor stamps
// (active=false + churned_at); dormant matches on the stage alone
// (pipeline-manager sets only pipeline_stage).
function isLapsedCustomerRow(c) {
  if (!c) return false;
  if (c.pipeline_stage === 'dormant') return true;
  return c.pipeline_stage === 'churned' && c.active === false && !!c.churned_at;
}

function parseOpportunityRef(sourceRef) {
  const m = /^upsell_opportunities:(.+)$/.exec(String(sourceRef || ''));
  return m ? m[1] : null;
}

/**
 * sms_enabled / seasonal_tips must not be explicitly false. A missing
 * notification_prefs row passes here (both columns default true, and the
 * default-row backfill covers existing customers) — the consent validator
 * re-checks at send time and fails closed regardless.
 */
async function prefsAllowMarketingSms(customerId) {
  const prefs = await db('notification_prefs')
    .where({ customer_id: customerId })
    .first('sms_enabled', 'seasonal_tips');
  if (!prefs) return true;
  return prefs.sms_enabled !== false && prefs.seasonal_tips !== false;
}

/**
 * Unified 30-day campaign cooldown. Returns a skip-reason string when the
 * customer was already touched by any campaign lane, else null:
 *   - a campaign draft (any campaign_type, any status) written in the window
 *     — excludeDraftId exempts the draft currently being approved, so a
 *     draft's own row never blocks its own send
 *   - a campaign-grade SMS (CAMPAIGN_SMS_TYPES) logged in the window
 *   - an annual-prepay renewal notice (notice_30/15/7_sent_at) fired in the
 *     window — those customers are mid-renewal-conversation, leave them be.
 */
async function campaignCooldownReason(customerId, { excludeDraftId = null } = {}) {
  let draftQuery = db('message_drafts')
    .where({ customer_id: customerId })
    .whereNotNull('campaign_type')
    .where('created_at', '>', db.raw(COOLDOWN_INTERVAL));
  if (excludeDraftId) draftQuery = draftQuery.whereNot('id', excludeDraftId);
  const recentDraft = await draftQuery.first('id');
  if (recentDraft) return 'recent_campaign_draft';

  const recentCampaignSms = await db('sms_log')
    .where({ customer_id: customerId })
    .whereIn('message_type', CAMPAIGN_SMS_TYPES)
    .where('created_at', '>', db.raw(COOLDOWN_INTERVAL))
    .first('id');
  if (recentCampaignSms) return 'recent_campaign_sms';

  const recentPrepayNotice = await db('annual_prepay_terms')
    .where({ customer_id: customerId })
    .where(function () {
      this.where('notice_30_sent_at', '>', db.raw(COOLDOWN_INTERVAL))
        .orWhere('notice_15_sent_at', '>', db.raw(COOLDOWN_INTERVAL))
        .orWhere('notice_7_sent_at', '>', db.raw(COOLDOWN_INTERVAL));
    })
    .first('id');
  if (recentPrepayNotice) return 'recent_prepay_notice';

  return null;
}

/**
 * The shared gate. See the module doc for codes and caller mapping.
 *
 * @param {Object} input
 * @param {string} input.campaignType     'reactivation' | 'upsell'
 * @param {string|null} input.customerId
 * @param {string|null} [input.sourceRef]  draft provenance ('upsell_opportunities:<id>')
 * @param {string|null} [input.excludeDraftId] the draft being approved — its
 *                                         own row must not trip the cooldown
 * @param {Object|null} [input.customer]   freshly-read customers row (the
 *                                         generators inject the row their
 *                                         source query just returned; the
 *                                         approval path omits it to force a
 *                                         fresh read)
 * @param {Object|null} [input.opportunity] freshly-read opportunity row
 *                                          (same injection contract)
 */
async function evaluateCampaignSendGate({
  campaignType,
  customerId,
  sourceRef = null,
  excludeDraftId = null,
  customer = null,
  opportunity = null,
}) {
  try {
    if (!customerId) return { ok: false, code: 'customer_not_found' };

    const cust = customer || await db('customers')
      .where({ id: customerId })
      .first('id', 'deleted_at', 'active', 'pipeline_stage', 'churned_at', 'nearest_location_id');
    if (!cust) return { ok: false, code: 'customer_not_found' };
    if (cust.deleted_at) return { ok: false, code: 'customer_deleted', customer: cust };

    if (campaignType === 'upsell' && !isLiveCustomerRow(cust)) {
      return { ok: false, code: 'customer_not_live', customer: cust };
    }
    if (campaignType === 'reactivation' && !isLapsedCustomerRow(cust)) {
      return { ok: false, code: 'not_lapsed', customer: cust };
    }

    if (campaignType === 'upsell') {
      const oppId = parseOpportunityRef(sourceRef);
      // A generator-written upsell draft always carries the ref; when it is
      // absent/unparseable there is no provenance row to re-check (or to
      // mark pitched), so the remaining guards decide.
      if (oppId) {
        const opp = opportunity || await db('upsell_opportunities')
          .where({ id: oppId })
          .first('id', 'status');
        if (!opp) return { ok: false, code: 'opportunity_missing', customer: cust };
        if (opp.status !== 'identified') {
          return { ok: false, code: 'opportunity_closed', reason: opp.status, customer: cust };
        }
      }
    }

    if (!(await prefsAllowMarketingSms(customerId))) {
      return { ok: false, code: 'prefs_opted_out', customer: cust };
    }

    const cooldown = await campaignCooldownReason(customerId, { excludeDraftId });
    if (cooldown) return { ok: false, code: 'cooldown_active', reason: cooldown, customer: cust };

    return { ok: true, customer: cust };
  } catch (err) {
    logger.warn(`[campaign-drafts-gate] guard lookup failed - failing closed: ${err.message}`);
    return { ok: false, code: 'guard_error', reason: err.message };
  }
}

module.exports = {
  evaluateCampaignSendGate,
  campaignCooldownReason,
  prefsAllowMarketingSms,
  isLiveCustomerRow,
  isLapsedCustomerRow,
  parseOpportunityRef,
  CAMPAIGN_SMS_TYPES,
  COOLDOWN_DAYS,
  TERMINAL_CODES,
  HOLD_CODES,
  TRANSIENT_CODES,
  VERDICT_CODES,
};
