const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const Helpers = require('./invoice-helpers');

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

// A live send claim (invoices.status 'sending') owns the invoice's attachments: the email counts and points to them at
// the provider handoff, and the Intelligence Bar's send approved a fixed list. Checked on the row locked FOR UPDATE, so it
// serializes with the claim's own UPDATE. Any live send claim (page, queue worker or bar) trips it: the claim marker does not
// say which sender holds it.
const INVOICE_SENDING_MESSAGE = 'This invoice is being sent right now; try again in a minute';
function assertNotBeingSent(lockedInvoice) {
  if (lockedInvoice && lockedInvoice.status === 'sending') {
    const err = attachmentError(INVOICE_SENDING_MESSAGE, 409);
    err.code = 'invoice_sending';
    throw err;
  }
}

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

  // The reservation comes BEFORE the first storage write: the Intelligence Bar's send claim refuses while it is live, and the
  // insert below refuses when the invoice's send episode moved since. Taken under the invoice row lock, so it is serialized
  // with a send claim (a claim that already holds the row refuses the upload here).
  const reservation = await db.transaction(async (trx) => {
    const locked = await trx('invoices').where({ id: invoice.id }).forUpdate()
      .first('id', 'status', 'sent_at', 'sms_sent_at', 'email_sent_at');
    if (!locked) throw attachmentError('Invoice not found', 404);
    assertNotBeingSent(locked);
    return Helpers.reserveAttachmentUpload(trx, locked, { uploadedByTechId });
  });
  let reservationReleased = false;
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

    const insertedRows = await db.transaction(async (trx) => {
      // customer_id comes from the LOCKED row, never the pre-lock read
      // (Codex #3109 r25): a merge-undo can repoint the invoice while this
      // upload waits on the FOR UPDATE — inserting the stale pre-lock
      // owner would split the attachment from the invoice it belongs to.
      const lockedInvoice = await trx('invoices').where({ id: invoice.id }).forUpdate()
        .first('id', 'customer_id', 'status', 'sent_at', 'sms_sent_at', 'email_sent_at');
      if (!lockedInvoice) throw attachmentError('Invoice not found', 404);
      assertNotBeingSent(lockedInvoice);
      // The send episode moved since the reservation (a delivery landed while the files were being stored), or the
      // reservation ran out: the files are not part of anything a send approved. Nothing is inserted; the objects are removed.
      if (Helpers.invoiceDeliveryEpoch(lockedInvoice) !== reservation.epoch || Date.now() > reservation.expiresAtMs) {
        const err = attachmentError('This invoice was sent while the files were uploading; upload them again', 409);
        err.code = 'invoice_sent_during_upload';
        throw err;
      }

      const lockedExisting = await attachmentUsage(invoice.id, trx);
      assertAttachmentBudget(lockedExisting, uploadedObjects.map((object) => object.file));

      const inserted = await trx('invoice_attachments').insert(uploadedObjects.map((object) => ({
        invoice_id: invoice.id,
        customer_id: lockedInvoice.customer_id || null,
        file_name: object.fileName,
        mime_type: object.contentType,
        file_size_bytes: object.size,
        s3_key: object.key,
        uploaded_by_tech_id: uploadedByTechId || null,
      }))).returning(['id', 'invoice_id', 'file_name', 'mime_type', 'file_size_bytes', 'created_at']);
      await Helpers.releaseAttachmentUpload(trx, reservation);
      return inserted;
    });
    reservationReleased = true;
    return insertedRows;
  } catch (err) {
    await cleanupUploadedObjects(uploadedObjects);
    if (!reservationReleased) {
      try { await Helpers.releaseAttachmentUpload(db, reservation); } catch (releaseErr) {
        logger.warn(`[invoice-attachments] upload reservation release failed for invoice ${invoice.id}: ${releaseErr.message}`);
      }
    }
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

async function deleteStoredObject(attachment) {
  if (!(config.s3?.bucket && attachment.s3_key)) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: attachment.s3_key }));
  } catch (err) {
    if (!isMissingS3ObjectError(err)) {
      logger.warn(`[invoice-attachments] failed to delete object ${attachment.id}: ${err.message}`);
      throw attachmentError('Could not delete attachment from storage. Please retry.', 502);
    }
  }
}

async function remove(invoiceId, attachmentId) {
  // The invoice row is locked first (the send claim's UPDATE waits on it, and this waits on a claim), so the
  // sending check, the storage delete and the row delete are one decision. A storage failure rolls it all back.
  return db.transaction(async (trx) => {
    const lockedInvoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first('id', 'status');
    assertNotBeingSent(lockedInvoice);
    const attachment = await trx('invoice_attachments').where({ id: attachmentId, invoice_id: invoiceId }).first();
    if (!attachment) {
      throw attachmentError('Attachment not found', 404);
    }
    await deleteStoredObject(attachment);
    await trx('invoice_attachments').where({ id: attachmentId, invoice_id: invoiceId }).del();
    return attachment;
  });
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
  _private: {
    assertAttachmentBudget,
    detectedMimeFromBuffer,
    validateAttachmentFile,
  },
};
