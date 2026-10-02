/**
 * Admin alert episodes: close / open-keys / raise-with-reopen.
 *
 * The mechanism first-application-sibling-split.js proved on its own alert: a
 * source CLOSES its bell when the problem is fixed and RINGS AGAIN when it
 * comes back, even if a person had already read the old one. Shared by the
 * schedule-integrity watchdog and the hot-estimate alert, both behind
 * ALERT_EPISODES (alertEpisodesLive(), read by each caller). The
 * first-application split keeps its own copy (billing code, left untouched).
 *
 * Callers use these through the module object so a unit test can stand them
 * in for their SQL (the SQL itself runs against Postgres in
 * alert-episodes-db.test.js).
 */

const db = require('../models/db');
const NotificationService = require('./notification-service');

// Close: mark every matching admin row read (COALESCE, so a person's own
// read_at stands) and stamp autoCleared. Deliberately NOT limited to unread
// rows — a row a person dismissed while the problem stood must still carry
// the stamp once it is really fixed, or raiseAdminAlertWithReopen would
// never see the fix and a comeback would stay silently dismissed. Rows
// already stamped are skipped, so a re-run rewrites nothing. Returns the
// number of rows closed. The close is also DONE (docs/admin-notifications.md
// section 4.3: the condition the alert was about has cleared), so the row
// leaves the bell with a one-line `resolution` — the caller's, or a generic
// one. A person's earlier done keeps its own stamps (doneColumns COALESCEs).
const GENERIC_RESOLUTION = 'Cleared: the condition this alert was about no longer holds';

async function closeAdminAlertKeys(conn, dedupeKeys, reason, { now = new Date(), resolution = null } = {}) {
  const keys = [...new Set((dedupeKeys || []).filter(Boolean).map(String))];
  if (!keys.length) return 0;
  return conn('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [keys])
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'")
    .update({
      ...NotificationService._private.doneColumns({ by: 'episodes', resolution: resolution || GENERIC_RESOLUTION, at: now, keepExisting: true, conn }),
      metadata: conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
        autoCleared: true, autoClearedReason: reason, autoClearedAt: now.toISOString(),
      })]),
    });
}

// The dedupe keys of every admin row under a key prefix that is not yet
// auto-cleared (read or unread) — the set a source judges against its live
// findings to decide what to close.
async function openAdminAlertKeys(conn, prefix) {
  const rows = await conn('notifications').where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [prefix])
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'")
    .select(conn.raw("metadata->>'dedupeKey' as dedupe_key"));
  return [...new Set(rows.map((r) => r.dedupe_key))];
}

// notifyAdmin with reopen. Inside ONE transaction (the same per-key advisory
// lock notifyAdmin takes) it reads the standing row for the key:
//  - auto-cleared (a fix came in and the problem is back): bump
//    recurrenceGeneration and pass dedupeVersion `${baseVersion}::g<n>` with
//    refreshOnDedupe, so notifyAdmin rewrites the row and rings it again;
//  - open (or absent): pass a version ONLY when the caller has one, kept
//    stable per generation — rows written before this existed carry no
//    dedupeVersion, and inventing one here would re-ring every standing
//    alert on the first run. No baseVersion = the call is exactly what the
//    caller would have made, a silent dedupe onto a standing row.
// A person's own dismissal of a still-standing problem stays dismissed;
// only a real fix followed by a real comeback rings again.
// Returns notifyAdmin's result plus `rang`: true when this call created a
// row or re-rang one (a silent dedupe is false), so a caller can cap real
// rings only.
async function raiseAdminAlertWithReopen(category, title, body, opts = {}) {
  const { dedupeKey, dedupeVersion: baseVersion, trx: callerTrx = null } = opts;
  if (!dedupeKey) throw new Error('raiseAdminAlertWithReopen requires a dedupeKey');
  const run = async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
    // .forUpdate(): the advisory lock is cooperative — markReadAdmin (a
    // person's dismissal) never takes it — so the standing row is
    // row-locked here, exactly as first-application-sibling-split.js's
    // raise does. A dismissal then either commits and is visible in this
    // read, or queues behind this whole transaction and lands on top of
    // the refresh; the refresh can never overwrite a dismissal back to
    // unread.
    // Newest row first (notifyAdmin's own lookup reads the same one): a key
    // can hold several rows, and the LATEST decides whether the episode is
    // standing or cleared — an arbitrary older auto-cleared row must not
    // re-version a live one.
    const existing = await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).orderBy('created_at', 'desc').forUpdate().first('metadata');
    let existingMeta = existing?.metadata;
    if (typeof existingMeta === 'string') { try { existingMeta = JSON.parse(existingMeta); } catch { existingMeta = null; } }
    const priorGeneration = Number(existingMeta?.recurrenceGeneration) || 0;
    let raiseOpts = { ...opts, trx };
    if (existingMeta?.autoCleared === true) {
      const generation = priorGeneration + 1;
      raiseOpts = {
        ...raiseOpts,
        dedupeVersion: `${baseVersion ?? ''}::g${generation}`,
        refreshOnDedupe: true,
        // A reopen always rings: a caller's quiet ringOnRefresh governs a
        // standing row's content refresh, never a comeback.
        ringOnRefresh: null,
        metadata: { ...opts.metadata, autoCleared: false, recurrenceGeneration: generation },
      };
    } else if (baseVersion !== undefined && priorGeneration > 0) {
      raiseOpts = { ...raiseOpts, dedupeVersion: `${baseVersion}::g${priorGeneration}` };
    }
    return NotificationService.notifyAdmin(category, title, body, raiseOpts);
  };
  const result = callerTrx ? await run(callerTrx) : await db.transaction(run);
  // A suppressed result (an internal test customer: notification-service's
  // central suppression inserts nothing) never rang, so it never uses up a
  // caller's per-run ring cap.
  return { ...result, rang: !result.suppressed && (!result.deduped || (result.refreshed === true && result.rung !== false)) };
}

// The metadata of every open (not auto-cleared) admin row under a dedupe-key
// prefix, for a caller that must know what a standing alert is about before
// closing it.
async function openAdminAlertMetadata(conn, prefix) {
  const rows = await conn('notifications').where({ recipient_type: 'admin' })
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [prefix])
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'")
    .select('metadata');
  return rows.map((r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) || {});
}

module.exports = { closeAdminAlertKeys, openAdminAlertKeys, openAdminAlertMetadata, raiseAdminAlertWithReopen };
