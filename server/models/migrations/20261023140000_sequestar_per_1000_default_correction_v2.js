/**
 * Sequestar 6% Fe EDDHA: clear the wrong per-1,000 prefill (owner 2026-10-22, "fix the Tree & Shrub card lines that never
 * go down"). A data correction: one row, one column, no rollback.
 *
 * Why. 20260716150000 seeded the row with default_rate_per_1000 = 1.5 (oz). The BRANDT label (specimen label F76, read
 * 2026-10-22) does not dose per 1,000 sq ft. It doses per plant (2 oz per small shrub; up to 2 oz per inch of trunk diameter
 * on large shrubs and trees) or up to 2 oz per 100 sq ft of bed (20 oz per 1,000). A picker prefill of 1.5 oz per 1,000
 * sq ft is a dose the label does not give, so a hand-picked Sequestar row would start from a wrong amount.
 *
 * up(): finds the catalog row by exact name. It changes the row only when there is exactly one, it is active, and it still
 * reads exactly as seeded (default_rate_per_1000 1.5, rate_unit oz). Otherwise it writes nothing and logs why. A row that is
 * already NULL with this migration's note present is logged as already corrected. On a change it sets the rate to NULL,
 * appends a provenance note to label_source_note and records the before/after in audit_log (recordAuditEvent, critical, in
 * this same transaction), so the change and its audit row land together or not at all.
 *
 * down(): a documented no-op. This replaces a value the label contradicts; putting 1.5 back would restore a known-wrong dose.
 * The audit row keeps the old value if anyone needs it.
 *
 * Locking: the row is read FOR UPDATE inside the migration's transaction, and the update repeats the read values (rate, unit,
 * note) as conditions and must change exactly one row; any other count writes nothing, audits nothing and logs why.
 *
 * Replaces 20261023010000 and 20261023120000, both frozen after their pushes (the first restored the wrong value on rollback
 * and wrote no audit row; the second read the row without a lock and updated it unconditionally).
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261023140000_sequestar_per_1000_default_correction_v2';
const ACTION = `migration:${MIGRATION}:corrected`;
const NAME = 'Sequestar 6% Fe EDDHA Soluble Micronutrient';
const OLD_RATE = 1.5;
const OLD_UNIT = 'oz';
const NOTE = 'Per-1,000 prefill cleared 2026-10-22: the BRANDT label (specimen F76) doses per plant (2 oz per small shrub, up to 2 oz per inch of trunk diameter) or up to 2 oz per 100 sq ft of bed (20 oz per 1,000), not 1.5 oz per 1,000.';
const SEPARATOR = ' | ';

const log = (message) => console.log(`[sequestar-per-1000-default] ${message}`);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return log('nothing written: no products_catalog table');
  const columns = await knex('products_catalog').columnInfo();
  if (!['default_rate_per_1000', 'label_source_note', 'rate_unit'].every((column) => column in columns)) return log('nothing written: the catalog lacks a column it needs');
  if (!(await knex.schema.hasTable('audit_log'))) return log('nothing written: no audit_log table to record the change in');

  // FOR UPDATE: the row cannot change between this read and the conditional update below (a concurrent edit waits).
  const rows = await knex('products_catalog').where({ name: NAME }).forUpdate().select('id', 'active', 'default_rate_per_1000', 'rate_unit', 'label_source_note');
  if (rows.length !== 1) return log(`nothing written: found ${rows.length} catalog rows named "${NAME}", expected exactly 1`);
  const [row] = rows;
  if (row.default_rate_per_1000 == null && String(row.label_source_note || '').includes(NOTE)) return log('nothing written: already corrected');
  if (row.active === false) return log('nothing written: the row is inactive');
  if (!(Number(row.default_rate_per_1000) === OLD_RATE && row.rate_unit === OLD_UNIT)) return log('nothing written: the row no longer reads 1.5 oz per 1,000 as seeded');

  const existing = String(row.label_source_note || '').trim();
  const note = existing ? `${existing}${SEPARATOR}${NOTE}` : NOTE;
  // Conditional on exactly what was read (rate, unit and note), and exactly one row must change; otherwise nothing is audited.
  const query = knex('products_catalog').where({ id: row.id, rate_unit: OLD_UNIT }).whereRaw('default_rate_per_1000 = ?', [OLD_RATE]);
  if (row.label_source_note == null) query.whereNull('label_source_note'); else query.where({ label_source_note: row.label_source_note });
  const changed = await query.update({ default_rate_per_1000: null, label_source_note: note, updated_at: knex.fn.now() });
  if (changed !== 1) return log(`nothing written: the conditional update changed ${changed} rows, expected exactly 1`);
  await recordAuditEvent({
    actor_type: 'system', action: ACTION, resource_type: 'products_catalog', resource_id: String(row.id),
    metadata: {
      migration: MIGRATION, name: NAME,
      before: { default_rate_per_1000: OLD_RATE, rate_unit: OLD_UNIT, label_source_note: row.label_source_note ?? null },
      after: { default_rate_per_1000: null, rate_unit: OLD_UNIT, label_source_note: note },
    },
    critical: true, trx: knex,
  });
};

// A data correction: the old 1.5 oz per 1,000 is contradicted by the label, so it is never restored.
exports.down = async function down() {};

exports.NAME = NAME;
exports.NOTE = NOTE;
exports.ACTION = ACTION;
