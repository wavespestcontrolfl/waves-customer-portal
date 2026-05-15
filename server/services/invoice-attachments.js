const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
const INVOICE_ATTACHMENT_PREFIX = 'invoice-attachments/';
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/tiff',
  'image/bmp',
  'image/x-ms-bmp',
  'application/pdf',
]);
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'tif', 'tiff', 'bmp', 'pdf']);

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function attachmentError(message, statusCode = 400) {
  const err = new Error(message);
  err.status = statusCode;
  err.statusCode = statusCode;
  err.isOperational = true;
  return err;
}

function extensionForFileName(fileName = '') {
  const match = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function normalizeMimeType(mimeType = '') {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/x-ms-bmp') return 'image/bmp';
  return normalized;
}

function isAllowedDeclaredFile(file = {}) {
  const ext = extensionForFileName(file.originalname || file.file_name || file.name);
  const mimeType = normalizeMimeType(file.mimetype || file.mime_type || file.type);
  return ALLOWED_MIME_TYPES.has(mimeType) || ALLOWED_EXTENSIONS.has(ext);
}

function detectedMimeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) return 'image/png';
  const header6 = buffer.slice(0, 6).toString('ascii');
  if (header6 === 'GIF87a' || header6 === 'GIF89a') return 'image/gif';
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  ) return 'image/tiff';
  return null;
}

function validateAttachmentFile(file) {
  if (!file?.buffer || !file.size) {
    throw attachmentError('Attachment is empty', 400);
  }
  if (!isAllowedDeclaredFile(file)) {
    throw attachmentError('Supported attachment types are JPG, PNG, GIF, TIFF, BMP, and PDF', 400);
  }
  const detected = detectedMimeFromBuffer(file.buffer);
  if (!detected || !ALLOWED_MIME_TYPES.has(detected)) {
    throw attachmentError('Attachment content is not a supported file type', 400);
  }
  return detected;
}

function safeFileName(fileName = 'attachment') {
  const safe = String(fileName || 'attachment')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/[\r\n]/g, '_')
    .trim()
    .slice(0, 180);
  return safe || 'attachment';
}

function keyFingerprint(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 12);
}

async function attachmentUsage(invoiceId, knex = db) {
  const row = await knex('invoice_attachments')
    .where({ invoice_id: invoiceId })
    .count('* as count')
    .sum('file_size_bytes as total_bytes')
    .first();
  return {
    count: Number(row?.count || 0),
    totalBytes: Number(row?.total_bytes || 0),
  };
}

function assertAttachmentBudget(existing, files) {
  const uploadCount = files.length;
  const uploadBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (existing.count + uploadCount > MAX_ATTACHMENT_COUNT) {
    throw attachmentError(`Invoices can have at most ${MAX_ATTACHMENT_COUNT} attachments`, 400);
  }
  if (existing.totalBytes + uploadBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw attachmentError('Invoice attachments cannot total more than 25 MB', 400);
  }
}

async function cleanupUploadedObjects(uploadedObjects) {
  await Promise.all((uploadedObjects || []).map(async (object) => {
    if (!object?.key || !config.s3?.bucket) return;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: object.key }));
    } catch (err) {
      logger.warn(`[invoice-attachments] failed to cleanup object ${keyFingerprint(object.key)}: ${err.message}`);
    }
  }));
}

async function list(invoiceId) {
  return db('invoice_attachments')
    .where({ invoice_id: invoiceId })
    .orderBy('created_at', 'asc')
    .select('id', 'invoice_id', 'file_name', 'mime_type', 'file_size_bytes', 'created_at');
}

async function upload(invoice, files = [], { uploadedByTechId = null } = {}) {
  if (!invoice?.id) {
    throw attachmentError('Invoice not found', 404);
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw attachmentError('No files provided', 400);
  }
  if (!config.s3?.bucket) {
    throw attachmentError('Attachment storage is not configured', 500);
  }

  const existing = await attachmentUsage(invoice.id);
  assertAttachmentBudget(existing, files);
  const validatedFiles = files.map((file) => ({
    file,
    contentType: validateAttachmentFile(file),
  }));

  const uploadedObjects = [];
  try {
    for (const { file, contentType } of validatedFiles) {
      const fileName = safeFileName(file.originalname || 'attachment');
      const random = crypto.randomBytes(6).toString('hex');
      const key = `${INVOICE_ATTACHMENT_PREFIX}${invoice.id}/${Date.now()}-${random}`;

      await s3.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: contentType,
      }));

      uploadedObjects.push({
        file,
        fileName,
        contentType,
        key,
        size: Number(file.size || file.buffer.length || 0),
      });
    }

    return await db.transaction(async (trx) => {
      const lockedInvoice = await trx('invoices').where({ id: invoice.id }).forUpdate().first('id');
      if (!lockedInvoice) throw attachmentError('Invoice not found', 404);

      const lockedExisting = await attachmentUsage(invoice.id, trx);
      assertAttachmentBudget(lockedExisting, uploadedObjects.map((object) => object.file));

      return trx('invoice_attachments').insert(uploadedObjects.map((object) => ({
        invoice_id: invoice.id,
        customer_id: invoice.customer_id || null,
        file_name: object.fileName,
        mime_type: object.contentType,
        file_size_bytes: object.size,
        s3_key: object.key,
        uploaded_by_tech_id: uploadedByTechId || null,
      }))).returning(['id', 'invoice_id', 'file_name', 'mime_type', 'file_size_bytes', 'created_at']);
    });
  } catch (err) {
    await cleanupUploadedObjects(uploadedObjects);
    throw err;
  }
}

async function getForInvoice(invoiceId, attachmentId) {
  return db('invoice_attachments')
    .where({ id: attachmentId, invoice_id: invoiceId })
    .first();
}

async function signedViewUrl(attachment, expiresIn = 3600) {
  if (!attachment?.s3_key) {
    throw attachmentError('Attachment not found', 404);
  }
  if (!config.s3?.bucket) {
    throw attachmentError('Attachment storage is not configured', 500);
  }
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: attachment.s3_key,
    ResponseContentDisposition: `inline; filename="${safeFileName(attachment.file_name)}"`,
    ResponseContentType: attachment.mime_type || undefined,
  }), { expiresIn });
}

function isMissingS3ObjectError(err) {
  const statusCode = err?.$metadata?.httpStatusCode || err?.statusCode;
  return statusCode === 404 || ['NoSuchKey', 'NotFound'].includes(err?.name || err?.Code || err?.code);
}

async function remove(invoiceId, attachmentId) {
  const attachment = await getForInvoice(invoiceId, attachmentId);
  if (!attachment) {
    throw attachmentError('Attachment not found', 404);
  }

  if (config.s3?.bucket && attachment.s3_key) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: attachment.s3_key }));
    } catch (err) {
      if (!isMissingS3ObjectError(err)) {
        logger.warn(`[invoice-attachments] failed to delete object ${attachment.id}: ${err.message}`);
        throw attachmentError('Could not delete attachment from storage. Please retry.', 502);
      }
    }
  }

  await db('invoice_attachments').where({ id: attachmentId, invoice_id: invoiceId }).del();
  return attachment;
}

module.exports = {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  ALLOWED_MIME_TYPES,
  attachmentError,
  isAllowedDeclaredFile,
  list,
  upload,
  getForInvoice,
  signedViewUrl,
  remove,
};
