const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

const s3Client = new S3Client({
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

const PhotoService = {
  /**
   * TTL for presigned VIEW urls on customer-dwell surfaces — tokenized
   * report/track/document pages and the logged-in portal. URLs are minted
   * per page-load, so this only has to cover in-page DWELL (backgrounded
   * tabs, lazy-loaded photo sliders), not link age: 5–15 minute links left
   * swiped-to report slides blank once the customer had the page open a
   * while (owner-reported 2026-07-11). 24h covers any realistic session
   * while keeping a leaked URL's reach bounded.
   */
  CUSTOMER_DWELL_TTL_SECONDS: 24 * 60 * 60,

  /**
   * Generate a presigned URL for uploading a photo from the field
   * Tech's mobile app uploads directly to S3 via this URL
   */
  async getUploadUrl(serviceRecordId, photoType, fileExtension = 'jpg') {
    const key = `${config.s3.photoPrefix}${serviceRecordId}/${photoType}_${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: `image/${fileExtension}`,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    logger.info(`Upload URL generated for ${key}`);
    return { url, key };
  },

  /**
   * Generate a presigned URL for viewing a photo
   * Customer portal uses these to display before/after images
   */
  async getViewUrl(s3Key, expiresIn = 300) {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
  },

  /**
   * Generate a short-lived URL that downloads an existing private object.
   * The filename is forced through S3's signed response headers so customer
   * documents do not inherit an opaque object-key name.
   */
  async getDownloadUrl(s3Key, fileName = 'document', expiresIn = 900) {
    const safeName = String(fileName || 'document')
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\x20-\x7E]/g, '_')
      .trim()
      .slice(0, 180) || 'document';
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
      ResponseContentDisposition: `attachment; filename="${safeName}"`,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
  },

  /**
   * Fetch a photo's raw bytes from S3. This is THE reader for a private
   * photo object's bytes — every consumer that needs the actual pixels
   * (vision/OCR input, an admin-side resize) goes through this, not its
   * own S3Client, so there is one place that knows how to read this bucket.
   * Returns { buffer, contentType } or throws.
   */
  async getPhotoBuffer(s3Key) {
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    }));
    const bytes = await res.Body.transformToByteArray();
    return {
      buffer: Buffer.from(bytes),
      contentType: res.ContentType || 'image/jpeg',
    };
  },

  /**
   * Fetch a photo's raw bytes from S3 as base64 (for vision/OCR input).
   * Returns { data, mimeType } or throws.
   */
  async getPhotoBase64(s3Key) {
    const { buffer, contentType } = await PhotoService.getPhotoBuffer(s3Key);
    return {
      data: buffer.toString('base64'),
      mimeType: contentType,
    };
  },

  /**
   * Delete a photo from S3
   */
  async deletePhoto(s3Key) {
    const command = new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    });

    await s3Client.send(command);
    logger.info(`Photo deleted: ${s3Key}`);
  },
};

module.exports = PhotoService;
