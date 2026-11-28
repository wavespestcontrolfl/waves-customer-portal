'use strict';

/**
 * Adds linked post-visit revision tracking to `message_drafts` (owner 2026-11-27 "ok go", Decision 4D).
 *
 * 24 of 29 visit-day SMS drafts fired before the technician saved the visit closeout record,
 * leaving the texting AI without field findings (`knew_more`, #1 SMS failure mode).
 *
 * Instead of overwriting the original `inbound` draft row (which would corrupt nightly judge
 * and sealed-exam historical baselines), a post-visit closeout creates ONE linked revision row
 * (`draft_trigger = 'post_visit_closeout'`, `supersedes_draft_id = <original draft id>`).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('message_drafts'))) return;

  const hasSupersedes = await knex.schema.hasColumn('message_drafts', 'supersedes_draft_id');
  const hasTrigger = await knex.schema.hasColumn('message_drafts', 'draft_trigger');

  if (!hasSupersedes || !hasTrigger) {
    await knex.schema.alterTable('message_drafts', (t) => {
      if (!hasSupersedes) {
        t.uuid('supersedes_draft_id').nullable().references('id').inTable('message_drafts').onDelete('SET NULL');
      }
      if (!hasTrigger) {
        t.string('draft_trigger', 32).notNullable().defaultTo('inbound');
      }
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS message_drafts_post_visit_revision_uniq
    ON message_drafts (sms_log_id, draft_trigger)
    WHERE sms_log_id IS NOT NULL AND draft_trigger = 'post_visit_closeout'
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('message_drafts'))) return;
  await knex.raw('DROP INDEX IF EXISTS message_drafts_post_visit_revision_uniq');
  const hasSupersedes = await knex.schema.hasColumn('message_drafts', 'supersedes_draft_id');
  const hasTrigger = await knex.schema.hasColumn('message_drafts', 'draft_trigger');
  if (hasSupersedes || hasTrigger) {
    await knex.schema.alterTable('message_drafts', (t) => {
      if (hasSupersedes) t.dropColumn('supersedes_draft_id');
      if (hasTrigger) t.dropColumn('draft_trigger');
    });
  }
};
