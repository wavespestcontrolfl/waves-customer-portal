'use strict';

/**
 * Tree & shrub "From your technician" paragraph: the completion step
 * (GATE_TS_TECH_PARAGRAPH). Called from complete-scheduled-service.js, post
 * commit, next to the lawn write gate. Best-effort by contract: it never
 * throws, never blocks the completion beyond the paragraph's own 15 second
 * deadline, and stores nothing on any miss.
 *
 * ONE deadline covers the whole step, from the first read: the assessment
 * lookup, the report build (the same object the customer report renders, built
 * without any model call), the input gather, the one model call, the validation
 * and the freeze, because the technician is waiting at Complete. The lookup is
 * raced here; the rest runs inside the engine's deadline
 * (tech-paragraph-engine.js), which gets only what is left.
 *
 * Gate off, or not a tree & shrub visit: returns before any read or call.
 */

const crypto = require('crypto');
const logger = require('../logger');
const featureGates = require('../../config/feature-gates');
const { detectServiceLine } = require('./service-line-configs');

/**
 * @param {object} input
 * @param {object} input.service  the service_records row (needs id, service_line / service_type)
 * @param {object} input.knex
 * @param {string|null} input.reportToken  the completion's own report token; never minted here (a
 *   token this helper minted could not reach the completion flow, which would then withhold the
 *   text for a missing token). No token: no paragraph.
 * @param {object} [input.deps]   test seams: { generate, now, callModel }
 * @returns {Promise<object|null>} { [assessmentId]: entry } for the caller's in-memory
 *   structured_notes, or null (nothing frozen; an already-frozen entry is not returned)
 */
async function freezeTreeShrubTechParagraph({
  service, knex, reportToken, deps = {},
} = {}) {
  if (!service || !service.id || !knex) return null;
  if (!featureGates.tsTechParagraphLive()) return null;
  const serviceLine = service.service_line || detectServiceLine(service.service_type);
  if (serviceLine !== 'tree_shrub') return null;
  if (!reportToken) {
    logger.info(`[ts-tech-paragraph] none for service_record ${service.id}: no_report_token`);
    return null;
  }

  const tech = require('./tree-shrub-tech-paragraph');
  const startedAt = Date.now();
  const remaining = () => tech.BUDGET_MS - (Date.now() - startedAt);
  const TIMEOUT = Symbol('timeout');
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), tech.BUDGET_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });

  const work = (async () => {
    try {
      const { loadLinkedTreeShrubAssessment } = require('../tree-shrub-assessment');
      // The paragraph belongs to the visit's confirmed assessment (the one the report
      // reads). No assessment row yet (the photo scoring is still running or failed)
      // means no report to sit in, so no paragraph.
      const assessment = await loadLinkedTreeShrubAssessment(service, knex);
      if (!assessment || assessment.id == null) {
        logger.info(`[ts-tech-paragraph] none for service_record ${service.id}: no_assessment`);
        return null;
      }
      const assessmentId = String(assessment.id);
      if (remaining() < 1000) return TIMEOUT;

      const outcome = await tech.createAndFreezeTechParagraph({
        serviceRecordId: service.id,
        assessmentId,
        budgetMs: remaining(),
        // The row's CURRENT notes, read inside the step's one deadline: a retried
        // completion finds the freeze and spends no second call.
        getStructuredNotes: async () => (await knex('service_records').where({ id: service.id }).first('structured_notes'))?.structured_notes,
        gatherInputs: async () => {
          const { buildReportV1Data } = require('./report-data');
          const { loadServiceRecordForPdf } = require('./pdf-queue');
          const joined = await loadServiceRecordForPdf(service.id, knex).catch(() => null);
          const record = joined || service;
          // Side-effect free: the build takes the cached treatment narrative or the
          // deterministic template and never dispatches the narrative lane, so this
          // step makes exactly one model call.
          const data = await buildReportV1Data(record, reportToken, knex, { skipNarrativeGeneration: true }).catch(() => null);
          // The build looks the assessment up again. If another one landed in
          // between, the gathered findings may be from it, not from the one the
          // freeze is keyed to: no paragraph (Codex r7). After this re-check a later
          // assessment only means the build used the selected one.
          const after = await loadLinkedTreeShrubAssessment(service, knex);
          if (!after || String(after.id) !== assessmentId) {
            logger.info(`[ts-tech-paragraph] none for service_record ${service.id}: assessment_changed`);
            return null;
          }
          return require('./tree-shrub-tech-paragraph-inputs').gatherTreeShrubTechParagraphInputs({ record, data, knex });
        },
        knex,
        deps,
      });
      if (outcome.status !== 'frozen' && outcome.status !== 'already_frozen') {
        logger.info(`[ts-tech-paragraph] none for service_record ${service.id}: ${outcome.status}${outcome.problems && outcome.problems.length ? ` (${outcome.problems.join(', ')})` : ''}`);
      }
      return outcome.entry ? { [assessmentId]: outcome.entry } : null;
    } catch (err) {
      logger.warn(`[ts-tech-paragraph] step failed for service_record ${service.id}: ${err.message}`);
      return null;
    }
  })();
  work.catch(() => {}); // a late settle after the deadline is never an unhandled rejection

  try {
    const result = await Promise.race([work, deadline]);
    if (result === TIMEOUT) {
      logger.info(`[ts-tech-paragraph] none for service_record ${service.id}: timeout`);
      return null;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PDF cache-key component: the frozen paragraph is text the PDF prints, so a PDF
 * cached before the paragraph existed is never served after it, and a changed
 * text re-keys. '' unless the gate is live, the visit is a tree & shrub visit
 * with a confirmed assessment, and a whole frozen entry exists, so every other
 * visit keeps its key byte for byte. Derived from the `service` snapshot's own
 * structured_notes (the render's snapshot). Any failed lookup (the assessment), or a
 * row without the column, stamps a random sentinel (a fresh render, never a stale hit).
 */
async function treeShrubTechParagraphPdfSignature(service, knex) {
  if (!featureGates.tsTechParagraphLive() || !service || !service.id || !knex) return '';
  try {
    const line = service.service_line || detectServiceLine(service.service_type);
    if (line !== 'tree_shrub') return '';
    const { loadLinkedTreeShrubAssessment } = require('../tree-shrub-assessment');
    // Strict: a failed lookup throws into the sentinel below, never into "no paragraph".
    const assessment = await loadLinkedTreeShrubAssessment(service, knex, { strict: true });
    if (!assessment || assessment.id == null) return '';
    // The SAME structured_notes snapshot the render reads (the service object the
    // caller hands buildReportV1Data), never a fresh read of the row: a paragraph
    // frozen between the caller's load and this call must not key a PDF that was
    // built without it. A caller whose row lacks the column cannot be keyed safely.
    if (!Object.hasOwn(service, 'structured_notes')) throw new Error('structured_notes not loaded');
    return require('./tree-shrub-tech-paragraph').techParagraphSignature(service.structured_notes, assessment.id);
  } catch {
    return `:tp=err${crypto.randomBytes(4).toString('hex')}`;
  }
}

module.exports = { freezeTreeShrubTechParagraph, treeShrubTechParagraphPdfSignature };
