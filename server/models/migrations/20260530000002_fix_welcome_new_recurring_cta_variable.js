/**
 * Align the `welcome.new_recurring` email CTA with its template family's
 * variable convention.
 *
 * Every other onboarding/welcome/prep template resolves its portal button from
 * `customer_portal_url`; `welcome.new_recurring` alone used `portal_url`. The
 * template has no hardcoded sender (it ships via admin manual-send or a future
 * email_template_automation enrollment), so the day someone wires an
 * automation that passes the standard `customer_portal_url` key, the CTA href
 * resolves empty and the button silently vanishes. Switch the CTA to
 * `customer_portal_url`, add it to the template's allowed/optional variables
 * (publish validation derives used vars from block url_variables), keep
 * `portal_url` for back-compat, and backfill the default fixture so previews
 * still render the button.
 *
 * Surgical + idempotent: only republishes when the active version's CTA still
 * references `portal_url`; a second run is a no-op. Mirrors the
 * publish-new-active-version convention used by the deepen_* migrations.
 */

const TEMPLATE_KEY = 'welcome.new_recurring';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function ensureMember(list, member) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!arr.includes(member)) arr.push(member);
  return arr;
}

exports.up = async function up(knex) {
  const hasTables = (await knex.schema.hasTable('email_templates'))
    && (await knex.schema.hasTable('email_template_versions'));
  if (!hasTables) return;

  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;

  const activeVersion = await knex('email_template_versions')
    .where({ template_id: template.id, status: 'active' })
    .first();
  if (!activeVersion) return;

  const blocks = parseJson(activeVersion.blocks, []);
  let changed = false;
  const newBlocks = (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block && block.type === 'cta' && block.url_variable === 'portal_url') {
      changed = true;
      return { ...block, url_variable: 'customer_portal_url' };
    }
    return block;
  });
  if (!changed) return; // already migrated (or fresh DB already correct)

  // Allow the new CTA variable through publish validation; keep portal_url.
  const allowed = ensureMember(parseJson(template.allowed_variables, []), 'customer_portal_url');
  const optional = ensureMember(parseJson(template.optional_variables, []), 'customer_portal_url');
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: JSON.stringify(allowed),
    optional_variables: JSON.stringify(optional),
    updated_at: new Date(),
  });

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [published] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: activeVersion.subject,
    preview_text: activeVersion.preview_text,
    blocks: JSON.stringify(newBlocks),
    text_body: activeVersion.text_body,
    validation_snapshot: activeVersion.validation_snapshot,
    published_at: new Date(),
  }).returning('*');

  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: published.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: published.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  // Backfill the default fixture so admin previews still render the button.
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    if (fixture) {
      const payload = parseJson(fixture.payload, {});
      if (payload && payload.customer_portal_url == null && payload.portal_url != null) {
        payload.customer_portal_url = payload.portal_url;
        await knex('email_template_fixtures').where({ id: fixture.id }).update({
          payload: JSON.stringify(payload),
          updated_at: new Date(),
        });
      }
    }
  }
};

exports.down = async function down() {
  // Historical template versions are intentionally retained; the corrected CTA
  // stays active. No-op.
};
