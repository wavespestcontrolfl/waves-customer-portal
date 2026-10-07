/**
 * Lawn Report V2 — write-time gate (single source of truth).
 *
 * At completion, build the V2 synthesis once and FREEZE it onto the service record
 * (structured_notes.lawnReportV2). Two purposes:
 *   1. Single source of truth — the SMS (delivery.js) and any later render read the
 *      same synthesized line instead of re-deriving it independently (the root cause
 *      of the contradictions the consistency layer reconciles at render time).
 *   2. Write-time consistency check — run reconcileLawnReport and surface any
 *      blocker-severity contradictions to the office (logged; never blocks completion).
 *
 * Best-effort: any failure leaves the record untouched and the render-time path still
 * reconciles. Lawn visits only.
 */

const logger = require('../logger');
const featureGates = require('../../config/feature-gates');
const { resolveWaterInForecast } = require('./lawn-watering-forecast');

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// Whether the record already carries a frozen watering snapshot (any shape):
// the forecast sentence is only ever added to a NEW freeze.
function hasFrozenWateringInstruction(record) {
  const notes = parseJsonObject(record && record.structured_notes);
  return !!(notes.lawnWateringFreeze || (notes.lawnReportV2 && notes.lawnReportV2.wateringInstruction));
}

// The paragraph step on its own: never throws, returns { [assessmentId]: entry }
// for the caller's in-memory structured_notes, or null.
async function freezeTechParagraphFor({ record, data, service, knex }) {
  try {
    const tech = require('./lawn-tech-paragraph');
    const assessmentId = data && data.lawnAssessment && data.lawnAssessment.assessmentId;
    if (assessmentId == null) return null;
    const outcome = await tech.createAndFreezeTechParagraph({
      serviceRecordId: service.id,
      assessmentId,
      // The row's CURRENT notes, read inside the step's one deadline: a retried
      // completion finds the freeze and spends no second call.
      getStructuredNotes: async () => (await knex('service_records').where({ id: service.id }).first('structured_notes'))?.structured_notes,
      gatherInputs: () => require('./lawn-tech-paragraph-inputs').gatherTechParagraphInputs({ record, data, knex }),
      knex,
    });
    if (outcome.status !== 'frozen' && outcome.status !== 'already_frozen') {
      logger.info(`[lawn-tech-paragraph] none for service_record ${service.id}: ${outcome.status}${outcome.problems && outcome.problems.length ? ` (${outcome.problems.join(', ')})` : ''}`);
    }
    return outcome.entry ? { [String(assessmentId)]: outcome.entry } : null;
  } catch (err) {
    logger.warn(`[lawn-tech-paragraph] step failed for service_record ${service && service.id}: ${err.message}`);
    return null;
  }
}

// The Visit Summary step (GATE_LAWN_VISIT_SUMMARY_V2, PROTOTYPE ONLY): code writes
// fixed sentences from the visit's facts (no model call). Never throws, returns
// { [assessmentId]: entry } for the caller's in-memory structured_notes, or null.
// It reads the watering instruction the record is FROZEN to (the persisted
// freeze when there is one), so a replay or a later rule edit changes nothing.
// A degraded product read writes none (the facts would be partial). Gate off: no read.
async function freezeVisitSummaryFor({ record, data, instructionOut, programVisitOut, wateringFreeze, service, knex }) {
  if (!featureGates.lawnVisitSummaryV2Live()) return null;
  try {
    const summary = require('./lawn-visit-summary');
    const assessmentId = data && data.lawnAssessment && data.lawnAssessment.assessmentId;
    if (assessmentId == null || instructionOut.productsLoadFailed) return null;
    const instruction = (wateringFreeze && wateringFreeze.wateringInstruction) || instructionOut.instruction;
    const outcome = await summary.createAndFreezeVisitSummary({
      serviceRecordId: service.id,
      assessmentId,
      getStructuredNotes: async () => (await knex('service_records').where({ id: service.id }).first('structured_notes'))?.structured_notes,
      gatherInputs: () => require('./lawn-visit-summary-inputs').gatherVisitSummaryFacts({ record, data, instruction, programVisit: programVisitOut && programVisitOut.programVisit === true, nextVisitBooked: programVisitOut && programVisitOut.nextVisitBooked === true, knex }),
      knex,
    });
    if (outcome.status !== 'frozen' && outcome.status !== 'already_frozen') {
      logger.info(`[lawn-visit-summary] none for service_record ${service.id}: ${outcome.status}${outcome.problems && outcome.problems.length ? ` (${outcome.problems.join(', ')})` : ''}`);
    }
    return outcome.entry ? { [String(assessmentId)]: outcome.entry } : null;
  } catch (err) {
    logger.warn(`[lawn-visit-summary] step failed for service_record ${service && service.id}: ${err.message}`);
    return null;
  }
}

// The report build's options. The recurring-plan answer (the program line's own
// resolveProgramVisit) is asked for only while the Visit Summary gate is live, so a gate-off
// build does no extra read.
function buildOptions(instructionOut, programVisitOut) {
  return featureGates.lawnVisitSummaryV2Live()
    ? { wateringInstructionOut: instructionOut, programVisitOut }
    : { wateringInstructionOut: instructionOut };
}

// The result with the Visit Summary's freeze added only when one exists.
function withVisitSummary(result, visitSummaryFreeze) {
  return visitSummaryFreeze ? { ...result, visitSummaryFreeze } : result;
}

/**
 * @param {object} input
 * @param {object} input.service  the service_records row (needs id, service_line/type, customer_id)
 * @param {object} input.knex
 * @returns {Promise<{ smsSummary: string|null, warnings: object[], persisted: boolean }>}
 */
async function finalizeLawnReportSynthesis({ service, knex } = {}) {
  const empty = { smsSummary: null, warnings: [], persisted: false };
  if (!service || !service.id || !knex) return empty;
  const serviceLine = service.service_line || (/(lawn)/i.test(String(service.service_type || '')) ? 'lawn' : null);
  if (serviceLine !== 'lawn') return empty;

  try {
    const { buildReportV1Data } = require('./report-data');
    const { reconcileLawnReport } = require('./report-consistency');
    const { loadServiceRecordForPdf, ensureReportToken } = require('./pdf-queue');

    // Freeze the SAME reportV2 the customer report renders — built from the full
    // inputs (applications, actions, mowing, customer concern, water snapshot) on a
    // customer-JOINED record (lat/lng for area weather) — so the frozen SMS line
    // can't diverge from the report the link opens. (buildReportV1Data emits
    // reportV2 for every lawn visit with a confirmed linked assessment —
    // the LAWN_REPORT_V2 flag is retired, owner ruling 2026-07-09.)
    const joined = await loadServiceRecordForPdf(service.id, knex).catch(() => null);
    const record = joined || service;
    const token = await ensureReportToken(service.id, knex);
    const instructionOut = {};
    const programVisitOut = {};
    const data = await buildReportV1Data(record, token, knex, buildOptions(instructionOut, programVisitOut)).catch(() => null);
    const reportV2 = data && data.reportV2;
    if (!reportV2) return empty;

    const fix = reconcileLawnReport({ data, reportV2 }) || { warnings: [] };
    const warnings = fix.warnings || [];

    // Surface contradictions to the office without blocking completion.
    const blockers = warnings.filter((w) => w.severity === 'blocker');
    if (blockers.length) {
      logger.warn(`[lawn-report-gate] ${blockers.length} blocker contradiction(s) on service_record ${service.id}: ${blockers.map((b) => b.code).join(', ')}`);
    }

    const frozen = {
      smsSummary: reportV2.smsSummary || null,
      todaysResult: fix.todaysResult || null,
      statusHeadline: reportV2.snapshot?.statusHeadline || null,
      generatedAt: new Date().toISOString(),
      warningCodes: warnings.map((w) => w.code),
    };

    // ATOMIC key merge (codex P1 #3152 round 3): this runs POST-commit, and
    // structured_notes has concurrent writers there — the completion flow's
    // status stamps and the admin time-on-site correction. Merging from the
    // stale in-memory snapshot and writing the whole column erased any key
    // that landed between the snapshot and this write (timeOnSiteAdjusted,
    // completionSmsStatus, ...). Only the lawnReportV2 key this gate owns
    // travels; the column's CURRENT value keeps everything else.
    await knex('service_records').where({ id: service.id }).update({
      structured_notes: knex.raw(
        "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
        [JSON.stringify({ lawnReportV2: frozen })],
      ),
    });

    // The watering instruction and its banner (GATE_LAWN_WATERING_RULE) freeze
    // under their OWN top-level key, first writer wins, in a statement of their
    // own. They cannot live inside lawnReportV2: the write above replaces that
    // whole object, which would erase a snapshot a concurrent or earlier run
    // had just frozen. The guarded UPDATE takes the row lock, so of two racing
    // writers the second re-checks the guard after the first commits and
    // writes nothing; a retry (or a gate rollback and re-run) changes nothing
    // either. Gate off builds no instruction, so nothing is written, and
    // nothing here ever deletes an existing snapshot.
    let wateringFreeze = null;
    // The frozen banner keeps only the treatment-specific lines: plan-dependent
    // sentences are composed at each render, never frozen.
    // Only a real claim is a snapshot: a state-null instruction, or one built
    // while the visit's products could not be read, is never frozen (the next
    // render regenerates it from what the products really are). A mow hold on
    // a state-null visit is regenerated too, from the frozen product facts, so
    // it reads the same at every render.
    if (instructionOut.instruction && instructionOut.instruction.state && !instructionOut.productsLoadFailed) {
      // GATE_LAWN_WATERING_FORECAST: a water-in whose property forecast reaches
      // the label amount inside its window freezes ONE conditional sentence
      // beside the instruction (never inside `lines`). Read once, here, before
      // the first-writer-wins freeze: a record that is already frozen is never
      // touched, so a replay is byte-identical. Off, or any miss: exactly the
      // instruction as built.
      if (featureGates.lawnWateringForecastLive() && !hasFrozenWateringInstruction(record)) {
        const forecast = await resolveWaterInForecast({
          instruction: instructionOut.instruction,
          latitude: record.customer_latitude ?? record.latitude ?? record.lat,
          longitude: record.customer_longitude ?? record.longitude ?? record.lng,
          fetchForecast: require('./application-conditions').fetchPropertyForecast,
        });
        if (forecast) instructionOut.instruction = { ...instructionOut.instruction, forecast };
      }
      await knex('service_records')
        .where({ id: service.id })
        .whereRaw("(structured_notes::jsonb -> 'lawnWateringFreeze') IS NULL")
        .update({
          structured_notes: knex.raw(
            "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
            [JSON.stringify({ lawnWateringFreeze: { wateringInstruction: instructionOut.instruction, banner: reportV2.banner ? { ...reportV2.banner, lines: instructionOut.instruction.lines } : null, frozenAt: frozen.generatedAt } })],
          ),
        });
      // Whichever writer won, the caller needs the persisted value.
      wateringFreeze = await knex('service_records').where({ id: service.id }).first('structured_notes')
        .then((row) => parseJsonObject(row && row.structured_notes).lawnWateringFreeze || null);
    }

    // "From your technician" paragraph (GATE_LAWN_TECH_PARAGRAPH, fixed sentences):
    // at most ONE model call, here, frozen first-writer-wins under its own top-level
    // key (never inside lawnReportV2, whose write above replaces the whole object).
    // A render only reads the frozen text. A miss falls back to the deterministic
    // lines; nothing to say freezes a text-less marker so a resume makes no second
    // call. Gate off: no read and no call.
    let techParagraphFreeze = null;
    if (featureGates.lawnTechParagraphLive()) {
      techParagraphFreeze = await freezeTechParagraphFor({ record, data, service, knex });
    }

    // Visit Summary (GATE_LAWN_VISIT_SUMMARY_V2, PROTOTYPE ONLY): fixed sentences
    // written by code from the visit's facts, frozen under its own key. No model
    // call, so it is synchronous with this awaited step: it lands before the
    // completion path queues the report email (whose worker rebuilds the PDF at
    // send time). The report swaps it in for the generic recap; the completion
    // SMS keeps the short customerRecap.
    const visitSummaryFreeze = await freezeVisitSummaryFor({ record, data, instructionOut, programVisitOut, wateringFreeze, service, knex });

    return withVisitSummary({
      smsSummary: frozen.smsSummary, frozen, wateringFreeze, reportToken: token, warnings, persisted: true,
      ...(techParagraphFreeze ? { techParagraphFreeze } : {}),
    }, visitSummaryFreeze);
  } catch (err) {
    logger.warn(`[lawn-report-gate] synthesis failed for service_record ${service?.id}: ${err.message}`);
    return empty;
  }
}

// Read the frozen SMS line off a record (used by delivery.js so the text matches the report).
function frozenSmsSummary(record) {
  const sn = parseJsonObject(record && record.structured_notes);
  const s = sn.lawnReportV2 && sn.lawnReportV2.smsSummary;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

module.exports = { finalizeLawnReportSynthesis, frozenSmsSummary };
