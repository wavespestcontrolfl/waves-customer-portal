/**
 * Sequestar 6% Fe EDDHA: make sure the per-1,000 prefill correction has its audit row (owner 2026-10-22, "fix the Tree & Shrub
 * card lines that never go down"). A reconcile: it never changes the catalog row.
 *
 * Why. The original bodies of 20261023010000 and 20261023120000 only ever ran on the closed PR previews #6507 and #6509; both
 * files are now documented no-ops (the filenames stay because those previews recorded them), and 20261023140000 does the
 * correction with its audit row. The ORIGINAL 010000 body cleared the 1.5 oz per 1,000 rate and appended the provenance note
 * but wrote no audit row, and the later correction migrations (120000, 140000) then saw a corrected row and exited. A database left in that state
 * (corrected, never audited) keeps its corrected row but has no record of who changed it or from what. This migration
 * reconciles any database left in that state, and does nothing on one where 140000 audited the change.
 *
 * up(): inside the migration's transaction it reads the catalog row FOR UPDATE. It writes ONE critical audit_log row
 * (recordAuditEvent, before/after metadata) only when all of these hold: exactly one catalog row has the name; the row is in the
 * corrected state (rate NULL and this correction's provenance note present); and no audit event exists yet for this row under
 * any action name the correction uses (120000, 140000, or this migration). Otherwise it writes nothing and logs why: an edited
 * row (anything other than the corrected state) is left alone and is not audited, and a row already audited is not audited twice.
 * It is idempotent: its own audit row makes a second run a no-op.
 *
 * down(): a documented no-op. An audit row is history; the correction itself is never reversed (the old 1.5 oz per 1,000 is
 * contradicted by the label).
 */
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261023160000_sequestar_correction_audit_reconcile';
const ACTION = `migration:${MIGRATION}:audited`;
// The audit actions the correction migrations write (20261023120000 and 20261023140000), and this migration's own.
const AUDIT_ACTIONS = [
  'migration:20261023120000_sequestar_per_1000_default_correction:corrected',
  'migration:20261023140000_sequestar_per_1000_default_correction_v2:corrected',
  ACTION,
];
const NAME = 'Sequestar 6% Fe EDDHA Soluble Micronutrient';
const OLD_RATE = 1.5;
const OLD_UNIT = 'oz';
// Same text the earlier migrations append.
const NOTE = 'Per-1,000 prefill cleared 2026-10-22: the BRANDT label (specimen F76) doses per plant (2 oz per small shrub, up to 2 oz per inch of trunk diameter) or up to 2 oz per 100 sq ft of bed (20 oz per 1,000), not 1.5 oz per 1,000.';
const SEPARATOR = ' | ';

const log = (message) => console.log(`[sequestar-audit-reconcile] ${message}`);

// The note as it read before the correction appended its text (null when the note was only ours).
function noteBefore(note) {
  if (note === NOTE) return null;
  return note.endsWith(`${SEPARATOR}${NOTE}`) ? note.slice(0, note.length - (SEPARATOR.length + NOTE.length)) : note.replace(NOTE, '').trim() || null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return log('nothing written: no products_catalog table');
  const columns = await knex('products_catalog').columnInfo();
  if (!['default_rate_per_1000', 'label_source_note', 'rate_unit'].every((column) => column in columns)) return log('nothing written: the catalog lacks a column it needs');
  if (!(await knex.schema.hasTable('audit_log'))) return log('nothing written: no audit_log table');

  // FOR UPDATE: the row cannot change between this read and the audit write (a concurrent edit waits).
  const rows = await knex('products_catalog').where({ name: NAME }).forUpdate().select('id', 'default_rate_per_1000', 'rate_unit', 'label_source_note');
  if (rows.length !== 1) return log(`nothing written: found ${rows.length} catalog rows named "${NAME}", expected exactly 1`);
  const [row] = rows;
  const note = String(row.label_source_note || '');
  if (!(row.default_rate_per_1000 == null && note.includes(NOTE))) return log('nothing written: the row is not in the corrected state (edited, or never corrected)');

  const audited = await knex('audit_log').where({ resource_type: 'products_catalog', resource_id: String(row.id) }).whereIn('action', AUDIT_ACTIONS).first('id');
  if (audited) return log('nothing written: the correction already has an audit row');

  await recordAuditEvent({
    actor_type: 'system', action: ACTION, resource_type: 'products_catalog', resource_id: String(row.id),
    metadata: {
      migration: MIGRATION, name: NAME,
      note: 'Audit reconcile: the row was corrected by the original 20261023010000 body, which wrote no audit row; the later correction migrations then saw it as already corrected.',
      before: { default_rate_per_1000: OLD_RATE, rate_unit: OLD_UNIT, label_source_note: noteBefore(note) },
      after: { default_rate_per_1000: null, rate_unit: row.rate_unit ?? OLD_UNIT, label_source_note: note },
    },
    critical: true, trx: knex,
  });
};

// An audit row is history, and the correction is never reversed.
exports.down = async function down() {};

exports.NAME = NAME;
exports.NOTE = NOTE;
exports.ACTION = ACTION;
exports.AUDIT_ACTIONS = AUDIT_ACTIONS;
