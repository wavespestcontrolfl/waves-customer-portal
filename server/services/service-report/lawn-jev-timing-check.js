/**
 * Jev result-timing check on the model-written lawn DIAGNOSIS summary (owner
 * 2026-10-28, "add it" 2026-10-29; dark behind GATE_LAWN_JEV_TIMING_CHECK =
 * off | shadow | enforce).
 *
 * The word list (report-writer-rules lawnResultTimingViolation) reads patterns,
 * not meaning. In a replay on 16 new timing claims it missed 5 ("By mid-November
 * the color should be much better."); Jev (package lawn_result_timing.v1) caught
 * all 16 with one false flag in 32 sentences, and the two together missed none.
 *
 * Target: the contract's `customer_summary` that the three lawn diagnosis
 * writers store in lawn_diagnostics (routes/public-lawn-assessment.js, routes/
 * tech-lawn-diagnostic.js persist, services/photo-assessment-create.js
 * runLawnAnalysis). Each calls checkDiagnosisSummary(contract, ...) just before
 * its insert and afterInsert(rowId) right after it. Customers read the summary
 * through public-lawn-diagnostic.js -> safeCustomerSummary, whose egress word
 * list (withoutResultTimingSentences) still runs after this check.
 *
 *  - off (default): the contract comes back untouched, nothing is asked.
 *  - shadow: the contract comes back untouched and no wait is added; after the
 *    insert, Jev is asked and the verdict is recorded against the new row.
 *  - enforce: the request waits (bounded by JEV_TIMING_CHECK_TIMEOUT_MS) and the
 *    sentences Jev flags are dropped from customer_summary BEFORE the row is
 *    stored, the way withoutResultTimingSentences drops word-list hits. A failed
 *    or late verdict keeps the text (fail open).
 * Only the MODEL's summary is checked (`modelWritten`): a deterministic summary
 * is fixed reviewed copy, and a technician's typed aiSummary never comes here.
 *
 * lawnJevTimingVerdict(text) puts every sentence to Jev in parallel and folds
 * the answers into ONE: { p: the largest p, yes: that p >= 0.5, confident: every
 * sentence confident }. A sentence whose call failed or did not answer in time
 * leaves the whole text with no verdict (null). It never throws.
 *
 * Out of scope: lawn-visit-summary.js (fixed, reviewed table phrases, no model
 * text) and lawn-diagnostic-report.js withoutResultTimingSentences (the
 * read-time egress scrub of stored summaries, which keeps running).
 */
const logger = require('../logger');
const { sentencesOf, MAX_SENTENCES } = require('./lawn-draft-timing-check');

const PACKAGE_ID = 'lawn_result_timing.v1';
const QUESTION_ID = 'states_result_timing';
// The whole step (every sentence, in parallel) is bounded by this.
const JEV_TIMING_CHECK_TIMEOUT_MS = 3000;
const SUBJECT_TYPE = 'lawn_diagnostics';

// Several sentences' answers -> the one answer the review row and the gate use.
function aggregateAnswers(answers) {
  const p = Math.max(...answers.map((answer) => answer.p));
  return { p, yes: p >= 0.5, confident: answers.every((answer) => answer.confident === true) };
}

/**
 * @param {string} text a summary the writers produced
 * @param {object} [deps] { ask? (tests), timeoutMs? }
 * @returns {Promise<null | {flagged:boolean, flaggedSentences:string[], answer:object, result:object}>}
 *   null = no verdict (nothing to ask, too long, a call failed or timed out).
 *   `result` is shaped for recordDecisions (ok, answers, packageId, packageHash,
 *   servedModel, provider).
 */
async function lawnJevTimingVerdict(text, deps = {}) {
  try {
    const sentences = sentencesOf(text);
    if (!sentences.length) return null;
    if (sentences.length > MAX_SENTENCES) {
      logger.warn(`[lawn-jev-timing-check] summary has ${sentences.length} sentences (limit ${MAX_SENTENCES}), not checked`);
      return null;
    }
    const ask = deps.ask || require('../typed-decisions/jev').askPackage;
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : JEV_TIMING_CHECK_TIMEOUT_MS;
    let timer;
    const results = await Promise.race([
      Promise.all(sentences.map((sentence) => Promise.resolve()
        .then(() => ask(PACKAGE_ID, { sentence }))
        .catch(() => null))),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, null); if (timer.unref) timer.unref(); }),
    ]);
    clearTimeout(timer);
    if (!results) {
      logger.warn(`[lawn-jev-timing-check] no verdict inside ${timeoutMs} ms, summary kept`);
      return null;
    }
    const usable = results.filter((result) => result && result.ok === true
      && result.answers && result.answers[QUESTION_ID]
      && typeof result.answers[QUESTION_ID].p === 'number');
    if (usable.length < sentences.length) {
      logger.warn(`[lawn-jev-timing-check] ${sentences.length - usable.length} of ${sentences.length} sentence calls failed, summary kept`);
      return null;
    }
    const answer = aggregateAnswers(usable.map((result) => result.answers[QUESTION_ID]));
    const first = usable[0];
    const flaggedSentences = sentences.filter((_sentence, index) => usable[index].answers[QUESTION_ID].yes === true);
    return {
      flagged: flaggedSentences.length > 0,
      flaggedSentences,
      answer,
      result: {
        ok: true,
        answers: { [QUESTION_ID]: answer },
        packageId: first.packageId || PACKAGE_ID,
        packageHash: first.packageHash,
        servedModel: usable.map((result) => result.servedModel).find(Boolean) || null,
        provider: first.provider,
      },
    };
  } catch (err) {
    logger.warn(`[lawn-jev-timing-check] check failed, summary kept: ${err.message}`);
    return null;
  }
}

/**
 * Records a verdict for the reviewers (decision_reviews, subject lawn_diagnostics,
 * one row for the diagnosis). The baseline is `production: false`: the word list
 * does not flag stored text (it only runs at read time, after this), so
 * production said "no timing"; a Jev yes queues as a disagreement and the rest
 * fall to the random audit. Never throws.
 */
async function recordLawnJevVerdict({ diagnosticId, summary, verdict }, deps = {}) {
  try {
    if (!diagnosticId || !verdict || !verdict.result) return { recorded: 0, skipped: 'no_verdict' };
    const { packageFor } = require('../typed-decisions/packages');
    const { lawnDiagnosisSubjectHash } = require('../typed-decisions/subject-hash');
    const record = deps.recordDecisions || require('../typed-decisions/shadow-recorder').recordDecisions;
    const pkg = packageFor(PACKAGE_ID);
    return await record({
      capability: pkg.capability,
      pkg,
      provider: verdict.result.provider,
      subjectType: SUBJECT_TYPE,
      subjectId: diagnosticId,
      result: verdict.result,
      baselines: { [QUESTION_ID]: { production: false } },
      subjectHash: lawnDiagnosisSubjectHash(summary),
    });
  } catch (err) {
    logger.warn(`[lawn-jev-timing-check] record failed: ${err.message}`);
    return { recorded: 0, skipped: 'error' };
  }
}

const UNCHANGED = (contract) => ({ contract, afterInsert: () => {} });

// Fire and forget: the request never waits on, or fails because of, the record.
function askThenRecord(diagnosticId, summary, verdictPromise, deps) {
  Promise.resolve(verdictPromise)
    .then((verdict) => recordLawnJevVerdict({ diagnosticId, summary, verdict }, deps))
    .catch(() => {});
}

/**
 * The shared step the three writers call just before inserting a lawn_diagnostics
 * row. `contract` is the final (repaired) report contract; the caller stores
 * `result.contract` (and takes ai_summary from its customer_summary when that is
 * where ai_summary came from), then calls `result.afterInsert(row.id)`.
 *
 * @param {object} contract
 * @param {object} opts { modelWritten: the summary was written by a model, not the deterministic builder }
 * @param {object} [deps] { ask?, recordDecisions?, timeoutMs? } (tests)
 * @returns {Promise<{contract:object, afterInsert:(rowId:string)=>void}>}
 */
async function checkDiagnosisSummary(contract, { modelWritten = false } = {}, deps = {}) {
  try {
    const summary = contract && contract.customer_summary;
    if (!modelWritten || typeof summary !== 'string' || !summary.trim()) return UNCHANGED(contract);
    const mode = require('../../config/feature-gates').lawnJevTimingCheckMode();
    if (mode !== 'shadow' && mode !== 'enforce') return UNCHANGED(contract);
    if (mode === 'shadow') {
      return { contract, afterInsert: (rowId) => askThenRecord(rowId, summary, lawnJevTimingVerdict(summary, deps), deps) };
    }
    const verdict = await lawnJevTimingVerdict(summary, deps);
    if (!verdict) return UNCHANGED(contract);
    if (!verdict.flagged) {
      return { contract, afterInsert: (rowId) => askThenRecord(rowId, summary, verdict, deps) };
    }
    // A flagged sentence: drop it before storage, exactly as the read-time egress
    // drops word-list hits (and the same empty result). The dropped text is no
    // longer the judged text, so nothing is recorded for it.
    const { withoutResultTimingSentences, GENERIC_LOW_CONFIDENCE_SUMMARY } = require('../lawn-diagnostic-report');
    const flagged = new Set(verdict.flaggedSentences);
    const kept = withoutResultTimingSentences(summary, (sentence) => flagged.has(sentence));
    logger.info(`[lawn-jev-timing-check] enforce: dropped ${verdict.flaggedSentences.length} flagged sentence(s) from a lawn diagnosis summary before storage`);
    return UNCHANGED({ ...contract, customer_summary: kept === null ? GENERIC_LOW_CONFIDENCE_SUMMARY : kept });
  } catch (err) {
    logger.warn(`[lawn-jev-timing-check] summary check failed, summary kept: ${err.message}`);
    return UNCHANGED(contract);
  }
}

module.exports = {
  checkDiagnosisSummary,
  lawnJevTimingVerdict,
  recordLawnJevVerdict,
  aggregateAnswers,
  PACKAGE_ID,
  QUESTION_ID,
  SUBJECT_TYPE,
  JEV_TIMING_CHECK_TIMEOUT_MS,
};
