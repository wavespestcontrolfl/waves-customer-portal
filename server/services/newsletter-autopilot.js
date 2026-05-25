/**
 * Newsletter Autopilot — guarded auto-draft for the weekly digest.
 *
 * Called by the Thursday 7 AM ET cron in scheduler.js. Never auto-sends;
 * creates a draft in newsletter_sends for admin review + manual send.
 *
 * Flow:
 *   1. Compute the current newsletter Thursday
 *   2. Check newsletter_calendar for a pre-planned entry
 *   3. Skip if calendar row already has a send_id or terminal status
 *   4. Generate a digest plan from approved events (same query pattern
 *      as POST /events/digest-plan in admin-newsletter.js)
 *   5. If fewer than 3 eligible events → skip with notification
 *   6. Build a prompt incorporating calendar topic / homeowner minute
 *   7. Delegate AI drafting to shared createNewsletterDraft() service
 *   8. Link the resulting send to the calendar entry (or create one)
 *   9. Notify admin that a draft is ready
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEligibleForFreshDigest, scoreFreshEvent, getCurrentNewsletterThursday, defaultTargetSendAt } = require('./event-freshness');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { createNewsletterDraft } = require('./newsletter-draft');

const NEWSLETTER_TYPE = 'local-weekly-fresh-events';
const MIN_ELIGIBLE_EVENTS = 3;

/**
 * Build the digest plan — same query as POST /events/digest-plan
 * in admin-newsletter.js, but without the HTTP layer.
 */
async function buildDigestPlan() {
  const now = new Date();
  const nowET = etParts(now);
  const daysBack = (nowET.dayOfWeek - 4 + 7) % 7; // 0 on Thu, 1 Fri, … 6 Wed
  const defaultStart = addETDays(now, -daysBack);
  const startDate = parseETDateTime(`${etDateString(defaultStart)}T00:00:00`);
  const endDate = parseETDateTime(`${etDateString(addETDays(startDate, 6))}T23:59:59`);

  const rows = await db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .select(
      'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
      'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
      'e.event_type', 'e.freshness_status', 'e.freshness_score',
      'e.admin_status', 'e.times_featured',
      'e.region_zone', 'e.family_friendly', 'e.is_free',
      's.name as source_name', 's.priority_tier as source_priority_tier',
    )
    .whereIn('e.admin_status', ['approved', 'featured'])
    .where('e.start_at', '>=', startDate)
    .where('e.start_at', '<=', endDate)
    .whereNotNull('e.event_url')
    .whereNotIn('e.freshness_status', ['expired', 'stale_recurring'])
    .orderByRaw('e.freshness_score DESC NULLS LAST');

  const eligible = rows.filter((r) => isEligibleForFreshDigest(r));
  const scored = eligible
    .map((r) => ({ ...r, compositeScore: scoreFreshEvent(r) }))
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return { rows, eligible, scored, startDate, endDate };
}

/**
 * Auto-draft the weekly flagship newsletter.
 *
 * @returns {{ skipped: boolean, reason?: string, sendId?: number, eventCount?: number }}
 */
async function autoDraftFlagship() {
  logger.info('[newsletter-autopilot] Starting weekly auto-draft');

  // 1. Compute the current newsletter Thursday
  const weekOf = getCurrentNewsletterThursday();
  logger.info(`[newsletter-autopilot] Week of: ${weekOf}`);

  // 2. Check the calendar for existing entry — skip if already handled
  const existingCalendar = await db('newsletter_calendar')
    .where('week_of', weekOf)
    .first();

  if (existingCalendar && existingCalendar.send_id) {
    const reason = `Calendar already has send_id: ${existingCalendar.send_id}`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }

  if (existingCalendar && existingCalendar.status === 'skipped') {
    const reason = 'Calendar status is skipped';
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }
  if (existingCalendar && ['drafted', 'scheduled', 'sent'].includes(existingCalendar.status)) {
    const reason = `Calendar status is ${existingCalendar.status} (send_id: ${existingCalendar.send_id || 'null'})`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }

  // 3. Look for a planned calendar entry with editorial guidance
  const calendarEntry = (existingCalendar && existingCalendar.status === 'planned')
    ? existingCalendar
    : null;

  // 4. Build digest plan
  const plan = await buildDigestPlan();
  const { eligible, scored } = plan;

  // 5. Gate: minimum event count
  if (eligible.length < MIN_ELIGIBLE_EVENTS) {
    const reason = `Not enough approved events (${eligible.length} eligible)`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);

    // Notify admin about the skip
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('newsletter_autopilot_skipped', {
        eligible: eligible.length,
        reason,
      });
    } catch (e) {
      logger.warn(`[newsletter-autopilot] skip notification failed: ${e.message}`);
    }

    return { skipped: true, reason };
  }

  // 6. Build prompt incorporating calendar data
  const topic = calendarEntry?.topic;
  const homeownerMinuteTopic = calendarEntry?.homeowner_minute_topic;
  const preferredEventIds = Array.isArray(calendarEntry?.event_ids) ? calendarEntry.event_ids : [];

  const prompt = topic
    ? `This week's theme: ${topic}. Fresh events from North Port to Tampa.${homeownerMinuteTopic ? ` Homeowner Minute: ${homeownerMinuteTopic}.` : ''}`
    : `Fresh events this week from North Port to Tampa.${homeownerMinuteTopic ? ` Homeowner Minute: ${homeownerMinuteTopic}.` : ''}`;

  // Use calendar event IDs if specified, otherwise fall back to scored digest plan (top 12)
  const topEvents = scored.slice(0, 12);
  let eventIds;
  if (preferredEventIds.length >= 5) {
    // Calendar has enough events — use them directly
    eventIds = preferredEventIds;
  } else if (preferredEventIds.length > 0) {
    // Calendar has some events but not enough — supplement with top-scored
    const supplementIds = topEvents
      .map((ev) => ev.id)
      .filter((id) => !preferredEventIds.includes(id));
    eventIds = [...preferredEventIds, ...supplementIds].slice(0, 12);
  } else {
    // No calendar events — use top-scored
    eventIds = topEvents.map((ev) => ev.id);
  }

  // Verify selected events still exist — supplement if stale IDs reduced the count
  const resolvedCount = await db('events_raw').whereIn('id', eventIds).count('* as c').first();
  const actualCount = Number(resolvedCount?.c || 0);
  if (actualCount < 5 && topEvents.length > 0) {
    const supplementIds = topEvents
      .map((ev) => ev.id)
      .filter((id) => !eventIds.includes(id));
    eventIds = [...eventIds, ...supplementIds].slice(0, 12);
    logger.info(`[newsletter-autopilot] Supplemented events: ${actualCount} resolved, padded to ${eventIds.length}`);
  }

  // 7. Idempotency: transaction-scoped advisory lock so the dedupe check +
  //    insert are atomic. pg_advisory_xact_lock auto-releases when the
  //    transaction ends — no leak if the process crashes mid-flight.
  const lockKey = Math.abs(Buffer.from(plan.startDate.toISOString()).readInt32BE(0) % 2147483647);

  let send;
  let earlyReturn = null;

  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [lockKey]);

    const existing = await trx('newsletter_sends')
      .where({ newsletter_type: NEWSLETTER_TYPE, status: 'draft' })
      .whereNull('created_by')
      .where('created_at', '>=', plan.startDate)
      .first();

    if (existing) {
      logger.info(`[newsletter-autopilot] draft already exists for this week: ${existing.id}`);
      earlyReturn = { skipped: true, reason: `Draft already exists: ${existing.id}`, sendId: existing.id };
      return; // transaction commits → lock auto-releases
    }

    // 8. Delegate AI drafting to the shared service
    const result = await createNewsletterDraft({
      prompt,
      eventIds,
      homeownerMinuteTopic,
      topic,
      newsletterType: NEWSLETTER_TYPE,
      trx,
    });

    send = result.send;
    // transaction commits → lock auto-releases
  });

  if (earlyReturn) {
    // Calendar may still be unlinked after a partial failure (draft created
    // but calendar update didn't complete). Fix the linkage before returning.
    if (existingCalendar && !existingCalendar.send_id) {
      await db('newsletter_calendar')
        .where({ id: existingCalendar.id })
        .update({
          send_id: earlyReturn.sendId,
          status: 'drafted',
          updated_at: db.fn.now(),
        });
      logger.info(`[newsletter-autopilot] Linked existing draft ${earlyReturn.sendId} to calendar ${existingCalendar.id}`);
    } else if (!existingCalendar) {
      await db('newsletter_calendar').insert({
        week_of: weekOf,
        topic: null,
        status: 'drafted',
        send_id: earlyReturn.sendId,
        target_send_at: defaultTargetSendAt(weekOf),
        event_ids: JSON.stringify([]),
      }).onConflict('week_of').merge({
        send_id: earlyReturn.sendId,
        status: 'drafted',
        updated_at: db.fn.now(),
      });
      logger.info(`[newsletter-autopilot] Created calendar entry for existing draft ${earlyReturn.sendId}`);
    }
    return earlyReturn;
  }

  // 9. Link send to calendar entry (or create one)
  if (calendarEntry) {
    await db('newsletter_calendar')
      .where({ id: calendarEntry.id })
      .update({
        send_id: send.id,
        status: 'drafted',
        updated_at: db.fn.now(),
      });
  } else {
    await db('newsletter_calendar').insert({
      week_of: weekOf,
      topic: null,
      status: 'drafted',
      send_id: send.id,
      target_send_at: defaultTargetSendAt(weekOf),
      event_ids: JSON.stringify([]),
    }).onConflict('week_of').merge({
      send_id: send.id,
      status: 'drafted',
      updated_at: db.fn.now(),
    });
  }

  logger.info(`[newsletter-autopilot] Draft created: sendId=${send.id}, events=${topEvents.length}`);

  // 10. Notify admin that a draft is ready
  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('newsletter_autopilot_draft', {
      sendId: send.id,
      subject: send.subject,
      eventCount: topEvents.length,
      calendarWeek: weekOf,
      hadCalendarEntry: !!calendarEntry,
    });
  } catch (e) {
    logger.warn(`[newsletter-autopilot] draft notification failed: ${e.message}`);
  }

  return { skipped: false, sendId: send.id, eventCount: topEvents.length };
}

module.exports = { autoDraftFlagship };
