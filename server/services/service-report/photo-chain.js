const crypto = require('crypto');
const db = require('../../models/db');

const PHOTO_CHAIN_COLUMNS = [
  'id',
  'service_record_id',
  'photo_type',
  's3_key',
  'storage_key',
  'thumbnail_key',
  'caption',
  'state_badge',
  'zone_id',
  'finding_id',
  'gps_lat',
  'gps_lng',
  'captured_at',
  'device',
  'app_version',
  'ai_tags',
  'annotation',
  'image_sha256',
  'sort_order',
  'created_at',
  'hash_sha256',
  'prev_hash_sha256',
];

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashBuffer(buffer) {
  return sha256Hex(buffer);
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function normalizeDecimal(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Math.round(n * 1_000_000) / 1_000_000;
}

function canonicalize(value) {
  if (value == null) return null;
  if (value instanceof Date) return normalizeDate(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        if (value[key] !== undefined) out[key] = canonicalize(value[key]);
        return out;
      }, {});
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function buildPhotoChainPayload(photo, prevHash = null) {
  return {
    service_record_id: photo.service_record_id || null,
    storage_key: photo.storage_key || photo.s3_key || null,
    thumbnail_key: photo.thumbnail_key || null,
    photo_type: photo.photo_type || null,
    caption: photo.caption || null,
    state_badge: photo.state_badge || null,
    zone_id: photo.zone_id || null,
    finding_id: photo.finding_id || null,
    gps_lat: normalizeDecimal(photo.gps_lat),
    gps_lng: normalizeDecimal(photo.gps_lng),
    captured_at: normalizeDate(photo.captured_at || photo.created_at),
    device: photo.device || null,
    app_version: photo.app_version || null,
    ai_tags: parseMaybeJson(photo.ai_tags),
    annotation: parseMaybeJson(photo.annotation),
    image_sha256: photo.image_sha256 || null,
    sort_order: photo.sort_order == null ? null : Number(photo.sort_order),
    prev_hash_sha256: prevHash || null,
  };
}

function hashPhotoChainPayload(photo, prevHash = null) {
  return sha256Hex(stableStringify(buildPhotoChainPayload(photo, prevHash)));
}

function photoSortTime(photo) {
  const date = new Date(photo.captured_at || photo.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function sortPhotoRowsForChain(rows = []) {
  return [...rows].sort((a, b) => {
    const timeDelta = photoSortTime(a) - photoSortTime(b);
    if (timeDelta) return timeDelta;
    const sortDelta = Number(a.sort_order || 0) - Number(b.sort_order || 0);
    if (sortDelta) return sortDelta;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function validatePhotoChainRows(rows = []) {
  const ordered = sortPhotoRowsForChain(rows);
  let prevHash = null;
  for (const photo of ordered) {
    if ((photo.prev_hash_sha256 || null) !== prevHash) {
      return {
        valid: false,
        photo_count: ordered.length,
        broken_at: photo.id || null,
        reason: 'prev_hash_mismatch',
        expected_prev_hash_sha256: prevHash,
        actual_prev_hash_sha256: photo.prev_hash_sha256 || null,
      };
    }

    const expectedHash = hashPhotoChainPayload(photo, prevHash);
    if (!photo.hash_sha256 || photo.hash_sha256 !== expectedHash) {
      return {
        valid: false,
        photo_count: ordered.length,
        broken_at: photo.id || null,
        reason: 'hash_mismatch',
        expected_hash_sha256: expectedHash,
        actual_hash_sha256: photo.hash_sha256 || null,
      };
    }
    prevHash = photo.hash_sha256;
  }

  return {
    valid: true,
    photo_count: ordered.length,
    broken_at: null,
  };
}

async function getPhotoSelectColumns(knex = db) {
  const info = await knex('service_photos').columnInfo();
  return PHOTO_CHAIN_COLUMNS.filter((column) => column === 'id' || info[column]);
}

async function latestPhotoHash(knex, serviceRecordId) {
  const info = await knex('service_photos').columnInfo();
  if (!info.hash_sha256) return null;
  let query = knex('service_photos')
    .where({ service_record_id: serviceRecordId })
    .whereNotNull('hash_sha256');
  if (info.captured_at) {
    query = query.orderByRaw('COALESCE(captured_at, created_at) DESC NULLS LAST');
  } else {
    query = query.orderBy('created_at', 'desc');
  }
  const row = await query
    .orderBy('sort_order', 'desc')
    .orderBy('id', 'desc')
    .first('hash_sha256');
  return row?.hash_sha256 || null;
}

async function validatePhotoChain(serviceRecordId, knex = db) {
  const columns = await getPhotoSelectColumns(knex);
  let query = knex('service_photos')
    .where({ service_record_id: serviceRecordId })
    .select(columns);
  if (columns.includes('captured_at')) {
    query = query.orderByRaw('COALESCE(captured_at, created_at) ASC NULLS LAST');
  } else {
    query = query.orderBy('created_at', 'asc');
  }
  const rows = await query
    .orderBy('sort_order', 'asc')
    .orderBy('id', 'asc');
  return validatePhotoChainRows(rows);
}

module.exports = {
  PHOTO_CHAIN_COLUMNS,
  buildPhotoChainPayload,
  hashBuffer,
  hashPhotoChainPayload,
  latestPhotoHash,
  sortPhotoRowsForChain,
  stableStringify,
  validatePhotoChain,
  validatePhotoChainRows,
};
