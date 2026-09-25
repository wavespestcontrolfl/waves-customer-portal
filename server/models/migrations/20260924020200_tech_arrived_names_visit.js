/**
 * The arrival text names the visit (owner directive 2026-09-24):
 *
 *   "Hello {first_name}! {tech_name} has arrived for your service."
 *   → "Hello {first_name}! {tech_name} has arrived for your {service_type}."
 *
 * sendTechArrived supplies {service_type} from the reminder path's label
 * resolver (buildServiceLabel), falling back to "service". This file
 * registers the new allowed variable on the base row so admin edits keep
 * validating, and swaps the copy.
 *
 * ADMIN-EDIT SAFETY: only a body that still equals the 2026-08-01
 * house-voice sweep copy is rewritten, and every UPDATE is a compare-and-
 * swap on that exact body, so an admin save landing mid-migration wins.
 * Experiment variants render INSTEAD of the base body (getTemplate prefers
 * an active sms_template_variants row), so variants get the same swap.
 *
 * ROLLBACK SAFETY: up() records the rows it actually rewrote in
 * system_settings under this migration's stamp and down() restores only
 * those. Any other tech_arrived body or variant still carrying
 * {service_type} (an admin customised the wording after up()) has the token
 * replaced with the literal word "service": the pre-migration sender does
 * not supply it, and getTemplate drops a text on an unresolved placeholder.
 * The allowed variable is dropped last.
 */
const KEY = 'tech_arrived';
const OLD_BODY = 'Hello {first_name}! {tech_name} has arrived for your service.';
const NEW_BODY = 'Hello {first_name}! {tech_name} has arrived for your {service_type}.';
const TOKEN = '{service_type}';
const STATE_KEY = 'migration.20260924020200.state';
const TABLES = ['sms_templates', 'sms_template_variants'];

function parseVars(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

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
    description: 'Rows 20260924020200 rewrote, so down() restores only those.',
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

async function setVariables(knex, mutate) {
  const base = await knex('sms_templates').where({ template_key: KEY }).first();
  if (!base) return;
  const before = parseVars(base.variables);
  const after = mutate(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  await knex('sms_templates')
    .where({ template_key: KEY })
    .update({ variables: JSON.stringify(after), updated_at: new Date() });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const rewritten = [];
  for (const table of TABLES) rewritten.push(...(await swap(knex, table, OLD_BODY, NEW_BODY)));
  await setVariables(knex, (vars) => (vars.includes('service_type') ? vars : [...vars, 'service_type']));
  const prior = await readState(knex);
  const seen = new Set(prior.map((e) => JSON.stringify(e)));
  await writeState(knex, [...prior, ...rewritten.filter((e) => !seen.has(JSON.stringify(e)))]);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const [table, id] of await readState(knex)) {
    if (!TABLES.includes(table) || !(await knex.schema.hasTable(table))) continue;
    await knex(table).where({ id, body: NEW_BODY }).update({ body: OLD_BODY, updated_at: new Date() });
  }
  // Customised wording that kept the token: keep it renderable by the old
  // sender rather than leaving every arrival text unsent while rolled back.
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    const rows = await knex(table).where({ template_key: KEY }).where('body', 'like', `%${TOKEN}%`).select('id', 'body');
    for (const row of rows) {
      await knex(table)
        .where({ id: row.id, body: row.body })
        .update({ body: row.body.split(TOKEN).join('service'), updated_at: new Date() });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
  await setVariables(knex, (vars) => vars.filter((v) => v !== 'service_type'));
};
