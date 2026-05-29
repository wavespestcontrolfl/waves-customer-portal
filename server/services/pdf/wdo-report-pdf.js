/**
 * FDACS-13645 Wood-Destroying Organisms Inspection Report — official PDF filler.
 *
 * Takes a `wdo_inspection` project's structured findings and stamps them onto
 * the genuine state form (server/assets/forms/fdacs-13645-fillable.pdf — the
 * decrypted, fillable AcroForm version of forms.fdacs.gov/13645.pdf). The
 * output is the real FDACS form, filled and flattened (locked) so it can be
 * filed / handed to a realtor or buyer.
 *
 * Signature protocol (Rule 5E-14.142, F.A.C. / Ch. 482.226, F.S.): the report
 * must carry the signature of the licensee/cardholder who performed the
 * inspection. We DO NOT auto-forge a signature — the printed name, ID-card
 * number, and date are filled, but the signature line is left blank for the
 * licensee to sign (wet or e-sign) before filing.
 *
 * Field mapping is intentionally defensive: a missing/renamed field in a future
 * form revision is logged and skipped, never thrown, so one bad field can't
 * fail the whole report.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const logger = require('../logger');
const {
  WAVES_BUSINESS_NAME,
  WAVES_FDACS_LICENSE_NUMBER,
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
} = require('../../constants/business');
const { formatDisplayDate } = require('../../utils/date-only');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'forms', 'fdacs-13645-fillable.pdf');

let cachedTemplateBytes = null;
function loadTemplateBytes() {
  if (!cachedTemplateBytes) {
    cachedTemplateBytes = fs.readFileSync(TEMPLATE_PATH);
  }
  return cachedTemplateBytes;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function asObject(value) {
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

// Split "13649 Luxe Ave #110, Bradenton, FL 34211" into street / city-state-zip.
function splitCompanyAddress(line) {
  const raw = clean(line);
  const idx = raw.indexOf(',');
  if (idx < 0) return { street: raw, cityStateZip: '' };
  return {
    street: raw.slice(0, idx).trim(),
    cityStateZip: raw.slice(idx + 1).trim(),
  };
}

function displayDate(value) {
  if (!value) return '';
  return formatDisplayDate(value, { fallback: '' });
}

function joinMulti(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(', ');
  return clean(value);
}

/**
 * Build the field value map: FDACS AcroForm field name -> value/instruction.
 * Text fields take a string. Checkboxes/radios are handled separately below.
 */
function buildTextValues({ findings, customer, project, applicator }) {
  const addr = splitCompanyAddress(WAVES_ADDRESS_LINE);
  const propertyAddress = clean(findings.property_address)
    || [customer?.address_line1, [customer?.city, customer?.state].filter(Boolean).join(', '), customer?.zip]
      .filter(Boolean).join(' ');
  const inspectionDate = displayDate(findings.inspection_date || project?.project_date || project?.created_at);

  return {
    // Section 1 — inspection company / inspector
    'Inspection Company Name': WAVES_BUSINESS_NAME,
    'Business License Number': WAVES_FDACS_LICENSE_NUMBER,
    'Company Address': addr.street,
    'Company City State and Zip Code': addr.cityStateZip,
    'Phone Number': WAVES_SUPPORT_PHONE_DISPLAY,
    'Date of Inspection': inspectionDate,
    'Print Name': clean(applicator.name),
    'ID Card No': clean(applicator.idCardNo),

    // Property + requester
    'Address of Property Inspected': propertyAddress,
    'addrofpropinspected': propertyAddress,
    'inspecdate8': inspectionDate,
    'Structures on Property Inspected': clean(findings.structures_inspected),
    'Name and Contact Information': clean(findings.requested_by),
    'Name and Contact Information if different from above': clean(findings.report_sent_to),

    // Section 2 — findings detail
    'Common Name of Organism and Location  use additional page if needed': clean(findings.live_wdo),
    'Common Name Description and Location  Describe evidence': clean(findings.wdo_evidence),
    'Common Name Description and Location of all visible damage  Describe damage': clean(findings.wdo_damage),
    'not visible andor accessible for inspection The descriptions and reasons for inaccessibility are stated below':
      clean(findings.inaccessible_areas),
    'SPECIFIC AREAS': clean(findings.inaccessible_areas),

    // Section 3/4 — previous + current treatment
    'treatment List what was observed': clean(findings.previous_treatment_notes),
    'comorgtreated': joinMulti(findings.organism_treated),
    'pesticideused': clean(findings.pesticide_used),
    'termscondtreat': clean(findings.treatment_terms),
    'locationtreatment': clean(findings.treatment_notice_location || findings.notice_location),

    // Section 5 — comments / financial disclosure
    'Comments 1': clean(findings.comments),
    'Date': inspectionDate,

    // Signature intentionally left blank — licensee signs before filing.
    // 'signaturelicensee': '',
  };
}

function setText(form, name, value) {
  const v = clean(value);
  if (!v) return;
  try {
    const field = form.getTextField(name);
    field.setText(v);
  } catch (err) {
    logger.warn(`[wdo-pdf] text field skipped "${name}": ${err.message}`);
  }
}

function checkBox(form, name) {
  try {
    form.getCheckBox(name).check();
  } catch (err) {
    logger.warn(`[wdo-pdf] checkbox skipped "${name}": ${err.message}`);
  }
}

function selectRadio(form, name, option) {
  try {
    form.getRadioGroup(name).select(option);
  } catch (err) {
    logger.warn(`[wdo-pdf] radio skipped "${name}"=${option}: ${err.message}`);
  }
}

function applyCheckboxes(form, findings) {
  // Section 2 finding (mutually exclusive checkboxes on the form)
  const finding = clean(findings.wdo_finding).toLowerCase();
  if (finding.startsWith('no visible')) {
    checkBox(form, 'NO visible signs of WDOs live evidence or damage observed');
  } else if (finding.startsWith('visible')) {
    checkBox(form, 'VISIBLE evidence of WDOs was observed as follows');
    // Tick the sub-findings that actually have content.
    if (clean(findings.live_wdo)) checkBox(form, '1 LIVE WDOs');
    if (clean(findings.wdo_evidence)) {
      checkBox(form, '2 EVIDENCE of WDOs dead wooddestroying insects or insect parts frass shelter tubes exit holes or other evidence');
    }
    if (clean(findings.wdo_damage)) checkBox(form, '3 DAMAGE caused by WDOs was observed and noted as follows');
  }

  // Inaccessible / obstructed areas — keyword-detect to tick the named boxes.
  const inacc = clean(findings.inaccessible_areas).toLowerCase();
  if (inacc) {
    if (inacc.includes('attic')) checkBox(form, 'Attic');
    if (inacc.includes('interior')) checkBox(form, 'Interior');
    if (inacc.includes('exterior')) checkBox(form, 'Exterior');
    if (inacc.includes('crawl')) checkBox(form, 'Crawlspace');
  }

  // Treatment method
  const method = clean(findings.treatment_method).toLowerCase();
  if (method.includes('whole')) checkBox(form, 'Whole structure');
  if (method.includes('spot')) checkBox(form, 'Spot treatment');

  // Previous treatment evidence (Yes/No radio)
  const prev = clean(findings.previous_treatment_evidence).toLowerCase();
  if (prev === 'yes') selectRadio(form, 'evidprevtreat', 'Yes');
  else if (prev === 'no') selectRadio(form, 'evidprevtreat', 'No');

  // Treated at time of inspection (Yes_2/No_2 radio)
  const treated = clean(findings.treated_at_inspection).toLowerCase();
  if (treated === 'yes') selectRadio(form, 'cotreatatinspect', 'Yes_2');
  else if (treated === 'no') selectRadio(form, 'cotreatatinspect', 'No_2');
}

/**
 * Resolve the inspector identity for Section 1. Falls back through the
 * project's stored tech identity and structured findings.
 */
function resolveApplicator({ project = {}, findings = {} }) {
  return {
    name: clean(
      findings.inspector_name
      || findings.applicator_name
      || project.tech_name
      || project.technician_name,
    ),
    idCardNo: clean(findings.applicator_fdacs_id || findings.inspector_id_card),
  };
}

/**
 * Build the filled, flattened FDACS-13645 PDF as a Buffer.
 * @param {object} args
 * @param {object} args.project    projects row (findings may be JSON string)
 * @param {object} args.customer   customers row (for address fallback)
 * @param {object} [args.applicator]  resolved inspector identity ({ name, idCardNo }).
 *   The WDO findings don't collect the inspector and a plain `db('projects')`
 *   load has no `tech_name`, so callers resolve the technician and pass it in;
 *   we fall back to the project/findings only if it's omitted.
 */
async function buildWdoReportPDFBuffer({ project, customer, applicator: applicatorOverride } = {}) {
  if (!project) throw new Error('project required for WDO report PDF');
  const findings = asObject(project.findings);
  const resolved = resolveApplicator({ project, findings });
  const applicator = {
    name: clean(applicatorOverride?.name) || resolved.name,
    idCardNo: clean(applicatorOverride?.idCardNo) || resolved.idCardNo,
  };

  const pdfDoc = await PDFDocument.load(loadTemplateBytes());
  const form = pdfDoc.getForm();

  const textValues = buildTextValues({ findings, customer, project, applicator });
  for (const [name, value] of Object.entries(textValues)) {
    setText(form, name, value);
  }
  applyCheckboxes(form, findings);

  // Flatten so the filed report is read-only (signature line stays blank for
  // the licensee). flatten() bakes field values into page content.
  try {
    form.flatten();
  } catch (err) {
    logger.warn(`[wdo-pdf] flatten failed for project ${project.id}: ${err.message}`);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = {
  buildWdoReportPDFBuffer,
  // exported for tests
  _private: { splitCompanyAddress, resolveApplicator, buildTextValues },
};
