/**
 * Projects — post-service inspection / documentation records.
 *
 * Created by techs in the field for WDO, termite, pest, rodent exclusion,
 * and bed-bug jobs — the documentation-heavy work that doesn't fit the
 * routine service_records flow. Each project owns its own photo set and
 * generates a customer-facing report at /report/project/:token (reusing
 * the existing public-report infrastructure).
 *
 * Bed-bug projects support an optional second-visit follow-up on the same
 * record (standard protocol is initial + 14-day). Other types are single-
 * visit; the followup_* columns simply remain NULL.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('projects', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');

    // Optional links back to the visit this project documents. Either may be
    // null when a project is created ad-hoc (e.g. a walk-in WDO request).
    t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
    t.uuid('scheduled_service_id').references('id').inTable('scheduled_services').onDelete('SET NULL');

    t.string('project_type', 50).notNullable();
    // 'wdo_inspection' | 'termite_inspection' | 'pest_inspection'
    // | 'rodent_exclusion' | 'bed_bug'

    t.enu('status', ['draft', 'sent', 'closed']).notNullable().defaultTo('draft');
    t.string('title', 200);
    t.jsonb('findings');
    t.text('recommendations');

    // Public report access — same 32-char hex token format as
    // service_records.report_view_token.
    t.string('report_token', 32).unique();
    t.timestamp('report_viewed_at');

    t.uuid('created_by_tech_id').notNullable().references('id').inTable('technicians');
    t.timestamp('sent_at');

    // Bed-bug follow-up (single optional second visit, same project).
    t.date('followup_date');
    t.jsonb('followup_findings');
    t.timestamp('followup_completed_at');

    t.timestamps(true, true);

    t.index(['customer_id', 'created_at']);
    t.index(['project_type', 'status']);
    t.index('created_by_tech_id');
  });

  await knex.schema.createTable('project_photos', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
    t.string('s3_key', 300).notNullable();
    t.string('category', 50); // declared per project_type in services/project-types.js
    t.string('caption', 200);
    t.enu('visit', ['primary', 'followup']).notNullable().defaultTo('primary');
    t.integer('sort_order').defaultTo(0);
    t.uuid('uploaded_by_tech_id').references('id').inTable('technicians');
    t.timestamps(true, true);

    t.index('project_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('project_photos');
  await knex.schema.dropTableIfExists('projects');
};
