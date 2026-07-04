/**
 * content_agent_runs.blog_post_id: add ON DELETE SET NULL (blog-engine
 * audit, queue/state lane).
 *
 * The original FK (20260408000002) has no ON DELETE action — the only
 * content FK in the schema without SET NULL. content-agent.js inserts a
 * run row for every post it drafts, and agent-drafted posts are exactly
 * the ones an admin later deletes: the delete violated the FK and the
 * admin route 500'd. The run row is an audit log, so it must survive the
 * post's deletion with a NULL reference, not block it.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('content_agent_runs');
  if (!exists) return;
  // Default knex/PG constraint name from `t.uuid(...).references(...)`.
  // IF EXISTS keeps this idempotent on databases where the constraint was
  // already dropped or never created (fresh installs get the new one).
  await knex.raw(`
    ALTER TABLE content_agent_runs
      DROP CONSTRAINT IF EXISTS content_agent_runs_blog_post_id_foreign
  `);
  await knex.raw(`
    ALTER TABLE content_agent_runs
      ADD CONSTRAINT content_agent_runs_blog_post_id_foreign
      FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id)
      ON DELETE SET NULL
  `);
};

exports.down = async function (knex) {
  const exists = await knex.schema.hasTable('content_agent_runs');
  if (!exists) return;
  await knex.raw(`
    ALTER TABLE content_agent_runs
      DROP CONSTRAINT IF EXISTS content_agent_runs_blog_post_id_foreign
  `);
  await knex.raw(`
    ALTER TABLE content_agent_runs
      ADD CONSTRAINT content_agent_runs_blog_post_id_foreign
      FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id)
  `);
};
