exports.up = async function up(knex) {
  const hasLeads = await knex.schema.hasTable('leads');
  const hasCustomers = await knex.schema.hasTable('customers');
  if (!hasLeads || !hasCustomers) return;

  const [
    leadsServiceInterest,
    leadsCustomerId,
    customersLeadServiceInterest,
  ] = await Promise.all([
    knex.schema.hasColumn('leads', 'service_interest'),
    knex.schema.hasColumn('leads', 'customer_id'),
    knex.schema.hasColumn('customers', 'lead_service_interest'),
  ]);
  if (!leadsServiceInterest || !leadsCustomerId || !customersLeadServiceInterest) return;

  await knex.raw(`
    UPDATE leads l
    SET service_interest = c.lead_service_interest,
        updated_at = COALESCE(l.updated_at, NOW())
    FROM customers c
    WHERE l.customer_id = c.id
      AND NULLIF(BTRIM(COALESCE(l.service_interest, '')), '') IS NULL
      AND NULLIF(BTRIM(COALESCE(c.lead_service_interest, '')), '') IS NOT NULL
  `);
};

exports.down = async function down() {
  // Data backfill only.
};
