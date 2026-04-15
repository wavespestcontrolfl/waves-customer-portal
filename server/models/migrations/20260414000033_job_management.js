/**
 * Job Management & Field Tools
 *
 *   1. job_form_templates   — per-service-type checklist definitions
 *   2. job_form_submissions — filled-out checklists per service
 *   3. extend job_costs     — add scheduled_service_id + technician_id
 *   4. extend expenses      — add scheduled_service_id + technician_id
 *                             (+ receipt_s3_key so we can reuse PhotoService)
 */
exports.up = async function (knex) {
  // ── Form templates ────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('job_form_templates'))) {
    await knex.schema.createTable('job_form_templates', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.string('service_type', 100).notNullable().unique();
      t.string('name', 200).notNullable();
      t.text('description');
      t.jsonb('sections').notNullable();
      t.boolean('is_active').notNullable().defaultTo(true);
      t.integer('version').notNullable().defaultTo(1);
      t.timestamps(true, true);
    });
  }

  // ── Form submissions ──────────────────────────────────────────────
  if (!(await knex.schema.hasTable('job_form_submissions'))) {
    await knex.schema.createTable('job_form_submissions', t => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('template_id').notNullable().references('id').inTable('job_form_templates').onDelete('CASCADE');
      t.uuid('service_record_id').nullable();
      t.uuid('scheduled_service_id').nullable();
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.jsonb('responses').notNullable();
      t.integer('completion_percent');
      t.timestamp('started_at');
      t.timestamp('completed_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index('scheduled_service_id');
      t.index('service_record_id');
      t.index('customer_id');
    });
  }

  // ── Extend job_costs ──────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('job_costs', 'scheduled_service_id'))) {
    await knex.schema.alterTable('job_costs', t => {
      t.uuid('scheduled_service_id').nullable();
      t.index('scheduled_service_id');
    });
  }
  if (!(await knex.schema.hasColumn('job_costs', 'technician_id'))) {
    await knex.schema.alterTable('job_costs', t => {
      t.uuid('technician_id').nullable();
      t.index('technician_id');
    });
  }

  // ── Extend expenses so techs can attach a receipt to a specific job ──
  if (!(await knex.schema.hasColumn('expenses', 'scheduled_service_id'))) {
    await knex.schema.alterTable('expenses', t => {
      t.uuid('scheduled_service_id').nullable();
      t.index('scheduled_service_id');
    });
  }
  if (!(await knex.schema.hasColumn('expenses', 'technician_id'))) {
    await knex.schema.alterTable('expenses', t => {
      t.uuid('technician_id').nullable();
      t.index('technician_id');
    });
  }
  if (!(await knex.schema.hasColumn('expenses', 'receipt_s3_key'))) {
    await knex.schema.alterTable('expenses', t => {
      t.string('receipt_s3_key', 500);
    });
  }
  if (!(await knex.schema.hasColumn('expenses', 'customer_id'))) {
    await knex.schema.alterTable('expenses', t => {
      t.uuid('customer_id').nullable();
      t.index('customer_id');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('job_form_submissions');
  await knex.schema.dropTableIfExists('job_form_templates');

  for (const col of ['scheduled_service_id', 'technician_id']) {
    if (await knex.schema.hasColumn('job_costs', col)) {
      await knex.schema.alterTable('job_costs', t => t.dropColumn(col));
    }
  }
  for (const col of ['scheduled_service_id', 'technician_id', 'receipt_s3_key', 'customer_id']) {
    if (await knex.schema.hasColumn('expenses', col)) {
      await knex.schema.alterTable('expenses', t => t.dropColumn(col));
    }
  }
};
