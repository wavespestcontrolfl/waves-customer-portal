'use strict';

// Bid kit files (GATE_BID_KIT, dark, admin only). Private S3 storage for the papers a bid asks for: a PDF, PNG, JPEG
// or DOCX, at most 15 MB, under `bid-kit/<item id>/<random>-<name>`. No public ACL is ever set, and a file opens only
// through a signed link that lasts at most 5 minutes. Nothing here reads the database.
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const catalog = require('../../shared/bid-kit-catalog.cjs');
const logger = require('./logger');
const { errorTag } = require('./bid-kit-log');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const SIGNED_URL_SECONDS = 300;
const KEY_PREFIX = 'bid-kit/';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TYPES = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  [DOCX_TYPE]: ['docx'],
};
const SUPPORTED_MESSAGE = 'Supported files are PDF, PNG, JPEG and DOCX, up to 15 MB';

class FileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

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

const extensionOf = (name = '') => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const normalizeMime = (mime = '') => {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  return type === 'image/jpg' ? 'image/jpeg' : type;
};

// What the bytes are, from their first bytes (a DOCX is a zip that holds word/document.xml).
function detectType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buffer[0] === 0x89 && buffer.slice(1, 4).toString('latin1') === 'PNG' && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04 && buffer.includes('word/document.xml')) return DOCX_TYPE;
  return null;
}

// The declared type and file name must be one of the four, and the bytes must be what they claim. Returns the type
// stored with the file.
function validateFile(file) {
  if (!file || !file.buffer || !file.buffer.length) throw new FileError('The file is empty');
  if (file.buffer.length > MAX_FILE_BYTES) throw new FileError('The file is larger than 15 MB', 413);
  const ext = extensionOf(file.originalname);
  const declared = normalizeMime(file.mimetype);
  if (!TYPES[declared] || !TYPES[declared].includes(ext)) throw new FileError(SUPPORTED_MESSAGE);
  const detected = detectType(file.buffer);
  if (detected !== declared) throw new FileError('The file content does not match its type. ' + SUPPORTED_MESSAGE);
  // A file name is typed text too: one that carries a tax ID or SSN (W9-123-45-6789.pdf) is refused, never stored or cleaned,
  // so the number cannot reach file_name, a list response or a signed link. The refusal never repeats the name.
  if (catalog.detectTaxId(file.originalname, { fileName: true }) || catalog.detectTaxId(safeFileName(file.originalname), { fileName: true })) throw new FileError(catalog.TAX_ID_REFUSED);
  return detected;
}

// The name kept with the file: no path, no quotes, no control characters.
const MAX_NAME_CHARS = 80;
function safeFileName(name = 'file') {
  const cleaned = String(name || 'file')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim();
  // A long name is shortened in the middle of the base, never at the end: the extension stays, so the stored name still says
  // what kind of file it is.
  const match = cleaned.match(/^(.*?)(\.[A-Za-z0-9]{1,5})$/);
  const [base, ext] = match ? [match[1], match[2]] : [cleaned, ''];
  const shortened = `${base.slice(0, Math.max(1, MAX_NAME_CHARS - ext.length)).trimEnd()}${ext}`;
  return shortened === '' ? 'file' : shortened;
}

// The name a signed link offers. A stored name that somehow holds a tax ID is replaced by a plain one.
function downloadName(fileName, contentType) {
  const name = safeFileName(fileName);
  return catalog.detectTaxId(name, { fileName: true }) ? `file.${(TYPES[contentType] || ['bin'])[0]}` : name;
}

const keyFingerprint = (key) => crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 12);

// Stores one file under a new private key and returns what the row keeps.
async function putFile(itemId, file) {
  if (!config.s3?.bucket) throw new FileError('File storage is not configured', 500);
  const contentType = validateFile(file);
  const fileName = safeFileName(file.originalname);
  // The key never carries the original name: a random token and a whitelisted extension only.
  const key = `${KEY_PREFIX}${itemId}/${crypto.randomBytes(8).toString('hex')}.${TYPES[contentType][0]}`;
  try {
    // Never cached by a browser or a proxy: the signed link is short-lived, and the file must not outlive it in a cache.
    await s3().send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: file.buffer, ContentType: contentType, CacheControl: NO_CACHE }));
  } catch (err) {
    // A timeout or a reset can leave the object stored although the call failed. No row points at this key yet, so it is
    // removed best effort before the error goes on (a fixed line, the item id only).
    logger.warn(`[bid-kit] storing a file for item ${itemId} failed; a cleanup delete of the new key was sent`);
    await deleteFile(key);
    throw err;
  }
  return { key, fileName, contentType, size: file.buffer.length };
}

const NO_CACHE = 'private, no-store';

// A link that opens the file for 5 minutes at most; the response says no-store, so no cache keeps the file after the link expires.
async function signedUrl({ key, fileName, contentType }) {
  if (!key) throw new FileError('There is no file on this item', 404);
  if (!config.s3?.bucket) throw new FileError('File storage is not configured', 500);
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    ResponseContentDisposition: `inline; filename="${downloadName(fileName, contentType)}"`,
    ResponseContentType: contentType || undefined,
    ResponseCacheControl: NO_CACHE,
  }), { expiresIn: SIGNED_URL_SECONDS });
}

// Best effort: a failed delete leaves a private object that nothing points at; the row is already right.
async function deleteFile(key) {
  if (!key || !config.s3?.bucket) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  } catch (err) {
    logger.warn(`[bid-kit] could not delete stored file ${keyFingerprint(key)}: ${errorTag(err)}`);
  }
}

module.exports = {
  FileError, MAX_FILE_BYTES, SIGNED_URL_SECONDS, KEY_PREFIX, SUPPORTED_MESSAGE, DOCX_TYPE,
  validateFile, detectType, safeFileName, putFile, signedUrl, deleteFile,
};
