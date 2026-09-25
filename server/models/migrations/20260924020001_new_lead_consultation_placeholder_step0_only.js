/**
 * Supersedes the scope of 20260924020000 (frozen — it already ran on the
 * preview database, so it cannot be edited; waves-db skill §4): that
 * migration inserted the consultation-booking placeholders into EVERY
 * `new_lead` automation_steps row, not just step 0. The block belongs to the
 * first, immediate email only — a later drip step sharing the same sign-off
 * boilerplate must never inherit a live slot-picker (pre-push audit P1).
 *
 * This strips `{{consultation_booking}}` / `{{consultation_booking_text}}`
 * (and the newline 020000 inserted with them) from any new_lead step whose
 * step_order is not 0. Production has a single step (0), so this is a no-op
 * there today; it makes the "step 0 only" invariant true on every
 * environment. Idempotent. down() is a documented no-op: seed/patch
 * rollbacks never edit an admin-editable row.
 */

const HTML_PLACEHOLDER = '{{consultation_booking}}';
const TEXT_PLACEHOLDER = '{{consultation_booking_text}}';

function stripPlaceholder(body, placeholder) {
  if (typeof body !== 'string' || !body.includes(placeholder)) return body;
  return body.split(`${placeholder}\n`).join('').split(placeholder).join('');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const rows = await knex('automation_steps')
    .where({ template_key: 'new_lead' })
    .whereNot({ step_order: 0 })
    .select('id', 'html_body', 'text_body');

  for (const row of rows) {
    const patch = {};
    const html = stripPlaceholder(row.html_body, HTML_PLACEHOLDER);
    const text = stripPlaceholder(row.text_body, TEXT_PLACEHOLDER);
    if (html !== row.html_body) patch.html_body = html;
    if (text !== row.text_body) patch.text_body = text;
    if (!Object.keys(patch).length) continue;
    if (await knex.schema.hasColumn('automation_steps', 'updated_at')) {
      patch.updated_at = new Date();
    }
    await knex('automation_steps').where({ id: row.id }).update(patch);
  }
};

// Documented no-op (waves-db skill §4).
exports.down = async function down() {};
