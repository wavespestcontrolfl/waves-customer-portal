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
 *   5. Preflight gate — skip with an actionable notification if the week
 *      fails the flagship quality contract (min events / source diversity)
 *   6. Build a prompt incorporating calendar topic / homeowner minute
 *   7. Delegate AI drafting to shared createNewsletterDraft() service
 *   8. Link the resulting send to the calendar entry (or create one)
 *   9. Notify admin that a draft is ready
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEligibleForFreshDigest, scoreFreshEvent, getCurrentNewsletterThursday, defaultTargetSendAt, weekLockKey } = require('./event-freshness');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { createNewsletterDraft } = require('./newsletter-draft');
const { getFlagshipType } = require('../config/newsletter-types');

const NEWSLETTER_TYPE = 'local-weekly-fresh-events';

// Lineup cap — diversity/coverage stats are measured over the events that
// would actually appear (top-N by score), matching the draft selection.
const LINEUP_CAP = 12;

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
      'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url', 'e.image_url',
      'e.event_type', 'e.freshness_status', 'e.freshness_score',
      'e.admin_status', 'e.times_featured', 'e.source_id',
      'e.region_zone', 'e.family_friendly', 'e.is_free',
      's.name as source_name', 's.priority_tier as source_priority_tier',
    )
    .whereIn('e.admin_status', ['approved', 'featured'])
    .whereNull('e.merged_into')
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
 * Preflight the weekly digest against the flagship type's declared quality
 * contract. Pure function over a built plan — no DB calls.
 *
 * Hard failures (caller should SKIP the auto-draft):
 *   - fewer than `minVerifiedFreshEvents` eligible events
 *   - fewer than `minSourceDiversity` distinct sources in the lineup
 *
 * Soft warnings (draft proceeds, surfaced on the notification):
 *   - fewer than `minCityDiversity` distinct cities/zones
 *   - image coverage below `minImageCoverage`
 *
 * @param {Array|{ scored: Array }} lineup - the resolved draft lineup (event
 *   objects), or a plan `{ scored }` for convenience. Preflight runs on the
 *   events that will actually be drafted, not the raw score order.
 * @param {Object} reqs - sourceRequirements from the flagship type config
 * @returns {{ pass: boolean, hardFailures: string[], warnings: string[], stats: Object, thresholds: Object }}
 */
function preflightDigest(lineupOrPlan, reqs = {}) {
  const {
    minVerifiedFreshEvents = 5,
    minSourceDiversity = 2,
    minCityDiversity = 2,
    minImageCoverage = 0.5,
  } = reqs;

  const rawEvents = Array.isArray(lineupOrPlan)
    ? lineupOrPlan
    : (Array.isArray(lineupOrPlan?.scored) ? lineupOrPlan.scored : []);

  // Dedupe by event id — a planned calendar row can carry duplicate
  // event_ids (admin save validates UUID/length, not uniqueness). Counting
  // duplicates would let a thin lineup like [A,B,A,B,A] pass the 5-event /
  // 2-source gate even though createNewsletterDraft() fetches only the
  // distinct rows. Events without an id can't be deduped, so keep them.
  const seenIds = new Set();
  const events = rawEvents.filter((e) => {
    const id = e && e.id != null ? String(e.id) : null;
    if (id === null) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  const eligibleCount = events.length;
  const lineup = events.slice(0, LINEUP_CAP);

  const sources = new Set(lineup.map((e) => e.source_id || e.source_name).filter(Boolean));
  const cities = new Set(
    lineup.map((e) => (e.city || e.region_zone || '').trim().toLowerCase()).filter(Boolean),
  );
  const withImage = lineup.filter((e) => e.image_url).length;
  const imageCoverage = lineup.length ? withImage / lineup.length : 0;

  const stats = {
    eligibleCount,
    lineupSize: lineup.length,
    sourceCount: sources.size,
    cityCount: cities.size,
    imageCoverage: Math.round(imageCoverage * 100) / 100,
  };

  const hardFailures = [];
  if (eligibleCount < minVerifiedFreshEvents) {
    hardFailures.push(`Eligible fresh approved events: ${eligibleCount} / required ${minVerifiedFreshEvents}`);
  }
  if (stats.sourceCount < minSourceDiversity) {
    hardFailures.push(`Source diversity: ${stats.sourceCount} / required ${minSourceDiversity}`);
  }

  const warnings = [];
  if (stats.cityCount < minCityDiversity) {
    warnings.push(`City diversity: ${stats.cityCount} / recommended ${minCityDiversity}`);
  }
  if (imageCoverage < minImageCoverage) {
    warnings.push(`Image coverage: ${Math.round(imageCoverage * 100)}% / recommended ${Math.round(minImageCoverage * 100)}%`);
  }

  return {
    pass: hardFailures.length === 0,
    hardFailures,
    warnings,
    stats,
    thresholds: { minVerifiedFreshEvents, minSourceDiversity, minCityDiversity, minImageCoverage },
  };
}

/**
 * Render an actionable skip notification body from a preflight report.
 */
function formatPreflightReport(report, weekOf) {
  const lines = [`Fresh This Week autopilot skipped (week of ${weekOf}).`, '', 'Reason:'];
  for (const f of report.hardFailures) lines.push(`- ${f}`);
  for (const w of report.warnings) lines.push(`- ${w} (warning)`);
  lines.push('', 'Next actions:');
  lines.push('- Approve more pending events for this Thu–Wed window');
  lines.push('- Check failing ingestion sources (Events → Sources health)');
  lines.push('- Add/repair event URLs where missing');
  return lines.join('\n');
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
  if (existingCalendar && ['scheduled', 'sent'].includes(existingCalendar.status)) {
    const reason = `Calendar status is ${existingCalendar.status}`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }
  if (existingCalendar && existingCalendar.status === 'drafted' && existingCalendar.send_id) {
    const reason = `Calendar already drafted (send_id: ${existingCalendar.send_id})`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);
    return { skipped: true, reason };
  }
  // drafted without send_id falls through — autopilot will re-draft

  // 3. Look for a planned calendar entry with editorial guidance
  const calendarEntry = (existingCalendar && existingCalendar.status === 'planned')
    ? existingCalendar
    : null;

  // 4. Build digest plan
  const plan = await buildDigestPlan();
  const { scored } = plan;

  // 5. Resolve the lineup the draft will actually use — calendar-curated
  //    event_ids (intersected with the eligible pool) take precedence over
  //    raw score order, padded with top-scored events to fill the slate.
  //    The preflight MUST run on this lineup, not the raw score order, or an
  //    operator-planned diverse week could be wrongly skipped because the
  //    automatic top-12 happened to be single-source.
  const topic = calendarEntry?.topic;
  const homeownerMinuteTopic = calendarEntry?.homeowner_minute_topic;
  const preferredEventIds = Array.isArray(calendarEntry?.event_ids) ? calendarEntry.event_ids : [];

  const topEvents = scored.slice(0, 12);
  const byId = new Map(scored.map((ev) => [ev.id, ev]));
  // Dedupe preferred ids — a calendar row may carry duplicates (admin save
  // validates UUID/length, not uniqueness); dupes would inflate the lineup.
  const eligiblePreferred = [...new Set(preferredEventIds.filter((id) => byId.has(id)))];

  let lineupEvents;
  if (eligiblePreferred.length >= 5) {
    // Calendar picks are all eligible — use them, in the operator's order
    lineupEvents = eligiblePreferred.map((id) => byId.get(id));
  } else if (eligiblePreferred.length > 0) {
    // Some calendar picks are eligible — supplement with top-scored
    const preferredSet = new Set(eligiblePreferred);
    const supplement = topEvents.filter((ev) => !preferredSet.has(ev.id));
    lineupEvents = [...eligiblePreferred.map((id) => byId.get(id)), ...supplement].slice(0, 12);
  } else {
    // No calendar picks are eligible — use top-scored
    lineupEvents = topEvents;
  }

  // 6. Preflight gate — enforce the flagship type's declared quality
  //    contract against the RESOLVED lineup. Hard-fail (skip) on too few
  //    events or too few sources; city diversity + image coverage are soft
  //    warnings carried onto the draft for now. Thresholds come from the
  //    type config so they tune in one place.
  const reqs = getFlagshipType()?.sourceRequirements || {};
  const preflight = preflightDigest(lineupEvents, reqs);
  if (!preflight.pass) {
    const reason = preflight.hardFailures.join('; ');
    logger.info(`[newsletter-autopilot] Preflight skip: ${reason}`);

    // Notify admin with an actionable report (exact counts + next actions).
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('newsletter_autopilot_skipped', {
        eligible: preflight.stats.eligibleCount,
        reason,
        preflight: preflight.stats,
        report: formatPreflightReport(preflight, weekOf),
      });
    } catch (e) {
      logger.warn(`[newsletter-autopilot] skip notification failed: ${e.message}`);
    }

    return { skipped: true, reason, preflight: preflight.stats };
  }
  if (preflight.warnings.length) {
    logger.info(`[newsletter-autopilot] Preflight warnings: ${preflight.warnings.join('; ')}`);
  }

  // 7. Build prompt incorporating calendar data + derive event IDs from the
  //    resolved lineup (same set the preflight just validated).
  const prompt = topic
    ? `This week's theme: ${topic}. Fresh events from North Port to Tampa.${homeownerMinuteTopic ? ` Homeowner Minute: ${homeownerMinuteTopic}.` : ''}`
    : `Fresh events this week from North Port to Tampa.${homeownerMinuteTopic ? ` Homeowner Minute: ${homeownerMinuteTopic}.` : ''}`;

  const eventIds = lineupEvents.map((ev) => ev.id);

  // Sanitize event IDs — calendar event_ids come from JSONB and may contain
  // malformed values that would cause Postgres uuid type errors in whereIn.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let safeEventIds = eventIds.filter(id => typeof id === 'string' && uuidRe.test(id));

  // Verify selected events still exist — supplement if stale IDs reduced the count
  const resolvedCount = await db('events_raw').whereIn('id', safeEventIds).count('* as c').first();
  const actualCount = Number(resolvedCount?.c || 0);
  if (actualCount < 5 && topEvents.length > 0) {
    const supplementIds = topEvents
      .map((ev) => ev.id)
      .filter((id) => !safeEventIds.includes(id));
    safeEventIds = [...safeEventIds, ...supplementIds].slice(0, 12);
    logger.info(`[newsletter-autopilot] Supplemented events: ${actualCount} resolved, padded to ${safeEventIds.length}`);
  }

  // 7. Idempotency: transaction-scoped advisory lock so the dedupe check +
  //    insert are atomic. pg_advisory_xact_lock auto-releases when the
  //    transaction ends — no leak if the process crashes mid-flight. The key is
  //    per-WEEK (weekLockKey) and shared with the draft-from-plan route so the
  //    two paths can't both create a draft for the same week.
  const lockKey = weekLockKey(weekOf);

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
      eventIds: safeEventIds,
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
      // Verify the deduped send is actually a flagship newsletter for this week
      const dedupedSend = await db('newsletter_sends')
        .where({ id: earlyReturn.sendId, newsletter_type: NEWSLETTER_TYPE })
        .first();
      if (dedupedSend) {
        await db('newsletter_calendar')
          .where({ id: existingCalendar.id })
          .update({
            send_id: earlyReturn.sendId,
            status: 'drafted',
            updated_at: db.fn.now(),
          });
        logger.info(`[newsletter-autopilot] Linked existing draft ${earlyReturn.sendId} to calendar ${existingCalendar.id}`);
      } else {
        logger.warn(`[newsletter-autopilot] Deduped send ${earlyReturn.sendId} is not a ${NEWSLETTER_TYPE} — skipping calendar linkage`);
      }
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
      preflightWarnings: preflight.warnings,
    });
  } catch (e) {
    logger.warn(`[newsletter-autopilot] draft notification failed: ${e.message}`);
  }

  return { skipped: false, sendId: send.id, eventCount: topEvents.length };
}

module.exports = { autoDraftFlagship, buildDigestPlan, preflightDigest, formatPreflightReport };
