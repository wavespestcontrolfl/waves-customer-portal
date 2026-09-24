/**
 * Property scope for customer Photo ID submissions (codex GH r1 P1 on
 * PR #4752): under GATE_APP_PROPERTY_SCOPE, `middleware/auth.js` resolves
 * the customer's SELECTED saved property (req.propertyId) from
 * `customer_properties`, and services/account-properties.js's
 * `resolveSessionScope` / `applyPropertyPredicate` is the one rule every
 * other property-aware read (visits, schedule, tracking) uses. Before this
 * migration, none of the three photo-id tables could record which property
 * a submission was about, so server/routes/photo-id.js had nothing to write
 * or filter on even once wired up.
 *
 * Nullable, no default: NULL means "no property selected" / gate off /
 * single-home customer — exactly what applyPropertyPredicate already reads
 * as "the primary (or unscoped) reading" everywhere else. ON DELETE SET
 * NULL — a retired/removed saved property must not orphan or block deleting
 * a customer's own photo-id history.
 */

async function addPropertyIdIfMissing(knex, table) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, 'property_id')) return;
  await knex.schema.alterTable(table, (t) => {
    t.uuid('property_id').nullable().references('id').inTable('customer_properties').onDelete('SET NULL');
    t.index(['property_id']);
  });
}

const TABLES = ['pest_identifications', 'lawn_diagnostics', 'tree_shrub_assessments'];

exports.up = async function up(knex) {
  for (const table of TABLES) {
     
    await addPropertyIdIfMissing(knex, table);
  }
};

exports.down = async function down(knex) {
  for (const table of TABLES) {
     
    if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, 'property_id')) {
       
      await knex.schema.alterTable(table, (t) => { t.dropColumn('property_id'); });
    }
  }
};
