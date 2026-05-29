/**
 * Admin / Tech — Projects
 *
 * Post-service inspection-and-documentation records: WDO, termite, pest,
 * rodent exclusion, bed bug. Techs create them in the field, admin reviews
 * and sends the customer-facing report at /report/project/:token.
 *
 * Mounted at /api/admin/projects. Both admins and techs can create and
 * edit; only admins can delete or transition status to 'sent' / 'closed'.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { PROJECT_TYPES, PROJECT_TYPE_KEYS, isValidProjectType, getProjectType } = require('../services/project-types');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const serviceLibrary = require('../services/service-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const ProjectEmail = require('../services/project-email');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { projectReportPathForProject } = require('../services/project-report-links');
const {
  buildProjectCloseoutPreview,
  completeProjectBackedService,
  resolveProjectPortalAttachment,
} = require('../services/project-completion');
const { buildWdoReportPDFBuffer } = require('../services/pdf/wdo-report-pdf');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');
const InvoiceService = require('../services/invoice');
const { SPECIALTY } = require('../services/pricing-engine/constants');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { publicPortalUrl } = require('../utils/portal-url');

router.use(adminAuthenticate, requireTechOrAdmin);

const ALLOWED_UPLOAD_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ACTIVE_APPOINTMENT_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const contentType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_UPLOAD_IMAGE_TYPES.has(contentType)) {
      const err = new Error('Only JPEG, PNG, GIF, or WebP images can be uploaded');
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});
const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});
const PHOTO_PREFIX = 'project-photos/';
const AI_PHOTO_LIMIT = 8;
const AI_PHOTO_MAX_BYTES = 4.5 * 1024 * 1024;
const AI_PHOTO_TOTAL_MAX_BYTES = 12 * 1024 * 1024;
const AI_SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isAdmin(req) {
  return req.techRole === 'admin';
}

function canAccessProject(req, project) {
  return isAdmin(req) || String(project?.created_by_tech_id || '') === String(req.technicianId || '');
}

async function hasProjectAccess(req, project) {
  if (canAccessProject(req, project)) return true;
  if (!project || !req.technicianId) return false;

  if (project.service_record_id) {
    const service = await db('service_records')
      .where({ id: project.service_record_id, technician_id: req.technicianId })
      .first('id');
    if (service) return true;
  }

  if (project.scheduled_service_id) {
    const scheduled = await db('scheduled_services')
      .where({ id: project.scheduled_service_id, technician_id: req.technicianId })
      .first('id');
    if (scheduled) return true;
  }

  return false;
}

async function requireProjectAccess(req, res, project) {
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return false;
  }
  if (!(await hasProjectAccess(req, project))) {
    res.status(403).json({ error: 'Project access denied' });
    return false;
  }
  return true;
}

function detectedImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function validateUploadedImage(file) {
  const declared = String(file?.mimetype || '').split(';')[0].trim().toLowerCase();
  const detected = detectedImageMime(file?.buffer);
  if (!detected || !ALLOWED_UPLOAD_IMAGE_TYPES.has(detected)) {
    const err = new Error('Uploaded file is not a supported image');
    err.status = 400;
    throw err;
  }
  if (declared !== detected) {
    const err = new Error(`Image content does not match declared type (${declared || 'unknown'})`);
    err.status = 400;
    throw err;
  }
  return detected;
}

function isMissingS3ObjectError(err) {
  const statusCode = err?.$metadata?.httpStatusCode || err?.statusCode;
  return statusCode === 404 || ['NoSuchKey', 'NotFound'].includes(err?.name || err?.Code || err?.code);
}

async function logProjectActivity(req, project, action, description, metadata = {}) {
  if (!project?.customer_id) return;
  try {
    await db('activity_log').insert({
      admin_user_id: req?.technicianId || null,
      customer_id: project.customer_id,
      action,
      description,
      metadata: {
        project_id: project.id,
        project_type: project.project_type,
        ...metadata,
      },
    });
  } catch (err) {
    logger.warn(`[projects] activity_log insert failed for ${project.id}: ${err.message}`);
  }
}

function normalizeDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string' && DATE_RE.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeFindings(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function cleanOneLine(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cleanMultiline(value, max = 1800) {
  const text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max).trim() : text;
}

function formatCustomerPropertyAddress(customer) {
  if (!customer) return '';
  return [
    customer.address_line1,
    [customer.city, customer.state].filter(Boolean).join(', '),
    customer.zip,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function compactPropertyProfile(profile) {
  if (!profile) return null;
  const sourceUrl = profile._aiSourceUrl || profile._sourceUrl || profile._raw?._sourceUrl || null;
  return {
    propertyType: profile.propertyType || null,
    squareFootage: Number(profile.squareFootage || 0) || null,
    lotSize: Number(profile.lotSize || 0) || null,
    yearBuilt: profile.yearBuilt || null,
    bedrooms: Number(profile.bedrooms || 0) || null,
    bathrooms: Number(profile.bathrooms || 0) || null,
    stories: profile.stories || null,
    constructionMaterial: profile.constructionMaterial && profile.constructionMaterial !== 'UNKNOWN'
      ? profile.constructionMaterial
      : null,
    foundationType: profile.foundationType && profile.foundationType !== 'UNKNOWN' ? profile.foundationType : null,
    sourceUrl,
    confidence: profile._aiConfidence || profile._confidence || profile._dataQuality?.level || null,
  };
}

function propertyProfileLines(profile) {
  const facts = compactPropertyProfile(profile);
  if (!facts) return '[no property facts found]';
  const lines = [];
  if (facts.propertyType) lines.push(`Property type: ${facts.propertyType}`);
  if (facts.squareFootage) lines.push(`Living area: ${facts.squareFootage} sq ft`);
  if (facts.lotSize) lines.push(`Lot size: ${facts.lotSize} sq ft`);
  if (facts.yearBuilt) lines.push(`Year built: ${facts.yearBuilt}`);
  if (facts.bedrooms) lines.push(`Bedrooms: ${facts.bedrooms}`);
  if (facts.bathrooms) lines.push(`Bathrooms: ${facts.bathrooms}`);
  if (facts.stories) lines.push(`Stories: ${facts.stories}`);
  if (facts.constructionMaterial) lines.push(`Construction: ${facts.constructionMaterial}`);
  if (facts.foundationType) lines.push(`Foundation: ${facts.foundationType}`);
  if (facts.sourceUrl) lines.push(`Source: ${facts.sourceUrl}`);
  if (facts.confidence) lines.push(`Property data confidence: ${facts.confidence}`);
  return lines.length ? lines.join('\n') : '[no property facts found]';
}

function parseAiJsonObject(text) {
  const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeWdoIntelligenceResult(raw, fallbackAddress, options = {}) {
  const { hasPreviousTreatmentContext = false } = options;
  const suggested = raw?.suggestedFindings || raw?.findings || {};
  const previousTreatment = cleanOneLine(suggested.previous_treatment_evidence || '', 20);
  const normalizedPreviousTreatment = hasPreviousTreatmentContext
    ? (/^yes$/i.test(previousTreatment) ? 'Yes' : /^no$/i.test(previousTreatment) ? 'No' : '')
    : '';

  return {
    suggestedFindings: {
      property_address: cleanOneLine(fallbackAddress, 500),
      structures_inspected: cleanMultiline(suggested.structures_inspected, 900),
      inspection_scope: cleanMultiline(suggested.inspection_scope, 900),
      previous_treatment_evidence: normalizedPreviousTreatment,
      previous_treatment_notes: hasPreviousTreatmentContext
        ? cleanMultiline(suggested.previous_treatment_notes, 1200)
        : '',
    },
    propertySummary: cleanMultiline(raw?.propertySummary || raw?.property_summary, 1000),
    confidence: ['high', 'medium', 'low'].includes(String(raw?.confidence || '').toLowerCase())
      ? String(raw.confidence).toLowerCase()
      : 'low',
    reviewNotes: Array.isArray(raw?.reviewNotes || raw?.review_notes)
      ? (raw.reviewNotes || raw.review_notes).map((item) => cleanOneLine(item, 260)).filter(Boolean).slice(0, 4)
      : [],
  };
}

function buildWdoIntelligencePrompt({ customer, propertyAddress, currentFindings, propertyProfile, hasPreviousTreatmentPhoto }) {
  const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || '[not provided]';
  const existingLines = Object.entries(currentFindings || {})
    .filter(([, value]) => hasMeaningfulValue(value))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n') || '[none]';

  return `You are helping a Florida pest-control operator prefill structured fields for an FDACS-13645 WDO inspection project.

Return JSON only. Do not write report prose. Be conservative and do not invent a detached structure, crawlspace, prior treatment, organism, damage, or inaccessible area unless the input supports it.

Prefill only these fields:
- property_address
- structures_inspected
- inspection_scope
- previous_treatment_evidence ("Yes" or "No" only; leave blank if not supported)
- previous_treatment_notes

Rules:
1. property_address should use the exact selected customer property address when available.
2. structures_inspected should describe the primary residential structure from the home facts. Mention an attached garage only if it is part of a typical main home description or supported by the facts. Do not mention detached buildings unless clearly supported.
3. inspection_scope should be a defensible WDO scope for visible and readily accessible areas. Include interior, garage, attic access, exterior perimeter, and accessible structural components when reasonable. Mention crawlspace only if the property facts indicate one.
4. Previous treatment is photo-grounded. If a prior-treatment photo is provided, look for visible treatment stickers/notices, drill holes, bait stations, patching, trench/rod marks, old treatment tags, or other visible treatment indicators. Use cautious language such as "photo appears to show" when the evidence is not definitive.
5. If no prior-treatment photo is provided and the existing fields do not mention prior treatment, leave previous_treatment_evidence and previous_treatment_notes blank. Do not default to "No" just because no photo was uploaded.
6. Do not fill FDACS finding, live WDO, WDO evidence, damage, treatment performed, pesticide, or treatment method.

Selected customer: ${customerName}
Property address: ${propertyAddress || '[not provided]'}

Property/home facts:
${propertyProfileLines(propertyProfile)}

Existing WDO fields:
${existingLines}

Prior-treatment photo attached: ${hasPreviousTreatmentPhoto ? 'yes' : 'no'}

Respond with exactly this JSON shape:
{
  "suggestedFindings": {
    "property_address": "<address or blank>",
    "structures_inspected": "<short field text or blank>",
    "inspection_scope": "<short field text or blank>",
    "previous_treatment_evidence": "Yes|No|",
    "previous_treatment_notes": "<short field text or blank>"
  },
  "propertySummary": "<one sentence about the home facts used, or blank>",
  "confidence": "high|medium|low",
  "reviewNotes": ["<operator review note>", "..."]
}`;
}

async function analyzeWdoProjectIntelligence({ customer, propertyAddress, currentFindings = {}, previousTreatmentPhoto = null }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let propertyProfile = null;

  if (propertyAddress) {
    try {
      propertyProfile = await lookupPropertyFromAITrio(propertyAddress);
    } catch (err) {
      logger.warn(`[projects] WDO property lookup failed: ${err.message}`);
    }
  }

  const content = [{
    type: 'text',
    text: buildWdoIntelligencePrompt({
      customer,
      propertyAddress,
      currentFindings,
      propertyProfile,
      hasPreviousTreatmentPhoto: Boolean(previousTreatmentPhoto),
    }),
  }];

  if (previousTreatmentPhoto) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: previousTreatmentPhoto.mediaType,
        data: previousTreatmentPhoto.buffer.toString('base64'),
      },
    });
  }

  const request = {
    model: previousTreatmentPhoto ? MODELS.VISION : MODELS.WORKHORSE,
    max_tokens: 900,
    messages: [{ role: 'user', content }],
  };
  if (previousTreatmentPhoto) request.temperature = 0.2;
  const msg = await anthropic.messages.create(request);

  const text = (msg.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const parsed = parseAiJsonObject(text);
  if (!parsed) {
    const err = new Error('AI returned an unreadable WDO prefill response');
    err.status = 502;
    throw err;
  }
  const normalized = normalizeWdoIntelligenceResult(parsed, propertyAddress, {
    hasPreviousTreatmentContext: Boolean(previousTreatmentPhoto)
      || hasMeaningfulValue(currentFindings.previous_treatment_evidence)
      || hasMeaningfulValue(currentFindings.previous_treatment_notes),
  });
  return {
    ...normalized,
    propertyProfile: compactPropertyProfile(propertyProfile),
  };
}

function evaluateProjectSendReadiness({ project, customer }) {
  const typeCfg = getProjectType(project?.project_type);
  const findings = normalizeFindings(project?.findings);
  // Recommendations are optional. Some report types render cleanly from
  // structured findings alone, and admins can still add narrative notes when
  // a customer-facing next step is useful.
  const isCertificate = project?.project_type === 'pre_treatment_termite_certificate';
  const required = [
    { key: 'project_date', label: isCertificate ? 'Treatment date' : 'Inspection date', ok: hasMeaningfulValue(project?.project_date) },
    { key: 'customer', label: 'Customer', ok: Boolean(customer?.id || project?.customer_id) },
    { key: 'project_type', label: 'Report title or type', ok: hasMeaningfulValue(project?.title) || Boolean(typeCfg) },
    { key: 'findings', label: 'Findings captured', ok: Object.values(findings).some(hasMeaningfulValue) },
  ];

  if (project?.project_type === 'wdo_inspection') {
    required.push(
      { key: 'wdo_property_address', label: 'Property inspected', ok: hasMeaningfulValue(findings.property_address) },
      { key: 'wdo_finding', label: 'FDACS finding selected', ok: hasMeaningfulValue(findings.wdo_finding) },
      { key: 'wdo_inspection_scope', label: 'Visible/access scope', ok: hasMeaningfulValue(findings.inspection_scope) },
    );
  }

  if (project?.project_type === 'pre_treatment_termite_certificate') {
    const productName = findings.product_name === 'Other' ? findings.product_name_other : findings.product_name;
    const rawMethod = findings.treatment_method;
    const method = rawMethod === 'Other' ? findings.treatment_method_other : rawMethod;
    // Coverage requirements vary by application method. Liquid soil barriers
    // (chemical) are sized by gallons of finished solution applied across a
    // measured area. Wood treatments (borate) are measured by treated area
    // but volume varies by saturation. Bait systems install discrete stations
    // around a perimeter — there is no "gallons applied." Gate the gallons
    // check accordingly so the send flow doesn't 422 on bait-system jobs.
    const isBaitSystem = rawMethod === 'Bait system';
    const isWoodTreatment = rawMethod === 'Wood treatment (borate)';
    const needsGallons = !isBaitSystem && !isWoodTreatment;
    const hasArea = hasMeaningfulValue(findings.square_footage) || hasMeaningfulValue(findings.linear_feet);
    const coverageOk = needsGallons
      ? hasArea && hasMeaningfulValue(findings.gallons_applied)
      : hasArea;
    const coverageLabel = needsGallons
      ? 'Coverage (sq ft or linear ft + gallons applied)'
      : 'Coverage (sq ft or linear ft)';
    required.push(
      { key: 'cert_treatment_address', label: 'Treatment address (or lot/block)', ok: hasMeaningfulValue(findings.treatment_address) || hasMeaningfulValue(findings.lot_block) },
      { key: 'cert_treatment_date', label: 'Date of treatment', ok: hasMeaningfulValue(findings.treatment_date) || hasMeaningfulValue(project?.project_date) },
      { key: 'cert_treatment_method', label: 'Method of treatment', ok: hasMeaningfulValue(method) },
      { key: 'cert_product', label: 'Product used', ok: hasMeaningfulValue(productName) },
      { key: 'cert_active_ingredient', label: 'Active ingredient + concentration', ok: hasMeaningfulValue(findings.active_ingredient) && hasMeaningfulValue(findings.concentration_pct) },
      { key: 'cert_coverage', label: coverageLabel, ok: coverageOk },
      { key: 'cert_applicator_name', label: "Applicator's printed name", ok: hasMeaningfulValue(findings.applicator_name) },
      { key: 'cert_applicator_fdacs_id', label: 'Applicator FDACS ID #', ok: hasMeaningfulValue(findings.applicator_fdacs_id) },
      // Applicator attestation satisfies FBC 1816.1.7 authorized-signature
      // requirement when paired with the typed name + FDACS ID + date.
      { key: 'cert_applicator_attestation', label: 'Applicator attestation (electronic signature)', ok: hasMeaningfulValue(findings.applicator_attestation) },
    );
  }

  return {
    required,
    missing: required.filter(item => !item.ok).map(({ key, label }) => ({ key, label })),
  };
}

async function validateProjectCreateScope(req, { customer_id, service_record_id, scheduled_service_id }) {
  const customer = await db('customers').where({ id: customer_id }).whereNull('deleted_at').first('id');
  if (!customer) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }

  let linkedAssignedToTech = false;

  if (service_record_id) {
    const service = await db('service_records')
      .where({ id: service_record_id })
      .first('id', 'customer_id', 'technician_id');
    if (!service) {
      const err = new Error('Service record not found');
      err.status = 400;
      throw err;
    }
    if (String(service.customer_id) !== String(customer_id)) {
      const err = new Error('Service record does not belong to the selected customer');
      err.status = 400;
      throw err;
    }
    if (String(service.technician_id || '') === String(req.technicianId || '')) linkedAssignedToTech = true;
  }

  if (scheduled_service_id) {
    const scheduled = await db('scheduled_services')
      .where({ id: scheduled_service_id })
      .first('id', 'customer_id', 'technician_id');
    if (!scheduled) {
      const err = new Error('Scheduled service not found');
      err.status = 400;
      throw err;
    }
    if (String(scheduled.customer_id) !== String(customer_id)) {
      const err = new Error('Scheduled service does not belong to the selected customer');
      err.status = 400;
      throw err;
    }
    if (String(scheduled.technician_id || '') === String(req.technicianId || '')) linkedAssignedToTech = true;
  }

  if (!isAdmin(req) && !linkedAssignedToTech) {
    const err = new Error('Technician projects must be linked to an assigned visit');
    err.status = 403;
    throw err;
  }

  return customer;
}

async function resolveProjectDate({ project_date, service_record_id, scheduled_service_id }) {
  const explicit = normalizeDateOnly(project_date);
  if (explicit) return explicit;
  if (service_record_id) {
    const row = await db('service_records').where({ id: service_record_id }).select('service_date').first();
    const serviceDate = normalizeDateOnly(row?.service_date);
    if (serviceDate) return serviceDate;
  }
  if (scheduled_service_id) {
    const row = await db('scheduled_services').where({ id: scheduled_service_id }).select('scheduled_date').first();
    const scheduledDate = normalizeDateOnly(row?.scheduled_date);
    if (scheduledDate) return scheduledDate;
  }
  return etDateString();
}

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (typeof stream.transformToByteArray === 'function') {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function inferImageMediaType(key) {
  const lower = String(key || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function resolveAiImageMediaType(contentType, key) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (normalized.startsWith('image/') && !AI_SUPPORTED_IMAGE_TYPES.has(normalized)) {
    throw new Error(`unsupported image type for AI review: ${normalized}`);
  }
  const mediaType = AI_SUPPORTED_IMAGE_TYPES.has(normalized) ? normalized : inferImageMediaType(key);
  if (!AI_SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    throw new Error(`unsupported image type for AI review: ${normalized || key || 'unknown'}`);
  }
  return mediaType;
}

async function buildAiPhotoInputs(photos = []) {
  if (!photos.length) return { photoLines: '[no photos attached]', imageBlocks: [] };
  if (!config.s3?.bucket) return { photoLines: '[photo review unavailable: S3 not configured]', imageBlocks: [] };
  const imageBlocks = [];
  const photoLines = [];
  let totalBytes = 0;
  for (const ph of photos.slice(0, AI_PHOTO_LIMIT)) {
    const label = [
      ph.category ? `category=${ph.category}` : null,
      ph.caption ? `caption=${ph.caption}` : null,
      ph.visit ? `visit=${ph.visit}` : null,
    ].filter(Boolean).join(', ') || 'no field note';
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: ph.s3_key }));
      const buffer = await streamToBuffer(object.Body);
      if (!buffer.length) throw new Error('empty image body');
      if (buffer.length > AI_PHOTO_MAX_BYTES) throw new Error('image too large for AI review');
      if (totalBytes + buffer.length > AI_PHOTO_TOTAL_MAX_BYTES) {
        throw new Error('AI photo payload budget reached');
      }
      const mediaType = resolveAiImageMediaType(object.ContentType, ph.s3_key);
      photoLines.push(`Photo ${imageBlocks.length + 1}: ${label}`);
      imageBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      });
      totalBytes += buffer.length;
    } catch (err) {
      logger.warn(`[projects] ai photo skipped ${ph.id}: ${err.message}`);
      photoLines.push(`Photo skipped: ${label}`);
    }
  }
  return {
    photoLines: photoLines.length ? photoLines.join('\n') : '[no photos attached]',
    imageBlocks,
  };
}

function compactText(value, max = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function formatContextDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function contextTimestamp(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

async function getCustomerCommunicationContext(customerId) {
  if (!customerId) return '';
  const [calls, sms, emails] = await Promise.all([
    db('call_log')
      .where({ customer_id: customerId })
      .select('created_at', 'direction', 'call_outcome', 'lead_synopsis', 'transcription', 'notes')
      .orderBy('created_at', 'desc')
      .limit(3)
      .catch((err) => {
        logger.warn(`[projects] call context unavailable: ${err.message}`);
        return [];
      }),
    db('sms_log')
      .where({ customer_id: customerId })
      .select('created_at', 'direction', 'message_body', 'message_type')
      .orderBy('created_at', 'desc')
      .limit(4)
      .catch((err) => {
        logger.warn(`[projects] sms context unavailable: ${err.message}`);
        return [];
      }),
    db('emails')
      .where({ customer_id: customerId })
      .select('received_at', 'subject', 'snippet', 'body_text')
      .orderBy('received_at', 'desc')
      .limit(3)
      .catch((err) => {
        logger.warn(`[projects] email context unavailable: ${err.message}`);
        return [];
      }),
  ]);

  const entries = [];
  for (const call of calls) {
    const summary = compactText(call.lead_synopsis || call.notes || call.transcription);
    if (summary) {
      entries.push({
        ts: contextTimestamp(call.created_at),
        line: `Call ${formatContextDate(call.created_at)} (${call.direction || 'unknown'}${call.call_outcome ? `, ${call.call_outcome}` : ''}): ${summary}`,
      });
    }
  }
  for (const msg of sms) {
    const summary = compactText(msg.message_body, 260);
    if (summary) {
      entries.push({
        ts: contextTimestamp(msg.created_at),
        line: `Text ${formatContextDate(msg.created_at)} (${msg.direction || 'unknown'}${msg.message_type ? `, ${msg.message_type}` : ''}): ${summary}`,
      });
    }
  }
  for (const email of emails) {
    const summary = compactText(email.snippet || email.body_text, 260);
    const subject = compactText(email.subject, 120);
    if (summary || subject) {
      entries.push({
        ts: contextTimestamp(email.received_at),
        line: `Email ${formatContextDate(email.received_at)}${subject ? ` "${subject}"` : ''}: ${summary || '[no body preview]'}`,
      });
    }
  }
  return entries
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6)
    .map(entry => entry.line)
    .join('\n');
}

function buildProjectReportPrompt({ typeCfg, findings, rawRecommendations, customer, tech, projectDate, photoLines, communicationContext }) {
  const labelMap = Object.fromEntries((typeCfg.findingsFields || []).map(f => [f.key, f.label]));
  const findingsLines = Object.entries(findings || {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `${labelMap[k] || k.replace(/_/g, ' ')}: ${v}`)
    .join('\n') || '[no structured findings captured]';

  return `# PROJECT REPORT WRITER — SYSTEM PROMPT v1

## CONTEXT

This generates customer-facing narrative copy for a Waves Pest Control & Lawn Care inspection / documentation report. The report is a branded PDF + web page delivered to the customer after a field visit.

Project types this prompt handles:
- WDO inspection (wood-destroying organism, often pre-home-purchase)
- Termite inspection
- Pest inspection (general survey, pre-treatment scoping)
- Rodent exclusion (entry-point mapping, trapping, exclusion work)
- Bed bug treatment (inspection + initial treatment, with an optional 14-day follow-up)

The narrative sits alongside structured findings (field/value pairs), photos, recent customer communication context, and Waves branding. This prompt writes four or five narrative sections only — it does NOT touch the structured findings.

## HARD CONSTRAINTS (READ FIRST — THESE OVERRIDE EVERYTHING ELSE)

1. **Never downplay a serious finding.** "Active subterranean termite infestation" stays serious. Do not soften to "some activity" or "a few signs." Accuracy beats reassurance.

2. **Never manufacture urgency that isn't there.** A clean inspection is calm: "no visible evidence of active wood-destroying organisms at time of inspection." Do not fear-sell: no "you dodged a bullet," "lucky," "imagine what could have happened."

3. **No military language.** Do not use: mission, tactical, deployment, fortification, fortress, sentries, invaders, infiltration, neutralize, annihilation, defensive perimeter, chemical barrier, vectors, sweep, recon, staging, advancement, threat, lockdown, intercept (as military metaphor).

4. **No overpromising.** Never: elimination, eradication, impenetrable, guaranteed, 100%, total protection, pest-free, foolproof. Use: reduce activity, manage pressure, support long-term control, limit conducive conditions.

5. **No invented observations.** Only reference findings, pests, species, locations, and conditions that appear in the inputs. If a field was left blank, do not fabricate content for it. Better to write less than to invent.

6. **No brand names for products.** Use active ingredient names (fipronil, bifenthrin, imidacloprid) or functional descriptions (non-repellent residual, insect growth regulator). If the active ingredient is not provided in the inputs, use the functional description only.

7. **Plain text only.** No markdown, no bold, no emojis, no bullet points, no em-dash headers. Just paragraphs under the allowed section titles.

8. **Length.** Each section 1–4 sentences. Total output roughly 120–240 words.

9. **Photo-grounded drafting.** Review attached photos when provided. Use visible conditions in the images to support the narrative only when they are consistent with the structured findings or technician notes. If a photo suggests something not captured in the fields, mention it cautiously as a visible condition and avoid diagnosing beyond the evidence.

## VOICE

Write like a knowledgeable field specialist drafting a professional summary — someone who understands the science and the stakes, and who communicates plainly.

The tone is:
- Calm and precise
- Technically informed but readable at a 9th-grade level
- Confident without bragging
- Clean, modern, premium
- Useful to the client: explain why the finding matters, what risk it creates, and what practical next step reduces that risk

Think: a well-written inspection report from a specialist you trust.
Do not think: action movie, military briefing, advertising copy, or fear-based sales pitch.

### Sentence-Level Rules

- Vary sentence openings. Do not start more than one sentence in a row with "We."
- Blend what was done with why it matters in the same sentence when you can.
- Avoid repeating the same word more than twice across the report sections (especially: treatment, inspect, applied, control, recommend).
- Add technical value without jargon dumping. Good examples: moisture supports wood decay; wood-to-ground contact increases WDO risk; gaps or rub marks can indicate rodent travel; sanitation and moisture can sustain pest pressure.

## SECTIONS

### CUSTOMER CONCERN

1–2 sentences, only when recent customer communication context is provided:
- Summarize the customer's stated concern from calls, text messages, or emails
- Reference the channel naturally when useful, for example "The recent call notes described..." or "The customer texted about..."
- Do not include phone numbers, email addresses, private transcript details unrelated to the pest concern, or unsupported assumptions
- If no communication context is provided, omit this section entirely

### WHAT WE INSPECTED

2–3 sentences:
- The areas covered (from the structured findings)
- The method (visual, probing, infrared, etc.) ONLY if mentioned in inputs — otherwise omit
- Scope limitations where relevant for the project type (e.g. "visible and accessible areas" for WDO)

### WHAT WE FOUND

2–3 sentences:
- Findings translated from dropdown values into customer-friendly language
- Specific locations from the inputs
- Moisture / conducive conditions if noted
- Severity framed factually, not dramatically
- If clean: say so clearly ("no visible evidence of...") without filler

### WHAT WE DID

1–3 sentences:
- Service actions performed during the documented visit, such as traps placed, materials applied, exclusion completed, rooms treated, or follow-up checks performed
- Counts and locations for completed work when provided
- If no service action was completed during the visit, write "No treatment or exclusion work was documented during this visit."
- Do not include future recommendations, customer prep, or repair instructions in this section
- Do not use date-relative words like "today" unless that exact word appears in the technician's notes

### WHAT WE RECOMMEND

2–4 sentences:
- Practical next steps grounded in the findings
- Customer actions, repairs, preparation, or follow-up scheduling
- Follow-up timing if project type calls for it (bed bug 14-day, rodent trap check cadence, etc.)
- If no action needed: say that clearly, not vaguely

## TYPE-SPECIFIC GUIDANCE — USE WHICHEVER MATCHES THIS PROJECT'S TYPE

### WDO Inspection
Formal, defensible tone. This document may sit in a real-estate transaction file. State scope limitations (visible and accessible areas only; no invasive probing unless noted). If clean: "no visible evidence of active wood-destroying organisms at time of inspection." If evidence found: name the species, the location, and whether activity is active or inactive. Avoid softening language that could mislead a buyer.

### Termite Inspection
Standalone (not tied to a real-estate transaction). Same care as WDO. Can lean more directly toward treatment recommendations when warranted.

### Pest Inspection
General survey. Identify pests, severity, likely conducive conditions. Recommendations should connect to a treatment plan without becoming a sales pitch.

### Rodent Exclusion
Blend of inspection + work performed in one visit. Cover species identified, entry points found, exclusion work completed during the documented visit, work pending, trap count and placement, and follow-up schedule for trap checks. Put trap placement and completed exclusion work under WHAT WE DID. Put repairs, customer instructions, sanitation changes, and future follow-up under WHAT WE RECOMMEND. Do not use date-relative words like "today" unless that exact word appears in the technician's notes.

### Bed Bug Treatment
Sensitive topic — no stigma, no judgment. Address: rooms treated, treatment method (chemical, heat, steam, combo), customer prep instructions, and the 14-day follow-up visit if applicable. Keep language matter-of-fact.

## INPUTS

Customer: ${customer?.first_name || ''} ${customer?.last_name || ''}
Project type: ${typeCfg.label}
Technician: ${tech?.name || 'Not specified'}
Project / inspection date: ${projectDate || '[not provided]'}

Structured findings:
${findingsLines}

Technician's raw recommendations / notes:
${rawRecommendations || '[none provided]'}

Attached photo review:
${photoLines || '[no photos attached]'}

Recent customer communication context:
${communicationContext || '[none provided]'}

## OUTPUT FORMAT

Output exactly this structure, plain text, no markdown:

If recent customer communication context is provided, start with:

CUSTOMER CONCERN

[1-2 sentences]

Then continue with:

WHAT WE INSPECTED

[2-3 sentences]

WHAT WE FOUND

[2-3 sentences]

WHAT WE DID

[1-3 sentences]

WHAT WE RECOMMEND

[2-4 sentences]

If recent customer communication context is [none provided], omit CUSTOMER CONCERN and output only WHAT WE INSPECTED, WHAT WE FOUND, WHAT WE DID, and WHAT WE RECOMMEND.

Do not include the customer name as a header. Do not add greetings, sign-offs, or any text outside the allowed sections.`;
}

async function draftProjectReport({ typeCfg, findings, rawRecommendations, customer, tech, projectDate, photos = [], communicationContext = '' }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { photoLines, imageBlocks } = await buildAiPhotoInputs(photos);
  const prompt = buildProjectReportPrompt({
    typeCfg,
    findings,
    rawRecommendations,
    customer,
    tech,
    projectDate,
    photoLines,
    communicationContext,
  });
  const msg = await anthropic.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...imageBlocks,
      ],
    }],
  });
  return msg.content?.[0]?.text || '';
}

// ---------------------------------------------------------------------------
// GET /api/admin/projects/types — registry for form rendering
// ---------------------------------------------------------------------------
router.get('/types', (_req, res) => {
  res.json({ types: PROJECT_TYPES, keys: PROJECT_TYPE_KEYS });
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/service-search — tech-safe service title picker
// ---------------------------------------------------------------------------
router.get('/service-search', async (req, res, next) => {
  try {
    const { search, limit = 10 } = req.query;
    const result = await serviceLibrary.getServices({
      search,
      isActive: 'true',
      limit: Math.min(Number(limit) || 10, 25),
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects — list (admin dashboard)
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { status, project_type, customer_id, tech_id, limit = 100 } = req.query;

    let q = db('projects as p')
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .leftJoin('service_records as srp', 'p.service_record_id', 'srp.id')
      .leftJoin('scheduled_services as ssp', 'p.scheduled_service_id', 'ssp.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.city', 'c.state',
        't.name as tech_name',
      )
      .orderBy('p.created_at', 'desc')
      .limit(Math.min(Number(limit) || 100, 500));

    if (!isAdmin(req)) {
      q = q.where(function () {
        this.where('p.created_by_tech_id', req.technicianId)
          .orWhere('srp.technician_id', req.technicianId)
          .orWhere('ssp.technician_id', req.technicianId);
      });
    }
    if (status) q = q.where('p.status', status);
    if (project_type) q = q.where('p.project_type', project_type);
    if (customer_id) q = q.where('p.customer_id', customer_id);
    if (tech_id) q = q.where('p.created_by_tech_id', tech_id);

    const rows = await q;
    const photoCounts = await db('project_photos')
      .whereIn('project_id', rows.map(r => r.id))
      .select('project_id')
      .count('* as n')
      .groupBy('project_id');
    const photoMap = Object.fromEntries(photoCounts.map(x => [x.project_id, Number(x.n)]));

    const projects = await Promise.all(rows.map(async (r) => ({
        ...r,
        customer_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        report_url: r.report_token ? await projectReportPathForProject(db, r, r) : null,
        photo_count: photoMap[r.id] || 0,
      })));

    res.json({ projects });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/:id — single project with photos
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const project = await db('projects as p')
      .where('p.id', req.params.id)
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.phone', 'c.email',
        'c.address_line1', 'c.city', 'c.state', 'c.zip',
        't.name as tech_name',
      )
      .first();
    if (!(await requireProjectAccess(req, res, project))) return;

    const photos = await db('project_photos')
      .where({ project_id: project.id })
      .orderBy(['visit', 'sort_order', 'created_at']);

    let upcomingAppointment = null;
    if (project.scheduled_service_id) {
      upcomingAppointment = await db('scheduled_services as s')
        .where({ 's.id': project.scheduled_service_id, 's.customer_id': project.customer_id })
        .where('s.scheduled_date', '>=', etDateString())
        .whereIn('s.status', ACTIVE_APPOINTMENT_STATUSES)
        .leftJoin('technicians as st', 's.technician_id', 'st.id')
        .select(
          's.service_type',
          's.scheduled_date',
          's.window_start',
          's.window_end',
          'st.name as technician_name',
        )
        .first();
    }

    const closeoutPreview = isAdmin(req)
      ? await buildProjectCloseoutPreview(project.id).catch((err) => {
        logger.warn(`[projects] closeout preview failed for ${project.id}: ${err.message}`);
        return null;
      })
      : null;

    const prepGuide = project.prep_token ? {
      token: project.prep_token,
      templateKey: project.prep_template_key || null,
      viewCount: project.prep_view_count || 0,
      firstViewedAt: project.prep_first_viewed_at || null,
      expiresAt: project.prep_expires_at || null,
      isExpired: project.prep_expires_at ? new Date(project.prep_expires_at) < new Date() : false,
    } : null;

    res.json({
      project: {
        ...project,
        customer_name: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
        report_url: project.report_token ? await projectReportPathForProject(db, project, project) : null,
      },
      prepGuide,
      upcomingAppointment: upcomingAppointment ? {
        serviceType: upcomingAppointment.service_type,
        scheduledDate: upcomingAppointment.scheduled_date,
        windowStart: upcomingAppointment.window_start,
        windowEnd: upcomingAppointment.window_end,
        technicianName: upcomingAppointment.technician_name,
      } : null,
      photos,
      closeoutPreview,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/:id/activity — project-specific activity history
// ---------------------------------------------------------------------------
router.get('/:id/activity', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;

    const activity = await db('activity_log as a')
      .leftJoin('technicians as t', 'a.admin_user_id', 't.id')
      .whereRaw("a.metadata->>'project_id' = ?", [project.id])
      .select(
        'a.id',
        'a.action',
        'a.description',
        'a.metadata',
        'a.created_at',
        'a.admin_user_id',
        't.name as actor_name',
      )
      .orderBy('a.created_at', 'desc')
      .limit(100);

    res.json({ activity });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects — create (tech-facing)
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const {
      customer_id, project_type, title, findings, recommendations,
      service_record_id, scheduled_service_id, project_date,
    } = req.body;

    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    if (!isValidProjectType(project_type)) return res.status(400).json({ error: 'Invalid project_type' });
    await validateProjectCreateScope(req, { customer_id, service_record_id, scheduled_service_id });
    const projectDate = await resolveProjectDate({ project_date, service_record_id, scheduled_service_id });

    const [row] = await db('projects').insert({
      customer_id,
      project_type,
      project_date: projectDate,
      title: title || null,
      findings: findings || null,
      recommendations: recommendations || null,
      service_record_id: service_record_id || null,
      scheduled_service_id: scheduled_service_id || null,
      status: 'draft',
      created_by_tech_id: req.technicianId,
    }).returning('*');

    logger.info(`[projects] created ${row.id} (${project_type}) by tech ${req.technicianId}`);
    await logProjectActivity(
      req,
      row,
      'project_created',
      `Project created: ${getProjectType(row.project_type)?.label || row.project_type}`,
    );
    res.json({ project: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/ai-write-preview — draft report copy before save
// ---------------------------------------------------------------------------
router.post('/ai-write-preview', requireAdmin, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const {
      project_type, findings, recommendations, customer_id, project_date,
      include_communications = true,
    } = req.body;
    if (!isValidProjectType(project_type)) return res.status(400).json({ error: 'Invalid project_type' });

    const typeCfg = getProjectType(project_type);
    const customer = customer_id ? await db('customers').where({ id: customer_id }).first() : null;
    const tech = req.technicianId ? await db('technicians').where({ id: req.technicianId }).first() : null;
    const communicationContext = include_communications === false
      ? ''
      : await getCustomerCommunicationContext(customer_id);
    const report = await draftProjectReport({
      typeCfg,
      findings: findings || {},
      rawRecommendations: recommendations || '',
      customer,
      tech,
      projectDate: normalizeDateOnly(project_date),
      communicationContext,
    });

    logger.info(`[projects] ai-write-preview ${project_type} — ${report.length} chars`);
    res.json({ report });
  } catch (err) {
    logger.error(`[projects] ai-write-preview failed: ${err.message}`);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/wdo-intelligence — prefill high-signal WDO fields
// from the selected customer/property and an optional prior-treatment photo.
// ---------------------------------------------------------------------------
router.post('/wdo-intelligence', upload.single('previous_treatment_photo'), async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const customerId = req.body.customer_id || null;
    const projectId = req.body.project_id || null;
    const serviceRecordId = req.body.service_record_id || null;
    const scheduledServiceId = req.body.scheduled_service_id || null;
    const currentFindings = normalizeFindings(req.body.findings);
    let scopedCustomerId = customerId;

    if (projectId) {
      const project = await db('projects').where({ id: projectId }).first();
      if (!(await requireProjectAccess(req, res, project))) return;
      if (project.project_type !== 'wdo_inspection') return res.status(400).json({ error: 'Project is not a WDO inspection' });
      if (customerId && project.customer_id && String(customerId) !== String(project.customer_id)) {
        return res.status(400).json({ error: 'Customer does not belong to the selected project' });
      }
      scopedCustomerId = project.customer_id || customerId;
    } else if (!isAdmin(req)) {
      if (!customerId) return res.status(400).json({ error: 'Customer required for technician WDO intelligence' });
      await validateProjectCreateScope(req, {
        customer_id: customerId,
        service_record_id: serviceRecordId,
        scheduled_service_id: scheduledServiceId,
      });
    }

    const customer = scopedCustomerId
      ? await db('customers').where({ id: scopedCustomerId }).whereNull('deleted_at').first()
      : null;
    if (scopedCustomerId && !customer) return res.status(404).json({ error: 'Customer not found' });

    const explicitAddress = cleanOneLine(req.body.property_address, 500);
    const propertyAddress = explicitAddress || formatCustomerPropertyAddress(customer);
    if (!propertyAddress) {
      return res.status(400).json({ error: 'Property address required' });
    }
    if (req.file?.buffer?.length > AI_PHOTO_MAX_BYTES) {
      return res.status(400).json({ error: 'Prior-treatment photo is too large for AI review' });
    }

    const previousTreatmentPhoto = req.file
      ? { buffer: req.file.buffer, mediaType: validateUploadedImage(req.file) }
      : null;

    const result = await analyzeWdoProjectIntelligence({
      customer,
      propertyAddress,
      currentFindings,
      previousTreatmentPhoto,
    });

    logger.info('[projects] WDO intelligence generated', {
      customerId,
      hasPhoto: Boolean(previousTreatmentPhoto),
      confidence: result.confidence,
      fields: Object.keys(result.suggestedFindings || {}).filter((key) => hasMeaningfulValue(result.suggestedFindings[key])),
    });
    res.json(result);
  } catch (err) {
    logger.error(`[projects] WDO intelligence failed: ${err.message}`);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/projects/:id — update findings / recommendations / title
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;

    const updates = {};
    const allowed = ['title', 'project_date', 'findings', 'recommendations', 'followup_date', 'followup_findings'];
    for (const f of allowed) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (updates.project_date !== undefined) updates.project_date = normalizeDateOnly(updates.project_date);
    if (Object.keys(updates).length === 0) return res.json({ project });

    await db('projects').where({ id: req.params.id }).update({ ...updates, updated_at: db.fn.now() });
    const updated = await db('projects').where({ id: req.params.id }).first();
    await logProjectActivity(
      req,
      updated,
      'project_updated',
      `Project updated: ${getProjectType(updated.project_type)?.label || updated.project_type}`,
      { fields: Object.keys(updates) },
    );
    res.json({ project: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// WDO report PDF + invoice helpers (shared by /send and /send-with-invoice)
// ---------------------------------------------------------------------------
function pdfEmailAttachment(filename, buffer) {
  return {
    filename,
    content: buffer.toString('base64'),
    type: 'application/pdf',
    disposition: 'attachment',
  };
}

function parseFindings(project) {
  try { return typeof project.findings === 'string' ? JSON.parse(project.findings) : (project.findings || {}); }
  catch { return {}; }
}

// Resolve the FDACS Section-1 inspector identity. The WDO findings don't
// collect the inspector and a plain db('projects') load has no tech_name, so
// load the technician who performed the project (created_by_tech_id) and use
// their name + FL applicator license (the individual's ID-card number). An
// explicit applicator_* finding still wins if present.
async function resolveProjectApplicator(project) {
  const findings = parseFindings(project);
  let name = String(findings.applicator_name || project.tech_name || '').trim();
  let idCardNo = String(findings.applicator_fdacs_id || '').trim();
  if ((!name || !idCardNo) && project.created_by_tech_id) {
    const tech = await db('technicians').where({ id: project.created_by_tech_id }).first().catch(() => null);
    if (tech) {
      name = name || String(tech.name || '').trim();
      idCardNo = idCardNo || String(tech.fl_applicator_license || '').trim();
    }
  }
  return { name, idCardNo };
}

// Build the filled FDACS-13645 PDF for a WDO project as an email attachment.
// Returns null (and logs) on any failure so a render hiccup never blocks the
// rest of the delivery.
async function buildWdoPdfAttachment(project, customer) {
  if (project?.project_type !== 'wdo_inspection') return null;
  try {
    const applicator = await resolveProjectApplicator(project);
    const buffer = await buildWdoReportPDFBuffer({ project, customer, applicator });
    return pdfEmailAttachment('FDACS-13645-WDO-Inspection-Report.pdf', buffer);
  } catch (err) {
    logger.error(`[projects] WDO PDF build failed for ${project.id}: ${err.message}`);
    return null;
  }
}

// Resolve the WDO inspection fee from the canonical bracketed pricing config
// (SPECIALTY.wdo.brackets), keyed on property footprint when known. Falls back
// to the base bracket if footprint isn't available.
function resolveWdoInspectionFee(findings) {
  const brackets = SPECIALTY?.wdo?.brackets || [];
  // WDO brackets key on STRUCTURE footprint. customers.property_sqft is treated
  // LAWN area (see initial_schema) and there is no structure-footprint column,
  // so we never infer the tier from customer columns — that would bill a small
  // house on a big lot into the $200/$225 tiers. Only an explicit structure
  // footprint captured on the inspection itself overrides the base bracket.
  const footprint = Number(findings?.structure_sqft || findings?.wdo_structure_sqft) || 0;
  if (footprint > 0) {
    for (const bracket of brackets) {
      if (footprint <= bracket.maxSqFt) {
        const price = Number(bracket.price);
        if (Number.isFinite(price) && price > 0) return price;
      }
    }
  }
  const base = Number(brackets[0]?.price);
  return Number.isFinite(base) && base > 0 ? base : 175; // base bracket (≤2500 sq ft)
}

function isReusableInvoice(inv) {
  return inv && !['void', 'paid'].includes(inv.status);
}

// Persist the project → invoice link so a later dry-run / send / resend reuses
// the same invoice instead of minting a duplicate. Guarded so it degrades to a
// no-op in environments where the projects.invoice_id column hasn't migrated.
async function persistProjectInvoiceLink(project, invoiceId) {
  if (!invoiceId || project.invoice_id === invoiceId) return;
  try {
    await db('projects').where({ id: project.id }).update({ invoice_id: invoiceId, updated_at: db.fn.now() });
    project.invoice_id = invoiceId;
  } catch (err) {
    logger.warn(`[projects] could not persist invoice link for ${project.id}: ${err.message}`);
  }
}

// Find an invoice already linked to this project, else create a draft. Returns
// { invoice, created }. Used by the combined report+invoice send.
//
// Dedupe order: explicit id → persisted projects.invoice_id → an invoice minted
// for the same scheduled service / service record → create. The endpoint is hit
// twice per send (dry-run + send) and can be re-run on resend, and projects may
// be ad-hoc (no service_record_id / scheduled_service_id), so reuse must not
// rely on a service linkage alone — every resolved invoice is recorded back on
// the project.
async function resolveOrCreateProjectInvoice({ project, customer, invoiceId }) {
  if (invoiceId) {
    const explicit = await db('invoices').where({ id: invoiceId, customer_id: project.customer_id }).first();
    if (!explicit) throw new Error('Invoice not found for this customer');
    await persistProjectInvoiceLink(project, explicit.id);
    return { invoice: explicit, created: false };
  }

  // 1. Reuse the invoice already recorded on the project (covers ad-hoc
  //    projects with no service linkage, and the dry-run → send → resend path).
  if (project.invoice_id) {
    const prior = await db('invoices').where({ id: project.invoice_id, customer_id: project.customer_id }).first();
    if (isReusableInvoice(prior)) return { invoice: prior, created: false };
  }

  // 2. Reuse a non-paid invoice already minted for the same scheduled service
  //    or service record (mirrors project-completion.findExistingCompletionInvoice).
  if (project.scheduled_service_id || project.service_record_id) {
    const linked = await db('invoices')
      .where({ customer_id: project.customer_id })
      .whereNotIn('status', ['void', 'paid'])
      .where(function invoiceLinkage() {
        if (project.scheduled_service_id) this.orWhere({ scheduled_service_id: project.scheduled_service_id });
        if (project.service_record_id) this.orWhere({ service_record_id: project.service_record_id });
      })
      .orderBy('created_at', 'desc')
      .first();
    if (linked) {
      await persistProjectInvoiceLink(project, linked.id);
      return { invoice: linked, created: false };
    }
  }

  // 3. Create a draft, carrying the scheduled-service / service-record linkage
  //    forward so completion + future lookups can find it.
  const findings = parseFindings(project);
  const fee = resolveWdoInspectionFee(findings);
  const created = await InvoiceService.create({
    customerId: project.customer_id,
    serviceRecordId: project.service_record_id || undefined,
    scheduledServiceId: project.scheduled_service_id || undefined,
    title: 'WDO Inspection',
    lineItems: [{
      description: 'WDO Inspection (FDACS-13645 Wood-Destroying Organisms Inspection Report)',
      quantity: 1,
      unit_price: fee,
      amount: fee,
    }],
    notes: `Auto-generated for WDO inspection project ${project.id}.`,
  });
  // Re-fetch so callers get the canonical DB row shape (line_items as JSONB, etc.).
  const fresh = await db('invoices').where({ id: created.id }).first();
  const invoice = fresh || created;
  await persistProjectInvoiceLink(project, invoice.id);
  return { invoice, created: true };
}

// Normalize an invoice's line_items into an array for PDF rendering — the
// column may arrive as parsed JSONB (array) or a raw JSON string depending on
// the driver / code path.
function normalizeInvoiceLineItemsForPdf(lineItems) {
  if (Array.isArray(lineItems)) return lineItems;
  if (typeof lineItems === 'string') {
    try { const parsed = JSON.parse(lineItems); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/send — generate token, mark sent, notify customer
// Admin-only (prevents accidental send by tech before review).
//
// Notifies the customer via SMS (Twilio) and email (SendGrid) with the
// public report link. For WDO inspections, the filled FDACS-13645 PDF is
// attached to the email. The public token can be generated before delivery,
// but status only moves to 'sent' after at least one customer channel works.
// ---------------------------------------------------------------------------
router.post('/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;

    const readiness = evaluateProjectSendReadiness({ project, customer });
    const overrideReason = String(req.body?.override_reason || '').trim();
    const hasReadinessOverride = readiness.missing.length > 0 && overrideReason.length > 0;
    if (readiness.missing.length > 0 && !hasReadinessOverride) {
      return res.status(422).json({
        error: 'Project report is missing required details',
        missing: readiness.missing,
      });
    }

    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    const projectCols = await db('projects').columnInfo().catch(() => ({}));
    const portalAttachment = await resolveProjectPortalAttachment(project).catch((err) => {
      logger.warn(`[projects] portal attachment resolution failed for ${project.id}: ${err.message}`);
      return { portalAttached: false, portalAttachReason: 'resolution_failed', completionProfile: null };
    });
    const tokenUpdate = {
      report_token: token,
      updated_at: db.fn.now(),
    };
    if (projectCols.portal_visible) tokenUpdate.portal_visible = portalAttachment.portalAttached;
    if (projectCols.portal_visibility) {
      tokenUpdate.portal_visibility = portalAttachment.completionProfile?.portalVisibility || project.portal_visibility || 'token_only';
    }
    if (projectCols.portal_attach_policy) {
      tokenUpdate.portal_attach_policy = portalAttachment.completionProfile?.portalAttachPolicy || project.portal_attach_policy || 'active_portal_customer';
    }
    if (projectCols.completion_profile_snapshot && portalAttachment.completionProfile) {
      tokenUpdate.completion_profile_snapshot = JSON.stringify(portalAttachment.completionProfile);
    }
    await db('projects').where({ id: req.params.id }).update(tokenUpdate);

    const updatedProject = await db('projects').where({ id: req.params.id }).first();
    const reportPath = await projectReportPathForProject(db, updatedProject, customer || {});
    const reportUrl = `https://portal.wavespestcontrol.com${reportPath || `/report/project/${token}`}`;
    const typeCfg = getProjectType(project.project_type);
    const typeLabel = typeCfg?.label || 'Service';
    const firstName = customer?.first_name || 'there';

    const channels = {};

    // SMS
    if (customer?.phone) {
      try {
        const digits = String(customer.phone).replace(/\D/g, '');
        const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}`
          : digits.length === 10 ? `+1${digits}`
          : null;
        if (!normalized) {
          channels.sms = { ok: false, error: `Invalid phone format: ${customer.phone}` };
        } else {
          const smsBody = await renderRequiredSmsTemplate('project_report_ready', {
            first_name: firstName,
            project_type: typeLabel,
            report_url: reportUrl,
          }, {
            workflow: 'project_report_ready',
            entity_type: 'project',
            entity_id: project.id,
          });
          const result = await sendCustomerMessage({
            to: normalized,
            body: smsBody,
            channel: 'sms',
            audience: 'customer',
            purpose: 'support_resolution',
            customerId: customer.id,
            identityTrustLevel: 'phone_matches_customer',
            entryPoint: 'admin_project_report_send',
            metadata: {
              original_message_type: 'project_report',
              project_id: project.id,
            },
          });
          channels.sms = result.sent
            ? { ok: true }
            : { ok: false, error: result.reason || result.code || 'SMS send blocked/failed' };
        }
      } catch (e) {
        logger.error(`[projects] send sms failed: ${e.message}`);
        channels.sms = { ok: false, error: e.message };
      }
    } else {
      channels.sms = { ok: false, error: 'No phone on file' };
    }

    // Email (through editable Waves template library)
    const emailRecipient = ProjectEmail.resolveProjectEmailRecipient(customer || {});
    const wdoAttachment = await buildWdoPdfAttachment(updatedProject, customer);
    if (emailRecipient.email) {
      try {
        const result = await ProjectEmail.sendProjectReportReady({
          project: updatedProject,
          customer,
          reportUrl,
          isResend: Boolean(project.sent_at || project.status === 'sent'),
          attachments: wdoAttachment ? [wdoAttachment] : [],
        });
        channels.email = result.ok
          ? { ok: true, messageId: result.messageId || null }
          : { ok: false, error: result.reason || result.error || 'Email send blocked/failed' };
      } catch (e) {
        logger.error(`[projects] send email failed: ${e.message}`);
        channels.email = { ok: false, error: e.message };
      }
    } else {
      channels.email = { ok: false, error: 'No email on file' };
    }

    const availableChannels = [
      customer?.phone ? 'sms' : null,
      emailRecipient.email ? 'email' : null,
    ].filter(Boolean);
    const successfulChannelCount = availableChannels.filter(channel => channels[channel]?.ok).length;
    const deliveryStatus = successfulChannelCount === 0
      ? 'failed'
      : successfulChannelCount < availableChannels.length ? 'partial' : 'sent';
    const delivered = successfulChannelCount > 0;
    const deliveryUpdate = {
      delivery_channels: channels,
      delivery_status: deliveryStatus,
      last_delivery_at: db.fn.now(),
      updated_at: db.fn.now(),
    };
    if (delivered) {
      deliveryUpdate.status = 'sent';
      deliveryUpdate.sent_at = project.sent_at || db.fn.now();
    }

    await db('projects').where({ id: req.params.id }).update(deliveryUpdate);

    const sendAction = delivered
      ? (project.sent_at || project.status === 'sent' ? 'project_report_resent' : 'project_report_sent')
      : 'project_report_delivery_failed';
    await logProjectActivity(
      req,
      project,
      sendAction,
      delivered
        ? `${sendAction === 'project_report_resent' ? 'Project report resent' : 'Project report sent'}: ${typeLabel}`
        : `Project report delivery failed: ${typeLabel}`,
      {
        report_token: token,
        channels,
        delivery_status: deliveryStatus,
        ...(hasReadinessOverride ? {
          readiness_override: {
            reason: overrideReason,
            missing: readiness.missing,
          },
        } : {}),
      },
    );

    logger.info(`[projects] delivery ${project.id} token=${token} status=${deliveryStatus} sms=${channels.sms?.ok} email=${channels.email?.ok}`);
    res.json({
      project_id: project.id,
      report_token: token,
      report_url: reportPath || `/report/project/${token}`,
      channels,
      delivery_status: deliveryStatus,
      sent: delivered,
      ...(readiness.missing.length > 0 ? { readiness_override: hasReadinessOverride } : {}),
    });
  } catch (err) { next(err); }
});

function projectEmailFailureMessage(result) {
  return result?.reason || result?.error || 'Email send blocked/failed';
}

function normalizeUsPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/admin/projects/:id/fdacs-pdf — preview/download the filled
// FDACS-13645 WDO inspection report. Admin-only.
// ---------------------------------------------------------------------------
router.get('/:id/fdacs-pdf', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.project_type !== 'wdo_inspection') {
      return res.status(400).json({ error: 'FDACS-13645 PDF is only available for WDO inspections' });
    }
    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;
    const applicator = await resolveProjectApplicator(project);
    const buffer = await buildWdoReportPDFBuffer({ project, customer, applicator });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="FDACS-13645-${project.id}.pdf"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/send-with-invoice — combined delivery.
// Admin-only. Sends ONE email (filled FDACS-13645 PDF + invoice PDF attached,
// report link + pay link in the body) and ONE SMS (report link + pay link).
//
// Body: { invoice_id?, dry_run?, override_reason? }
//   - invoice_id : use this existing invoice; otherwise reuse a linked draft
//                  or auto-create a draft WDO inspection invoice.
//   - dry_run    : resolve/create the invoice and return its amount WITHOUT
//                  sending — lets the UI confirm the figure first.
// ---------------------------------------------------------------------------
router.post('/:id/send-with-invoice', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Enforce the WDO constraint the UI relies on — the auto-created invoice is
    // a "WDO Inspection" line, so a direct API call on another project type
    // must not bill the wrong service (mirrors the /fdacs-pdf guard).
    if (project.project_type !== 'wdo_inspection') {
      return res.status(400).json({ error: 'Report + invoice send is only available for WDO inspections' });
    }
    if (!project.customer_id) return res.status(400).json({ error: 'Project has no customer' });

    const customer = await db('customers').where({ id: project.customer_id }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Readiness gate mirrors /send so we never email an incomplete report.
    const readiness = evaluateProjectSendReadiness({ project, customer });
    const overrideReason = String(req.body?.override_reason || '').trim();
    const hasReadinessOverride = readiness.missing.length > 0 && overrideReason.length > 0;
    if (readiness.missing.length > 0 && !hasReadinessOverride) {
      return res.status(422).json({ error: 'Project report is missing required details', missing: readiness.missing });
    }

    const { invoice, created } = await resolveOrCreateProjectInvoice({
      project,
      customer,
      invoiceId: req.body?.invoice_id,
    });

    if (['paid', 'void'].includes(invoice.status)) {
      return res.status(409).json({ error: `Cannot send a ${invoice.status} invoice`, invoice_id: invoice.id });
    }

    // dry_run: surface the resolved invoice + amount, send nothing.
    if (req.body?.dry_run) {
      return res.json({
        dry_run: true,
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          total: invoice.total,
          status: invoice.status,
          created,
        },
      });
    }

    // Report link (ensure a token exists, same shape as /send).
    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    if (!project.report_token) {
      await db('projects').where({ id: project.id }).update({ report_token: token, updated_at: db.fn.now() });
    }
    const refreshed = await db('projects').where({ id: project.id }).first();
    const reportPath = await projectReportPathForProject(db, refreshed, customer);
    const reportUrl = `https://portal.wavespestcontrol.com${reportPath || `/report/project/${token}`}`;

    // Pay link (short URL, same shape as invoice-email).
    const domain = publicPortalUrl();
    const payUrl = await shortenOrPassthrough(`${domain}/pay/${invoice.token}`, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });

    // Build both PDFs.
    const attachments = [];
    const wdoAttachment = await buildWdoPdfAttachment(refreshed, customer);
    if (wdoAttachment) attachments.push(wdoAttachment);
    try {
      const invoiceForPdf = { ...invoice, customer, line_items: normalizeInvoiceLineItemsForPdf(invoice.line_items) };
      const invoiceBuffer = await buildInvoicePDFBuffer(invoiceForPdf);
      attachments.push(pdfEmailAttachment(`invoice-${invoice.invoice_number}.pdf`, invoiceBuffer));
    } catch (err) {
      logger.error(`[projects] invoice PDF build failed for ${invoice.invoice_number}: ${err.message}`);
    }

    const typeLabel = getProjectType(project.project_type)?.label || 'Report';
    const firstName = customer.first_name || 'there';
    const channels = {};

    // ONE SMS — report link + pay link.
    const normalized = normalizeUsPhone(customer.phone);
    if (normalized) {
      try {
        const baseBody = await renderRequiredSmsTemplate('project_report_ready', {
          first_name: firstName,
          project_type: typeLabel,
          report_url: reportUrl,
        }, { workflow: 'project_report_with_invoice', entity_type: 'project', entity_id: project.id });
        const smsBody = `${baseBody}\n\nInvoice ${invoice.invoice_number} ($${Number(invoice.total).toFixed(2)}): ${payUrl}`;
        const result = await sendCustomerMessage({
          to: normalized,
          body: smsBody,
          channel: 'sms',
          audience: 'customer',
          purpose: 'support_resolution',
          customerId: customer.id,
          identityTrustLevel: 'phone_matches_customer',
          entryPoint: 'admin_project_report_with_invoice',
          metadata: { original_message_type: 'project_report_with_invoice', project_id: project.id, invoice_id: invoice.id },
        });
        channels.sms = result.sent ? { ok: true } : { ok: false, error: result.reason || result.code || 'SMS send blocked/failed' };
      } catch (e) {
        logger.error(`[projects] combined send sms failed: ${e.message}`);
        channels.sms = { ok: false, error: e.message };
      }
    } else {
      channels.sms = { ok: false, error: customer.phone ? `Invalid phone format: ${customer.phone}` : 'No phone on file' };
    }

    // ONE email — both PDFs attached.
    const emailRecipient = ProjectEmail.resolveProjectEmailRecipient(customer);
    if (emailRecipient.email) {
      try {
        const result = await ProjectEmail.sendProjectReportWithInvoice({
          project: refreshed, customer, reportUrl, payUrl, invoice, attachments,
        });
        channels.email = result.ok
          ? { ok: true, messageId: result.messageId || null }
          : { ok: false, error: projectEmailFailureMessage(result) };
      } catch (e) {
        logger.error(`[projects] combined send email failed: ${e.message}`);
        channels.email = { ok: false, error: e.message };
      }
    } else {
      channels.email = { ok: false, error: 'No email on file' };
    }

    const delivered = channels.sms?.ok || channels.email?.ok;

    // Finalize the invoice as delivered (it went out alongside the report).
    // markDeliverySent uses the canonical finalization semantics: it promotes
    // draft / scheduled / sending → sent and clears scheduled_send_at (and the
    // scheduled-review fields), so a 'scheduled' invoice can't be re-sent later
    // by processScheduledSends. It does NOT send anything itself, so the
    // invoice's own SMS path never fires a second, duplicate text.
    if (delivered) {
      await InvoiceService.markDeliverySent(invoice.id, {
        sms: !!channels.sms?.ok,
        email: !!channels.email?.ok,
        source: 'project_report_with_invoice',
        payUrl,
      }).catch((err) => logger.error(`[projects] markDeliverySent failed for ${invoice.id}: ${err.message}`));
    }

    if (delivered) {
      await db('projects').where({ id: project.id }).update({
        status: 'sent',
        sent_at: project.sent_at || db.fn.now(),
        last_delivery_at: db.fn.now(),
        delivery_channels: channels,
        delivery_status: (channels.sms?.ok && channels.email?.ok) ? 'sent' : 'partial',
        updated_at: db.fn.now(),
      });
    }

    await logProjectActivity(
      req, project,
      delivered ? 'project_report_with_invoice_sent' : 'project_report_with_invoice_failed',
      delivered
        ? `Report + invoice sent: ${typeLabel} (${invoice.invoice_number})`
        : `Report + invoice delivery failed: ${typeLabel}`,
      { report_token: token, invoice_id: invoice.id, invoice_created: created, channels,
        ...(hasReadinessOverride ? { readiness_override: { reason: overrideReason, missing: readiness.missing } } : {}) },
    );

    res.json({
      project_id: project.id,
      invoice: { id: invoice.id, invoice_number: invoice.invoice_number, total: invoice.total, created },
      report_url: reportPath || `/report/project/${token}`,
      pay_url: payUrl,
      channels,
      sent: delivered,
    });
  } catch (err) {
    if (err?.message === 'Invoice not found for this customer') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/send-prep-guide — send mapped prep email
// ---------------------------------------------------------------------------
router.post('/:id/send-prep-guide', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;
    if (!customer) return res.status(400).json({ error: 'Project has no customer' });

    const requestedTemplateKey = String(req.body?.template_key || '').trim();
    const templateKey = requestedTemplateKey || ProjectEmail.prepTemplateForProjectType(project.project_type);
    if (!templateKey || !ProjectEmail.isPrepTemplateKey(templateKey)) {
      return res.status(400).json({ error: 'No prep guide is configured for this project type' });
    }

    const recipient = ProjectEmail.resolveProjectEmailRecipient(customer);
    if (!recipient.email) return res.status(400).json({ error: 'Customer has no valid email on file' });

    const result = await ProjectEmail.sendPrepGuide({ project, customer, templateKey });
    const typeLabel = getProjectType(project.project_type)?.label || project.project_type;
    if (result.ok) {
      await logProjectActivity(
        req,
        project,
        'project_prep_guide_sent',
        `Prep guide sent: ${typeLabel}`,
        {
          channel: 'email',
          template_key: templateKey,
          recipient_role: recipient.role,
          provider_message_id: result.messageId || null,
        },
      );
      const freshProject = await db('projects').select('prep_token').where({ id: project.id }).first();
      return res.json({
        ok: true,
        sent: true,
        template_key: templateKey,
        message_id: result.messageId || null,
        prep_token: freshProject?.prep_token || null,
      });
    }

    const failure = projectEmailFailureMessage(result);
    await logProjectActivity(
      req,
      project,
      'project_prep_guide_failed',
      `Prep guide email failed: ${typeLabel}`,
      {
        channel: 'email',
        template_key: templateKey,
        recipient_role: recipient.role,
        failure_reason: failure,
      },
    );
    return res.status(result.skipped ? 400 : 502).json({ error: failure, template_key: templateKey });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/projects/:id/prep-expiry — set or clear prep guide expiration
// ---------------------------------------------------------------------------
router.patch('/:id/prep-expiry', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.prep_token) return res.status(400).json({ error: 'Project has no prep guide' });

    const { expires_at } = req.body || {};
    const prepExpiresAt = expires_at ? parseETDateTime(expires_at) : null;

    if (prepExpiresAt && isNaN(prepExpiresAt.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    await db('projects').where({ id: project.id }).update({ prep_expires_at: prepExpiresAt });
    await logProjectActivity(
      req,
      project,
      prepExpiresAt ? 'project_prep_expiry_set' : 'project_prep_expiry_cleared',
      prepExpiresAt
        ? `Prep guide expires ${prepExpiresAt.toISOString()}`
        : 'Prep guide expiration cleared',
    );

    return res.json({ ok: true, prep_expires_at: prepExpiresAt });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/send-portal-invite — send customer portal invite
// ---------------------------------------------------------------------------
router.post('/:id/send-portal-invite', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;
    if (!customer) return res.status(400).json({ error: 'Project has no customer' });

    const recipient = ProjectEmail.resolvePortalInviteRecipient(customer);
    if (!recipient.email) return res.status(400).json({ error: 'Customer has no valid email on file' });

    const result = await ProjectEmail.sendPortalInvite({ project, customer });
    const typeLabel = getProjectType(project.project_type)?.label || project.project_type;
    if (result.ok) {
      await logProjectActivity(
        req,
        project,
        'project_portal_invite_sent',
        `Portal invite sent: ${typeLabel}`,
        {
          channel: 'email',
          template_key: 'portal.invite',
          recipient_role: recipient.role,
          provider_message_id: result.messageId || null,
        },
      );
      return res.json({
        ok: true,
        sent: true,
        template_key: 'portal.invite',
        message_id: result.messageId || null,
      });
    }

    const failure = projectEmailFailureMessage(result);
    await logProjectActivity(
      req,
      project,
      'project_portal_invite_failed',
      `Portal invite email failed: ${typeLabel}`,
      {
        channel: 'email',
        template_key: 'portal.invite',
        recipient_role: recipient.role,
        failure_reason: failure,
      },
    );
    return res.status(result.skipped ? 400 : 502).json({ error: failure, template_key: 'portal.invite' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/close — admin only
// ---------------------------------------------------------------------------
router.post('/:id/close', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const result = await completeProjectBackedService({
      projectId: req.params.id,
      actorId: req.technicianId,
    });
    await logProjectActivity(
      req,
      result.project || project,
      'project_closed',
      `Project closed: ${getProjectType(project.project_type)?.label || project.project_type}`,
      {
        scheduled_service_id: project.scheduled_service_id || null,
        service_record_id: result.serviceRecord?.id || result.project?.service_record_id || null,
        service_completed: !!result.serviceCompleted,
        portal_attached: !!result.portalAttached,
        portal_attach_reason: result.portalAttachReason || null,
      },
    );
    res.json({
      ok: true,
      project: result.project,
      serviceRecordId: result.serviceRecord?.id || result.project?.service_record_id || null,
      serviceCompleted: !!result.serviceCompleted,
      portalAttached: !!result.portalAttached,
      portalAttachReason: result.portalAttachReason || null,
      reportUrl: result.reportPath || null,
      billing: result.billing || null,
      followup: result.followup || null,
    });
  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        error: err.message,
        code: err.code || null,
        details: err.details || null,
      });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/followup — record bed-bug follow-up visit
// ---------------------------------------------------------------------------
router.post('/:id/followup', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;
    if (project.project_type !== 'bed_bug') {
      return res.status(400).json({ error: 'Follow-up only applies to bed bug projects' });
    }
    const { followup_findings } = req.body;
    await db('projects').where({ id: req.params.id }).update({
      followup_findings: followup_findings || project.followup_findings,
      followup_completed_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    const updated = await db('projects').where({ id: req.params.id }).first();
    await logProjectActivity(
      req,
      updated,
      'project_followup_recorded',
      `Project follow-up recorded: ${getProjectType(updated.project_type)?.label || updated.project_type}`,
    );
    res.json({ project: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/ai-write — Claude drafts the
// customer-facing narrative sections from findings, communication context,
// tech notes, and photos. Admin reviews before Send.
//
// Accepts optional overrides in the body so the admin can generate against
// unsaved edits without a round-trip save. Admin-only — techs capture facts,
// admin owns customer-facing copy.
// ---------------------------------------------------------------------------
router.post('/:id/ai-write', requireAdmin, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const typeCfg = getProjectType(project.project_type);
    if (!typeCfg) return res.status(400).json({ error: 'Unknown project type' });

    const findings = req.body.findings || project.findings || {};
    const rawRecommendations = (req.body.recommendations !== undefined
      ? req.body.recommendations
      : project.recommendations) || '';
    const projectDate = normalizeDateOnly(req.body.project_date) || normalizeDateOnly(project.project_date) || normalizeDateOnly(project.created_at);

    const customer = await db('customers').where({ id: project.customer_id }).first();
    const tech = project.created_by_tech_id
      ? await db('technicians').where({ id: project.created_by_tech_id }).first()
      : null;
    const includeCommunications = req.body.include_communications !== false;
    const includePhotos = req.body.include_photos !== false;
    const communicationContext = includeCommunications
      ? await getCustomerCommunicationContext(project.customer_id)
      : '';
    const photos = includePhotos
      ? await db('project_photos')
        .where({ project_id: project.id })
        .orderBy(['visit', 'sort_order', 'created_at'])
        .limit(AI_PHOTO_LIMIT)
      : [];

    const report = await draftProjectReport({
      typeCfg,
      findings,
      rawRecommendations,
      customer,
      tech,
      projectDate,
      photos,
      communicationContext,
    });
    logger.info(`[projects] ai-write ${project.id} — ${report.length} chars`);
    res.json({ report });
  } catch (err) {
    logger.error(`[projects] ai-write failed: ${err.message}`);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Photo endpoints
// ---------------------------------------------------------------------------

// POST /api/admin/projects/:id/photos — multipart upload
router.post('/:id/photos', upload.single('photo'), async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    const contentType = validateUploadedImage(req.file);

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${PHOTO_PREFIX}${project.id}/${Date.now()}-${safeName}`;
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: contentType,
    }));

    const [row] = await db('project_photos').insert({
      project_id: project.id,
      s3_key: key,
      category: req.body.category || null,
      caption: req.body.caption || null,
      visit: req.body.visit === 'followup' ? 'followup' : 'primary',
      uploaded_by_tech_id: req.technicianId,
    }).returning('*');

    await logProjectActivity(
      req,
      project,
      'project_photo_uploaded',
      `Project photo uploaded: ${req.file.originalname}`,
      { photo_id: row.id, category: row.category, visit: row.visit },
    );
    res.json({ photo: row });
  } catch (err) { next(err); }
});

// GET /api/admin/projects/:id/photos/:photoId/url — presigned view URL
router.get('/:id/photos/:photoId/url', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;
    const photo = await db('project_photos').where({ id: req.params.photoId, project_id: req.params.id }).first();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket, Key: photo.s3_key,
    }), { expiresIn: 3600 });
    res.json({ url });
  } catch (err) { next(err); }
});

// DELETE /api/admin/projects/:id/photos/:photoId — remove a photo
router.delete('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;
    const photo = await db('project_photos').where({ id: req.params.photoId, project_id: req.params.id }).first();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    if (config.s3?.bucket && photo.s3_key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: photo.s3_key }));
      } catch (err) {
        if (!isMissingS3ObjectError(err)) {
          logger.warn(`[projects] failed to delete photo object ${photo.id}: ${err.message}`);
          return res.status(502).json({ error: 'Could not delete photo from storage. Please retry.' });
        }
        logger.warn(`[projects] photo object already missing ${photo.id}: ${photo.s3_key}`);
      }
    }
    const deleted = await db('project_photos')
      .where({ id: req.params.photoId, project_id: req.params.id })
      .del();
    if (!deleted) return res.status(404).json({ error: 'Photo not found' });
    await logProjectActivity(
      req,
      project,
      'project_photo_deleted',
      `Project photo deleted: ${photo.caption || photo.category || photo.id}`,
      { photo_id: photo.id, category: photo.category, visit: photo.visit },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/projects/:id/photos/:photoId — update caption / category
router.put('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;
    const updates = {};
    for (const f of ['caption', 'category', 'sort_order']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true });
    await db('project_photos')
      .where({ id: req.params.photoId, project_id: req.params.id })
      .update({ ...updates, updated_at: db.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router._private = {
  canAccessProject,
  hasProjectAccess,
  detectedImageMime,
  validateUploadedImage,
  isMissingS3ObjectError,
  logProjectActivity,
  evaluateProjectSendReadiness,
  completeProjectBackedService,
};

module.exports = router;
