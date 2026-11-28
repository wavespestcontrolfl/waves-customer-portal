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
const { invoicePayerOwnership } = require('../services/invoice-payer-ownership');
const config = require('../config');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('../services/llm/call');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { TECH_DEAD_ASSIGNMENT_STATUSES, techAccessCutoff, technicianVisitRowInScope } = require('../services/technician-visit-scope');
const {
  PROJECT_TYPES,
  PROJECT_TYPE_KEYS,
  WDO_CONSTRUCTION_OPTIONS,
  TERMITE_LIQUID_DILUTION_METHODS,
  TERMITE_PERIMETER_METHODS,
  isValidProjectType,
  getProjectType,
  stripInternalFindingKeys,
  redactInspectionFeeCues,
  redactSpecificAmounts,
  resolveFeeValuesForScrub,
  projectRecordedFeeValues,
  resolveProjectRecordedFeeValues,
  projectArchivedFeeValues,
  projectTypeHasInternalFindingKeys,
  projectTypeFreeTextKeys,
  projectTypeConfigFreeTextKeys,
  redactInspectionFeeCuesForType,
  redactProjectTitleForWrite,
  redactProjectFreeTextForWrite,
  projectTypeConfigHasInternalFindingKeys,
  filingBinaryMayDiscloseFee,
  woodBasePlatePct,
} = require('../services/project-types');
const { appointmentManagedProjectTypes, resolveCompletionProfileForServiceId, PROJECT_CREATION_LINKED_ONLY_TYPES } = require('../services/service-completion-profiles');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const { lookupWdoHistory } = require('../services/property-lookup/wdo-history-lookup');
const serviceLibrary = require('../services/service-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const ProjectEmail = require('../services/project-email');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
const { projectReportPathForProject } = require('../services/project-report-links');
const { findReportFollowupAppointment } = require('../services/report-followup-appointment');
const { resolveProjectReportPreviewFields } = require('../services/service-report/report-data');
const {
  buildProjectCloseoutPreview,
  completeProjectBackedService,
  completionTechnicianNotes,
  resolveProjectPortalAttachment,
} = require('../services/project-completion');
const { buildWdoReportPDFBuffer } = require('../services/pdf/wdo-report-pdf');
const { wdoReportCopyEmails } = require('../services/wdo-report-copies');
const { getInvoiceEmailRecipients, withAccountPrimaryContactStrict } = require('../services/customer-contact');

// The project's customer row with its account role resolved: the project
// report recipient (ProjectEmail.resolveProjectEmailRecipient with
// applyReportRule) withholds the report from an occupant on a property
// manager's account and falls back to the account holder, so a property row
// with no email of its own takes the account primary's email and first name.
// The phone stays the row's own (project texts are unchanged). An unreadable
// account primary leaves the role unknown, which withholds.
// strict (the unattended hold release): a failed account-holder lookup throws instead of falling back to the property
// row, which would lose the manager role that keeps reports from on-site occupants. The release stays held and retries.
// database + forShare (the report email's handoff): the property and the account holder rows are read on that
// transaction, the holder's row held FOR SHARE until it commits, so neither can change before the provider request.
async function loadProjectCustomer(customerId, { strict = false, database = db, forShare = false } = {}) {
  const query = database('customers').where({ id: customerId });
  const row = await (forShare ? query.forShare() : query).first();
  if (!row) return row;
  const full = await withAccountPrimaryContactStrict(row, { db: database, forShare })
    .catch((err) => { if (strict) throw err; return null; });
  if (!full || full === row) return row;
  return { ...row, email: full.email, first_name: full.first_name, account_contact_role: full.account_contact_role };
}
const { normalizeAddendumPhoto } = require('../services/pdf/addendum-photo');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');
const InvoiceService = require('../services/invoice');
const { acquireScheduledMintLockChain, TERMINAL_INVOICE_STATUSES } = require('../services/scheduled-invoice-mint');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { publicPortalUrl } = require('../utils/portal-url');
const { recordAuditEvent } = require('../services/audit-log');
const {
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
  parseWdoFeeAmount,
  loadLinkedWdoVisit,
} = require('../services/wdo-inspection-fee');
const { wdoReportHoldLive, isEnabled } = require('../config/feature-gates');
const { invoiceWithdrawnFromCustomer } = require('../services/invoice-helpers');
const { isReportHeld, REPORT_UNSHARED_SQL, reportLinkShared } = require('../services/project-report-hold');

router.use(adminAuthenticate, requireTechOrAdmin);

const ALLOWED_UPLOAD_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
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

// Project types whose project_date lands on a dated legal filing (FDACS-13645
// / pre-treat certificate) — a future date can't be attested, so create/edit
// reject it instead of trusting the keyboard.
const LEGAL_DOC_DATE_TYPES = new Set(['wdo_inspection', 'pre_treatment_termite_certificate']);

// The pre-treat certificate's final-exterior fields are free text that the
// customer notice prints. The shared copy
// screen runs here at write time: a claim ("pet-safe", "EPA-approved") or an
// access code is refused, not stored. reports-public blanks the same keys at
// egress, and the detail payload names them for the staff preview.
const { failingFinalExteriorKeys, isClockTime } = require('../services/final-exterior-screen');
// A date of something already done, on a legal document (the final
// exterior treatment, the framing inspection, the Bora-Care application):
// blank, or a real YYYY-MM-DD no later than today (ET), like project_date,
// and never before `initialDate` when one is given (same day allowed).
function pastCertificateDateProblem(value, initialDate) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return true;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== raw) return true;
  if (raw > etDateString()) return true;
  const initial = normalizeDateOnly(initialDate);
  return Boolean(initial) && raw < initial;
}

// Staff-preview field on the project detail (preview == public): which
// stored final-exterior keys the public page blanks.
function pretreatStickerPreviewFields(project) {
  if (project?.project_type !== 'pre_treatment_termite_certificate') {
    return { final_exterior_screened_keys: [] };
  }
  return { final_exterior_screened_keys: failingFinalExteriorKeys(project.findings) };
}

// Update-path check on what the save leaves stored: runs only when the
// findings or the project date change, against `current` (the pre-lock
// snapshot, then the locked row).
function finalExteriorRejectionForUpdate(project, updates, current) {
  if (updates.findings === undefined && updates.project_date === undefined) return null;
  return finalExteriorRejection(
    project.project_type,
    updates.findings !== undefined ? updates.findings : current.findings,
    updates.project_date !== undefined ? updates.project_date : current.project_date,
  ) || publishedCertificateEditRejection(project, updates, current);
}

// The public link reads the live findings, so an edit to a certificate that
// already has a link must not leave a staff-send field failing that the edit
// touched (a cleared warranty, a garbage time, "No warranty" -> "None"). A
// legacy certificate that already fails keeps saving edits to OTHER fields.
function publishedCertificateEditRejection(project, updates, current) {
  if (project.project_type !== 'pre_treatment_termite_certificate' || updates.findings === undefined) return null;
  if (!(current.report_token || current.sent_at || project.report_token || project.sent_at)) return null;
  const before = normalizeFindings(current.findings);
  const after = normalizeFindings(updates.findings);
  const failing = pretreatStaffSendChecks(after, getProjectType(project.project_type))
    .filter((c) => !c.ok && String(after[c.field] ?? '') !== String(before[c.field] ?? ''));
  if (!failing.length) return null;
  return {
    error: `This certificate is already published — complete ${failing.map((c) => c.label).join('; ')} before saving.`,
    code: 'published_certificate_incomplete',
    missing: failing.map(({ key, label }) => ({ key, label })),
  };
}

// The pre-treat certificate as it went out (owner 10-23 option A on #6515):
// the new construction warranty is built from this copy, never from edits
// made after the send. Every delivered send overwrites it with what that send
// carried. Other project types, or a deploy without the column, get nothing.
function pretreatSentSnapshot(project, projectCols) {
  if (project?.project_type !== 'pre_treatment_termite_certificate' || !projectCols?.pretreat_sent_snapshot) return {};
  return {
    pretreat_sent_snapshot: JSON.stringify({
      findings: normalizeFindings(project.findings),
      project_date: normalizeDateOnly(project.project_date),
      sent_at: new Date().toISOString(),
    }),
  };
}

// Send with invoice: save the copy once the report leg reached the owner,
// fenced on the send claim (a stale takeover owns the row otherwise).
// The row passed in is the post-claim re-read the send delivered.
async function savePretreatSentCopy(project, projectCols, { reportReached, claimToken }) {
  const copy = reportReached ? pretreatSentSnapshot(project, projectCols) : {};
  if (!copy.pretreat_sent_snapshot) return;
  await db('projects').where({ id: project.id, delivery_claim_token: claimToken }).update(copy);
}

// Re-judges the staff-send checks on the row as it stands after the send
// claim (an edit can land between the first read and the claim; edits are
// fenced once the row is 'sending'). Throws an operational 422; both send
// routes' catch blocks release every claim they took.
async function assertPretreatStillSendable(projectId, projectType) {
  if (projectType !== 'pre_treatment_termite_certificate') return;
  const row = await db('projects').select('findings').where({ id: projectId }).first();
  const missing = pretreatStaffSendChecks(normalizeFindings(row?.findings), getProjectType(projectType)).filter((c) => !c.ok);
  if (!missing.length) return;
  throw Object.assign(new Error(`Project report is missing required compliance details (cannot be overridden): ${missing.map((c) => c.label).join('; ')}`), {
    isOperational: true, statusCode: 422, status: 422, code: 'missing_compliance_details',
  });
}

// Create-path checks on a legal document's dates, first failure wins: the
// stored date can't be in the future, and the final exterior date must fit.
function legalDocCreateRejection(projectType, projectDate, findings) {
  if (LEGAL_DOC_DATE_TYPES.has(projectType) && projectDate > etDateString()) {
    return {
      error: `The inspection/treatment date can't be in the future (${projectDate}) — use the date the work was actually performed.`,
      code: 'project_date_in_future',
    };
  }
  return finalExteriorRejection(projectType, findings, projectDate);
}

// 422 body for a final-exterior or Bora-Care field the certificate can't
// carry, or null.
function finalExteriorRejection(projectType, rawFindings, projectDate) {
  if (projectType !== 'pre_treatment_termite_certificate') return null;
  const findings = normalizeFindings(rawFindings);
  if (pastCertificateDateProblem(findings.final_exterior_date, findings.treatment_date || projectDate)) {
    return {
      error: 'The final exterior treatment date must be a real date between the initial treatment and today — enter it after the visit is done.',
      code: 'final_exterior_date_invalid', field: 'final_exterior_date',
    };
  }
  const failingKeys = failingFinalExteriorKeys(findings);
  if (failingKeys.includes('final_exterior_time')) {
    return {
      error: 'The final exterior treatment time must be a clock time (HH:MM).',
      code: 'final_exterior_time_invalid', field: 'final_exterior_time',
    };
  }
  const [failingKey] = failingKeys;
  if (failingKey) {
    return {
      error: 'The final exterior treatment fields print on the customer notice — remove the claim or code and save again.',
      code: 'final_exterior_copy', field: failingKey,
    };
  }
  return borateRecordRejection(findings, projectDate);
}

// The Bora-Care record prints on the certificate and the warranty: the
// framing inspection is a real date no later than today, the Bora-Care
// application fits between the initial treatment and today, and the base
// plate share is a plain percent.
function borateRecordRejection(findings, projectDate) {
  if (pastCertificateDateProblem(findings.framing_inspection_date, null)) {
    return {
      error: 'The final framing inspection date must be a real date no later than today.',
      code: 'framing_inspection_date_invalid', field: 'framing_inspection_date',
    };
  }
  if (pastCertificateDateProblem(findings.borate_treatment_date, findings.treatment_date || projectDate)) {
    return {
      error: 'The Bora-Care application date must be a real date between the initial treatment and today.',
      code: 'borate_treatment_date_invalid', field: 'borate_treatment_date',
    };
  }
  if (String(findings.wood_base_plate_pct ?? '').trim() && woodBasePlatePct(findings.wood_base_plate_pct) === null) {
    return {
      error: 'Enter the wood base plates as a percent from 0 to 100, like 85.',
      code: 'wood_base_plate_pct_invalid', field: 'wood_base_plate_pct',
    };
  }
  return null;
}
// project_photos.caption is varchar(200): a longer caption would fail the
// INSERT after the image is already in S3, stranding an orphan object and
// blocking every Save retry. Clamp rather than reject — losing the tail of a
// description is recoverable; a wedged photo upload is not.
const PHOTO_CAPTION_MAX = 200;
function clampPhotoCaption(value) {
  const caption = String(value ?? '').trim();
  return caption ? caption.slice(0, PHOTO_CAPTION_MAX) : null;
}
const AI_PHOTO_LIMIT = 8;
const AI_PHOTO_MAX_BYTES = 4.5 * 1024 * 1024;
const AI_PHOTO_TOTAL_MAX_BYTES = 12 * 1024 * 1024;
const AI_SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isAdmin(req) {
  return req.techRole === 'admin';
}

// "Sent another way": which projects can be
// marked as sent outside the portal. Same "signed" test as the WDO attention
// sweep (wdo_signature IS NOT NULL); a portal send sets sent_at, so only a
// report with no portal send and no earlier mark qualifies.
const MARK_SENT_OUTSIDE_NOTE_MAX = 500;
const PROJECT_SEND_STALE_MS = 10 * 60 * 1000;

function projectDeliverySendingActive(project) {
  if (String(project?.delivery_status || '') !== 'sending') return false;
  const claimedAtMs = project?.updated_at ? new Date(project.updated_at).getTime() : NaN;
  if (!Number.isFinite(claimedAtMs)) return true;
  return Date.now() - claimedAtMs <= PROJECT_SEND_STALE_MS;
}

function addSentOutsideClaimGuard(query, project) {
  if ('sent_outside_portal_at' in project && !project.sent_outside_portal_at) {
    query.whereNull('sent_outside_portal_at');
  }
}

function markSentOutsideBlock(project) {
  if (project.project_type !== 'wdo_inspection') return { code: 'not_wdo_report', error: 'Only a WDO report can be marked as sent another way' };
  if (project.wdo_signature == null) return { code: 'not_signed', error: 'The WDO report is not signed yet' };
  if (project.sent_at || project.status === 'sent') return { code: 'already_sent', error: 'This report was already sent through the portal' };
  if (project.sent_outside_portal_at) return { code: 'already_marked', error: 'This report is already marked as sent another way' };
  if (project.report_hold_status === 'releasing') return { code: 'release_in_progress', error: 'The paid report is being sent right now. Give it a moment, then refresh.' };
  if (projectDeliverySendingActive(project)) return { code: 'send_in_progress', error: 'This report is being sent right now. Give it a moment, then refresh.' };
  return null;
}

function canMarkSentOutside(req, project) {
  return isAdmin(req) && !markSentOutsideBlock(project);
}

function canAccessProject(req, project) {
  return isAdmin(req) || String(project?.created_by_tech_id || '') === String(req.technicianId || '');
}

// Technician access: the project's creator, or the technician named on its
// service record or scheduled visit. A linked VISIT additionally has to sit
// inside the canonical current/recent window (technicianVisitRowInScope:
// not a dead status, within the access window) — a cancelled or stale visit
// grants nothing (codex #5568 r4 P1). Creator and service-record access keep
// their contract (admin-projects-guards / -routes tests pin it).
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
      .first('id', 'technician_id', 'status', 'scheduled_date');
    if (scheduled) {
      const { technicianVisitRowInScope } = require('../services/technician-visit-scope');
      // Rows always carry status + date; evaluate the window when they do.
      const windowed = scheduled.status != null || scheduled.scheduled_date != null;
      if (!windowed || technicianVisitRowInScope(req, { ...scheduled, technician_id: req.technicianId })) return true;
    }
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

// Structured-output contract for /wdo-intelligence (llm/call.js jsonSchema).
// Blank = "not supported by the facts"; normalizeWdoIntelligenceResult still
// re-checks every value (address fallback, dropdown match, photo grounding).
const WDO_INTELLIGENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestedFindings', 'propertySummary', 'confidence', 'reviewNotes'],
  properties: {
    suggestedFindings: {
      type: 'object',
      additionalProperties: false,
      required: ['property_address', 'structures_inspected', 'structure_type', 'inspection_scope', 'previous_treatment_evidence', 'previous_treatment_notes'],
      properties: {
        property_address: { type: 'string', description: 'The selected property address, or blank' },
        structures_inspected: { type: 'string', description: 'Structure list text, or blank' },
        structure_type: { type: 'string', enum: [...WDO_CONSTRUCTION_OPTIONS, ''], description: 'A dropdown value, or blank when the facts do not support one' },
        inspection_scope: { type: 'string', description: 'Short field text, or blank' },
        previous_treatment_evidence: { type: 'string', enum: ['Yes', 'No', ''] },
        previous_treatment_notes: { type: 'string', description: 'Short field text, or blank' },
      },
    },
    propertySummary: { type: 'string', description: 'One sentence about the home facts used, or blank' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reviewNotes: { type: 'array', items: { type: 'string' }, description: 'Operator review notes' },
  },
};

function buildWdoIntelligencePrompt({ customer, propertyAddress, currentFindings, propertyProfile, hasPreviousTreatmentPhoto }) {
  const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || '[not provided]';
  const existingLines = Object.entries(currentFindings || {})
    .filter(([, value]) => hasMeaningfulValue(value))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n') || '[none]';

  return `You are helping a Florida pest-control operator prefill structured fields for an FDACS-13645 WDO inspection project.

Do not write report prose. Be conservative and do not invent a detached structure, crawlspace, prior treatment, organism, damage, or inaccessible area unless the input supports it.

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

Also give a one-sentence propertySummary of the home facts you used (or blank), your confidence, and any operator review notes.`;
}

async function analyzeWdoProjectIntelligence({ customer, propertyAddress, currentFindings = {}, previousTreatmentPhoto = null }) {
  let propertyProfile = null;

  if (propertyAddress) {
    try {
      propertyProfile = await lookupPropertyFromAITrio(propertyAddress);
    } catch (err) {
      logger.warn(`[projects] WDO property lookup failed: ${err.message}`);
    }
  }

  const prompt = buildWdoIntelligencePrompt({
      customer,
      propertyAddress,
      currentFindings,
      propertyProfile,
      hasPreviousTreatmentPhoto: Boolean(previousTreatmentPhoto),
    });
  const images = previousTreatmentPhoto ? [{
    data: previousTreatmentPhoto.buffer.toString('base64'),
    mimeType: previousTreatmentPhoto.mediaType,
  }] : [];
  const policy = previousTreatmentPhoto
    ? MODELS.TEXT_POLICIES.visionAnalysis
    : MODELS.TEXT_POLICIES.contentDraft;
  const msg = await dispatchWithFallback(policy, {
    laneId: 'wdo_project_brief',
    text: prompt,
    images,
    maxTokens: 900,
    jsonMode: true,
    jsonSchema: WDO_INTELLIGENCE_SCHEMA,
  });

  if (!msg.ok || !msg.json) {
    const err = new Error('AI returned an unreadable WDO prefill response');
    err.status = 502;
    throw err;
  }
  const normalized = normalizeWdoIntelligenceResult(msg.json, propertyAddress, {
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

// --- Previous-treatment photo extraction (WDO Section 3) -------------------
// Reads ONE field photo — typically a prior company's treatment sticker or
// notice on the electrical panel (company name, dates, materials, organism,
// often handwritten), or physical evidence like drill holes / bait stations —
// and transcribes it into the previous-treatment fields. Unlike
// /wdo-intelligence this deliberately skips the (slow, web-search) property
// lookup: it is the point-the-camera-at-the-sticker fast path.

function buildWdoTreatmentPhotoPrompt(propertyAddress) {
  return `You are reading a field photo taken during a Florida FDACS-13645 WDO (wood-destroying organism) inspection${propertyAddress ? ` at ${propertyAddress}` : ''}. The photo may show evidence of PREVIOUS WDO treatment: a termite-protection or treatment sticker/notice from a prior pest-control company (often affixed to the electrical panel, water heater, or a garage wall), drill holes in the slab or foundation, bait-station covers, patched drill marks, trench lines, or an old treatment tag.

Return JSON only. Transcribe, don't invent: only report company names, dates, products, and organisms you can actually read in the photo. Handwriting is common on these stickers — transcribe it carefully and write "[illegible]" for any part you cannot read with confidence. Transcribe dates exactly as written (do not expand two-digit years).

Fields:
- previous_treatment_evidence: "Yes" only if the photo clearly shows prior-treatment evidence (sticker, notice, tag, drill holes, bait stations). "No" only if the photo clearly shows a relevant area with no treatment indicators. Leave blank if the photo is unclear or unrelated.
- previous_treatment_notes: 1-4 short sentences written for the report's "Previous treatment observations" field. If a sticker or notice is present, state what it is, the company, where it appears if identifiable, and every legible detail: date of WDO inspection, date(s) of treatment, materials/products used, organism treated for, and any lot or permit number. If only physical evidence is visible, describe it and its location. Do not speculate beyond what is visible.

Give suggestedFindings (previous_treatment_evidence as "Yes", "No", or blank; previous_treatment_notes as the field text or blank), your confidence (high, medium, or low), and any operator reviewNotes.`;
}

function normalizeWdoTreatmentPhotoResult(raw) {
  const suggested = raw?.suggestedFindings || raw?.findings || {};
  const evidence = cleanOneLine(suggested.previous_treatment_evidence || '', 20);
  return {
    suggestedFindings: {
      previous_treatment_evidence: /^yes$/i.test(evidence) ? 'Yes' : /^no$/i.test(evidence) ? 'No' : '',
      previous_treatment_notes: cleanMultiline(suggested.previous_treatment_notes, 1200),
    },
    confidence: ['high', 'medium', 'low'].includes(String(raw?.confidence || '').toLowerCase())
      ? String(raw.confidence).toLowerCase()
      : 'low',
    reviewNotes: Array.isArray(raw?.reviewNotes || raw?.review_notes)
      ? (raw.reviewNotes || raw.review_notes).map((item) => cleanOneLine(item, 260)).filter(Boolean).slice(0, 4)
      : [],
  };
}

// Structured-output contract for the treatment-photo read (llm/call.js
// jsonSchema). normalizeWdoTreatmentPhotoResult still decides what is kept.
const WDO_TREATMENT_PHOTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestedFindings', 'confidence', 'reviewNotes'],
  properties: {
    suggestedFindings: {
      type: 'object',
      additionalProperties: false,
      required: ['previous_treatment_evidence', 'previous_treatment_notes'],
      properties: {
        previous_treatment_evidence: { type: 'string', enum: ['Yes', 'No', ''] },
        previous_treatment_notes: { type: 'string' },
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reviewNotes: { type: 'array', items: { type: 'string' } },
  },
};

async function extractWdoTreatmentPhoto({ photo, propertyAddress }) {
  // VISION first, OpenAI Terra on a miss — the same policy the WDO brief
  // rides when a photo is attached.
  const msg = await dispatchWithFallback(MODELS.TEXT_POLICIES.visionAnalysis, {
    laneId: 'wdo_project_brief',
    text: buildWdoTreatmentPhotoPrompt(propertyAddress),
    images: [{ data: photo.buffer.toString('base64'), mimeType: photo.mediaType }],
    jsonMode: true,
    jsonSchema: WDO_TREATMENT_PHOTO_SCHEMA,
    maxTokens: 700,
  });
  if (!msg.ok || !msg.json) {
    const err = new Error('AI returned an unreadable treatment-photo response');
    err.status = 502;
    throw err;
  }
  return normalizeWdoTreatmentPhotoResult(msg.json);
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

// Additional per-product applications on the pre-treatment certificate
// (findings.additional_applications). Rows the tech added but never filled
// in are ignored — they don't render and don't block the send.
function certAdditionalApplications(findings) {
  const rows = Array.isArray(findings?.additional_applications) ? findings.additional_applications : [];
  return rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)
    && Object.values(row).some(hasMeaningfulValue));
}

// Per-application completeness checks for the pre-treatment certificate.
// Runs once over the flat primary-application keys (the original cert_*
// keys/labels) and once per additional application row.
function certApplicationChecks(app, { keyPrefix, labelPrefix }) {
  // "Other" is gone from both pickers, so it can no longer be SELECTED
  // (product_name is a free-text search, so the literal string is still
  // typeable like any other junk value — it fails this check rather than
  // passing silently, which is more than an arbitrary typo gets).
  // These two lines are main's, unchanged, and deliberately so: they decide
  // whether ALREADY-STORED records may still be sent, and tightening them
  // retroactively broke paid customers. Whether legacy "Other" records should
  // be re-gated is a business decision about issued compliance documents, not
  // a side effect of deleting two form inputs; it needs its own change with a
  // record count.
  const productName = app.product_name === 'Other' ? app.product_name_other : app.product_name;
  const rawMethod = app.treatment_method;
  const method = rawMethod === 'Other' ? app.treatment_method_other : rawMethod;
  // Coverage requirements vary by application method. Liquid soil barriers
  // (chemical) are sized by gallons of finished solution applied across a
  // measured area. Wood treatments (borate) are measured by treated area
  // but volume varies by saturation. Bait systems install discrete stations
  // around a perimeter — there is no "gallons applied." Gate the gallons
  // check accordingly so the send flow doesn't 422 on bait-system jobs.
  const isBaitSystem = rawMethod === 'Bait system';
  const isWoodTreatment = rawMethod === 'Wood treatment (borate)';
  const needsGallons = !isBaitSystem && !isWoodTreatment;
  // A finished-solution concentration only exists for liquid soil barriers.
  // Bait stations and direct wood treatments have no dilution to record —
  // the create form deliberately leaves concentration_pct blank for them,
  // so requiring it here would dead-end those certificates at send.
  const needsConcentration = needsGallons;
  const hasArea = hasMeaningfulValue(app.square_footage) || hasMeaningfulValue(app.linear_feet);
  const coverageOk = needsGallons
    ? hasArea && hasMeaningfulValue(app.gallons_applied)
    : hasArea;
  const coverageLabel = needsGallons
    ? 'Coverage (sq ft or linear ft + gallons applied)'
    : 'Coverage (sq ft or linear ft)';
  return [
    { key: `${keyPrefix}treatment_method`, label: `${labelPrefix}Method of treatment`, ok: hasMeaningfulValue(method) },
    { key: `${keyPrefix}product`, label: `${labelPrefix}Product used`, ok: hasMeaningfulValue(productName) },
    {
      key: `${keyPrefix}active_ingredient`,
      label: `${labelPrefix}${needsConcentration ? 'Active ingredient + concentration' : 'Active ingredient'}`,
      ok: hasMeaningfulValue(app.active_ingredient)
        && (!needsConcentration || hasMeaningfulValue(app.concentration_pct)),
    },
    { key: `${keyPrefix}coverage`, label: `${labelPrefix}${coverageLabel}`, ok: coverageOk },
  ];
}

// Rule 5E-14.105(3) F.A.C.: a pre-construction treatment for a new building
// carries a retreatment warranty (at least 1 year, renewable 4 more); only
// work attached to an existing building is exempt (owner 2026-10-23, "follow
// the law"). Only the form's own choices pass, so a legacy "No warranty" or a
// free-text value written through the update route does not.
function pretreatWarrantyOk(value, typeCfg) {
  const field = (typeCfg?.findingsFields || []).find((item) => item.key === 'warranty_type');
  return (field?.options || []).includes(String(value || '').trim());
}

// Checks added 2026-10-23 run only on a staff send (/send, /send-with-invoice)
// (see the note in certApplicationChecks). The final exterior fields are not here: they fill
// the notice's reference blank, and the later visit's full FBC 105.10 record
// (area, concentration, gallons) is its own certificate.
function pretreatStaffSendChecks(findings, typeCfg) {
  return [
    { key: 'cert_warranty', field: 'warranty_type', label: 'Warranty / retreatment bond (a new building needs a warranty; "No warranty" is only for an addition)', ok: pretreatWarrantyOk(findings.warranty_type, typeCfg), hard: true },
    // FBC 105.10 lists the time and date of the treatment.
    { key: 'cert_treatment_time', field: 'treatment_time', label: 'Time of treatment', ok: isClockTime(findings.treatment_time), hard: true },
  ];
}

function evaluateProjectSendReadiness({ project, customer, staffSend = false }) {
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
    required.push(
      { key: 'cert_treatment_address', label: 'Treatment address (or lot/block)', ok: hasMeaningfulValue(findings.treatment_address) || hasMeaningfulValue(findings.lot_block) },
      { key: 'cert_treatment_date', label: 'Date of treatment', ok: hasMeaningfulValue(findings.treatment_date) || hasMeaningfulValue(project?.project_date) },
      ...certApplicationChecks(findings, { keyPrefix: 'cert_', labelPrefix: '' }),
      // A combined job (e.g. soil barrier + wood treatment) records each
      // extra product as its own application row — every row with content
      // must be as complete as the primary before the certificate can send.
      ...certAdditionalApplications(findings).flatMap((row, index) => certApplicationChecks(row, {
        keyPrefix: `cert_app${index + 2}_`,
        labelPrefix: `Application ${index + 2}: `,
      })),
      { key: 'cert_applicator_name', label: "Applicator's printed name", ok: hasMeaningfulValue(findings.applicator_name) },
      { key: 'cert_applicator_fdacs_id', label: 'Applicator FDACS ID #', ok: hasMeaningfulValue(findings.applicator_fdacs_id) },
      // Applicator attestation satisfies the FBC 1816.1 / R318.1 authorized-signature
      // requirement when paired with the typed name + FDACS ID + date.
      { key: 'cert_applicator_attestation', label: 'Applicator attestation (electronic signature)', ok: hasMeaningfulValue(findings.applicator_attestation) },
    );
    required.push(...(staffSend ? pretreatStaffSendChecks(findings, typeCfg) : []));
  }

  // Termite Phase-3 compliance content (Codex P1 r2 on #2703): the termite
  // lanes still route through this project flow (project_required in the
  // completion-lane registry), which never runs validateTypedFindings — so
  // the send gate must enforce the same FS 482.226 / FAC 5E-14 content the
  // typed path enforces, or the project path stays a bypass. Method lists
  // are shared with the typed validator (project-types.js).
  // `hard: true` keeps these out of the override_reason escape (Codex P1
  // r3): an admin can override a thin narrative, not a statutory omission.
  if (project?.project_type === 'termite_inspection') {
    required.push(
      { key: 'ti_areas_not_inspected', label: 'Areas not inspected / why ("None" if all visible areas were inspected)', ok: hasMeaningfulValue(findings.areas_not_inspected), hard: true },
      // FS 482.226 wants the report to state the notice WAS affixed — 'No'
      // blocks the send just like the typed path.
      { key: 'ti_inspection_notice_affixed', label: 'Inspection notice affixed ("Yes" required)', ok: String(findings.inspection_notice_affixed || '') === 'Yes', hard: true },
    );
  }

  if (project?.project_type === 'termite_treatment') {
    const method = String(findings.treatment_method || '');
    // The method itself must be recorded before the method-conditional
    // requirements can mean anything — a blank method would silently skip
    // the % solution rule and soften the posted-notice rule (Codex P1 r3).
    required.push(
      { key: 'tt_treatment_method', label: 'Treatment method', ok: hasMeaningfulValue(method), hard: true },
      { key: 'tt_epa_registration', label: 'EPA reg. no.', ok: hasMeaningfulValue(findings.epa_registration), hard: true },
      {
        key: 'tt_posted_notice',
        label: TERMITE_PERIMETER_METHODS.includes(method)
          ? 'Posted notice placed ("Yes" required for exterior/perimeter applications)'
          : 'Posted notice placed',
        ok: TERMITE_PERIMETER_METHODS.includes(method)
          ? String(findings.posted_notice || '') === 'Yes'
          : hasMeaningfulValue(findings.posted_notice),
        hard: true,
      },
    );
    if (TERMITE_LIQUID_DILUTION_METHODS.includes(method)) {
      required.push({ key: 'tt_percent_solution', label: '% solution', ok: hasMeaningfulValue(findings.percent_solution), hard: true });
    }
  }

  return {
    required,
    missing: required.filter(item => !item.ok).map(({ key, label }) => ({ key, label })),
    // Compliance blockers that a send override_reason must NOT bypass.
    hardMissing: required.filter(item => !item.ok && item.hard).map(({ key, label }) => ({ key, label })),
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
      .first('id', 'customer_id', 'technician_id', 'status', 'scheduled_date');
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
    // A cancelled, rescheduled or out-of-window visit no longer authorizes a
    // new project: creation stamps created_by_tech_id, which grants lasting
    // access (codex #5568 r8 P1). Same predicate as hasProjectAccess.
    if (String(scheduled.technician_id || '') === String(req.technicianId || '')
      && technicianVisitRowInScope({ techRole: 'technician', technicianId: req.technicianId }, scheduled)) linkedAssignedToTech = true;
  }

  if (!isAdmin(req) && !linkedAssignedToTech) {
    const err = new Error('Technician projects must be linked to an assigned visit');
    err.status = 403;
    throw err;
  }

  return customer;
}

// Locked revalidation at the write boundary (codex #5568 r14 P1). The scope
// check in validateProjectCreateScope runs on unlocked reads well before the
// insert (profile resolution, duplicate lookup in between), so a reassignment
// or cancellation landing in that gap would still let the former technician
// mint a project (and with it created_by_tech_id access). Inside the insert
// transaction this locks the linked scheduled_services row FOR UPDATE and
// re-judges the SAME authorization: the visit row in scope for this technician
// (technicianVisitRowInScope), or the linked service record assigned to them
// (the other path validateProjectCreateScope accepts, unchanged). Any non-admin
// role is judged as a technician, as validateProjectCreateScope does.
async function assertTechnicianProjectLinkStillAssigned(trx, req, { service_record_id, scheduled_service_id }) {
  if (isAdmin(req)) return;
  const refuse = () => {
    const err = new Error('Technician projects must be linked to an assigned visit');
    err.status = 403;
    throw err;
  };
  const actor = { techRole: 'technician', technicianId: req.technicianId };
  if (scheduled_service_id) {
    const scheduled = await trx('scheduled_services')
      .where({ id: scheduled_service_id })
      .forUpdate()
      .first('id', 'customer_id', 'technician_id', 'status', 'scheduled_date');
    if (scheduled
      && String(scheduled.technician_id || '') === String(req.technicianId || '')
      && technicianVisitRowInScope(actor, scheduled)) return;
    // A linked visit decides on its own (codex #5568 r16 P1): a record whose
    // visit was reassigned, cancelled or aged out of the window must not
    // authorize through the record's technician_id. The record-only fallback
    // below is for a record with no linked visit at all.
    refuse();
  }
  if (service_record_id) {
    const service = await trx('service_records')
      .where({ id: service_record_id })
      .first('id', 'technician_id');
    if (service && String(service.technician_id || '') === String(req.technicianId || '')) return;
  }
  refuse();
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
  if (!photos.length) return { photoLines: '[no photos attached]', images: [] };
  if (!config.s3?.bucket) return { photoLines: '[photo review unavailable: S3 not configured]', images: [] };
  const images = [];
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
      photoLines.push(`Photo ${images.length + 1}: ${label}`);
      images.push({ data: buffer.toString('base64'), mimeType: mediaType });
      totalBytes += buffer.length;
    } catch (err) {
      logger.warn(`[projects] ai photo skipped ${ph.id}: ${err.message}`);
      photoLines.push(`Photo skipped: ${label}`);
    }
  }
  return {
    photoLines: photoLines.length ? photoLines.join('\n') : '[no photos attached]',
    images,
  };
}

// F1 (universal one-time services, ratified Q13): the comms context now
// comes from the shared WINDOWED builder in
// services/completion-comms-context (recurring = since last completed
// visit of the line, cap 120d; one-time = since job origin, cap 180d).
// The legacy unbounded builder and its helpers were retired with it.
const { buildCompletionCommsContext } = require('../services/completion-comms-context');

// Array findings (certificate application rows) flatten to readable
// "key: value" rows — String() on an object would feed the writer
// "[object Object]".
function formatFindingForPrompt(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item && typeof item === 'object'
        ? Object.entries(item)
          .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
          .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
          .join(', ')
        : String(item ?? '')))
      .filter((line) => line.trim() !== '')
      .join(' | ');
  }
  return String(value ?? '');
}

function buildProjectReportPrompt({ typeCfg, findings, rawRecommendations, customer, tech, projectDate, photoLines, communicationContext, archivedFeeValues = [] }) {
  const labelMap = Object.fromEntries((typeCfg.findingsFields || []).map(f => [f.key, f.label]));
  // Internal keys (inspection_fee) must never reach the model — the drafted
  // narrative is returned verbatim as customer-facing `recommendations`.
  // Stripping the structured findings keeps the fee out of the prompt, and
  // sanitizing rawRecommendations keeps it out of the free-text input: both
  // AI-write endpoints default that input to the editable recommendations
  // field, so an admin note or edit like "Inspection fee $250" would otherwise
  // reach the model and yield a new customer-facing narrative containing it
  // (codex #2817 P2). redactInspectionFeeCues removes only fee language, never
  // a legitimate estimate. Gated on the type config: only a type carrying the
  // internal fee field (WDO) gets its free text scrubbed.
  const typeCarriesFee = projectTypeConfigHasInternalFindingKeys(typeCfg);
  // Two passes on every free-text prompt input: the literal-cue scrub, plus
  // the VALUE scrub with the fee this project actually recorded — customer
  // text can mention the amount without the words "inspection fee" ("buyer
  // asked whether the $250 charge is due"), and once the model paraphrases
  // it the downstream cue guards can no longer recognize it (codex #2817).
  let parsedFindingsForFee = findings;
  if (typeof parsedFindingsForFee === 'string') {
    try { parsedFindingsForFee = JSON.parse(parsedFindingsForFee); } catch { parsedFindingsForFee = null; }
  }
  // Resolved like every other scrub site: an absent/blank/digit-free fee
  // bills at the flat default, so the default must join the scrub targets
  // here too — "buyer asked about the $250 charge" has no literal cue and
  // would otherwise reach the model. Archived filing snapshot fees (passed
  // by the on-project endpoint; the pre-save preview has none) join for the
  // same reason: a legacy note can quote an older filed fee (codex #2817).
  const recordedFeeValues = typeCarriesFee
    ? resolveFeeValuesForScrub([
      parsedFindingsForFee?.inspection_fee ?? '',
      ...archivedFeeValues,
    ])
    : [];
  const scrubPromptInput = (text) => {
    if (!typeCarriesFee) return text;
    let safe = redactInspectionFeeCues(text);
    if (recordedFeeValues.length) safe = redactSpecificAmounts(safe, recordedFeeValues);
    return safe;
  };
  const safeRawRecommendations = scrubPromptInput(rawRecommendations);
  const safeCommunicationContext = scrubPromptInput(communicationContext);
  const safePhotoLines = scrubPromptInput(photoLines);
  const findingsLines = Object.entries(stripInternalFindingKeys(findings, {
    redactValues: typeCarriesFee,
    feeValues: recordedFeeValues,
    freeTextKeys: projectTypeConfigFreeTextKeys(typeCfg),
  }) || {})
    .map(([k, v]) => [k, formatFindingForPrompt(v)])
    .filter(([, v]) => v.trim() !== '')
    .map(([k, v]) => `${labelMap[k] || k.replace(/_/g, ' ')}: ${v}`)
    .join('\n') || '[no structured findings captured]';

  return `# PROJECT REPORT WRITER — SYSTEM PROMPT v1

## CONTEXT

This generates customer-facing narrative copy for a Waves Pest Control inspection / documentation report. The report is a branded PDF + web page delivered to the customer after a field visit.

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
${safeRawRecommendations || '[none provided]'}

Attached photo review:
${safePhotoLines || '[no photos attached]'}

Recent customer communication context:
${safeCommunicationContext || '[none provided]'}

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

async function draftProjectReport({ typeCfg, findings, rawRecommendations, customer, tech, projectDate, photos = [], communicationContext = '', archivedFeeValues = [] }) {
  const { photoLines, images } = await buildAiPhotoInputs(photos);
  const prompt = buildProjectReportPrompt({
    typeCfg,
    findings,
    rawRecommendations,
    customer,
    tech,
    projectDate,
    photoLines,
    communicationContext,
    archivedFeeValues,
  });
  const result = await dispatchWithFallback(MODELS.TEXT_POLICIES.report, {
    laneId: 'project_report',
    text: prompt,
    images,
    jsonMode: false,
    maxTokens: 1200,
  });
  if (!result.ok || !String(result.text || '').trim()) throw new Error('Project report AI providers unavailable');
  return result.text;
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
    types[key] = {
      ...PROJECT_TYPES[key],
      appointmentManaged: managed.has(key),
      linkedCreationOnly: PROJECT_CREATION_LINKED_ONLY_TYPES.has(key),
    };
  }
  res.json({ types, keys: PROJECT_TYPE_KEYS, appointmentManaged: Array.from(managed) });
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/service-search — tech-safe service title picker
// ---------------------------------------------------------------------------
const SERVICE_TITLE_FIELDS = ['id', 'service_key', 'name', 'category', 'billing_type', 'default_duration_minutes'];
function pickServiceTitleFields(service) {
  return Object.fromEntries(SERVICE_TITLE_FIELDS.filter((field) => service[field] !== undefined).map((field) => [field, service[field]]));
}

router.get('/service-search', async (req, res, next) => {
  try {
    const { search, limit = 10 } = req.query;
    const result = await serviceLibrary.getServices({
      search,
      isActive: 'true',
      limit: Math.min(Number(limit) || 10, 25),
    });
    // The title picker reads a name and the line under it (category, billing
    // type, duration). A technician gets only those: the full catalog row
    // carries typical_materials_cost, internal_notes and prices, and material
    // cost next to price shows the margin (technician visibility audit A9).
    if (req.techRole !== 'admin') {
      return res.json({ ...result, services: (result.services || []).map(pickServiceTitleFields) });
    }
    res.json(result);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/applicators — licensed-applicator picker for the
// pre-treatment certificate. Tech-reachable (the timetracking tech route
// sanitizes license fields away, so the create form needs its own source).
// License numbers print on the public certificate, so exposing them to a
// logged-in tech is not a data leak.
// ---------------------------------------------------------------------------
router.get('/applicators', async (req, res, next) => {
  try {
    const techs = await db('technicians')
      .where({ active: true })
      .orderBy('name')
      .select('id', 'name', 'applicator_printed_name', 'fl_applicator_license', 'license_expiry');
    const todayEt = etDateString();
    res.json({
      applicators: techs.map((t) => {
        // Same expiry rule as admin-compliance-v2 (past = expired, no expiry
        // on file = active), but compared as ET calendar dates: the license
        // is good through the end of its expiry day, and a date-only column
        // must not flip early because UTC midnight lands at 8pm ET. An
        // expired number is withheld (never auto-filled onto a state
        // compliance certificate) — the tech stays pickable by name and
        // types their renewed number.
        const expiryDate = normalizeDateOnly(t.license_expiry);
        const expired = Boolean(expiryDate && expiryDate < todayEt);
        return {
          id: t.id,
          // Certificates print the applicator's FULL legal name — the
          // dedicated printed-name column wins over the casual display name
          // used across customer comms.
          name: String(t.applicator_printed_name || '').trim() || t.name,
          // The display name certificates saved BEFORE the printed-name
          // column existed — the create form matches stored drafts against
          // it and upgrades them to the printed name.
          legacyName: t.name,
          fdacsId: expired ? null : (String(t.fl_applicator_license || '').trim() || null),
        };
      }),
      // Admins create certificates on behalf of the treating tech, so only a
      // tech's own session defaults the applicator to themselves.
      defaultTechnicianId: isAdmin(req) ? null : req.technicianId || null,
    });
  } catch (err) { next(err); }
});

function parseDefaultProductNames(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = parsed.split(','); }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item || '').trim()).filter(Boolean);
}

function pretreatMethodForPlannedProduct(productName, serviceLabel = '') {
  const value = `${productName || ''} ${serviceLabel || ''}`.toLowerCase();
  if (/bora[- ]?care|borate|wood treatment/.test(value)) return 'Wood treatment (borate)';
  if (/trelona|sentricon|bait/.test(value)) return 'Bait system';
  return 'Soil barrier (chemical)';
}

// GET /api/admin/projects/scheduled-service/:id/application-prefill
// The certificate is post-service paperwork, so its application rows begin
// with the products already planned by the appointment's primary service and
// add-on lines. They remain editable because the applicator must record what
// was actually used, not blindly certify the schedule's plan.
router.get('/scheduled-service/:id/application-prefill', async (req, res, next) => {
  try {
    const scheduled = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'service_id', 'service_type', 'status', 'scheduled_date');
    if (!scheduled) return res.status(404).json({ error: 'Scheduled service not found' });
    // Canonical current-visit predicate (codex #5568 r16 P2): a bare
    // technician_id compare kept a cancelled or long-past visit readable.
    // Any non-admin role is judged as a technician.
    if (!isAdmin(req)
      && !technicianVisitRowInScope({ techRole: 'technician', technicianId: req.technicianId }, scheduled)) {
      return res.status(403).json({ error: 'Scheduled service access denied' });
    }

    const addonRows = await db('scheduled_service_addons')
      .where({ scheduled_service_id: scheduled.id })
      .orderBy('created_at', 'asc')
      .select('service_id', 'service_name')
      .catch(() => []);
    const serviceIds = [scheduled.service_id, ...addonRows.map((row) => row.service_id)].filter(Boolean);
    const libraryRows = serviceIds.length
      ? await db('services').whereIn('id', serviceIds).select('id', 'name', 'default_products')
      : [];
    const libraryById = new Map(libraryRows.map((row) => [String(row.id), row]));
    const serviceLines = [
      {
        serviceId: scheduled.service_id,
        label: libraryById.get(String(scheduled.service_id || ''))?.name || scheduled.service_type || 'Scheduled service',
      },
      ...addonRows.map((row) => ({
        serviceId: row.service_id,
        label: libraryById.get(String(row.service_id || ''))?.name || row.service_name || 'Scheduled add-on',
      })),
    ];
    const planned = serviceLines.flatMap((line) => {
      const library = libraryById.get(String(line.serviceId || ''));
      return parseDefaultProductNames(library?.default_products).map((productName) => ({
        productName,
        serviceLabel: line.label,
      }));
    });
    const productNames = [...new Set(planned.map((row) => row.productName))];
    // Active catalog rows only, as the job card and the completion defaults read them: a retired row can share a live row's
    // name (two "Tekko Pro IGR" rows, the inactive one another EPA registration), and the record would carry its EPA number.
    const productRows = productNames.length
      ? await db('products_catalog').whereIn('name', productNames)
        .where(function activeProducts() { this.where({ active: true }).orWhereNull('active'); })
        .select('*').catch(() => [])
      : [];
    const productByName = new Map(productRows.map((row) => [String(row.name || '').toLowerCase(), row]));
    const applications = planned.map((row) => {
      const product = productByName.get(row.productName.toLowerCase()) || {};
      return {
        _scheduled_service_label: row.serviceLabel,
        treatment_method: pretreatMethodForPlannedProduct(row.productName, row.serviceLabel),
        product_name: row.productName,
        epa_registration: product.epa_reg_number || product.epa_registration_number || '',
        active_ingredient: product.active_ingredient || '',
      };
    });

    return res.json({ applications, source: 'scheduled_service' });
  } catch (err) { return next(err); }
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
          // A project-linked visit authorizes only while it is current
          // (dead statuses and the access window, as in hasProjectAccess;
          // codex #5568 r7 P1).
          .orWhere(function () {
            this.where('ssp.technician_id', req.technicianId)
              .whereNotIn('ssp.status', TECH_DEAD_ASSIGNMENT_STATUSES)
              .where('ssp.scheduled_date', '>=', techAccessCutoff());
          });
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

    // Same follow-up scoping as the public report page (shared helper) so
    // the staff preview can never show a different "Follow-up" than the
    // customer's copy — the old linked-visit-only lookup printed the just-
    // treated visit itself as its own follow-up on the service day.
    const upcomingAppointment = await findReportFollowupAppointment({
      customerId: project.customer_id,
      scheduledServiceId: project.scheduled_service_id,
    });

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

    // Applicator identity + Poison Control verdict for the customer-report
    // preview (Codex P1, 2026-09-26): the SAME shared resolver the public
    // project report uses (report-data.js), so the preview can never show a
    // different applicator or Poison Control line than the sent report —
    // the technician who actually PERFORMED the linked service, never
    // merely `tech_name` (the project's created_by_tech_id, which can be an
    // admin typing up someone else's visit), judged against the same date
    // absent a WDO filing (project_date, or created_at when blank).
    const previewFields = await resolveProjectReportPreviewFields(
      project, project.project_date || project.created_at, db,
    ).catch(() => ({ applicatorFdacsId: null, applicatorName: null, poisonControl: false }));
    const applicator_fdacs_id = previewFields.applicatorFdacsId;
    const applicator_name = previewFields.applicatorName;
    const poison_control = previewFields.poisonControl;

    res.json({
      project: {
        ...project,
        applicator_fdacs_id,
        applicator_name,
        poison_control,
        wdo_signature: wdoSignature,
        // Server-computed: gate on, admin viewer, signed, no portal send, not yet marked.
        canMarkSentOutside: canMarkSentOutside(req, project),
        // Heavy archive index (carries as-sent findings snapshots) — the UI
        // lists filings via GET /:id/wdo-filings instead.
        wdo_sent_filings: undefined,
        wdo_sent_filings_count: loadWdoFilings(project).length,
        // The archive index is stripped above, but the customer preview must
        // scrub against archived snapshot fees exactly like the public /data
        // serializer — a previously filed report can quote an older fee than
        // the current editable field, and preview == public has to hold for
        // it. Only the derived fee values ride the payload (codex #2817).
        wdo_archived_fee_values: projectTypeHasInternalFindingKeys(project.project_type)
          ? projectArchivedFeeValues(project)
          : [],
        // Same computation as the public report page's fdacsPdfAvailable —
        // the customer-preview needs it to mirror the page's WDO findings
        // suppression rule (the raw archive index is stripped above).
        // Includes the legacy-binary fee gate so staff never see a filing
        // advertised that the customer page withholds (codex #2817).
        fdacs_pdf_available: (() => {
          const filings = loadWdoFilings(project);
          const lastFiling = filings.length ? filings[filings.length - 1] : null;
          return Boolean(lastFiling?.s3_key && config.s3?.bucket)
            && !filingBinaryMayDiscloseFee(lastFiling);
        })(),
        ...pretreatStickerPreviewFields(project),
        property_profile: propertyProfile,
        wdo_history: wdoHistory,
        wdo_applicator: wdoApplicator,
        customer_name: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
        report_url: project.report_token ? await projectReportPathForProject(db, project, project) : null,
        ...(await heldInvoiceStatusKeys(project)),
        // Drives the "Invoice now, report after payment" choice in the drawer. The report_hold_* columns ride on ...project.
        ...(wdoReportHoldLive() ? {
          report_payment_hold_available: project.project_type === 'wdo_inspection'
            && !reportLinkShared(project),
        } : {}),
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
    // Owner ruling 2026-07-13: WDO + pre-treat certs are never done without a
    // scheduled visit, so ad-hoc/unlinked creation closes, and the link must
    // be THE compliance visit itself — either the linked profile's pointer
    // matches, or (legacy rows with no service_id, whose name-based profile
    // resolution finds nothing — Codex r2) the visit's own service text
    // matches the compliance service. A random lawn/pest visit must not
    // carry a WDO/cert create (Codex r3). Typed visits already 422'd above
    // as scheduled_service_appointment_managed; the completion machinery
    // (FDACS signature/PDF/filing) is unchanged.
    if (PROJECT_CREATION_LINKED_ONLY_TYPES.has(project_type)) {
      if (!linkedScheduledServiceId) {
        return res.status(422).json({
          error: 'WDO and pre-treat certificate reports are created from their scheduled visit — open the appointment in Dispatch or the tech portal and create the report there.',
          code: 'project_type_linked_only',
        });
      }
      if (!linkedProjectTypeMatches) {
        const linkedVisit = await db('scheduled_services')
          .where({ id: linkedScheduledServiceId })
          .first('service_type');
        const label = String(linkedVisit?.service_type || '');
        const legacyLabelMatches = project_type === 'wdo_inspection'
          ? /\bwdo\b|wood[\s-]?destroying/i.test(label)
          : /pre[\s-]?treat|slab/i.test(label);
        if (!legacyLabelMatches) {
          return res.status(422).json({
            error: 'The linked appointment is not a WDO / pre-treat visit — open the report from the compliance visit it documents.',
            code: 'project_type_link_mismatch',
          });
        }
      }
    }
    await validateProjectCreateScope(req, { customer_id, service_record_id, scheduled_service_id });
    const projectDate = await resolveProjectDate({ project_date, service_record_id, scheduled_service_id });

    // A WDO / pre-treat certificate is a legal document dated the day the
    // inspection/treatment actually happened — a future date can't be attested.
    // A typo'd future date has already shipped on a signed prod filing
    // (2027-03-13 for a 2026 inspection), so reject rather than trust.
    // The final exterior date is judged against the date actually stored
    // (resolved from the linked visit when the body omits it).
    const createDateRejection = legalDocCreateRejection(project_type, projectDate, findings);
    if (createDateRejection) return res.status(422).json(createDateRejection);

    // One visit, one report (#2717 server hardening): stale client caches
    // (week rows, continue snapshots) repeatedly re-offered the create
    // sheet for already-linked visits, and nothing here prevented a second
    // row. This is a CONFLICT, not a silent merge (Codex P2 on #2732): the
    // submitted body may carry freshly typed findings, and returning the
    // existing row as a success would let the client discard that draft.
    // A 409 keeps the client's local draft intact (create-failure path
    // never clears it) and names the existing report to continue in.
    // Keeper preference matches migration 20260714000010: strongest report
    // first (closed > sent > draft), then oldest.
    //
    // Legacy record-only links count too (Codex round-2 P2): a project
    // created before the derived link was persisted carries
    // scheduled_service_id = NULL while its service record points at the
    // visit — the direct-column lookup (and the partial unique index)
    // would miss it and let the visit mint a second report. Migration
    // 20260714000010 backfills those rows; the join here covers any that
    // appear between deploys or in environments where the backfill was
    // guarded out.
    const existingByVisit = () => db('projects')
      .leftJoin('service_records', 'projects.service_record_id', 'service_records.id')
      .where((q) => q
        .where('projects.scheduled_service_id', linkedScheduledServiceId)
        .orWhere('service_records.scheduled_service_id', linkedScheduledServiceId))
      .orderByRaw("CASE projects.status WHEN 'closed' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END")
      .orderBy('projects.created_at', 'asc')
      .select('projects.*')
      .first();
    if (linkedScheduledServiceId) {
      const existing = await existingByVisit();
      if (existing) {
        logger.info(`[projects] create for visit ${linkedScheduledServiceId} refused — existing project ${existing.id}`);
        return res.status(409).json({
          error: 'This visit already has a report — open it to continue instead of starting a new one.',
          code: 'visit_already_reported',
          project: existing,
        });
      }
    }

    // Cue + recorded-value write scrub for the customer-facing free text —
    // no filings can exist yet, so the fee set is the incoming findings
    // resolved against the flat default (codex #2817).
    const createFeeValues = projectTypeHasInternalFindingKeys(project_type)
      ? projectRecordedFeeValues({ findings: findings || {} })
      : [];
    let row;
    try {
      row = await db.transaction(async (trx) => {
      await assertTechnicianProjectLinkStillAssigned(trx, req, { service_record_id, scheduled_service_id: linkedScheduledServiceId });
      const [inserted] = await trx('projects').insert({
        customer_id,
        project_type,
        project_date: projectDate,
        // title is customer-facing headline text — same write-time fee scrub
        // as recommendations, clamped to the varchar(200) column since the
        // scrub can lengthen text (codex #2817)
        title: title ? redactProjectTitleForWrite(title, project_type, createFeeValues) : null,
        findings: findings || null,
        // inspection fee must never be customer-facing — sanitized on WRITE
        // (durable for new rows; migration 20260717000001 cleaned legacy rows
        // at rest, codex #2817). Type-gated: only WDO carries the internal
        // fee field; on other types "inspection fee" prose is a legitimate
        // customer disclosure.
        recommendations: recommendations ? redactProjectFreeTextForWrite(recommendations, project_type, createFeeValues) : null,
        service_record_id: service_record_id || null,
        // Persist the DERIVED link too (record-only callers): the linked-only
        // gate accepted this create because the record resolved to a scheduled
        // visit, and the schedule/tech continuation path looks projects up by
        // projects.scheduled_service_id — dropping it here would let the same
        // visit mint a duplicate report (Codex round-2 P2).
        scheduled_service_id: linkedScheduledServiceId || null,
        status: 'draft',
        created_by_tech_id: req.technicianId,
      }).returning('*');
      return inserted;
      });
    } catch (insertErr) {
      // Unique-violation on the partial index (migration 20260714000010) =
      // we lost a same-visit create race — same 409 contract as the
      // pre-insert check above, naming the winner.
      if (insertErr?.code === '23505' && linkedScheduledServiceId) {
        const winner = await existingByVisit();
        if (winner) {
          logger.info(`[projects] create race for visit ${linkedScheduledServiceId} lost to existing project ${winner.id}`);
          return res.status(409).json({
            error: 'This visit already has a report — open it to continue instead of starting a new one.',
            code: 'visit_already_reported',
            project: winner,
          });
        }
      }
      throw insertErr;
    }

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
    const {
      project_type, findings, recommendations, customer_id, project_date,
      include_communications = true,
    } = req.body;
    if (!isValidProjectType(project_type)) return res.status(400).json({ error: 'Invalid project_type' });

    const typeCfg = getProjectType(project_type);
    const customer = customer_id ? await db('customers').where({ id: customer_id }).first() : null;
    const tech = req.technicianId ? await db('technicians').where({ id: req.technicianId }).first() : null;
    const previewComms = include_communications === false
      ? { text: '', promptHint: '' }
      : await buildCompletionCommsContext({
        // Preview has no job origin: the create modal posts only
        // customer/type/date, and project_date is the INSPECTION date —
        // anchoring there would filter out the pre-visit booking comms
        // this feature exists to summarize (Codex r2, reversing r1's
        // project_date suggestion). The bare 180-day cap is the honest
        // window until the project is saved with a linked booking.
        customerId: customer_id,
      }).catch(() => ({ text: '', promptHint: '' }));
    const communicationContext = previewComms.text
      ? `${previewComms.promptHint}\n${previewComms.text}`
      : '';
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
    // Two-provider policy (visionAnalysis / contentDraft): either configured
    // provider can serve this request, so only bail when NEITHER key exists —
    // an Anthropic-only guard would 400 exactly when the OpenAI failover leg
    // should be carrying the lane.
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'AI not configured' });
    }

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

// ---------------------------------------------------------------------------
// POST /api/admin/projects/wdo-treatment-photo — extract prior-treatment
// details from a single photo (a previous company's treatment sticker/notice,
// or visible evidence) into the WDO Previous Treatment fields. Photo-only
// fast path: no property lookup, one vision call.
// ---------------------------------------------------------------------------
router.post('/wdo-treatment-photo', upload.single('previous_treatment_photo'), async (req, res, next) => {
  try {
    // visionAnalysis is two-provider: only bail when NEITHER key exists (same
    // posture as /wdo-intelligence).
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'AI not configured' });
    }
    if (!req.file) return res.status(400).json({ error: 'Previous-treatment photo required' });
    if (req.file.buffer.length > AI_PHOTO_MAX_BYTES) {
      return res.status(400).json({ error: 'Prior-treatment photo is too large for AI review' });
    }
    const mediaType = validateUploadedImage(req.file);

    // Same access posture as /wdo-intelligence: an existing project scopes by
    // project access; a pre-save technician call must be linked to an
    // assigned visit; admins can extract freely.
    const customerId = req.body.customer_id || null;
    const projectId = req.body.project_id || null;
    if (projectId) {
      const project = await db('projects').where({ id: projectId }).first();
      if (!(await requireProjectAccess(req, res, project))) return;
      if (project.project_type !== 'wdo_inspection') return res.status(400).json({ error: 'Project is not a WDO inspection' });
      if (customerId && project.customer_id && String(customerId) !== String(project.customer_id)) {
        return res.status(400).json({ error: 'Customer does not belong to the selected project' });
      }
    } else if (!isAdmin(req)) {
      if (!customerId) return res.status(400).json({ error: 'Customer required for technician WDO intelligence' });
      await validateProjectCreateScope(req, {
        customer_id: customerId,
        service_record_id: req.body.service_record_id || null,
        scheduled_service_id: req.body.scheduled_service_id || null,
      });
    }

    const result = await extractWdoTreatmentPhoto({
      photo: { buffer: req.file.buffer, mediaType },
      propertyAddress: cleanOneLine(req.body.property_address, 500),
    });

    logger.info('[projects] WDO treatment-photo extraction', {
      customerId,
      projectId,
      confidence: result.confidence,
      evidence: result.suggestedFindings.previous_treatment_evidence || '(blank)',
      notesChars: result.suggestedFindings.previous_treatment_notes.length,
    });
    res.json(result);
  } catch (err) {
    logger.error(`[projects] WDO treatment-photo extraction failed: ${err.message}`);
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

// Legacy certificate drafts (created before the findings-level treatment_date
// field was removed from the registry) still carry findings.treatment_date,
// which the certificate renderer prefers over the project date. The forms now
// edit ONLY the project date, so once an editor actually CHANGES it, the
// hidden legacy value must not keep printing a stale date — drop it so the
// date the editor saw becomes the single source. An untouched legacy draft
// keeps rendering its original attested findings date. Mutates `updates`.
function dropStaleCertTreatmentDate(project, updates) {
  if (project?.project_type !== 'pre_treatment_termite_certificate') return;
  if (!hasMeaningfulValue(updates.project_date)) return;
  if (updates.project_date === normalizeDateOnly(project.project_date)) return;
  const findings = normalizeFindings(updates.findings !== undefined ? updates.findings : project.findings);
  if (!hasMeaningfulValue(findings.treatment_date)) return;
  const { treatment_date: _stale, ...rest } = findings;
  updates.findings = rest;
}

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
    // Mirror of the create-path clamp: a dated legal filing can't carry a
    // future inspection/treatment date (one already shipped in prod).
    if (updates.project_date && LEGAL_DOC_DATE_TYPES.has(project.project_type) && updates.project_date > etDateString()) {
      return res.status(422).json({
        error: `The inspection/treatment date can't be in the future (${updates.project_date}) — use the date the work was actually performed.`,
        code: 'project_date_in_future',
      });
    }
    // Durable inspection-fee guard: an admin-saved narrative/title can't
    // persist the internal fee (legacy rows cleaned at rest by migration
    // 20260717000001, codex #2817). Cue AND recorded-value passes — a
    // paraphrase without the literal cue must not be re-persisted either.
    // The fee set is what THIS save produces: incoming findings (falling
    // back to the stored row) merged with the archived filing snapshots.
    // Type-gated — see the create path.
    const writeFeeValues = projectTypeHasInternalFindingKeys(project.project_type)
      ? projectRecordedFeeValues({
        findings: updates.findings !== undefined ? updates.findings : project.findings,
        wdo_sent_filings: project.wdo_sent_filings,
      })
      : [];
    if (updates.recommendations != null) updates.recommendations = redactProjectFreeTextForWrite(updates.recommendations, project.project_type, writeFeeValues);
    if (updates.title != null) updates.title = redactProjectTitleForWrite(updates.title, project.project_type, writeFeeValues);
    dropStaleCertTreatmentDate(project, updates);
    if (Object.keys(updates).length === 0) return res.json({ project });

    // Serialized with in-flight deliveries the same way photo mutations are:
    // a findings/date edit landing while a send
    // is building would make the emailed signed PDF differ from the live
    // public report, or race the staleness bookkeeping.
    // The staleness refresh rides the SAME locked transaction, computed from
    // the LOCKED row's signature — a post-commit refresh from a refetch could
    // overwrite a concurrently saved replacement signature with the old one
    // marked stale. Best-effort within the edit (the send gates re-verify the
    // content hash themselves; only legacy pre-hash signatures rely on this
    // flag — hence the loud warn).
    let signatureStale = null;
    try {
      await db.transaction(async (trx) => {
        const locked = await lockProjectForPhotoMutation(project, trx, 'the edit', null);
        // The final exterior fields are judged here, on the LOCKED row and
        // after the legacy-date drop, so an overlapping save that moved the
        // project date or the final exterior date can't slip past.
        const lockedRejection = finalExteriorRejectionForUpdate(project, updates, locked || project);
        if (lockedRejection) throw Object.assign(new Error(lockedRejection.error), { code: 'final_exterior_rejected', body: lockedRejection });
        await trx('projects').where({ id: req.params.id }).update({ ...updates, updated_at: db.fn.now() });
        if (updates.findings !== undefined || updates.project_date !== undefined) {
          const before = locked || project;
          signatureStale = await refreshWdoSignatureStaleness(
            req,
            before,
            { ...before, ...updates, id: project.id },
            { connection: trx },
          ).catch((err) => {
            logger.warn(`[projects] WDO signature staleness update failed for ${project.id}: ${err.message}`);
            return null;
          });
        }
      });
    } catch (e) {
      if (e.code === 'send_in_progress') return res.status(409).json({ error: e.message, code: e.code });
      if (e.code === 'final_exterior_rejected') return res.status(422).json(e.body);
      throw e;
    }
    const updated = await db('projects').where({ id: req.params.id }).first();

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
    photoSetHash: sig.photo_set_hash || null,
    feeValues: Array.isArray(sig.fee_values) ? sig.fee_values : null,
    contentStale: Boolean(sig.content_stale),
  };
}

// Archive index of every FDACS PDF actually emailed (projects.wdo_sent_filings).
function loadWdoFilings(project) {
  let filings = project?.wdo_sent_filings;
  if (typeof filings === 'string') { try { filings = JSON.parse(filings); } catch { filings = []; } }
  return Array.isArray(filings) ? filings : [];
}

// Canonical hash of the content the licensee attests to: the CUSTOMER-SAFE
// findings JSON (key-order independent) plus the inspection date. The
// customer-safe transform (internal-key strip + fee-cue scrub, via
// stripInternalFindingKeys) is applied BEFORE hashing because it is also what
// the FDACS PDF renders and what the sign-time preview shows — hash, preview,
// and emitted filing all agree on one representation, so the signature
// authorizes exactly the content that is emitted (codex #2817: sanitizing
// only at render time would emit content the hash never authorized). The
// scrub is deterministic, so the hash is stable across recomputes.
// Consequence: signatures captured over the RAW representation (pre-change)
// no longer verify and force one re-sign — the safe direction.
// Captured onto the signature at sign time and recomputed at every
// send/stamp, so a signed-then-edited report can never be emitted as a
// signed FDACS-13645.
function wdoContentHash(project, feeValues = null) {
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
    // identical inputs to the PDF's customerSafeFindings — hash == render,
    // including the recorded-value pass (codex #2817)
    findings: stable(stripInternalFindingKeys(parseFindings(project), {
      redactValues: true,
      feeValues: Array.isArray(feeValues) ? feeValues : projectRecordedFeeValues(project),
      freeTextKeys: projectTypeFreeTextKeys('wdo_inspection'),
    }) || {}),
    project_date: normalizeDateOnly(project.project_date),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Send-gate view of the signature: present, and does it still match the
// content it was captured against? Legacy signatures (captured before content
// hashing) carry no hash and are honored unless a findings edit has explicitly
// flagged them stale (refreshWdoSignatureStaleness on PUT /:id).
function wdoSignatureFreshness(project, feeValues = null) {
  const signature = loadWdoSignature(project);
  if (!signature) return { signed: false, fresh: false, signature: null };
  const effectiveFeeValues = Array.isArray(feeValues) ? feeValues : signature.feeValues;
  const fresh = !signature.contentStale
    && (!signature.contentHash || signature.contentHash === wdoContentHash(project, effectiveFeeValues));
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
// `connection` lets the findings-edit path run this INSIDE its locked
// transaction with the locked row's signature — a post-commit refresh from a
// refetch could overwrite a concurrently saved replacement signature with
// the old one marked stale.
async function refreshWdoSignatureStaleness(req, before, after, { connection = db } = {}) {
  if (after.project_type !== 'wdo_inspection') return null;
  let sig = after.wdo_signature;
  if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch { sig = null; } }
  if (!sig || !sig.image) return null;
  const sigFeeValues = Array.isArray(sig.fee_values) ? sig.fee_values : null;
  const newHash = wdoContentHash(after, sigFeeValues);
  const stale = sig.content_hash
    ? sig.content_hash !== newHash
    // Legacy signature: no hash to verify a revert against, so once stale it
    // stays stale until the licensee re-signs.
    : (Boolean(sig.content_stale) || wdoContentHash(before, sigFeeValues) !== newHash);
  if (Boolean(sig.content_stale) === stale) return stale;
  await connection('projects').where({ id: after.id }).update({
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

// The signature's content hash covers findings + project_date only — the photo
// addendum (captions, categories, order, membership) is rendered LIVE into the
// FDACS PDF at send time and sits outside the hash. Any photo mutation on a
// signed WDO therefore flags the signature stale directly: the licensee
// attested a report whose photo pages just changed, and must re-sign before
// send. The flag write rides the SAME transaction as the photo mutation so a
// crash can't land the photo change while losing the stale flag. Unlike the
// findings hash, this doesn't self-heal on revert — a photo edit is a re-sign.
// Returns false (no signature / not a WDO), 'already_stale', or 'flagged'
// (newly flagged by THIS mutation — the caller logs the activity entry).
// Locks the project row for the duration of a content mutation's transaction
// (photos, findings edits, signature saves) and rejects while a send claim is
// active: a change landing between the send's freshness check and its
// render/snapshot would otherwise ride into the emailed filing unattested.
// The locked row (not the request-scope snapshot, which a concurrent
// signature save can invalidate) also feeds the staleness decision below.
// Applies to every project type — any in-flight send is rendering content it
// already validated.
// Pass columns = null to lock and return the FULL row (the findings-edit
// path needs it to compute staleness from locked state).
async function lockProjectForPhotoMutation(project, trx, what = 'the photo change', columns = ['wdo_signature', 'delivery_status', 'project_type']) {
  const query = trx('projects').where({ id: project.id }).forUpdate();
  const cols = columns ? [...new Set([...columns, 'updated_at'])] : null;
  const locked = await (cols ? query.first(...cols) : query.first());
  const sendInProgress = () => {
    const err = new Error(`This report is being sent right now — retry ${what} in a moment.`);
    err.code = 'send_in_progress';
    throw err;
  };
  // The in-flight delivery claim to respect: the shared send claim
  // (delivery_status).
  if (String(locked?.delivery_status || '') === 'sending') {
    // Mirror the send routes' 10-minute stale recovery: without it a
    // CRASHED send claim would 409 every edit/photo/signature change
    // indefinitely — the operator couldn't fix the very report that's
    // stuck. Unknown/unparseable age counts as fresh (reject) — the safe
    // direction. Recovery normalizes to 'failed', same as the send revert.
    const claimedAtMs = locked?.updated_at ? new Date(locked.updated_at).getTime() : Date.now();
    const ageMs = Date.now() - claimedAtMs;
    if (!(ageMs > 10 * 60 * 1000)) sendInProgress();
    // A crashed release gives the report back to the sweep in the same write (as the stale-claim recovery does), so
    // the edit does not keep it 'releasing' for another 10 minutes.
    const cols = await trx('projects').columnInfo();
    await trx('projects').where({ id: project.id }).update({
      delivery_status: 'failed',
      delivery_claim_token: null,
      ...(cols.report_hold_status ? {
        report_hold_status: db.raw("CASE WHEN report_hold_status = 'releasing' THEN 'held' ELSE report_hold_status END"),
        report_hold_locked_at: db.raw("CASE WHEN report_hold_status = 'releasing' THEN NULL ELSE report_hold_locked_at END"),
      } : {}),
      updated_at: db.fn.now(),
    });
  }
  return locked;
}

async function flagWdoSignatureStaleForPhotos(project, trx, lockedRow) {
  if (!project || project.project_type !== 'wdo_inspection') return false;
  let sig = lockedRow ? lockedRow.wdo_signature : null;
  if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch { sig = null; } }
  if (!sig || !sig.image) return false;
  if (sig.content_stale) return 'already_stale';
  await trx('projects').where({ id: project.id }).update({
    wdo_signature: JSON.stringify({ ...sig, content_stale: true }),
    updated_at: db.fn.now(),
  });
  return 'flagged';
}

// Activity-trail companion to flagWdoSignatureStaleForPhotos — logged AFTER
// the mutation's transaction commits (best-effort, like every activity write).
async function logWdoPhotoStaleness(req, project, changeSummary) {
  // Post-commit truth, not the request snapshot — a concurrent signature
  // save may have changed whose name belongs in the trail.
  const row = await db('projects').where({ id: project.id }).first('wdo_signature').catch(() => null);
  let sig = row ? row.wdo_signature : project.wdo_signature;
  if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch { sig = null; } }
  await logProjectActivity(
    req,
    project,
    'project_wdo_signature_stale',
    `WDO photos changed after signing (${changeSummary}) — ${sig?.signer_name || 'licensee'} must re-sign before send`,
    { signer_name: sig?.signer_name || null, photo_change: changeSummary },
  ).catch(() => {});
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

const WDO_ADDENDUM_CATEGORY_CAPTIONS = Object.freeze({
  wdo_evidence: 'Visible WDO evidence documented at the inspected property.',
  wdo_damage: 'Visible WDO damage documented at the inspected property.',
  inaccessible_area: 'Obstruction or inaccessible area documented during the inspection.',
  previous_treatment: 'Evidence of previous treatment documented at the inspected property.',
  notice: 'Inspection or treatment notice documented at the inspected property.',
  treatment_document: 'Prior treatment document reviewed during the inspection.',
  exterior: 'Exterior condition documented at the inspected structure.',
  interior: 'Interior condition documented at the inspected structure.',
  living_area: 'Living-area condition documented during the inspection.',
  kitchen: 'Kitchen-area condition documented during the inspection.',
  bathroom: 'Bathroom-area condition documented during the inspection.',
  garage: 'Garage condition documented during the inspection.',
  attic: 'Attic condition documented during the inspection.',
  crawlspace: 'Crawlspace condition documented during the inspection.',
  other: 'Site condition documented during the WDO inspection.',
});

const WDO_ADDENDUM_FINDING_DETAILS = Object.freeze({
  wdo_evidence: { keys: ['wdo_evidence', 'live_wdo'], prefix: 'Visible WDO evidence' },
  wdo_damage: { keys: ['wdo_damage'], prefix: 'Visible WDO damage' },
  inaccessible_area: { keys: ['inaccessible_areas'], prefix: 'Obstruction or inaccessible area' },
  previous_treatment: { keys: ['previous_treatment_notes'], prefix: 'Previous treatment evidence' },
  treatment_document: { keys: ['previous_treatment_notes'], prefix: 'Prior treatment document' },
  notice: { keys: ['notice_location'], prefix: 'Inspection notice location' },
});

function wdoAddendumPhotoCaption(photo = {}, project = null) {
  const typed = String(photo.caption || '').trim();
  if (typed) return typed;
  const category = String(photo.category || '').trim().toLowerCase();
  const findings = project ? parseFindings(project) : {};
  const detailConfig = WDO_ADDENDUM_FINDING_DETAILS[category];
  const detail = detailConfig?.keys
    .map((key) => String(findings[key] || '').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (detail) {
    return `${detailConfig.prefix}: ${detail}`.slice(0, 300);
  }
  if (WDO_ADDENDUM_CATEGORY_CAPTIONS[category]) {
    return WDO_ADDENDUM_CATEGORY_CAPTIONS[category];
  }
  if (category) {
    const label = category.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} documented during the WDO inspection.`;
  }
  return 'Site condition documented during the WDO inspection.';
}

// Fetch the project's photos from S3 for the PDF photo addendum, ordered the
// way the tech arranged them, normalizing each (normalizeAddendumPhoto:
// EXIF rotation baked in, bounded JPEG). When normalization can't decode the
// image, the original is used as-is if it's PNG/JPEG (pdf-lib can't embed
// anything else). Failures on individual photos are skipped so one bad object
// can't sink the whole report; anything past the count/byte budget is
// omitted (and logged).
// Extracted row loader — shared by the addendum renderer and the photo-set
// hash so the signature check covers exactly the rows the PDF will render.
function loadWdoAddendumPhotoRows(project, connection = db) {
  return connection('project_photos')
    .where({ project_id: project.id })
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'asc')
    .select('id', 's3_key', 'caption', 'category', 'visit');
}

// Hash of the photo-addendum identity the licensee attests to: membership,
// captions, categories, visit, and render order. Captured onto the signature
// at sign time (under the project lock) and re-verified at the PDF build
// choke point — the mutation-time content_stale flag is the UX signal; this
// is the gate that survives a lost-update race on the flag itself (a
// signature save that read before a photo change committed).
function wdoPhotoSetHash(rows) {
  const payload = JSON.stringify((rows || []).map((ph) => [
    String(ph.id), String(ph.caption || ''), String(ph.category || ''), String(ph.visit || ''),
  ]));
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function loadWdoAddendumPhotos(project, preloadedRows) {
  const rows = preloadedRows || await loadWdoAddendumPhotoRows(project).catch(() => []);
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
      out.push({ buffer, contentType, caption: wdoAddendumPhotoCaption(ph, project) });
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
  // The photo-row read propagates failure: a signature hashed over an EMPTY
  // photo set would otherwise collide with an errored-read-as-[] and slip an
  // unverified addendum through — a read failure must abort the build, never
  // masquerade as "no photos" (Codex P2 on #2887).
  const [baseApplicator, photoRows] = await Promise.all([
    resolveProjectApplicator(project),
    loadWdoAddendumPhotoRows(project),
  ]);
  // Photo-set verification (the findings hash's sibling): refuse to stamp
  // the signature onto a photo addendum the licensee never saw. Legacy
  // signatures without a photo_set_hash rely on the content_stale flag alone.
  if (signature.photoSetHash && signature.photoSetHash !== wdoPhotoSetHash(photoRows)) {
    const err = new Error('Photos changed after signing — the licensee must re-sign before sending');
    err.code = 'signature_stale';
    throw err;
  }
  const photos = await loadWdoAddendumPhotos(project, photoRows);
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
    // The photo set the signature was captured against: a filing is only ever re-used for the same signature
    // revision (signed_at) and the same photo set, not just the same findings.
    photo_set_hash: signature?.photoSetHash || null,
    content_hash: wdoContentHash(project, signature?.feeValues || null),
    // The archived binary was rendered through the customer-safe scrub
    // (buildWdoReportPDFBuffer applies customerSafeFindings) — the public
    // /fdacs-pdf gate uses this to distinguish a clean modern archive from a
    // legacy binary that may print a raw fee (codex #2817). Bump the tag if
    // the redaction contract ever changes incompatibly.
    pdf_renderer: 'fee-scrub-v1',
    // As-sent snapshot — the public token viewer serves these for WDO so the
    // web report can never silently diverge from the emailed signed PDF.
    // Stored RAW deliberately: /data scrubs at egress, and the raw snapshot
    // is what content_hash-adjacent tooling and admin views expect.
    findings: parseFindings(project),
    project_date: normalizeDateOnly(project.project_date),
  };
}

const PROJECT_INVOICE_NON_REUSABLE_STATUSES = ['void', 'paid', 'disputed', ...TERMINAL_INVOICE_STATUSES];
const PROJECT_INVOICE_ALREADY_BILLED_STATUSES = ['paid', 'prepaid', 'processing', 'disputed'];
const PROJECT_INVOICE_NON_SENDABLE_STATUSES = ['paid', 'prepaid', 'void', 'processing', 'sending', 'disputed'];

function alreadyBilledProjectError(inv) {
  const isDisputed = String(inv?.status || '').toLowerCase() === 'disputed';
  const message = isDisputed
    ? `Invoice ${inv.invoice_number} is disputed and cannot be sent or re-billed until the dispute is resolved. Nothing was sent.`
    : `This visit is already billed on invoice ${inv.invoice_number} (${inv.status}). Nothing was sent.`;
  const err = new Error(message);
  err.code = isDisputed ? 'invoice_disputed' : 'already_billed';
  err.invoiceId = inv.id;
  err.invoiceNumber = inv.invoice_number;
  return err;
}

function nonSendableProjectInvoicePayload(invoice) {
  if (invoice.status === 'disputed') {
    return {
      error: 'Cannot send a disputed invoice — resolve the dispute first.',
      code: 'invoice_disputed',
      invoice_id: invoice.id,
    };
  }
  return { error: `Cannot send a ${invoice.status} invoice`, invoice_id: invoice.id };
}

function isReusableInvoice(inv) {
  // Terminal and disputed invoices are never reuse candidates (codex #3344
  // r9-round pre-push; B-48): every payment route rejects refunded/cancelled/
  // disputed invoices, so reusing one links the project to a dead or disputed
  // bill. 'paid' stays excluded because reuse means "send for collection" —
  // the already-billed guard owns settled/disputed invoices.
  return inv && !PROJECT_INVOICE_NON_REUSABLE_STATUSES.includes(inv.status);
}

const WDO_INVOICE_LINE_DESCRIPTION = 'WDO Inspection (FDACS-13645 Wood-Destroying Organisms Inspection Report)';

async function resolveWdoFeeForProject(project, database = db, { existingDraftAmount = null } = {}) {
  const findings = parseFindings(project);
  if (parseWdoFeeAmount(findings.inspection_fee) !== null) {
    return resolveWdoInspectionFee(findings);
  }
  const scheduledService = await loadLinkedWdoVisit(project, database);
  return resolveWdoInspectionFee(findings, { scheduledService, fallbackFee: existingDraftAmount });
}

// If a reused invoice is still the auto-created WDO draft (untouched: draft
// status, our title + single WDO line item) and the resolved fee has since
// changed (the tech edited inspection_fee between the dry-run
// and the send), reprice its line item so we never bill the stale amount. A
// manually edited invoice (different title/lines) is left untouched, and a
// blank/prose inspection_fee never overwrites an existing positive draft with
// the $250 fallback.
async function maybeRepriceWdoDraft(invoice, project, { database = db } = {}) {
  if (!invoice || invoice.status !== 'draft' || String(invoice.title || '') !== 'WDO Inspection') return invoice;
  let items = invoice.line_items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = null; } }
  if (!Array.isArray(items) || items.length !== 1) return invoice;
  if (!String(items[0].description || '').startsWith('WDO Inspection (FDACS')) return invoice;

  const existingAmount = Number(items[0].amount ?? items[0].unit_price);
  const fee = await resolveWdoFeeForProject(project, database, { existingDraftAmount: existingAmount });
  // Never reprice a draft down to $0 — a no-charge WDO is refused before any
  // reuse path runs (wdo_no_charge guard); this is defense in depth for any
  // future caller that skips that guard.
  if (fee <= 0) return invoice;
  if (existingAmount === fee) return invoice;
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
    // A live report hold stays bound to the invoice the customer received (GATE_WDO_REPORT_HOLD): the
    // sweep releases the report when THAT invoice is paid, so a preview or a refused send that
    // resolved another invoice must not retarget it. Decided in the update itself, not from the
    // row this request read.
    // A hold whose invoice is gone (invoice_id NULL) stays unbound for staff to resolve: it never adopts another bill.
    // The condition exists only where the hold columns do (the row read shows which).
    const query = runner('projects').where({ id: project.id });
    if ('report_hold_status' in project) {
      query.whereRaw("(coalesce(report_hold_status, '') NOT IN ('held', 'releasing') OR invoice_id = ?)", [invoiceId]);
    }
    const linked = await query.update({ invoice_id: invoiceId, updated_at: db.fn.now() });
    if (linked) project.invoice_id = invoiceId;
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

// WDO report hold refusals. A hold waits on the homeowner's own payment, so an invoice billed to
// a third party (payer) or accrued on a payer's monthly statement cannot carry one: the homeowner
// does not control that payment, and a legal document would sit behind it for weeks.
function holdRefusal(status, code, error) {
  return Object.assign(new Error(error), { holdRefusal: { status, code } });
}

// The live Bill-To at a pay-link handoff: the arming payer check, rerun on the locked handle. Any refusal (a payer,
// a statement, an unreadable lookup) is a reason not to send the homeowner a pay link.
async function liveBillToRefusal(liveProject, database) {
  try {
    await assertHoldMintable(liveProject, true, { database });
    return null;
  } catch (err) {
    return err.holdRefusal?.code || 'bill_to_unreadable';
  }
}

async function assertHoldMintable(project, holdRequested, { database = db, linkedInvoiceId = null, locked = null } = {}) {
  if (!holdRequested) return;
  if (linkedInvoiceId || isReportHeld(locked)) {
    throw holdRefusal(409, 'hold_invoice_unusable', 'The invoice linked to this report is no longer open, so the report cannot be held on a new one. Use Send report.');
  }
  // Fail CLOSED: a lookup that cannot say "self-pay" must not let a hold mint an invoice for a
  // possibly payer-billed visit (resolveForInvoice falls back to self-pay on error unless told not to).
  let ssId = project.scheduled_service_id || null;
  if (!ssId && project.service_record_id) {
    const link = await database('service_records')
      .where({ id: project.service_record_id, customer_id: project.customer_id })
      .first('scheduled_service_id');
    ssId = link?.scheduled_service_id || null;
  }
  const payer = await require('../services/payer').resolveForInvoice({
    database,
    customerId: project.customer_id,
    scheduledServiceId: ssId,
    throwOnError: true,
  });
  if (!payer?.payerId) return;
  if (require('../services/payer').isNetPaymentTerm(String(payer.paymentTerms || '')) && isEnabled('payerStatements')) {
    throw holdRefusal(422, 'hold_statement_accrued', 'This service bills on the payer\'s monthly statement, so the report cannot wait for payment. Send the report and invoice normally.');
  }
  throw holdRefusal(422, 'hold_payer_billed', 'This service is billed to a third party, so the report cannot wait for payment. Send the report and invoice normally.');
}

// The checks that need no invoice. Returns { status, code, error } or null.
async function reportHoldRequestRefusal(project, projectCols, customer) {
  if (!wdoReportHoldLive()) {
    return { status: 422, code: 'hold_not_enabled', error: 'Holding the report until it is paid is not turned on.' };
  }
  if (project.project_type !== 'wdo_inspection') {
    return { status: 422, code: 'hold_not_supported', error: 'Holding the report until it is paid is available for WDO reports only.' };
  }
  if (reportLinkShared(project)) {
    return { status: 422, code: 'hold_after_send', error: 'This report was already sent or already has a report link, so it cannot be held. A hold only applies before the first send.' };
  }
  if (!reportHoldColumnsPresent(projectCols)) {
    return { status: 422, code: 'hold_columns_missing', error: 'Report hold is not set up in this database yet.' };
  }
  if (project.report_hold_status === 'releasing') {
    return { status: 409, code: 'release_in_progress', error: 'The paid report is being sent right now. Give it a moment, then refresh.' };
  }
  return holdReleasabilityRefusal(project, customer);
}

// The promise is "sent once paid": a report the automatic release would refuse today (a signature, an omission
// that needs an override reason, no email) is not held; staff use the normal send.
async function holdReleasabilityRefusal(project, customer, { database = undefined } = {}) {
  const notReleasable = await heldReleaseBlocker(project, customer, { database });
  return notReleasable
    ? { status: 422, code: 'hold_not_releasable', error: `This report could not be sent by itself after payment: ${notReleasable}. Fix that, or use Send report + invoice.` }
    : null;
}

// The checks that need the resolved invoice: payer-billed, statement-accrued, nothing to pay.
function reportHoldInvoiceRefusal(invoice, hold) {
  if (hold.wasHeld && hold.boundInvoiceId !== invoice.id) {
    return { status: 409, code: 'hold_invoice_locked', error: 'This report is already held on another invoice. Re-send that invoice, or press Send report.' };
  }
  if (invoice.payer_statement_id) {
    return { status: 422, code: 'hold_statement_accrued', error: 'This invoice bills on the payer\'s monthly statement, so the report cannot wait for payment.' };
  }
  if (invoice.payer_id || invoice.payer_snapshot) {
    return { status: 422, code: 'hold_payer_billed', error: 'This invoice is billed to a third party, so the report cannot wait for payment.' };
  }
  if (!(Number(invoice.total) > 0)) {
    return { status: 422, code: 'hold_no_charge', error: 'There is nothing to pay on this invoice, so there is nothing to wait for. Use Send report.' };
  }
  return null;
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
// The project row locked for the reuse-or-create decision. Every reuse reads the customer this request read: a
// project moved to another customer since (a merge) refuses rather than bill the old one. A missing row reads as the
// request's own copy (the create below then fails on its own).
async function lockProjectForInvoiceResolve(trx, project) {
  const locked = await trx('projects').where({ id: project.id }).forUpdate().first();
  if (locked && String(locked.customer_id) !== String(project.customer_id)) {
    throw Object.assign(new Error('This project moved to another customer while it was being sent. Refresh and try again.'), { code: 'project_customer_changed', status: 409 });
  }
  return locked || {};
}

async function findAlreadyBilledProjectInvoice(conn, project, linkedInvoiceId) {
  const clauses = [
    linkedInvoiceId ? { col: 'id', val: linkedInvoiceId } : null,
    project.scheduled_service_id ? { col: 'scheduled_service_id', val: project.scheduled_service_id } : null,
    project.service_record_id ? { col: 'service_record_id', val: project.service_record_id } : null,
  ].filter(Boolean);
  if (!clauses.length) return null;
  const row = await conn('invoices')
    .where({ customer_id: project.customer_id })
    .whereIn('status', PROJECT_INVOICE_ALREADY_BILLED_STATUSES)
    .where(function billedLinkage() {
      for (const c of clauses) this.orWhere({ [c.col]: c.val });
    })
    .orderBy('created_at', 'desc')
    .first();
  if (!row || !PROJECT_INVOICE_ALREADY_BILLED_STATUSES.includes(String(row.status || '').toLowerCase())) {
    return null;
  }
  return row;
}

async function resolveOrCreateProjectInvoice({ project, customer, invoiceId, dryRun = false, holdRequested = false }) {
  // No-charge WDO (owner ruling 2026-07-15, #2751 follow-up): an explicit $0
  // inspection fee means nothing is billed for this visit. Refuse the
  // combined report+invoice send on EVERY path — before the explicit-id and
  // reuse checks, so no draft is minted, repriced, or attached — and point
  // the operator at the report-only send. Billing it anyway requires typing
  // a non-zero fee first (the entry always wins).
  if (project.project_type === 'wdo_inspection'
    && resolveWdoInspectionFee(parseFindings(project)) === 0) {
    const err = new Error('This WDO inspection is recorded as no charge ($0 inspection fee) — use "Send report" to deliver the FDACS report without an invoice. To bill it, enter a non-zero inspection fee first.');
    err.code = 'wdo_no_charge';
    throw err;
  }
  if (invoiceId) {
    const blocked = await findAlreadyBilledProjectInvoice(db, project, project.invoice_id);
    if (blocked) {
      await persistProjectInvoiceLink(project, blocked.id);
      throw alreadyBilledProjectError(blocked);
    }
    const explicit = await db('invoices').where({ id: invoiceId, customer_id: project.customer_id }).first();
    if (!explicit) throw new Error('Invoice not found for this customer');
    if (PROJECT_INVOICE_ALREADY_BILLED_STATUSES.includes(String(explicit.status || '').toLowerCase())) {
      const explicitMatchesProject = String(explicit.id) === String(project.invoice_id || '')
        || (project.scheduled_service_id && String(explicit.scheduled_service_id || '') === String(project.scheduled_service_id))
        || (project.service_record_id && String(explicit.service_record_id || '') === String(project.service_record_id));
      if (explicitMatchesProject) await persistProjectInvoiceLink(project, explicit.id);
      throw alreadyBilledProjectError(explicit);
    }
    // A held send links its invoice only when the hold is armed (armReportHold writes the link under the project
    // lock, after every hold check): a refused held send never relinks the project.
    if (!holdRequested) await persistProjectInvoiceLink(project, explicit.id);
    // This is the normal final-send path (UI posts the previewed draft's id), so
    // reprice it too if the WDO fee changed since the dry-run. Only the untouched
    // auto-created draft is affected; a hand-picked/edited invoice is left as-is.
    // A held send bills exactly the invoice staff confirmed (its fingerprint): never repriced here.
    return { invoice: holdRequested ? explicit : await maybeRepriceWdoDraft(explicit, project), created: false };
  }

  // Serialize the reuse-or-create decision on the project row. The endpoint is
  // hit twice per send (dry-run + send) and can be double-clicked, so two
  // overlapping POSTs used to race: both fell through the reuse checks (invoice_id
  // still null) and both called InvoiceService.create, leaving duplicate WDO
  // drafts (there's no DB uniqueness backstop on projects.invoice_id). A FOR UPDATE
  // lock makes the loser block until the winner commits the link, then re-read it
  // and reuse the same invoice. The lock is released on commit.
  return db.transaction(async (trx) => {
    const locked = await lockProjectForInvoiceResolve(trx, project);
    const linkedInvoiceId = locked.invoice_id || project.invoice_id;

    // 0. Check disputed/paid/processing invoices on the project or visit FIRST
    //    so an older draft on the same visit can never bypass a disputed link.
    const alreadyBilled = await findAlreadyBilledProjectInvoice(trx, project, linkedInvoiceId);
    if (alreadyBilled) {
      await persistProjectInvoiceLink(project, alreadyBilled.id, trx);
      throw alreadyBilledProjectError(alreadyBilled);
    }

    // 1. Reuse the invoice already recorded on the project (covers ad-hoc
    //    projects with no service linkage, and the dry-run → send → resend path).
    if (linkedInvoiceId) {
      const prior = await trx('invoices').where({ id: linkedInvoiceId, customer_id: project.customer_id }).first();
      if (isReusableInvoice(prior)) {
        project.invoice_id = linkedInvoiceId;
        return { invoice: await maybeRepriceWdoDraft(prior, project, { database: trx }), created: false };
      }
    }

    // 2. Reuse a non-paid invoice already minted for the same scheduled service
    //    or service record (mirrors project-completion.findExistingCompletionInvoice).
    if (project.scheduled_service_id || project.service_record_id) {
      const linked = await trx('invoices')
        .where({ customer_id: project.customer_id })
        .whereNotIn('status', PROJECT_INVOICE_NON_REUSABLE_STATUSES)
        .where(function invoiceLinkage() {
          if (project.scheduled_service_id) this.orWhere({ scheduled_service_id: project.scheduled_service_id });
          if (project.service_record_id) this.orWhere({ service_record_id: project.service_record_id });
        })
        .orderBy('created_at', 'desc')
        .first();
      if (linked) {
        await persistProjectInvoiceLink(project, linked.id, trx);
        return { invoice: await maybeRepriceWdoDraft(linked, project, { database: trx }), created: false };
      }
    }

    // 3. Nothing to reuse — mint the project's draft invoice. How the draft is
    //    built depends on the project type.
    //
    // A report hold must never CREATE a third-party or statement-billed invoice as a side
    // effect of a send the route is about to refuse: predict the payer before the draft is
    // built. A reused or explicit invoice is checked by the route after it resolves.
    //
    // A project whose linked invoice cannot be reused (voided, replaced, paid elsewhere) or whose hold is
    // live never gets a replacement draft for a hold: the hold binds the invoice the customer received, and
    // a refused replacement would leave a stray bill behind. Every hold refusal runs here, before the create.
    await assertHoldMintable(project, holdRequested, { database: trx, linkedInvoiceId, locked });

    if (project.project_type === 'wdo_inspection') {

      // WDO bills a single auto-priced "WDO Inspection" line. On a dry-run, DON'T
      // mint a real draft just to show the amount — every cancelled preview would
      // strand an orphan invoice + burn an invoice number. Return a non-persisted
      // preview of the fee/total instead; `created: true` so the confirm dialog
      // still reads "Create and send", and the real send below does the create.
      // A held send prices from the LOCKED row: a fee changed to $0 since the preflight bills nothing, so no draft.
      const feeSource = holdRequested && 'findings' in locked ? { ...project, findings: locked.findings } : project;
      const fee = await resolveWdoFeeForProject(feeSource, trx);
      if (holdRequested && fee === 0) {
        throw holdRefusal(422, 'wdo_no_charge', 'This WDO inspection is now recorded as no charge ($0 inspection fee). Nothing was sent. Use "Send report".');
      }
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
    // line items come from the linked scheduled-service pricing. A pre-treatment
    // certificate reaches this path before closeout creates its service record,
    // so scheduled_service_id alone is a valid invoice source.
    // Unlike WDO there's no cheap synthetic fee to preview, and replaying the
    // full discount/tax math outside create() would risk drift, so the dry-run
    // below builds the draft through the same create() call the real send uses
    // — inside a savepoint that is always rolled back, so a preview never
    // persists a numbered invoice or links it to the project (ADMIN-BUG-R49).
    // The real send's draft IS persisted + linked, so a follow-up send after a
    // preview mints exactly one draft and reuses it on any resend (reuse path
    // 1 above) — never duplicates.
    if (!project.service_record_id && !project.scheduled_service_id) {
      const err = new Error('This service report isn’t linked to an appointment or completed visit, so an invoice can’t be built automatically. Create the invoice from the visit first — it will be reused here.');
      err.code = 'invoice_build_failed';
      throw err;
    }
    const serviceRecord = project.service_record_id
      ? await trx('service_records')
        .where({ id: project.service_record_id, customer_id: project.customer_id })
        .first()
      : null;
    if (project.service_record_id && !serviceRecord) {
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
    const scheduledServiceId = serviceRecord?.scheduled_service_id || project.scheduled_service_id;
    // Mint-serialization (codex #3344 r2, WaveGuard #3338 fast-follow):
    // this draft bills the visit's scheduled-service pricing, so it must
    // contend on the same visit row lock every other scheduled-price mint
    // takes — the WaveGuard extension apply holds FOR UPDATE on the rows it
    // reprices, and an unlocked build here could line-item the old price
    // after both of the extension's invoice probes have passed. Lock on
    // THIS transaction and build the lines through it; the create below
    // commits on the pooled connection while the lock (held to this trx's
    // commit) keeps the reprice out until the invoice is visible to the
    // extension's probes.
    if (scheduledServiceId) {
      // The shared mint serialization, not a parallel one (pre-push P0,
      // codex r5 round; consolidated in r8): every other scheduled-service
      // invoice writer (completion mint, Charge Now, checkout) takes the
      // SAME chain in the SAME order — advisory mint lock → customer
      // key-share → visit row lock — owned by scheduled-invoice-mint, so
      // this path contends identically and cannot drift.
      await acquireScheduledMintLockChain(trx, {
        scheduledServiceId,
        customerId: project.customer_id,
      });
      // In-lock replay re-check (pre-push P0, codex r5 round): the reuse and
      // already-billed checks above ran BEFORE these locks — a canonical
      // mint that held them first can commit an invoice for this visit and
      // this transaction would wake and create a duplicate collectible.
      // Repeat both checks now that no other writer can mint: an invoice
      // that appeared is adopted (or 409s) exactly like the pre-lock pass.
      // The derived scheduledServiceId is included in the linkage — the
      // pre-lock pass could only see project.scheduled_service_id.
      const lockedReuse = await trx('invoices')
        .where({ customer_id: project.customer_id })
        // Terminal and disputed invoices are NOT adoption candidates (codex r7 P1; B-48).
        .whereNotIn('status', PROJECT_INVOICE_NON_REUSABLE_STATUSES)
        .where(function invoiceLinkage() {
          this.orWhere({ scheduled_service_id: scheduledServiceId });
          if (project.service_record_id) this.orWhere({ service_record_id: project.service_record_id });
        })
        .orderBy('created_at', 'desc')
        .first();
      if (lockedReuse) {
        await persistProjectInvoiceLink(project, lockedReuse.id, trx);
        return { invoice: await maybeRepriceWdoDraft(lockedReuse, project, { database: trx }), created: false };
      }
      const lockedBilled = await trx('invoices')
        .where({ customer_id: project.customer_id })
        .whereIn('status', PROJECT_INVOICE_ALREADY_BILLED_STATUSES)
        .where(function billedLinkage() {
          this.orWhere({ scheduled_service_id: scheduledServiceId });
          if (project.service_record_id) this.orWhere({ service_record_id: project.service_record_id });
        })
        .orderBy('created_at', 'desc')
        .first();
      if (lockedBilled) {
        await persistProjectInvoiceLink(project, lockedBilled.id, trx);
        throw alreadyBilledProjectError(lockedBilled);
      }
    }
    const built = scheduledServiceId
      ? await InvoiceService.buildLineItemsForScheduledService(scheduledServiceId, {
          fallbackDescription: serviceRecord?.service_type || getProjectType(project.project_type)?.label || 'Service visit',
          database: trx,
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
    if (dryRun) {
      // Preview only (ADMIN-BUG-R49): build the draft through the SAME
      // create() call the real send uses below — replaying the discount/tax
      // math independently would risk drift — but inside a SAVEPOINT that is
      // UNCONDITIONALLY rolled back, so a cancelled or errored preview never
      // mints a real numbered draft, never links it to the project, and never
      // burns an invoice number. Without this, the never-sent draft let the
      // project Close guard read billing as resolved.
      const previewSavepoint = `project_invoice_preview_${crypto.randomBytes(6).toString('hex')}`;
      await trx.raw(`SAVEPOINT ${previewSavepoint}`);
      let previewInvoice;
      try {
        const previewCreated = await InvoiceService.create({
          customerId: project.customer_id,
          serviceRecordId: project.service_record_id || undefined,
          scheduledServiceId: scheduledServiceId || undefined,
          lineItems: built.lineItems,
          discountIds: built.discountIds && built.discountIds.length ? built.discountIds : undefined,
          trustedStoredDiscountSources: ['scheduled_service'],
          notes: `Auto-generated for ${getProjectType(project.project_type)?.label || 'service'} project ${project.id}.`,
          database: trx,
        });
        const previewFresh = await trx('invoices').where({ id: previewCreated.id }).first();
        previewInvoice = previewFresh || previewCreated;
      } finally {
        await trx.raw(`ROLLBACK TO SAVEPOINT ${previewSavepoint}`);
        await trx.raw(`RELEASE SAVEPOINT ${previewSavepoint}`);
      }
      return {
        invoice: { ...previewInvoice, id: null, invoice_number: null, status: 'preview' },
        created: true,
        preview: true,
      };
    }
    const createdNonWdo = await InvoiceService.create({
      customerId: project.customer_id,
      serviceRecordId: project.service_record_id || undefined,
      scheduledServiceId: scheduledServiceId || undefined,
      lineItems: built.lineItems,
      discountIds: built.discountIds && built.discountIds.length ? built.discountIds : undefined,
      // The scheduled-service lines carry stored discount amounts; trust them so
      // the draft total matches the appointment (mirrors createFromService).
      trustedStoredDiscountSources: ['scheduled_service'],
      notes: `Auto-generated for ${getProjectType(project.project_type)?.label || 'service'} project ${project.id}.`,
      // On THIS transaction, not the pool: the invoice's scheduled_service_id
      // FK takes a key-share lock on the visit row we hold FOR UPDATE above —
      // a pooled-connection insert would wait on our own lock while we await
      // it (self-deadlock until timeout). Same-trx also makes invoice + link
      // commit atomically.
      database: trx,
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
  // Hoisted so the outer catch can release the send claim on an unexpected
  // throw — otherwise a crash mid-send would 409 every later attempt for
  // 10 minutes (the claim's stale-recovery window).
  let revertSendClaimOnError = null;
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
      ? await loadProjectCustomer(project.customer_id)
      : null;

    const readiness = evaluateProjectSendReadiness({ project, customer, staffSend: true });
    // Statutory compliance blockers are not overridable (Codex P1 r3) —
    // override_reason exists for judgment calls, not FS/FAC omissions.
    if (readiness.hardMissing.length > 0) {
      return res.status(422).json({
        error: 'Project report is missing required compliance details (cannot be overridden)',
        missing: readiness.hardMissing,
      });
    }
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

    // dry_run: routing preview for the confirm dialog — who receives the
    // report email and which "Report Sent to Requestor and to:" third parties
    // get a report-only copy. Mirrors send-with-invoice's preview so the
    // report-only send is no longer a blind fire. No side effects: nothing
    // claimed, no token minted, nothing sent.
    if (req.body?.dry_run) {
      return res.json({
        dry_run: true,
        email_routing: await manualSendPreviewRouting(customer, project),
        ...heldSendDryRunKeys(project),
      });
    }

    // A held WDO report sends through the release itself, the one sender of a held report (the automatic one runs it
    // too): one claim, one set of locked pre-send checks, the link published only once the email is accepted.
    // Staff confirmed a plain send, and the report was held (by another admin) since the preview: ask again, so the
    // early-release warning is seen before payment is bypassed.
    // Any caller that did not confirm the early release (an older client, the technician completion screen) is asked too.
    if (req.body?.expected_hold !== 'held' && isReportHeld(project)) {
      return res.status(409).json({ code: 'hold_changed', error: 'This report was just held until its invoice is paid. Press Send report again to see the warning and send it early.' });
    }
    if (project.project_type === 'wdo_inspection' && isReportHeld(project)) {
      return await sendHeldReportByStaff(req, res, { project, readiness, hasReadinessOverride, overrideReason });
    }
    // Staff confirmed the early release of a held report, and the automatic release sent it meanwhile: a plain resend
    // now would be a second copy with a new key. Say so instead.
    if (req.body?.expected_hold === 'held' && project.report_hold_status === 'released') {
      return res.status(409).json({ code: 'hold_already_released', error: 'The invoice was paid and the report was already sent by itself. Nothing new was sent. Use Resend report if the customer needs another copy.' });
    }
    // Staff confirmed a FIRST send, and the report went out meanwhile (another admin, or a hold armed and released by
    // payment while the dialog was open): sending now would be a second copy nobody confirmed as a resend.
    const confirmedFirstSend = req.body?.expected_sent === false;
    if (confirmedFirstSend && (project.sent_at || project.status === 'sent')) {
      return res.status(409).json({ code: 'report_already_sent', error: 'This report was sent while you were confirming. Nothing new was sent. Press Send report again to resend it.' });
    }

    // Send claim: /send previously had NO concurrency guard, so two
    // overlapping POSTs (double-click, impatient retry) each passed the gates
    // and both built + archived + emailed the FDACS filing — the customer got
    // two copies and the project two identical archived filings. Claim the
    // row as 'sending' before any side effect (mirrors the send-with-invoice
    // invoice claim); a crashed claim self-recovers after 10 minutes.
    // A recovered STALE claim normalizes its revert target to 'failed' — an
    // abort must never write 'sending' back with a fresh updated_at, which
    // would re-lock retries for another 10 minutes per failure, indefinitely.
    const previousDeliveryStatus = project.delivery_status === 'sending'
      ? 'failed'
      : (project.delivery_status || null);
    // Ownership fence: the stale takeover reuses the same 'sending' value, so
    // without a per-claim token a stalled-but-alive original request could
    // revert or finalize over the takeover's claim. Every revert/finalize
    // below conditions on this token.
    const sendClaimToken = crypto.randomBytes(12).toString('hex');
    const sendClaimQuery = db('projects')
      .where({ id: project.id })
      .where((q) => q
        .whereRaw("delivery_status IS DISTINCT FROM 'sending'")
        .orWhereRaw("updated_at < now() - interval '10 minutes'"));
    // A report held (or being released) since the read above sends only through the release: this plain send
    // must not claim it.
    if ('report_hold_status' in project) sendClaimQuery.whereRaw("coalesce(report_hold_status, '') NOT IN ('held', 'releasing')");
    addSentOutsideClaimGuard(sendClaimQuery, project);
    if (confirmedFirstSend) sendClaimQuery.whereNull('sent_at').whereRaw("status IS DISTINCT FROM 'sent'");
    const sendClaim = await sendClaimQuery
      .update({ delivery_status: 'sending', delivery_claim_token: sendClaimToken, updated_at: db.fn.now() });
    if (!sendClaim) {
      return res.status(409).json({
        error: 'This report is already being sent — give it a moment, then refresh.',
        code: 'send_in_progress',
      });
    }
    const revertSendClaim = async () => {
      await db('projects')
        .where({ id: project.id, delivery_status: 'sending', delivery_claim_token: sendClaimToken })
        .update({ delivery_status: previousDeliveryStatus, delivery_claim_token: null, updated_at: db.fn.now() })
        .catch((err) => logger.warn(`[projects] send claim revert failed for ${project.id}: ${err.message}`));
    };
    revertSendClaimOnError = revertSendClaim;

    await assertPretreatStillSendable(project.id, project.project_type);

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
    // Token-fenced like the finalize below: a stalled request that resumes
    // after a stale takeover must not overwrite the new owner's
    // report_token / portal fields with its own pre-delivery stamp.
    const stamped = await db('projects')
      .where({ id: req.params.id, delivery_claim_token: sendClaimToken })
      .update(tokenUpdate);
    if (!stamped) {
      logger.error(`[projects] send superseded before token stamp for ${project.id} — claim taken over by a newer request`);
      return res.status(409).json({
        error: 'This send was superseded by a newer request — refresh and check the report status.',
        code: 'send_superseded',
      });
    }

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
    if (isWdo && !ProjectEmail.resolveProjectEmailRecipient(customer || {}, { applyReportRule: true }).email) {
      await revertSendClaim();
      return res.status(422).json({ error: 'A WDO report is delivered as the FDACS-13645 PDF by email — add an email address for this customer first.', code: 'email_required' });
    }

    // Build the FDACS report PDF up-front. For a WDO report this PDF *is* the
    // deliverable (and is gated as signed), so a build/stamp failure must abort
    // before any channel send rather than deliver a report-less message.
    const built = await buildManualSendFiling({ updatedProject, customer, technicianId: req.technicianId });
    if (built.error) {
      await revertSendClaim();
      logger.error(`[projects] WDO PDF build/archive failed for ${updatedProject.id}: ${built.logMessage}`);
      return res.status(500).json({ error: built.error });
    }
    const { wdoPdf, wdoFiling } = built;

    const channels = {};

    // Ownership recheck + LEASE RENEWAL immediately before the external
    // sends: the token fences every DB write, but a stalled request that
    // resumes after a takeover could otherwise still EMAIL — and resend keys
    // don't collide across owners, so the provider wouldn't dedupe the pair.
    // Re-stamping updated_at here restarts the 10-minute takeover window at
    // the moment delivery begins, so the build phase (PDF render, archive)
    // can no longer eat the lease out from under the provider calls.
    const stillOwned = await db('projects')
      .where({ id: project.id, delivery_claim_token: sendClaimToken })
      .update({ updated_at: db.fn.now() });
    if (!stillOwned) {
      logger.error(`[projects] send superseded before delivery for ${project.id} — claim taken over; nothing emailed by this request`);
      return res.status(409).json({
        error: 'This send was superseded by a newer request — refresh and check the report status.',
        code: 'send_superseded',
      });
    }

    // Email first (through editable Waves template library). For WDO it carries
    // the FDACS PDF, so the SMS link is only sent after the email succeeds.
    const emailRecipient = ProjectEmail.resolveProjectEmailRecipient(customer || {}, { applyReportRule: true });
    const isResendSend = Boolean(project.sent_at || project.status === 'sent');
    if (emailRecipient.email) {
      try {
        // Recipient-hashed idempotency key: the claim stops concurrent duplicates, this stops crash-retry
        // duplicates at the provider layer. A resend keys on the claim token —
        // deterministic within this attempt, distinct across attempts.
        const recipientHash = crypto.createHash('sha1')
          .update(String(emailRecipient.email).toLowerCase())
          .digest('hex')
          .slice(0, 12);
        const result = await ProjectEmail.sendProjectReportReady({
          project: updatedProject,
          customer,
          reportUrl,
          isResend: isResendSend,
          attachments: wdoPdf ? [wdoPdf.attachment] : [],
          idempotencyKey: `project.report_ready:${project.id}:${isResendSend ? `resend-${sendClaimToken}` : 'initial'}:${recipientHash}`,
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
    // A migrated historical delivery ('legacy_sent', migration
    // 20260511000001) has no sent_at — its delivery_status is the ONLY
    // record that the report was issued, and its public token still opens.
    // A resend that delivers nothing keeps it (the attempt is recorded in
    // delivery_channels / last_delivery_at); it must not read as a
    // never-issued report (GH Codex #3893 r9 P2).
    const deliveryStatus = !delivered
      ? (successfulChannelCount === 0
        ? (project.delivery_status === 'legacy_sent' ? 'legacy_sent' : 'failed')
        : 'partial')
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
      // The row re-read after the claim is what this send delivered.
      Object.assign(deliveryUpdate, pretreatSentSnapshot(updatedProject, projectCols));
      if (wdoFiling && projectCols.wdo_sent_filings) {
        // Atomic jsonb append — /send has no send claim, so a concurrent send
        // must not lose a filing record to read-modify-write.
        deliveryUpdate.wdo_sent_filings = db.raw(
          "coalesce(wdo_sent_filings, '[]'::jsonb) || ?::jsonb",
          [JSON.stringify([wdoFiling])],
        );
      }
    }

    // Fenced finalize: only the request that still owns the claim may write
    // the outcome. Zero rows = a stale takeover superseded this request —
    // the emails above already went out, but the row's state belongs to the
    // new owner now; recording over it would corrupt THEIR in-flight send.
    deliveryUpdate.delivery_claim_token = null;
    const finalized = await db('projects')
      .where({ id: req.params.id, delivery_claim_token: sendClaimToken })
      .update(deliveryUpdate);
    if (!finalized) {
      logger.error(`[projects] send finalize fenced off for ${project.id} — claim superseded by a stale-takeover; outcome not recorded`);
    }

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
        // prefix only — activity metadata is an audit trail, and the full
        // value is a never-expiring bearer credential (audit 2026-07-16);
        // the projects row holds the real token
        report_token_prefix: String(token).slice(0, 6),
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

    logger.info(`[projects] delivery ${project.id} token=${String(token).slice(0, 6)}… status=${deliveryStatus} sms=${channels.sms?.ok} email=${channels.email?.ok}`);
    res.json({
      project_id: project.id,
      report_token: token,
      report_url: reportPath || `/report/project/${token}`,
      channels,
      delivery_status: deliveryStatus,
      sent: delivered,
      ...(readiness.missing.length > 0 ? { readiness_override: hasReadinessOverride } : {}),
    });
  } catch (err) {
    if (revertSendClaimOnError) await revertSendClaimOnError().catch(() => {});
    next(err);
  }
});

// A staff Send report of a held report: the release with source 'manual_send', answered in /send's own shape.
const STAFF_RELEASE_REFUSALS = {
  not_held_or_busy: [409, 'send_in_progress', 'This report is already being sent — give it a moment, then refresh.'],
  claim_superseded: [409, 'send_superseded', 'This send was superseded by a newer request — refresh and check the report status.'],
  hold_columns_missing: [409, 'send_in_progress', 'This report cannot be sent right now. Refresh and try again.'],
};
async function sendHeldReportByStaff(req, res, { project, readiness, hasReadinessOverride, overrideReason }) {
  const result = await releaseHeldProjectReport(project.id, { source: 'manual_send', actor: req, readinessOverride: hasReadinessOverride });
  const refusal = STAFF_RELEASE_REFUSALS[result.reason];
  if (refusal) return res.status(refusal[0]).json({ code: refusal[1], error: refusal[2] });
  // Nothing went to a provider (a release check refused it): staff read why.
  if (!result.released && !result.channels) return res.status(422).json({ error: result.reason, code: 'held_release_refused' });
  if (result.released && hasReadinessOverride) {
    await logProjectActivity(req, project, 'project_report_readiness_override', 'Held report sent with an override reason',
      { readiness_override: { reason: overrideReason, missing: readiness.missing } }).catch(() => {});
  }
  return res.json({
    project_id: project.id,
    ...(result.released ? { report_token: result.token, report_url: result.reportPath || `/report/project/${result.token}` } : {}),
    channels: result.channels,
    delivery_status: result.released ? result.deliveryStatus : 'failed',
    sent: Boolean(result.released),
    ...(readiness.missing.length > 0 ? { readiness_override: hasReadinessOverride } : {}),
  });
}

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
// A delivery stamps 'sent' unless the project is closed: decided in the write itself, so a closeout that committed
// while the report was being delivered keeps its closed status (closed_at stays set and closeout artifacts key on it).
const SENT_UNLESS_CLOSED = () => db.raw("CASE WHEN status = 'closed' THEN status ELSE 'sent' END");

async function sendWdoReportCopies({ req, project, customer, reportUrl, attachment, excludeEmails, isResend, keyPart = 'initial', ownClaim = null, copyHandoff = null }) {
  const emails = wdoReportCopyEmails(parseFindings(project), excludeEmails);
  if (!emails.length) return null;
  const sent = [];
  const failed = [];
  for (const email of emails) {
    // A release sends each copy only while it still owns its claim (the renewal also keeps the lease alive through a
    // long list); a lost claim stops the list, and the new owner sends the rest under the same keys.
    if (ownClaim && !(await db('projects').where(ownClaim).update(RELEASE_LEASE_RENEWAL()).catch(() => 0))) {
      failed.push({ email, error: 'the release claim was lost' });
      continue;
    }
    // The email is hashed into the idempotency key, not embedded: a long
    // (but valid) address could push the key past email_messages'
    // varchar(260) and fail the insert instead of sending.
    const emailKey = crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
    // A release's copy runs the release's locked pre-send check in its provider handoff.
    const handoffState = copyHandoff ? { boundaryBlock: null } : null;
    try {
      const result = await ProjectEmail.sendProjectReportReady({
        project,
        customer,
        reportUrl,
        ...(copyHandoff ? { withProviderHandoff: copyHandoff(email, handoffState), handoffState } : {}),
        attachments: attachment ? [attachment] : [],
        // name 'there' keeps the template greeting generic — the customer's
        // first name on a title company's copy would read wrong.
        recipient: { email, name: 'there', role: 'report_copy' },
        idempotencyKey: `project.report_copy:${project.id}:${emailKey}:${isResend ? new Date().toISOString() : keyPart}`,
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
// WDO report hold: helpers and release (GATE_WDO_REPORT_HOLD, owner 2026-11-24)
// ---------------------------------------------------------------------------
// A held report waits on the project row (report_hold_* columns). Mutual
// exclusion with /send and /send-with-invoice is the shared delivery claim
// (delivery_status 'sending' + claim token): the release takes it with the
// held -> releasing flip in ONE update, so a manual send and the sweep can
// never both deliver the same FDACS filing.

function reportHoldColumnsPresent(projectCols) {
  return Boolean(projectCols?.report_hold_status && projectCols?.report_hold_attempts);
}

// Written in the SAME update as a delivered send's sent stamp, so a send that
// delivers a held report releases the hold atomically (a crash cannot leave a
// delivered report held, or a released one unsent).
function heldReportReleaseFields(source = 'manual_send') {
  return {
    report_hold_status: 'released',
    report_hold_released_at: db.fn.now(),
    report_hold_release_source: source,
    report_hold_locked_at: null,
    report_hold_last_error: null,
  };
}

// A held report's invoice status rides on the project detail: the drawer says "paid" only for a paid invoice.
async function heldInvoiceStatusKeys(project) {
  if (!isReportHeld(project)) return {};
  const row = await db('invoices').where({ id: project.invoice_id }).first('status').catch(() => null);
  return { report_hold_invoice_status: row?.status || null };
}

// The /send dry run says so when sending releases a held report.
function heldSendDryRunKeys(project) {
  return isReportHeld(project) ? { releases_payment_hold: true } : {};
}

// The same fields as heldReportReleaseFields, evaluated per row inside an UPDATE: only a row that is
// held at that moment is released (any other row keeps every value).
function heldReleaseFieldsInSql(source) {
  const whenHeld = (column, held, bindings = []) => db.raw(`CASE WHEN report_hold_status = 'held' THEN ${held} ELSE ${column} END`, bindings);
  return {
    report_hold_released_at: whenHeld('report_hold_released_at', 'now()'),
    report_hold_release_source: whenHeld('report_hold_release_source', '?', [source]),
    report_hold_locked_at: whenHeld('report_hold_locked_at', 'NULL'),
    report_hold_last_error: whenHeld('report_hold_last_error', 'NULL'),
    // A held report's link exists only from a release email of unknown outcome, maybe to an address staff corrected
    // since: a report sent another way takes it back, so the public viewer never shows its live findings.
    report_token: whenHeld('report_token', 'NULL'),
    // (every CASE reads the row as it was before the update)
    report_hold_status: whenHeld('report_hold_status', "'released'"),
  };
}

// The text sent with the invoice of a held report. The WDO report is an email
// PDF, so the text always says "emailed".
function heldReportInvoiceSms({ firstName, typeLabel, invoice, payUrl }) {
  return `Hi ${firstName}, your Waves ${typeLabel} is complete. Invoice ${invoice.invoice_number} — pay online: ${payUrl}\n\nYour report is emailed automatically as soon as it's paid.`;
}

// The release's steps up to the provider calls, each of which can stop it: the invoice (settled, or any for a staff
// send), the claimed row's readiness, the signed PDF archived BEFORE the link is published (a failure leaves no token
// and no portal visibility behind), the hidden link, and the lease renewal with the filing reference (written BEFORE
// the email, in the same fenced update, so a retry after a crash records the filing actually sent).
// Returns { done } (the release's answer) or { invoice, pdf, link }.
async function prepareHeldRelease({ project, projectCols, ownClaim, ctx, source, actor, staffSend, readinessOverride, revertToHeld }) {
  const superseded = { done: { released: false, reason: 'claim_superseded' } };
  const invoice = staffSend ? await loadHeldInvoice(project) : await loadSettledHoldInvoice(project);
  // Not due yet is not a delivery failure: no attempt is burned.
  if (!invoice) return { done: await revertToHeld('invoice_not_settled', { countAttempt: false }) };
  ctx.customer = project.customer_id ? await loadProjectCustomer(project.customer_id, { strict: true }) : null;
  // Judged on the claimed row: a staff send skips the missing-details rule only when staff gave an override reason
  // (a detail removed after the screen read, with no reason given, stops the send).
  const blocked = await heldReleaseBlocker(project, ctx.customer, { readinessChecked: staffSend && Boolean(readinessOverride) });
  if (blocked) return { done: await revertToHeld(blocked) };
  const pdf = await buildAndArchiveHeldReportPdf({ project, customer: ctx.customer, invoice, source, sentByTechId: actor?.technicianId || null });
  if (pdf.error) return { done: await revertToHeld(pdf.error) };
  const link = await stampHeldReportLink({ project, projectCols, ownClaim, customer: ctx.customer, invoice, requireSettled: !staffSend });
  if (!link) return superseded;
  const refusal = HELD_LINK_REFUSALS[link.refused];
  if (refusal) return { done: await revertToHeld(refusal.reason, { countAttempt: refusal.countAttempt }) };
  if (!(await db('projects').where(ownClaim).update({ ...RELEASE_LEASE_RENEWAL(), ...releaseFilingFields(pdf.wdoFiling) }))) return superseded;
  return { invoice, pdf, link };
}

// Why a link was not published while this claim is still ours: a refund that reopened the invoice is "not due yet"
// (no attempt); a paid invoice owned by another customer hands the report back for a person to look (a counted
// attempt rings the bell).
const HELD_LINK_REFUSALS = {
  unsettled: { reason: 'invoice_not_settled', countAttempt: false },
  owner_mismatch: { reason: 'The paid invoice belongs to another customer, so the report was not sent. Check the invoice and the customer.', countAttempt: true },
};

/**
 * Deliver a payment-held WDO report: the /send delivery with a system actor.
 * Called by the release sweep once the linked invoice is 'paid' or 'prepaid'.
 *
 * held -> releasing (atomic claim, with the shared delivery claim) -> released
 * on success; back to held with attempts+1 and backoff on any failure. The
 * FDACS PDF is rebuilt from LIVE data, so the signature checks re-run here:
 * findings edited after signing keep the report held until the licensee
 * re-signs, never emailing content the licensee did not see. The first failure
 * raises ONE admin bell; the stuck-hold bucket of the attention sweep reminds.
 *
 * The steps are the helpers below; each returns a result or a plain reason
 * string for the revert, and this function only sequences them.
 */
async function releaseHeldProjectReport(projectId, { source = 'payment_sweep', actor = null, readinessOverride = false } = {}) {
  // A staff Send report of a held report runs this same release: no settled invoice is needed (staff release it
  // early), a failure is answered to staff instead of burning an attempt or ringing the bell, and the activity names
  // the staff member.
  const staffSend = source === 'manual_send';
  const projectCols = await db('projects').columnInfo().catch(() => ({}));
  if (!reportHoldColumnsPresent(projectCols)) return { released: false, reason: 'hold_columns_missing' };

  const claim = await claimHeldReportForRelease(projectId);
  // Not held any more, or a send holds the delivery claim: try again next tick.
  if (!claim) return { released: false, reason: 'not_held_or_busy' };

  const { project, ownClaim } = claim;
  const ctx = { customer: null };
  const baseRevert = makeHeldReverter({ project, claim, ctx, source });
  const revertToHeld = (reason, opts = {}) => baseRevert(reason, staffSend ? { ...opts, countAttempt: false } : opts);
  try {
    const prepared = await prepareHeldRelease({ project, projectCols, ownClaim, ctx, source, actor, staffSend, readinessOverride, revertToHeld });
    if (prepared.done) return prepared.done;
    const { invoice, pdf, link } = prepared;

    const sent = await sendHeldReport({ link, customer: ctx.customer, invoice, wdoPdf: pdf.wdoPdf, wdoFiling: pdf.wdoFiling, ownClaim, staffSend });
    // The FDACS PDF rides on the email only, so the email IS the delivery.
    // A definite non-send takes back the link this attempt minted; an email of unknown outcome may carry it.
    if (!sent.channels.email.ok) {
      // Unsettled at the handoff (a refund or reversal): not due yet, as before the stamp.
      const email = sent.channels.email;
      const reverted = email.unsettled || email.relink
        ? await revertToHeld(email.unsettled ? 'invoice_not_settled' : email.error, { countAttempt: false, unmintToken: link.mintedToken || email.relink })
        : await revertToHeld(`Report email failed: ${email.error || 'unknown'}`, {
          unmintToken: link.mintedToken && !email.uncertain,
        });
      return { ...reverted, channels: sent.channels };
    }

    const finalized = await finalizeHeldRelease({ project, projectCols, ownClaim, channels: sent.channels, customer: ctx.customer, invoice, wdoFiling: pdf.wdoFiling, source, portalAttached: link.portalAttached, link });
    // Still our claim, but the project moved to another customer or invoice after the email: the report stays hidden,
    // its link is taken back, and a person looks (a counted attempt rings the bell).
    if (!finalized && await db('projects').where(ownClaim).first('id')) {
      return revertToHeld('The customer or invoice changed while the report was being sent, so it was not published. Check the account, then press Send report.', { unmintToken: true });
    }
    if (!finalized) {
      logger.error(`[projects] hold release finalize fenced off for ${projectId}: claim superseded, outcome not recorded`);
      return { released: false, reason: 'claim_superseded' };
    }
    await recordHeldRelease({ project, invoice, link, channels: sent.channels, source, actor });
    return {
      released: true, channels: sent.channels, reportUrl: link.reportUrl, reportPath: link.reportPath, token: link.token,
      deliveryStatus: finalizedDeliveryStatus(sent.channels, ctx.customer),
    };
  } catch (err) {
    logger.error(`[projects] hold release failed for ${projectId}: ${err.message}`);
    return await revertToHeld(err.message);
  }
}

// A release's lease: the stale-claim recovery expires report_hold_locked_at, the send takeover expires
// updated_at, so every renewal under the ownership fence moves BOTH.
const RELEASE_LEASE_RENEWAL = () => ({ updated_at: db.fn.now(), report_hold_locked_at: db.fn.now() });

function releaseFilingFields(filing) {
  return filing
    ? { delivery_channels: db.raw("coalesce(delivery_channels, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ release_filing: filing })]) }
    : {};
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// held -> releasing in ONE update, together with the shared delivery claim.
async function claimHeldReportForRelease(projectId) {
  const before = await db('projects').where({ id: projectId }).first('delivery_status');
  const previousDeliveryStatus = before?.delivery_status === 'sending' ? 'failed' : (before?.delivery_status || null);
  const claimToken = crypto.randomBytes(12).toString('hex');
  const claimed = await db('projects')
    .where({ id: projectId, report_hold_status: 'held' })
    .where((q) => q
      .whereRaw("delivery_status IS DISTINCT FROM 'sending'")
      .orWhereRaw("updated_at < now() - interval '10 minutes'"))
    .update({
      report_hold_status: 'releasing',
      report_hold_locked_at: db.fn.now(),
      delivery_status: 'sending',
      delivery_claim_token: claimToken,
      updated_at: db.fn.now(),
    });
  if (!claimed) return null;
  const project = await db('projects').where({ id: projectId }).first();
  return {
    project,
    previousDeliveryStatus,
    attemptsSoFar: Number(project?.report_hold_attempts || 0),
    ownClaim: { id: projectId, report_hold_status: 'releasing', delivery_claim_token: claimToken },
  };
}

// Back to held so the sweep retries, with backoff; the first failure rings the bell.
// `countAttempt: false` is for "not due yet" (invoice not settled).
function makeHeldReverter({ project, claim, ctx, source }) {
  const hold = require('../services/project-report-hold');
  return async function revertToHeld(reason, { countAttempt = true, unmintToken = false } = {}) {
    const { attemptsSoFar, previousDeliveryStatus, ownClaim } = claim;
    const nextAttempts = countAttempt ? attemptsSoFar + 1 : attemptsSoFar;
    const delayMinutes = countAttempt ? hold.reportHoldBackoffMinutes(nextAttempts) : 2;
    const reverted = await db('projects').where(ownClaim).update({
      report_hold_status: 'held',
      report_hold_locked_at: null,
      report_hold_attempts: nextAttempts,
      report_hold_next_attempt_at: new Date(Date.now() + delayMinutes * 60 * 1000),
      // A settlement deferral (the invoice is not paid yet) is not a delivery failure and stores no error: the drawer
      // reads an error as "paid, but the report did not send".
      ...(countAttempt ? { report_hold_last_error: String(reason || 'release failed').slice(0, 500) } : {}),
      delivery_status: previousDeliveryStatus,
      delivery_claim_token: null,
      // The link binding belongs to the link: a link taken back takes its binding with it.
      ...(unmintToken ? { report_token: null } : {}),
      updated_at: db.fn.now(),
    }).catch((err) => logger.warn(`[projects] hold revert failed for ${project.id}: ${err.message}`));
    if (countAttempt && reverted) await ringReleaseFailedOnce({ hold, project, customer: ctx.customer, reason, attemptsSoFar, source });
    return { released: false, reason: String(reason || 'release_failed') };
  };
}

// ONE release-failure bell, rung until an alert is recorded: the attempt count is saved first, so a failed insert (or a
// stop between the writes) must not mean the bell is never raised. A marker on the row says one was recorded. Only
// while the hold is still unreleased: a revert that lost its claim, or a release that finished meanwhile (and closed
// the alert), must not be followed by a new failure alert.
async function ringReleaseFailedOnce({ hold, project, customer, reason, attemptsSoFar, source }) {
  const channelsNow = typeof project.delivery_channels === 'string' ? safeJsonParse(project.delivery_channels) : project.delivery_channels;
  const stillHeld = (await db('projects').where({ id: project.id }).first('report_hold_status'))?.report_hold_status === 'held';
  if (!stillHeld || channelsNow?.release_bell === true) return;
  if (attemptsSoFar === 0) {
    await logProjectActivity(null, project, 'project_report_release_blocked',
      `Paid report release blocked: ${String(reason || 'release failed').slice(0, 200)}`, { source }).catch(() => {});
  }
  if (!(await hold.raiseReleaseFailedBell({ project, customer, reason }))) return;
  const marked = await db('projects').where({ id: project.id, report_hold_status: 'held' }).update({
    delivery_channels: db.raw("coalesce(delivery_channels, '{}'::jsonb) || '{\"release_bell\": true}'::jsonb"),
  }).catch((err) => { logger.warn(`[projects] release bell marker not stored for ${project.id}: ${err.message}`); return null; });
  // A release that finished between the check above and the raise closed its bells BEFORE this one existed. Every
  // releaser closes after its release commits, so the row no longer being held here means this bell is stale: close it
  // (one of the two sides always sees the other).
  if (marked === 0) await hold.closeReleaseFailedBell(project.id);
}


// The held invoice for a staff release: any status (staff release the report before payment). A held report with no
// bound invoice still releases, keyed on no invoice.
async function loadHeldInvoice(project) {
  const row = project.invoice_id ? await db('invoices').where({ id: project.invoice_id }).first().catch(() => null) : null;
  return row || { id: project.invoice_id || null };
}

// Settled money only: 'paid' or credit-covered 'prepaid'. An ACH 'processing'
// invoice, or a part payment, stays held. Returns the invoice or null.
async function loadSettledHoldInvoice(project) {
  const invoice = project.invoice_id
    ? await db('invoices').where({ id: project.invoice_id }).first().catch(() => null)
    : null;
  return invoice && ['paid', 'prepaid'].includes(String(invoice.status || '').toLowerCase()) ? invoice : null;
}

// The same gates as /send. Returns a reason string, or null when the report may go.
// `readinessChecked`: a staff Send report already applied the readiness rules (with an override reason when needed).
async function heldReleaseBlocker(project, customer, { readinessChecked = false, database = undefined } = {}) {
  if (!customer) return 'Customer record missing';
  const sigState = wdoSignatureFreshness(project);
  if (!sigState.signed) return 'Licensee signature required, re-sign to release the paid report';
  if (!sigState.fresh) return 'Findings were edited after signing, the licensee must re-sign to release the paid report';
  // ...and the photo addendum the licensee signed (the PDF builder's own check, run here so a hold is never promised on
  // a report whose paid release would refuse). A photo read that fails throws (fail closed).
  const signedPhotos = sigState.signature.photoSetHash;
  if (signedPhotos && signedPhotos !== wdoPhotoSetHash(await loadWdoAddendumPhotoRows(project, database))) {
    return 'Photos changed after signing, the licensee must re-sign to release the paid report';
  }
  const gateProblem = wdoSectionTwoContradiction(project) || wdoCoreFindingsIncomplete(project);
  if (gateProblem) return gateProblem;
  const readiness = evaluateProjectSendReadiness({ project, customer });
  // Anything /send would need an override reason for (not only the statutory omissions) also stops the automatic
  // release: staff press Send report and give the reason. The first failure rings the one bell.
  if (!readinessChecked && readiness.missing.length > 0) {
    return `Missing details, staff must press Send report and give a reason: ${readiness.missing.map((m) => m.label).join('; ')}`;
  }
  // The address the release really sends to (a service contact who declines email falls back to the holder).
  // `database`: a caller inside a transaction reads the contact's choice on it.
  const emailRecipient = await ProjectEmail.resolveProjectEmailRecipientForSend(customer, { applyReportRule: true, ...(database ? { database } : {}) })
    .catch(() => ({ email: null }));
  // ...and the address-wide rule the email's handoff applies (every contact slot sharing that address): a recipient it
  // would stop never passes here, so a paid release is not blocked on every attempt. Unreadable refuses.
  const accepted = emailRecipient?.email
    && await ProjectEmail.dispatchBoundaryCheck({ recipient: emailRecipient, customerId: customer?.id, database }).catch(() => false)
    // ...and the report email's suppression list (a bounced or unsubscribed address would never get the paid report).
    && !(await ProjectEmail.reportEmailSuppressed(emailRecipient.email, database).catch(() => true));
  return accepted ? null : 'No email on file that accepts email, the FDACS-13645 PDF is delivered by email';
}

// Report link and portal stamps, as /send does (a hold send minted no link).
// Returns { token, refreshed, reportUrl }, { unsettled: true } when the invoice reopened, or null when the claim was lost.
async function stampHeldReportLink({ project, projectCols, ownClaim, customer, invoice, requireSettled = true }) {
  const token = project.report_token || crypto.randomBytes(16).toString('hex');
  const portalAttachment = await resolveProjectPortalAttachment(project).catch((err) => {
    logger.warn(`[projects] portal attachment resolution failed for ${project.id}: ${err.message}`);
    return { portalAttached: false, portalAttachReason: 'resolution_failed', completionProfile: null };
  });
  const profile = portalAttachment.completionProfile;
  const tokenUpdate = { report_token: token, ...RELEASE_LEASE_RENEWAL() };
  // Hidden from the portal until the email is accepted: finalizeHeldRelease shows it (and the visit link) then.
  if (projectCols.portal_visible) tokenUpdate.portal_visible = false;
  if (projectCols.portal_visibility) tokenUpdate.portal_visibility = profile?.portalVisibility || project.portal_visibility || 'token_only';
  if (projectCols.portal_attach_policy) tokenUpdate.portal_attach_policy = profile?.portalAttachPolicy || project.portal_attach_policy || 'active_portal_customer';
  if (projectCols.completion_profile_snapshot && profile) tokenUpdate.completion_profile_snapshot = JSON.stringify(profile);
  // The link is published only while the bound invoice is still settled, read under its row lock in the same
  // transaction: a credit reversal or refund that reopened it during the PDF work keeps the report held.
  const published = await db.transaction(async (trx) => {
    // The invoice first, then the project: the order arming and an account merge take them in. The settled invoice
    // must be this customer's own, and the project still this customer's (the portal decision and the report path
    // above were made for this customer).
    if (requireSettled) {
      const locked = await trx('invoices').where({ id: invoice.id }).forUpdate().first('status', 'customer_id');
      if (!locked || !['paid', 'prepaid'].includes(String(locked.status || '').toLowerCase())) return 'unsettled';
      if (String(locked.customer_id) !== String(customer.id)) return 'owner_mismatch';
    }
    const lockedProject = await trx('projects').where({ ...ownClaim, invoice_id: invoice.id }).forUpdate().first('id', 'customer_id');
    if (!lockedProject || String(lockedProject.customer_id) !== String(customer.id)) return 'lost';
    return (await trx('projects').where({ ...ownClaim, invoice_id: invoice.id }).update(tokenUpdate)) ? 'ok' : 'lost';
  });
  if (published === 'unsettled' || published === 'owner_mismatch') return { refused: published };
  if (published !== 'ok') return null;
  const refreshed = await db('projects').where({ id: project.id }).first();
  const reportPath = await projectReportPathForProject(db, refreshed, customer);
  return {
    token, refreshed, reportPath, portalAttached: portalAttachment.portalAttached, mintedToken: !project.report_token,
    reportUrl: `https://portal.wavespestcontrol.com${reportPath || `/report/project/${token}`}`,
  };
}

// A release that stopped after it archived (and maybe emailed) the filing leaves the reference on the
// row; the retry sends and records THAT filing again, as long as the findings it was built from are
// unchanged. After an edit and re-sign the retry archives anew, and the email key changes with the content.
//
// A stored filing that MATCHES is the one that may already have gone out, so it is never replaced: a read
// failure (or an empty object) throws, the release goes back to held, and the next attempt tries again. Only
// a filing that no longer matches the signature (revision and photo set) or the invoice is archived anew.
async function resumableReleaseFiling(project, invoice) {
  const channels = typeof project.delivery_channels === 'string' ? safeJsonParse(project.delivery_channels) : project.delivery_channels;
  const filing = channels?.release_filing;
  const signature = loadWdoSignature(project);
  if (!filing?.s3_key || filing.invoice_id !== invoice.id || filing.content_hash !== wdoContentHash(project, loadWdoSignature(project)?.feeValues || null)
    || (filing.signed_at ?? null) !== (signature?.signedAt ?? null)
    || (filing.photo_set_hash ?? null) !== (signature?.photoSetHash ?? null)) return null;
  const object = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: filing.s3_key }));
  const buffer = await streamToBuffer(object.Body);
  if (!buffer.length) throw new Error('the archived filing is empty');
  return { buffer, attachment: pdfEmailAttachment('FDACS-13645-WDO-Inspection-Report.pdf', buffer), filing };
}

// The link, filing and recipient a held report's link was first emailed with, or null.
function heldLinkBinding(project) {
  const channels = typeof project.delivery_channels === 'string' ? safeJsonParse(project.delivery_channels) : project.delivery_channels;
  return channels?.release_link_binding || null;
}

// The email key part naming the link a report email carries.
function linkKeyPart(token) {
  return crypto.createHash('sha1').update(String(token || '')).digest('hex').slice(0, 8);
}

// The email key part naming the report email's recipient.
function recipientKeyPart(email) {
  return crypto.createHash('sha1').update(String(email).toLowerCase()).digest('hex').slice(0, 12);
}

// The email key part naming WHICH filing the report email carries: findings, signature revision and photo set.
function filingKeyPart(filing) {
  return crypto.createHash('sha1')
    .update([filing?.content_hash, filing?.signed_at, filing?.photo_set_hash].map((v) => String(v ?? '')).join('|'))
    .digest('hex').slice(0, 8);
}

// Build and archive the FDACS PDF before any channel send (fail closed).
async function buildAndArchiveHeldReportPdf({ project, customer, invoice, source, sentByTechId = null }) {
  try {
    const resumed = await resumableReleaseFiling(project, invoice);
    if (resumed) return { wdoPdf: resumed, wdoFiling: resumed.filing };
    const wdoPdf = await buildWdoPdfAttachment(project, customer);
    const wdoFiling = wdoPdf
      ? await archiveWdoFiling({ project, buffer: wdoPdf.buffer, source: `report_hold_release:${source}`, invoiceId: invoice.id, sentByTechId })
      : null;
    return { wdoPdf, wdoFiling };
  } catch (err) {
    return { error: `FDACS PDF build or archive failed: ${err.message}` };
  }
}

// A held report closed out with no link: the visit's record says so (structured_notes.projectReport, read by the
// customer's service history). When the release publishes the report (automatic or by staff), the record gets
// the link the closeout would have written, on the portal decision made NOW (the closeout's own said "not attached",
// since the report was unsent): the URL for a portal-attached report, else the token alone. Best effort: a failed
// write leaves the visit without its history link, never stops the delivery.
async function restoreHeldVisitReportLink(project, reportPath, portalAttached, database) {
  if (!isReportHeld(project) || !project.service_record_id || !project.report_token) return;
  await database('service_records')
    .where({ id: project.service_record_id })
    .whereRaw("structured_notes->>'projectId' = ?", [String(project.id)])
    .update({
      structured_notes: db.raw(
        "coalesce(structured_notes, '{}'::jsonb) || jsonb_build_object('portalAttached', ?::boolean, 'projectReport', jsonb_build_object('token', ?::text, 'url', ?::text, 'tokenOnly', ?::boolean), 'reportHeld', false, 'projectTitle', ?::text)",
        [Boolean(portalAttached), project.report_token, portalAttached ? (reportPath || null) : null, !portalAttached, project.title || null],
      ),
      // The paid report's recommendations join the visit note the held completion wrote without them
      // (match both the new 'Project completed.' placeholder and legacy 'Project completed: <title>'
      // notes written before B-58, while preserving staff-edited notes).
      technician_notes: db.raw(
        'CASE WHEN technician_notes IS NOT DISTINCT FROM ? OR technician_notes IS NOT DISTINCT FROM ? THEN ? ELSE technician_notes END',
        [
          completionTechnicianNotes(project, { reportHeld: true }),
          project.title
            ? `Project completed: ${redactProjectTitleForWrite(project.title, project.project_type, await resolveProjectRecordedFeeValues(project, database))}`
            : 'Project completed.',
          completionTechnicianNotes(project),
        ],
      ),
    });
}

// The manual send's FDACS PDF, built and archived BEFORE any channel send (fail closed): the PDF *is* the WDO
// deliverable, and the archive is the record of the legal filing actually emailed. (A held report never comes here: it
// sends through the release.) Returns { wdoPdf, wdoFiling }, or { error, logMessage } when nothing may be sent.
async function buildManualSendFiling({ updatedProject, customer, technicianId }) {
  let wdoPdf;
  try {
    wdoPdf = await buildWdoPdfAttachment(updatedProject, customer);
  } catch (e) {
    return { error: 'Could not generate the FDACS report; nothing was sent.', logMessage: e.message };
  }
  if (!wdoPdf) return { wdoPdf: null, wdoFiling: null };
  try {
    const wdoFiling = await archiveWdoFiling({ project: updatedProject, buffer: wdoPdf.buffer, source: 'send', sentByTechId: technicianId || null });
    return { wdoPdf, wdoFiling };
  } catch (e) {
    return { error: 'Could not archive the FDACS filing; nothing was sent.', logMessage: e.message };
  }
}

// The customer email, the realtor copies (after the email) and the courtesy text.
async function sendHeldReport({ link, customer, invoice, wdoPdf, wdoFiling, ownClaim, staffSend = false }) {
  const { channels } = await sendHeldReportEmailAndCopies({ link, customer, invoice, wdoPdf, wdoFiling, ownClaim, staffSend });
  // The FDACS PDF rides on the email only: no text without it.
  if (!channels.email.ok) return { channels: { ...channels, sms: { ok: false, error: 'Skipped — email delivery did not succeed' } } };
  channels.sms = await sendHeldReportTextOnce({ project: link.refreshed, customer, invoice, reportUrl: link.reportUrl, wdoFiling, ownClaim, requireSettled: !staffSend });
  return { channels };
}

// ONE locked pre-send check for every leg of a held report's release (the email, each requestor copy, the text),
// run inside that leg's provider handoff and held until the provider request returns. Lock order is the one an
// account merge takes (customers, then the rows that point at them): the customer-comms advisory lock (plus the
// phone lock for the text), the customer rows FOR SHARE, the bound invoice FOR SHARE, the project FOR SHARE last.
// It checks: the customer is still a live row; for the automatic release, the invoice is still settled and still
// billed to the same account; the project still holds this attempt's claim, still belongs to the customer, and was
// not recorded as sent another way. `check(trx, fresh)` is the leg's own target check. Any failed read blocks.
async function heldReleaseAuthority(trx, { customerId, invoice, ownClaim, requireSettled }) {
  const customer = await loadProjectCustomer(customerId, { strict: true, database: trx, forShare: true });
  if (!customer || customer.deleted_at) return { block: 'REPORT_OWNER_CHANGED' };
  if (requireSettled) {
    const inv = await trx('invoices').where({ id: invoice.id }).forShare().first('status', 'customer_id');
    // The paid invoice is this customer's own (not just unchanged since an earlier read of it).
    if (!inv || !['paid', 'prepaid'].includes(String(inv.status || '').toLowerCase())
      || String(inv.customer_id) !== String(customerId)) return { block: 'HELD_INVOICE_UNSETTLED' };
  }
  const project = await trx('projects').where(ownClaim).forShare().first();
  if (!project || String(project.customer_id) !== String(customerId) || project.sent_outside_portal_at) {
    return { block: 'REPORT_OWNER_CHANGED' };
  }
  // ...and the invoice the report is held on is still that settled invoice.
  if (requireSettled && String(project.invoice_id || '') !== String(invoice.id)) return { block: 'HELD_INVOICE_UNSETTLED' };
  return { customer, project };
}

// The handoff for an EMAIL leg (the report email or one requestor copy): `state.boundaryBlock` names a refusal.
function heldReportEmailLegHandoff({ customerId, invoice, ownClaim, requireSettled, state, check }) {
  const { withCustomerCommsLock } = require('../utils/customer-comms-lock');
  return async (dispatch) => {
    let dispatched = false;
    try {
      return await withCustomerCommsLock(db, customerId, async (trx) => {
        const fresh = await heldReleaseAuthority(trx, { customerId, invoice, ownClaim, requireSettled });
        const block = fresh.block || (await check(trx, fresh));
        if (block) {
          state.boundaryBlock = { code: block };
          return { ok: false };
        }
        dispatched = true;
        await dispatch(trx);
        return { ok: true };
      });
    } catch (err) {
      if (dispatched) throw err;
      state.boundaryBlock = { code: 'HELD_RELEASE_READ_FAILED' };
      return { ok: false };
    }
  };
}

const normEmail = (email) => String(email || '').trim().toLowerCase();

// The report email: still the send-time recipient (a corrected email during the PDF work refuses; the release
// retries with the new one).
function heldReportRecipientHandoff({ customerId, expectedEmail, state, ownClaim, invoice, requireSettled }) {
  return heldReportEmailLegHandoff({
    customerId, invoice, ownClaim, requireSettled, state,
    check: async (trx, fresh) => {
      const now = await ProjectEmail.resolveProjectEmailRecipientForSend(fresh.customer, { applyReportRule: true, database: trx });
      if (!now?.email || normEmail(now.email) !== normEmail(expectedEmail)) return 'REPORT_RECIPIENT_CHANGED';
      // ...and the address-wide rule under the same locks: another contact slot sharing the address that declined email
      // since the queue check stops the PDF here.
      return await ProjectEmail.dispatchBoundaryCheck({ recipient: now, customerId, database: trx }) ? null : 'REPORT_RECIPIENT_DECLINED';
    },
  });
}

// One requestor copy: the address is still named on the form as it is now, and is not the report's recipient.
function heldReportCopyHandoff({ customerId, copyEmail, primaryEmail, state, ownClaim, invoice, requireSettled }) {
  return heldReportEmailLegHandoff({
    customerId, invoice, ownClaim, requireSettled, state,
    check: async (_trx, fresh) => (
      wdoReportCopyEmails(parseFindings(fresh.project), [primaryEmail]).map(normEmail).includes(normEmail(copyEmail))
        ? null : 'REPORT_COPY_REMOVED'
    ),
  });
}

// What staff read when an earlier report email's outcome is unknown.
function heldUnknownOutcomeMessage(staffSend) {
  return staffSend
    ? 'The report email may or may not have arrived. Check with the customer. If they did not get it, press Send report again to send a new copy.'
    : 'The last report email may or may not have arrived. Check with the customer, then press Send report to send a new copy.';
}

// A held report's email and requestor copies, the same for the automatic release and a manual Send report: one
// send-time recipient, one key per invoice + filing + recipient, and only that recipient left out of the copies.
//
// staffSend (a manual Send report): an earlier report email whose outcome stayed unknown holds its key for good (the
// library refuses to guess). Staff pressing Send report is the approval for a fresh copy: the key moves on, as after a
// block, and the next attempt (this button again, or the sweep) sends a new one. The sweep alone never does.
// The report email's key: the release, its invoice, the filing it carries, the recipient (a corrected address mints a
// new key), and a counter that moves only on proof that nothing reached the customer (heldReportEmailOutcome). An
// earlier email of unknown outcome keeps its key for the automatic retry; a staff press after that, once staff have
// checked with the customer, moves the counter first: a new copy.
async function heldReportEmailKey({ refreshed, invoice, wdoFiling, recipientEmail, ownClaim, staffSend }) {
  const recipientHash = recipientKeyPart(recipientEmail);
  // ...and the link it carries: a link taken back after a refusal before dispatch and minted again is a different email.
  const linkHash = linkKeyPart(refreshed.report_token);
  const stored = typeof refreshed.delivery_channels === 'string' ? safeJsonParse(refreshed.delivery_channels) : refreshed.delivery_channels;
  const newCopyApproved = staffSend && stored?.release_email_unknown === true;
  if (newCopyApproved) {
    await db('projects').where(ownClaim).update({
      delivery_channels: db.raw("(coalesce(delivery_channels, '{}'::jsonb) - 'release_email_unknown') || jsonb_build_object('release_email_blocks', coalesce((delivery_channels->>'release_email_blocks')::int, 0) + 1)"),
    });
  }
  const blocks = (Number(stored?.release_email_blocks) || 0) + (newCopyApproved ? 1 : 0);
  const invoicePart = String(invoice.id).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 40);
  return `project.report_ready:${refreshed.id}:hold_release:${invoicePart}:${filingKeyPart(wdoFiling)}:${recipientHash}:${linkHash}${blocks ? `:b${blocks}` : ''}`;
}

// What the report email's result means, and the mark it leaves on the row:
// - unknown: the first attempt's timeout after the handoff (deliveryOutcome 'uncertain'), or any hold the library puts
//   on an earlier attempt with this key (ambiguous, exhausted, in progress after a crash, scheduled). Link and key stay.
// - unsettled: the handoff refused because the invoice is no longer settled. Correctly held again: no mark.
// - rekey: proof nothing reached the customer, a refusal (blocked) or this key's bounced or dropped ledger row (deduped).
// - keep: a plain error. The key stays: an earlier attempt with it may have been accepted, and the next retry finds it.
const HELD_EMAIL_OUTCOME_MARKS = {
  rekey: "coalesce(delivery_channels, '{}'::jsonb) || jsonb_build_object('release_email_blocks', coalesce((delivery_channels->>'release_email_blocks')::int, 0) + 1)",
  unknown: "coalesce(delivery_channels, '{}'::jsonb) || '{\"release_email_unknown\": true}'::jsonb",
};
function heldReportEmailOutcome(result, handoffState) {
  if (result.ok) return 'ok';
  if (!result.blocked && (result.deliveryOutcome === 'uncertain' || /email send held by provider_retry_/.test(String(result.error || '')))) return 'unknown';
  if (handoffState.boundaryBlock?.code === 'HELD_INVOICE_UNSETTLED') return 'unsettled';
  return result.blocked || result.deduped ? 'rekey' : 'keep';
}

async function sendHeldReportEmail({ refreshed, reportUrl, customer, invoice, wdoPdf, wdoFiling, ownClaim, staffSend, emailRecipient }) {
  const handoffState = { boundaryBlock: null };
  // A link belongs to the first filing and recipient it was emailed with (bound under the claim BEFORE the dispatch, so a
  // crash after the provider accepted the email still leaves the binding). A changed filing (an edit and re-sign) or
  // address never goes out on that link, since the earlier recipient may hold it: the release takes the link back and
  // the next attempt mints a new one. The binding names its link, so one left from a link taken back binds nothing.
  const linkBinding = `${linkKeyPart(refreshed.report_token)}:${filingKeyPart(wdoFiling)}:${recipientKeyPart(emailRecipient.email)}`;
  const bound = heldLinkBinding(refreshed);
  if (bound && bound !== linkBinding && bound.startsWith(`${linkKeyPart(refreshed.report_token)}:`)) {
    return { ok: false, relink: true, error: 'The report or its email address changed after an earlier email with this link. A new link is sent on the next try.' };
  }
  if (bound !== linkBinding) {
    const written = await db('projects').where(ownClaim).update({
      delivery_channels: db.raw("coalesce(delivery_channels, '{}'::jsonb) || jsonb_build_object('release_link_binding', ?::text)", [linkBinding]),
    });
    if (!written) return { ok: false, error: 'This release no longer owns the report. Nothing was sent.' };
  }
  const result = await ProjectEmail.sendProjectReportReady({
    project: refreshed,
    customer,
    reportUrl,
    isResend: false,
    recipient: emailRecipient,
    handoffState,
    withProviderHandoff: heldReportRecipientHandoff({ customerId: customer.id, expectedEmail: emailRecipient.email, state: handoffState, ownClaim, invoice, requireSettled: !staffSend }),
    attachments: wdoPdf ? [wdoPdf.attachment] : [],
    idempotencyKey: await heldReportEmailKey({ refreshed, invoice, wdoFiling, recipientEmail: emailRecipient.email, ownClaim, staffSend }),
  });
  const outcome = heldReportEmailOutcome(result, handoffState);
  if (HELD_EMAIL_OUTCOME_MARKS[outcome]) {
    await db('projects').where(ownClaim).update({ delivery_channels: db.raw(HELD_EMAIL_OUTCOME_MARKS[outcome]) })
      .catch((err) => logger.warn(`[projects] release email outcome (${outcome}) not recorded for ${refreshed.id}: ${err.message}`));
  }
  if (outcome === 'ok') return { ok: true, messageId: result.messageId || null };
  return {
    ok: false, uncertain: outcome === 'unknown', unsettled: outcome === 'unsettled',
    error: outcome === 'unknown' ? heldUnknownOutcomeMessage(staffSend) : projectEmailFailureMessage(result),
  };
}

async function sendHeldReportEmailAndCopies({ link, customer, invoice, wdoPdf, wdoFiling, ownClaim, staffSend = false }) {
  const { refreshed, reportUrl } = link;
  const channels = {};
  // ONE send-time recipient (the service contact falls back to the account holder when it declines email): it
  // receives the email, keys the retry, and is left out of the realtor copies. A failed lookup fails the email.
  let emailRecipient = { email: '' };
  try {
    emailRecipient = await ProjectEmail.resolveProjectEmailRecipientForSend(customer, { applyReportRule: true });
    channels.email = await sendHeldReportEmail({ refreshed, reportUrl, customer, invoice, wdoPdf, wdoFiling, ownClaim, staffSend, emailRecipient });
  } catch (err) {
    channels.email = { ok: false, error: err.message };
  }
  if (!channels.email.ok) return { channels };

  // Only the address that receives the report is excluded: the billing contact and the account email
  // got the invoice alone, so a named requestor at either still needs the report.
  const copies = await sendWdoReportCopies({
    req: null,
    project: refreshed,
    customer,
    reportUrl,
    attachment: wdoPdf ? wdoPdf.attachment : null,
    excludeEmails: [emailRecipient.email],
    isResend: false,
    // each copy is keyed to the filing and the link it carries, so a corrected filing or a new link after a retry
    // reaches the requestors (a taken-back link would otherwise stay their only one)
    keyPart: `release:${filingKeyPart(wdoFiling)}:${linkKeyPart(refreshed.report_token)}`,
    ownClaim,
    copyHandoff: (copyEmail, state) => heldReportCopyHandoff({
      customerId: customer.id, copyEmail, primaryEmail: emailRecipient.email, state, ownClaim, invoice, requireSettled: !staffSend,
    }),
  });
  if (copies) channels.report_copies = copies;
  return { channels };
}

// The text has no provider-side dedupe, so the leg is claimed on the row (per invoice and filing) BEFORE it is
// dispatched, fenced on the release claim: a retry after a crash finds the mark and never texts twice. The text
// is at-most-once: a crash between the mark and the provider loses a courtesy copy, never repeats it.
async function sendHeldReportTextOnce({ project, customer, invoice, reportUrl, wdoFiling, ownClaim, requireSettled }) {
  // ...per invoice, filing and link: a new link (the old one taken back) is texted again.
  const mark = `${invoice.id}:${filingKeyPart(wdoFiling)}:${linkKeyPart(project.report_token)}`;
  const stored = typeof project.delivery_channels === 'string' ? safeJsonParse(project.delivery_channels) : project.delivery_channels;
  if (stored?.release_sms === mark) return { ok: true, deduped: true };
  const claimed = await db('projects').where(ownClaim).update({
    ...RELEASE_LEASE_RENEWAL(),
    delivery_channels: db.raw("coalesce(delivery_channels, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ release_sms: mark })]),
  });
  if (!claimed) return { ok: false, error: 'Text not sent: the release claim was lost' };
  // The phone as it is NOW (a number corrected during the PDF and email work gets the text), then held to the provider
  // request by the locked handoff.
  const current = await loadProjectCustomer(customer.id, { strict: true }).catch(() => null);
  if (!current || current.deleted_at) return { ok: false, error: 'Text not sent: the customer could not be read' };
  const sent = await sendHeldReportText({ project, customer: current, invoice, reportUrl, ownClaim, requireSettled });
  // A text that definitely did not go (a number corrected at the last moment, quiet hours, a block) gives its mark
  // back, so the next attempt can text the right number. Only an unknown outcome keeps it (never texts twice).
  if (!sent.ok && sent.notSent) {
    await db('projects').where(ownClaim).update({ delivery_channels: db.raw("delivery_channels - 'release_sms'") })
      .catch((err) => logger.warn(`[projects] release text mark not returned for ${project.id}: ${err.message}`));
  }
  return sent;
}

// The release text's provider handoff: the bearer link goes only to the number on the customer row as it is at the
// request, under the customer-comms and phone locks and the same locked check as the email legs.
function heldReportSmsHandoff({ customerId, phone, ownClaim, invoice, requireSettled }) {
  const { withSmsConsentLock } = require('../utils/customer-comms-lock');
  const refused = { ok: false, code: 'RECIPIENT_CHANGED', reason: 'recipient_changed', retryable: false };
  return async (dispatch) => {
    let dispatched = false;
    try {
      return await withSmsConsentLock(db, { phone, customerId }, async (trx) => {
        const fresh = await heldReleaseAuthority(trx, { customerId, invoice, ownClaim, requireSettled });
        if (fresh.block || normalizeUsPhone(fresh.customer.phone) !== phone) return refused;
        dispatched = true;
        return dispatch(trx);
      });
    } catch (err) {
      if (dispatched) throw err;
      return refused;
    }
  };
}

// The text is a courtesy copy of the link: a blocked or quiet-hours text
// never undoes a delivered report.
async function sendHeldReportText({ project, customer, invoice, reportUrl, ownClaim, requireSettled }) {
  const normalizedPhone = normalizeUsPhone(customer.phone);
  if (!normalizedPhone) {
    return { ok: false, error: customer.phone ? `Invalid phone format: ${customer.phone}` : 'No phone on file' };
  }
  try {
    const smsBody = await renderRequiredSmsTemplate('project_report_ready', {
      first_name: customer.first_name || 'there',
      project_type: getProjectType(project.project_type)?.label || 'Service',
      report_url: reportUrl,
    }, { workflow: 'project_report_ready', entity_type: 'project', entity_id: project.id });
    const result = await sendCustomerMessage({
      to: normalizedPhone,
      body: smsBody,
      channel: 'sms',
      audience: 'customer',
      purpose: 'support_resolution',
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'project_report_hold_release',
      metadata: { original_message_type: 'project_report', project_id: project.id, invoice_id: invoice.id },
      withSmsHandoff: heldReportSmsHandoff({ customerId: customer.id, phone: normalizedPhone, ownClaim, invoice, requireSettled }),
    });
    if (result.sent) return { ok: true };
    const { classifyDeliveryCertainty } = require('../services/messaging/send-customer-message');
    return { ok: false, error: result.reason || result.code || 'SMS send blocked/failed', notSent: classifyDeliveryCertainty(result) === 'not_sent' };
  } catch (err) {
    return { ok: false, error: err.message, notSent: false };
  }
}

// The released stamp, fenced on the claim. False when a stale takeover owns the row now.
// A failed requestor copy (the realtor or title company named on the form) makes the release partial, so the drawer
// shows it: the hold is released and nothing retries a copy.
function finalizedDeliveryStatus(channels, customer) {
  const successful = [channels.email, channels.sms, channels.report_copies].filter((c) => c?.ok).length;
  const available = 1 + (customer?.phone ? 1 : 0) + (channels.report_copies ? 1 : 0);
  return successful >= available ? 'sent' : 'partial';
}

// The release and the visit history link commit together: a stop or an error between them rolls both back, so the
// release runs again (the email, copies and text are once-only by key and mark) and writes both.
async function finalizeHeldRelease({ project, projectCols, ownClaim, channels, customer, invoice, wdoFiling, source, portalAttached = false, link = null }) {
  const filingAppend = wdoFiling && projectCols.wdo_sent_filings
    ? { wdo_sent_filings: db.raw("coalesce(wdo_sent_filings, '[]'::jsonb) || ?::jsonb", [JSON.stringify([wdoFiling])]) }
    : {};
  return db.transaction(async (trx) => {
    const written = await finalizeHeldReleaseRow(trx, { project, projectCols, ownClaim, channels, customer, invoice, source, portalAttached, filingAppend });
    if (written && link) await restoreHeldVisitReportLink(link.refreshed, link.reportPath, portalAttached, trx);
    return written;
  });
}

function finalizeHeldReleaseRow(trx, { project, projectCols, ownClaim, channels, customer, invoice, source, portalAttached, filingAppend }) {
  // ...and only while the project still belongs to the customer and the invoice the email's handoff verified: an
  // account merge after the handoff must never publish the old recipient's link under the new owner.
  return trx('projects').where(ownClaim).where({ customer_id: customer.id, invoice_id: invoice.id }).update({
    status: SENT_UNLESS_CLOSED(),
    sent_at: project.sent_at || db.fn.now(),
    last_delivery_at: db.fn.now(),
    delivery_channels: channels,
    delivery_status: finalizedDeliveryStatus(channels, customer),
    delivery_claim_token: null,
    report_hold_next_attempt_at: null,
    // The portal shows the report from the write that records it delivered.
    ...(projectCols.portal_visible ? { portal_visible: Boolean(portalAttached) } : {}),
    ...heldReportReleaseFields(source),
    updated_at: db.fn.now(),
    ...filingAppend,
  });
}

async function recordHeldRelease({ project, invoice, link, channels, source, actor = null }) {
  const hold = require('../services/project-report-hold');
  const typeLabel = getProjectType(link.refreshed.project_type)?.label || 'Service';
  // The bell first, and the log best effort: the report is delivered and recorded, so nothing here may undo that
  // or leave the "send the paid report" bell open.
  await hold.closeReleaseFailedBell(project.id);
  await logProjectActivity(actor, project, source === 'manual_send' ? 'project_report_sent' : 'project_report_released_after_payment',
    source === 'manual_send'
      ? `Held report sent by staff: ${typeLabel}`
      : `Paid report released: ${typeLabel} (invoice ${invoice.invoice_number || invoice.id} paid)`,
    { report_token_prefix: String(link.token).slice(0, 6), invoice_id: invoice.id, channels, source }).catch(() => {});
  logger.info(`[projects] hold release delivered ${project.id} source=${source} email=${channels.email.ok} sms=${channels.sms?.ok}`);
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
      ? await loadProjectCustomer(project.customer_id)
      : null;
    const [baseApplicator, photoRows] = await Promise.all([
      resolveProjectApplicator(project),
      loadWdoAddendumPhotoRows(project),
    ]);
    // Never stamp a signature onto content that isn't sendable — even in this
    // admin preview, which can be downloaded and filed manually. Render unsigned
    // when the signature is stale (findings hash, mutation flag, OR photo-set
    // hash — the same checks the send choke point enforces) or when the
    // Section 2 hard gates (contradiction / incomplete) would 422 the send,
    // so a downloadable preview can't become a signed FDACS filing that the
    // send routes themselves refuse to emit.
    const { fresh, signature } = wdoSignatureFreshness(project);
    const photosFresh = !signature?.photoSetHash
      || signature.photoSetHash === wdoPhotoSetHash(photoRows);
    const sendBlocked = wdoSectionTwoContradiction(project) || wdoCoreFindingsIncomplete(project);
    const stampSignature = (fresh && photosFresh && !sendBlocked) ? signature : null;
    const photos = await loadWdoAddendumPhotos(project, photoRows);
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
// A valid PNG/JPEG can still be a blank (all-white or fully transparent) canvas,
// which would flip the WDO send gate to "signed" and emit an officially signed
// FDACS-13645 with no actual signature. parseSignatureImage (services/
// signature-image.js, shared with the customer contract signature pad) refuses
// any image with ~zero variance on every channel, an oversized body, or one
// that is not a real PNG/JPEG — while the signer is still holding the pen
// instead of at send time.
const { parseSignatureImage } = require('../services/signature-image');

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

    // Type, size (2MB), magic bytes and visible ink, with the same answers as before.
    const parsed = await parseSignatureImage(req.body?.signature);
    if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) });

    const applicator = await resolveProjectApplicator(project);
    const feeValues = await resolveProjectRecordedFeeValues(project);
    const signature = {
      image: parsed.image,
      content_type: parsed.contentType,
      signer_name: String(req.body?.signer_name || applicator.name || '').trim().slice(0, 120),
      signer_id_card: String(req.body?.signer_id_card || applicator.idCardNo || '').trim().slice(0, 60),
      attestation: String(req.body?.attestation || 'I certify I performed this inspection and the findings are accurate.').trim().slice(0, 500),
      signed_at: new Date().toISOString(),
      signed_by_tech_id: req.technicianId || null,
      fee_values: feeValues,
      // Binds the signature to the content it attests — the send gates
      // recompute this hash and refuse to stamp if findings/project_date
      // changed after signing (the licensee must re-sign).
      content_hash: wdoContentHash(project, feeValues),
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

    // Serialized with photo mutations and sends: the write locks the project
    // row (photo transactions hold the same lock) and rejects mid-send, and
    // the photo-set hash is computed INSIDE the lock — so the signature
    // records exactly the addendum that exists at the moment it lands, and a
    // photo change racing this save can't be silently covered (the PDF choke
    // point re-verifies the hash) nor erase a stale flag it never saw.
    try {
      await db.transaction(async (trx) => {
        // Same lock/guard as photo mutations — including the crashed-claim
        // recovery, so a dead send can't block re-signing indefinitely.
        await lockProjectForPhotoMutation(project, trx, 'the signature');
        signature.photo_set_hash = wdoPhotoSetHash(await loadWdoAddendumPhotoRows(project, trx));
        await trx('projects').where({ id: project.id }).update({ wdo_signature: JSON.stringify(signature), updated_at: db.fn.now() });
      });
    } catch (e) {
      if (e.code === 'send_in_progress') return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
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
      // Same lock + in-flight-delivery guard as capture and photo mutations:
      // clearing mid-send would revoke a signature the send already
      // validated; the locked row (not the request snapshot) is what gets
      // logged, so a concurrently saved replacement is never misattributed.
      let prior = null;
      try {
        await db.transaction(async (trx) => {
          const locked = await lockProjectForPhotoMutation(project, trx, 'the signature change');
          prior = loadWdoSignature(locked || project);
          await trx('projects').where({ id: project.id }).update({ wdo_signature: null, updated_at: db.fn.now() });
        });
      } catch (e) {
        if (e.code === 'send_in_progress') return res.status(409).json({ error: e.message, code: e.code });
        throw e;
      }
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
// POST /api/admin/projects/:id/mark-sent-outside — "Sent another way".
// Admin-only. Records that
// a signed WDO report went out by some route other than the portal, so the
// nightly attention sweep stops flagging it. Records only: no customer
// message, no email, no filing archive, and sent_at stays NULL.
// Body: { note? } (trimmed, max 500 characters).
// ---------------------------------------------------------------------------
function buildMarkSentOutsideUpdate(trx, locked, { technicianId, note }) {
  const hasHoldColumns = 'report_hold_status' in locked;
  const hasDeliveryColumns = 'delivery_status' in locked;
  const query = trx('projects')
    .where({ id: locked.id, project_type: 'wdo_inspection' })
    .whereNotNull('wdo_signature')
    .whereNull('sent_at')
    .whereNull('sent_outside_portal_at');
  if ('status' in locked) query.whereRaw("status IS DISTINCT FROM 'sent'");
  // Not while a portal /send or /send-with-invoice holds an active send claim
  // (a crashed >10m claim can be superseded, mirroring the send routes).
  if (hasDeliveryColumns) {
    query.where((q) => q
      .whereRaw("delivery_status IS DISTINCT FROM 'sending'")
      .orWhereRaw("updated_at < now() - interval '10 minutes'"));
  }
  // Not while a held report is being sent (the release, automatic or by staff, is its one sender).
  if (hasHoldColumns) query.whereRaw("coalesce(report_hold_status, '') <> 'releasing'");
  const patch = {
    sent_outside_portal_at: db.fn.now(),
    sent_outside_portal_by: technicianId || null,
    sent_outside_portal_note: note || null,
    // Clear any stale crashed send claim we just superseded so the row never stays 'sending'.
    ...(hasDeliveryColumns && String(locked.delivery_status || '') === 'sending'
      ? { delivery_status: 'failed', delivery_claim_token: null }
      : {}),
    // A report held until paid that went out another way must not be sent again when it is paid: decided
    // on the row as the update sees it, so a hold armed after the read above is released too.
    ...(hasHoldColumns ? heldReleaseFieldsInSql('sent_outside') : {}),
  };
  return query.update(patch).returning(['sent_outside_portal_at', 'sent_outside_portal_by', 'sent_outside_portal_note']);
}

router.post('/:id/mark-sent-outside', requireAdmin, async (req, res, next) => {
  try {
    const rawNote = req.body?.note;
    if (rawNote != null && typeof rawNote !== 'string') return res.status(400).json({ error: 'note must be text' });
    const note = String(rawNote || '').trim();
    if (note.length > MARK_SENT_OUTSIDE_NOTE_MAX) {
      return res.status(400).json({ error: `note must be ${MARK_SENT_OUTSIDE_NOTE_MAX} characters or fewer` });
    }

    // Lock the project row FOR UPDATE before reading send/hold state and
    // writing sent_outside_portal_at, preventing a race against an in-flight
    // /send or /send-with-invoice delivery claim (B-47).
    const outcome = await db.transaction(async (trx) => {
      const locked = await trx('projects').where({ id: req.params.id }).forUpdate().first();
      if (!locked) return { notFound: true };
      const blocked = markSentOutsideBlock(locked);
      if (blocked) return { blocked };

      const rows = await buildMarkSentOutsideUpdate(trx, locked, { technicianId: req.technicianId, note });
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return { stateChanged: true };
      await recordAuditEvent({
        actor_type: 'technician',
        actor_id: req.technicianId || null,
        action: 'wdo.report_marked_sent_outside',
        resource_type: 'project',
        resource_id: locked.id,
        metadata: { customer_id: locked.customer_id || null, note: note || null },
        ip_address: req.ip || null,
        user_agent: req.headers?.['user-agent'] || null,
        critical: true,
        trx,
      });
      return { project: locked, updated: row };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Project not found' });
    if (outcome.blocked) return res.status(409).json(outcome.blocked);
    if (outcome.stateChanged) {
      return res.status(409).json({ code: 'state_changed', error: 'The report changed while you were marking it. Reload and check.' });
    }
    const { project, updated } = outcome;

    // Unconditionally: a hold armed after the read above was released by the same write, and its bells are answered.
    await require('../services/project-report-hold').closeReleaseFailedBell(project.id);
    await logProjectActivity(req, project, 'project_wdo_marked_sent_outside', 'WDO report marked as sent another way (outside the portal)', {
      has_note: Boolean(note),
    });
    res.json({
      ok: true,
      sent_outside_portal_at: updated.sent_outside_portal_at,
      sent_outside_portal_by: updated.sent_outside_portal_by,
      sent_outside_portal_note: updated.sent_outside_portal_note,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// send-with-invoice: report hold steps (GATE_WDO_REPORT_HOLD). The route calls
// these so a held send and a normal send share one flow; `hold` is
// { active, requested, wasHeld } from createSendHold. Behavior is unchanged
// from the inline version these replaced.
// ---------------------------------------------------------------------------

// The hold intent. Prepare mode carries it too, so the hold's checks (the preflight, and the payer check where a
// draft would be created) run before a draft is made; preparation still never arms a hold (it answers before any
// stamp) and sends nothing.
function sendHoldFlag(body) {
  return body?.hold_report_until_paid === true || body?.hold_report_until_paid === 'true';
}

// Answers the request and returns true when the hold cannot be armed (no invoice needed yet).
// A combined send's delivery claim: a held send never takes a release's claim; a plain send claims no report that is
// held or being released.
const SEND_CLAIM_HOLD_EXCLUSION = {
  true: "coalesce(report_hold_status, '') <> 'releasing'",
  false: "coalesce(report_hold_status, '') NOT IN ('held', 'releasing')",
};

// The recipient a combined send's customer email goes to: a held send uses the billing email authority's recipient.
function combinedSendEmailRecipient(hold, customer, invoice) {
  return hold.active
    ? heldInvoiceEmailRecipient(customer, invoice)
    : ProjectEmail.resolveProjectEmailRecipient(customer, { applyReportRule: true });
}

const HOLD_USE_SEND_REPORT = { status: 409, code: 'hold_use_send_report', error: 'This report is held until the invoice is paid. Press Send report to send it now, or re-send the held invoice.' };
const HOLD_INVOICE_REQUIRED = { status: 422, code: 'hold_invoice_required', error: 'A held send needs the invoice the operator confirmed. Prepare the invoice first.' };

async function holdRequestRefused(res, { project, customer, holdRequested, needsConfirmedInvoice }) {
  // The ONE preflight, before any invoice is created: the link, the release readiness and the credit balance (the
  // payer is checked where a draft would be created, and the payment evidence on the resolved invoice below).
  // The arming transaction judges the same things again under the locks.
  // A held report goes out only through the release (Send report), never inside a plain report + invoice send. A held
  // send bills an invoice that already exists (the drawer prepares the draft first and the operator confirms ITS
  // amount): it never creates the invoice itself, so the amount confirmed is the amount sent.
  let refusal = (!holdRequested && isReportHeld(project) && HOLD_USE_SEND_REPORT) || null;
  if (holdRequested) {
    refusal = await reportHoldRequestRefusal(project, await db('projects').columnInfo().catch(() => ({})), customer);
    if (!refusal && await require('../services/project-report-hold').customerHasCredit(project.customer_id)) {
      refusal = { status: 409, code: 'hold_has_credit', error: 'This customer has account credit, which would settle the invoice before the report is held. Use Send report + invoice.' };
    }
  }
  refusal = refusal || (holdRequested && needsConfirmedInvoice && HOLD_INVOICE_REQUIRED) || null;
  if (refusal) res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
  return Boolean(refusal);
}

// Answers the request and returns true when the resolved invoice cannot carry a hold.
async function holdInvoiceRefused(res, invoice, hold) {
  let refusal = hold.requested ? reportHoldInvoiceRefusal(invoice, hold) : null;
  if (!refusal && hold.requested) {
    // Payment evidence on the resolved invoice (the arming transaction reads it again under the invoice lock).
    refusal = await require('../services/project-report-hold').assertNoPaymentStarted(invoice).then(() => null, (err) => {
      if (!err.holdRefusal) throw err;
      return { ...err.holdRefusal, error: err.message };
    });
  }
  if (refusal) res.status(refusal.status).json({ error: refusal.error, code: refusal.code, invoice_id: invoice.id });
  return Boolean(refusal);
}

// Dry run keys (only while the gate is on, for a WDO): whether this send could hold the report.
async function holdDryRunKeys({ holdRequested, isWdoProject, project, invoice, isPayerBilledPreview, customer }) {
  if (!wdoReportHoldLive() || !isWdoProject) return {};
  const available = (await reportHoldRequestRefusal(project, await db('projects').columnInfo().catch(() => ({})), customer)) === null
    && !(await require('../services/project-report-hold').customerHasCredit(project.customer_id))
    && !isPayerBilledPreview && !invoice.payer_statement_id && Number(invoice.total) > 0;
  const keys = { report_hold: holdRequested, report_hold_available: available };
  if (!holdRequested) return keys;
  // Who gets the report once it is paid: the release's own recipient and exclusion rule (sendHeldReport), so the
  // confirm shows the addresses payment will email, before anyone authorizes the hold.
  return { ...keys, report_hold_release: await heldReleaseRouting(customer, project) };
}

// Who a held report's release emails: the send-time recipient and the named requestors with only that recipient left
// out (the rule sendHeldReportEmailAndCopies applies). The previews of both sends show it.
async function heldReleaseRouting(customer, project) {
  const recipient = await ProjectEmail.resolveProjectEmailRecipientForSend(customer || {}, { applyReportRule: true }).catch(() => null);
  return { recipient: recipient?.email || null, copies: wdoReportCopyEmails(parseFindings(project), [recipient?.email]) };
}

// The manual Send report preview: a held WDO report shows the release's own routing (it sends through the release
// step); any other report the plain send's recipient and copies (recipient, account email and billing left out).
async function manualSendPreviewRouting(customer, project) {
  // Every held report previews the release's recipients (an invoice deleted since arming included): the release sends it.
  if (project.project_type === 'wdo_inspection' && isReportHeld(project)) {
    const { recipient, copies } = await heldReleaseRouting(customer, project);
    return { recipient, report_copies: copies };
  }
  const previewRecipient = ProjectEmail.resolveProjectEmailRecipient(customer || {}, { applyReportRule: true });
  let previewCopies = [];
  if (project.project_type === 'wdo_inspection') {
    const prefs = customer
      ? await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null)
      : null;
    const [billing] = getInvoiceEmailRecipients(customer || {}, prefs || {});
    previewCopies = wdoReportCopyEmails(parseFindings(project), [previewRecipient.email, customer?.email, billing?.email]);
  }
  return { recipient: previewRecipient.email || null, report_copies: previewCopies };
}

function createSendHold(project, holdRequested) {
  // boundInvoiceId is read BEFORE the invoice is resolved: resolving may persist a link, and an active
  // hold must stay on the invoice the customer was sent.
  return {
    active: holdRequested,
    requested: holdRequested,
    wasHeld: String(project.report_hold_status || '') === 'held',
    boundInvoiceId: project.invoice_id || null,
  };
}

// A hold stamps the hold, never a report link: the project has no token (the hold refuses one that exists) and no
// portal visibility until the release. The
// stamp comes BEFORE any customer message, so a crash after the invoice went out still leaves
// a held report for the sweep, never a customer told "after payment" with nothing waiting.
function selectSendStamp(hold, invoice, tokenUpdate) {
  if (!hold.active) return tokenUpdate;
  return {
    invoice_id: invoice.id,
    updated_at: db.fn.now(),
    // One held invoice send per confirmation: the count moves with every send that arms, and the operator's
    // fingerprint names the count it saw, so a replayed request (a lost response) refuses instead of sending again.
    delivery_channels: db.raw("coalesce(delivery_channels, '{}'::jsonb) || jsonb_build_object('held_invoice_sends', coalesce((delivery_channels->>'held_invoice_sends')::int, 0) + 1)"),
    ...(hold.wasHeld ? {} : {
      report_hold_status: 'held',
      report_hold_at: db.fn.now(),
      report_hold_released_at: null,
      report_hold_release_source: null,
      report_hold_attempts: 0,
      report_hold_next_attempt_at: null,
      report_hold_locked_at: null,
      report_hold_last_error: null,
    }),
  };
}

// The pre-delivery stamp, fenced on the claim token. A hold is armed by armReportHold instead.
async function stampSend({ hold, project, invoice, customer, expectedFingerprint, tokenUpdate, deliveryClaimToken }) {
  if (hold.active) {
    await armReportHold({ hold, project, invoice, customer, expectedFingerprint, deliveryClaimToken });
    return true;
  }
  return db('projects').where({ id: project.id, delivery_claim_token: deliveryClaimToken }).update(tokenUpdate);
}

// The preconditions of a hold, judged on the rows as they are under the locks. Throws a refusal.
const HOLD_REFUSED_RELEASING = { status: 409, code: 'release_in_progress', error: 'The paid report is being sent right now. Give it a moment, then refresh.' };
const HOLD_REFUSED_ISSUED = { status: 422, code: 'hold_after_send', error: 'This report was already sent or already has a report link, so it cannot be held. A hold only applies before the first send.' };
const HOLD_REFUSED_WITHDRAWN = { status: 422, code: 'hold_payer_billed', error: 'This invoice is billed to a third party, so the report cannot wait for payment.' };

const HOLD_REFUSED_OWNER = { status: 409, code: 'hold_customer_changed', error: 'This invoice no longer belongs to the customer this report is for (an account merge?). Refresh and check the invoice before sending.' };
// The invoice, the project and the customer the send was built for (their email, pay link) must be one customer.
function assertHoldArmable({ locked, lockedInvoice, intendedCustomerIds }) {
  const owners = new Set([lockedInvoice.customer_id, locked.customer_id, ...intendedCustomerIds].map(String));
  const refusal = (owners.size > 1 && HOLD_REFUSED_OWNER)
    || (locked.report_hold_status === 'releasing' && HOLD_REFUSED_RELEASING)
    || (reportLinkShared(locked) && HOLD_REFUSED_ISSUED)
    || reportHoldInvoiceRefusal(lockedInvoice, { wasHeld: locked.report_hold_status === 'held', boundInvoiceId: locked.invoice_id || null })
    || (invoiceWithdrawnFromCustomer(lockedInvoice) && HOLD_REFUSED_WITHDRAWN);
  if (refusal) throw holdRefusal(refusal.status, refusal.code, refusal.error);
}

// What an invoice bills and says, as one comparable string: the shared invoice approval digest (total, credit, amount
// due, lines, the operator's message and the notes the PDF prints) plus the subtotal, discount and tax the PDF shows.
function billingFingerprint(inv) {
  const money = (v) => Math.round((Number(v) || 0) * 100);
  return JSON.stringify([
    require('../services/invoice-helpers').approvedInvoiceVersionDigest(inv),
    money(inv.subtotal), money(inv.discount_amount), money(inv.tax_amount), Number(inv.tax_rate) || 0,
    // ...and the title, due date and billing address the email and PDF print. The due date is the one a first delivery
    // carries (a draft past its due day goes out due on the send day), so the preview confirms what is sent.
    String(inv.title || ''), require('../services/invoice-helpers').firstDeliveryDueDateOf(inv, etDateString()),
    typeof inv.customer_address_snapshot === 'string' ? inv.customer_address_snapshot : JSON.stringify(inv.customer_address_snapshot ?? null),
  ]);
}

// The short form of the fingerprint the preview hands the drawer and the send hands back.
// The confirmed bill, and whether the report was already held when the operator saw it: a first held send whose
// response was lost, replayed after it succeeded, would otherwise pass as a resend of the invoice.
// ...and how many held invoice sends the report had then (selectSendStamp counts them): one confirmation, one send.
const billingFingerprintHash = (inv, reportHeld = false, project = null) => crypto.createHash('sha1')
  .update(billingFingerprint(inv) + (reportHeld ? '|held' : '') + heldInvoiceSendsPart(project)).digest('hex').slice(0, 16);
function heldInvoiceSendsPart(project) {
  const channels = typeof project?.delivery_channels === 'string' ? safeJsonParse(project.delivery_channels) : project?.delivery_channels;
  const sends = Number(channels?.held_invoice_sends) || 0;
  return sends ? `|sends:${sends}` : '';
}

// Arming a hold is ONE transaction: the project row, then the invoice row (FOR UPDATE, always in that
// order, with the customer's payment lock between them, as the pay paths take it), every precondition
// re-read under those locks (hold and sent state, the invoice's payer ownership, no payment started),
// and ONE conditional write that names the invoice it binds. A request that lost a race refuses
// instead of retargeting, and a refusal rolls the whole arming back.
async function armReportHold({ hold, project, invoice, expectedFingerprint, deliveryClaimToken }) {
  await db.transaction(async (trx) => {
    // Lock order matches an account merge (the payment lock, then customers, then the invoice, then projects last),
    // so a merge and an arming wait on each other instead of deadlocking. The project's owner is checked against the
    // customers locked here once its row is locked (assertHoldArmable).
    const ownerId = (await require('../services/pay-combined').lockCombinedCustomerStable(trx, invoice.id, invoice.customer_id)) || invoice.customer_id;
    // Credit issuance (postCreditMovement) locks the customers row, and the credit paths take that row before the
    // invoice row. Taking it here, in the same order, means a credit cannot be issued between this balance read and
    // the hold stamp: the row stays locked until this transaction commits.
    const lockedCustomer = await trx('customers').where({ id: ownerId }).forUpdate().first('id', 'account_credits');
    // The release's readiness (a recipient that accepts email, the account holder) is judged on the customer as it is
    // now, read in this transaction before the invoice lock (customers before invoices).
    const currentCustomer = await loadProjectCustomer(project.customer_id, { strict: true, database: trx, forShare: true }).catch(() => null);
    if (!currentCustomer || currentCustomer.deleted_at) {
      throw holdRefusal(409, 'hold_customer_changed', 'The customer record changed while this was being sent. Nothing was sent. Refresh and send again.');
    }
    const lockedInvoice = await trx('invoices').where({ id: invoice.id }).forUpdate().first();
    const locked = await trx('projects').where({ id: project.id }).forUpdate().first();
    assertHoldArmable({ locked, lockedInvoice, intendedCustomerIds: [project.customer_id, invoice.customer_id] });
    // The project still points at the invoice staff confirmed (another request relinking it meanwhile refuses).
    if (locked.invoice_id && String(locked.invoice_id) !== String(invoice.id)) {
      throw holdRefusal(409, 'hold_invoice_changed', 'This report was linked to a different invoice while it was being sent. Nothing was sent. Refresh and send again.');
    }
    // Known before any refusal below: a refused resend of an existing hold must leave that hold in place.
    hold.wasHeld = locked.report_hold_status === 'held';
    // The no-charge rule on the LOCKED project: a fee changed to $0 since this send read the project bills nothing.
    if (resolveWdoInspectionFee(parseFindings(locked)) === 0) {
      throw holdRefusal(422, 'wdo_no_charge', 'This WDO inspection is now recorded as no charge ($0 inspection fee). Nothing was sent. Use "Send report".');
    }
    // The email, the PDF and the pay link all show the invoice as it is NOW: if it changed since this send read it,
    // nothing is sent (a stale amount in the email beside a different amount on the pay link).
    // ...and the locked invoice is the one the operator confirmed: a held send must carry the preview's fingerprint
    // (a send without one refuses, so an amount that changed before the request began cannot go out unconfirmed).
    if (billingFingerprint(lockedInvoice) !== billingFingerprint(invoice)
      || String(expectedFingerprint || '') !== billingFingerprintHash(lockedInvoice, locked.report_hold_status === 'held', locked)) {
      throw holdRefusal(409, 'hold_invoice_changed', 'The invoice changed while this was being sent. Nothing was sent. Refresh and send again.');
    }
    const notReleasable = await holdReleasabilityRefusal(locked, currentCustomer, { database: trx });
    if (notReleasable) throw holdRefusal(notReleasable.status, notReleasable.code, notReleasable.error);
    // On every held send, a first send and a resend alike: credit issued since the preflight would settle the bill.
    if (!lockedCustomer || Number(lockedCustomer.account_credits) > 0) {
      throw holdRefusal(409, 'hold_has_credit', 'This customer has account credit, which would settle the invoice before the report is held. Use Send report + invoice.');
    }
    await assertHoldMintable(locked, true, { database: trx });
    // ...and the invoice's OWN visit: an explicit or earlier invoice can ride a different visit than the project's,
    // and a payer assigned to that visit since leaves no stamp on the invoice. Unknown ownership refuses too.
    if (await invoicePayerOwnership(lockedInvoice, trx)) {
      throw holdRefusal(422, 'hold_payer_billed', 'This invoice is billed to a third party, or its payer could not be checked, so the report cannot wait for payment. Send the report and invoice normally.');
    }
    await require('../services/project-report-hold').assertNoPaymentStarted(lockedInvoice, trx);
    const written = await trx('projects')
      .where({ id: project.id, delivery_claim_token: deliveryClaimToken })
      .whereRaw(REPORT_UNSHARED_SQL)
      .whereRaw("(coalesce(report_hold_status, '') NOT IN ('held', 'releasing') OR invoice_id IS NOT DISTINCT FROM ?)", [invoice.id])
      .update(selectSendStamp(hold, invoice, null));
    if (!written) throw holdRefusal(409, 'send_superseded', 'This send was superseded by a newer request — refresh and check the report status.');
  });
}

// Takes back the hold this request armed (the invoice never went out). Fenced on the claim token, so
// it runs before the claim is given back.
async function takeBackHoldStamp({ hold, project, deliveryClaimToken }) {
  if (!hold.active || hold.wasHeld) return;
  await db('projects')
    .where({ id: project.id, delivery_claim_token: deliveryClaimToken, report_hold_status: 'held' })
    .update({ report_hold_status: null, report_hold_at: null, updated_at: db.fn.now() })
    .catch((err) => logger.warn(`[projects] hold stamp revert failed for ${project.id}: ${err.message}`));
}

// A held report has no link yet: it is minted when the report is sent.
async function sendReportLink({ hold, refreshed, customer, token }) {
  if (hold.active) return { reportPath: null, reportUrl: null };
  const reportPath = await projectReportPathForProject(db, refreshed, customer);
  return { reportPath, reportUrl: `https://portal.wavespestcontrol.com${reportPath || `/report/project/${token}`}` };
}

// A held send attaches no report: the PDF is built and archived at the release, when it is emailed.
function buildSendReportPdf(hold, refreshed, customer) {
  return hold.active ? Promise.resolve(null) : buildWdoPdfAttachment(refreshed, customer);
}

// ONE SMS of a combined send, report link + pay link, as a channel result. It goes through the canonical
// 'payment_link' policy (consent, kill switch, identity trust, invoiceId). That policy forbids an exact price and caps
// at 2 segments, so the body omits the dollar amount (it's on the pay page / invoice PDF) and stays terse. For WDO it is
// sent only after the email succeeds, since the report itself lives in the email-only FDACS PDF and a bare pay-link
// text would be wrong; for non-WDO the report link is in the text, so it sends regardless.
async function sendInvoicePayLinkText({ hold, isWdoProject, isPayerInvoice, emailOk, customer, project, invoice, firstName, typeLabel, reportUrl, payUrl, deliveryClaimToken }) {
  const normalized = normalizeUsPhone(customer.phone);
  if (!normalized) return { ok: false, error: customer.phone ? `Invalid phone format: ${customer.phone}` : 'No phone on file' };
  if (isWdoProject && !emailOk) return { ok: false, error: 'Skipped — email delivery did not succeed' };
  try {
    const result = await sendCustomerMessage({
      to: normalized,
      body: invoiceSendSmsBody({ hold, isPayerInvoice, firstName, typeLabel, reportUrl, invoice, payUrl }),
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_link',
      customerId: customer.id,
      invoiceId: invoice.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'admin_project_report_with_invoice',
      operatorInitiated: true,
      // original_message_type 'invoice' keeps the admin-sms-templates invoice kill switch applicable to this billing text.
      metadata: { original_message_type: 'invoice', project_id: project.id, invoice_id: invoice.id, ...(hold.active ? { report_hold: true } : {}) },
      // A held send's pay-link text: the number, the customer and this send's claim re-read under the phone locks
      // through the provider request (a phone corrected or a merge during the send skips the text).
      ...(hold.active ? { withSmsHandoff: heldInvoiceSmsHandoff({ customerId: customer.id, phone: normalized, projectId: project.id, invoiceId: invoice.id, deliveryClaimToken, invoiceClaimToken: hold.invoiceClaimToken }) } : {}),
    });
    if (result.sent) return { ok: true };
    return { ok: false, error: result.code === 'RECIPIENT_CHANGED' ? 'Skipped: the phone number or customer changed during the send' : (result.reason || result.code || 'SMS send blocked/failed') };
  } catch (e) {
    logger.error(`[projects] combined send sms failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// The customer email of a combined send, as a channel result. The library reports its own errors in the result, so a
// throw is usually before the provider phase (not sent); a held send knows better: a throw after its handoff started
// may have reached the customer (outcome unknown).
async function sendCustomerInvoiceEmail(args) {
  if (!args.recipient.email) return { ok: false, error: 'No email on file' };
  try {
    const result = await sendInvoiceEmail(args);
    return result.ok
      ? { ok: true, messageId: result.messageId || null }
      : { ok: false, error: projectEmailFailureMessage(result), uncertain: invoiceEmailUncertain(result) };
  } catch (e) {
    logger.error(`[projects] combined send email failed: ${e.message}`);
    return { ok: false, error: e.message, uncertain: Boolean(args.handoffState?.handoffStarted) };
  }
}

// The customer email: invoice-first for a hold, report-only for a payer-billed invoice, else combined.
function sendInvoiceEmail({ handoffState, hold, deliveryClaimToken, isPayerInvoice, isWdoProject, project, refreshed, customer, reportUrl, payUrl, invoice, attachments, reportAttachments, recipient }) {
  if (hold.active) {
    return ProjectEmail.sendProjectInvoiceBeforeReport({
      project: refreshed, customer, payUrl, invoice, attachments, recipient, handoffState,
      withProviderHandoff: heldInvoiceProviderHandoff({ invoice, project, deliveryClaimToken, invoiceClaimToken: hold.invoiceClaimToken, recipientEmail: recipient?.email, state: handoffState }),
    });
  }
  if (isPayerInvoice) {
    // Payer-billed: homeowner gets the report only (FDACS PDF for WDO + report link), never the invoice PDF or pay link.
    return ProjectEmail.sendProjectReportReady({
      project: refreshed, customer, reportUrl,
      attachments: reportAttachments,
      isResend: Boolean(project.sent_at || project.status === 'sent'),
    });
  }
  return ProjectEmail.sendProjectReportWithInvoice({
    project: refreshed, customer, reportUrl, payUrl, invoice, attachments,
    // Only WDO attaches a report PDF (the FDACS-13645); non-WDO attaches just the invoice PDF and
    // delivers the report as a link. Drives the template's attachments sentence.
    reportAttached: isWdoProject,
  });
}

// The billing-contact copy of the same email.
function sendBillingCopyEmail({ isWdoProject, project, refreshed, customer, reportUrl, payUrl, invoice, attachments, billing }) {
  const recipient = { email: billing.email, name: billing.name || '', role: billing.role || 'billing' };
  const stamp = new Date().toISOString();
  return ProjectEmail.sendProjectReportWithInvoice({
    project: refreshed, customer, reportUrl, payUrl, invoice, attachments,
    reportAttached: isWdoProject,
    recipient,
    idempotencyKey: `project.report_with_invoice:${project.id}:${invoice.id}:billing:${stamp}`,
  });
}

// Third-party report copies, after the customer email. A held send defers them to the release:
// nobody receives the report before it is paid.
async function sendReportCopiesUnlessHeld({ hold, req, isWdoProject, channels, project, refreshed, customer, reportUrl, wdoPdf, excludeEmails }) {
  if (hold.active || !isWdoProject || !channels.email?.ok) return;
  const copies = await sendWdoReportCopies({
    req,
    project: refreshed,
    customer,
    reportUrl,
    attachment: wdoPdf ? wdoPdf.attachment : null,
    excludeEmails,
    isResend: Boolean(project.sent_at || project.status === 'sent'),
  });
  if (copies) channels.report_copies = copies;
}

// Payer-billed: the homeowner still gets the report link (their service) but NOT the pay link; AR
// routes to the payer's AP inbox. A held send texts the pay link only.
function invoiceSendSmsBody({ hold, isPayerInvoice, firstName, typeLabel, reportUrl, invoice, payUrl }) {
  if (hold.active) return heldReportInvoiceSms({ firstName, typeLabel, invoice, payUrl });
  const report = `Hi ${firstName}, your Waves ${typeLabel} report is ready: ${reportUrl}`;
  return isPayerInvoice ? report : `${report}\n\nInvoice ${invoice.invoice_number} — pay online: ${payUrl}`;
}

// An email that failed with an error (not a definite refusal: blocked, skipped, or reported not sent) may still have
// reached the customer (a timeout after the provider took it). The outcome is UNKNOWN, never "not delivered".
function invoiceEmailUncertain(result) {
  return !result.ok && !result.blocked && !result.skipped && result.deliveryOutcome === 'uncertain';
}

// The checks every held pay-link handoff (the invoice email and the text) runs on its locked handle, in one place:
// the invoice and the project still belong to the customer, this send still owns the claim on a held, unshared
// report, it is still the homeowner's own bill (not withdrawn to a payer, the visit not billed to a third party now),
// and no collections hold stops the pay link (an operator send skips only a plain dispute hold; an unreadable hold
// refuses). Returns { live, liveProject } or { code, reason } (a refusal).
async function heldPayLinkFence(database, { customerId, projectId, invoiceId, deliveryClaimToken, invoiceClaimToken }) {
  const live = await database('invoices').where({ id: invoiceId }).forShare().first();
  const liveProject = await database('projects').where({ id: projectId }).forShare().first();
  if (!live || !liveProject) return { code: 'HELD_INVOICE_UNREADABLE', reason: 'The invoice or project could not be re-read' };
  if ([live.customer_id, liveProject.customer_id].some((id) => String(id) !== String(customerId))) {
    return { code: 'INVOICE_CUSTOMER_MISMATCH', reason: 'The invoice or project moved to another customer' };
  }
  // ...and this send still owns the invoice's claim: a stale recovery may have handed it to another sender.
  if (String(live.send_claim_token || '') !== String(invoiceClaimToken)) {
    return { code: 'HELD_SEND_SUPERSEDED', reason: 'This send no longer owns the invoice claim' };
  }
  if (String(liveProject.delivery_claim_token || '') !== String(deliveryClaimToken)
    || liveProject.report_hold_status !== 'held' || reportLinkShared(liveProject)) {
    return { code: 'HELD_SEND_SUPERSEDED', reason: 'This send no longer owns a held, unshared report' };
  }
  const ownership = await require('../services/invoice-helpers').selfPayAtDispatch(invoiceId, database)();
  if (ownership.ok !== true) return { code: ownership.code || 'INVOICE_PAYER_BILLED', reason: ownership.reason || 'Not the homeowner\'s bill' };
  if (await liveBillToRefusal(liveProject, database) || await invoicePayerOwnership(live, database)) {
    return { code: 'INVOICE_PAYER_BILLED', reason: 'This service is now billed to a third party, or its payer could not be checked' };
  }
  const collectionHold = require('../services/collections/collection-hold');
  const held = await collectionHold.messagingHeldByCollectionHold(customerId, database, { ignoreDisputeHold: collectionHold.holdExemptionApplies('operator') });
  if (held.held) return { code: 'COLLECTION_HOLD', reason: 'A collections hold applies to this customer' };
  return { live, liveProject };
}

// Everything arming checked, again at the invoice email's provider boundary: still a fee to bill, no payment started,
// no account credit, and a report that can still send by itself once paid. Returns a refusal or null.
async function heldInvoiceStillArmable(database, { live, liveProject, customerId }) {
  if (resolveWdoInspectionFee(parseFindings(liveProject)) === 0) return { code: 'WDO_NO_CHARGE', reason: 'The inspection is now recorded as no charge' };
  try {
    await require('../services/project-report-hold').assertNoPaymentStarted(live, database);
  } catch (err) {
    return { code: 'HOLD_PAYMENT_STARTED', reason: err.message };
  }
  const liveCustomer = await loadProjectCustomer(customerId, { strict: true, database });
  if (!liveCustomer || liveCustomer.deleted_at) return { code: 'INVOICE_CUSTOMER_MISMATCH', reason: 'The customer record changed' };
  if (Number(liveCustomer.account_credits) > 0) return { code: 'HOLD_HAS_CREDIT', reason: 'The customer now has account credit' };
  if (await holdReleasabilityRefusal(liveProject, liveCustomer, { database })) {
    return { code: 'HOLD_NOT_RELEASABLE', reason: 'The report could no longer send by itself after payment' };
  }
  return null;
}

// The held invoice email's provider handoff: the canonical billing email authority (the customer's comms lock, the
// recipient re-resolved under it, the invoice's deposit-settlement lock, collection holds, suppression), held from the
// last check through the provider request. Its pre-send check, run on the LOCKED handle before dispatch and again at the
// provider boundary, is this send's own fence: the project and the invoice still belong to the customer the hold was armed
// for, this request still owns the delivery claim, the report is still held and unshared, the invoice is still this
// send's claim ('sending', so a payment or a void in between refuses), it still bills what the email shows (amount and
// lines) with the same amount due, and it is still the homeowner's own bill. Fails closed: anything unreadable refuses.
function heldInvoiceProviderHandoff({ invoice, project, deliveryClaimToken, invoiceClaimToken, recipientEmail, state }) {
  const customerId = project.customer_id;
  const expectedDue = require('../services/invoice-helpers').invoiceAmountDue(invoice);
  const refuse = (code, reason) => ({ ok: false, code, reason, retryable: false });
  const preSendCheck = async ({ database }) => {
    // The switch is read again: turning the hold off stops a held invoice email that has not gone yet.
    if (!wdoReportHoldLive()) return refuse('HOLD_SWITCHED_OFF', 'The report hold was switched off');
    const fence = await heldPayLinkFence(database, { customerId, projectId: project.id, invoiceId: invoice.id, deliveryClaimToken, invoiceClaimToken });
    if (fence.code) return refuse(fence.code, fence.reason);
    const { live, liveProject } = fence;
    if (String(live.status || '') !== 'sending') return refuse('HELD_INVOICE_NOT_SENDABLE', 'The invoice was paid, voided or changed state');
    const due = require('../services/invoice-helpers').invoiceAmountDue(live);
    if (billingFingerprint(live) !== billingFingerprint(invoice) || due !== expectedDue || !(due > 0)) {
      return refuse('HELD_INVOICE_CHANGED', 'The invoice amount changed before delivery');
    }
    const notArmable = await heldInvoiceStillArmable(database, { live, liveProject, customerId });
    return notArmable ? refuse(notArmable.code, notArmable.reason) : { ok: true };
  };
  return (dispatch) => require('../services/billing-channel-email-authority').dispatchUnderBillingEmailAuthority({
    input: { customerId, invoiceId: invoice.id, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
    recipientEmail,
    templateKey: 'project.invoice_before_report',
    holdExempt: 'operator',
    preSendCheck,
    dispatch,
    state,
  });
}

// The held invoice text's locked handoff: the customer's phone, the project's owner and this send's claim, and the
// invoice's owner, all re-read under the phone consent locks (customer FOR SHARE before the project, as a merge locks).
function heldInvoiceSmsHandoff({ customerId, phone, projectId, invoiceId, deliveryClaimToken, invoiceClaimToken }) {
  const { withSmsConsentLock } = require('../utils/customer-comms-lock');
  const refused = { ok: false, code: 'RECIPIENT_CHANGED', reason: 'recipient_changed', retryable: false };
  return async (dispatch) => {
    let dispatched = false;
    try {
      return await withSmsConsentLock(db, { phone, customerId }, async (trx) => {
        const liveCustomer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forShare().first('id', 'phone');
        if (!liveCustomer || normalizeUsPhone(liveCustomer.phone) !== phone) return refused;
        const fence = await heldPayLinkFence(trx, { customerId, projectId, invoiceId, deliveryClaimToken, invoiceClaimToken });
        if (fence.code === 'COLLECTION_HOLD') return { ok: false, code: 'COLLECTION_HOLD', reason: 'collection_hold', retryable: false };
        if (fence.code) return refused;
        // paid from the email meanwhile (or voided/disputed): no second request to pay
        if (['paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled', 'disputed'].includes(String(fence.live.status || '').toLowerCase())
          || !(require('../services/invoice-helpers').invoiceAmountDue(fence.live) > 0)) return refused;
        dispatched = true;
        return dispatch(trx);
      });
    } catch (err) {
      if (dispatched) throw err;
      return refused;
    }
  };
}

// Who a held invoice email goes to: the billing email authority's recipient (the customer's billing contact and email
// choices, the address every invoice email uses), the same one its provider handoff re-resolves under the locks. A
// refusal (no address, email off) is an empty recipient: nothing is sent and the send reports it.
async function heldInvoiceEmailRecipient(customer, invoice) {
  const { billingEmailRecipient } = require('../services/billing-email-sender');
  const resolved = await billingEmailRecipient({
    customerId: customer.id, invoiceId: invoice.id, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' },
  }, 'projects');
  if (resolved.refusal) return { email: null, refusal: resolved.refusal };
  return { email: resolved.to, name: resolved.recipient?.name || '', role: resolved.recipient?.role || 'billing' };
}

// A held send whose invoice email outcome is unknown is never marked sent (no sent stamp, no reminders, no visit
// closeout); the office bell asks staff to check with the customer. A first delivery parks the invoice for review the
// way a stale send is (still payable from the link the customer may hold, so payment still releases the report). An
// invoice already sent (sent, viewed, overdue) keeps its status: its earlier delivery still stands.
// A held send's invoice claim also takes the first-delivery due date (a draft past its due day goes out due on the send
// day, as every first send does), and claims only the status this request read, so the rollback and the
// unknown-outcome park restore the status it really had.
function heldInvoiceClaimFields(hold) {
  return hold.active ? { due_date: require('../services/invoice-helpers').firstDeliveryDueDate(db, etDateString()) } : {};
}

// The combined send's invoice claim, owned by its token.
function invoiceClaimWhere(id, claimToken) {
  return { id, status: 'sending', send_claim_token: claimToken };
}

async function settleUnverifiedHeldInvoice(invoice, previousInvoiceStatus, claimToken) {
  const firstDelivery = ['draft', 'scheduled'].includes(String(previousInvoiceStatus || '').toLowerCase());
  const { STALE_SEND_PARK_ERROR } = require('../services/invoice-helpers');
  const update = firstDelivery
    ? { status: 'scheduled', scheduled_send_at: null, scheduled_send_error: STALE_SEND_PARK_ERROR, send_claim_token: null }
    : { status: previousInvoiceStatus, send_claim_token: null };
  await db('invoices').where(invoiceClaimWhere(invoice.id, claimToken)).update({ ...update, updated_at: db.fn.now() })
    .catch((err) => logger.error(`[projects] unverified held invoice not settled for ${invoice.id}: ${err.message}`));
}

// The one bell for an invoice email of unknown outcome: the hold stays, and staff check whether it arrived. A later
// held send whose email was accepted closes it (the customer has the invoice now).
async function ringUncertainInvoiceEmailBell({ hold, delivered, channels, project, customer }) {
  const reportHold = require('../services/project-report-hold');
  if (hold.active && channels.email?.ok) await reportHold.closeInvoiceEmailBell(project.id);
  if (!(hold.active && delivered && channels.email?.uncertain)) return;
  await reportHold.raiseInvoiceEmailUncertainBell({ project, customer, reason: channels.email.error });
  // A release that committed before the raise closed its bells before this one existed: the report is out, so this
  // bell is stale. Only a finished release closes it here: a release still in flight may fail back to held, and its own
  // finalize closes the bell when it succeeds.
  const now = await db('projects').where({ id: project.id }).first('report_hold_status').catch(() => null);
  if (now?.report_hold_status === 'released') await reportHold.closeInvoiceEmailBell(project.id);
}

// Only an accepted email stamps email_sent_at. (An unknown outcome on a held send parks the invoice instead.)
function invoiceEmailReached({ isPayerInvoice, channels }) {
  return Boolean(isPayerInvoice ? channels.payer_email?.ok : channels.email?.ok);
}

// A held send delivers the INVOICE only: the email that carries the pay link is the delivery. An unknown email outcome
// keeps the hold armed (the customer may hold a pay link and has been told the report follows payment); only a
// definite failure takes the hold back.
function sendIsDelivered({ hold, channels, deliveredReport, payerLegOk }) {
  return hold.active ? Boolean(channels.email?.ok || channels.email?.uncertain) : (deliveredReport && payerLegOk);
}

// The final project write of a send, fenced on the claim token (zero rows = a stale takeover owns
// the row). Returns true when nothing needed writing (not delivered) or the write landed.
async function finalizeInvoiceSend({ hold, delivered, project, refreshed, projectCols, channels, deliveryStatus, deliveryClaimToken, previousDeliveryStatus, wdoFiling }) {
  const fence = { id: project.id, delivery_claim_token: deliveryClaimToken };
  if (!delivered) {
    // The invoice never went out, so the hold this request armed is not armed: take it back (the
    // revert after this clears the claim token this is fenced on, so it runs first).
    await takeBackHoldStamp({ hold, project, deliveryClaimToken });
    return true;
  }
  // A held send: the invoice is out and the hold was stamped before delivery. The invoice email is NOT report
  // delivery, so no delivery field of the project records it (closeout reads them as "the report went out"): the claim
  // is simply given back with the status it had, and the activity log keeps the invoice outcome. The project stays
  // unsent (no status 'sent' or sent_at): the sweep owns the release.
  if (hold.active) {
    return db('projects').where(fence).update({ delivery_status: previousDeliveryStatus, delivery_claim_token: null, updated_at: db.fn.now() });
  }
  const bookkeeping = {
    last_delivery_at: db.fn.now(),
    delivery_channels: channels,
    delivery_status: deliveryStatus,
    delivery_claim_token: null,
    updated_at: db.fn.now(),
  };
  const written = await db('projects').where(fence).update({
    ...bookkeeping,
    // Resending a closed project's report must not regress its lifecycle
    // (closed_at stays set and closeout artifacts key on status='closed').
    status: SENT_UNLESS_CLOSED(),
    sent_at: project.sent_at || db.fn.now(),
    ...(wdoFiling && projectCols.wdo_sent_filings ? {
      // Atomic jsonb append — never read-modify-write the filing index.
      wdo_sent_filings: db.raw("coalesce(wdo_sent_filings, '[]'::jsonb) || ?::jsonb", [JSON.stringify([wdoFiling])]),
    } : {}),
  });
  return written;
}

const SEND_OUTCOMES = {
  plain_ok: { action: 'project_report_with_invoice_sent', text: (t, inv) => `Report + invoice sent: ${t} (${inv})` },
  plain_failed: { action: 'project_report_with_invoice_failed', text: (t) => `Report + invoice delivery failed: ${t}` },
  held_ok: { action: 'project_invoice_sent_report_held', text: (t, inv) => `Invoice sent, report held until paid: ${t} (${inv})` },
  held_failed: { action: 'project_invoice_report_hold_failed', text: (t) => `Invoice delivery failed (report hold not armed): ${t}` },
  // A resend on a report that was already held: the failed resend leaves the earlier hold as it was.
  held_resend_failed: { action: 'project_invoice_report_hold_resend_failed', text: (t) => `Invoice resend failed; the report stays held until paid: ${t}` },
};

// The activity row of a send: action, text and the hold keys of its metadata.
function sendActivityEntry({ hold, delivered, typeLabel, invoice, token }) {
  const outcome = SEND_OUTCOMES[`${hold.active ? 'held' : 'plain'}_${delivered ? 'ok' : `${hold.active && hold.wasHeld ? 'resend_' : ''}failed`}`];
  return {
    action: outcome.action,
    description: outcome.text(typeLabel, invoice.invoice_number),
    meta: { report_token_prefix: hold.active ? null : String(token).slice(0, 6), ...(hold.active ? { report_hold: true } : {}) },
  };
}

// A held report has no link yet; `report_held` rides the response only for a hold request.
function sendResponseHoldKeys({ hold, reportPath, token, delivered }) {
  return {
    report_url: hold.active ? null : (reportPath || `/report/project/${token}`),
    // A failed resend leaves an earlier hold in place: the report is still held.
    ...(hold.requested ? { report_held: hold.active && (delivered || Boolean(hold.wasHeld)) } : {}),
  };
}

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
  // The hold this request armed, until the first customer message goes out: any exception in between takes it back.
  let armedHold = null;
  let dispatchStarted = false;
  // A held send's invoice email handoff state: the authority marks handoffStarted at the real provider handoff.
  let heldHandoffState = null;
  // Tracks the SHARED project delivery claim (delivery_status='sending') this
  // route takes alongside /send — the invoice claim alone can't stop a
  // concurrent report-only /send from emailing + archiving the same FDACS
  // report. The delivered branches resolve the claim by writing the final
  // delivery_status; the guarded revert only touches a still-'sending' row.
  let deliveryClaim = null;
  const revertDeliveryClaimOnAbort = async (projectId) => {
    if (!deliveryClaim) return;
    await db('projects')
      .where({ id: projectId, delivery_status: 'sending', delivery_claim_token: deliveryClaim.token })
      .update({ delivery_status: deliveryClaim.previousStatus, delivery_claim_token: null, updated_at: db.fn.now() })
      .catch((err) => logger.warn(`[projects] combined-send delivery claim revert failed for ${projectId}: ${err.message}`));
    deliveryClaim = null;
  };
  // Seam-applied credit on the combined report+invoice send. Hoisted (with its
  // reversal) so the outer catch can return it on ANY abort, not just the
  // explicit WDO/no-delivery paths. Reverses ONLY this send's amount; on full
  // coverage (prepaid) it un-prepays to the real pre-send status. Must run AFTER
  // the 'sending' claim is released (reverseAppliedCredit refuses 'sending'/'prepaid').
  let appliedProjectCredit = 0;
  // True when this send's credit FULLY covered the invoice (now prepaid). The
  // full-coverage side effects are deferred to the delivered-success branch so a
  // failed-delivery reversal never strands a stopped dunning sequence / activated
  // prepay term.
  let projectCreditFullyCovered = false;
  const reverseProjectCreditOnAbort = async () => {
    if (!(appliedProjectCredit > 0) || !claimedInvoice) return;
    try {
      const { reverseAppliedCredit, postCreditMovement, round2 } = require('../services/customer-credit');
      const r = await reverseAppliedCredit({ invoiceId: claimedInvoice.id, amount: appliedProjectCredit, createdBy: 'system:project_send_failed' });
      if (r.reversed > 0) { appliedProjectCredit = 0; return; }
      // Codex pre-push P2 (round 2 of the owner's audit): lock the customer
      // row before the invoice row — postCreditMovement below also locks
      // the customer, and this abort-cleanup path's old invoice-then-
      // customer order could deadlock against settleZeroBalance's now
      // customer-first order (server/services/invoice.js). claimedInvoice
      // carries no customer_id, so an unlocked pre-read supplies it.
      const preCustomer = await db('invoices').where({ id: claimedInvoice.id }).first('customer_id');
      await db.transaction(async (trx) => {
        if (preCustomer) await trx('customers').where({ id: preCustomer.customer_id }).forUpdate().first('id');
        const locked = await trx('invoices').where({ id: claimedInvoice.id }).forUpdate().first();
        // Local pre-push audit P1 (round 2, Claude fallback): the pre-read
        // above is unlocked and can go stale — a customer merge repointing
        // this invoice's owner in that window would leave us holding the
        // WRONG (retired) customer while postCreditMovement posts against
        // the invoice's CURRENT (survivor) customer with no lock on it.
        // This path is best-effort cleanup (already wrapped in try/catch
        // with no rethrow), so on a mismatch skip the reversal and log
        // rather than throw — the credit stays applied and needs manual
        // reconciliation, same as any other failure of this cleanup.
        if (preCustomer && locked && locked.customer_id !== preCustomer.customer_id) {
          logger.error(`[projects] credit-reversal abort-cleanup skipped for invoice ${claimedInvoice.id} — owner changed between the pre-read and the lock; reconcile the $${appliedProjectCredit} applied credit manually`);
          return;
        }
        if (locked && String(locked.status || '').toLowerCase() === 'prepaid' && !locked.stripe_payment_intent_id) {
          const reverseAmt = Math.min(round2(appliedProjectCredit), round2(locked.credit_applied || 0));
          if (reverseAmt > 0) {
            await postCreditMovement({
              customerId: locked.customer_id,
              delta: reverseAmt,
              source: 'adjustment',
              invoiceId: claimedInvoice.id,
              note: `Project send failed — returned $${reverseAmt} applied credit`,
              createdBy: 'system:project_send_failed',
            }, trx);
            await trx('invoices').where({ id: claimedInvoice.id }).update({
              credit_applied: Math.max(0, round2(round2(locked.credit_applied || 0) - reverseAmt)),
              status: claimedInvoice.previousStatus,
              // this send's own claim token goes with the claim it gives back (another sender's is left alone)
              send_claim_token: db.raw('CASE WHEN send_claim_token = ? THEN NULL ELSE send_claim_token END', [claimedInvoice.claimToken]),
              prepaid_at: null,
              prepaid_by: null,
              prepaid_prev_status: null,
              paid_at: null,
              updated_at: trx.fn.now(),
            });
          }
        }
      });
      appliedProjectCredit = 0;
    } catch (e) {
      logger.warn(`[projects] credit reversal after failed project send skipped for ${claimedInvoice?.id}: ${e.message}`);
    }
  };
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

    const customer = await loadProjectCustomer(project.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // The filled FDACS-13645 PDF rides on the email only (SMS can't carry it),
    // so a WDO report can't be delivered without an email — fail up front rather
    // than text a bare link and record the official report as sent. Non-WDO
    // reports deliver the report as a link in the text itself, so SMS-only is
    // fine and email isn't required.
    if (isWdoProject && !ProjectEmail.resolveProjectEmailRecipient(customer, { applyReportRule: true }).email) {
      return res.status(422).json({ error: 'A WDO report is delivered as the FDACS-13645 PDF by email — add an email address for this customer first.', code: 'email_required' });
    }

    // Readiness gate mirrors /send so we never email an incomplete report.
    const readiness = evaluateProjectSendReadiness({ project, customer, staffSend: true });
    // Statutory compliance blockers are not overridable (Codex P1 r3) —
    // mirrors /send.
    if (readiness.hardMissing.length > 0) {
      return res.status(422).json({ error: 'Project report is missing required compliance details (cannot be overridden)', missing: readiness.hardMissing });
    }
    const overrideReason = String(req.body?.override_reason || '').trim();
    const hasReadinessOverride = readiness.missing.length > 0 && overrideReason.length > 0;
    if (readiness.missing.length > 0 && !hasReadinessOverride) {
      return res.status(422).json({ error: 'Project report is missing required details', missing: readiness.missing });
    }

    // Explicit boolean — a stringified `dry_run: "false"` must NOT read as truthy
    // (and silently preview instead of send), nor `dry_run: 0` send for real.
    const dryRun = req.body?.dry_run === true || req.body?.dry_run === 'true';
    // Card-on-file completion needs a durable draft invoice id before the
    // explicit charge. This mode performs all report/readiness/billing checks
    // but sends nothing.
    const prepareInvoice = req.body?.prepare_invoice === true || req.body?.prepare_invoice === 'true';

    // Report hold (GATE_WDO_REPORT_HOLD): send the invoice and pay link only, and send the report
    // by itself once the invoice is paid. Prepare mode checks the hold but never arms it.
    const holdRequested = sendHoldFlag(req.body);
    const needsConfirmedInvoice = !dryRun && !prepareInvoice && !req.body?.invoice_id;
    if (await holdRequestRefused(res, { project, customer, holdRequested, needsConfirmedInvoice })) return;

    const hold = createSendHold(project, holdRequested);
    const { invoice, created } = await resolveOrCreateProjectInvoice({
      project,
      customer,
      invoiceId: req.body?.invoice_id,
      dryRun: dryRun && !prepareInvoice,
      holdRequested,
    });

    // Match the canonical invoice non-sendable statuses (invoice.js; B-48): don't
    // push another pay link for an invoice that's paid, void, mid-send, disputed,
    // or has a bank payment (ACH) already in flight ('processing').
    if (PROJECT_INVOICE_NON_SENDABLE_STATUSES.includes(invoice.status)) {
      return res.status(409).json(nonSendableProjectInvoicePayload(invoice));
    }
    if (await holdInvoiceRefused(res, invoice, hold)) return;

    if (prepareInvoice) {
      return res.json({
        prepared: true,
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          total: invoice.total,
          status: invoice.status,
          created,
          payer_billed: !!invoice.payer_id,
          billing_fingerprint: billingFingerprintHash(invoice, isReportHeld(project), project),
        },
      });
    }

    // dry_run: surface the resolved invoice + amount, send nothing and (for a
    // brand-new WDO) create nothing — `invoice` is a non-persisted preview here.
    if (dryRun) {
      // Routing preview so the confirm dialog shows exactly who gets what
      // BEFORE the send: the customer recipient (combined report+invoice
      // email), the billing-contact copy (same email, when a distinct billing
      // contact is configured), and the report-only third-party copies parsed
      // from the FDACS "Report Sent to Requestor and to:" line.
      // A hold preview names the one address the held invoice email really goes to (the billing recipient the send
      // resolves, with no second billing copy), and says so when there is none.
      const previewRecipient = holdRequested
        ? await heldInvoiceEmailRecipient(customer, invoice)
        : ProjectEmail.resolveProjectEmailRecipient(customer, { applyReportRule: true });
      const previewPrefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
      const [previewBilling] = getInvoiceEmailRecipients(customer, previewPrefs || {});
      const previewRecipientEmail = String(previewRecipient.email || '').trim().toLowerCase();
      const previewBillingEmail = String(previewBilling?.email || '').trim().toLowerCase();

      // Third-party Bill-To: mirror the real send's routing so the confirm dialog
      // is accurate. For a payer-billed invoice the homeowner gets the report
      // ONLY (no invoice PDF / pay link / billing copy) and the invoice + pay link
      // route to the payer AP inbox. Resolve the payer from the persisted preview
      // invoice's snapshot, or — for a brand-new non-persisted preview — the
      // customer/per-job default the real create() will use (mirroring its
      // serviceRecordId → scheduled_service_id derivation).
      const PreviewPayerService = require('../services/payer');
      let previewPayerApEmail = null;
      let isPayerBilledPreview = false;
      if (invoice.payer_id || invoice.payer_snapshot) {
        await PreviewPayerService.attachToInvoice(invoice);
        isPayerBilledPreview = !!invoice.payer_id;
        previewPayerApEmail = invoice.payer ? (PreviewPayerService.payerRecipient(invoice.payer)?.email || null) : null;
      } else {
        let previewSsId = project.scheduled_service_id || null;
        if (!previewSsId && project.service_record_id) {
          const srLink = await db('service_records')
            .where({ id: project.service_record_id, customer_id: customer.id })
            .first('scheduled_service_id').catch(() => null);
          if (srLink?.scheduled_service_id) previewSsId = srLink.scheduled_service_id;
        }
        const resolvedPreviewPayer = await PreviewPayerService.resolveForInvoice({
          customerId: customer.id,
          scheduledServiceId: previewSsId,
        }).catch(() => null);
        if (resolvedPreviewPayer?.payerId) {
          isPayerBilledPreview = true;
          previewPayerApEmail = resolvedPreviewPayer.snapshot
            ? (PreviewPayerService.payerRecipient(resolvedPreviewPayer.snapshot)?.email || null)
            : null;
        }
      }
      const previewReportCopies = isWdoProject
        ? wdoReportCopyEmails(parseFindings(project), [previewRecipientEmail, customer?.email, previewBillingEmail])
        : [];
      return res.json({
        dry_run: true,
        ...(await holdDryRunKeys({ holdRequested, isWdoProject, project, invoice, isPayerBilledPreview, customer })),
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          total: invoice.total,
          status: invoice.status,
          created,
          // What the operator is confirming: the send hands it back, and a held send refuses a changed invoice.
          ...(holdRequested && invoice.id && !created ? { billing_fingerprint: billingFingerprintHash(invoice, isReportHeld(project), project) } : {}),
        },
        email_routing: isPayerBilledPreview ? {
          // Homeowner gets the report ONLY; the invoice + pay link go to the payer
          // AP inbox — no homeowner billing copy for a payer invoice.
          recipient: previewRecipient.email || null,
          report_only: true,
          payer_billed: true,
          payer: previewPayerApEmail,
          billing_copy: null,
          report_copies: previewReportCopies,
        } : {
          recipient: previewRecipient.email || null,
          ...(previewRecipient.refusal ? { recipient_refused: previewRecipient.refusal.reason || 'not_sendable' } : {}),
          billing_copy: !holdRequested && previewBillingEmail && previewBillingEmail !== previewRecipientEmail ? previewBillingEmail : null,
          // Same exclusion set the send applies: recipient, primary, billing.
          report_copies: previewReportCopies,
        },
      });
    }

    // Atomically claim the invoice as 'sending' before any side effects, so two
    // overlapping send-with-invoice POSTs can't both pass the status check and
    // deliver duplicate report/pay-link messages (mirrors the InvoiceService
    // send-claim). Released below if nothing is delivered.
    const previousInvoiceStatus = invoice.status;
    // Every combined send owns its claim by token: a rollback, an unknown-outcome park or the finalize touch only this
    // episode, never a newer sender's claim taken after a stale recovery.
    // (invoices.send_claim_token is a uuid column.) The held handoffs read it from the hold.
    const invoiceClaimToken = crypto.randomUUID();
    hold.invoiceClaimToken = invoiceClaimToken;
    const claimedRows = await db('invoices')
      .where({ id: invoice.id })
      // Mirror InvoiceService SEND_CLAIMABLE_STATUSES so resending a report for
      // an opened/overdue invoice works (getByToken flips sent → viewed once
      // the customer opens the pay link).
      .whereIn('status', ['draft', 'scheduled', 'sent', 'viewed', 'overdue'])
      .where((q) => { if (hold.active) q.where({ status: previousInvoiceStatus }); })
      .update({ status: 'sending', send_claim_token: invoiceClaimToken, ...heldInvoiceClaimFields(hold), updated_at: db.fn.now() });
    if (!claimedRows) {
      return res.status(409).json({ error: 'Invoice send already in progress', invoice_id: invoice.id });
    }
    claimedInvoice = { id: invoice.id, previousStatus: previousInvoiceStatus, claimToken: invoiceClaimToken };
    // The email and PDF print the due date the claim wrote (the fingerprint already confirmed it).
    if (hold.active) {
      invoice.due_date = require('../services/invoice-helpers').firstDeliveryDueDateOf({ ...invoice, status: 'sending' }, etDateString());
    }

    // Shared project delivery claim (see hoist comment): one claim namespace
    // across /send and /send-with-invoice so the two routes can't race each
    // other into duplicate FDACS emails/archives. Taken AFTER the invoice
    // claim; losing it returns the invoice claim before 409ing. Same stale-
    // recovery normalization as /send: never revert back to 'sending'.
    const previousDeliveryStatus = project.delivery_status === 'sending'
      ? 'failed'
      : (project.delivery_status || null);
    // Same ownership fence as /send: token per claim, conditioned reverts.
    const deliveryClaimToken = crypto.randomBytes(12).toString('hex');
    const deliveryClaimQuery = db('projects')
      .where({ id: project.id })
      .where((q) => q
        .whereRaw("delivery_status IS DISTINCT FROM 'sending'")
        .orWhereRaw("updated_at < now() - interval '10 minutes'"));
    // ...and a plain send never claims a report held (or being released) since the read above. No send at all takes a
    // release's claim (a crashed one is handed back by the release's own recovery).
    if ('report_hold_status' in project) {
      deliveryClaimQuery.whereRaw(SEND_CLAIM_HOLD_EXCLUSION[String(Boolean(holdRequested))]);
    }
    addSentOutsideClaimGuard(deliveryClaimQuery, project);
    const deliveryClaimRows = await deliveryClaimQuery
      .update({ delivery_status: 'sending', delivery_claim_token: deliveryClaimToken, updated_at: db.fn.now() });
    if (!deliveryClaimRows) {
      await db('invoices').where(invoiceClaimWhere(invoice.id, invoiceClaimToken))
        .update({ status: previousInvoiceStatus, send_claim_token: null, updated_at: db.fn.now() })
        .catch((err) => logger.warn(`[projects] invoice claim release after lost delivery claim failed for ${invoice.id}: ${err.message}`));
      claimedInvoice = null;
      return res.status(409).json({
        error: 'This report is already being sent — give it a moment, then refresh.',
        code: 'send_in_progress',
      });
    }
    deliveryClaim = { previousStatus: previousDeliveryStatus, token: deliveryClaimToken };

    // Same post-claim re-judge as /send (the catch below releases the claims).
    await assertPretreatStillSendable(project.id, project.project_type);

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
    // Token-fenced like /send's stamp: a resumed stalled request must not
    // overwrite the takeover owner's token/portal fields.
    const stamped = await stampSend({ hold, project, invoice, customer, expectedFingerprint: req.body?.expected_billing_fingerprint, tokenUpdate, deliveryClaimToken });
    if (stamped && hold.active) armedHold = { hold, project, deliveryClaimToken };
    if (!stamped) {
      await db('invoices').where(invoiceClaimWhere(invoice.id, invoiceClaimToken))
        .update({ status: previousInvoiceStatus, send_claim_token: null, updated_at: db.fn.now() })
        .catch((err) => logger.warn(`[projects] invoice claim release after superseded stamp failed for ${invoice.id}: ${err.message}`));
      claimedInvoice = null;
      await reverseProjectCreditOnAbort();
      logger.error(`[projects] combined send superseded before token stamp for ${project.id} — claim taken over by a newer request`);
      return res.status(409).json({
        error: 'This send was superseded by a newer request — refresh and check the report status.',
        code: 'send_superseded',
      });
    }
    const refreshed = await db('projects').where({ id: project.id }).first();
    const { reportPath, reportUrl } = await sendReportLink({ hold, refreshed, customer, token });

    // Auto-apply available account credit BEFORE building the invoice PDF / pay
    // link / email — this combined project-report+invoice send bypasses
    // InvoiceService.sendViaSMSAndEmail, so without this a self-pay project
    // invoice would go out at the gross total. Gated + best-effort + idempotent;
    // applyAccountCreditToInvoice skips payer-billed invoices on its own. Re-read
    // in place so the PDF + email amount_due + pay page all reflect it. The
    // reversal helper (reverseProjectCreditOnAbort) is hoisted above the try so
    // every abort path — including the outer catch — can return this credit.
    try {
      const { autoApplyAccountCreditIfEnabled } = require('../services/customer-credit');
      // Defer the full-coverage side effects (stop dunning + activate the annual-
      // prepay term): this send applies credit BEFORE building/delivering and
      // reverses it if delivery fails, so those effects must not fire until the
      // invoice is actually delivered — otherwise a reversal leaves them un-undone.
      // We run them ourselves in the delivered-success branch below.
      // A held send never applies credit: the hold is refused up front for a customer with any credit balance.
      const projectCreditResult = hold.active ? null : await autoApplyAccountCreditIfEnabled(invoice.id, { deferFullCoverageSideEffects: true });
      if (projectCreditResult && projectCreditResult.applied > 0) {
        appliedProjectCredit = projectCreditResult.applied;
        projectCreditFullyCovered = !!projectCreditResult.fullyCovered;
        const freshInvoice = await db('invoices').where({ id: invoice.id }).first();
        if (freshInvoice) Object.assign(invoice, freshInvoice);
      }
    } catch (creditErr) {
      logger.warn(`[projects] account-credit auto-apply skipped for invoice ${invoice.id}: ${creditErr.message}`);
    }


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
      wdoPdf = await buildSendReportPdf(hold, refreshed, customer);
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
      try {
        await require('../services/payer').attachToInvoice(invoice);
        const invoiceForPdf = { ...invoice, customer, line_items: normalizeInvoiceLineItemsForPdf(invoice.line_items) };
        const invoiceBuffer = await buildInvoicePDFBuffer(invoiceForPdf);
        attachments.push(pdfEmailAttachment(`invoice-${invoice.invoice_number}.pdf`, invoiceBuffer));
      } catch (err) {
        logger.error(`[projects] invoice PDF build failed for ${invoice.invoice_number}: ${err.message}`);
        // The invoice-first email IS the invoice PDF: a held send without it fails before anything is sent.
        if (hold.active) throw err;
      }
    } catch (e) {
      await db('invoices').where(invoiceClaimWhere(invoice.id, invoiceClaimToken))
        .update({ status: previousInvoiceStatus, send_claim_token: null, updated_at: db.fn.now() }).catch(() => {});
      await reverseProjectCreditOnAbort();
      // The hold stamp is fenced on the claim token, so it is taken back before the claim is given back.
      await takeBackHoldStamp({ hold, project, deliveryClaimToken });
      await revertDeliveryClaimOnAbort(project.id);
      logger.error(`[projects] send PDF build/archive failed for ${refreshed.id}: ${e.message}`);
      return res.status(500).json({ error: `Could not generate the ${hold.active ? 'invoice PDF' : 'FDACS report'}; nothing was sent.` });
    }

    // For a third-party-billed invoice the homeowner gets a report-ONLY email
    // (FDACS PDF for WDO + report link, no invoice PDF / pay link); the invoice
    // + pay link go to the payer's AP inbox. `isPayerInvoice` keys off the
    // invoice's payer snapshot — NOT AP-email availability — so a misconfigured
    // payer (active, no usable ap_email) still never bills the homeowner.
    const reportAttachments = wdoPdf ? [wdoPdf.attachment] : [];
    const isPayerInvoice = !!invoice.payer_id;

    const typeLabel = getProjectType(project.project_type)?.label || 'Report';
    const firstName = customer.first_name || 'there';
    const channels = {};

    // Ownership recheck + lease renewal immediately before the external
    // sends (same contract as /send): re-stamping updated_at restarts the
    // takeover window at the moment delivery begins.
    const stillOwned = await db('projects')
      .where({ id: project.id, delivery_claim_token: deliveryClaimToken })
      .update({ updated_at: db.fn.now() });
    if (!stillOwned) {
      await db('invoices').where(invoiceClaimWhere(invoice.id, invoiceClaimToken))
        .update({ status: previousInvoiceStatus, send_claim_token: null, updated_at: db.fn.now() })
        .catch((err) => logger.warn(`[projects] invoice claim release after superseded delivery failed for ${invoice.id}: ${err.message}`));
      claimedInvoice = null;
      await reverseProjectCreditOnAbort();
      logger.error(`[projects] combined send superseded before delivery for ${project.id} — claim taken over; nothing sent by this request`);
      return res.status(409).json({
        error: 'This send was superseded by a newer request — refresh and check the report status.',
        code: 'send_superseded',
      });
    }

    // The recipient the invoice email really goes to: a held send resolves it with the contact's email switch (the
    // service contact falls back to the account holder), and that one address receives the email and is the one the
    // billing copy is compared with. (Resolved before anything is dispatched.)
    const emailRecipient = await combinedSendEmailRecipient(hold, customer, invoice);
    // ONE email FIRST — it carries the report attachments (the FDACS PDF for WDO)
    // + the invoice PDF. For WDO it's the required channel: the pay-link SMS is
    // only sent after the email succeeds, so a failed email can't leave the
    // customer with a bare pay-link text while the report is recorded not-sent
    // (and retries can't duplicate that text). For non-WDO the email is a bonus
    // (the report link rides in the SMS), so its failure doesn't block the text.
    if (hold.active) heldHandoffState = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    else dispatchStarted = true;
    channels.email = await sendCustomerInvoiceEmail({
      handoffState: heldHandoffState, hold, deliveryClaimToken, isPayerInvoice, isWdoProject, project, refreshed, customer, reportUrl, payUrl, invoice, attachments, reportAttachments, recipient: emailRecipient,
    });

    // Billing-contact copy: recipient resolution above prefers the slot-1
    // service contact, so a configured billing contact (notification_prefs
    // billing_email / billing-role contact — the same resolution standalone
    // invoice emails use) otherwise never sees the invoice, amount due, or pay
    // link. Same combined email, explicit recipient. Best-effort: failures are
    // recorded on channels but never change delivered/claim semantics — the
    // customer copy governs.
    let billingCopyEmail = '';
    // Bill-To delivery. For a third-party-billed invoice the payer AP inbox is
    // the PRIMARY invoice/pay-link delivery — send it INDEPENDENTLY of whether
    // the customer/report email succeeded (a homeowner with no/failed email
    // must not strand the payer invoice), and require it for invoice
    // finalization below. For self-pay, the billing-contact copy stays a
    // best-effort courtesy copy gated on the customer email succeeding.
    const payerBilling = invoice.payer
      ? require('../services/payer').payerRecipient(invoice.payer)
      : null;
    const payerBilled = !!payerBilling?.email;
    // Phase 2: an accrued invoice (attached to a payer statement) is delivered as
    // a line on the consolidated monthly statement — NEVER individually here (with
    // its child payUrl) and never finalized via markDeliverySent below. The
    // project REPORT still sends; only the per-invoice delivery is suppressed.
    const accruedOnStatement = !!invoice.payer_statement_id;
    if (accruedOnStatement) {
      // Intentionally no individual invoice delivery — billed on the statement.
    } else if (payerBilled) {
      billingCopyEmail = String(payerBilling.email).trim().toLowerCase();
      try {
        // Stable-per-recipient key: dedupes the AP copy after the first success
        // so a /send-with-invoice retry (the invoice can finalize off the payer
        // delivery even when the homeowner report leg fails) doesn't re-bill the
        // AP a duplicate — BUT keys on a hash of the AP email so that after an
        // operator corrects a wrong/blocked AP address, the retry produces a new
        // key and actually delivers to the corrected inbox instead of returning
        // the old terminal (blocked/bounced) result.
        const payerEmailHash = require('crypto').createHash('sha1').update(billingCopyEmail).digest('hex').slice(0, 12);
        const result = await ProjectEmail.sendProjectReportWithInvoice({
          project: refreshed, customer, reportUrl, payUrl, invoice, attachments,
          reportAttached: isWdoProject,
          recipient: { email: payerBilling.email, name: payerBilling.name || '', role: 'payer' },
          idempotencyKey: `project.report_with_invoice:${project.id}:${invoice.id}:payer:${payerEmailHash}`,
        });
        channels.payer_email = result.ok
          ? { ok: true, recipient: billingCopyEmail }
          : { ok: false, recipient: billingCopyEmail, error: projectEmailFailureMessage(result) };
        // Freeze the AP email we actually delivered to onto the snapshot (same
        // as sendInvoiceEmail), so the receipt + pay page keep routing to it even
        // if the payer row is later edited/deactivated.
        if (result.ok) {
          await require('../services/payer').freezeApEmail(invoice, billingCopyEmail);
        }
      } catch (e) {
        logger.error(`[projects] combined send payer copy failed: ${e.message}`);
        channels.payer_email = { ok: false, recipient: billingCopyEmail, error: e.message };
      }
    } else if (isPayerInvoice) {
      // Payer-billed but no usable AP email: the bill-to party can't be reached.
      // Record an explicit payer_email failure so the combined send is treated as
      // partial/failed (below) and the UI doesn't claim "Report + invoice
      // delivered" while the invoice is silently restored to draft — the operator
      // must fix the payer AP email and resend.
      channels.payer_email = { ok: false, recipient: null, error: 'Payer has no usable AP email — invoice not delivered to the bill-to party' };
    } else if (channels.email?.ok) {
      // Self-pay only. A payer-billed invoice must NEVER route the invoice/pay
      // link to the homeowner's billing contact — when the payer has no usable
      // AP email (payerBilled false), the invoice is simply not delivered (and
      // not finalized below) so the operator fixes the payer AP email. Falling
      // through here would expose the third-party bill + pay link to the
      // homeowner.
      const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
      const [billing] = getInvoiceEmailRecipients(customer, prefs || {});
      const billingEmail = String(billing?.email || '').trim().toLowerCase();
      // A held send's one invoice email already went to the billing recipient (the billing email authority's own).
      if (!hold.active && billingEmail && billingEmail !== String(emailRecipient.email || '').trim().toLowerCase()) {
        billingCopyEmail = billingEmail;
        try {
          const result = await sendBillingCopyEmail({
            isWdoProject, project, refreshed, customer, reportUrl, payUrl, invoice, attachments, billing,
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
    await sendReportCopiesUnlessHeld({
      hold, req, isWdoProject, channels, project, refreshed, customer, reportUrl, wdoPdf,
      excludeEmails: [emailRecipient.email, customer?.email, billingCopyEmail],
    });

    // ONE SMS — report link + pay link. It goes through the canonical
    // 'payment_link' policy (consent, kill switch, identity trust, invoiceId).
    // That policy forbids an exact price and caps at 2 segments, so the body
    // omits the dollar amount (it's on the pay page / invoice PDF) and stays
    // terse. For WDO it's sent only after the email succeeds, since the report
    // itself lives in the email-only FDACS PDF and a bare pay-link text would be
    // wrong; for non-WDO the report link is in the text, so it sends regardless.
    channels.sms = await sendInvoicePayLinkText({
      hold, isWdoProject, isPayerInvoice, emailOk: Boolean(channels.email?.ok), customer, project, invoice, firstName, typeLabel, reportUrl, payUrl, deliveryClaimToken,
    });

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
    const delivered_report = isWdoProject ? !!channels.email?.ok : successfulChannelCount > 0;
    // For a payer-billed invoice the AP (bill-to) leg is part of "delivered": the
    // project isn't fully delivered until BOTH the homeowner report and the payer
    // invoice go out. A missing/failed AP recipient makes it partial/failed even
    // when the homeowner report succeeded, so the UI never claims delivered while
    // the bill-to party never received the invoice.
    // Phase 2: an accrued invoice has NO individual AP leg (it ships on the
    // consolidated statement), so its payer leg is satisfied for REPORT-delivery
    // status — otherwise a successfully-sent homeowner report would be marked
    // failed, the claim restored, and retries duplicate the report.
    // invoiceDelivered (below) is still gated on !accruedOnStatement, so the
    // accrued invoice itself is never finalized here.
    const payerLegOk = !isPayerInvoice || accruedOnStatement || !!channels.payer_email?.ok;
    const delivered = sendIsDelivered({ hold, channels, deliveredReport: delivered_report, payerLegOk });
    const anySuccess = successfulChannelCount > 0
      || (isPayerInvoice && (accruedOnStatement || !!channels.payer_email?.ok));
    const deliveryStatus = !delivered
      ? (anySuccess ? 'partial' : 'failed')
      : (successfulChannelCount >= availableChannels.length ? 'sent' : 'partial');

    // Finalize the invoice as delivered (it went out alongside the report).
    // markDeliverySent uses the canonical finalization semantics: it promotes
    // draft / scheduled / sending → sent and clears scheduled_send_at (and the
    // scheduled-review fields), so a 'scheduled' invoice can't be re-sent later
    // by processScheduledSends. It does NOT send anything itself, so the
    // invoice's own SMS path never fires a second, duplicate text.
    // Invoice finalization is keyed on BILL-TO delivery, not report delivery:
    // a payer-billed invoice is "sent" only when the payer AP send succeeds
    // (so it can't be marked sent off the back of the customer/report email),
    // and conversely the payer send standing alone is enough even if the
    // homeowner report email failed. Self-pay keeps the report-delivery rule.
    // Phase 2: an accrued invoice is finalized by its statement, not here.
    const invoiceDelivered = !accruedOnStatement
      && (isPayerInvoice ? !!channels.payer_email?.ok : delivered);
    const unverifiedHeld = invoiceDelivered && hold.active && !isPayerInvoice && Boolean(channels.email?.uncertain);
    if (unverifiedHeld) {
      await settleUnverifiedHeldInvoice(invoice, previousInvoiceStatus, invoiceClaimToken);
    } else if (invoiceDelivered) {
      await InvoiceService.markDeliverySent(invoice.id, {
        sms: !!channels.sms?.ok,
        email: invoiceEmailReached({ isPayerInvoice, channels }),
        source: 'project_report_with_invoice',
        payUrl,
        actorTechnicianId: req.technicianId || null,
        claimToken: invoiceClaimToken,
      }).catch((err) => logger.error(`[projects] markDeliverySent failed for ${invoice.id}: ${err.message}`));
      // Invoice is delivered + finalized — now run the full-coverage side effects we
      // deferred at apply time (stop dunning followups + activate the annual-prepay
      // term). Deferred so a failed-delivery reversal never strands them; the
      // delivered path can't be reversed afterward. Best-effort; never blocks.
      if (projectCreditFullyCovered) {
        try {
          const { runPostFullCoverageSideEffects } = require('../services/customer-credit');
          await runPostFullCoverageSideEffects(invoice.id);
        } catch (sideErr) {
          logger.warn(`[projects] post-coverage side effects skipped for invoice ${invoice.id}: ${sideErr.message}`);
        }
      }
      // Delivery succeeded — the customer has the PDF/pay link built at amount due,
      // so the credit is legitimately consumed. Clear the pending reversal so a
      // throw in a LATER step (project status update, activity log, response) can't
      // make the outer catch reverse credit / reopen the invoice out from under an
      // already-delivered document.
      appliedProjectCredit = 0;
    } else {
      // Nothing went out — release the 'sending' claim back to its prior status
      // so the invoice isn't stranded and can be retried.
      await db('invoices').where(invoiceClaimWhere(invoice.id, invoiceClaimToken))
        .update({ status: previousInvoiceStatus, send_claim_token: null, updated_at: db.fn.now() }).catch(() => {});
      await reverseProjectCreditOnAbort();
    }

    // The sent copy follows the report leg alone: a report that reached the
    // owner is the copy even when a payer leg failed the send as a whole.
    await savePretreatSentCopy(refreshed, projectCols, { reportReached: delivered_report && !hold.active, claimToken: deliveryClaimToken });

    // Both delivered-branch finalizes are fenced on the claim token (same
    // contract as /send): zero rows = a stale takeover owns the row now.
    const finalized = await finalizeInvoiceSend({
      hold, delivered, project, refreshed, projectCols, channels, deliveryStatus, deliveryClaimToken, previousDeliveryStatus: deliveryClaim?.previousStatus ?? null, wdoFiling,
    });
    if (delivered && !finalized) {
      logger.error(`[projects] combined-send finalize fenced off for ${project.id} — claim superseded by a stale-takeover; outcome not recorded`);
    }
    await ringUncertainInvoiceEmailBell({ hold, delivered, channels, project, customer });
    // Delivered branches resolved the claim by writing the final
    // delivery_status; anything short of delivered restores the pre-claim
    // value so a failed send doesn't 409 retries for 10 minutes.
    if (delivered) deliveryClaim = null;
    else await revertDeliveryClaimOnAbort(project.id);

    const activity = sendActivityEntry({ hold, delivered, typeLabel, invoice, token });
    await logProjectActivity(
      req, project, activity.action, activity.description,
      { ...activity.meta, invoice_id: invoice.id, invoice_created: created, channels,
        ...(hasReadinessOverride ? { readiness_override: { reason: overrideReason, missing: readiness.missing } } : {}) },
    );

    res.json({
      project_id: project.id,
      invoice: { id: invoice.id, invoice_number: invoice.invoice_number, total: invoice.total, created },
      pay_url: payUrl,
      channels,
      delivery_status: deliveryStatus,
      sent: delivered,
      ...sendResponseHoldKeys({ hold, reportPath, token, delivered }),
    });
  } catch (err) {
    // Release the 'sending' claim on any abort so the invoice isn't stranded
    // (and retries don't 409). No-op if it was already finalized to 'sent'.
    if (claimedInvoice) {
      await db('invoices').where(invoiceClaimWhere(claimedInvoice.id, claimedInvoice.claimToken))
        .update({ status: claimedInvoice.previousStatus, send_claim_token: null, updated_at: db.fn.now() })
        .catch((e) => logger.warn(`[projects] claim release on error failed for ${claimedInvoice.id}: ${e.message}`));
    }
    // An exception before any customer message leaves no promise to keep: take the armed hold back, while this
    // request still owns the claim token it is fenced on (so before the claim is given back).
    if (armedHold && !(heldHandoffState ? heldHandoffState.handoffStarted : dispatchStarted)) await takeBackHoldStamp(armedHold);
    // Return the shared project delivery claim too (guarded: only reverts a
    // row still parked at 'sending', so a post-delivery throw can't clobber
    // the final delivery_status).
    await revertDeliveryClaimOnAbort(req.params.id);
    // Return this send's seam-applied credit too — a throw between apply and the
    // explicit WDO/no-delivery guards (e.g. while building the PDF or composing
    // the message) would otherwise leave the invoice settled-by-credit with no
    // pay link delivered. Runs after the claim release above so reverseAppliedCredit
    // isn't refused on a still-'sending' row.
    await reverseProjectCreditOnAbort();
    if (err?.message === 'Invoice not found for this customer') {
      return res.status(404).json({ error: err.message });
    }
    // A hold on a payer-billed or statement-billed service: refused BEFORE the invoice was created.
    if (err?.holdRefusal) {
      return res.status(err.holdRefusal.status).json({ error: err.message, code: err.holdRefusal.code });
    }
    // The invoice couldn't be auto-built from the visit (no linked visit / no
    // derivable pricing) — surface the actionable reason as a 422 rather than an
    // opaque 500.
    if (err?.code === 'invoice_build_failed') {
      return res.status(422).json({ error: err.message, code: err.code });
    }
    // The visit is already billed on a paid/in-flight/disputed invoice — block
    // the duplicate send with a 409 and point at the existing invoice.
    if (['already_billed', 'invoice_disputed'].includes(err?.code)) {
      return res.status(409).json({ error: err.message, code: err.code, invoice_id: err.invoiceId, invoice_number: err.invoiceNumber });
    }
    // No-charge WDO ($0 fee): nothing to bill — the operator sends the
    // report by itself instead. Same shape on dry-run and send, so the UI
    // shows the actionable message in the confirm flow.
    if (err?.code === 'wdo_no_charge' || err?.code === 'project_customer_changed') {
      return res.status(409).json({ error: err.message, code: err.code });
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
      ? await loadProjectCustomer(project.customer_id)
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
      ? await loadProjectCustomer(project.customer_id)
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

    // Job costing (non-blocking, fire-and-forget) — mirrors the dispatch
    // completion path (admin-dispatch.js). Project-backed services are completed
    // here, not through dispatch, so without this their service_records financials
    // (revenue / labor_hours / margin) would stay null and stay off the dashboard
    // + /admin/revenue tiles. The backfill migration covers existing history; this
    // keeps future project closeouts populated too.
    const costingServiceId = project.scheduled_service_id;
    if (result.serviceCompleted && costingServiceId) {
      try {
        const JobCosting = require('../services/job-costing');
        void JobCosting.calculateJobCost(costingServiceId).catch((e) =>
          logger.error(`[projects] job cost calc failed for ${costingServiceId}: ${e.message}`));
      } catch (e) {
        logger.error(`[projects] job costing require failed: ${e.message}`);
      }
    }

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
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const typeCfg = getProjectType(project.project_type);
    if (!typeCfg) return res.status(400).json({ error: 'Unknown project type' });

    const findings = req.body.findings || project.findings || {};
    const rawRecommendations = (req.body.recommendations !== undefined
      ? req.body.recommendations
      : project.recommendations) || '';
    const projectDate = normalizeDateOnly(req.body.project_date) || normalizeDateOnly(project.project_date) || normalizeDateOnly(project.created_at);

    const customer = await loadProjectCustomer(project.customer_id);
    const tech = project.created_by_tech_id
      ? await db('technicians').where({ id: project.created_by_tech_id }).first()
      : null;
    const includeCommunications = req.body.include_communications !== false;
    const includePhotos = req.body.include_photos !== false;
    const projectComms = includeCommunications
      ? await buildCompletionCommsContext({
        customerId: project.customer_id,
        scheduledServiceId: project.scheduled_service_id || null,
        // created_at is when the JOB opened; project_date is the
        // inspection date and would drop the pre-visit booking comms this
        // feature summarizes (Codex r3 — same rule as the preview above).
        originDate: project.created_at || null,
      }).catch(() => ({ text: '', promptHint: '' }))
      : { text: '', promptHint: '' };
    // Thread the relevance hint with the block (Codex P2) — the window
    // alone can hold unrelated-line comms the prompt must be told to skip.
    const communicationContext = projectComms.text
      ? `${projectComms.promptHint}\n${projectComms.text}`
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
      archivedFeeValues: projectArchivedFeeValues(project),
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

    let mutation;
    try {
      mutation = await db.transaction(async (trx) => {
        const locked = await lockProjectForPhotoMutation(project, trx);
        const [inserted] = await trx('project_photos').insert({
          project_id: project.id,
          s3_key: key,
          category: req.body.category || null,
          caption: clampPhotoCaption(req.body.caption),
          visit: req.body.visit === 'followup' ? 'followup' : 'primary',
          uploaded_by_tech_id: req.technicianId,
        }).returning('*');
        const stale = await flagWdoSignatureStaleForPhotos(project, trx, locked);
        return { row: inserted, staleness: stale };
      });
    } catch (e) {
      // The object went to S3 before this transaction — reclaim it on any
      // post-upload failure so a rejected mutation can't strand an
      // unreferenced customer photo in storage forever.
      if (config.s3?.bucket) {
        await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }))
          .catch((cleanupErr) => logger.warn(`[projects] orphan upload cleanup failed for project ${project.id}: ${cleanupErr.message}`));
      }
      if (e.code === 'send_in_progress') return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
    const { row, staleness } = mutation;

    await logProjectActivity(
      req,
      project,
      'project_photo_uploaded',
      `Project photo uploaded: ${req.file.originalname}`,
      { photo_id: row.id, category: row.category, visit: row.visit },
    );
    if (staleness === 'flagged') await logWdoPhotoStaleness(req, project, 'photo added');
    res.json({ photo: row, ...(staleness ? { signature_stale: true } : {}) });
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
    // DB record first, bytes second: destroying the S3 object before the
    // transaction meant a rolled-back delete (lock conflict, staleness-flag
    // failure) left a live DB row pointing at permanently-gone evidence on a
    // legal filing. The deletion-job tombstone rides the SAME transaction —
    // after commit it is the only surviving reference to the object, so it
    // must not be a best-effort write (a swallowed insert would strand the
    // object with nothing left to find it by). The post-commit S3 delete
    // below retires it; any failure leaves it queued for the
    // photo-orphan-reclaim sweep.
    let mutation;
    try {
      mutation = await db.transaction(async (trx) => {
        const locked = await lockProjectForPhotoMutation(project, trx);
        const count = await trx('project_photos')
          .where({ id: req.params.photoId, project_id: req.params.id })
          .del();
        if (!count) return { deleted: 0, staleness: false };
        let tombstoneId = null;
        if (config.s3?.bucket && photo.s3_key) {
          const [tombstone] = await trx('activity_log').insert({
            admin_user_id: req.technicianId || null,
            customer_id: project.customer_id,
            action: 'project_photo_delete_orphaned',
            description: `Photo storage object pending deletion (photo ${photo.id})`,
            metadata: { project_id: project.id, photo_id: photo.id, s3_key: photo.s3_key },
          }).returning('id');
          tombstoneId = (tombstone && tombstone.id) || tombstone || null;
        }
        const stale = await flagWdoSignatureStaleForPhotos(project, trx, locked);
        return { deleted: count, staleness: stale, tombstoneId };
      });
    } catch (e) {
      if (e.code === 'send_in_progress') return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
    const { deleted, staleness, tombstoneId } = mutation;
    if (!deleted) return res.status(404).json({ error: 'Photo not found' });
    // Best-effort is fine for RETIRING the tombstone (a missed stamp just
    // means the reclaim sweep re-deletes an already-missing key — a no-op on
    // S3 — and stamps it then); it was NOT fine for creating it.
    const retireTombstone = async (note) => {
      if (!tombstoneId) return;
      await db('activity_log').where({ id: tombstoneId }).update({
        metadata: JSON.stringify({
          project_id: project.id,
          photo_id: photo.id,
          s3_key: photo.s3_key,
          reclaimed_at: new Date().toISOString(),
          ...(note ? { reclaim_note: note } : {}),
        }),
      }).catch(() => {});
    };
    if (config.s3?.bucket && photo.s3_key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: photo.s3_key }));
        await retireTombstone();
      } catch (err) {
        if (!isMissingS3ObjectError(err)) {
          // Row is gone; the durable tombstone keeps the object reclaimable.
          // Plaintext log carries IDs only: s3 keys embed the original
          // filename, which can carry PII.
          logger.warn(`[projects] photo object orphaned after delete ${photo.id} (project ${req.params.id}); tombstone ${tombstoneId || 'n/a'} queued: ${err.message}`);
        } else {
          logger.warn(`[projects] photo object already missing ${photo.id} (project ${req.params.id})`);
          await retireTombstone('already_missing');
        }
      }
    }
    await logProjectActivity(
      req,
      project,
      'project_photo_deleted',
      `Project photo deleted: ${photo.caption || photo.category || photo.id}`,
      { photo_id: photo.id, category: photo.category, visit: photo.visit },
    );
    if (staleness === 'flagged') await logWdoPhotoStaleness(req, project, 'photo removed');
    res.json({ ok: true, ...(staleness ? { signature_stale: true } : {}) });
  } catch (err) { next(err); }
});

// PUT /api/admin/projects/:id/photos/:photoId — update caption / category
router.put('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!(await requireProjectAccess(req, res, project))) return;
    const updates = {};
    for (const f of ['caption', 'category', 'sort_order']) {
      if (req.body[f] !== undefined) {
        updates[f] = f === 'caption' ? clampPhotoCaption(req.body[f]) : req.body[f];
      }
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true });
    let mutation;
    try {
      mutation = await db.transaction(async (trx) => {
        const locked = await lockProjectForPhotoMutation(project, trx);
        const current = await trx('project_photos')
          .where({ id: req.params.photoId, project_id: req.params.id })
          .first();
        if (!current) return { changed: 0, staleness: false };
        // Only persist values that actually differ — Postgres reports a
        // matched row as updated even when nothing changed, and a no-op save
        // (open the caption editor, hit save) must never force a legal
        // re-sign on a signed WDO.
        const realChanges = {};
        for (const [field, value] of Object.entries(updates)) {
          if (String(current[field] ?? '') !== String(value ?? '')) realChanges[field] = value;
        }
        if (Object.keys(realChanges).length === 0) return { changed: 1, staleness: false };
        await trx('project_photos')
          .where({ id: req.params.photoId, project_id: req.params.id })
          .update({ ...realChanges, updated_at: db.fn.now() });
        // Caption/category/order all render into the FDACS photo addendum —
        // an edit to any of them on a signed WDO requires a re-sign.
        const stale = await flagWdoSignatureStaleForPhotos(project, trx, locked);
        return { changed: 1, staleness: stale };
      });
    } catch (e) {
      if (e.code === 'send_in_progress') return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
    const { changed, staleness } = mutation;
    if (!changed) return res.status(404).json({ error: 'Photo not found' });
    if (staleness === 'flagged') await logWdoPhotoStaleness(req, project, 'photo details edited');
    res.json({ ok: true, ...(staleness ? { signature_stale: true } : {}) });
  } catch (err) { next(err); }
});

router._private = {
  billingFingerprintHash,
  filingKeyPart,
  resumableReleaseFiling,
  pretreatSentSnapshot,
  assertTechnicianProjectLinkStillAssigned,
  canAccessProject,
  hasProjectAccess,
  detectedImageMime,
  validateUploadedImage,
  isMissingS3ObjectError,
  logProjectActivity,
  evaluateProjectSendReadiness,
  pretreatWarrantyOk,
  publishedCertificateEditRejection,
  completeProjectBackedService,
  dropStaleCertTreatmentDate,
  resolveWdoInspectionFee,
  resolveWdoFeeForProject,
  maybeRepriceWdoDraft,
  markSentOutsideBlock,
  nonSendableProjectInvoicePayload,
  alreadyBilledProjectError,
  wdoAddendumPhotoCaption,
  wdoFeeIsExplicitZero,
};

module.exports = router;
// WDO report hold release: consumed by services/project-report-hold.js (the sweep) by lazy require; it lives here
// so it reuses the send path's helpers (PDF build, filing archive, copies, gates) without moving them.
module.exports.releaseHeldProjectReport = releaseHeldProjectReport;
