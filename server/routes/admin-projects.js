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
const { PROJECT_TYPES, PROJECT_TYPE_KEYS, WDO_CONSTRUCTION_OPTIONS, isValidProjectType, getProjectType } = require('../services/project-types');
const { appointmentManagedProjectTypes, resolveCompletionProfileForServiceId } = require('../services/service-completion-profiles');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const { lookupWdoHistory } = require('../services/property-lookup/wdo-history-lookup');
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
const { wdoReportCopyEmails } = require('../services/wdo-report-copies');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');
const { normalizeAddendumPhoto } = require('../services/pdf/addendum-photo');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');
const InvoiceService = require('../services/invoice');
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
    roofType: profile.roofType && profile.roofType !== 'UNKNOWN' ? profile.roofType : null,
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
  if (facts.roofType) lines.push(`Roof: ${facts.roofType}`);
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
  const { hasPreviousTreatmentContext = false, propertyProfile = null } = options;
  const suggested = raw?.suggestedFindings || raw?.findings || {};
  const previousTreatment = cleanOneLine(suggested.previous_treatment_evidence || '', 20);
  const normalizedPreviousTreatment = hasPreviousTreatmentContext
    ? (/^yes$/i.test(previousTreatment) ? 'Yes' : /^no$/i.test(previousTreatment) ? 'No' : '')
    : '';

  return {
    suggestedFindings: {
      property_address: cleanOneLine(fallbackAddress, 500),
      structures_inspected: cleanMultiline(suggested.structures_inspected, 900),
      structure_type: normalizeWdoConstructionSelection(suggested.structure_type || suggested.structures_inspected, propertyProfile),
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

function normalizeWdoConstructionSelection(value, propertyProfile = null) {
  const text = cleanOneLine(value, 160);
  const profileFacts = propertyProfile?.facts || propertyProfile || {};
  const factCandidates = [
    profileFacts.constructionMaterial,
    profileFacts.construction_material,
    profileFacts.structureType,
    profileFacts.structure_type,
    profileFacts.propertyType,
    profileFacts.property_type,
  ].map((item) => cleanOneLine(item, 160)).filter(Boolean);

  const mapCandidate = (candidate) => {
    if (WDO_CONSTRUCTION_OPTIONS.includes(candidate)) return candidate;
    const lower = candidate.toLowerCase();
    if (/\b(cmu|cbs|cb|concrete\s+masonry|masonry\s+unit|masonry|block|concrete\s+block|brick)\b/.test(lower)) {
      return 'CMU / Concrete Masonry Unit';
    }
    if (/\b(manufactured|mobile|modular)\b/.test(lower)) return 'Manufactured / Mobile Home';
    if (/\b(metal|steel|aluminum)\b/.test(lower)) return 'Metal Frame';
    if (/(^|[\W_])wood(?:en)?([\W_]|$)|(^|[\W_])wood[_\s-]*frame([\W_]|$)|^frame$/.test(lower)) return 'Wood Frame';
    return '';
  };

  for (const candidate of factCandidates) {
    const mapped = mapCandidate(candidate);
    if (mapped) return mapped;
  }

  return '';
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
- structure_type
- inspection_scope
- previous_treatment_evidence ("Yes" or "No" only; leave blank if not supported)
- previous_treatment_notes

Rules:
1. property_address should use the exact selected customer property address when available.
2. structures_inspected should list the structures on the property that are being inspected, such as main home, attached garage, detached garage, shed, or addition. Do not mention detached buildings unless clearly supported.
3. structure_type must be exactly one of these dropdown values when supported by property facts: ${WDO_CONSTRUCTION_OPTIONS.join(', ')}. Leave blank if the construction type is not supported by the facts.
4. inspection_scope should be a defensible WDO scope for visible and readily accessible areas. Include interior, garage, attic access, exterior perimeter, and accessible structural components when reasonable. Mention crawlspace only if the property facts indicate one.
5. Previous treatment is photo-grounded. If a prior-treatment photo is provided, look for visible treatment stickers/notices, drill holes, bait stations, patching, trench/rod marks, old treatment tags, or other visible treatment indicators. Use cautious language such as "photo appears to show" when the evidence is not definitive.
6. If no prior-treatment photo is provided and the existing fields do not mention prior treatment, leave previous_treatment_evidence and previous_treatment_notes blank. Do not default to "No" just because no photo was uploaded.
7. Do not fill FDACS finding, live WDO, WDO evidence, damage, treatment performed, pesticide, or treatment method.

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
    "structures_inspected": "<structure list text or blank>",
    "structure_type": "${WDO_CONSTRUCTION_OPTIONS.join('|')}|",
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
    propertyProfile,
  });
  return {
    ...normalized,
    propertyProfile: compactPropertyProfile(propertyProfile),
  };
}

// Section-1 administrative fields the WDO property lookup auto-fills on its own.
// They are NOT inspection findings — a report carrying only these would file
// with a blank inspection body, so they must not satisfy "Findings captured".
const WDO_AUTOFILL_ADMIN_KEYS = new Set([
  'requested_by',
  'report_sent_to',
  'notice_location',
  'property_address',
  'structures_inspected',
]);

function evaluateProjectSendReadiness({ project, customer }) {
  const typeCfg = getProjectType(project?.project_type);
  const findings = normalizeFindings(project?.findings);
  // Recommendations are optional. Some report types render cleanly from
  // structured findings alone, and admins can still add narrative notes when
  // a customer-facing next step is useful.
  const isCertificate = project?.project_type === 'pre_treatment_termite_certificate';
  // "Findings captured" must reflect real inspection content. On WDO reports
  // the Section-1 administrative fields below are auto-filled by the property
  // lookup, so a report carrying ONLY those would pass a naive "any field set"
  // check while the inspection body (Section 2+) is blank — exactly the failure
  // that filed an empty FDACS-13645. Exclude them so admin auto-fill alone can't
  // satisfy the gate; the hard wdoCoreFindingsIncomplete gate enforces the rest.
  const findingsCaptured = project?.project_type === 'wdo_inspection'
    ? Object.entries(findings).some(([key, value]) => !WDO_AUTOFILL_ADMIN_KEYS.has(key) && hasMeaningfulValue(value))
    : Object.values(findings).some(hasMeaningfulValue);
  const required = [
    { key: 'project_date', label: isCertificate ? 'Treatment date' : 'Inspection date', ok: hasMeaningfulValue(project?.project_date) },
    { key: 'customer', label: 'Customer', ok: Boolean(customer?.id || project?.customer_id) },
    { key: 'project_type', label: 'Report title or type', ok: hasMeaningfulValue(project?.title) || Boolean(typeCfg) },
    { key: 'findings', label: 'Findings captured', ok: findingsCaptured },
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
router.get('/types', async (_req, res) => {
  // appointmentManaged = the type's completion now runs through the typed
  // service-report flow (live profile cutover state). Creation UIs filter
  // these out of their type pickers; existing records stay fully usable.
  const managed = await appointmentManagedProjectTypes();
  const types = {};
  for (const key of PROJECT_TYPE_KEYS) {
    types[key] = { ...PROJECT_TYPES[key], appointmentManaged: managed.has(key) };
  }
  res.json({ types, keys: PROJECT_TYPE_KEYS, appointmentManaged: Array.from(managed) });
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

    // Select project columns explicitly, excluding the heavy JSONB blobs the list
    // never needs (signature data URL up to 2MB, property profile, history) —
    // pulling p.* would transfer/allocate hundreds of MB for up to 500 rows.
    const projectCols = await db('projects').columnInfo().catch(() => ({}));
    const HEAVY_LIST_COLS = new Set(['wdo_signature', 'property_profile', 'wdo_history', 'wdo_sent_filings']);
    const colNames = Object.keys(projectCols);
    const lightSelect = colNames.length
      ? colNames.filter((c) => !HEAVY_LIST_COLS.has(c)).map((c) => `p.${c}`)
      : ['p.*'];
    const blobFlags = projectCols.wdo_signature
      ? [db.raw('(p.wdo_signature IS NOT NULL) AS wdo_signed')]
      : [];

    let q = db('projects as p')
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .leftJoin('service_records as srp', 'p.service_record_id', 'srp.id')
      .leftJoin('scheduled_services as ssp', 'p.scheduled_service_id', 'ssp.id')
      .select(
        ...lightSelect,
        ...blobFlags,
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

    const projects = await Promise.all(rows.map(async (r) => {
      // wdo_signed comes from SQL (IS NOT NULL); wdo_signature is no longer
      // selected. The fallback handles the pre-columnInfo p.* path.
      const { wdo_signature, wdo_signed, ...rest } = r;
      return {
        ...rest,
        wdo_signed: !!(wdo_signed ?? wdo_signature),
        customer_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        report_url: r.report_token ? await projectReportPathForProject(db, r, r) : null,
        photo_count: photoMap[r.id] || 0,
      };
    }));

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

    // Strip the heavy signature image from the detail payload — expose only
    // the metadata the UI needs (signed state, who, when, and whether the
    // findings were edited after signing so a re-sign is required).
    const wdoSignature = (() => {
      let s = project.wdo_signature;
      if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
      if (!s || !s.image) return null;
      return {
        signed: true,
        signer_name: s.signer_name || null,
        signed_at: s.signed_at || null,
        content_stale: !wdoSignatureFreshness(project).fresh,
      };
    })();

    const parseJsonCol = (v) => {
      let p = v;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
      return p && typeof p === 'object' ? p : null;
    };
    const propertyProfile = parseJsonCol(project.property_profile);
    const wdoHistory = parseJsonCol(project.wdo_history);
    // Resolved inspector identity (name + FDACS ID) so the signature pad can
    // prefill the required FDACS ID-card field for WDO projects.
    const wdoApplicator = project.project_type === 'wdo_inspection'
      ? await resolveProjectApplicator(project).catch(() => null)
      : null;

    res.json({
      project: {
        ...project,
        wdo_signature: wdoSignature,
        // Heavy archive index (carries as-sent findings snapshots) — the UI
        // lists filings via GET /:id/wdo-filings instead.
        wdo_sent_filings: undefined,
        wdo_sent_filings_count: loadWdoFilings(project).length,
        property_profile: propertyProfile,
        wdo_history: wdoHistory,
        wdo_applicator: wdoApplicator,
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
    // Types cut over to the typed service-report completion flow no longer
    // create project records — the appointment completion is the artifact.
    // Server-side guard so stale clients can't recreate the dual-entry path.
    //
    // The LINKED appointment's own profile decides before the type-level
    // blanket: a project type becomes appointment-managed when ANY profile
    // routes it typed, but keys excluded from cutover (general_appointment,
    // waveguard_initial_setup) still resolve project_required and MUST keep
    // their Projects flow — otherwise they need a project they can't create.
    // The type-level check governs unlinked/ad hoc creations only.
    const managedTypes = await appointmentManagedProjectTypes();
    // The profile resolves from BOTH link fields: the route accepts
    // service_record_id with or without scheduled_service_id, and neither
    // path may become a side door for typed completions (Codex P1) —
    // especially for partially-cutover types the type-level guard no longer
    // blocks. When both links are present they must refer to the same visit,
    // or a crafted create could pair a project_required appointment with a
    // typed record and never have the record's profile checked.
    // FAIL CLOSED on resolver errors: a linked create whose profile can't be
    // verified must not slip through as a dual-entry project (the type-level
    // guard no longer covers partially-cutover types). 503, not silent null.
    let linkedProfile = null;
    let recordScheduledServiceId = null;
    if (service_record_id) {
      let linkedRecord;
      try {
        linkedRecord = await db('service_records')
          .where({ id: service_record_id })
          .first('scheduled_service_id');
      } catch (err) {
        logger.error(`[projects] linked record lookup failed for ${service_record_id}: ${err.message}`);
        return res.status(503).json({
          error: 'Could not verify the linked service record — try again shortly.',
          code: 'project_link_unverifiable',
        });
      }
      recordScheduledServiceId = linkedRecord?.scheduled_service_id || null;
    }
    if (scheduled_service_id && recordScheduledServiceId
        && String(recordScheduledServiceId) !== String(scheduled_service_id)) {
      return res.status(400).json({
        error: 'scheduled_service_id and service_record_id refer to different visits.',
        code: 'project_link_mismatch',
      });
    }
    const linkedScheduledServiceId = scheduled_service_id || recordScheduledServiceId;
    if (linkedScheduledServiceId) {
      try {
        linkedProfile = await resolveCompletionProfileForServiceId(linkedScheduledServiceId);
      } catch (err) {
        logger.error(`[projects] linked profile resolution failed for ${linkedScheduledServiceId}: ${err.message}`);
        return res.status(503).json({
          error: 'Could not verify the linked appointment — try again shortly.',
          code: 'project_link_unverifiable',
        });
      }
      if (linkedProfile?.findingsType) {
        return res.status(422).json({
          error: 'This appointment completes through its service-specific findings form — finish the visit from Dispatch instead of creating a project.',
          code: 'scheduled_service_appointment_managed',
        });
      }
    }
    // The bypass is scoped to the linked profile's OWN type — a linked
    // project_required appointment must not become a side door for creating
    // OTHER cut-over types (e.g. linking a general_appointment while
    // submitting mosquito_event).
    const linkedProjectTypeMatches = !!linkedProfile?.projectBacked
      && linkedProfile?.projectType === project_type;
    if (managedTypes.has(project_type) && !linkedProjectTypeMatches) {
      return res.status(422).json({
        error: 'This service type is completed through the appointment flow now — finish the visit from Dispatch instead of creating a project.',
        code: 'project_type_appointment_managed',
      });
    }
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

    // Cache the resolved property profile on the project so the specs panel
    // shows on reload without re-running the (web-search) lookup.
    if (projectId && result.propertyProfile) {
      const cols = await db('projects').columnInfo().catch(() => ({}));
      if (cols.property_profile) {
        await db('projects').where({ id: projectId })
          .update({ property_profile: JSON.stringify(result.propertyProfile), updated_at: db.fn.now() })
          .catch((err) => logger.warn(`[projects] could not cache property profile for ${projectId}: ${err.message}`));
      }
    }

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

// Process-local TTL cache for the pre-save (no project_id) WDO history path,
// which has no project row to cache the result on. Keeps a repeated tech/customer
// lookup for the same property from re-billing the up-to-8-search Anthropic call
// on every reload. Keyed by normalized address (property history is property-level
// public-records data, not customer-specific); short TTL since it only needs to
// span a work session, and process-local is fine on a single instance.
const WDO_HISTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const WDO_HISTORY_CACHE_MAX = 500;
const wdoHistoryAddressCache = new Map(); // normAddress -> { history, expires }

function wdoHistoryCacheKey(address) {
  return String(address || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function getCachedWdoHistory(address) {
  const key = wdoHistoryCacheKey(address);
  if (!key) return null;
  const hit = wdoHistoryAddressCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) { wdoHistoryAddressCache.delete(key); return null; }
  return hit.history;
}
function setCachedWdoHistory(address, history) {
  const key = wdoHistoryCacheKey(address);
  if (!key || !history) return;
  // Bound memory: drop the oldest entry when over cap (Map preserves insertion order).
  if (wdoHistoryAddressCache.size >= WDO_HISTORY_CACHE_MAX) {
    const oldest = wdoHistoryAddressCache.keys().next().value;
    if (oldest !== undefined) wdoHistoryAddressCache.delete(oldest);
  }
  wdoHistoryAddressCache.set(key, { history, expires: Date.now() + WDO_HISTORY_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// POST /api/admin/projects/wdo-history — research prior WDO treatment + permit
// history for the property (FDACS Section 4). Opt-in (separate web-search call).
// Body (JSON): { project_id?, customer_id?, property_address? }. Cached on the
// project when project_id is supplied, else in a process-local TTL cache.
// ---------------------------------------------------------------------------
router.post('/wdo-history', async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const customerId = req.body?.customer_id || null;
    const projectId = req.body?.project_id || null;
    const serviceRecordId = req.body?.service_record_id || null;
    const scheduledServiceId = req.body?.scheduled_service_id || null;
    const wantRefresh = req.body?.refresh === true || req.body?.refresh === 'true';
    let scopedCustomerId = customerId;

    if (projectId) {
      const project = await db('projects').where({ id: projectId }).first();
      if (!(await requireProjectAccess(req, res, project))) return;
      if (project.project_type !== 'wdo_inspection') return res.status(400).json({ error: 'Project is not a WDO inspection' });
      // Return the cached history unless an explicit refresh is requested — this
      // opt-in lookup runs up to 8 web searches, so the common reload/retry must
      // not re-bill an Anthropic call for the same project.
      if (!wantRefresh) {
        let cached = project.wdo_history;
        if (typeof cached === 'string') { try { cached = JSON.parse(cached); } catch { cached = null; } }
        if (cached && typeof cached === 'object') {
          return res.json({ history: cached, cached: true });
        }
      }
      scopedCustomerId = project.customer_id || customerId;
    } else if (!isAdmin(req)) {
      if (!customerId) return res.status(400).json({ error: 'Customer required for technician WDO history' });
      // Pass the assigned visit scope (service_record_id / scheduled_service_id)
      // so an assigned field tech isn't rejected before the project is saved.
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

    const propertyAddress = cleanOneLine(req.body?.property_address, 500) || formatCustomerPropertyAddress(customer);
    if (!propertyAddress) return res.status(400).json({ error: 'Property address required' });

    // Pre-save path (no project row to cache on): serve a recent in-memory result
    // for this address unless an explicit refresh is requested, so repeated tech
    // lookups don't re-bill the web-search call. (The project path already
    // returned its DB-cached history above.)
    if (!projectId && !wantRefresh) {
      const cachedHistory = getCachedWdoHistory(propertyAddress);
      if (cachedHistory) return res.json({ history: cachedHistory, cached: true });
    }

    // A failed lookup must surface as a FAILURE, not as "no history found" —
    // the tech would otherwise write "no prior treatment" onto a legal filing
    // off the back of a transient API error. A successful nothing-found comes
    // back as a normal history object (previousTreatment: false); null means
    // the lookup is unconfigured/skipped.
    let history = null;
    try {
      history = await lookupWdoHistory(propertyAddress);
    } catch (err) {
      // Log ids only — the property address is customer PII and must not be
      // interpolated into log lines.
      logger.warn(`[projects] WDO history lookup failed (project=${projectId || 'pre-save'}, customer=${scopedCustomerId || 'n/a'}): ${err.message}`);
      return res.status(502).json({ error: 'Treatment/permit history lookup failed — try again in a moment.', code: 'lookup_failed' });
    }
    if (!history) {
      return res.json({ history: null, message: 'History lookup unavailable — verify treatment/permit history on site.' });
    }

    if (projectId) {
      const cols = await db('projects').columnInfo().catch(() => ({}));
      if (cols.wdo_history) {
        await db('projects').where({ id: projectId })
          .update({ wdo_history: JSON.stringify(history), updated_at: db.fn.now() })
          .catch((err) => logger.warn(`[projects] could not cache WDO history for ${projectId}: ${err.message}`));
      }
    } else {
      setCachedWdoHistory(propertyAddress, history);
    }

    logger.info('[projects] WDO history generated', {
      projectId, previousTreatment: history.previousTreatment, confidence: history.confidence,
    });
    res.json({ history });
  } catch (err) {
    logger.error(`[projects] WDO history failed: ${err.message}`);
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

    // If this edit changed the content a captured WDO signature attests to,
    // flag the signature stale so the send gates force a re-sign. Best-effort:
    // the send gates re-verify the content hash themselves, so a bookkeeping
    // failure here can't let a hashed signature stamp edited content (only
    // legacy pre-hash signatures rely on this flag — hence the loud warn).
    let signatureStale = null;
    if (updates.findings !== undefined || updates.project_date !== undefined) {
      signatureStale = await refreshWdoSignatureStaleness(req, project, updated).catch((err) => {
        logger.warn(`[projects] WDO signature staleness update failed for ${updated.id}: ${err.message}`);
        return null;
      });
    }

    await logProjectActivity(
      req,
      updated,
      'project_updated',
      `Project updated: ${getProjectType(updated.project_type)?.label || updated.project_type}`,
      { fields: Object.keys(updates) },
    );
    res.json({ project: updated, ...(signatureStale !== null ? { signature_stale: signatureStale } : {}) });
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

// Read the captured licensee e-signature off the project (JSONB column).
function loadWdoSignature(project) {
  let sig = project.wdo_signature;
  if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch { sig = null; } }
  if (!sig || !sig.image) return null;
  return {
    image: sig.image,
    contentType: sig.content_type || 'image/png',
    signerName: sig.signer_name || '',
    signerIdCard: sig.signer_id_card || '',
    signedAt: sig.signed_at || null,
    contentHash: sig.content_hash || null,
    contentStale: Boolean(sig.content_stale),
  };
}

// Archive index of every FDACS PDF actually emailed (projects.wdo_sent_filings).
function loadWdoFilings(project) {
  let filings = project?.wdo_sent_filings;
  if (typeof filings === 'string') { try { filings = JSON.parse(filings); } catch { filings = []; } }
  return Array.isArray(filings) ? filings : [];
}

// Canonical hash of the content the licensee attests to: the findings JSON
// (key-order independent) plus the inspection date. Captured onto the
// signature at sign time and recomputed at every send/stamp, so a
// signed-then-edited report can never be emitted as a signed FDACS-13645 —
// the signature only authorizes the content it was drawn against.
function wdoContentHash(project) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = stable(value[key]);
        return acc;
      }, {});
    }
    return value;
  };
  const payload = JSON.stringify({
    findings: stable(parseFindings(project)),
    project_date: normalizeDateOnly(project.project_date),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Send-gate view of the signature: present, and does it still match the
// content it was captured against? Legacy signatures (captured before content
// hashing) carry no hash and are honored unless a findings edit has explicitly
// flagged them stale (refreshWdoSignatureStaleness on PUT /:id).
function wdoSignatureFreshness(project) {
  const signature = loadWdoSignature(project);
  if (!signature) return { signed: false, fresh: false, signature: null };
  const fresh = !signature.contentStale
    && (!signature.contentHash || signature.contentHash === wdoContentHash(project));
  return { signed: true, fresh, signature };
}

// FDACS Section 2 integrity: "NO visible signs of WDO(s)" (box A) with text
// still in the Section 2.B lines (live / evidence / damage) would print an
// internally contradictory legal filing — box A checked while B's lines carry
// findings. Happens when the tech types text first and flips the select late.
// Hard 422, no override: the fix is a 30-second edit (clear the text or
// change the finding; explanatory notes belong in Section 5 Comments), unlike
// the missing-data overrides which cover genuinely unknowable fields.
function wdoSectionTwoContradiction(project) {
  const findings = parseFindings(project);
  const finding = String(findings.wdo_finding || '').trim().toLowerCase();
  if (!finding.startsWith('no visible')) return null;
  const labels = {
    live_wdo: 'Live WDO(s)',
    wdo_evidence: 'Evidence of WDO(s)',
    wdo_damage: 'Damage caused by WDO(s)',
  };
  const conflicting = Object.keys(labels).filter((key) => String(findings[key] || '').trim());
  if (!conflicting.length) return null;
  const names = conflicting.map((key) => labels[key]).join(', ');
  return `Section 2 contradiction: "${findings.wdo_finding}" is selected but ${names} still contain${conflicting.length === 1 ? 's' : ''} text. Clear ${conflicting.length === 1 ? 'it' : 'them'} or change the finding — explanatory notes belong in Comments.`;
}

// FDACS Section 2 completeness: the inspection's core finding — and, when WDO
// activity is reported, the description of what was observed — must be present
// before the report is filed. Without them the official form goes out with a
// blank Section 2 (no box checked, no description): a legally deficient FDACS
// filing that defeats the purpose of the inspection. Hard 422, no override:
// unlike the missing-data overrides (which cover genuinely unknowable
// administrative fields), the inspection finding is the entire point of the
// report and is never unknowable. Pairs with wdoSectionTwoContradiction, which
// guards the inverse (a "no visible signs" finding carrying Section 2.B text).
function wdoCoreFindingsIncomplete(project) {
  const findings = parseFindings(project);
  const finding = String(findings.wdo_finding || '').trim();
  if (!finding) {
    return 'A WDO report requires a Section 2 finding (live WDOs, evidence of WDOs, damage, or "no visible signs") before it can be filed.';
  }
  // The PDF mapper only checks a Section 2 box for a finding that starts with
  // "no visible" or "visible" (the two project-types.js select options). Any
  // other value — a typo or a legacy string — maps to NO box and would file an
  // unchecked, blank Section 2. Reject it rather than let it through.
  const normalized = finding.toLowerCase();
  const noVisible = normalized.startsWith('no visible');
  const visible = !noVisible && normalized.startsWith('visible');
  if (!noVisible && !visible) {
    return 'The Section 2 finding must be a recognized selection ("Visible evidence of WDO observed" or "No visible signs of WDO observed") — the recorded value would leave the official form\'s Section 2 box blank.';
  }
  // A "visible activity" finding with no description would print the box
  // checked over blank Section 2.B lines — incomplete on its face. Require at
  // least one of the live / evidence / damage descriptions.
  if (visible) {
    const described = ['live_wdo', 'wdo_evidence', 'wdo_damage']
      .some((key) => String(findings[key] || '').trim());
    if (!described) {
      return 'Section 2 reports visible WDO activity but no live/evidence/damage description was entered — describe what was observed (Section 2.B) before filing.';
    }
  }
  return null;
}

// Called after PUT /:id persists a findings/project_date edit on a WDO
// project. If the project is signed and the attested content changed, flag the
// signature stale (and self-heal back to fresh if a hashed signature's content
// is edited back to exactly what was signed). The send gates re-verify the
// hash themselves, so this flag is the UX signal plus the only protection for
// legacy un-hashed signatures.
async function refreshWdoSignatureStaleness(req, before, after) {
  if (after.project_type !== 'wdo_inspection') return null;
  let sig = after.wdo_signature;
  if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch { sig = null; } }
  if (!sig || !sig.image) return null;
  const newHash = wdoContentHash(after);
  const stale = sig.content_hash
    ? sig.content_hash !== newHash
    // Legacy signature: no hash to verify a revert against, so once stale it
    // stays stale until the licensee re-signs.
    : (Boolean(sig.content_stale) || wdoContentHash(before) !== newHash);
  if (Boolean(sig.content_stale) === stale) return stale;
  await db('projects').where({ id: after.id }).update({
    wdo_signature: JSON.stringify({ ...sig, content_stale: stale }),
    updated_at: db.fn.now(),
  });
  if (stale) {
    await logProjectActivity(
      req,
      after,
      'project_wdo_signature_stale',
      `WDO findings edited after signing — ${sig.signer_name || 'licensee'} must re-sign before send`,
      { signer_name: sig.signer_name || null },
    );
  }
  return stale;
}

// The FDACS Print Name / ID Card No must match whoever actually signed, which
// may differ from the project creator (admin-created WDO, or another cardholder
// signs in the field). Prefer the captured signer identity over the project
// technician when a signature is present.
function applicatorForReport(baseApplicator, signature) {
  if (!signature) return baseApplicator;
  return {
    name: signature.signerName || baseApplicator.name,
    idCardNo: signature.signerIdCard || baseApplicator.idCardNo,
  };
}

// Photos are normalized (EXIF-rotated + downscaled + recompressed) before
// embedding, so the budgets below are backstops, not the primary control:
// 16 normalized photos run ~3-12MB total. The total budget is sized so even
// a fully-loaded addendum of fallback originals stays under SendGrid's 30MB
// cap after ~33% base64 inflation plus the form pages, invoice PDF, and HTML
// body (14MB raw → ~18.7MB encoded). The raw cap is a decode guard so a
// pathological upload can't balloon sharp's memory.
const MAX_ADDENDUM_PHOTOS = 16; // 8 addendum pages (2 per page)
const MAX_ADDENDUM_RAW_PHOTO_BYTES = 32 * 1024 * 1024;
const MAX_ADDENDUM_TOTAL_BYTES = 14 * 1024 * 1024;

// Fetch the project's photos from S3 for the PDF photo addendum, ordered the
// way the tech arranged them, normalizing each (normalizeAddendumPhoto:
// EXIF rotation baked in, bounded JPEG). When normalization can't decode the
// image, the original is used as-is if it's PNG/JPEG (pdf-lib can't embed
// anything else). Failures on individual photos are skipped so one bad object
// can't sink the whole report; anything past the count/byte budget is
// omitted (and logged).
async function loadWdoAddendumPhotos(project) {
  const rows = await db('project_photos')
    .where({ project_id: project.id })
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc')
    .catch(() => []);
  const out = [];
  let totalBytes = 0;
  for (const ph of rows) {
    if (out.length >= MAX_ADDENDUM_PHOTOS) {
      logger.warn(`[projects] addendum photo cap (${MAX_ADDENDUM_PHOTOS}) reached for ${project.id}; ${rows.length - out.length} omitted`);
      break;
    }
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: ph.s3_key }));
      const raw = await streamToBuffer(object.Body);
      if (!raw.length) continue;
      if (raw.length > MAX_ADDENDUM_RAW_PHOTO_BYTES) {
        logger.warn(`[projects] addendum photo ${ph.id} skipped — ${raw.length}B over raw decode guard`);
        continue;
      }

      const normalized = await normalizeAddendumPhoto(raw);
      let buffer;
      let contentType;
      if (normalized) {
        ({ buffer, contentType } = normalized);
      } else {
        // Couldn't decode — fall back to the original, but pdf-lib only
        // embeds PNG/JPEG, so skip anything else (e.g. WebP, GIF) rather
        // than consume an addendum slot with a "[Photo N unavailable]".
        const isPng = raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47;
        const isJpeg = raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
        if (!isPng && !isJpeg) {
          logger.warn(`[projects] addendum photo ${ph.id} skipped — unsupported image format for PDF embedding`);
          continue;
        }
        buffer = raw;
        contentType = object.ContentType || 'image/jpeg';
      }

      if (totalBytes + buffer.length > MAX_ADDENDUM_TOTAL_BYTES) {
        logger.warn(`[projects] addendum byte budget reached for ${project.id}; remaining photos omitted`);
        break;
      }
      totalBytes += buffer.length;
      out.push({ buffer, contentType, caption: ph.caption || '' });
    } catch (err) {
      logger.warn(`[projects] addendum photo fetch failed for ${ph.id}: ${err.message}`);
    }
  }
  return out;
}

// Build the filled FDACS-13645 PDF (+ signature + photo addendum) for a WDO
// project as an email attachment. Throws on failure — for a WDO report the
// FDACS PDF *is* the deliverable, so callers must abort the send rather than
// deliver a report-less or unsigned message. Returns null only for non-WDO
// projects (which carry no FDACS attachment).
//
// This helper is used only by the send paths (the admin preview at /fdacs-pdf
// calls buildWdoReportPDFBuffer directly), so it also enforces the signature
// invariant at the build choke-point: an unsigned WDO report can never be
// turned into a send attachment, regardless of which route (current or future)
// calls it. The route-level guards still return the clean 422 first; this is a
// compliance backstop.
async function buildWdoPdfAttachment(project, customer) {
  if (project?.project_type !== 'wdo_inspection') return null;
  const { signed, fresh, signature } = wdoSignatureFreshness(project);
  if (!signed) {
    const err = new Error('Licensee signature required before sending the WDO report');
    err.code = 'signature_required';
    throw err;
  }
  // Refuse to stamp a signature onto content the licensee never saw — the
  // route gates return the clean 422 first; this re-verifies at the choke
  // point so no caller can stamp stale content.
  if (!fresh) {
    const err = new Error('Findings were edited after signing — the licensee must re-sign before sending');
    err.code = 'signature_stale';
    throw err;
  }
  const [baseApplicator, photos] = await Promise.all([
    resolveProjectApplicator(project),
    loadWdoAddendumPhotos(project),
  ]);
  const applicator = applicatorForReport(baseApplicator, signature);
  const buffer = await buildWdoReportPDFBuffer({ project, customer, applicator, signature, photos });
  // Callers need the raw buffer too (to archive the exact emailed bytes), not
  // just the base64 email attachment.
  return { attachment: pdfEmailAttachment('FDACS-13645-WDO-Inspection-Report.pdf', buffer), buffer };
}

const FILING_PREFIX = 'project-filings/';

// Upload the exact FDACS-13645 PDF that is about to be emailed. Sends
// regenerate the PDF from live data, so this archive is the only durable
// record of what was actually filed in the real-estate transaction — callers
// run it BEFORE any channel send and treat failure as fatal (abort the send)
// rather than emailing an unarchived legal document. Returns the filing entry
// to append to projects.wdo_sent_filings once delivery succeeds; if the email
// then fails, the S3 object is simply orphaned (harmless) and no entry is
// recorded.
async function archiveWdoFiling({ project, buffer, source, invoiceId = null, sentByTechId = null }) {
  if (!config.s3?.bucket) throw new Error('S3 not configured');
  const key = `${FILING_PREFIX}${project.id}/${Date.now()}-FDACS-13645.pdf`;
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: 'application/pdf',
  }));
  const signature = loadWdoSignature(project);
  return {
    s3_key: key,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sent_at: new Date().toISOString(),
    source,
    invoice_id: invoiceId,
    sent_by_tech_id: sentByTechId,
    signer_name: signature?.signerName || null,
    signed_at: signature?.signedAt || null,
    content_hash: wdoContentHash(project),
    // As-sent snapshot — the public token viewer serves these for WDO so the
    // web report can never silently diverge from the emailed signed PDF.
    findings: parseFindings(project),
    project_date: normalizeDateOnly(project.project_date),
  };
}

// WDO inspection auto-invoice fee. The tech enters any fee on the form
// (findings.inspection_fee) — WDO pricing varies by construction (wood frame),
// new build, prior termite history, etc., so it's a free amount, not fixed
// tiers. That entry always wins. If it's left blank, fall back to tiering by
// the structure footprint they entered (≤2500 → $150 · ≤3500 → $200 · >3500 →
// $250), and if neither is set default to the top $250 tier (conservative;
// surfaced in the dry-run for the operator to adjust). We never tier on
// customers.property_sqft (that's lawn area).
const WDO_FEE_TIERS = [
  { maxSqFt: 2500, price: 150 },
  { maxSqFt: 3500, price: 200 },
  { maxSqFt: Infinity, price: 250 },
];
function parseWdoFee(value) {
  const m = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function resolveWdoInspectionFee(findings) {
  const picked = parseWdoFee(findings?.inspection_fee);
  if (picked > 0) return picked;
  const sqft = Number(String(findings?.structure_sqft ?? '').replace(/[^0-9.]/g, '')) || 0;
  if (sqft > 0) {
    for (const tier of WDO_FEE_TIERS) {
      if (sqft <= tier.maxSqFt) return tier.price;
    }
  }
  return 250; // nothing picked or measured — top tier, operator adjusts in dry-run
}

function isReusableInvoice(inv) {
  return inv && !['void', 'paid'].includes(inv.status);
}

const WDO_INVOICE_LINE_DESCRIPTION = 'WDO Inspection (FDACS-13645 Wood-Destroying Organisms Inspection Report)';

// If a reused invoice is still the auto-created WDO draft (untouched: draft
// status, our title + single WDO line item) and the resolved fee has since
// changed (the tech edited inspection_fee / structure_sqft between the dry-run
// and the send), reprice its line item so we never bill the stale amount. A
// manually edited invoice (different title/lines) is left untouched.
async function maybeRepriceWdoDraft(invoice, project) {
  if (!invoice || invoice.status !== 'draft' || String(invoice.title || '') !== 'WDO Inspection') return invoice;
  let items = invoice.line_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = null; } }
  if (!Array.isArray(items) || items.length !== 1) return invoice;
  if (!String(items[0].description || '').startsWith('WDO Inspection (FDACS')) return invoice;

  const fee = resolveWdoInspectionFee(parseFindings(project));
  if (Number(items[0].amount ?? items[0].unit_price) === fee) return invoice;
  try {
    const updated = await InvoiceService.update(invoice.id, {
      line_items: [{ description: WDO_INVOICE_LINE_DESCRIPTION, quantity: 1, unit_price: fee, amount: fee }],
    });
    return updated || invoice;
  } catch (err) {
    logger.warn(`[projects] WDO draft reprice failed for ${invoice.id}: ${err.message}`);
    return invoice;
  }
}

// Persist the project → invoice link so a later dry-run / send / resend reuses
// the same invoice instead of minting a duplicate. Guarded so it degrades to a
// no-op in environments where the projects.invoice_id column hasn't migrated.
// `runner` is the knex transaction when called inside resolveOrCreateProjectInvoice's
// lock (it must update the projects row on the same connection that holds the
// FOR UPDATE lock, or it self-deadlocks); defaults to the pooled db otherwise.
async function persistProjectInvoiceLink(project, invoiceId, runner = db) {
  if (!invoiceId || project.invoice_id === invoiceId) return;
  try {
    await runner('projects').where({ id: project.id }).update({ invoice_id: invoiceId, updated_at: db.fn.now() });
    project.invoice_id = invoiceId;
  } catch (err) {
    logger.warn(`[projects] could not persist invoice link for ${project.id}: ${err.message}`);
  }
}

// Compute the WDO invoice total for the dry-run preview WITHOUT creating an
// invoice. Delegates to InvoiceService.previewInvoiceTotals — the mirror of
// create()'s financial path now lives in invoice.js next to create() itself,
// because keeping a copy here drifted three times (legacy fallback rate,
// service-record tax key, and the #1520 scheduled-service tax key). The
// inputs match the InvoiceService.create call in resolveOrCreateProjectInvoice
// exactly: same service linkage, same 'WDO Inspection' title.
async function previewWdoInvoiceTotals(project, customer, fee) {
  return InvoiceService.previewInvoiceTotals({
    customerId: project.customer_id,
    customer,
    amount: fee,
    serviceRecordId: project.service_record_id || null,
    scheduledServiceId: project.scheduled_service_id || null,
    title: 'WDO Inspection',
  });
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
async function resolveOrCreateProjectInvoice({ project, customer, invoiceId, dryRun = false }) {
  if (invoiceId) {
    const explicit = await db('invoices').where({ id: invoiceId, customer_id: project.customer_id }).first();
    if (!explicit) throw new Error('Invoice not found for this customer');
    await persistProjectInvoiceLink(project, explicit.id);
    // This is the normal final-send path (UI posts the previewed draft's id), so
    // reprice it too if the WDO fee changed since the dry-run. Only the untouched
    // auto-created draft is affected; a hand-picked/edited invoice is left as-is.
    return { invoice: await maybeRepriceWdoDraft(explicit, project), created: false };
  }

  // Serialize the reuse-or-create decision on the project row. The endpoint is
  // hit twice per send (dry-run + send) and can be double-clicked, so two
  // overlapping POSTs used to race: both fell through the reuse checks (invoice_id
  // still null) and both called InvoiceService.create, leaving duplicate WDO
  // drafts (there's no DB uniqueness backstop on projects.invoice_id). A FOR UPDATE
  // lock makes the loser block until the winner commits the link, then re-read it
  // and reuse the same invoice. The lock is released on commit.
  return db.transaction(async (trx) => {
    const locked = await trx('projects').where({ id: project.id }).forUpdate().first();
    const linkedInvoiceId = (locked && locked.invoice_id) || project.invoice_id;

    // 1. Reuse the invoice already recorded on the project (covers ad-hoc
    //    projects with no service linkage, and the dry-run → send → resend path).
    if (linkedInvoiceId) {
      const prior = await trx('invoices').where({ id: linkedInvoiceId, customer_id: project.customer_id }).first();
      if (isReusableInvoice(prior)) {
        project.invoice_id = linkedInvoiceId;
        return { invoice: await maybeRepriceWdoDraft(prior, project), created: false };
      }
    }

    // 2. Reuse a non-paid invoice already minted for the same scheduled service
    //    or service record (mirrors project-completion.findExistingCompletionInvoice).
    if (project.scheduled_service_id || project.service_record_id) {
      const linked = await trx('invoices')
        .where({ customer_id: project.customer_id })
        .whereNotIn('status', ['void', 'paid'])
        .where(function invoiceLinkage() {
          if (project.scheduled_service_id) this.orWhere({ scheduled_service_id: project.scheduled_service_id });
          if (project.service_record_id) this.orWhere({ service_record_id: project.service_record_id });
        })
        .orderBy('created_at', 'desc')
        .first();
      if (linked) {
        await persistProjectInvoiceLink(project, linked.id, trx);
        return { invoice: await maybeRepriceWdoDraft(linked, project), created: false };
      }
    }

    // 2b. Don't re-bill an already-billed visit. The reuse checks above skip
    //     'paid'/'void' (and a paid invoice isn't reusable), so without this an
    //     admin who previews/resends a report whose invoice was already PAID would
    //     fall through to step 3 and mint a fresh draft + pay link for the same
    //     completed visit — a duplicate bill the later non-sendable-status guard
    //     can't catch (it only sees the new 'draft'). A paid OR in-flight ('processing',
    //     ACH) invoice linked to this project or the same scheduled-service /
    //     service-record means the work is settled or settling, so block the send
    //     with a 409 and surface the existing invoice. ('void' is intentionally
    //     excluded — a cancelled invoice should be re-billable.)
    const billedLinkClauses = [
      linkedInvoiceId ? { col: 'id', val: linkedInvoiceId } : null,
      project.scheduled_service_id ? { col: 'scheduled_service_id', val: project.scheduled_service_id } : null,
      project.service_record_id ? { col: 'service_record_id', val: project.service_record_id } : null,
    ].filter(Boolean);
    if (billedLinkClauses.length) {
      const alreadyBilled = await trx('invoices')
        .where({ customer_id: project.customer_id })
        .whereIn('status', ['paid', 'processing'])
        .where(function billedLinkage() {
          for (const c of billedLinkClauses) this.orWhere({ [c.col]: c.val });
        })
        .orderBy('created_at', 'desc')
        .first();
      if (alreadyBilled) {
        // Record the link so the UI can point at the settled invoice.
        await persistProjectInvoiceLink(project, alreadyBilled.id, trx);
        const err = new Error(`This visit is already billed on invoice ${alreadyBilled.invoice_number} (${alreadyBilled.status}). Nothing was sent.`);
        err.code = 'already_billed';
        err.invoiceId = alreadyBilled.id;
        err.invoiceNumber = alreadyBilled.invoice_number;
        throw err;
      }
    }

    // 3. Nothing to reuse — mint the project's draft invoice. How the draft is
    //    built depends on the project type.
    if (project.project_type === 'wdo_inspection') {
      // WDO bills a single auto-priced "WDO Inspection" line. On a dry-run, DON'T
      // mint a real draft just to show the amount — every cancelled preview would
      // strand an orphan invoice + burn an invoice number. Return a non-persisted
      // preview of the fee/total instead; `created: true` so the confirm dialog
      // still reads "Create and send", and the real send below does the create.
      const fee = resolveWdoInspectionFee(parseFindings(project));
      if (dryRun) {
        const totals = await previewWdoInvoiceTotals(project, customer, fee);
        return {
          invoice: { id: null, invoice_number: null, status: 'preview', ...totals },
          created: true,
          preview: true,
        };
      }

      // Real send — create a draft, carrying the scheduled-service / service-record
      // linkage forward so completion + future lookups can find it, and record it
      // on the project (inside the lock) so the racing/resend POST reuses it.
      const created = await InvoiceService.create({
        customerId: project.customer_id,
        serviceRecordId: project.service_record_id || undefined,
        scheduledServiceId: project.scheduled_service_id || undefined,
        title: 'WDO Inspection',
        lineItems: [{
          description: WDO_INVOICE_LINE_DESCRIPTION,
          quantity: 1,
          unit_price: fee,
          amount: fee,
        }],
        notes: `Auto-generated for WDO inspection project ${project.id}.`,
      });
      // Re-fetch so callers get the canonical DB row shape (line_items as JSONB, etc.).
      // InvoiceService.create auto-commits on the pooled connection (it doesn't touch
      // the locked projects row, so no lock conflict); the row is visible here.
      const fresh = await trx('invoices').where({ id: created.id }).first();
      const invoice = fresh || created;
      await persistProjectInvoiceLink(project, invoice.id, trx);
      return { invoice, created: true };
    }

    // Non-WDO service reports bill what the visit actually was, so the draft's
    // line items come from the linked service record's scheduled-service pricing.
    // Unlike WDO there's no cheap synthetic fee to preview, and replaying the
    // full discount/tax math outside create() would risk drift, so we mint the
    // real draft on BOTH the dry-run and the send. That's safe: the draft is
    // persisted + linked to the project, so a re-preview or the follow-up send
    // reuses the SAME draft (reuse path 1 above) — a cancelled preview leaves at
    // most one legitimate draft per project, never duplicates.
    if (!project.service_record_id) {
      const err = new Error('This service report isn’t linked to a completed visit, so an invoice can’t be built automatically. Create the invoice from the visit first — it will be reused here.');
      err.code = 'invoice_build_failed';
      throw err;
    }
    const serviceRecord = await trx('service_records')
      .where({ id: project.service_record_id, customer_id: project.customer_id })
      .first();
    if (!serviceRecord) {
      const err = new Error('The visit linked to this report wasn’t found for this customer, so an invoice can’t be built automatically.');
      err.code = 'invoice_build_failed';
      throw err;
    }
    // Derive the scheduled-service linkage for pricing from the LINKED SERVICE
    // RECORD first, falling back to the project's own scheduled_service_id (an
    // ad-hoc project's service record may not carry one). The report is tied to
    // project.service_record_id, so its visit — serviceRecord.scheduled_service_id
    // — is the authoritative appointment to bill from; project.scheduled_service_id
    // is a separate denormalized link that, if it disagrees, would price the
    // invoice off a different appointment than the one being reported on. Without
    // any scheduled service there's no priced line set to bill from.
    const scheduledServiceId = serviceRecord.scheduled_service_id || project.scheduled_service_id;
    const built = scheduledServiceId
      ? await InvoiceService.buildLineItemsForScheduledService(scheduledServiceId, {
          fallbackDescription: serviceRecord.service_type || getProjectType(project.project_type)?.label || 'Service visit',
        })
      : { lineItems: [], discountIds: [] };
    // Sum the non-discount (positive) lines — a draft with no positive lines
    // would bill $0, which means the visit has no pricing to invoice from. Fail
    // with an actionable message instead of minting a $0 orphan draft.
    const positiveTotal = (built.lineItems || []).reduce(
      (sum, item) => (Number(item.amount) > 0 ? sum + Number(item.amount) : sum), 0);
    if (positiveTotal <= 0) {
      const err = new Error('The linked visit has no pricing, so an invoice can’t be built automatically. Add pricing on the appointment (or create the invoice from the visit) first — it will be reused here.');
      err.code = 'invoice_build_failed';
      throw err;
    }
    const createdNonWdo = await InvoiceService.create({
      customerId: project.customer_id,
      serviceRecordId: project.service_record_id,
      scheduledServiceId: scheduledServiceId || undefined,
      lineItems: built.lineItems,
      discountIds: built.discountIds && built.discountIds.length ? built.discountIds : undefined,
      // The scheduled-service lines carry stored discount amounts; trust them so
      // the draft total matches the appointment (mirrors createFromService).
      trustedStoredDiscountSources: ['scheduled_service'],
      notes: `Auto-generated for ${getProjectType(project.project_type)?.label || 'service'} project ${project.id}.`,
    });
    const builtFresh = await trx('invoices').where({ id: createdNonWdo.id }).first();
    const builtInvoice = builtFresh || createdNonWdo;
    await persistProjectInvoiceLink(project, builtInvoice.id, trx);
    return { invoice: builtInvoice, created: true };
  });
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

    // A WDO report is an official FDACS-13645 filing — it must carry the
    // licensee signature, and the signature must still match the content it
    // was captured against (findings edited after signing require a re-sign).
    if (project.project_type === 'wdo_inspection') {
      const sigState = wdoSignatureFreshness(project);
      if (!sigState.signed) {
        return res.status(422).json({ error: 'Licensee signature required before sending the WDO report', code: 'signature_required' });
      }
      if (!sigState.fresh) {
        return res.status(422).json({ error: 'Findings were edited after signing — the licensee must re-sign before sending', code: 'signature_stale' });
      }
      const contradiction = wdoSectionTwoContradiction(project);
      if (contradiction) {
        return res.status(422).json({ error: contradiction, code: 'contradictory_findings' });
      }
      const incomplete = wdoCoreFindingsIncomplete(project);
      if (incomplete) {
        return res.status(422).json({ error: incomplete, code: 'incomplete_findings' });
      }
    }

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
    const isWdo = project.project_type === 'wdo_inspection';

    // A WDO report's FDACS-13645 PDF rides on the email only, so it can't be
    // delivered without an email address — fail up front rather than text a bare
    // link and record the official report as sent.
    if (isWdo && !ProjectEmail.resolveProjectEmailRecipient(customer || {}).email) {
      return res.status(422).json({ error: 'A WDO report is delivered as the FDACS-13645 PDF by email — add an email address for this customer first.', code: 'email_required' });
    }

    // Build the FDACS report PDF up-front. For a WDO report this PDF *is* the
    // deliverable (and is gated as signed), so a build/stamp failure must abort
    // before any channel send rather than deliver a report-less message.
    let wdoPdf = null;
    try {
      wdoPdf = await buildWdoPdfAttachment(updatedProject, customer);
    } catch (e) {
      logger.error(`[projects] WDO PDF build failed for ${updatedProject.id}: ${e.message}`);
      return res.status(500).json({ error: 'Could not generate the FDACS report; nothing was sent.' });
    }

    // Archive the exact PDF being emailed BEFORE any channel send (fail-closed):
    // sends regenerate the PDF from live data, so without this there would be
    // no record of what was actually delivered as the legal filing.
    let wdoFiling = null;
    if (wdoPdf) {
      try {
        wdoFiling = await archiveWdoFiling({
          project: updatedProject,
          buffer: wdoPdf.buffer,
          source: 'send',
          sentByTechId: req.technicianId || null,
        });
      } catch (e) {
        logger.error(`[projects] WDO filing archive failed for ${updatedProject.id}: ${e.message}`);
        return res.status(500).json({ error: 'Could not archive the FDACS filing; nothing was sent.' });
      }
    }

    const channels = {};

    // Email first (through editable Waves template library). For WDO it carries
    // the FDACS PDF, so the SMS link is only sent after the email succeeds.
    const emailRecipient = ProjectEmail.resolveProjectEmailRecipient(customer || {});
    if (emailRecipient.email) {
      try {
        const result = await ProjectEmail.sendProjectReportReady({
          project: updatedProject,
          customer,
          reportUrl,
          isResend: Boolean(project.sent_at || project.status === 'sent'),
          attachments: wdoPdf ? [wdoPdf.attachment] : [],
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

    // Third-party report copies — the FDACS "Report Sent to Requestor and
    // to:" line is a delivery claim; any emails the tech entered there get a
    // report-only copy once the customer email has succeeded. Exclusions
    // mirror the combined route: the resolved recipient, the primary email
    // (distinct when a service contact is configured), and the billing
    // contact, so no customer-side address gets an unintended duplicate.
    if (isWdo && channels.email?.ok) {
      const copyPrefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
      const [copyBilling] = getInvoiceEmailRecipients(customer, copyPrefs || {});
      const copies = await sendWdoReportCopies({
        req,
        project: updatedProject,
        customer,
        reportUrl,
        attachment: wdoPdf ? wdoPdf.attachment : null,
        excludeEmails: [emailRecipient.email, customer?.email, copyBilling?.email],
        isResend: Boolean(project.sent_at || project.status === 'sent'),
      });
      if (copies) channels.report_copies = copies;
    }

    // SMS (report link). For WDO, defer until the email (with the FDACS PDF)
    // succeeds so a failed email can't leave the customer with only a link while
    // the report is recorded not-sent; for other project types it's independent.
    const digits = String(customer?.phone || '').replace(/\D/g, '');
    const normalizedPhone = digits.length === 11 && digits.startsWith('1') ? `+${digits}`
      : digits.length === 10 ? `+1${digits}` : null;
    if (!customer?.phone) {
      channels.sms = { ok: false, error: 'No phone on file' };
    } else if (!normalizedPhone) {
      channels.sms = { ok: false, error: `Invalid phone format: ${customer.phone}` };
    } else if (isWdo && !channels.email?.ok) {
      channels.sms = { ok: false, error: 'Skipped — email delivery did not succeed' };
    } else {
      try {
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
          to: normalizedPhone,
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
      } catch (e) {
        logger.error(`[projects] send sms failed: ${e.message}`);
        channels.sms = { ok: false, error: e.message };
      }
    }

    const availableChannels = [
      customer?.phone ? 'sms' : null,
      emailRecipient.email ? 'email' : null,
    ].filter(Boolean);
    const successfulChannelCount = availableChannels.filter(channel => channels[channel]?.ok).length;
    // For WDO the FDACS PDF is email-only, so delivery requires the email to
    // succeed; for everything else any successful channel counts.
    const delivered = isWdo ? !!channels.email?.ok : successfulChannelCount > 0;
    const deliveryStatus = !delivered
      ? (successfulChannelCount === 0 ? 'failed' : 'partial')
      : (successfulChannelCount < availableChannels.length ? 'partial' : 'sent');
    const deliveryUpdate = {
      delivery_channels: channels,
      delivery_status: deliveryStatus,
      last_delivery_at: db.fn.now(),
      updated_at: db.fn.now(),
    };
    if (delivered) {
      // Resending a closed project's report must not regress its lifecycle
      // (closed_at stays set and closeout artifacts key on status='closed').
      deliveryUpdate.status = project.status === 'closed' ? project.status : 'sent';
      deliveryUpdate.sent_at = project.sent_at || db.fn.now();
      if (wdoFiling && projectCols.wdo_sent_filings) {
        // Atomic jsonb append — /send has no send claim, so a concurrent send
        // must not lose a filing record to read-modify-write.
        deliveryUpdate.wdo_sent_filings = db.raw(
          "coalesce(wdo_sent_filings, '[]'::jsonb) || ?::jsonb",
          [JSON.stringify([wdoFiling])],
        );
      }
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

// Email the report-only third-party copies named on the FDACS form (emails
// parsed from findings.report_sent_to — the realtor/title company in a
// closing). Runs only after the customer email succeeded; sends the FDACS PDF
// + report link and NEVER the invoice or pay link; logs to the project
// activity trail because the filing itself claims these deliveries ("Report
// Sent to Requestor and to:"). Best-effort per recipient — copy failures are
// recorded but don't change delivered/claim semantics.
async function sendWdoReportCopies({ req, project, customer, reportUrl, attachment, excludeEmails, isResend }) {
  const emails = wdoReportCopyEmails(parseFindings(project), excludeEmails);
  if (!emails.length) return null;
  const sent = [];
  const failed = [];
  for (const email of emails) {
    // The email is hashed into the idempotency key, not embedded: a long
    // (but valid) address could push the key past email_messages'
    // varchar(260) and fail the insert instead of sending.
    const emailKey = crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
    try {
      const result = await ProjectEmail.sendProjectReportReady({
        project,
        customer,
        reportUrl,
        attachments: attachment ? [attachment] : [],
        // name 'there' keeps the template greeting generic — the customer's
        // first name on a title company's copy would read wrong.
        recipient: { email, name: 'there', role: 'report_copy' },
        idempotencyKey: `project.report_copy:${project.id}:${emailKey}:${isResend ? new Date().toISOString() : 'initial'}`,
      });
      if (result.ok) sent.push(email);
      else failed.push({ email, error: projectEmailFailureMessage(result) });
    } catch (err) {
      failed.push({ email, error: err.message });
    }
  }
  if (sent.length) {
    await logProjectActivity(
      req,
      project,
      'project_report_copy_sent',
      `WDO report copy emailed to ${sent.join(', ')}`,
      { sent, failed: failed.map((f) => f.email) },
    ).catch(() => {});
  }
  if (failed.length) {
    // Counts + provider errors only — recipient email addresses are PII and
    // must not land in log lines (the activity trail above is the durable
    // record of who was and wasn't emailed).
    logger.warn(`[projects] ${failed.length} of ${emails.length} WDO report cop${failed.length === 1 ? 'y' : 'ies'} failed for ${project.id}: ${failed.map((f) => f.error).join('; ')}`);
  }
  // Shaped like every other channel entry ({ ok, error }) so the admin
  // delivery summary renders it correctly; sent/failed ride along for detail.
  return {
    ok: failed.length === 0,
    sent,
    failed,
    ...(failed.length
      ? { error: `${failed.length} of ${emails.length} report cop${failed.length === 1 ? 'y' : 'ies'} failed` }
      : {}),
  };
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
    const [baseApplicator, photos] = await Promise.all([
      resolveProjectApplicator(project),
      loadWdoAddendumPhotos(project),
    ]);
    // Never stamp a stale signature onto edited content — even in this admin
    // preview, which can be downloaded and filed manually. Render unsigned
    // instead, so the preview shows exactly what is currently sendable.
    const { fresh, signature } = wdoSignatureFreshness(project);
    const stampSignature = fresh ? signature : null;
    const applicator = applicatorForReport(baseApplicator, stampSignature);
    const buffer = await buildWdoReportPDFBuffer({ project, customer, applicator, signature: stampSignature, photos });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="FDACS-13645-${project.id}.pdf"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Archived FDACS filings. Every successful WDO send uploads the exact emailed
// PDF to S3 before delivery (archiveWdoFiling), so even though sends
// regenerate the PDF from live data there is always an immutable record of
// what was actually filed in the real-estate transaction.
//   GET /:id/wdo-filings           — metadata list (no findings snapshots)
//   GET /:id/wdo-filings/:index/url — presigned download URL for one filing
// ---------------------------------------------------------------------------
router.get('/:id/wdo-filings', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const filings = loadWdoFilings(project).map((f, index) => ({
      index,
      sha256: f.sha256 || null,
      sent_at: f.sent_at || null,
      source: f.source || null,
      invoice_id: f.invoice_id || null,
      signer_name: f.signer_name || null,
      signed_at: f.signed_at || null,
    }));
    res.json({ filings });
  } catch (err) { next(err); }
});

router.get('/:id/wdo-filings/:index/url', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const index = Number.parseInt(req.params.index, 10);
    const filing = Number.isInteger(index) && index >= 0 ? loadWdoFilings(project)[index] : null;
    if (!filing?.s3_key) return res.status(404).json({ error: 'Filing not found' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket, Key: filing.s3_key,
    }), { expiresIn: 3600 });
    res.json({ url, sha256: filing.sha256 || null, sent_at: filing.sent_at || null });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/wdo-signature — capture the licensee
// e-signature for a WDO report. Tech or admin (the licensee signs in the
// field). Body: { signature (PNG/JPEG data URL), signer_name?, signer_id_card?,
// attestation? }. DELETE clears it.
// ---------------------------------------------------------------------------
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // 2MB

// A valid PNG/JPEG can still be a blank (all-white or fully transparent) canvas,
// which would flip the WDO send gate to "signed" and emit an officially signed
// FDACS-13645 with no actual signature. Reject any image with ~zero variance on
// every channel — a real signature, even a faint one, moves at least one channel
// well past this floor. Can't decode? Don't block (we already validated the
// magic bytes); the UI's hasDrawn gate is the primary guard, this is depth.
async function signatureHasInk(buffer) {
  try {
    const sharp = require('sharp');
    const stats = await sharp(buffer).stats();
    return stats.channels.some((ch) => ch.stdev > 1.5);
  } catch (err) {
    logger.warn(`[projects] signature ink check skipped (decode failed): ${err.message}`);
    return true;
  }
}

router.post('/:id/wdo-signature', requireTechOrAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireProjectAccess(req, res, project))) return;
    if (project.project_type !== 'wdo_inspection') {
      return res.status(400).json({ error: 'Signatures are only captured for WDO inspections' });
    }
    const cols = await db('projects').columnInfo().catch(() => ({}));
    if (!cols.wdo_signature) {
      return res.status(503).json({ error: 'Signature capture is not available yet (pending migration)' });
    }

    const image = String(req.body?.signature || '').trim();
    const m = image.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/i);
    if (!m) return res.status(400).json({ error: 'signature must be a PNG or JPEG data URL' });
    const approxBytes = Math.floor((m[2].length * 3) / 4);
    if (approxBytes > MAX_SIGNATURE_BYTES) {
      return res.status(413).json({ error: 'Signature image too large (max 2MB)' });
    }
    // Validate the decoded bytes are a real PNG/JPEG (magic bytes) so a
    // malformed data URL can't be saved and later fail silently at stamp time
    // while the send gate still treats the project as signed.
    const decoded = Buffer.from(m[2], 'base64');
    const isPng = decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47;
    const isJpeg = decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
    if (!isPng && !isJpeg) {
      return res.status(400).json({ error: 'signature image is not a valid PNG or JPEG' });
    }
    if (!(await signatureHasInk(decoded))) {
      return res.status(400).json({ error: 'Signature looks blank — please sign before saving', code: 'signature_blank' });
    }

    const applicator = await resolveProjectApplicator(project);
    const signature = {
      image,
      content_type: m[1].toLowerCase(),
      signer_name: String(req.body?.signer_name || applicator.name || '').trim().slice(0, 120),
      signer_id_card: String(req.body?.signer_id_card || applicator.idCardNo || '').trim().slice(0, 60),
      attestation: String(req.body?.attestation || 'I certify I performed this inspection and the findings are accurate.').trim().slice(0, 500),
      signed_at: new Date().toISOString(),
      signed_by_tech_id: req.technicianId || null,
      // Binds the signature to the content it attests — the send gates
      // recompute this hash and refuse to stamp if findings/project_date
      // changed after signing (the licensee must re-sign).
      content_hash: wdoContentHash(project),
    };

    // The FDACS-13645 requires the licensee's printed name AND ID-card number,
    // and the send gate treats any saved signature as complete — so require both
    // here rather than emitting a signed form with a blank ID Card No.
    if (!signature.signer_name) {
      return res.status(400).json({ error: "Inspector's printed name is required to sign" });
    }
    if (!signature.signer_id_card) {
      return res.status(400).json({ error: "Inspector's FDACS ID card number is required to sign", code: 'signer_id_required' });
    }

    await db('projects').where({ id: project.id }).update({ wdo_signature: JSON.stringify(signature), updated_at: db.fn.now() });
    await logProjectActivity(req, project, 'project_wdo_signed', `WDO report signed by ${signature.signer_name || 'licensee'}`, { signer_name: signature.signer_name });
    res.json({ ok: true, signed_at: signature.signed_at, signer_name: signature.signer_name });
  } catch (err) { next(err); }
});

router.delete('/:id/wdo-signature', requireTechOrAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await requireProjectAccess(req, res, project))) return;
    if (project.project_type !== 'wdo_inspection') {
      return res.status(400).json({ error: 'Signatures are only captured for WDO inspections' });
    }
    const cols = await db('projects').columnInfo().catch(() => ({}));
    if (cols.wdo_signature) {
      const prior = loadWdoSignature(project);
      await db('projects').where({ id: project.id }).update({ wdo_signature: null, updated_at: db.fn.now() });
      // Clearing the licensee's e-signature on a legal filing must leave a
      // trail — capture logs project_wdo_signed, so removal logs too.
      if (prior) {
        await logProjectActivity(
          req,
          project,
          'project_wdo_signature_cleared',
          `WDO signature cleared (was signed by ${prior.signerName || 'licensee'})`,
          { signer_name: prior.signerName || null, signed_at: prior.signedAt || null },
        );
      }
    }
    res.json({ ok: true });
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
  // Tracks an invoice claimed as 'sending' so any abort (a throw before the
  // normal finalize/restore path) releases it instead of stranding it.
  let claimedInvoice = null;
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const isWdoProject = project.project_type === 'wdo_inspection';
    // WDO is an official FDACS-13645 filing — require the licensee signature
    // before anything else, and require it to still match the content it was
    // captured against (findings edited after signing force a re-sign). Other
    // project types carry no signature requirement.
    if (isWdoProject) {
      const sigState = wdoSignatureFreshness(project);
      if (!sigState.signed) {
        return res.status(422).json({ error: 'Licensee signature required before sending the WDO report', code: 'signature_required' });
      }
      if (!sigState.fresh) {
        return res.status(422).json({ error: 'Findings were edited after signing — the licensee must re-sign before sending', code: 'signature_stale' });
      }
      const contradiction = wdoSectionTwoContradiction(project);
      if (contradiction) {
        return res.status(422).json({ error: contradiction, code: 'contradictory_findings' });
      }
      const incomplete = wdoCoreFindingsIncomplete(project);
      if (incomplete) {
        return res.status(422).json({ error: incomplete, code: 'incomplete_findings' });
      }
    }
    if (!project.customer_id) return res.status(400).json({ error: 'Project has no customer' });

    const customer = await db('customers').where({ id: project.customer_id }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // The filled FDACS-13645 PDF rides on the email only (SMS can't carry it),
    // so a WDO report can't be delivered without an email — fail up front rather
    // than text a bare link and record the official report as sent. Non-WDO
    // reports deliver the report as a link in the text itself, so SMS-only is
    // fine and email isn't required.
    if (isWdoProject && !ProjectEmail.resolveProjectEmailRecipient(customer).email) {
      return res.status(422).json({ error: 'A WDO report is delivered as the FDACS-13645 PDF by email — add an email address for this customer first.', code: 'email_required' });
    }

    // Readiness gate mirrors /send so we never email an incomplete report.
    const readiness = evaluateProjectSendReadiness({ project, customer });
    const overrideReason = String(req.body?.override_reason || '').trim();
    const hasReadinessOverride = readiness.missing.length > 0 && overrideReason.length > 0;
    if (readiness.missing.length > 0 && !hasReadinessOverride) {
      return res.status(422).json({ error: 'Project report is missing required details', missing: readiness.missing });
    }

    // Explicit boolean — a stringified `dry_run: "false"` must NOT read as truthy
    // (and silently preview instead of send), nor `dry_run: 0` send for real.
    const dryRun = req.body?.dry_run === true || req.body?.dry_run === 'true';

    const { invoice, created } = await resolveOrCreateProjectInvoice({
      project,
      customer,
      invoiceId: req.body?.invoice_id,
      dryRun,
    });

    // Match the canonical invoice non-sendable statuses (invoice.js): don't
    // push another pay link for an invoice that's paid, void, mid-send, or has
    // a bank payment (ACH) already in flight ('processing').
    if (['paid', 'prepaid', 'void', 'processing', 'sending'].includes(invoice.status)) {
      return res.status(409).json({ error: `Cannot send a ${invoice.status} invoice`, invoice_id: invoice.id });
    }

    // dry_run: surface the resolved invoice + amount, send nothing and (for a
    // brand-new WDO) create nothing — `invoice` is a non-persisted preview here.
    if (dryRun) {
      // Routing preview so the confirm dialog shows exactly who gets what
      // BEFORE the send: the customer recipient (combined report+invoice
      // email), the billing-contact copy (same email, when a distinct billing
      // contact is configured), and the report-only third-party copies parsed
      // from the FDACS "Report Sent to Requestor and to:" line.
      const previewRecipient = ProjectEmail.resolveProjectEmailRecipient(customer);
      const previewPrefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
      const [previewBilling] = getInvoiceEmailRecipients(customer, previewPrefs || {});
      const previewRecipientEmail = String(previewRecipient.email || '').trim().toLowerCase();
      const previewBillingEmail = String(previewBilling?.email || '').trim().toLowerCase();
      return res.json({
        dry_run: true,
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          total: invoice.total,
          status: invoice.status,
          created,
        },
        email_routing: {
          recipient: previewRecipient.email || null,
          billing_copy: previewBillingEmail && previewBillingEmail !== previewRecipientEmail ? previewBillingEmail : null,
          // Same exclusion set the send applies: recipient, primary, billing.
          report_copies: isWdoProject
            ? wdoReportCopyEmails(parseFindings(project), [previewRecipientEmail, customer?.email, previewBillingEmail])
            : [],
        },
      });
    }

    // Atomically claim the invoice as 'sending' before any side effects, so two
    // overlapping send-with-invoice POSTs can't both pass the status check and
    // deliver duplicate report/pay-link messages (mirrors the InvoiceService
    // send-claim). Released below if nothing is delivered.
    const previousInvoiceStatus = invoice.status;
    const claimedRows = await db('invoices')
      .where({ id: invoice.id })
      // Mirror InvoiceService SEND_CLAIMABLE_STATUSES so resending a report for
      // an opened/overdue invoice works (getByToken flips sent → viewed once
      // the customer opens the pay link).
      .whereIn('status', ['draft', 'scheduled', 'sent', 'viewed', 'overdue'])
      .update({ status: 'sending', updated_at: db.fn.now() });
    if (!claimedRows) {
      return res.status(409).json({ error: 'Invoice send already in progress', invoice_id: invoice.id });
    }
    claimedInvoice = { id: invoice.id, previousStatus: previousInvoiceStatus };

    // Report link + portal visibility — mirror /send so a token_only WDO report
    // never leaks into the customer portal via the `portal_visible IS NULL` +
    // 'sent' legacy-visible path in documents.js.
    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    const projectCols = await db('projects').columnInfo().catch(() => ({}));
    const portalAttachment = await resolveProjectPortalAttachment(project).catch((err) => {
      logger.warn(`[projects] portal attachment resolution failed for ${project.id}: ${err.message}`);
      return { portalAttached: false, portalAttachReason: 'resolution_failed', completionProfile: null };
    });
    const tokenUpdate = { report_token: token, updated_at: db.fn.now() };
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
    await db('projects').where({ id: project.id }).update(tokenUpdate);
    const refreshed = await db('projects').where({ id: project.id }).first();
    const reportPath = await projectReportPathForProject(db, refreshed, customer);
    const reportUrl = `https://portal.wavespestcontrol.com${reportPath || `/report/project/${token}`}`;

    // Pay link (short URL, same shape as invoice-email).
    const domain = publicPortalUrl();
    const payUrl = await shortenOrPassthrough(`${domain}/pay/${invoice.token}`, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });

    // Build both PDFs. The FDACS report IS the deliverable here, so if it can't
    // be built (e.g. signature can't be stamped) abort and release the claim
    // rather than sending a report-less message.
    const attachments = [];
    let wdoFiling = null;
    let wdoPdf = null;
    try {
      wdoPdf = await buildWdoPdfAttachment(refreshed, customer);
      if (wdoPdf) {
        attachments.push(wdoPdf.attachment);
        // Archive the exact PDF being emailed BEFORE any channel send
        // (fail-closed) — sends regenerate the PDF from live data, so this is
        // the only durable record of the delivered legal filing.
        wdoFiling = await archiveWdoFiling({
          project: refreshed,
          buffer: wdoPdf.buffer,
          source: 'send_with_invoice',
          invoiceId: invoice.id,
          sentByTechId: req.technicianId || null,
        });
      }
    } catch (e) {
      await db('invoices').where({ id: invoice.id, status: 'sending' })
        .update({ status: previousInvoiceStatus, updated_at: db.fn.now() }).catch(() => {});
      logger.error(`[projects] WDO PDF build/archive failed for ${refreshed.id}: ${e.message}`);
      return res.status(500).json({ error: 'Could not generate the FDACS report; nothing was sent.' });
    }
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

    // ONE email FIRST — it carries the report attachments (the FDACS PDF for WDO)
    // + the invoice PDF. For WDO it's the required channel: the pay-link SMS is
    // only sent after the email succeeds, so a failed email can't leave the
    // customer with a bare pay-link text while the report is recorded not-sent
    // (and retries can't duplicate that text). For non-WDO the email is a bonus
    // (the report link rides in the SMS), so its failure doesn't block the text.
    const emailRecipient = ProjectEmail.resolveProjectEmailRecipient(customer);
    if (emailRecipient.email) {
      try {
        const result = await ProjectEmail.sendProjectReportWithInvoice({
          project: refreshed, customer, reportUrl, payUrl, invoice, attachments,
          // Only WDO attaches a report PDF (the FDACS-13645); non-WDO attaches
          // just the invoice PDF and delivers the report as a link. Drives the
          // template's attachments sentence so the copy matches reality.
          reportAttached: isWdoProject,
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

    // Billing-contact copy: recipient resolution above prefers the slot-1
    // service contact, so a configured billing contact (notification_prefs
    // billing_email / billing-role contact — the same resolution standalone
    // invoice emails use) otherwise never sees the invoice, amount due, or pay
    // link. Same combined email, explicit recipient. Best-effort: failures are
    // recorded on channels but never change delivered/claim semantics — the
    // customer copy governs.
    let billingCopyEmail = '';
    if (channels.email?.ok) {
      const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
      const [billing] = getInvoiceEmailRecipients(customer, prefs || {});
      const billingEmail = String(billing?.email || '').trim().toLowerCase();
      if (billingEmail && billingEmail !== String(emailRecipient.email || '').trim().toLowerCase()) {
        billingCopyEmail = billingEmail;
        try {
          const result = await ProjectEmail.sendProjectReportWithInvoice({
            project: refreshed, customer, reportUrl, payUrl, invoice, attachments,
            reportAttached: isWdoProject,
            recipient: { email: billing.email, name: billing.name || '', role: billing.role || 'billing' },
            idempotencyKey: `project.report_with_invoice:${project.id}:${invoice.id}:billing:${new Date().toISOString()}`,
          });
          channels.billing_email = result.ok
            ? { ok: true, recipient: billingEmail }
            : { ok: false, recipient: billingEmail, error: projectEmailFailureMessage(result) };
        } catch (e) {
          logger.error(`[projects] combined send billing copy failed: ${e.message}`);
          channels.billing_email = { ok: false, recipient: billingEmail, error: e.message };
        }
      }
    }

    // Third-party report copies — the FDACS "Report Sent to Requestor and
    // to:" line is a delivery claim; any emails the tech entered there get a
    // report-only copy (FDACS PDF + report link, never the invoice or pay
    // link) once the customer email has succeeded.
    if (isWdoProject && channels.email?.ok) {
      const copies = await sendWdoReportCopies({
        req,
        project: refreshed,
        customer,
        reportUrl,
        attachment: wdoPdf ? wdoPdf.attachment : null,
        excludeEmails: [emailRecipient.email, customer?.email, billingCopyEmail],
        isResend: Boolean(project.sent_at || project.status === 'sent'),
      });
      if (copies) channels.report_copies = copies;
    }

    // ONE SMS — report link + pay link. It goes through the canonical
    // 'payment_link' policy (consent, kill switch, identity trust, invoiceId).
    // That policy forbids an exact price and caps at 2 segments, so the body
    // omits the dollar amount (it's on the pay page / invoice PDF) and stays
    // terse. For WDO it's sent only after the email succeeds, since the report
    // itself lives in the email-only FDACS PDF and a bare pay-link text would be
    // wrong; for non-WDO the report link is in the text, so it sends regardless.
    const normalized = normalizeUsPhone(customer.phone);
    if (!normalized) {
      channels.sms = { ok: false, error: customer.phone ? `Invalid phone format: ${customer.phone}` : 'No phone on file' };
    } else if (isWdoProject && !channels.email?.ok) {
      channels.sms = { ok: false, error: 'Skipped — email delivery did not succeed' };
    } else {
      try {
        const smsBody = `Hi ${firstName}, your Waves ${typeLabel} report is ready: ${reportUrl}\n\nInvoice ${invoice.invoice_number} — pay online: ${payUrl}`;
        const result = await sendCustomerMessage({
          to: normalized,
          body: smsBody,
          channel: 'sms',
          audience: 'customer',
          purpose: 'payment_link',
          customerId: customer.id,
          invoiceId: invoice.id,
          identityTrustLevel: 'phone_matches_customer',
          entryPoint: 'admin_project_report_with_invoice',
          // original_message_type 'invoice' keeps the admin-sms-templates
          // invoice kill switch applicable to this billing text.
          metadata: { original_message_type: 'invoice', project_id: project.id, invoice_id: invoice.id },
        });
        channels.sms = result.sent ? { ok: true } : { ok: false, error: result.reason || result.code || 'SMS send blocked/failed' };
      } catch (e) {
        logger.error(`[projects] combined send sms failed: ${e.message}`);
        channels.sms = { ok: false, error: e.message };
      }
    }

    // Mirror /send: only count channels the customer actually has, so an
    // email-only or SMS-only customer whose one channel succeeds is recorded as
    // 'sent', not 'partial'.
    const availableChannels = [
      customer.phone ? 'sms' : null,
      emailRecipient.email ? 'email' : null,
    ].filter(Boolean);
    const successfulChannelCount = availableChannels.filter((ch) => channels[ch]?.ok).length;
    // The FDACS PDF is email-only, so a WDO report only counts as delivered when
    // the email succeeds; SMS is a supplementary link, and email failure means
    // not-sent (claim released below, nothing finalized). A non-WDO report
    // carries its link + pay link in either channel, so any successful channel
    // counts as delivered (mirrors /send).
    const delivered = isWdoProject ? !!channels.email?.ok : successfulChannelCount > 0;
    const deliveryStatus = !delivered
      ? (successfulChannelCount === 0 ? 'failed' : 'partial')
      : (successfulChannelCount < availableChannels.length ? 'partial' : 'sent');

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
    } else {
      // Nothing went out — release the 'sending' claim back to its prior status
      // so the invoice isn't stranded and can be retried.
      await db('invoices').where({ id: invoice.id, status: 'sending' })
        .update({ status: previousInvoiceStatus, updated_at: db.fn.now() }).catch(() => {});
    }

    if (delivered) {
      await db('projects').where({ id: project.id }).update({
        // Resending a closed project's report must not regress its lifecycle
        // (closed_at stays set and closeout artifacts key on status='closed').
        status: project.status === 'closed' ? project.status : 'sent',
        sent_at: project.sent_at || db.fn.now(),
        last_delivery_at: db.fn.now(),
        delivery_channels: channels,
        delivery_status: deliveryStatus,
        updated_at: db.fn.now(),
        ...(wdoFiling && projectCols.wdo_sent_filings ? {
          // Atomic jsonb append — never read-modify-write the filing index.
          wdo_sent_filings: db.raw(
            "coalesce(wdo_sent_filings, '[]'::jsonb) || ?::jsonb",
            [JSON.stringify([wdoFiling])],
          ),
        } : {}),
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
      delivery_status: deliveryStatus,
      sent: delivered,
    });
  } catch (err) {
    // Release the 'sending' claim on any abort so the invoice isn't stranded
    // (and retries don't 409). No-op if it was already finalized to 'sent'.
    if (claimedInvoice) {
      await db('invoices').where({ id: claimedInvoice.id, status: 'sending' })
        .update({ status: claimedInvoice.previousStatus, updated_at: db.fn.now() })
        .catch((e) => logger.warn(`[projects] claim release on error failed for ${claimedInvoice.id}: ${e.message}`));
    }
    if (err?.message === 'Invoice not found for this customer') {
      return res.status(404).json({ error: err.message });
    }
    // The invoice couldn't be auto-built from the visit (no linked visit / no
    // derivable pricing) — surface the actionable reason as a 422 rather than an
    // opaque 500.
    if (err?.code === 'invoice_build_failed') {
      return res.status(422).json({ error: err.message, code: err.code });
    }
    // The visit is already billed on a paid/in-flight invoice — block the
    // duplicate send with a 409 and point at the existing invoice.
    if (err?.code === 'already_billed') {
      return res.status(409).json({ error: err.message, code: err.code, invoice_id: err.invoiceId, invoice_number: err.invoiceNumber });
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
