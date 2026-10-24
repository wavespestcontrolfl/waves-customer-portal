/**
 * Tax ledger rules (GATE_TAX_LEDGER, 2026-10-23): payee patterns that
 * pre-fill the Bank Import suggestion for every staged bank row (category
 * for an expense, or personal / transfer / income / review), so the owner
 * reviews an inbox instead of a spreadsheet. Suggestion-only: a row never
 * changes status without the operator.
 *
 * Schema only. The seed rows (merchant patterns in
 * services/tax-ledger-seed-rules.js) are written at runtime by
 * services/tax-ledger-rules.js ensureSeedRules(), idempotent by pattern, so
 * the seed list can change in a later PR without a new migration and an
 * owner's edit to a seeded row (disable, re-point) is never overwritten.
 * Rules the owner writes from the Inbox get source='owner' and priority 10,
 * so they always win over a seed (100).
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('tax_ledger_rules');
  if (!has) {
    await knex.schema.createTable('tax_ledger_rules', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('pattern').notNullable();                 // case-insensitive regex tested against bank_transactions.description
      t.string('kind', 12).notNullable();              // expense | personal | transfer | income | review
      t.uuid('category_id').references('id').inTable('expense_categories').onDelete('SET NULL');
      t.string('irs_line', 6);
      t.text('note');
      t.integer('priority').notNullable().defaultTo(100);
      t.boolean('enabled').notNullable().defaultTo(true);
      t.string('source', 10).notNullable().defaultTo('seed'); // seed | owner
      t.integer('hits').notNullable().defaultTo(0);
      t.timestamp('last_hit_at', { useTz: true });
      t.timestamps(true, true);
      t.unique('pattern');
      t.index(['enabled', 'priority']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tax_ledger_rules');
};
