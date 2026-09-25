'use strict';

/**
 * Consultation-booking block placeholder on the LIVE `new_lead` automation
 * step (lead-inspection-link-scope.md §2 "PR 3 / Email block", dark behind
 * GATE_LEAD_INSPECTION_LINK). Inserts `{{consultation_booking}}` /
 * `{{consultation_booking_text}}` so automation-runner.js's
 * lead-consultation-email-block.js has somewhere to substitute into. The
 * runner renders both placeholders to '' whenever the block is hidden
 * (gate off, one-time lead, no slots, etc.), so an unaffected send stays
 * byte-identical to today.
 *
 * Anchor-based, NOT an exact-body match (unlike
 * 20260811000011_dry_state_reentry_wording_new_appointment's sentence
 * swap): the live row is owner-edited (current phone 297-5749, not the
 * 20260424000007 seed's 210-1983), so this can never assume the row still
 * reads the seed verbatim. Only ever INSERTS — never rewrites the owner's
 * own copy. Runs on `template_key='new_lead'` only, whatever its current
 * step_order (every seeded row is 0, but this doesn't assume it).
 *
 * Idempotent: a body that already carries its placeholder is left alone.
 * Anchor missing → falls back to appending right before the closing
 * sign-off line; neither found → no-op for that column, logged via
 * console.warn — never fails the migration. Because this runs AFTER the
 * 20260424000007 seed in migration order, a fresh DB ends up with the same
 * placeholder a patched production row gets, without touching the frozen
 * seed migration itself.
 *
 * down() is a documented no-op (waves-db skill §4): a seed-adjacent
 * migration never deletes/rewrites an admin-editable row.
 */

const HTML_PLACEHOLDER = '{{consultation_booking}}';
const HTML_ANCHOR = "<h2>What's next</h2>";
const HTML_SIGNOFF = '<p>— The Waves Pest Control team</p>';

const TEXT_PLACEHOLDER = '{{consultation_booking_text}}';
const TEXT_ANCHOR = 'Reply with your address';
const TEXT_SIGNOFF = '— The Waves Pest Control team';

// Returns the patched body, the SAME body (placeholder already present, or
// nothing to patch because both anchors are missing — a warn is logged by
// the caller in that case), or null to signal "neither anchor found".
function insertBefore(body, placeholder, anchor, signoff) {
  if (body.includes(placeholder)) return body;
  if (body.includes(anchor)) return body.replace(anchor, `${placeholder}\n${anchor}`);
  if (body.includes(signoff)) return body.replace(signoff, `${placeholder}\n${signoff}`);
  return null;
}

function patchColumn(row, column, placeholder, anchor, signoff, patch) {
  const body = row[column];
  if (typeof body !== 'string' || !body) return;
  const next = insertBefore(body, placeholder, anchor, signoff);
  if (next === null) {
    console.warn(`[migration 20260924020000] new_lead step ${row.id}: no ${column} anchor found, leaving it untouched`);
    return;
  }
  if (next !== body) patch[column] = next;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const rows = await knex('automation_steps')
    .where({ template_key: 'new_lead' })
    .select('id', 'html_body', 'text_body');

  for (const row of rows) {
    const patch = {};
    patchColumn(row, 'html_body', HTML_PLACEHOLDER, HTML_ANCHOR, HTML_SIGNOFF, patch);
    patchColumn(row, 'text_body', TEXT_PLACEHOLDER, TEXT_ANCHOR, TEXT_SIGNOFF, patch);
    if (Object.keys(patch).length) {
      if (await knex.schema.hasColumn('automation_steps', 'updated_at')) {
        patch.updated_at = new Date();
      }
      await knex('automation_steps').where({ id: row.id }).update(patch);
    }
  }
};

// Documented no-op (waves-db skill §4): a seed-adjacent migration's down()
// must never delete/rewrite an admin-editable row.
exports.down = async function down() {};
