/**
 * Autonomous Content Engine — internal-link SEO foundation.
 *
 * Adds strategy, validation, review, and lifecycle fields to
 * content_internal_link_tasks. This is intentionally additive so the
 * current planner/runner can keep writing the original columns while
 * the PR executor is developed behind shadow/dry-run gates.
 */

const TABLE = 'content_internal_link_tasks';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;

  await knex.schema.alterTable(TABLE, (t) => {
    t.text('source_url');
    t.text('source_canonical_url');
    t.text('target_canonical_url');
    t.string('target_file', 500);
    t.string('source_page_type', 40);
    t.string('target_page_type', 40);
    t.integer('target_priority');
    t.string('topic_cluster', 120);
    t.string('source_topic', 200);
    t.string('target_topic', 200);
    t.decimal('topical_relevance_score', 5, 4);
    t.string('anchor_type', 40);
    t.string('anchor_variant', 200);
    t.decimal('anchor_confidence', 5, 4);
    t.integer('source_existing_internal_links_count');
    t.integer('target_existing_inlinks_count');
    t.boolean('target_indexable');
    t.integer('target_http_status');
    t.boolean('target_canonical_matches');
    t.boolean('source_indexable');
    t.integer('source_http_status');
    t.boolean('source_canonical_matches');
    t.text('link_context_before');
    t.text('link_context_after');
    t.string('paragraph_hash', 64);
    t.string('planner_version', 40);
    t.string('executor_version', 40);
    t.text('failure_reason');
    t.text('dismissed_reason');
    t.text('reviewer_notes');
    t.string('pr_branch', 255);
    t.string('pr_commit_sha', 64);
    t.timestamp('merged_at');
    t.timestamp('deployed_at');
    t.timestamp('verified_at');
  });

  await knex.schema.alterTable(TABLE, (t) => {
    t.index(['status', 'target_priority'], 'content_internal_link_tasks_status_priority_idx');
    t.index(['target_url', 'anchor_text'], 'content_internal_link_tasks_target_anchor_idx');
    t.index('source_file', 'content_internal_link_tasks_source_file_idx');
    t.index('topic_cluster', 'content_internal_link_tasks_topic_cluster_idx');
    t.index('pr_commit_sha', 'content_internal_link_tasks_pr_commit_idx');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;

  await knex.schema.alterTable(TABLE, (t) => {
    t.dropIndex(['status', 'target_priority'], 'content_internal_link_tasks_status_priority_idx');
    t.dropIndex(['target_url', 'anchor_text'], 'content_internal_link_tasks_target_anchor_idx');
    t.dropIndex('source_file', 'content_internal_link_tasks_source_file_idx');
    t.dropIndex('topic_cluster', 'content_internal_link_tasks_topic_cluster_idx');
    t.dropIndex('pr_commit_sha', 'content_internal_link_tasks_pr_commit_idx');
  });

  await knex.schema.alterTable(TABLE, (t) => {
    t.dropColumn('source_url');
    t.dropColumn('source_canonical_url');
    t.dropColumn('target_canonical_url');
    t.dropColumn('target_file');
    t.dropColumn('source_page_type');
    t.dropColumn('target_page_type');
    t.dropColumn('target_priority');
    t.dropColumn('topic_cluster');
    t.dropColumn('source_topic');
    t.dropColumn('target_topic');
    t.dropColumn('topical_relevance_score');
    t.dropColumn('anchor_type');
    t.dropColumn('anchor_variant');
    t.dropColumn('anchor_confidence');
    t.dropColumn('source_existing_internal_links_count');
    t.dropColumn('target_existing_inlinks_count');
    t.dropColumn('target_indexable');
    t.dropColumn('target_http_status');
    t.dropColumn('target_canonical_matches');
    t.dropColumn('source_indexable');
    t.dropColumn('source_http_status');
    t.dropColumn('source_canonical_matches');
    t.dropColumn('link_context_before');
    t.dropColumn('link_context_after');
    t.dropColumn('paragraph_hash');
    t.dropColumn('planner_version');
    t.dropColumn('executor_version');
    t.dropColumn('failure_reason');
    t.dropColumn('dismissed_reason');
    t.dropColumn('reviewer_notes');
    t.dropColumn('pr_branch');
    t.dropColumn('pr_commit_sha');
    t.dropColumn('merged_at');
    t.dropColumn('deployed_at');
    t.dropColumn('verified_at');
  });
};
