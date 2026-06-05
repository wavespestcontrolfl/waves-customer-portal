exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('technician_capabilities');
  if (!hasTable) {
    await knex.schema.createTable('technician_capabilities', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
      t.string('service_category', 40).notNullable();
      t.string('capability_level', 40).notNullable().defaultTo('qualified');
      t.string('source', 40).notNullable().defaultTo('system_default');
      t.text('notes').nullable();
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.unique(['technician_id', 'service_category'], 'uq_technician_capabilities_tech_category');
      t.index(['service_category', 'active'], 'idx_technician_capabilities_category_active');
      t.index(['technician_id', 'active'], 'idx_technician_capabilities_tech_active');
    });
  }

  const hasTechnicians = await knex.schema.hasTable('technicians');
  if (!hasTechnicians) return;

  const technicians = await knex('technicians').where({ active: true }).select('id');
  if (!technicians.length) return;

  const categories = [
    { service_category: 'general', capability_level: 'qualified' },
    { service_category: 'mosquito', capability_level: 'qualified' },
    { service_category: 'lawn', capability_level: 'review_required' },
    { service_category: 'rodent', capability_level: 'review_required' },
    { service_category: 'termite', capability_level: 'review_required' },
  ];

  const rows = technicians.flatMap(tech => categories.map(category => ({
    technician_id: tech.id,
    ...category,
    source: 'system_default',
    active: true,
    notes: 'Seeded for route optimization capability review.',
    updated_at: knex.fn.now(),
  })));

  await knex('technician_capabilities')
    .insert(rows)
    .onConflict(['technician_id', 'service_category'])
    .ignore();
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('technician_capabilities');
};
