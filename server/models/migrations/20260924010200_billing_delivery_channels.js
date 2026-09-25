const COLUMNS = [
  'invoice_channels',
  'payment_issue_channels',
  'billing_channels',
  'payment_receipt_channels',
];

async function hasConstraint(knex, name) {
  const result = await knex.raw(
    'SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass',
    [name, 'notification_prefs'],
  );
  return (result.rows || result).length > 0;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;

  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('notification_prefs', column))) {
      await knex.schema.alterTable('notification_prefs', (table) => {
        table.specificType(column, 'text[]').nullable();
      });
    }

    const constraint = `notification_prefs_${column}_check`;
    if (!(await hasConstraint(knex, constraint))) {
      await knex.raw(`
        ALTER TABLE notification_prefs
        ADD CONSTRAINT ${constraint}
        CHECK (
          ${column} IS NULL OR (
            cardinality(${column}) BETWEEN 1 AND 3
            AND ${column} <@ ARRAY['email', 'sms', 'push']::text[]
            AND cardinality(${column}) = (
              ('email' = ANY(${column}))::int
              + ('sms' = ANY(${column}))::int
              + ('push' = ANY(${column}))::int
            )
          )
        )
      `);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('notification_prefs', column)) {
      await knex.schema.alterTable('notification_prefs', (table) => table.dropColumn(column));
    }
  }
};

exports._private = { COLUMNS };
