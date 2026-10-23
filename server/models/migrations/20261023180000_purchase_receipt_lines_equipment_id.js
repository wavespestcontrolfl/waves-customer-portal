'use strict';

/**
 * purchase_receipt_lines.equipment_id — the equipment row a receipt line
 * that the inventory agent classed as equipment (status agent_equipment)
 * was filed under on Equipment → Assets (docs/tool-inventory-tracker-scope.md
 * PR 3: a purchase that replaces a missing or damaged tool is traceable).
 * Nullable; set by the Assets dialog save that carries receipt_line_id.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  if (await knex.schema.hasColumn('purchase_receipt_lines', 'equipment_id')) return;
  await knex.schema.alterTable('purchase_receipt_lines', (t) => {
    t.uuid('equipment_id').nullable().references('id').inTable('equipment').onDelete('SET NULL');
    t.index('equipment_id');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('purchase_receipt_lines'))) return;
  if (!(await knex.schema.hasColumn('purchase_receipt_lines', 'equipment_id'))) return;
  await knex.schema.alterTable('purchase_receipt_lines', (t) => { t.dropColumn('equipment_id'); });
};
