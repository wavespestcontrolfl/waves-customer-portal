'use strict';

/**
 * Inputs for the lawn "From your technician" paragraph (lawn-tech-paragraph.js,
 * fixed sentences), read once at completion from the report data the completion
 * gate has just built (the same object the customer report renders) plus one
 * small read: the visit's kept photo findings.
 *
 * The paragraph uses three inputs: the technician's note (the model extracts from
 * it), the applied product names, and the LOW-confidence kept photo findings (the
 * "may be" line). A higher-confidence finding is not an input: the report's own
 * "What the photos showed" block prints it.
 *
 * Fail closed: a read that throws propagates, and the caller stores no
 * paragraph. A read that succeeds and finds nothing is an empty input.
 *
 * What it never passes on: any customer name, an address, a price, the raw photo
 * list, the photo read's free text, a score, a prior visit.
 */

const { appliedFromProducts } = require('./lawn-visit-memory');
const { keptRunRows } = require('./tip-library');
const { PHOTO_FINDING_LABELS } = require('./lawn-photo-findings');
const { normalizeInputs, FINDING_OF_PHOTO_LABEL } = require('./lawn-tech-paragraph');

const ALLOWED_LABELS = new Set(PHOTO_FINDING_LABELS);
const LOW_CONFIDENCE = new Set(['low', 'unknown']);

/**
 * The kept, allowlisted findings of one assessment's reviewed run: the same keep
 * rule as the report's "What the photos showed" block (technician-confirmed
 * assessment, the run's own, reviewed), with the read's confidence kept beside
 * each label.
 */
function keptFindings(run, assessment) {
  if (!run || !assessment || assessment.confirmed_by_tech !== true) return [];
  if (String(run.assessment_id) !== String(assessment.id)) return [];
  if (run.customer_id != null && assessment.customer_id != null && String(run.customer_id) !== String(assessment.customer_id)) return [];
  if (!run.reviewed_at) return [];
  const { reviewed, added } = keptRunRows(run);
  const seen = new Set();
  const out = [];
  for (const row of [...reviewed, ...added]) {
    if (!row || typeof row.label !== 'string' || !ALLOWED_LABELS.has(row.label) || seen.has(row.label)) continue;
    seen.add(row.label);
    out.push({ label: row.label, confidence: row.confidence });
  }
  return out;
}

async function readKeptFindings(knex, assessmentId) {
  if (assessmentId == null) return [];
  const assessment = await knex('lawn_assessments').where({ id: assessmentId }).first('id', 'customer_id', 'confirmed_by_tech');
  if (!assessment) return [];
  const run = await knex('lawn_assessment_runs')
    .where({ assessment_id: assessmentId, customer_id: assessment.customer_id })
    .first('assessment_id', 'customer_id', 'reviewed_findings', 'added_details', 'reviewed_at');
  return keptFindings(run, assessment);
}

/**
 * @param {object} args
 * @param {object} args.record  the customer-joined service record (technician_notes)
 * @param {object} args.data    buildReportV1Data output (reportV2, lawnAssessment)
 * @param {object} args.knex
 * @returns {Promise<object|null>} normalized inputs, or null when the visit cannot support a paragraph
 */
async function gatherTechParagraphInputs({ record, data, knex }) {
  const reportV2 = data && data.reportV2;
  const lawnAssessment = data && data.lawnAssessment;
  const assessmentId = lawnAssessment && lawnAssessment.assessmentId;
  if (!reportV2 || assessmentId == null || !record) return null;
  // A report build that could not read its inputs cleanly froze nothing; the
  // paragraph is not written from a degraded read either.
  if (lawnAssessment.lawnCopyV6Unfrozen === true) return null;

  const products = appliedFromProducts(reportV2.treatment && reportV2.treatment.products);
  const findings = (await readKeptFindings(knex, assessmentId))
    .filter((f) => LOW_CONFIDENCE.has(f.confidence) && FINDING_OF_PHOTO_LABEL[f.label])
    .map((f) => ({ key: FINDING_OF_PHOTO_LABEL[f.label] }));
  return normalizeInputs({ technicianNote: record.technician_notes, products, findings });
}

module.exports = { gatherTechParagraphInputs, keptFindings };
