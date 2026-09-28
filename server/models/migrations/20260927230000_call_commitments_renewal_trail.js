/**
 * call_commitments.renewal_trail — true on every row created once
 * applyHumanUpdate writes the durable commitment_edit / commitment_reopen
 * events for non-callback SLA kinds (send_estimate, schedule_visit); NULL on
 * every row that existed before. A NULL row may have been reopened, or
 * edited and then confirmed, with no event to show it: the old path left
 * only human_state = 'confirmed', the same as a bare confirm, so its renewal
 * boundary is unknowable (promise-chaser-bell declines to ring on it rather
 * than guess). Added nullable first so existing rows stay NULL, then given
 * its default so new rows are marked.
 */

exports.up = async function (knex) {
  if (await knex.schema.hasColumn('call_commitments', 'renewal_trail')) return;
  await knex.schema.alterTable('call_commitments', (t) => { t.boolean('renewal_trail'); });
  await knex.raw('ALTER TABLE call_commitments ALTER COLUMN renewal_trail SET DEFAULT true');
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('call_commitments', 'renewal_trail')) {
    await knex.schema.alterTable('call_commitments', (t) => { t.dropColumn('renewal_trail'); });
  }
};
