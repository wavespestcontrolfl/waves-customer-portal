/** Free execution: provider-bound leases and one durable submit attempt per authority instance. */
const OLD_OUTCOMES = ['slot_reserved', 'submitting', 'submit_ambiguous', 'placed', 'pending', 'drafted', 'sent', 'failed', 'skipped', 'blocked', 'captcha', 'needs_owner', 'human_step_done', 'ready_for_payment', 'ready_for_credentials', 'no_payment_required', 'price_changed', 'instrument_unavailable', 'auto_renew_unavoidable', 'payment_ambiguous', 'mint_not_started', 'terms_changed', 'send_error', 'sandbox_replay'];
const outcomes = async (db, values) => {
  await db.raw('ALTER TABLE seo_link_attempts DROP CONSTRAINT IF EXISTS seo_link_attempts_outcome_check');
  await db.raw(`ALTER TABLE seo_link_attempts ADD CONSTRAINT seo_link_attempts_outcome_check CHECK (outcome IN (${values.map((v) => `'${v}'`).join(',')}))`);
};
exports.up = async function up(db) {
  if (!(await db.schema.hasTable('seo_link_attempts'))) return;
  for (const col of ['leased_provider', 'lease_mode']) {
    if (!(await db.schema.hasColumn('seo_link_prospects', col))) await db.schema.alterTable('seo_link_prospects', (t) => t.text(col));
  }
  if (!(await db.schema.hasColumn('seo_link_prospects', 'outreach_draft_attempts'))) await db.schema.alterTable('seo_link_prospects', (t) => t.integer('outreach_draft_attempts').notNullable().defaultTo(0));
  if (!(await db.schema.hasColumn('seo_link_attempts', 'idempotency_key'))) await db.schema.alterTable('seo_link_attempts', (t) => t.text('idempotency_key'));
  await db.raw('CREATE UNIQUE INDEX IF NOT EXISTS seo_link_attempts_idempotency_key_unique ON seo_link_attempts (idempotency_key) WHERE idempotency_key IS NOT NULL');
  await outcomes(db, [...OLD_OUTCOMES, 'slot_released']);
};
exports.down = async function down(db) {
  if (!(await db.schema.hasTable('seo_link_attempts'))) return;
  await db('seo_link_attempts').where({ outcome: 'slot_released' }).update({ outcome: 'skipped' });
  await outcomes(db, OLD_OUTCOMES);
  await db.raw('DROP INDEX IF EXISTS seo_link_attempts_idempotency_key_unique');
  if (await db.schema.hasColumn('seo_link_attempts', 'idempotency_key')) await db.schema.alterTable('seo_link_attempts', (t) => t.dropColumn('idempotency_key'));
  for (const col of ['leased_provider', 'lease_mode', 'outreach_draft_attempts']) {
    if (await db.schema.hasColumn('seo_link_prospects', col)) await db.schema.alterTable('seo_link_prospects', (t) => t.dropColumn(col));
  }
};
