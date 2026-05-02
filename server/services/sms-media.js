const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const config = require('../config');
const logger = require('./logger');

const PREFIX = 'sms-media/';
const OUTBOUND_PREFIX = 'sms-attachments/';
const URL_TTL_SECONDS = 60 * 60;

function attachmentTokenSecret() {
  return config.jwt?.secret || config.twilio?.authToken || null;
}

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function getExtension(contentType) {
  switch ((contentType || '').split(';')[0].toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

function parseStoredMedia(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function createAttachmentToken({ key, size, mimeType }) {
  const secret = attachmentTokenSecret();
  if (!secret) throw new Error('SMS attachment token secret is not configured');
  const payload = [key || '', size || '', mimeType || ''].join('|');
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

function isValidAttachmentToken(attachment = {}) {
  if (!attachment?.key || !attachment?.attachmentToken) return false;
  if (!attachment.key.startsWith(OUTBOUND_PREFIX)) return false;
  const expected = createAttachmentToken({
    key: attachment.key,
    size: attachment.size,
    mimeType: attachment.mimeType || attachment.contentType,
  });
  try {
    return crypto.timingSafeEqual(
      Buffer.from(String(attachment.attachmentToken), 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

function isSignableStoredMediaKey(key) {
  return typeof key === 'string' &&
    (key.startsWith(`${PREFIX}inbound/`) || key.startsWith(OUTBOUND_PREFIX));
}

function extractTwilioMedia(body = {}) {
  const count = Math.min(parseInt(body.NumMedia || '0', 10) || 0, 10);
  const media = [];
  for (let i = 0; i < count; i++) {
    const url = body[`MediaUrl${i}`];
    if (!url) continue;
    media.push({
      provider: 'twilio',
      providerUrl: url,
      contentType: body[`MediaContentType${i}`] || null,
      index: i,
    });
  }
  return media;
}

function isAllowedTwilioMediaUrl(url, body = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'api.twilio.com') return false;

    const accountSid = body.AccountSid || config.twilio?.accountSid;
    const messageSid = body.MessageSid;
    if (!accountSid || !messageSid) return false;

    const expectedPrefix = `/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media/`;
    return parsed.pathname.startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

async function uploadTwilioMedia(body = {}) {
  const inbound = extractTwilioMedia(body);
  if (!inbound.length || !config.s3?.bucket) return inbound;
  if (!config.twilio?.accountSid || !config.twilio?.authToken) return inbound;

  const auth = Buffer
    .from(`${config.twilio.accountSid}:${config.twilio.authToken}`)
    .toString('base64');

  const uploaded = [];
  for (const item of inbound) {
    try {
      if (!isAllowedTwilioMediaUrl(item.providerUrl, body)) {
        logger.warn('[sms-media] Rejected unexpected inbound Twilio media URL');
        uploaded.push({ ...item, providerUrl: null, rejected: true });
        continue;
      }
      const response = await fetch(item.providerUrl, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!response.ok) throw new Error(`Twilio media fetch failed (${response.status})`);
      const contentType = response.headers.get('content-type') || item.contentType || 'application/octet-stream';
      const bytes = Buffer.from(await response.arrayBuffer());
      const key = `${PREFIX}inbound/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${item.index}.${getExtension(contentType)}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }));
      uploaded.push({
        ...item,
        key,
        contentType,
        size: bytes.length,
      });
    } catch (err) {
      logger.error(`[sms-media] Failed to persist inbound media: ${err.message}`);
      uploaded.push(item);
    }
  }
  return uploaded;
}

async function signMediaForClient(value) {
  const media = parseStoredMedia(value);
  if (!media.length) return [];
  return Promise.all(media.map(async (item) => {
    if (item.key && config.s3?.bucket && isSignableStoredMediaKey(item.key)) {
      try {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: config.s3.bucket, Key: item.key }),
          { expiresIn: URL_TTL_SECONDS },
        );
        return { ...item, url };
      } catch (err) {
        logger.error(`[sms-media] Failed to sign media ${item.key}: ${err.message}`);
      }
    }
    return { ...item, url: item.url || item.providerUrl || null };
  }));
}

function mediaFromOutboundAttachments(attachments = [], urls = []) {
  if (Array.isArray(attachments) && attachments.length) {
    return attachments.slice(0, 10).map((a, index) => ({
      direction: 'outbound',
      key: isValidAttachmentToken(a) ? a.key : null,
      url: a.url || null,
      fileName: a.fileName || null,
      contentType: a.mimeType || a.contentType || null,
      size: a.size || null,
      index,
    }));
  }
  return (Array.isArray(urls) ? urls : []).slice(0, 10).map((url, index) => ({
    direction: 'outbound',
    url,
    index,
  }));
}

module.exports = {
  extractTwilioMedia,
  uploadTwilioMedia,
  signMediaForClient,
  mediaFromOutboundAttachments,
  createAttachmentToken,
  // Exposed for tests/review and to document the SSRF guard.
  isAllowedTwilioMediaUrl,
};
