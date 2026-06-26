/**
 * Review Outreach overhaul — channel + sequence linkage on review_requests.
 *
 * Adds the columns the real-conversion-funnel analytics and the multi-touch
 * cadence engine need:
 *   - channel        which channel the touch went out on ('sms' | 'email')
 *   - template_key   which outreach template body was sent (per-template
 *                    conversion reporting; null = legacy canonical send)
 *   - sequence_id    the review_sequences row this touch belongs to (null for
 *                    a one-off manual / automated post-service ask)
 *   - sequence_step  0-based index of the touch within its sequence plan
 *
 * All nullable / defaulted so existing rows and the unchanged post-service
 * auto-send path keep working with no backfill.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_requests'))) return;

  const hasChannel = await knex.schema.hasColumn('review_requests', 'channel');
  const hasTemplateKey = await knex.schema.hasColumn('review_requests', 'template_key');
  const hasSequenceId = await knex.schema.hasColumn('review_requests', 'sequence_id');
  const hasSequenceStep = await knex.schema.hasColumn('review_requests', 'sequence_step');

  await knex.schema.alterTable('review_requests', (t) => {
    if (!hasChannel) t.string('channel', 16).defaultTo('sms');
    if (!hasTemplateKey) t.string('template_key', 64);
    if (!hasSequenceId) t.uuid('sequence_id');
    if (!hasSequenceStep) t.integer('sequence_step');
  });

  // Index sequence_id for the "touches in this sequence" lookups.
  if (!hasSequenceId) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.index('sequence_id');
    });
  }

  // Backfill channel on existing rows so analytics "by channel" never sees null.
  if (!hasChannel) {
    await knex('review_requests').whereNull('channel').update({ channel: 'sms' });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_requests'))) return;
  const cols = ['sequence_step', 'sequence_id', 'template_key', 'channel'];
  for (const col of cols) {
    if (await knex.schema.hasColumn('review_requests', col)) {
      await knex.schema.alterTable('review_requests', (t) => t.dropColumn(col));
    }
  }
};
