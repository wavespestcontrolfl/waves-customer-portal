/**
 * lsa_leads relabel columns (owner 2026-11-23, "do step b next").
 *
 * Step B files each matched Local Services call's funnel row (ad_service_attribution)
 * as google_lsa instead of waves_website. These columns record what the job did
 * for each lead, so the change can be audited and undone by hand:
 *   relabeled_at   when the job finished with this lead (null = not done yet)
 *   relabel_result relabeled | created | already_lsa | kept_<source> | unproven
 *   relabeled_from the funnel row's lead_source before the change
 */
const COLUMNS = ['relabeled_at', 'relabel_result', 'relabeled_from'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lsa_leads'))) return;
  const missing = [];
  for (const name of COLUMNS) {
    if (!(await knex.schema.hasColumn('lsa_leads', name))) missing.push(name);
  }
  if (!missing.length) return;
  await knex.schema.alterTable('lsa_leads', (t) => {
    if (missing.includes('relabeled_at')) t.timestamp('relabeled_at', { useTz: true });
    if (missing.includes('relabel_result')) t.text('relabel_result');
    if (missing.includes('relabeled_from')) t.text('relabeled_from');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lsa_leads'))) return;
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('lsa_leads', name)) {
      await knex.schema.alterTable('lsa_leads', (t) => t.dropColumn(name));
    }
  }
};
