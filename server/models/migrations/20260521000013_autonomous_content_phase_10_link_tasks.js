/**
 * Autonomous Content Engine — Phase 10 schema (internal link tasks).
 *
 * One table: content_internal_link_tasks — pending anchor additions.
 * The internal-link-planner produces these as candidate edits; the
 * autonomous-runner (Step 11) opens an Astro PR that applies them.
 *
 * Unique on (source_file, target_url, anchor_text) so re-running the
 * planner doesn't duplicate. status flows pending → applied | skipped.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('content_internal_link_tasks');
  if (exists) return;

  await knex.schema.createTable('content_internal_link_tasks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Source file in the Astro repo where the edit is applied.
    t.string('source_file', 500).notNullable();
    // Where the new link points.
    t.text('target_url').notNullable();
    // The text that becomes the anchor.
    t.string('anchor_text', 200).notNullable();
    // The full sentence/line we matched into — kept for human review.
    t.text('context_snippet');
    // Byte offset of the match in source_file at planning time.
    // Not used for application (we re-locate at apply time in case the
    // file changed) but valuable for diff inspection.
    t.integer('source_offset');

    // What triggered this planning pass — usually the opportunity that
    // produced the new target page.
    t.uuid('opportunity_id').references('id').inTable('opportunity_queue').onDelete('SET NULL');

    t.string('status', 20).notNullable().defaultTo('pending');
    //   pending | applied | skipped | rejected | superseded
    t.text('skip_reason');

    t.timestamp('planned_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('applied_at');
    t.string('astro_pr_url', 500);

    t.timestamps(true, true);

    t.unique(['source_file', 'target_url', 'anchor_text']);
    t.index('status');
    t.index('target_url');
    t.index('opportunity_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('content_internal_link_tasks');
};
