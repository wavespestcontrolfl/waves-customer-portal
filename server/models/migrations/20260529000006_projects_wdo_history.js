/**
 * projects.wdo_history — cached prior WDO treatment / permit history for a WDO
 * inspection (previous treatment evidence, fumigation details, re-roof permit
 * year, relevant permits, sources, confidence) resolved by the WDO history
 * lookup. Feeds FDACS-13645 Section 4 as tech-verifiable suggestions; cached so
 * the panel renders on reload without re-running the web-search lookup. Nullable.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'wdo_history');
  if (has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.jsonb('wdo_history');
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('projects', 'wdo_history');
  if (!has) return;
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('wdo_history');
  });
};
