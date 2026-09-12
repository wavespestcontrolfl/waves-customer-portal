const KINDS = ['send_estimate', 'send_appointment_confirmation', 'callback', 'send_report', 'send_paperwork',
  'technician_follow_up', 'schedule_visit', 'send_photos', 'confirm_date', 'call_back', 'provide_info', 'make_payment', 'other', 'send_reschedule_link'];
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('call_commitments', 'subject'))) await knex.schema.alterTable('call_commitments', (t) => { t.jsonb('subject').nullable(); });
  await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS call_commitments_kind_check');
  // PostgreSQL DDL cannot bind a value parameter here; this allowlist is
  // migration-owned, never caller input.
  await knex.raw(`ALTER TABLE call_commitments ADD CONSTRAINT call_commitments_kind_check CHECK (kind IN (${KINDS.map((k) => `'${k}'`).join(', ')}))`);
  if (!(await knex.schema.hasColumn('outbox_messages', 'commitment_id'))) await knex.schema.alterTable('outbox_messages', (t) => {
    t.uuid('commitment_id').nullable().unique().references('id').inTable('call_commitments').onDelete('CASCADE');
    t.timestamp('available_at', { useTz: true }).nullable();
    t.string('provider_message_id', 64).nullable();
  });
  await knex('sms_templates').insert({ template_key: 'reschedule_link_promise', name: 'Promised reschedule link', category: 'appointment',
    body: 'Hi {first}, this is Waves Pest Control. As promised, choose a new appointment time here: {link}. Reply here if you need help. Reply STOP to opt out.',
    variables: JSON.stringify(['first', 'link']), is_active: true, is_internal: false }).onConflict('template_key').ignore();
};
exports.down = async function down() {}; // Gate rollback keeps delivery evidence.

exports.COMMITMENT_KINDS = KINDS;
