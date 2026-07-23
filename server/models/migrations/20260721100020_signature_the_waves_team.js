'use strict';

/**
 * Retire company-name email sign-offs (owner call 2026-07-21): every
 * signature block that signs as the company ("— Waves Pest Control",
 * "The Waves Pest Control team", and variants) becomes "— The Waves
 * Team" across ALL email_template_versions (active and draft — a draft
 * published later must not resurrect the old sign-off).
 *
 * Scope guard: ONLY blocks of type 'signature' whose content mentions the
 * company name are rewritten — bespoke sign-offs (a person's name, a
 * two-line authored signature) are untouched, and body copy that names
 * the company (e.g. locked authorization text) is never a signature
 * block, so it stays verbatim.
 *
 * Newsletter carve-out (owner: "all emails, except newsletter"):
 * marketing-mode templates are skipped entirely; newsletter broadcast
 * chrome (glassNewsletter masthead) never used the pill header or these
 * signature blocks in the first place.
 *
 * The renderer's default for a content-less signature block changes to
 * '— The Waves Team' in the same PR (email-template-library.js).
 */

const NEW_SIGNATURE = '— The Waves Team';
const COMPANY_RE = /waves\s+pest\s+control/i;

function rewriteBlocks(rawBlocks) {
  let blocks;
  try {
    blocks = typeof rawBlocks === 'string' ? JSON.parse(rawBlocks) : rawBlocks;
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;
  let changed = false;
  const next = blocks.map((block) => {
    if (block && block.type === 'signature' && typeof block.content === 'string' && COMPANY_RE.test(block.content)) {
      changed = true;
      return { ...block, content: NEW_SIGNATURE };
    }
    return block;
  });
  return changed ? next : null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_versions'))) return;
  const rows = await knex('email_template_versions as v')
    .leftJoin('email_templates as t', 'v.template_id', 't.id')
    .whereRaw("COALESCE(LOWER(t.mode), 'service') <> 'marketing'")
    .select('v.id', 'v.blocks');
  for (const row of rows) {
    const next = rewriteBlocks(row.blocks);
    if (next) {
      await knex('email_template_versions')
        .where({ id: row.id })
        .update({ blocks: JSON.stringify(next), updated_at: new Date() });
    }
  }
};

// Down is a no-op by design: the old sign-offs varied per template and are
// not recoverable from a single constant; restoring them would re-run the
// original seed migrations' copy, which is a content decision, not a
// schema rollback.
exports.down = async function down() {};

exports._test = { rewriteBlocks, NEW_SIGNATURE };
