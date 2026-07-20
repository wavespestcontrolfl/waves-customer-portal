/**
 * Consumer for project_photo_delete_orphaned tombstones.
 *
 * Photo deletes are DB-first (rolling back a committed delete after the S3
 * object is destroyed would break a legal filing's evidence reference), so a
 * transient S3 failure after commit leaves the object in storage with only an
 * activity-log tombstone pointing at it. This sweep drains those tombstones:
 * retry the object delete, stamp reclaimed_at into the tombstone's metadata
 * on success, leave it queued on failure for the next run.
 *
 * Ungated hygiene — it only ever deletes objects whose DB rows the operator
 * already deleted. Serialized across replicas like the other sweeps.
 */

const db = require('../models/db');
const logger = require('./logger');

const BATCH = 25;

async function reclaimOrphanedPhotoObjects() {
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('photo-orphan-reclaim', async () => {
    const config = require('../config');
    if (!config.s3?.bucket) return { skipped: true, reason: 'no_s3' };
    const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: config.s3.region,
      credentials: config.s3.accessKeyId
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });

    const rows = await db('activity_log')
      .where({ action: 'project_photo_delete_orphaned' })
      .whereRaw("coalesce(metadata->>'reclaimed_at', '') = ''")
      .orderBy('created_at', 'asc')
      .limit(BATCH)
      .select('id', 'metadata');

    let reclaimed = 0;
    for (const row of rows) {
      let meta = row.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      const key = meta && meta.s3_key;
      if (!key) {
        // Malformed tombstone — stamp it so it never re-queues.
        await db('activity_log').where({ id: row.id }).update({
          metadata: JSON.stringify({ ...(meta || {}), reclaimed_at: new Date().toISOString(), reclaim_note: 'no_key' }),
        }).catch(() => {});
        continue;
      }
      try {
        // DeleteObject on an already-missing key succeeds silently on S3, so
        // any error here is transient/config — the tombstone stays queued.
        await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
        await db('activity_log').where({ id: row.id }).update({
          metadata: JSON.stringify({ ...meta, reclaimed_at: new Date().toISOString() }),
        });
        reclaimed += 1;
      } catch (err) {
        logger.warn(`[photo-orphan-reclaim] reclaim failed for activity ${row.id}: ${err.message}`);
      }
    }
    return { ok: true, scanned: rows.length, reclaimed };
  });
}

module.exports = { reclaimOrphanedPhotoObjects };
