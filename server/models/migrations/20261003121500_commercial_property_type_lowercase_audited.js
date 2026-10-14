/**
 * Lowercase case/whitespace variants of the two commercial property types,
 * with one audit_log row per changed record.
 *
 * Tax, invoice, pay-page, receipt, PDF and call-triage code read
 * customers.property_type / customer_properties.property_type by EXACT match
 * on 'commercial' | 'business'. The admin customer form stored the value as
 * typed, so a row holding 'Commercial' read as residential everywhere (prod
 * 2026-10-03: one customer + its property row; three invoices at $0 tax).
 * The write path now canonicalizes (canonicalStoredPropertyType); this fixes
 * the rows already stored.
 *
 * Scope is deliberately narrow: only values that already ARE commercial or
 * business apart from case/whitespace. NULL rows, residential types and
 * subtypes are untouched, and nothing is copied between the two tables — the
 * never-mirror-commercial-to-customers fence (call-property-lookup.js) is an
 * owner ruling and stays as is. Issued invoices are not touched; a corrected
 * customer is taxed on invoices created from here on.
 *
 * The field is tax-significant, so every rewrite is recorded (actor
 * 'system:migration', before/after in metadata) in the same transaction as
 * the update. updated_at is not restamped: this is a spelling correction, not
 * an edit. `down` restores the recorded spelling on rows still holding the
 * value this migration wrote and APPENDS a rolled-back record per restored
 * row — audit_log is append-only, nothing is deleted.
 */

const AUDIT_ACTION = 'migration.property_type_commercial_lowercase';
const AUDIT_ROLLBACK_ACTION = 'migration.property_type_commercial_lowercase_rolled_back';
const TABLES = [
  { table: 'customers', resourceType: 'customer' },
  { table: 'customer_properties', resourceType: 'customer_properties' },
];
const VARIANT_WHERE = `LOWER(TRIM(property_type)) IN ('commercial', 'business')
  AND property_type <> LOWER(TRIM(property_type))`;

async function tableReady(knex, table) {
  return (await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, 'property_type'));
}

exports.up = async function up(knex) {
  const canAudit = await knex.schema.hasTable('audit_log');
  await knex.transaction(async (trx) => {
    for (const { table, resourceType } of TABLES) {
      if (!(await tableReady(knex, table))) continue;
      const rows = await trx(table).whereRaw(VARIANT_WHERE).forUpdate().select('id', 'property_type');
      for (const row of rows) {
        const after = String(row.property_type).trim().toLowerCase();
        await trx(table).where({ id: row.id }).update({ property_type: after });
        if (canAudit) {
          await trx('audit_log').insert({
            actor_type: 'system:migration',
            action: AUDIT_ACTION,
            resource_type: resourceType,
            resource_id: row.id,
            metadata: { field: 'property_type', before: row.property_type, after },
          });
        }
      }
    }
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  await knex.transaction(async (trx) => {
    for (const { table, resourceType } of TABLES) {
      if (!(await tableReady(knex, table))) continue;
      const records = await trx('audit_log')
        .where({ action: AUDIT_ACTION, resource_type: resourceType })
        .select('resource_id', 'metadata');
      for (const record of records) {
        const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
        if (typeof meta.before !== 'string' || typeof meta.after !== 'string') continue;
        const restored = await trx(table)
          .where({ id: record.resource_id, property_type: meta.after })
          .update({ property_type: meta.before });
        if (!restored) continue;
        await trx('audit_log').insert({
          actor_type: 'system:migration',
          action: AUDIT_ROLLBACK_ACTION,
          resource_type: resourceType,
          resource_id: record.resource_id,
          metadata: { field: 'property_type', before: meta.after, after: meta.before },
        });
      }
    }
  });
};

exports._test = { AUDIT_ACTION, AUDIT_ROLLBACK_ACTION, VARIANT_WHERE };
