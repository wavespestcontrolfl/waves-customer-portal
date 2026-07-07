/**
 * Best-effort S3 storage for public photo-assessment funnel uploads
 * (lawn-assessment + pest-identifier). Mirrors the direct base64 → S3 upload
 * pattern from routes/admin-lawn-assessment.js: analysis has already run from
 * the in-memory base64, so storage failure never fails the request — the admin
 * view just shows fewer photos.
 */

const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');

let PhotoService;
try { PhotoService = require('../services/photos'); } catch { PhotoService = null; }

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/**
 * Upload each photo to the private photo bucket and insert a row in the
 * funnel's photo table.
 *
 * @param {object} opts
 * @param {string} opts.table       photo table ('lawn_diagnostic_photos' | 'pest_identification_photos')
 * @param {string} opts.fkColumn    FK column pointing at the parent row
 * @param {string} opts.rowId       parent row id
 * @param {string} opts.keyPrefix   S3 photoType prefix (e.g. 'lawnfunnel' | 'pestid')
 * @param {Array}  opts.photos      [{ data (base64), mimeType }]
 */
async function storeFunnelPhotos({ table, fkColumn, rowId, keyPrefix, photos = [] }) {
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    if (!photo || !photo.data) continue;
    const mimeType = photo.mimeType || 'image/jpeg';
    const ext = EXT_BY_MIME[mimeType] || 'jpg';

    let s3Key = null;
    if (PhotoService && config.s3?.bucket) {
      try {
        const uploadResult = await PhotoService.getUploadUrl(rowId, `${keyPrefix}_${i}`, ext);
        s3Key = uploadResult.key;
        // eslint-disable-next-line global-require
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({
          region: config.s3.region,
          credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
        });
        await s3.send(new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: s3Key,
          Body: Buffer.from(photo.data, 'base64'),
          ContentType: mimeType,
          Metadata: { funnelRowId: String(rowId), photoIndex: String(i) },
        }));
      } catch (s3Err) {
        logger.error(`[funnel-photos] S3 upload failed for ${table} photo ${i}: ${s3Err.message}`);
        s3Key = null;
      }
    }

    try {
      await db(table).insert({
        [fkColumn]: rowId,
        photo_index: i,
        s3_key: s3Key,
        mime_type: mimeType,
        customer_visible: true,
      });
    } catch (dbErr) {
      logger.error(`[funnel-photos] photo row insert failed for ${table} photo ${i}: ${dbErr.message}`);
    }
  }
}

module.exports = { storeFunnelPhotos };
