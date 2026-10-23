/**
 * Sequestar 6% Fe EDDHA: clear the per-1,000 prefill (owner 2026-10-22, "fix the Tree & Shrub card lines that never go
 * down"). One row, one column, all or nothing.
 *
 * Why. 20260716150000 seeded the row with default_rate_per_1000 = 1.5 (oz). The BRANDT label (specimen label F76, read
 * 2026-10-22) does not dose per 1,000 sq ft at all. It doses per plant (2 oz per small shrub; up to 2 oz per inch of trunk
 * diameter on large shrubs and trees) or up to 2 oz per 100 sq ft of bed (20 oz per 1,000). A picker prefill of
 * 1.5 oz per 1,000 sq ft is a dose the label does not give. The Tree & Shrub card now carries the label dose as a
 * symptom-only secondary line, and the completion form shows a blank rate for this product so the tech enters the
 * amount the plant calls for.
 *
 * up(): finds the catalog row by exact name. It changes the row only when there is exactly one, it is still active, and it
 * still reads exactly as seeded (default_rate_per_1000 1.5, rate_unit oz). Anything else (no row, two rows, a staff edit)
 * and it writes nothing and says why. It sets default_rate_per_1000 to NULL and appends a provenance note.
 *
 * down(): puts the 1.5 back only while the row still holds exactly what up() wrote (the rate still NULL and the appended
 * note still the last text of label_source_note). A staff edit to either keeps the row as staff left it.
 */
const NAME = 'Sequestar 6% Fe EDDHA Soluble Micronutrient';
const OLD_RATE = 1.5;
const OLD_UNIT = 'oz';
const NOTE = 'Per-1,000 prefill cleared 2026-10-22: the BRANDT label (specimen F76) doses per plant (2 oz per small shrub, up to 2 oz per inch of trunk diameter) or up to 2 oz per 100 sq ft of bed (20 oz per 1,000), not 1.5 oz per 1,000.';
const SEPARATOR = ' | ';

const log = (message) => console.log(`[sequestar-per-1000-default] ${message}`);

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return { skip: 'no products_catalog table' };
  const columns = await knex('products_catalog').columnInfo();
  if (!('default_rate_per_1000' in columns) || !('label_source_note' in columns) || !('rate_unit' in columns)) return { skip: 'the catalog lacks a column it needs' };
  const rows = await knex('products_catalog').where({ name: NAME }).select('id', 'active', 'default_rate_per_1000', 'rate_unit', 'label_source_note');
  if (rows.length !== 1) return { skip: `found ${rows.length} catalog rows named "${NAME}", expected exactly 1` };
  return { row: rows[0] };
}

exports.up = async function up(knex) {
  const { row, skip } = await loadRow(knex);
  if (skip) return log(`nothing written: ${skip}`);
  if (row.active === false) return log('nothing written: the row is inactive');
  if (!(Number(row.default_rate_per_1000) === OLD_RATE && row.rate_unit === OLD_UNIT)) return log('nothing written: the row no longer reads 1.5 oz per 1,000 as seeded');
  const existing = String(row.label_source_note || '').trim();
  await knex('products_catalog').where({ id: row.id }).update({
    default_rate_per_1000: null,
    label_source_note: existing ? `${existing}${SEPARATOR}${NOTE}` : NOTE,
    updated_at: knex.fn.now(),
  });
};

exports.down = async function down(knex) {
  const { row, skip } = await loadRow(knex);
  if (skip) return log(`rollback did nothing: ${skip}`);
  const note = String(row.label_source_note || '');
  const written = note === NOTE || note.endsWith(`${SEPARATOR}${NOTE}`);
  if (row.default_rate_per_1000 != null || !written) return log('rollback did nothing: the row was changed after this migration');
  const before = note === NOTE ? null : note.slice(0, note.length - (SEPARATOR.length + NOTE.length));
  await knex('products_catalog').where({ id: row.id }).update({ default_rate_per_1000: OLD_RATE, label_source_note: before, updated_at: knex.fn.now() });
};

exports.NAME = NAME;
exports.NOTE = NOTE;
