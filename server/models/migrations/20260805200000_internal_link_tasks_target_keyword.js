/**
 * content_internal_link_tasks.target_keyword — the brief's keyword for the
 * link target, persisted at plan time so the executor can score legacy
 * targets whose frontmatter carries no primary_keyword/target_keyword with
 * the same core-token denominator the planner ranked with (PR #3226).
 */

exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('content_internal_link_tasks', 'target_keyword');
  if (!has) {
    await knex.schema.alterTable('content_internal_link_tasks', (t) => {
      // 500 matches content_briefs.target_keyword — the value persisted here
      // is that field verbatim; a narrower column would fail the insert for
      // long-tail keywords the briefs table accepts.
      t.string('target_keyword', 500);
    });
  }
};

exports.down = async (knex) => {
  const has = await knex.schema.hasColumn('content_internal_link_tasks', 'target_keyword');
  if (has) {
    await knex.schema.alterTable('content_internal_link_tasks', (t) => {
      t.dropColumn('target_keyword');
    });
  }
};
