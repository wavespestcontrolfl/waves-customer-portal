/**
 * Who gets the weekly events email, and which phase of the first-readers step it is in.
 *
 * Owner 2026-11-26 ("ok go" on the plan page): no weekly issue has gone out since 2025-07-03, so
 * the first weekly issues go only to warm readers, the people who opened a Waves email in the
 * last 90 days (newsletter-warm-audience.js, the rule the Waves Pest Insider planner also
 * uses). After WARM_ISSUES issues have gone out that way, the weekly goes to every active reader.
 *
 * Why 3: one issue says little about the group (a single Thursday can be a holiday, a storm or a
 * bad lineup), and a re-started stream earns its sender reputation over a few clean sends before
 * the whole list is added. Three weekly issues give the warm readers three chances to open, click
 * or complain, and the owner three weeks to see it in History before the larger audience is added
 * (about 98 warm readers against 629 active on 2026-11-26). Change WARM_ISSUES to change this.
 *
 * Each issue records its phase on newsletter_sends.audience_phase ('warm' or 'all') when its
 * draft is built, so every send's audience is auditable. A warm issue also carries its reader
 * list in segment_filter ({ subscriber_ids, holdout: 'weekly-warm', address_keys }), which the
 * sender checks again right before each batch: a reader who unsubscribed, or whose address changed
 * after the plan, is skipped. The weekly has no holdout group (the name is only how the sender
 * recognizes a planned audience), so nobody is held out here.
 *
 * Only issues that went out ('sent') and reached at least one reader (a delivery row passing the
 * sender's reachedDelivery rule) count toward WARM_ISSUES. A held, skipped or failed issue, or a
 * 'sent' one whose rows were all skipped or bounced, does not use up a warm step, so the
 * widening waits for three issues readers actually got.
 *
 * The sender refuses a weekly issue whose phase is missing or whose warm list is missing
 * (newsletter-sender.js audienceRefusal), so a draft that never got a phase cannot reach the
 * whole list by accident.
 */
'use strict';

const db = require('../models/db');
const logger = require('./logger');
const {
  WARM_DAYS, DAY_MS, addressKey, warmAudienceQuery,
} = require('./newsletter-warm-audience');

/** Weekly issues that go to warm readers only, before the list is widened. */
const WARM_ISSUES = 3;
const PHASE_WARM = 'warm';
const PHASE_ALL = 'all';
/** The name the send's segment_filter gives the weekly warm audience (newsletter-sender.js SEND_HOLDOUTS). */
const WEEKLY_WARM_PLAN = 'weekly-warm';

/**
 * Weekly issues readers already got in the warm phase: 'sent' issues of the warm phase with at
 * least one delivery row that reached its reader by the sender's own rule (reachedDelivery). A
 * 'sent' issue whose rows were all skipped, bounced or dropped reached nobody, so it does not use
 * up a warm step. Counted by phase alone, not by type, so a legacy flagship row with no type
 * (promoted by its calendar link) counts too.
 */
async function sentWarmIssueCount(knex = db) {
  // Loaded here, not at the top: newsletter-sender.js loads this module.
  const { reachedDelivery } = require('./newsletter-sender');
  const row = await knex('newsletter_sends as s')
    .where({ 's.audience_phase': PHASE_WARM, 's.status': 'sent' })
    .whereExists((sub) => {
      reachedDelivery(sub.select(knex.raw('1')).from('newsletter_send_deliveries as d').whereRaw('d.send_id = s.id'));
    })
    .count('* as c')
    .first();
  return Number(row?.c) || 0;
}

/** The phase the next weekly issue uses, given how many warm issues already went out. */
function phaseForSentWarmIssues(sentWarmIssues) {
  return sentWarmIssues < WARM_ISSUES ? PHASE_WARM : PHASE_ALL;
}

/**
 * The warm readers as of `asOf`: subscriber ids (ascending) and the key of the address that
 * qualified, by id. Runs the send path's archived-link relink sweep first, as every audience read
 * does.
 */
async function selectWarmReaders({ asOf = new Date(), knex = db } = {}) {
  const NewsletterSubscribers = require('./newsletter-subscribers');
  await NewsletterSubscribers.relinkArchivedLinkedSubscribers(knex);
  const rows = await warmAudienceQuery({ since: new Date(asOf.getTime() - WARM_DAYS * DAY_MS), until: asOf });
  const subscriberIds = [];
  const addressKeys = {};
  for (const row of rows) {
    const id = Number(row.id);
    subscriberIds.push(id);
    addressKeys[id] = addressKey(row.email);
  }
  return { subscriberIds, addressKeys };
}

/** The segment_filter that makes the send path mail exactly these warm readers, each at the address that qualified. */
function warmSegmentFilter({ subscriberIds, addressKeys }) {
  return { subscriber_ids: [...subscriberIds], holdout: WEEKLY_WARM_PLAN, address_keys: { ...addressKeys } };
}

/**
 * The next weekly issue's audience: its phase, its segment_filter (null for everyone) and the
 * counts behind it.
 * @returns {Promise<{ phase: 'warm'|'all', segmentFilter: object|null, sentWarmIssues: number, warmReaders: number|null }>}
 */
async function planWeeklyAudience({ asOf = new Date(), knex = db } = {}) {
  const sentWarmIssues = await sentWarmIssueCount(knex);
  const phase = phaseForSentWarmIssues(sentWarmIssues);
  if (phase === PHASE_ALL) return { phase, segmentFilter: null, sentWarmIssues, warmReaders: null };
  const readers = await selectWarmReaders({ asOf, knex });
  return {
    phase,
    segmentFilter: warmSegmentFilter(readers),
    sentWarmIssues,
    warmReaders: readers.subscriberIds.length,
  };
}

/**
 * Give a flagship draft its audience phase, once. A draft that already has a phase, or is not a
 * draft any more, is returned as it is. The write does not touch updated_at: choosing the
 * audience is not an edit of the issue, and an edit after the owner's copy would read as stale.
 * Returns the row as stored afterwards.
 */
async function ensureFlagshipAudience(send, { asOf = new Date(), knex = db } = {}) {
  if (!send || send.audience_phase || send.status !== 'draft') return send;
  // Lazy: newsletter-event-selection pulls the event stack. A send with no type is a flagship when
  // the flagship calendar links it, the same rule the sender and the lineup gates use.
  const { isFlagshipSend } = require('./newsletter-event-selection');
  if (!(await isFlagshipSend(send, { knex }))) return send;
  const plan = await planWeeklyAudience({ asOf, knex });
  const updated = await knex('newsletter_sends')
    .where({ id: send.id, status: 'draft' })
    .whereNull('audience_phase')
    .update({
      audience_phase: plan.phase,
      segment_filter: plan.segmentFilter ? JSON.stringify(plan.segmentFilter) : null,
    });
  if (updated) {
    logger.info(`[newsletter-weekly-audience] send ${send.id} audience phase ${plan.phase}`
      + (plan.phase === PHASE_WARM
        ? ` (warm issue ${plan.sentWarmIssues + 1} of ${WARM_ISSUES}, ${plan.warmReaders} warm readers)`
        : ` (${plan.sentWarmIssues} warm issues already sent)`));
  }
  return (await knex('newsletter_sends').where({ id: send.id }).first()) || send;
}

/** ensureFlagshipAudience that logs a failure instead of throwing (the autopilot's draft must survive it). */
async function recordFlagshipAudience(send, options) {
  try {
    return await ensureFlagshipAudience(send, options);
  } catch (err) {
    logger.warn(`[newsletter-weekly-audience] audience phase not recorded for send ${send?.id}: ${err.message}`);
    return send;
  }
}

/**
 * What the owner's copy says about the audience: { phase, issueNumber, of } for a warm issue,
 * null for anything else (the copy then reads as before).
 */
async function warmPhaseNote(send, { knex = db } = {}) {
  if (send?.audience_phase !== PHASE_WARM) return null;
  return { phase: PHASE_WARM, issueNumber: (await sentWarmIssueCount(knex)) + 1, of: WARM_ISSUES };
}

module.exports = {
  WARM_ISSUES,
  PHASE_WARM,
  PHASE_ALL,
  WEEKLY_WARM_PLAN,
  sentWarmIssueCount,
  phaseForSentWarmIssues,
  selectWarmReaders,
  warmSegmentFilter,
  planWeeklyAudience,
  ensureFlagshipAudience,
  recordFlagshipAudience,
  warmPhaseNote,
};
