'use strict';

/**
 * Rollback guard for `20261128030000_message_drafts_post_visit_revision.js` (frozen on push).
 *
 * Because Knex rolls migrations back in reverse timestamp order, this `down()` runs
 * BEFORE `20261128030000` drops `draft_trigger` / `supersedes_draft_id`, refusing
 * rollback while any `post_visit_closeout` revision row exists so nightly shadow-judge
 * baselines can never be polluted by orphaned revision rows.
 */

exports.up = async function up() {
  // No schema change on up — columns and unique index were created in 20261128030000.
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('message_drafts'))) return;
  if (!(await knex.schema.hasColumn('message_drafts', 'draft_trigger'))) return;
  const existing = await knex('message_drafts')
    .where({ draft_trigger: 'post_visit_closeout' })
    .first('id');
  if (existing) {
    throw new Error(
      'Cannot roll back post-visit SMS revision schema while post_visit_closeout rows exist in message_drafts; archive or remove them first to preserve nightly shadow-judge baseline isolation.',
    );
  }
};
