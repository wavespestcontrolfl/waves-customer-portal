/**
 * Admin photo-assessment create path (lawn assessment + pest identification)
 * as a service, so it runs without an HTTP request: one implementation, two
 * callers — the admin route (POST /api/admin/photo-assessments/:type,
 * source 'admin') and the inbound photo-text triage
 * (services/photo-text-triage.js, source 'auto_triage').
 *
 * createAdminAssessment({ type, source, photos, message_photos, lead_id,
 * customer_id, contact, address, note }) resolves the photos (base64 uploads
 * and/or stored inbound MMS media), resolves the lead/customer associations,
 * runs the SAME analysis ladder the public funnel runs, inserts the
 * prospect-mode row, and stores its photos. It returns
 * { id, type, analysis } on success or { error, status } on a refusal —
 * never a partial row.
 */

const sharp = require('sharp');

const db = require('../models/db');
const logger = require('./logger');
const { parseStoredMedia, isSignableStoredMediaKey } = require('./sms-media');
const lawnAssessment = require('./lawn-assessment');
const {
  buildDiagnosticReportContract,
  classifyReleaseMode,
  applyAutoReleaseRepair,
} = require('./lawn-diagnostic-report');
const {
  runFindingsLadder,
  applyWriterSummary,
  deriveOverallScore,
} = require('./lawn-diagnostic-analyze');
const { identifyPest, buildPestReportContract } = require('./pest-identification');
const { storeFunnelPhotos } = require('../utils/funnel-photos');
const { etParts } = require('../utils/datetime-et');

let PhotoService;
try { PhotoService = require('./photos'); } catch { PhotoService = null; }

const MAX_PHOTOS = 5;
const MAX_PHOTO_CHARS = 6_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Inbound MMS photos pulled into an assessment: resized to this max
// dimension and re-encoded as JPEG so every downstream consumer (vision
// ladder, funnel photo storage) sees the same shape normalizePhotos always
// produced — no separate code path for an SMS-sourced photo.
const MESSAGE_PHOTO_MAX_PX = 1600;
const MESSAGE_PHOTO_JPEG_QUALITY = 82;
const MESSAGE_PHOTO_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function cleanString(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// Resolves one { message_id, key } request-photo entry into a
// normalizePhotos-shaped { data, mimeType } photo, or an { error, status }
// describing why it was refused. The key must belong to THIS message's own
// stored inbound media AND pass isSignableStoredMediaKey — the guard against
// an admin (or a compromised admin session) reading an arbitrary S3 object
// by key.
async function loadMessagePhoto(entry) {
  const messageId = cleanString(entry?.message_id, 64);
  const key = typeof entry?.key === 'string' ? entry.key : null;
  if (!messageId || !UUID_RE.test(messageId) || !key) {
    return { error: 'Each message_photos entry needs a valid message_id and key', status: 400 };
  }

  const message = await db('messages').where({ id: messageId }).first();
  if (!message) return { error: `Message ${messageId} not found`, status: 404 };
  if (message.direction !== 'inbound') {
    return { error: `Message ${messageId} is not an inbound message`, status: 400 };
  }

  const storedMedia = parseStoredMedia(message.media);
  const mediaItem = storedMedia.find((item) => item && item.key === key);
  if (!mediaItem || !isSignableStoredMediaKey(key)) {
    return { error: `Photo key is not available on message ${messageId}`, status: 400 };
  }

  const declaredMime = cleanString(mediaItem.contentType || mediaItem.mimeType, 80);
  if (!declaredMime || !MESSAGE_PHOTO_ALLOWED_MIME.has(declaredMime.toLowerCase())) {
    return { error: `Unsupported photo type on message ${messageId}`, status: 400 };
  }

  if (!PhotoService) {
    logger.error(`[admin-photo-assessments] photo storage service unavailable for ${key}`);
    return { error: 'Could not fetch the photo from storage — try again in a moment.', status: 502 };
  }
  let raw;
  try {
    ({ buffer: raw } = await PhotoService.getPhotoBuffer(key));
  } catch (err) {
    logger.error(`[admin-photo-assessments] S3 fetch failed for ${key}: ${err.message}`);
    return { error: 'Could not fetch the photo from storage — try again in a moment.', status: 502 };
  }

  let jpegBuffer;
  try {
    jpegBuffer = await sharp(raw)
      .rotate()
      .resize(MESSAGE_PHOTO_MAX_PX, MESSAGE_PHOTO_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: MESSAGE_PHOTO_JPEG_QUALITY })
      .toBuffer();
  } catch (err) {
    logger.error(`[admin-photo-assessments] photo resize failed for ${key}: ${err.message}`);
    return { error: 'Could not process the photo — try again in a moment.', status: 502 };
  }

  let conversationCustomerId = null;
  if (message.conversation_id) {
    const conversation = await db('conversations').where({ id: message.conversation_id }).select('customer_id').first();
    conversationCustomerId = conversation?.customer_id || null;
  }

  return {
    photo: { data: jpegBuffer.toString('base64'), mimeType: 'image/jpeg' },
    customerId: conversationCustomerId,
  };
}

// Resolves every message_photos entry in order, short-circuiting on the
// first failure. Returns { photos, customerId } when every entry's own
// conversation customer agrees (including all-null), or an
// { error, status } when they don't.
async function resolveMessagePhotos(entries) {
  const photos = [];
  // Every selected message's own conversation customer, INCLUDING null for
  // an unlinked conversation — null is a distinct ownership state, not "no
  // opinion". Collecting only truthy ids would let a selection mixing a
  // customer-linked message with an unlinked one slip through as
  // "one distinct customer" and silently attribute the unlinked sender's
  // photo to that customer. A phone-keyed thread on the client can mix
  // messages from more than one customer (a shared/reassigned number) —
  // the client already refuses to submit a mixed selection, but this is
  // the authoritative check: message_photos whose messages don't all agree
  // (including agreeing on "none") is refused outright rather than
  // silently attributed to whichever entry happened to resolve first.
  const customerIds = [];
  for (const entry of entries) {
    const result = await loadMessagePhoto(entry);
    if (result.error) return { error: result.error, status: result.status };
    photos.push(result.photo);
    customerIds.push(result.customerId || null);
  }
  if (new Set(customerIds).size > 1) {
    return { error: 'Selected photos belong to different customers — pick photos from one customer.', status: 400 };
  }
  return { photos, customerId: customerIds[0] || null };
}

const TYPES = {
  lawn: {
    table: 'lawn_diagnostics',
    photoTable: 'lawn_diagnostic_photos',
    photoFk: 'diagnostic_id',
    photoKeyPrefix: 'lawnfunnel',
    reportPath: (token) => `/lawn-report/${token}`,
    label: 'Lawn Assessment',
  },
  pest: {
    table: 'pest_identifications',
    photoTable: 'pest_identification_photos',
    photoFk: 'identification_id',
    photoKeyPrefix: 'pestid',
    reportPath: (token) => `/pest-report/${token}`,
    label: 'Pest Identification',
  },
};

function normalizePhotos(rawPhotos) {
  const photos = Array.isArray(rawPhotos) ? rawPhotos.filter(Boolean) : [];
  return photos.map((photo, index) => ({
    photo_id: `photo-${index + 1}`,
    data: typeof photo.data === 'string' && photo.data ? photo.data : null,
    mimeType: cleanString(photo.mimeType || photo.mime_type, 80) || 'image/jpeg',
    quality: 'limited',
    limitations: [],
  }));
}

// Same pipeline the public funnel runs (shared ladder → contract → writer →
// release repair) — one analysis implementation, three front doors (tech,
// public funnel, admin-created).
async function runLawnAnalysis(photos, prospectNote, source) {
  const season = lawnAssessment.getSeason(etParts(new Date()).month);
  const { findings, findingsSource, fallbackReason, provenance } = await runFindingsLadder({
    photos,
    season,
    products: [],
    compliance: {},
  });
  const reportContract = buildDiagnosticReportContract({
    photos: photos.map((photo) => ({ photo_id: photo.photo_id, quality: photo.quality, limitations: photo.limitations })),
    findings,
    products: [],
    compliance: {},
    seasonal_context: '',
  });
  const releaseMode = classifyReleaseMode(reportContract);
  await applyWriterSummary(reportContract, { season, findingsSource, releaseMode, provenance });
  const sanitizedContract = applyAutoReleaseRepair(reportContract, releaseMode);
  return {
    insert: {
      ai_analysis: JSON.stringify({
        release_mode: releaseMode,
        findings_source: findingsSource,
        fallback_reason: fallbackReason,
        prospect_note: prospectNote,
        provenance: {
          source,
          perception_model: provenance.perceptionModel || null,
          challenge_model: provenance.challengeModel || null,
          writer: provenance.writerModel || 'deterministic',
        },
      }),
      report_contract: JSON.stringify(sanitizedContract),
      overall_score: deriveOverallScore(sanitizedContract, null),
      ai_summary: cleanString(sanitizedContract.customer_summary, 2000),
    },
  };
}

async function runPestAnalysis(photos, prospectNote) {
  const result = await identifyPest(photos);
  if (!result.ok) return { error: 'Photo analysis is unavailable right now — try again in a few minutes.' };
  const contract = buildPestReportContract(result);
  return {
    insert: {
      ai_analysis: JSON.stringify({
        prospect_note: prospectNote,
        per_photo: result.perPhoto.map((photo) => ({
          slug: photo.entry ? photo.entry.slug : null,
          confidence: photo.confidence,
          category: photo.category,
          agreement: photo.agreement,
          model_count: photo.model_count,
          observations: photo.observations,
        })),
      }),
      report_contract: JSON.stringify(contract),
      category: contract.identification.category,
      species_slug: contract.identification.slug,
      service_line: contract.service.line,
      urgency: contract.urgency,
      ai_summary: (result.observations || []).join(' ').slice(0, 2000) || null,
    },
  };
}

// Resolves the request's photo inputs (photos + message_photos) into the
// normalizePhotos-shaped list the analysis ladder runs on, or an
// { error, status }. Owns every count/size/shape check for BOTH sources so
// createAdminAssessment makes exactly one decision (did this fail) instead of
// re-checking the combined list at each stage.
async function resolveRequestPhotos(body) {
  const rawPhotos = Array.isArray(body.photos) ? body.photos.filter(Boolean) : [];
  const messagePhotoRequests = Array.isArray(body.message_photos) ? body.message_photos.filter(Boolean) : [];
  if (!rawPhotos.length && !messagePhotoRequests.length) {
    return { error: 'At least one photo is required', status: 400 };
  }
  if (rawPhotos.length + messagePhotoRequests.length > MAX_PHOTOS) {
    return { error: `At most ${MAX_PHOTOS} photos per assessment`, status: 400 };
  }

  // Pulled BEFORE the vision ladder runs — a bad key or an unreachable S3
  // object fails the request outright rather than silently dropping a
  // photo the operator explicitly selected.
  const messagePhotos = await resolveMessagePhotos(messagePhotoRequests);
  if (messagePhotos.error) return messagePhotos;

  const photos = normalizePhotos([...rawPhotos, ...messagePhotos.photos]);
  if (!photos.length || !photos.some((photo) => photo.data)) {
    return { error: 'At least one photo is required', status: 400 };
  }
  if (photos.length > MAX_PHOTOS) {
    return { error: `At most ${MAX_PHOTOS} photos per assessment`, status: 400 };
  }
  if (photos.some((photo) => photo.data && photo.data.length > MAX_PHOTO_CHARS)) {
    return { error: 'One of the photos is too large — resize it and retry.', status: 413 };
  }

  return { photos, messageCustomerId: messagePhotos.customerId };
}

// One id → row lookup for both lead_id and customer_id, so the two
// association fields share a single validated-UUID-then-exists shape
// instead of two parallel hand-written blocks.
const ASSOCIATION_LOOKUPS = {
  lead_id: { table: 'leads', notFoundLabel: 'Lead' },
  customer_id: { table: 'customers', notFoundLabel: 'Customer' },
};
async function lookupAssociation(field, id) {
  const spec = ASSOCIATION_LOOKUPS[field];
  if (!UUID_RE.test(String(id))) return { error: `invalid ${field}`, status: 400 };
  const row = await db(spec.table).where({ id }).first();
  if (!row) return { error: `${spec.notFoundLabel} not found`, status: 404 };
  return { id: row.id, row };
}

// The linked customer's own contact fields, shaped like a contact_snapshot,
// so an assessment created without an explicit contact (Customer 360 or an
// inbound-thread pick) still lists a name/email/phone instead of "No
// contact yet" while its Linked column says Customer.
function customerContactSnapshot(customer) {
  if (!customer) return null;
  return {
    first_name: cleanString(customer.first_name, 80),
    last_name: cleanString(customer.last_name, 80),
    email: cleanString(customer.email, 254),
    phone: cleanString(customer.phone, 20),
  };
}

// Resolves lead_id/customer_id into { leadId, customerId, customerContact }
// (customerContact = the linked customer's contact fields, or null), or an
// { error, status }. customerId prefers an explicit body value, otherwise
// defaults from the inbound message thread (messageCustomerId, from
// resolveRequestPhotos) — same existence check either way, so a
// stale/deleted id never links. An explicit customer_id that CONTRADICTS
// the selected messages' own (non-null) customer is refused rather than
// silently overriding it — the client only ever sends an explicit
// customer_id from the Customer 360-embedded composer, where it should
// always agree with the thread it pulled photos from.
async function resolveAssociations(body, messageCustomerId) {
  let leadId = null;
  let customerId = null;
  let customerContact = null;

  if (body.lead_id) {
    const lead = await lookupAssociation('lead_id', body.lead_id);
    if (lead.error) return lead;
    leadId = lead.id;
  }

  if (body.customer_id && messageCustomerId && String(body.customer_id) !== String(messageCustomerId)) {
    return { error: 'customer_id does not match the selected photos’ customer', status: 400 };
  }
  const requestedCustomerId = body.customer_id || messageCustomerId;
  if (requestedCustomerId) {
    const customer = await lookupAssociation('customer_id', requestedCustomerId);
    if (customer.error) return customer;
    customerId = customer.id;
    customerContact = customerContactSnapshot(customer.row);
  }

  return { leadId, customerId, customerContact };
}

// An explicit body.contact wins; otherwise the linked customer's own
// contact fields (customerContact, from resolveAssociations) stand in so
// the row is never "No contact yet" while linked to a customer.
function buildSnapshots(body, customerContact = null) {
  const contact = body.contact && typeof body.contact === 'object' && !Array.isArray(body.contact) ? body.contact : {};
  const explicitContact = {
    first_name: cleanString(contact.first_name, 80),
    last_name: cleanString(contact.last_name, 80),
    email: cleanString(contact.email, 254),
    phone: cleanString(contact.phone, 20),
  };
  const contactSnapshot = Object.values(explicitContact).some(Boolean) ? explicitContact : (customerContact || {});
  const address = body.address && typeof body.address === 'object' && !Array.isArray(body.address) ? body.address : {};
  const addressSnapshot = {
    line1: cleanString(address.line1),
    city: cleanString(address.city),
    state: cleanString(address.state, 20),
    zip: cleanString(address.zip, 12),
  };
  return {
    contactSnapshot: Object.values(contactSnapshot).some(Boolean) ? contactSnapshot : null,
    addressSnapshot: Object.values(addressSnapshot).some(Boolean) ? addressSnapshot : null,
    prospectNote: cleanString(body.note, 500),
  };
}

// Admin-lane assessment create: resolve photos + associations, run the
// shared analysis, insert the prospect-mode row, store its photos. `source`
// is stamped server-side by each caller ('admin' for the route,
// 'auto_triage' for inbound photo-text triage) — never read from a request
// body. No lead, attribution row, or email is ever created here.
async function createAdminAssessment({ type, source, ...body }) {
  const config = TYPES[String(type || '')];
  if (!config) return { error: 'Unknown assessment type', status: 404 };

  const requestPhotos = await resolveRequestPhotos(body);
  if (requestPhotos.error) return requestPhotos;
  const { photos, messageCustomerId } = requestPhotos;

  const associations = await resolveAssociations(body, messageCustomerId);
  if (associations.error) return associations;
  const { leadId, customerId, customerContact } = associations;

  const { contactSnapshot, addressSnapshot, prospectNote } = buildSnapshots(body, customerContact);

  const analysis = type === 'lawn'
    ? await runLawnAnalysis(photos, prospectNote, source)
    : await runPestAnalysis(photos, prospectNote);
  if (analysis.error) return { error: analysis.error, status: 503 };

  const [row] = await db(config.table).insert({
    mode: 'prospect',
    status: 'analyzed',
    source,
    lead_id: leadId,
    customer_id: customerId,
    contact_snapshot: contactSnapshot ? JSON.stringify(contactSnapshot) : null,
    address_snapshot: addressSnapshot ? JSON.stringify(addressSnapshot) : null,
    ...analysis.insert,
  }).returning(['id', 'created_at']);

  await storeFunnelPhotos({
    table: config.photoTable,
    fkColumn: config.photoFk,
    rowId: row.id,
    keyPrefix: config.photoKeyPrefix,
    photos,
  });

  logger.info(`[photo-assessment-create] ${source} ${type} assessment ${row.id}`);
  return {
    id: row.id,
    type,
    analysis: { ...analysis.insert, created_at: row.created_at || new Date() },
  };
}

module.exports = {
  TYPES,
  UUID_RE,
  MAX_PHOTOS,
  MESSAGE_PHOTO_ALLOWED_MIME,
  cleanString,
  createAdminAssessment,
  _test: {
    normalizePhotos,
    resolveRequestPhotos,
    resolveAssociations,
    lookupAssociation,
    buildSnapshots,
  },
};
