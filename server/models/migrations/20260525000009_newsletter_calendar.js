exports.up = async function (knex) {
  await knex.schema.createTable('newsletter_calendar', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.date('week_of').notNullable().unique();
    table.text('topic').nullable();
    table.text('notes').nullable();
    table.string('homeowner_minute_topic', 256).nullable();
    table.timestamp('target_send_at').notNullable();
    table.string('status', 16).notNullable().defaultTo('planned');
    table.uuid('send_id').nullable().references('id').inTable('newsletter_sends').onDelete('SET NULL');
    table.jsonb('event_ids').notNullable().defaultTo('[]');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  // Add CHECK constraints via raw SQL (Knex doesn't support CHECK natively)
  await knex.raw(`
    ALTER TABLE newsletter_calendar
    ADD CONSTRAINT chk_calendar_week_of_thursday CHECK (EXTRACT(ISODOW FROM week_of) = 4)
  `);
  await knex.raw(`
    ALTER TABLE newsletter_calendar
    ADD CONSTRAINT chk_calendar_status CHECK (status IN ('planned', 'drafted', 'scheduled', 'sent', 'skipped'))
  `);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('newsletter_calendar');
};
