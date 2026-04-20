exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // Add photo_url to technicians (for the review page tech profile)
  const hasTechTable = await knex.schema.hasTable('technicians');
  if (hasTechTable) {
    const hasTechPhoto = await knex.schema.hasColumn('technicians', 'photo_url');
    if (!hasTechPhoto) {
      await knex.schema.alterTable('technicians', t => {
        t.string('photo_url', 500);
      });
    }
  }

  // Also add to dispatch_technicians if it exists
  const hasDispatchTable = await knex.schema.hasTable('dispatch_technicians');
  if (hasDispatchTable) {
    const hasDispatchPhoto = await knex.schema.hasColumn('dispatch_technicians', 'photo_url');
    if (!hasDispatchPhoto) {
      await knex.schema.alterTable('dispatch_technicians', t => {
        t.string('photo_url', 500);
      });
    }
  }

  // Review requests — tracks full lifecycle of each review ask
  const hasReviewRequests = await knex.schema.hasTable('review_requests');
  if (!hasReviewRequests) {
    await knex.schema.createTable('review_requests', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.string('token', 64).notNullable().unique();
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
      t.uuid('technician_id').references('id').inTable('technicians').onDelete('SET NULL');

      // Context
      t.string('tech_name', 100);
      t.string('service_type', 100);
      t.date('service_date');

      // Trigger
      t.string('triggered_by', 30).defaultTo('auto'); // 'auto', 'tech', 'admin'
      t.timestamp('scheduled_for'); // when SMS should fire (null = immediate)
      t.timestamp('sms_sent_at');

      // Customer interaction
      t.timestamp('opened_at');
      t.integer('open_count').defaultTo(0);
      t.integer('rating'); // 1-10
      t.timestamp('rated_at');
      t.text('feedback_text');
      t.boolean('redirected_to_google').defaultTo(false);
      t.timestamp('redirected_at');
      t.string('google_location', 50); // which GBP location

      // Follow-up
      t.boolean('followup_sent').defaultTo(false);
      t.timestamp('followup_sent_at');

      // pending → sent → opened → rated → reviewed | feedback | expired
      t.string('status', 20).defaultTo('pending');

      t.timestamps(true, true);
      t.index('token');
      t.index('customer_id');
      t.index('status');
      t.index('scheduled_for');
    });
  } else {
    // If table exists (from old review-gate system), add missing columns
    const cols = [
      { name: 'service_record_id', add: t => t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL') },
      { name: 'technician_id', add: t => t.uuid('technician_id').references('id').inTable('technicians').onDelete('SET NULL') },
      { name: 'tech_name', add: t => t.string('tech_name', 100) },
      { name: 'service_type', add: t => t.string('service_type', 100) },
      { name: 'service_date', add: t => t.date('service_date') },
      { name: 'triggered_by', add: t => t.string('triggered_by', 30).defaultTo('auto') },
      { name: 'scheduled_for', add: t => t.timestamp('scheduled_for') },
      { name: 'sms_sent_at', add: t => t.timestamp('sms_sent_at') },
      { name: 'opened_at', add: t => t.timestamp('opened_at') },
      { name: 'open_count', add: t => t.integer('open_count').defaultTo(0) },
      { name: 'rating', add: t => t.integer('rating') },
      { name: 'rated_at', add: t => t.timestamp('rated_at') },
      { name: 'feedback_text', add: t => t.text('feedback_text') },
      { name: 'redirected_to_google', add: t => t.boolean('redirected_to_google').defaultTo(false) },
      { name: 'redirected_at', add: t => t.timestamp('redirected_at') },
      { name: 'google_location', add: t => t.string('google_location', 50) },
      { name: 'followup_sent', add: t => t.boolean('followup_sent').defaultTo(false) },
      { name: 'followup_sent_at', add: t => t.timestamp('followup_sent_at') },
    ];
    for (const col of cols) {
      const has = await knex.schema.hasColumn('review_requests', col.name);
      if (!has) {
        await knex.schema.alterTable('review_requests', col.add);
      }
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('review_requests');
  const hasTech = await knex.schema.hasTable('technicians');
  if (hasTech) {
    const has = await knex.schema.hasColumn('technicians', 'photo_url');
    if (has) await knex.schema.alterTable('technicians', t => { t.dropColumn('photo_url'); });
  }
};
