/**
 * Re-insert of the consultation-booking placeholders, step 0 ONLY — the
 * second half of the two-deploy staging from #4813 (Codex r4 P1): that PR
 * shipped the placeholder-aware renderer while 20260924020400 held the
 * placeholders out of the live step, because Railway runs migrations
 * pre-deploy while the previous instance still serves and an old renderer
 * would email the token literally. With #4813 live everywhere, this writes
 * `{{consultation_booking}}` / `{{consultation_booking_text}}` into the
 * live, owner-edited new_lead step 0 the same way 20260924020000 did:
 * before `<h2>What's next</h2>` / "Reply with your address", else before
 * the sign-off, else untouched (warn). String patch only, never a body
 * overwrite. Idempotent. down() is a documented no-op (seed/patch
 * rollbacks never edit an admin-editable row; 020400 is the strip).
 */

const HTML_PLACEHOLDER = '{{consultation_booking}}';
const HTML_ANCHOR = "<h2>What's next</h2>";
const HTML_SIGNOFF = '<p>— The Waves Pest Control team</p>';
const TEXT_PLACEHOLDER = '{{consultation_booking_text}}';
const TEXT_ANCHOR = 'Reply with your address';
const TEXT_SIGNOFF = '— The Waves Pest Control team';
const PRESENT_RE = { html: /\{\{\s*consultation_booking\s*\}\}/, text: /\{\{\s*consultation_booking_text\s*\}\}/ };

function insertBefore(body, present, placeholder, anchor, signoff) {
  if (present.test(body)) return body;
  if (body.includes(anchor)) return body.replace(anchor, `${placeholder}\n${anchor}`);
  if (body.includes(signoff)) return body.replace(signoff, `${placeholder}\n${signoff}`);
  return null;
}

function patchColumn(row, column, present, placeholder, anchor, signoff, patch) {
  const body = row[column];
  if (typeof body !== 'string' || !body) return;
  const next = insertBefore(body, present, placeholder, anchor, signoff);
  if (next === null) {
    console.warn(`[migration 20260924030100] new_lead step ${row.id}: no ${column} anchor found, leaving it untouched`);
    return;
  }
  if (next !== body) patch[column] = next;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const rows = await knex('automation_steps')
    .where({ template_key: 'new_lead', step_order: 0 })
    .select('id', 'html_body', 'text_body');

  for (const row of rows) {
    const patch = {};
    patchColumn(row, 'html_body', PRESENT_RE.html, HTML_PLACEHOLDER, HTML_ANCHOR, HTML_SIGNOFF, patch);
    patchColumn(row, 'text_body', PRESENT_RE.text, TEXT_PLACEHOLDER, TEXT_ANCHOR, TEXT_SIGNOFF, patch);
    if (!Object.keys(patch).length) continue;
    if (await knex.schema.hasColumn('automation_steps', 'updated_at')) {
      patch.updated_at = new Date();
    }
    await knex('automation_steps').where({ id: row.id }).update(patch);
  }
};

exports.down = async function down() {};
