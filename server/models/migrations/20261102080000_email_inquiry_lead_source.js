/**
 * Seed the 'Email Inquiry' lead_sources row. Leads auto-created from the shared
 * inbox (email-actions.js handleLeadInquiry, lead_type 'email_inquiry') never set
 * leads.lead_source_id, so every one read as unattributed in the source filter,
 * the ROI table and the unattributed-leads alert. The writer now looks this row
 * up by NAME at insert time and falls back to NULL when it is missing.
 *
 * Values follow the existing non-phone seeds (20260401000096, 20260928030000):
 *   source_type 'email'  no other seed uses it, and no code allow-lists source_type
 *   channel     'direct' the sender wrote to a Waves address (same bucket as the
 *                        toll-free customer line)
 *   cost_type   'free', is_active true
 *
 * Insert-if-absent by source_type (the writer matches on it, so an office
 * rename of the row never breaks attribution): an existing row is never
 * overwritten. Existing NULL-source email leads are NOT backfilled here.
 * down() is a documented no-op, like the 20260928030000 seed.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  const existing = await knex('lead_sources').where({ source_type: 'email' }).first('id');
  if (existing) return;

  await knex('lead_sources').insert({
    name: 'Email Inquiry',
    source_type: 'email',
    channel: 'direct',
    cost_type: 'free',
    monthly_cost: 0,
    is_active: true,
    notes: 'Leads auto-created from an inbound email to the shared inbox (email-actions.js handleLeadInquiry).',
  });
};

// Seed rollback — never destructive. Deleting this row would strand every
// future email lead at lead_source_id NULL again, and if the office has since
// edited the row (renamed it, marked it inactive), a delete would erase that
// edit too.
exports.down = async function down() {};
