/**
 * Removes an uncitable timing claim from lc.first_visit_pest (seeded by
 * 20260928080000, corrected once already by 20260928080100 — that seed
 * migration is frozen per waves-db §4, so this is a third file, not an
 * edit to either prior one).
 *
 * "University of Florida notes that fipronil works slowly on ant colonies,
 * taking four weeks or more on fire ants" rested on UF/IFAS LH059, which is
 * now withdrawn (HTTP 410) — no manufacturer or current UF source makes
 * this timing claim, so it is removed outright rather than re-sourced. The
 * source line's "ant colony timing from University of Florida IFAS" clause
 * is removed with it. See the 2026-09-28 copy draft, B1 section.
 *
 * Read-modify-write, guarded on the exact known strings (same shape as
 * 20260721100020_signature_the_waves_team.js): only a version whose body
 * still contains the sentence being removed is touched, so an admin edit
 * made in between is preserved. down() is a documented no-op — reverting
 * would restore an unsupported claim.
 */

const OLD_LIST_ITEM = 'That is why you may still see ants after the visit, sometimes for a while. It is the treatment working, not failing. University of Florida notes that fipronil works slowly on ant colonies, taking four weeks or more on fire ants. Please do not spray the ants you see with a store-bought repellent; it scatters the colony.';
const NEW_LIST_ITEM = 'That is why you may still see ants after the visit, sometimes for a while. It is the treatment working, not failing. Please do not spray the ants you see with a store-bought repellent; it scatters the colony.';

const OLD_SOURCE_NOTE = 'Source: activity averages are Waves visit records, 2026; rain is NOAA radar near your home, local totals may vary; product behavior from the manufacturer and the product label; ant colony timing from University of Florida IFAS.';
const NEW_SOURCE_NOTE = 'Source: activity averages are Waves visit records, 2026; rain is NOAA radar near your home, local totals may vary; product behavior from the manufacturer and the product label.';

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
    if (block?.type === 'list' && Array.isArray(block.items) && block.items.includes(OLD_LIST_ITEM)) {
      changed = true;
      return { ...block, items: block.items.map((item) => (item === OLD_LIST_ITEM ? NEW_LIST_ITEM : item)) };
    }
    if (block?.type === 'small_note' && block.content === OLD_SOURCE_NOTE) {
      changed = true;
      return { ...block, content: NEW_SOURCE_NOTE };
    }
    return block;
  });
  return changed ? next : null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_template_versions')) || !(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: 'lc.first_visit_pest' }).first();
  if (!template) return;
  const versions = await knex('email_template_versions').where({ template_id: template.id });
  for (const version of versions) {
    const next = rewriteBlocks(version.blocks);
    if (next) {
      await knex('email_template_versions').where({ id: version.id }).update({
        blocks: JSON.stringify(next), updated_at: new Date(),
      });
    }
  }
};

// Documented no-op: reverting would restore an uncitable claim.
exports.down = async function down() {};

exports.__private = { OLD_LIST_ITEM, NEW_LIST_ITEM, OLD_SOURCE_NOTE, NEW_SOURCE_NOTE, rewriteBlocks };
