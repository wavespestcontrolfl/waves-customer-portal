'use strict';

// Bid kit files (GATE_BID_KIT, dark, admin only). Private S3 storage for the papers a bid asks for: a PDF, PNG, JPEG
// or DOCX, at most 15 MB, under `bid-kit/<item id>/<random>-<name>`. No public ACL is ever set, and a file opens only
// through a signed link that lasts at most 5 minutes. Nothing here reads the database.
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('./logger');

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
  return detected;
}

// The name kept with the file: no path, no quotes, no control characters.
function safeFileName(name = 'file') {
  const cleaned = String(name || 'file')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim()
    .slice(0, 80);
  return cleaned || 'file';
}

const keyFingerprint = (key) => crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 12);

// Stores one file under a new private key and returns what the row keeps.
async function putFile(itemId, file) {
  if (!config.s3?.bucket) throw new FileError('File storage is not configured', 500);
  const contentType = validateFile(file);
  const fileName = safeFileName(file.originalname);
  const key = `${KEY_PREFIX}${itemId}/${crypto.randomBytes(8).toString('hex')}-${fileName.replace(/ /g, '_')}`;
  await s3().send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: file.buffer, ContentType: contentType }));
  return { key, fileName, contentType, size: file.buffer.length };
}

// A link that opens the file for 5 minutes at most.
async function signedUrl({ key, fileName, contentType }) {
  if (!key) throw new FileError('There is no file on this item', 404);
  if (!config.s3?.bucket) throw new FileError('File storage is not configured', 500);
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    ResponseContentDisposition: `inline; filename="${safeFileName(fileName)}"`,
    ResponseContentType: contentType || undefined,
  }), { expiresIn: SIGNED_URL_SECONDS });
}

// Best effort: a failed delete leaves a private object that nothing points at; the row is already right.
async function deleteFile(key) {
  if (!key || !config.s3?.bucket) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  } catch (err) {
    logger.warn(`[bid-kit] could not delete stored file ${keyFingerprint(key)}: ${err?.name || 'Error'}`);
  }
}

module.exports = {
  FileError, MAX_FILE_BYTES, SIGNED_URL_SECONDS, KEY_PREFIX, SUPPORTED_MESSAGE, DOCX_TYPE,
  validateFile, detectType, safeFileName, putFile, signedUrl, deleteFile,
};
