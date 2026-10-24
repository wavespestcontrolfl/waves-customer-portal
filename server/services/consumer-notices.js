// FDACS-13692 Consumer Notice Form on file (Rule 5E-14.105(1), F.A.C.; owner
// 2026-10-24, GATE_WARRANTY_13692_CHECK): the owner or authorized agent signs
// the state form BEFORE a wood-destroying-organism contract. A notice on file is
// either an e-signed Document Request (customer_contracts, template
// consumer_notice.fdacs_13692, signed_at read as an Eastern date) or a scan of
// the paper form the office uploads with the date it was signed
// (consumer_notice_paper_records). The New Construction Termite Warranty reads
// the latest one dated on or before its contract basis and treatment dates.
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const CONSUMER_NOTICE_TEMPLATE_KEY = 'consumer_notice.fdacs_13692';
// Until this Eastern day a missing notice only warns the warranty office;
// after it the warranty refuses (owner 2026-10-24).
const CONSUMER_NOTICE_GRACE_END = '2026-11-24';
// The form on file is Rev. 07/21: an earlier signed date is not this form.
const FORM_FIRST_DAY = '2021-07-01';
const KEY_PREFIX = 'consumer-notices/';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SIGNED_URL_SECONDS = 300;
const SUPPORTED_MESSAGE = 'Supported files are JPG, PNG and PDF, up to 10 MB';
// A sent or opened (not yet signed) notice shows in the list; it never counts.
const LISTED_STATUSES = ['draft', 'sent', 'viewed', 'signed'];

function noticeError(message, status = 400) {
  return Object.assign(new Error(message), { status, isOperational: true });
}

// { y, m, d } or a YYYY-MM-DD string (a timestamp's first ten characters
// pass); anything else is not a day.
function dayParts(value) {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const { y, m, d } = value;
    return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) ? { y, m, d } : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? { y: +match[1], m: +match[2], d: +match[3] } : null;
}

const dayKey = ({ y, m, d }) => y * 10000 + m * 100 + d;
const usDate = ({ y, m, d }) => `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;

// MM/DD/YYYY → { y, m, d } for a real calendar day, else null.
function parseUsDay(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const day = { y: +match[3], m: +match[1], d: +match[2] };
  const check = new Date(Date.UTC(day.y, day.m - 1, day.d));
  return check.getUTCMonth() === day.m - 1 && check.getUTCDate() === day.d ? day : null;
}

// Every notice the customer has, newest signed day first; `usable` is true
// for a signed e-sign contract and for every paper record.
async function noticeRows(conn, customerId) {
  const esigned = await conn('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY })
    .whereIn('status', LISTED_STATUSES)
    .select('id', 'status', 'signed_at', 'created_at');
  const paper = await conn('consumer_notice_paper_records')
    .where({ customer_id: customerId })
    // A date column read as text: the driver would turn it into a local-midnight Date.
    .select('id', 'file_name', 'notes', db.raw("to_char(signed_on, 'YYYY-MM-DD') as signed_on"));
  const rows = [];
  for (const row of esigned) {
    const signed = row.status === 'signed' && row.signed_at;
    const day = signed ? dayParts(etDateString(new Date(row.signed_at))) : null;
    rows.push({
      source: 'esign',
      id: row.id,
      status: row.status,
      usable: Boolean(day),
      day,
      sortAt: new Date(row.signed_at || row.created_at).getTime(),
    });
  }
  for (const row of paper) {
    const day = dayParts(row.signed_on);
    if (!day) continue;
    rows.push({ source: 'paper', id: row.id, status: 'signed', usable: true, day, fileName: row.file_name, notes: row.notes || null, sortAt: Date.UTC(day.y, day.m - 1, day.d) });
  }
  // Signed day first; an e-sign notice wins a tie (it carries the signature itself).
  const dayOrder = (row) => (row.day ? dayKey(row.day) : 0);
  return rows.sort((a, b) => (dayOrder(b) - dayOrder(a)) || (a.source === b.source ? b.sortAt - a.sortAt : (a.source === 'esign' ? -1 : 1)));
}

// The latest notice signed on or before `onOrBefore`, or null. Rule
// 5E-14.105(1): the notice comes before the contract, so a later one never
// counts for it.
async function findConsumerNotice(conn, customerId, { onOrBefore } = {}) {
  const limit = dayParts(onOrBefore);
  if (!limit) throw new Error('findConsumerNotice needs an onOrBefore day');
  const found = (await noticeRows(conn, customerId))
    .find((row) => row.usable && dayKey(row.day) <= dayKey(limit));
  return found ? { source: found.source, id: found.id, signedOn: usDate(found.day) } : null;
}

async function listConsumerNotices(customerId, conn = db) {
  return (await noticeRows(conn, customerId)).map((row) => ({
    source: row.source,
    id: row.id,
    status: row.status,
    usable: row.usable,
    signedOn: row.day ? usDate(row.day) : null,
    signedOnIso: row.day ? `${row.day.y}-${String(row.day.m).padStart(2, '0')}-${String(row.day.d).padStart(2, '0')}` : null,
    fileName: row.fileName || null,
    notes: row.notes || null,
  }));
}

// ── Paper scan upload ───────────────────────────────────────────────────────

let client = null;
function s3() {
  if (!client) {
    client = new S3Client({
      region: config.s3?.region,
      credentials: config.s3?.accessKeyId
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });
  }
  return client;
}

const EXTENSIONS = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'application/pdf': ['pdf'] };

function declaredMime(file) {
  const mime = String(file?.mimetype || '').split(';')[0].trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function detectedMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

// The declared type and file name must be JPG, PNG or PDF, and the first bytes
// must agree. Returns the type stored with the file.
function validatePaperFile(file) {
  if (!file?.buffer?.length) throw noticeError('The file is empty.');
  if (file.buffer.length > MAX_FILE_BYTES) throw noticeError('The file is larger than 10 MB.', 413);
  const extension = (String(file.originalname || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  const declared = declaredMime(file);
  if (!EXTENSIONS[declared] || !EXTENSIONS[declared].includes(extension)) throw noticeError(SUPPORTED_MESSAGE);
  if (detectedMime(file.buffer) !== declared) throw noticeError(`The file content does not match its type. ${SUPPORTED_MESSAGE}`);
  return declared;
}

// A real MM/DD/YYYY day that is not in the future (Eastern) and not before
// the form's Rev. 07/21 start. Returns { y, m, d }.
function validatePaperSignedOn(value, today = etDateString()) {
  const day = parseUsDay(value);
  if (!day) throw noticeError('Enter the date the form was signed as MM/DD/YYYY.');
  if (dayKey(day) > dayKey(dayParts(today))) throw noticeError('The signed date cannot be in the future.');
  if (dayKey(day) < dayKey(dayParts(FORM_FIRST_DAY))) throw noticeError('The signed date cannot be before 07/01/2021: the form on file is Rev. 07/21.');
  return day;
}

function safeFileName(name) {
  const safe = String(name || 'consumer-notice')
    .replace(/[/\\?%*:|"<>\r\n]/g, '_')
    .trim()
    .slice(0, 180);
  return safe || 'consumer-notice';
}

function present(row, day) {
  return {
    source: 'paper',
    id: row.id,
    signedOn: usDate(day),
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    notes: row.notes || null,
  };
}

// Stores the scan (private, no public ACL) and records it. A failed insert
// removes the stored object.
async function recordPaperNotice(customerId, file, { signedOn, notes, adminId = null, today } = {}) {
  if (!config.s3?.bucket) throw noticeError('File storage is not configured.', 500);
  const mimeType = validatePaperFile(file);
  const day = validatePaperSignedOn(signedOn, today);
  const note = String(notes || '').trim().slice(0, 500);
  const key = `${KEY_PREFIX}${customerId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  await s3().send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: file.buffer, ContentType: mimeType }));
  try {
    const [row] = await db('consumer_notice_paper_records').insert({
      customer_id: customerId,
      signed_on: `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`,
      s3_key: key,
      file_name: safeFileName(file.originalname),
      mime_type: mimeType,
      file_size_bytes: file.buffer.length,
      recorded_by_admin_id: adminId || null,
      notes: note || null,
    }).returning(['id', 'file_name', 'mime_type', 'file_size_bytes', 'notes']);
    return present(row, day);
  } catch (err) {
    try {
      await s3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    } catch (cleanupErr) {
      logger.warn(`[consumer-notices] could not remove the stored scan after a failed insert: ${cleanupErr.message}`);
    }
    throw err;
  }
}

async function getPaperRecord(customerId, recordId) {
  return db('consumer_notice_paper_records').where({ id: recordId, customer_id: customerId }).first();
}

// A short-lived link to view the scan; the key is never returned.
async function signedViewUrl(record, expiresIn = SIGNED_URL_SECONDS) {
  if (!record?.s3_key) throw noticeError('Notice not found.', 404);
  if (!config.s3?.bucket) throw noticeError('File storage is not configured.', 500);
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: record.s3_key,
    ResponseContentDisposition: `inline; filename="${safeFileName(record.file_name)}"`,
    ResponseContentType: record.mime_type || undefined,
  }), { expiresIn });
}

module.exports = {
  CONSUMER_NOTICE_TEMPLATE_KEY,
  CONSUMER_NOTICE_GRACE_END,
  FORM_FIRST_DAY,
  MAX_FILE_BYTES,
  findConsumerNotice,
  listConsumerNotices,
  recordPaperNotice,
  getPaperRecord,
  signedViewUrl,
  parseUsDay,
  validatePaperFile,
  validatePaperSignedOn,
};
