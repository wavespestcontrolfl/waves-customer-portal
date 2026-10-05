'use strict';

/**
 * Inputs for the lawn "From your technician" paragraph (lawn-tech-paragraph.js),
 * read once at completion from the report data the completion gate has just
 * built (the same object the customer report renders) plus three small reads:
 * the visit's kept photo findings, the last visit's kept photo findings, and the
 * product catalog's names (a defense list for the validator).
 *
 * Fail closed: a read that throws propagates, and the caller stores no
 * paragraph. A read that succeeds and finds nothing is an empty input, not a
 * failure.
 *
 * What it never passes on: the raw observation free text, any customer name, an
 * address, a price, the visit's raw photo list.
 */

const { appliedFromProducts } = require('./lawn-visit-memory');
const { keptRunRows } = require('./tip-library');
const { PHOTO_FINDING_LABELS } = require('./lawn-photo-findings');
const { buildSinceLastCopy, METRIC_SENTENCE, WATCH_TOPIC } = require('./lawn-since-last-copy');
const { normalizeInputs } = require('./lawn-tech-paragraph');

// The progress sentences that speak to density, weeds and stressed areas. Color
// and the overall direction are left out: the paragraph never compares color
// between visits, and the overall direction can rest on color when the lighting
// gate is off.
const PROGRESS_METRICS = ['turf_density', 'weed_suppression', 'stress_damage'];
const PROGRESS_SENTENCES = new Set(PROGRESS_METRICS.flatMap((metric) => Object.values(METRIC_SENTENCE[metric] || {})));
// Watch topics the watering banner owns: the paragraph says nothing about them.
const SKIPPED_WATCH = new Set(['water', 'coverage']);

const ALLOWED_LABELS = new Set(PHOTO_FINDING_LABELS);

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

function withMethods(applied, products) {
  const methodOf = new Map((Array.isArray(products) ? products : []).map((p) => [p && p.name, p && p.method]));
  return applied.map((a) => ({ ...a, method: methodOf.get(a.name) || null }));
}

function wateringSummary(instruction) {
  const lines = instruction && Array.isArray(instruction.lines) ? instruction.lines.filter((l) => typeof l === 'string' && l.trim()) : [];
  return lines.slice(0, 2).join(' ') || null;
}

/**
 * @param {object} args
 * @param {object} args.record  the customer-joined service record (technician_notes, first_name)
 * @param {object} args.data    buildReportV1Data output (reportV2, lawnAssessment)
 * @param {object} [args.instruction]  the visit's watering instruction (lines)
 * @param {object} args.knex
 * @returns {Promise<object|null>} normalized inputs, or null when the visit cannot support a paragraph
 */
async function gatherTechParagraphInputs({ record, data, instruction = null, knex }) {
  const reportV2 = data && data.reportV2;
  const lawnAssessment = data && data.lawnAssessment;
  const assessmentId = lawnAssessment && lawnAssessment.assessmentId;
  if (!reportV2 || assessmentId == null || !record) return null;
  // A report build that could not read its inputs cleanly froze nothing; the
  // paragraph is not written from a degraded read either.
  if (lawnAssessment.lawnCopyV6Unfrozen === true) return null;

  const products = withMethods(appliedFromProducts(reportV2.treatment && reportV2.treatment.products), reportV2.treatment && reportV2.treatment.products);
  const snapshot = reportV2.snapshot || {};

  const sinceLast = reportV2.sinceLast && typeof reportV2.sinceLast === 'object' ? reportV2.sinceLast : null;
  let prior = null;
  if (sinceLast && /^\d{4}-\d{2}-\d{2}$/.test(String(sinceLast.priorDate || ''))) {
    prior = {
      date: sinceLast.priorDate,
      products: Array.isArray(sinceLast.applied) ? sinceLast.applied : [],
      watched: (Array.isArray(sinceLast.checks) ? sinceLast.checks : [])
        .filter((c) => c && !SKIPPED_WATCH.has(c.key) && WATCH_TOPIC[c.key])
        .map((c) => WATCH_TOPIC[c.key]),
      findings: sinceLast.priorAssessmentId != null ? await readKeptFindings(knex, sinceLast.priorAssessmentId) : [],
    };
  }

  let progressLines = [];
  if (sinceLast && reportV2.progress) {
    // The fixed sentences the "Since your last visit" block would print; a build
    // failure leaves the paragraph without progress lines, never with a guess.
    try {
      const copy = buildSinceLastCopy({ sinceLast, progress: reportV2.progress, insights: reportV2.insights, bannerPresent: true });
      progressLines = copy ? copy.lines.filter((line) => PROGRESS_SENTENCES.has(line)) : [];
    } catch { progressLines = []; }
  }

  const catalogRows = await knex('products_catalog').select('name');
  return normalizeInputs({
    technicianNote: record.technician_notes,
    products,
    scores: {
      overall: snapshot.overallScore,
      rows: (Array.isArray(reportV2.diagnosis) ? reportV2.diagnosis : []).map((d) => ({ label: d && d.label, score: d && d.score })),
    },
    findings: await readKeptFindings(knex, assessmentId),
    prior,
    progressLines,
    facts: { headline: snapshot.statusHeadline, watering: wateringSummary(instruction) },
    knownProductNames: (catalogRows || []).map((row) => row && row.name),
  });
}

module.exports = { gatherTechParagraphInputs, keptFindings, PROGRESS_SENTENCES };
