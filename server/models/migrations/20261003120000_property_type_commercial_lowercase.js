/**
 * Lowercase case/whitespace variants of the two commercial property types.
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
 */

const TABLES = ['customers', 'customer_properties'];

exports.up = async function up(knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, 'property_type'))) continue;
    await knex.raw(
      `UPDATE ${table}
          SET property_type = LOWER(TRIM(property_type))
        WHERE LOWER(TRIM(property_type)) IN ('commercial', 'business')
          AND property_type <> LOWER(TRIM(property_type))`
    );
  }
};

// The original casing is not recorded and carries no meaning; nothing to undo.
exports.down = async function down() {};
