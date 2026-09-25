/**
 * Deploy-ordering hold (Codex #4813 r4 P1). Railway runs migrations as the
 * pre-deploy command while the PREVIOUS instance is still serving. 20260924020000
 * (frozen — it already ran on preview) writes `{{consultation_booking}}` /
 * `{{consultation_booking_text}}` into the live new_lead step; an old
 * instance's minute scheduler sending a due step in that overlap does not
 * know the token and would email it literally.
 *
 * This runs in the SAME pre-deploy step, right after 020000/020001, and
 * strips the placeholders from every new_lead step again — so no
 * environment carries them until every serving instance renders them. The
 * re-insert (same anchor logic as 020000, step 0 only) ships as its own
 * migration in a follow-up PR once this renderer is deployed. Idempotent;
 * down() no-op (seed/patch rollbacks never edit an admin-editable row).
 */

const PLACEHOLDER_RE = /\{\{\s*consultation_booking(?:_text)?\s*\}\}\n?/g;

function strip(body) {
  if (typeof body !== 'string' || !PLACEHOLDER_RE.test(body)) return body;
  PLACEHOLDER_RE.lastIndex = 0;
  return body.replace(PLACEHOLDER_RE, '');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const rows = await knex('automation_steps')
    .where({ template_key: 'new_lead' })
    .select('id', 'html_body', 'text_body');

  for (const row of rows) {
    PLACEHOLDER_RE.lastIndex = 0;
    const patch = {};
    const html = strip(row.html_body);
    const text = strip(row.text_body);
    if (html !== row.html_body) patch.html_body = html;
    if (text !== row.text_body) patch.text_body = text;
    if (!Object.keys(patch).length) continue;
    if (await knex.schema.hasColumn('automation_steps', 'updated_at')) {
      patch.updated_at = new Date();
    }
    await knex('automation_steps').where({ id: row.id }).update(patch);
  }
};

exports.down = async function down() {};
