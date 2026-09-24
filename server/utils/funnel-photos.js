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

// Shared S3 upload for one funnel/photo-id photo. Never throws — a storage
// hiccup degrades to a null s3_key (best-effort, see header).
async function uploadFunnelPhotoToS3({
  rowId, keyPrefix, index, mimeType, base64,
}) {
  if (!PhotoService || !config.s3?.bucket) return null;
  const ext = EXT_BY_MIME[mimeType] || 'jpg';
  try {
    const uploadResult = await PhotoService.getUploadUrl(rowId, `${keyPrefix}_${index}`, ext);
    const s3Key = uploadResult.key;
     
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    });
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
      Body: Buffer.from(base64, 'base64'),
      ContentType: mimeType,
      Metadata: { funnelRowId: String(rowId), photoIndex: String(index) },
    }));
    return s3Key;
  } catch (s3Err) {
    logger.error(`[funnel-photos] S3 upload failed for ${keyPrefix} photo ${index}: ${s3Err.message}`);
    return null;
  }
}

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
async function storeFunnelPhotos({
  table, fkColumn, rowId, keyPrefix, photos = [],
}) {
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    if (!photo || !photo.data) continue;
    const mimeType = photo.mimeType || 'image/jpeg';
    const s3Key = await uploadFunnelPhotoToS3({
      rowId, keyPrefix, index: i, mimeType, base64: photo.data,
    });

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

/**
 * Same best-effort S3 upload, but for `tree_shrub_assessment_photos` — a
 * differently-shaped table (customer_id NOT NULL, photo_order instead of
 * photo_index, no generic customer_visible-only contract) that predates the
 * funnel tables, so it can't reuse storeFunnelPhotos's insert shape.
 *
 * @param {object} opts
 * @param {string} opts.assessmentId  tree_shrub_assessments.id
 * @param {string} opts.customerId    tree_shrub_assessment_photos.customer_id (NOT NULL)
 * @param {string} opts.keyPrefix     S3 photoType prefix (e.g. 'treeshrub/customer')
 * @param {Array}  opts.photos        [{ data (base64), mimeType }]
 */
async function storeTreeShrubCustomerPhotos({
  assessmentId, customerId, keyPrefix, photos = [],
}) {
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    if (!photo || !photo.data) continue;
    const mimeType = photo.mimeType || 'image/jpeg';
    const s3Key = await uploadFunnelPhotoToS3({
      rowId: assessmentId, keyPrefix, index: i, mimeType, base64: photo.data,
    });

    try {
      await db('tree_shrub_assessment_photos').insert({
        assessment_id: assessmentId,
        customer_id: customerId,
        s3_key: s3Key,
        mime_type: mimeType,
        photo_order: i,
        is_best_photo: i === 0,
        customer_visible: true,
      });
    } catch (dbErr) {
      logger.error(`[funnel-photos] tree-shrub photo row insert failed for photo ${i}: ${dbErr.message}`);
    }
  }
}

module.exports = { storeFunnelPhotos, storeTreeShrubCustomerPhotos };
