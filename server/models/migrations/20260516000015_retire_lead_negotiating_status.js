exports.up = async function up(knex) {
  const hasLeads = await knex.schema.hasTable('leads');
  if (!hasLeads || !(await knex.schema.hasColumn('leads', 'status'))) return;

  const patch = { status: 'estimate_sent' };
  if (await knex.schema.hasColumn('leads', 'updated_at')) {
    patch.updated_at = new Date();
  }

  await knex('leads')
    .where({ status: 'negotiating' })
    .update(patch);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'leads_status_not_negotiating'
          AND conrelid = 'leads'::regclass
      ) THEN
        ALTER TABLE leads
          ADD CONSTRAINT leads_status_not_negotiating
          CHECK (status IS NULL OR status <> 'negotiating');
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  const hasLeads = await knex.schema.hasTable('leads');
  if (hasLeads) {
    await knex.raw('ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_not_negotiating');
  }

  // Irreversible data cleanup: estimate_sent may already be a valid status
  // for other rows, so do not guess which rows were previously negotiating.
};
