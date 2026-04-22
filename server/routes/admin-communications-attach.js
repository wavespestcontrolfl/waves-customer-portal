/**
 * Outbound SMS/MMS attachment upload.
 *
 * Splits off admin-communications.js so the file stays focused. Flow:
 *   1. Admin UI picks images → POSTs multipart to /attach
 *   2. Handler uploads each to S3 under `sms-attachments/<ts>-<file>`
 *   3. Returns a presigned GET URL for each; the composer stashes them and
 *      passes them back to POST /admin/communications/sms as `mediaUrls`
 *   4. TwilioService.sendSMS forwards to Twilio, which fetches the media
 *      before delivery.
 *
 * Presigned URLs expire in 24h — Twilio fetches within seconds of the API
 * call, so that window is plenty. S3 was chosen because the receipt-upload
 * pipeline (admin-job-expenses.js) already wires it and Twilio MMS requires
 * a publicly fetchable URL anyway (Railway volume would need a new proxy).
 *
 * Size cap: 5MB per file, max 5 files per message. Twilio MMS limit is 5MB
 * per attachment and 10 mediaUrls per message; we keep 5 to stay well under
 * the size ceiling.
 *
 * Mimetype allowlist is images only for v1 — PDFs deliver inconsistently
 * across carriers, audio notes have higher friction than value.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const config = require('../config');

router.use(adminAuthenticate, requireAdmin);

const MAX_PER_MESSAGE = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB per Twilio MMS
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const PREFIX = 'sms-attachments/';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_PER_MESSAGE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

router.post('/attach', upload.array('attachments', MAX_PER_MESSAGE), async (req, res, next) => {
  try {
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const results = [];
    for (const file of req.files) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
        { expiresIn: 24 * 60 * 60 }, // 24h — Twilio fetches within seconds
      );
      results.push({
        url,
        key,
        fileName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      });
    }

    logger.info(`[sms-attach] Uploaded ${results.length} file(s), total ${req.files.reduce((s, f) => s + f.size, 0)} bytes`);
    res.json({ attachments: results });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File exceeds ${MAX_FILE_BYTES / 1024 / 1024}MB limit` });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({ error: `Too many files (max ${MAX_PER_MESSAGE})` });
    }
    if (err.message?.startsWith('Unsupported file type')) {
      return res.status(415).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
