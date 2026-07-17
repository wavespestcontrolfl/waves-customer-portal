/**
 * One-time backfill: scrub the internal inspection_fee out of legacy
 * project.recommendations narratives (audit 2026-07-16 / codex #2807, #2817).
 *
 * WHY A BACKFILL, NOT REQUEST-TIME SURGERY:
 *   inspection_fee is an internal invoicing helper that must never be
 *   customer-facing. Two clean, permanent guards already exist:
 *     - the finding is stripped from the model prompt (buildProjectReportPrompt),
 *       so no NEW narrative can contain it, and
 *     - the finding is stripped from the public /data payload as a structured
 *       field (stripInternalFindingKeys).
 *   The only remaining exposure is narratives DRAFTED BEFORE the prompt strip,
 *   which may have the fee baked into free text. This migration removes it once,
 *   in place, so no request-time text scrubbing is needed on the hot path.
 *
 * WHAT IT REMOVES:
 *   ONLY inspection-fee language + an amount (redactInspectionFeeCues) — never
 *   a generic price/cost/charge, so a legitimate customer-facing repair or
 *   treatment estimate in a historical report is never corrupted (codex #2817
 *   P1). Because the scrub keys off fee LANGUAGE (not a specific value), it also
 *   catches a STALE draft fee that no current/archived snapshot still names.
 *
 * SENDS NOTHING: this is a plain UPDATE of the recommendations column — no
 * delivery path is touched, so no customer communication fires (owner rule).
 *
 * CONCURRENCY: runs pre-deploy while the previous version is still live, so
 * each UPDATE compares-and-sets on the originally-read text; a row edited
 * between read and write is re-read and retried, so a contended row is never
 * clobbered AND never left bearing the fee (codex #2817 P2).
 *
 * IDEMPOTENT: a row whose narrative has no inspection-fee language is a no-op,
 * and re-running changes nothing. Irreversible by design — down() is a
 * documented no-op (we never restore a removed internal fee).
 */

const { redactInspectionFeeCues } = require('../../services/project-types');

const SELECT_COLS = ['id', 'findings', 'wdo_sent_filings', 'recommendations'];
const MAX_RETRY_PASSES = 5;

function parseObj(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function feeOf(findings) {
  const parsed = parseObj(findings);
  return parsed && typeof parsed === 'object' ? (parsed.inspection_fee ?? null) : null;
}

// Only projects that carry an inspection fee are eligible — a fee-less
// project should never have its recommendations touched.
function hasInspectionFee(row) {
  if (feeOf(row.findings) != null && String(feeOf(row.findings)).trim() !== '') return true;
  const filings = parseObj(row.wdo_sent_filings);
  if (Array.isArray(filings)) {
    for (const filing of filings) {
      const v = feeOf(filing && filing.findings);
      if (v != null && String(v).trim() !== '') return true;
    }
  }
  return false;
}

// Scrub one batch of rows; return the ids that were skipped because the row
// changed under us (compare-and-set matched 0), so the caller can re-read and
// retry them.
async function scrubBatch(knex, rows) {
  let updated = 0;
  const contended = [];
  for (const row of rows) {
    if (!hasInspectionFee(row)) continue;
    const scrubbed = redactInspectionFeeCues(row.recommendations);
    if (scrubbed === row.recommendations) continue;
    const n = await knex('projects')
      .where({ id: row.id, recommendations: row.recommendations })
      .update({ recommendations: scrubbed });
    if (n > 0) updated += 1;
    else contended.push(row.id);
  }
  return { updated, contended };
}

exports.up = async function up(knex) {
  const hasProjects = await knex.schema.hasTable('projects');
  if (!hasProjects) return;
  const hasRecs = await knex.schema.hasColumn('projects', 'recommendations');
  if (!hasRecs) return;

  let pending = await knex('projects')
    .whereNotNull('recommendations')
    .andWhereRaw("recommendations <> ''")
    .select(SELECT_COLS);
  const scanned = pending.length;

  let updated = 0;
  let stillContended = [];
  for (let pass = 0; pass < MAX_RETRY_PASSES && pending.length; pass += 1) {
    const { updated: passUpdated, contended } = await scrubBatch(knex, pending);
    updated += passUpdated;
    if (!contended.length) { stillContended = []; break; }
    // Re-read the contended rows fresh so a row whose concurrent edit removed
    // the fee is a no-op next pass, and one that still bears it is re-scrubbed.
    pending = await knex('projects').whereIn('id', contended).select(SELECT_COLS);
    stillContended = contended;
  }

  if (stillContended.length) {
     
    console.warn(`[migrate] scrub_inspection_fee: ${stillContended.length} row(s) still contended after ${MAX_RETRY_PASSES} passes: ${stillContended.join(', ')}`);
  }
   
  console.log(`[migrate] scrub_inspection_fee_from_project_narratives: scanned ${scanned}, scrubbed ${updated}, unresolved_contended ${stillContended.length}`);
};

exports.down = async function down() {
  // No-op by design: a removed internal fee is not restored.
};
