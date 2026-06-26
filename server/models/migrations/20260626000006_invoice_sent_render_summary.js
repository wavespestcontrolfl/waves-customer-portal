/**
 * Render the AI/operator invoice SUMMARY in the prod invoice.sent SendGrid
 * template.
 *
 * PR #2107 added an `invoice_summary` payload to sendInvoiceEmail, but in prod
 * the SMTP fallback (which renders the summary paragraph) is disabled — invoice
 * email goes out via the SendGrid `invoice.sent` template, and the active
 * template never rendered `{{invoice_summary}}`. Worse, the template publisher /
 * send path rejects payload variables that aren't in
 * `email_templates.allowed_variables`. So a saved summary would never reach the
 * customer. This re-publishes invoice.sent with a callout block that renders
 * `{{invoice_summary}}` (right after the greeting, above the details table) and
 * whitelists the variable.
 *
 * The block renderer suppresses a block whose content resolves to empty
 * (`renderBlocks` guards every block on `if (content)`), so invoices with no
 * summary render exactly as before.
 *
 * Idempotent: no-op if the active version already references the variable.
 * Loads the CURRENT active version (not a hardcoded block list) so it composes
 * with any later template edits. `down` retains historical versions, matching
 * the existing customer-email template migrations.
 */

const TEMPLATE_KEY = 'invoice.sent';
const VARIABLE = 'invoice_summary';
const SAMPLE = 'We treated the exterior perimeter and entry points and checked the garage during this visit. You may see normal activity for a couple of weeks as the treatment settles in.';
const NEW_BLOCK = { type: 'callout', content: `{{${VARIABLE}}}` };
// Insert directly after the greeting paragraph (index 0), above the details
// table. A summary belongs ahead of any later (thank-you) note.
const insertIndexFor = (blocks) => (blocks.length ? 1 : 0);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
}
function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try { const p = JSON.parse(value); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; }
}
function referencesVariable(blocks, variable) {
  const re = new RegExp(`\\{\\{\\s*${variable}\\s*\\}\\}`);
  return blocks.some((b) => re.test(String((b && b.content) || '')));
}

exports.up = async function up(knex) {
  const hasCore = (await knex.schema.hasTable('email_templates'))
    && (await knex.schema.hasTable('email_template_versions'));
  if (!hasCore) return;

  const tmpl = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!tmpl) return;
  const active = await knex('email_template_versions')
    .where({ template_id: tmpl.id, status: 'active' })
    .orderBy('version_number', 'desc')
    .first();
  if (!active) return;

  const blocks = asArray(active.blocks);
  if (referencesVariable(blocks, VARIABLE)) return; // already rendered

  const at = insertIndexFor(blocks);
  const newBlocks = [...blocks.slice(0, at), NEW_BLOCK, ...blocks.slice(at)];

  // Number from the LATEST version across ALL statuses, not the active one —
  // an unpublished draft may already hold active.version_number + 1, and
  // (template_id, version_number) is unique, so deriving from `active` would
  // collide and abort the deploy. Matches the existing publish path.
  const latest = await knex('email_template_versions')
    .where({ template_id: tmpl.id })
    .orderBy('version_number', 'desc')
    .first();
  const nextVersion = (latest?.version_number || 0) + 1;

  const [version] = await knex('email_template_versions').insert({
    template_id: tmpl.id,
    version_number: nextVersion,
    status: 'active',
    subject: active.subject,
    preview_text: active.preview_text || null,
    blocks: JSON.stringify(newBlocks),
    text_body: active.text_body || null,
    published_at: new Date(),
  }).returning('*');

  await knex('email_template_versions')
    .where({ template_id: tmpl.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });

  const allowed = new Set(asArray(tmpl.allowed_variables)); allowed.add(VARIABLE);
  const optional = new Set(asArray(tmpl.optional_variables)); optional.add(VARIABLE);
  await knex('email_templates').where({ id: tmpl.id }).update({
    active_version_id: version.id,
    allowed_variables: JSON.stringify([...allowed].sort()),
    optional_variables: JSON.stringify([...optional].sort()),
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: tmpl.id, is_default: true })
      .first();
    if (fixture) {
      const payload = asObject(fixture.payload);
      if (!payload[VARIABLE]) {
        payload[VARIABLE] = SAMPLE;
        await knex('email_template_fixtures').where({ id: fixture.id })
          .update({ payload: JSON.stringify(payload), updated_at: new Date() });
      }
    }
  }
};

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
