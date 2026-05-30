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
 * opts.backfill — optional partial field map applied to the primary inside the
 *   txn before the losers are merged away (the auto-pass uses it to copy
 *   digest-required fields like event_url from a loser when the survivor lacks
 *   them, so a merge never makes an otherwise-eligible event disappear). The
 *   manual route passes nothing → behavior unchanged.
 *
 * @returns {Promise<{ merged:number, calendarsUpdated:number }>}
 */
async function mergeEvents(primaryId, toMerge, opts = {}) {
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

    // Backfill digest-required/quality fields onto the survivor BEFORE the
    // losers are rejected, so the merge never drops the only row that carried
    // event_url (which isEligibleForFreshDigest hard-requires) and make a real
    // event disappear. Caller computes which fields the survivor is missing.
    if (opts.backfill && Object.keys(opts.backfill).length > 0) {
      await trx('events_raw').where({ id: primaryId }).update({ ...opts.backfill, updated_at: new Date() });
    }

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
 *   1. by curation strength — 'featured' (explicit editorial pick) ahead of
 *      'approved' ahead of anything un-curated — so the auto-merge never demotes
 *      a featured event to a merely-approved one, nor drops a curated row in
 *      favor of a pending duplicate (the digest only shows approved/featured,
 *      and the approved-ids path orders featured first too);
 *   2. then the highest-priority source (lowest priority_tier; nulls last);
 *   3. then the most complete (image > url);
 *   4. then the earliest-pulled (most established).
 */
function pickSurvivor(events) {
  const curatedRank = (e) => (e.admin_status === 'featured' ? 0 : e.admin_status === 'approved' ? 1 : 2);
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
 * Whether a duplicate cluster is safe to auto-merge: it must be a PURE
 * cross-source duplicate — exactly one row per source across ≥2 distinct
 * sources. findDuplicateClusters groups by title+ET-day+city only, so a cluster
 * can contain two rows from the SAME feed (e.g. separate showtimes/sessions with
 * different external_ids) which may be legit distinct events. If any source
 * contributes more than one row, leave the whole cluster for manual review.
 */
function isCleanCrossSourceCluster(events) {
  const sourceIds = (Array.isArray(events) ? events : []).map((e) => e.source_id);
  const distinct = new Set(sourceIds).size;
  return distinct >= 2 && distinct === sourceIds.length;
}

const normalizeVenue = (v) => String(v || '').trim().toLowerCase();

/**
 * Whether a cluster is safe to merge UNATTENDED. findDuplicateClusters matches
 * on title + ET day + city only — not enough for an automated reject, because
 * two genuinely different same-title events (e.g. "Trivia Night" at different
 * venues, or a matinee vs an evening showing) would group together. On top of
 * the pure cross-source check, require the rows to also agree on a non-empty
 * venue AND the exact start_at instant — a same-title/day/city/venue/time match
 * across ≥2 sources is almost certainly one real event. Anything looser
 * (different/blank venue, different time) is left for the manual
 * /events/duplicates review rather than auto-rejected.
 */
function isAutoMergeableCluster(events) {
  if (!isCleanCrossSourceCluster(events)) return false;
  const venues = events.map((e) => normalizeVenue(e.venue_name));
  if (venues.some((v) => !v) || new Set(venues).size !== 1) return false;
  const starts = events.map((e) => (e.start_at ? new Date(e.start_at).getTime() : NaN));
  if (starts.some((t) => Number.isNaN(t)) || new Set(starts).size !== 1) return false;
  return true;
}

// Fields the survivor must carry to stay digest-eligible/complete. event_url is
// hard-required by isEligibleForFreshDigest; image_url is a quality/score field.
const BACKFILL_FIELDS = ['event_url', 'image_url'];

/**
 * Compute the fields to copy onto the survivor from the losers: for each
 * BACKFILL_FIELD the survivor is missing, take the first loser that has it.
 * Ensures a merge can't drop the only row that carried event_url (which would
 * make an otherwise-eligible event vanish from the digest).
 */
function computeSurvivorBackfill(survivor, losers) {
  const out = {};
  for (const field of BACKFILL_FIELDS) {
    if (!survivor[field]) {
      const donor = (losers || []).find((e) => e[field]);
      if (donor) out[field] = donor[field];
    }
  }
  return out;
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
      'e.source_id', 'e.pulled_at', 'e.admin_status', 'e.venue_name', 's.priority_tier as source_priority_tier',
    );

  // Filter to auto-mergeable clusters BEFORE applying the cap. The query
  // feeding findDuplicateClusters is unordered, so capping the raw result
  // first would let loose, manual-only clusters (mismatched venue/time)
  // consume the whole budget and starve safe cross-source duplicates that
  // happen to sort later. Cap the work we actually intend to do instead.
  const clusters = findDuplicateClusters(events)
    .filter((c) => isAutoMergeableCluster(c.events))
    .slice(0, maxClusters);
  let mergedEvents = 0;
  let mergedClusters = 0;
  for (const cluster of clusters) {
    const survivor = pickSurvivor(cluster.events);
    const loserRows = cluster.events.filter((e) => e.id !== survivor.id);
    const losers = loserRows.map((e) => e.id);
    if (losers.length === 0) continue;
    // Carry event_url/image_url onto the survivor from a loser if it lacks them,
    // so collapsing the cluster can't drop the only event_url-bearing row.
    const backfill = computeSurvivorBackfill(survivor, loserRows);
    try {
      const { merged } = await mergeEvents(survivor.id, losers, { backfill });
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

module.exports = { mergeEvents, pickSurvivor, isCleanCrossSourceCluster, isAutoMergeableCluster, computeSurvivorBackfill, autoMergeDuplicates, EVENT_MERGE_LOCK_KEY };
