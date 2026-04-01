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
  async getViewUrl(s3Key, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: s3Key,
    });

    return getSignedUrl(s3Client, command, { expiresIn });
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
