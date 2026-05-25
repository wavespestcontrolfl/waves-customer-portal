/**
 * Update original 6 prep templates to use prep_url instead of customer_portal_url.
 *
 * Publishes new versions (does not mutate active versions) so the change is
 * safe to roll back by archiving the new version and restoring the previous one.
 */

const TEMPLATE_KEYS = [
  'prep.rodent',
  'prep.flea',
  'prep.mosquito',
  'prep.lawn',
  'prep.termite',
  'prep.interior_pest',
];

function json(value) {
  return JSON.stringify(value || []);
}

function migrateCta(blocks) {
  return blocks.map((block) => {
    if (block.type === 'cta' && block.url_variable === 'customer_portal_url') {
      return { ...block, label: 'Open prep guide', url_variable: 'prep_url' };
    }
    return block;
  });
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;

  for (const templateKey of TEMPLATE_KEYS) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template?.active_version_id) continue;

    const activeVersion = await knex('email_template_versions')
      .where({ id: template.active_version_id })
      .first();
    if (!activeVersion) continue;

    let blocks;
    try {
      blocks = typeof activeVersion.blocks === 'string'
        ? JSON.parse(activeVersion.blocks)
        : activeVersion.blocks;
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;

    const hasCta = blocks.some((b) => b.type === 'cta' && b.url_variable === 'customer_portal_url');
    if (!hasCta) continue;

    const updatedBlocks = migrateCta(blocks);

    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = (Number(latest?.max) || 0) + 1;

    const [newVersion] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      status: 'active',
      subject: activeVersion.subject,
      preview_text: activeVersion.preview_text,
      blocks: json(updatedBlocks),
      text_body: activeVersion.text_body,
      published_at: new Date(),
    }).returning('*');

    await knex('email_template_versions')
      .where({ id: activeVersion.id })
      .update({ status: 'archived', updated_at: new Date() });

    await knex('email_templates').where({ id: template.id }).update({
      active_version_id: newVersion.id,
      last_published_at: new Date(),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
