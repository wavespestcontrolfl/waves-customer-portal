/**
 * Beehiiv teardown — removes the last schema reference to Beehiiv now that
 * every template has local-first step content (migration 000007). The
 * beehiiv_automation_id column was already unused at runtime after the
 * executeAutomation cutover; dropping it makes the schema match reality.
 *
 * Env vars (BEEHIIV_API_KEY, BEEHIIV_PUB_ID, BEEHIIV_AUTO_*) should be
 * removed from Railway after this deploy succeeds. The code no longer
 * reads them.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('automation_templates', 'beehiiv_automation_id');
  if (has) {
    await knex.schema.alterTable('automation_templates', (t) => {
      t.dropColumn('beehiiv_automation_id');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('automation_templates', (t) => {
    t.string('beehiiv_automation_id');
  });
};
