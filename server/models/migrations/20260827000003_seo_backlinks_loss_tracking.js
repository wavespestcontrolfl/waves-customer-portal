/**
 * Backlink loss tracking — makes "lost" a verified, dated, explained state.
 *
 * seo_backlinks gains:
 *   miss_count   consecutive DataForSEO scans that did not report the link
 *   last_seen    last scan date the link WAS reported
 *   lost_at      when the monitor flipped the row to status='lost'
 *   lost_reason  page_gone | link_removed | unreachable | (null for legacy rows)
 *   recovery_queued_at  when the loss was evaluated for the Link Building board
 *                (queued, or terminally skipped); null = still owed a recovery
 *                evaluation, which the next scan sweeps up
 *
 * seo_backlink_events is the append-only history the old status flip lacked
 * (lost, recovered, rel_changed, verify_survived) so a link that flaps in and
 * out of the DataForSEO index no longer erases its own trail.
 */
exports.up = async function (knex) {
  const cols = await knex('seo_backlinks').columnInfo();
  await knex.schema.alterTable('seo_backlinks', (t) => {
    if (!cols.miss_count) t.integer('miss_count').notNullable().defaultTo(0);
    if (!cols.last_seen) t.date('last_seen');
    if (!cols.lost_at) t.timestamp('lost_at');
    if (!cols.lost_reason) t.string('lost_reason', 32);
    if (!cols.recovery_queued_at) t.timestamp('recovery_queued_at');
  });

  // Legacy rows were flipped without a timestamp; updated_at is the best proxy.
  await knex('seo_backlinks').where('status', 'lost').whereNull('lost_at')
    .update({ lost_at: knex.raw('updated_at') });
  await knex('seo_backlinks').whereNull('last_seen').whereNotNull('last_checked')
    .update({ last_seen: knex.raw('last_checked') });

  if (!(await knex.schema.hasTable('seo_backlink_events'))) {
    await knex.schema.createTable('seo_backlink_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('backlink_id').references('id').inTable('seo_backlinks').onDelete('CASCADE');
      t.string('event_type', 32).notNullable(); // lost | recovered | rel_changed | verify_survived
      t.jsonb('detail');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['backlink_id', 'created_at']);
      t.index(['event_type', 'created_at']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_backlink_events');
  const cols = await knex('seo_backlinks').columnInfo();
  await knex.schema.alterTable('seo_backlinks', (t) => {
    ['miss_count', 'last_seen', 'lost_at', 'lost_reason', 'recovery_queued_at'].forEach((c) => { if (cols[c]) t.dropColumn(c); });
  });
};
