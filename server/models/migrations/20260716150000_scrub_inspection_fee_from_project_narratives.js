/**
 * One-time backfill: scrub the internal inspection_fee out of legacy
 * project.recommendations narratives (audit 2026-07-16 / codex #2807).
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
 * SENDS NOTHING: this is a plain UPDATE of the recommendations column — no
 * delivery path is touched, so no customer communication fires (owner rule).
 *
 * DETERMINISTIC + IDEMPOTENT: uses the shared, well-tested redactFeeFromText
 * with each project's OWN fee value(s) (live findings + every archived filing);
 * a row whose narrative has no fee is a no-op, and re-running changes nothing.
 * Irreversible by design — down() is a documented no-op (we never restore a
 * removed internal fee).
 */

const { redactFeeFromText, redactFeeCues } = require('../../services/project-types');

function parseObj(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function feeOf(findings) {
  const parsed = parseObj(findings);
  return parsed && typeof parsed === 'object' ? (parsed.inspection_fee ?? null) : null;
}

function feeValuesForProject(row) {
  const values = [feeOf(row.findings)];
  const filings = parseObj(row.wdo_sent_filings);
  if (Array.isArray(filings)) {
    for (const filing of filings) values.push(feeOf(filing && filing.findings));
  }
  return values.filter((v) => v != null && String(v).trim() !== '');
}

exports.up = async function up(knex) {
  const hasProjects = await knex.schema.hasTable('projects');
  if (!hasProjects) return;
  const hasRecs = await knex.schema.hasColumn('projects', 'recommendations');
  if (!hasRecs) return;

  const rows = await knex('projects')
    .whereNotNull('recommendations')
    .andWhereRaw("recommendations <> ''")
    .select('id', 'findings', 'wdo_sent_filings', 'recommendations');

  let scanned = 0;
  let updated = 0;
  let skippedConcurrent = 0;
  for (const row of rows) {
    scanned += 1;
    const feeValues = feeValuesForProject(row);
    // Only scrub projects that carry an inspection fee — a fee-less project's
    // recommendations may legitimately quote a cued dollar estimate we must
    // not touch.
    if (!feeValues.length) continue;
    // Two passes: the known fee value(s), then a value-INDEPENDENT fee-cued
    // pass so a STALE draft fee (changed after the narrative was written, so
    // no current/archived snapshot still names it) is also removed (codex
    // #2807). Gated to fee-bearing projects above so it can't strip an
    // unrelated project's legitimate estimate.
    const scrubbed = redactFeeCues(redactFeeFromText(row.recommendations, feeValues));
    if (scrubbed !== row.recommendations) {
      // Compare-and-set: this runs pre-deploy while the previous version is
      // still live, so match the ORIGINAL text too — if an admin edited the
      // narrative between the bulk SELECT and this UPDATE, write nothing
      // rather than clobber the newer copy (codex #2807).
      const n = await knex('projects')
        .where({ id: row.id, recommendations: row.recommendations })
        .update({ recommendations: scrubbed });
      if (n > 0) updated += 1;
      else skippedConcurrent += 1;
    }
  }

   
  console.log(`[migrate] scrub_inspection_fee_from_project_narratives: scanned ${scanned}, scrubbed ${updated}, skipped_concurrent ${skippedConcurrent}`);
};

exports.down = async function down() {
  // No-op by design: a removed internal fee is not restored.
};
