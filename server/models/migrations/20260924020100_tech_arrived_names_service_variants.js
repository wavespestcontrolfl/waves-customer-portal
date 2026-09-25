/**
 * Supersedes 20260924020000_tech_arrived_names_service (frozen: the preview
 * database ran it before Codex round 1 on #4792 landed). That file rewrote
 * the base `tech_arrived` row to use {service_type} and registered the
 * allowed variable. Still missing from it:
 *
 *   - Experiment variants render INSTEAD of the base body (getTemplate
 *     prefers an active sms_template_variants row), so a variant carrying
 *     the old generic copy would keep sending "your service".
 *   - Rollback evidence: body alone does not prove this migration rewrote
 *     a row, so down() restores only the rows up() records here.
 *
 * Every rewrite is a compare-and-swap on the exact old body, so an admin
 * save landing mid-migration wins instead of being overwritten.
 */
const KEY = 'tech_arrived';
const OLD_BODY = 'Hello {first_name}! {tech_name} has arrived for your service.';
const NEW_BODY = 'Hello {first_name}! {tech_name} has arrived for your {service_type}.';
const STATE_KEY = 'migration.20260924020100.state';
const TABLES = ['sms_templates', 'sms_template_variants'];

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return [];
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed.rewritten) ? parsed.rewritten : [];
  } catch {
    return [];
  }
}

async function writeState(knex, rewritten) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where({ key: STATE_KEY }).del();
  await knex('system_settings').insert({
    key: STATE_KEY,
    value: JSON.stringify({ rewritten }),
    category: 'migration',
    description: 'Rows 20260924020100 rewrote, so down() restores only those.',
  });
}

// Compare-and-swap every row of `table` for the key whose body is `from`.
async function swap(knex, table, from, to) {
  if (!(await knex.schema.hasTable(table))) return [];
  const rows = await knex(table).where({ template_key: KEY, body: from }).select('id');
  const touched = [];
  for (const row of rows) {
    const changed = await knex(table)
      .where({ id: row.id, body: from })
      .update({ body: to, updated_at: new Date() });
    if (changed !== 0) touched.push([table, row.id]);
  }
  return touched;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const rewritten = [];
  for (const table of TABLES) rewritten.push(...(await swap(knex, table, OLD_BODY, NEW_BODY)));
  const prior = await readState(knex);
  const seen = new Set(prior.map((e) => JSON.stringify(e)));
  await writeState(knex, [...prior, ...rewritten.filter((e) => !seen.has(JSON.stringify(e)))]);
};

exports.down = async function down(knex) {
  for (const [table, id] of await readState(knex)) {
    if (!TABLES.includes(table) || !(await knex.schema.hasTable(table))) continue;
    await knex(table).where({ id, body: NEW_BODY }).update({ body: OLD_BODY, updated_at: new Date() });
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
