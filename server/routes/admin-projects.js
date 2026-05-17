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
const serviceLibrary = require('../services/service-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { wrapEmail, formatDate, plainText } = require('../services/email-template');
const { etDateString } = require('../utils/datetime-et');
const { projectReportPathForProject } = require('../services/project-report-links');

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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function evaluateProjectSendReadiness({ project, customer, photoCount = 0 }) {
  const typeCfg = getProjectType(project?.project_type);
  const findings = normalizeFindings(project?.findings);
  // Certificate of Compliance is structured-findings + photos only — there is
  // no narrative "Recommendations" section on the rendered document, so the
  // shared recommendations check would force techs to type unrelated copy
  // (or override) just to satisfy a field that never reaches the customer.
  const isCertificate = project?.project_type === 'pre_treatment_termite_certificate';
  const required = [
    { key: 'project_date', label: isCertificate ? 'Treatment date' : 'Inspection date', ok: hasMeaningfulValue(project?.project_date) },
    { key: 'customer', label: 'Customer', ok: Boolean(customer?.id || project?.customer_id) },
    { key: 'project_type', label: 'Report title or type', ok: hasMeaningfulValue(project?.title) || Boolean(typeCfg) },
    { key: 'findings', label: 'Findings captured', ok: Object.values(findings).some(hasMeaningfulValue) },
    ...(isCertificate ? [] : [
      { key: 'recommendations', label: 'Recommendation / notes', ok: hasMeaningfulValue(project?.recommendations) },
    ]),
    { key: 'photos', label: 'Photos attached', ok: Number(photoCount) > 0 },
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

async function countProjectPhotos(projectId) {
  const row = await db('project_photos').where({ project_id: projectId }).count('* as count').first();
  return Number(row?.count || row?.n || 0);
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

    res.json({
      project: {
        ...project,
        customer_name: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
        report_url: project.report_token ? await projectReportPathForProject(db, project, project) : null,
      },
      upcomingAppointment: upcomingAppointment ? {
        serviceType: upcomingAppointment.service_type,
        scheduledDate: upcomingAppointment.scheduled_date,
        windowStart: upcomingAppointment.window_start,
        windowEnd: upcomingAppointment.window_end,
        technicianName: upcomingAppointment.technician_name,
      } : null,
      photos,
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
// POST /api/admin/projects/:id/send — generate token, mark sent, notify customer
// Admin-only (prevents accidental send by tech before review).
//
// Notifies the customer via SMS (Twilio) and email (SendGrid) with the
// public report link. The public token can be generated before delivery,
// but status only moves to 'sent' after at least one customer channel works.
// ---------------------------------------------------------------------------
router.post('/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;

    const photoCount = await countProjectPhotos(project.id);
    const readiness = evaluateProjectSendReadiness({ project, customer, photoCount });
    const overrideReason = String(req.body?.override_reason || '').trim();
    const hasReadinessOverride = readiness.missing.length > 0 && overrideReason.length > 0;
    if (readiness.missing.length > 0 && !hasReadinessOverride) {
      return res.status(422).json({
        error: 'Project report is missing required details',
        missing: readiness.missing,
      });
    }

    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    await db('projects').where({ id: req.params.id }).update({
      report_token: token,
      updated_at: db.fn.now(),
    });

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
          const smsBody = `Hi ${firstName}! Your Waves ${typeLabel} report is ready: ${reportUrl}\n\nQuestions? Reply here.`;
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

    // Email (via SendGrid, service-tier ASM group)
    if (customer?.email) {
      try {
        const sendgrid = require('../services/sendgrid-mail');
        if (!sendgrid.isConfigured()) {
          channels.email = { ok: false, error: 'SendGrid not configured' };
        } else {
          const serviceGid = parseInt(process.env.SENDGRID_ASM_GROUP_SERVICE) || null;
          const safeTypeLabel = escapeHtml(typeLabel);
          const safeFirstName = escapeHtml(firstName);
          const safeTitle = project.title ? escapeHtml(project.title) : '';
          const clientName = `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim();
          const fullAddress = [
            customer?.address_line1,
            [customer?.city, customer?.state].filter(Boolean).join(', '),
            customer?.zip,
          ].filter(Boolean).join(' ');
          const heading = `Your ${safeTypeLabel} report is ready`;
          const intro = `Hi ${safeFirstName}, your technician's report is posted. You can review the visit summary, photos, findings, and recommendations online.`;
          const projectDate = normalizeDateOnly(project.project_date) || normalizeDateOnly(project.created_at);
          const lines = [
            ['Report', safeTypeLabel],
            safeTitle ? ['Title', safeTitle] : null,
            projectDate ? ['Inspection date', formatDate(projectDate)] : null,
            clientName ? ['Client', escapeHtml(clientName)] : null,
            customer?.email ? ['Email', escapeHtml(customer.email)] : null,
            customer?.phone ? ['Phone', escapeHtml(customer.phone)] : null,
            fullAddress ? ['Property', escapeHtml(fullAddress)] : null,
            ['Prepared', formatDate(project.sent_at || new Date())],
          ].filter(Boolean);
          const html = wrapEmail({
            preheader: `Your Waves ${typeLabel} report is ready.`,
            heading,
            intro,
            lines,
            ctaHref: reportUrl,
            ctaLabel: 'View report',
            footerNote: 'Questions? Reply to this email or call (941) 297-5749.',
          });
          const text = plainText([
            `Hi ${firstName},`,
            '',
            intro,
            '',
            `Report: ${typeLabel}`,
            project.title ? `Title: ${project.title}` : null,
            projectDate ? `Inspection date: ${formatDate(projectDate)}` : null,
            clientName ? `Client: ${clientName}` : null,
            customer?.email ? `Email: ${customer.email}` : null,
            customer?.phone ? `Phone: ${customer.phone}` : null,
            fullAddress ? `Property: ${fullAddress}` : null,
            `View report: ${reportUrl}`,
            '',
            'Questions? Reply to this email or call (941) 297-5749.',
            '— Waves Pest Control',
          ]);
          const result = await sendgrid.sendOne({
            to: customer.email,
            fromEmail: 'reports@wavespestcontrol.com',
            fromName: 'Waves Pest Control',
            replyTo: 'contact@wavespestcontrol.com',
            subject: `Your Waves ${typeLabel} report is ready`,
            html,
            text,
            categories: ['project_report', `type_${project.project_type}`],
            asmGroupId: serviceGid,
          });
          channels.email = { ok: true, messageId: result.messageId };
        }
      } catch (e) {
        logger.error(`[projects] send email failed: ${e.message}`);
        channels.email = { ok: false, error: e.message };
      }
    } else {
      channels.email = { ok: false, error: 'No email on file' };
    }

    const availableChannels = [
      customer?.phone ? 'sms' : null,
      customer?.email ? 'email' : null,
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

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/close — admin only
// ---------------------------------------------------------------------------
router.post('/:id/close', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await db('projects').where({ id: req.params.id }).update({ status: 'closed', updated_at: db.fn.now() });
    await logProjectActivity(
      req,
      project,
      'project_closed',
      `Project closed: ${getProjectType(project.project_type)?.label || project.project_type}`,
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
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
};

module.exports = router;
