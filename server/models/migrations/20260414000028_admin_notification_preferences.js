/**
 * Admin notification preferences — per technician/admin user, per trigger event,
 * choose whether to receive bell entry, push notification, and/or sound.
 *
 * Triggers (10): new_lead, sms_reply, payment_succeeded, payment_failed,
 *   appointment_cancelled, review_received, low_review, job_complete,
 *   low_inventory, churn_risk
 */
exports.up = async function (knex) {
  await knex.schema.createTable('notification_preferences', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('admin_user_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
    t.string('trigger_key', 50).notNullable();
    t.boolean('push_enabled').defaultTo(true);
    t.boolean('bell_enabled').defaultTo(true);
    t.boolean('sound_enabled').defaultTo(true);
    t.timestamps(true, true);
    t.unique(['admin_user_id', 'trigger_key']);
    t.index('admin_user_id');
  });

  // Seed defaults for all existing admin users (active technicians)
  const TRIGGERS = [
    'new_lead', 'sms_reply', 'payment_succeeded', 'payment_failed',
    'appointment_cancelled', 'review_received', 'low_review',
    'job_complete', 'low_inventory', 'churn_risk',
  ];

  // Quieter defaults for high-volume events
  const LOW_PRIORITY = new Set(['payment_succeeded', 'job_complete']);

  const users = await knex('technicians').where({ active: true }).select('id');
  if (users.length > 0) {
    const rows = [];
    for (const u of users) {
      for (const trig of TRIGGERS) {
        rows.push({
          admin_user_id: u.id,
          trigger_key: trig,
          push_enabled: !LOW_PRIORITY.has(trig),
          bell_enabled: true,
          sound_enabled: !LOW_PRIORITY.has(trig),
        });
      }
    }
    await knex('notification_preferences').insert(rows);
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('notification_preferences');
};
