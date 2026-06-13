const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../models/db');
const config = require('../config');
const { isUserFeatureEnabled } = require('./feature-flags');

const VISUAL_SERVICE_NOTES_FLAG = 'visual_service_notes_enabled';
const VISUAL_SERVICE_NOTES_REQUIRED_FLAG = 'visual_service_notes_required';
const VISUAL_SERVICE_NOTES_ENABLED_SETTING = 'visualServiceNotesEnabled';
const VISUAL_SERVICE_NOTES_REQUIRED_SETTING = 'visualServiceNotesRequired';
const VISUAL_SERVICE_NOTES_SETTING_CATEGORY = 'visual_service_notes';
const VISUAL_SERVICE_NOTES_SETTING_DESCRIPTIONS = {
  [VISUAL_SERVICE_NOTES_ENABLED_SETTING]: 'Global enable flag for optional Visual Service Notes. User feature flag visual_service_notes_enabled can also enable it per user.',
  [VISUAL_SERVICE_NOTES_REQUIRED_SETTING]: 'Future-only setting for requiring Visual Service Notes. Default false and not enforced in MVP.',
};

const VISIBILITY_STATUSES = new Set([
  'internal_only',
  'draft_customer',
  'approved_customer',
  'rejected',
]);

const PROCESSING_STATUSES = new Set(['none', 'pending', 'processed', 'failed']);
const MEDIA_TYPES = new Set(['none', 'photo', 'video']);
const ACTIVE_VISUAL_NOTE_STATUSES = new Set(['on_site']);
const MAX_VISUAL_MOMENT_MEDIA_BYTES = 50 * 1024 * 1024;
const VISUAL_MOMENT_MEDIA_PREFIX = 'visual-service-notes/';

const TAG_CATALOG = [
  { tagCode: 'bugs_seen', label: 'Bugs Seen', group: 'observation', serviceTypes: ['pest', 'rodent', 'termite', 'mosquito', 'other'], sortOrder: 10, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'treatment_applied', label: 'Treatment Applied', group: 'treatment', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 20, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'moisture_issue', label: 'Moisture Issue', group: 'observation', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 30, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'access_issue', label: 'Access Issue', group: 'access', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 40, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'recommendation', label: 'Recommendation', group: 'recommendation', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 50, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'before', label: 'Before', group: 'before_after', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 60, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'after', label: 'After', group: 'before_after', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 70, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'no_major_activity', label: 'No Major Activity', group: 'general', serviceTypes: ['pest', 'lawn', 'rodent', 'termite', 'tree_shrub', 'mosquito', 'other'], sortOrder: 80, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'ants', label: 'Ants', group: 'observation', serviceTypes: ['pest'], sortOrder: 110, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'roaches', label: 'Roaches', group: 'observation', serviceTypes: ['pest'], sortOrder: 120, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'spiders_webs', label: 'Spiders / Webs', group: 'observation', serviceTypes: ['pest'], sortOrder: 130, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'wasps', label: 'Wasps', group: 'observation', serviceTypes: ['pest'], sortOrder: 140, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'entry_point', label: 'Entry Point', group: 'access', serviceTypes: ['pest', 'rodent', 'termite'], sortOrder: 150, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'conducive_condition', label: 'Conducive Condition', group: 'observation', serviceTypes: ['pest', 'rodent', 'termite'], sortOrder: 160, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'weeds', label: 'Weeds', group: 'observation', serviceTypes: ['lawn'], sortOrder: 210, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'fungus_disease', label: 'Fungus / Disease', group: 'observation', serviceTypes: ['lawn'], sortOrder: 220, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'chinch_insects', label: 'Chinch / Lawn Insects', group: 'observation', serviceTypes: ['lawn'], sortOrder: 230, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'dry_spot', label: 'Dry Spot', group: 'observation', serviceTypes: ['lawn'], sortOrder: 240, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'irrigation_issue', label: 'Irrigation Issue', group: 'observation', serviceTypes: ['lawn'], sortOrder: 250, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'thin_turf', label: 'Thin Turf', group: 'observation', serviceTypes: ['lawn'], sortOrder: 260, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'rodent_activity', label: 'Rodent Activity', group: 'observation', serviceTypes: ['rodent'], sortOrder: 310, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'droppings', label: 'Droppings / Activity', group: 'observation', serviceTypes: ['rodent'], sortOrder: 320, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'exclusion_work', label: 'Exclusion Work', group: 'treatment', serviceTypes: ['rodent'], sortOrder: 330, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'trap_station_checked', label: 'Trap / Station Checked', group: 'treatment', serviceTypes: ['rodent'], sortOrder: 340, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'sanitation_issue', label: 'Sanitation Issue', group: 'recommendation', serviceTypes: ['rodent'], sortOrder: 350, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'whitefly', label: 'Whitefly', group: 'observation', serviceTypes: ['tree_shrub'], sortOrder: 410, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'scale', label: 'Scale', group: 'observation', serviceTypes: ['tree_shrub'], sortOrder: 420, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'mites', label: 'Mites', group: 'observation', serviceTypes: ['tree_shrub'], sortOrder: 430, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'plant_disease', label: 'Plant Disease', group: 'observation', serviceTypes: ['tree_shrub'], sortOrder: 440, defaultCustomerVisible: false, requiresMedia: false },
  { tagCode: 'nutrient_issue', label: 'Nutrient Issue', group: 'observation', serviceTypes: ['tree_shrub'], sortOrder: 450, defaultCustomerVisible: false, requiresMedia: false },
];

const LOCATION_AREAS = [
  'Front Yard',
  'Backyard',
  'Left Side',
  'Right Side',
  'Garage Side',
  'Driveway Edge',
  'Lanai',
  'Perimeter',
  'Interior',
  'Other',
];

const TAG_BY_CODE = Object.fromEntries(TAG_CATALOG.map((tag) => [tag.tagCode, tag]));

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

function parseBooleanSetting(value, defaultValue = false) {
  if (value == null) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

async function systemSettingBoolean(key, defaultValue = false, knex = db) {
  const row = await knex('system_settings').where({ key }).first('value').catch(() => null);
  return parseBooleanSetting(row?.value, defaultValue);
}

async function isVisualServiceNotesEnabled(userId, knex = db) {
  const globalEnabled = await systemSettingBoolean(VISUAL_SERVICE_NOTES_ENABLED_SETTING, false, knex);
  if (globalEnabled) return true;
  return isUserFeatureEnabled(userId, VISUAL_SERVICE_NOTES_FLAG, false, knex);
}

async function isVisualServiceNotesRequired(knex = db) {
  const required = await systemSettingBoolean(VISUAL_SERVICE_NOTES_REQUIRED_SETTING, false, knex);
  return required === true;
}

async function getVisualServiceNotesSettings(knex = db) {
  const [enabled, required] = await Promise.all([
    systemSettingBoolean(VISUAL_SERVICE_NOTES_ENABLED_SETTING, false, knex),
    systemSettingBoolean(VISUAL_SERVICE_NOTES_REQUIRED_SETTING, false, knex),
  ]);
  return { enabled, required };
}

async function upsertVisualServiceNotesSetting(key, value, knex = db) {
  await knex('system_settings')
    .insert({
      key,
      value: value ? 'true' : 'false',
      category: VISUAL_SERVICE_NOTES_SETTING_CATEGORY,
      description: VISUAL_SERVICE_NOTES_SETTING_DESCRIPTIONS[key] || null,
    })
    .onConflict('key')
    .merge({
      value: value ? 'true' : 'false',
      category: VISUAL_SERVICE_NOTES_SETTING_CATEGORY,
      description: VISUAL_SERVICE_NOTES_SETTING_DESCRIPTIONS[key] || null,
      updated_at: knex.fn.now(),
    });
}

async function setVisualServiceNotesSettings({ enabled, required } = {}, knex = db) {
  const writes = [];
  if (typeof enabled === 'boolean') {
    writes.push(upsertVisualServiceNotesSetting(VISUAL_SERVICE_NOTES_ENABLED_SETTING, enabled, knex));
  }
  if (typeof required === 'boolean') {
    writes.push(upsertVisualServiceNotesSetting(VISUAL_SERVICE_NOTES_REQUIRED_SETTING, required, knex));
  }
  if (writes.length) await Promise.all(writes);
  return getVisualServiceNotesSettings(knex);
}

function serviceTypeKey(serviceType) {
  const text = String(serviceType || '').toLowerCase();
  if (text.includes('lawn') || text.includes('turf')) return 'lawn';
  if (text.includes('rodent') || text.includes('rat') || text.includes('mouse')) return 'rodent';
  if (text.includes('termite')) return 'termite';
  if (text.includes('tree') || text.includes('shrub') || text.includes('palm')) return 'tree_shrub';
  if (text.includes('mosquito')) return 'mosquito';
  if (text.includes('pest') || text.includes('roach') || text.includes('ant') || text.includes('wasp')) return 'pest';
  return 'other';
}

function tagForCode(tagCode) {
  return TAG_BY_CODE[String(tagCode || '').trim()];
}

function nullIfEmpty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function truncateText(value, max = 1000) {
  const text = nullIfEmpty(value);
  if (!text) return null;
  return text.slice(0, max);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateOrNow(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function safeFilename(value, fallback = 'visual-note-media') {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || fallback;
}

function mediaTypeForMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('image/')) return 'photo';
  if (normalized.startsWith('video/')) return 'video';
  return null;
}

async function uploadVisualMomentMedia(file, metadata = {}) {
  if (!file) {
    return {
      mediaType: 'none',
      mediaStorageKey: null,
      thumbnailStorageKey: null,
      mediaDurationSeconds: null,
      uploadStatus: 'uploaded',
      processingStatus: 'none',
    };
  }
  if (!config.s3?.bucket) {
    const err = new Error('S3 not configured');
    err.statusCode = 500;
    throw err;
  }
  if (!Buffer.isBuffer(file.buffer) || !file.buffer.length) {
    const err = new Error('Media file is empty');
    err.statusCode = 400;
    throw err;
  }
  if (file.buffer.length > MAX_VISUAL_MOMENT_MEDIA_BYTES) {
    const err = new Error('Visual note media exceeds 50MB limit');
    err.statusCode = 413;
    throw err;
  }
  const mediaType = mediaTypeForMime(file.mimetype);
  if (!mediaType) {
    const err = new Error('Visual note media must be a photo or video');
    err.statusCode = 400;
    throw err;
  }

  const jobId = safeFilename(metadata.jobId || 'job');
  const filename = safeFilename(file.originalname || (mediaType === 'video' ? 'clip.mp4' : 'photo.jpg'));
  const key = `${VISUAL_MOMENT_MEDIA_PREFIX}${jobId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || (mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
  }));
  return {
    mediaType,
    mediaStorageKey: key,
    thumbnailStorageKey: null,
    mediaDurationSeconds: null,
    uploadStatus: 'uploaded',
    processingStatus: mediaType === 'video' ? 'pending' : 'none',
  };
}

async function signedVisualMomentMediaUrl(moment, expiresIn = 3600) {
  const key = moment?.media_storage_key || moment?.mediaStorageKey || null;
  if (!key || !config.s3?.bucket) return null;
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
  }), { expiresIn });
}

function templateCaptionForMoment(moment = {}) {
  const tagCode = moment.tag_code || moment.tagCode;
  const location = nullIfEmpty(moment.location_area || moment.locationArea) || 'the documented area';
  const note = nullIfEmpty(moment.note) || 'See technician note.';
  const templates = {
    bugs_seen: `Pest activity was observed near ${location}.`,
    ants: `Ant activity was observed near ${location}.`,
    weeds: `Weed pressure was observed near ${location}.`,
    moisture_issue: `Moisture was observed near ${location}. This may contribute to pest or lawn issues.`,
    treatment_applied: `Treatment was applied near ${location} during today's service.`,
    access_issue: `Access was limited near ${location}. Please make this area accessible before the next service.`,
    recommendation: `Your technician noted a recommendation near ${location}: ${note}`,
    no_major_activity: 'No major visible activity was documented during today\'s service.',
  };
  return templates[tagCode] || `${moment.tag_label || moment.tagLabel || 'Service note'} was documented near ${location}.`;
}

function customerCaptionForMoment(moment = {}) {
  return nullIfEmpty(moment.customer_caption || moment.customerCaption)
    || nullIfEmpty(moment.ai_caption || moment.aiCaption)
    || templateCaptionForMoment(moment);
}

function formatVisualMoment(row = {}, { mediaUrl = null, includeInternal = false } = {}) {
  const formatted = {
    id: row.id,
    jobId: row.job_id,
    customerId: row.customer_id || null,
    propertyId: row.property_id || null,
    technicianId: row.technician_id || null,
    routeId: row.route_id || null,
    tagCode: row.tag_code,
    tagLabel: row.tag_label,
    tagGroup: row.tag_group,
    serviceType: row.service_type,
    locationArea: row.location_area || null,
    mediaType: row.media_type || 'none',
    mediaUrl,
    thumbnailUrl: row.thumbnail_storage_key ? mediaUrl : null,
    mediaDurationSeconds: row.media_duration_seconds == null ? null : Number(row.media_duration_seconds),
    uploadStatus: row.upload_status || null,
    processingStatus: row.processing_status || 'none',
    visibilityStatus: row.visibility_status || 'internal_only',
    customerCaption: customerCaptionForMoment(row),
    capturedAt: row.captured_at || row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeInternal) {
    formatted.note = row.note || '';
    formatted.aiCaption = row.ai_caption || '';
    formatted.rawCustomerCaption = row.customer_caption || '';
    formatted.gpsLatitude = row.gps_latitude == null ? null : Number(row.gps_latitude);
    formatted.gpsLongitude = row.gps_longitude == null ? null : Number(row.gps_longitude);
    formatted.mediaStorageKey = row.media_storage_key || null;
    formatted.thumbnailStorageKey = row.thumbnail_storage_key || null;
    formatted.metadata = row.metadata || {};
  }
  return formatted;
}

function canCreateVisualServiceMoment({ job, technicianId, techRole, enabled }) {
  if (!enabled) {
    return { ok: false, status: 403, error: 'Visual Service Notes are disabled' };
  }
  if (!job) {
    return { ok: false, status: 404, error: 'Service not found' };
  }
  if (techRole !== 'admin' && String(job.technician_id || '') !== String(technicianId || '')) {
    return { ok: false, status: 403, error: 'Not assigned to this service' };
  }
  if (techRole !== 'admin' && !ACTIVE_VISUAL_NOTE_STATUSES.has(String(job.status || '').toLowerCase())) {
    return { ok: false, status: 409, error: 'Visual Notes are available when the service is active on property' };
  }
  return { ok: true };
}

function normalizeMomentInsert({ body = {}, job, technicianId, media = {} }) {
  const tag = tagForCode(body.tagCode || body.tag_code);
  if (!tag) {
    const err = new Error('tagCode is required');
    err.statusCode = 400;
    throw err;
  }
  const locationArea = nullIfEmpty(body.locationArea || body.location_area);
  if (locationArea && !LOCATION_AREAS.includes(locationArea)) {
    const err = new Error('locationArea is invalid');
    err.statusCode = 400;
    throw err;
  }
  const mediaType = media.mediaType || 'none';
  if (!MEDIA_TYPES.has(mediaType)) {
    const err = new Error('mediaType is invalid');
    err.statusCode = 400;
    throw err;
  }
  const processingStatus = media.processingStatus || 'none';
  if (!PROCESSING_STATUSES.has(processingStatus)) {
    const err = new Error('processingStatus is invalid');
    err.statusCode = 400;
    throw err;
  }
  return {
    job_id: job.id,
    customer_id: job.customer_id || null,
    property_id: job.property_id || null,
    technician_id: technicianId || job.technician_id || null,
    route_id: job.route_id || null,
    tag_code: tag.tagCode,
    tag_label: tag.label,
    tag_group: tag.group,
    service_type: serviceTypeKey(job.service_type),
    location_area: locationArea,
    note: truncateText(body.note, 1500),
    media_type: mediaType,
    media_storage_key: media.mediaStorageKey || null,
    thumbnail_storage_key: media.thumbnailStorageKey || null,
    media_duration_seconds: numberOrNull(media.mediaDurationSeconds),
    upload_status: media.uploadStatus || 'uploaded',
    processing_status: processingStatus,
    visibility_status: 'internal_only',
    ai_caption: null,
    customer_caption: truncateText(body.customerCaption || body.customer_caption || templateCaptionForMoment({
      tag_code: tag.tagCode,
      tag_label: tag.label,
      location_area: locationArea,
      note: body.note,
    }), 1500),
    gps_latitude: numberOrNull(body.gpsLatitude || body.gps_latitude),
    gps_longitude: numberOrNull(body.gpsLongitude || body.gps_longitude),
    captured_at: dateOrNow(body.capturedAt || body.captured_at),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
  };
}

async function loadApprovedVisualServiceMomentsForReport(service, knex = db) {
  const jobId = service?.scheduled_service_id || service?.job_id || null;
  if (!jobId) return [];
  const rows = await knex('visual_service_moments')
    .where({ job_id: jobId, visibility_status: 'approved_customer' })
    .orderBy('captured_at')
    .orderBy('created_at')
    .catch(() => []);
  const activeRows = rows.filter((row) => !row.deleted_at);
  return Promise.all(activeRows.map(async (row) => {
    const mediaUrl = await signedVisualMomentMediaUrl(row).catch(() => null);
    return formatVisualMoment(row, { mediaUrl, includeInternal: false });
  }));
}

async function invalidateVisualMomentReportPdfCache(jobId, knex = db) {
  if (!jobId) return;
  try {
    await knex('service_records')
      .where({ scheduled_service_id: jobId })
      .update({ pdf_storage_key: null });
  } catch {
    // Best-effort derived cache invalidation. Do not block review actions.
  }
}

module.exports = {
  VISUAL_SERVICE_NOTES_FLAG,
  VISUAL_SERVICE_NOTES_REQUIRED_FLAG,
  VISUAL_SERVICE_NOTES_ENABLED_SETTING,
  VISUAL_SERVICE_NOTES_REQUIRED_SETTING,
  VISUAL_SERVICE_NOTES_SETTING_CATEGORY,
  VISIBILITY_STATUSES,
  TAG_CATALOG,
  LOCATION_AREAS,
  ACTIVE_VISUAL_NOTE_STATUSES,
  MAX_VISUAL_MOMENT_MEDIA_BYTES,
  getVisualServiceNotesSettings,
  setVisualServiceNotesSettings,
  isVisualServiceNotesEnabled,
  isVisualServiceNotesRequired,
  canCreateVisualServiceMoment,
  normalizeMomentInsert,
  uploadVisualMomentMedia,
  signedVisualMomentMediaUrl,
  formatVisualMoment,
  customerCaptionForMoment,
  templateCaptionForMoment,
  tagForCode,
  serviceTypeKey,
  nullIfEmpty,
  truncateText,
  loadApprovedVisualServiceMomentsForReport,
  invalidateVisualMomentReportPdfCache,
};
