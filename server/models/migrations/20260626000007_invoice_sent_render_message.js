/**
 * Render the operator/AI thank-you MESSAGE in the prod invoice.sent SendGrid
 * template.
 *
 * Companion to `20260626000006_invoice_sent_render_summary.js`. PR #2109 added an
 * `invoice_message` payload to sendInvoiceEmail, but prod sends via the SendGrid
 * `invoice.sent` template (SMTP fallback disabled), which neither rendered
 * `{{invoice_message}}` nor whitelisted it. This re-publishes invoice.sent with
 * a plain paragraph block for `{{invoice_message}}` placed directly AFTER the
 * service-summary callout (email order: greeting → summary → thank-you →
 * details → pay CTA) and whitelists the variable.
 *
 * The block renderer suppresses a block whose content resolves to empty, so
 * invoices with no thank-you message render exactly as before.
 *
 * Idempotent: no-op if the active version already references the variable. Loads
 * the CURRENT active version (which, after migration ...0006 runs, already has
 * the summary callout) so the two compose regardless of run order. `down`
 * retains historical versions, matching the existing customer-email migrations.
 */

const TEMPLATE_KEY = 'invoice.sent';
const VARIABLE = 'invoice_message';
const SUMMARY_VARIABLE = 'invoice_summary';
const SAMPLE = 'Thank you so much for trusting us with your home — we truly appreciate your business and look forward to taking great care of you.';
// Plain paragraph (no callout chrome) so it reads as a personal note, distinct
// from the boxed summary above it.
const NEW_BLOCK = { type: 'paragraph', content: `{{${VARIABLE}}}` };

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
function indexReferencing(blocks, variable) {
  const re = new RegExp(`\\{\\{\\s*${variable}\\s*\\}\\}`);
  return blocks.findIndex((b) => re.test(String((b && b.content) || '')));
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
  if (indexReferencing(blocks, VARIABLE) !== -1) return; // already rendered

  // Insert after the summary callout if present, else after the greeting.
  const summaryIdx = indexReferencing(blocks, SUMMARY_VARIABLE);
  const at = summaryIdx !== -1 ? summaryIdx + 1 : (blocks.length ? 1 : 0);
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
