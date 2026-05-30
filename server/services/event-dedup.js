/**
 * Cross-source event de-duplication.
 *
 * Ingest dedupes only on (source_id, external_id), so the same real-world event
 * pulled from two feeds becomes two events_raw rows and could otherwise both
 * reach a digest. This service:
 *   - mergeEvents(): the shared merge transaction (advisory-locked, calendar-
 *     rewriting) used by BOTH the admin POST /events/merge route and the
 *     automated pass below — the locking/safety logic lives in one place.
 *   - autoMergeDuplicates(): a cron pass that clusters upcoming events
 *     (normalized title + ET day + city, via findDuplicateClusters) and
 *     collapses each cluster into one survivor — the row from the
 *     highest-priority source, then the most complete.
 */

const db = require('../models/db');
const logger = require('./logger');
const { findDuplicateClusters, rewriteCalendarEventIds } = require('./event-duplicates');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

// Same advisory-lock key the manual POST /events/merge route uses, so manual and
// automatic merges serialize against each other and merge-vs-merge races (where
// one merge's primary becomes another's duplicate) can't interleave.
const EVENT_MERGE_LOCK_KEY = 778001;

/**
 * Collapse `toMerge` event ids into `primaryId`. Advisory-locked + revalidated
 * (FOR UPDATE) so it's safe against concurrent merges. Losers are marked
 * admin_status='rejected' + merged_into=primaryId (both already exclude them
 * from the queue + digest), and any newsletter_calendar.event_ids referencing
 * them are rewritten to the primary. Throws (rolls back) on a merge conflict.
 *
 * @returns {Promise<{ merged:number, calendarsUpdated:number }>}
 */
async function mergeEvents(primaryId, toMerge) {
  const ids = [...new Set((toMerge || []).filter((id) => id && id !== primaryId))];
  if (ids.length === 0) return { merged: 0, calendarsUpdated: 0 };
  const mergeMap = new Map(ids.map((id) => [id, primaryId]));

  let merged = 0;
  let calendarsUpdated = 0;
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [EVENT_MERGE_LOCK_KEY]);

    // Revalidate the primary inside the txn: FOR UPDATE + re-read rolls us back
    // if it was merged away (else we'd repoint calendars to a non-survivor).
    const lockedPrimary = await trx('events_raw')
      .select('id', 'merged_into')
      .where({ id: primaryId })
      .forUpdate()
      .first();
    if (!lockedPrimary) throw new Error('merge conflict: primary event no longer exists — rolled back');
    if (lockedPrimary.merged_into) throw new Error('merge conflict: primary was concurrently merged into another event — rolled back');

    // Conditional on merged_into IS NULL — if a concurrent merge claimed a row
    // between caller validation and here, fewer rows update and we roll back.
    merged = await trx('events_raw')
      .whereIn('id', ids)
      .whereNull('merged_into')
      .update({
        admin_status: 'rejected',
        merged_into: primaryId,
        suppression_reason: `merged into ${primaryId}`,
        updated_at: new Date(),
      });
    if (merged !== ids.length) throw new Error('merge conflict: a duplicate was concurrently merged — rolled back');

    // Rewrite any planned calendars referencing a merged id. FOR UPDATE locks
    // the (tiny) calendar table so a concurrent edit/autopilot write isn't
    // clobbered by our snapshot-derived array.
    const calendars = await trx('newsletter_calendar').select('id', 'event_ids').forUpdate();
    for (const cal of calendars) {
      const calIds = Array.isArray(cal.event_ids)
        ? cal.event_ids
        : (() => { try { return JSON.parse(cal.event_ids || '[]'); } catch { return []; } })();
      const rewritten = rewriteCalendarEventIds(calIds, mergeMap);
      if (rewritten) {
        await trx('newsletter_calendar').where({ id: cal.id })
          .update({ event_ids: JSON.stringify(rewritten), updated_at: trx.fn.now() });
        calendarsUpdated += 1;
      }
    }
  });

  return { merged, calendarsUpdated };
}

/**
 * Choose the survivor of a duplicate cluster:
 *   1. a human-curated row (admin_status approved/featured) over an un-curated
 *      one — so the auto-merge never drops a curated event from the digest in
 *      favor of a pending duplicate (the digest only shows approved/featured);
 *   2. then the highest-priority source (lowest priority_tier; nulls last);
 *   3. then the most complete (image > url);
 *   4. then the earliest-pulled (most established).
 */
function pickSurvivor(events) {
  const curatedRank = (e) => (['approved', 'featured'].includes(e.admin_status) ? 0 : 1);
  const completeness = (e) => (e.image_url ? 2 : 0) + (e.event_url ? 1 : 0);
  return [...events].sort((a, b) => {
    const cr = curatedRank(a) - curatedRank(b);
    if (cr !== 0) return cr;
    const ta = a.source_priority_tier == null ? Infinity : Number(a.source_priority_tier);
    const tb = b.source_priority_tier == null ? Infinity : Number(b.source_priority_tier);
    if (ta !== tb) return ta - tb;
    const dc = completeness(b) - completeness(a);
    if (dc !== 0) return dc;
    const at = a.pulled_at ? new Date(a.pulled_at).getTime() : Infinity;
    const bt = b.pulled_at ? new Date(b.pulled_at).getTime() : Infinity;
    return at - bt;
  })[0];
}

/**
 * Cron pass: cluster upcoming, un-merged, non-rejected events and merge each
 * cluster into its survivor. Conservative clustering (title + ET day + city)
 * keeps false positives near zero. Bounded to the forward window + a per-run cap.
 */
async function autoMergeDuplicates({ windowDays = 90, maxClusters = 100 } = {}) {
  const startET = parseETDateTime(`${etDateString()}T00:00:00`);
  const endET = parseETDateTime(`${etDateString(addETDays(new Date(), windowDays))}T23:59:59`);

  const events = await db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .whereNull('e.merged_into')
    .whereNot('e.admin_status', 'rejected')
    .whereNotNull('e.start_at')
    .where('e.start_at', '>=', startET)
    .where('e.start_at', '<=', endET)
    .select(
      'e.id', 'e.title', 'e.start_at', 'e.city', 'e.image_url', 'e.event_url',
      'e.source_id', 'e.pulled_at', 'e.admin_status', 's.priority_tier as source_priority_tier',
    );

  const clusters = findDuplicateClusters(events).slice(0, maxClusters);
  let mergedEvents = 0;
  let mergedClusters = 0;
  for (const cluster of clusters) {
    // findDuplicateClusters groups by title+day+city only — it does NOT require
    // multiple sources. A single feed emitting two legit same-day/same-title
    // rows (e.g. separate showtimes with different external_ids) must NOT be
    // auto-merged. This feature is for CROSS-source dupes, so require ≥2 sources.
    if (new Set(cluster.events.map((e) => e.source_id)).size < 2) continue;

    const survivor = pickSurvivor(cluster.events);
    const losers = cluster.events.filter((e) => e.id !== survivor.id).map((e) => e.id);
    if (losers.length === 0) continue;
    try {
      const { merged } = await mergeEvents(survivor.id, losers);
      if (merged > 0) { mergedEvents += merged; mergedClusters += 1; }
    } catch (err) {
      // One cluster's conflict (e.g. a concurrent manual merge) must not abort
      // the whole pass — log and move on; the next run retries.
      logger.warn(`[event-dedup] cluster "${cluster.key}" auto-merge skipped: ${err.message}`);
    }
  }
  if (mergedClusters > 0) {
    logger.info(`[event-dedup] auto-merged ${mergedEvents} duplicate(s) across ${mergedClusters} cluster(s)`);
  }
  return { clustersFound: clusters.length, mergedClusters, mergedEvents };
}

module.exports = { mergeEvents, pickSurvivor, autoMergeDuplicates, EVENT_MERGE_LOCK_KEY };
