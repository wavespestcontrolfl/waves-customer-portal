/**
 * Autonomous Content Engine — Phase 9 schema (index status).
 *
 * One table: content_index_status — per-URL snapshot of:
 *   - IndexNow submission timestamp + last result
 *   - Google URL Inspection result (read-only — submission is via
 *     IndexNow only per v3.1 plan)
 *   - Coverage state / canonical mismatch flags
 *
 * One row per URL (unique). Re-submissions and re-inspections update
 * the row in place; we keep snapshot diffs in raw_inspection jsonb
 * for audit.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('content_index_status');
  if (exists) return;

  await knex.schema.createTable('content_index_status', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('url').notNullable().unique();

    // IndexNow side.
    t.timestamp('indexnow_submitted_at');
    t.string('indexnow_status', 30); // ok | rate_limited | rejected | error
    t.text('indexnow_last_error');
    t.integer('indexnow_submit_count').notNullable().defaultTo(0);

    // Google URL Inspection (read-only).
    t.timestamp('inspection_checked_at');
    t.string('coverage_state', 60);
    //   'Submitted and indexed'
    //   'URL is unknown to Google'
    //   'Crawled - currently not indexed'
    //   'Discovered - currently not indexed'
    //   'Page with redirect'
    //   ...
    t.string('indexing_state', 60);
    //   'INDEXING_ALLOWED' | 'BLOCKED_BY_ROBOTS_TXT' | 'BLOCKED_BY_META_TAG' | ...
    t.string('canonical_url', 500);
    t.boolean('canonical_matches').defaultTo(true);
    t.string('verdict', 30); // PASS | PARTIAL | FAIL | NEUTRAL
    t.jsonb('raw_inspection').notNullable().defaultTo('{}');
    t.text('inspection_error');

    // Sitemap presence (managed by sitemap-manager).
    t.timestamp('sitemap_checked_at');
    t.boolean('in_sitemap');

    t.timestamps(true, true);

    t.index('coverage_state');
    t.index('canonical_matches');
    t.index('inspection_checked_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('content_index_status');
};
