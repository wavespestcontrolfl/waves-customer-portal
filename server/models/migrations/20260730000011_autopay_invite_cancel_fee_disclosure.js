// Owner ruling 2026-07-30 (email leg of the same disclosure as
// 20260730000010): the autopay setup-invitation emails carry the
// late-cancel/no-show fee line via a {{cancel_fee_line}} token, composed at
// send time from pricing_config. Read-modify-write on the ACTIVE version's
// blocks — appended only when absent, so admin edits are preserved.
const KEYS = ['autopay.setup_invitation', 'autopay.plan_choice_invitation'];
const TOKEN = '{{cancel_fee_line}}';

async function activeVersion(knex, key) {
  const template = await knex('email_templates').where({ template_key: key }).first('id', 'active_version_id');
  if (!template || !template.active_version_id) return null;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first('id', 'blocks');
  return version || null;
}

function parseBlocks(blocks) {
  if (Array.isArray(blocks)) return blocks;
  try {
    const parsed = JSON.parse(blocks || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const key of KEYS) {
    const version = await activeVersion(knex, key);
    if (!version) continue;
    const blocks = parseBlocks(version.blocks);
    if (!blocks) continue;
    if (JSON.stringify(blocks).includes('cancel_fee_line')) continue;
    blocks.push({ type: 'paragraph', content: TOKEN });
    await knex('email_template_versions')
      .where({ id: version.id })
      .update({ blocks: JSON.stringify(blocks), updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const key of KEYS) {
    const version = await activeVersion(knex, key);
    if (!version) continue;
    const blocks = parseBlocks(version.blocks);
    if (!blocks) continue;
    const filtered = blocks.filter((b) => !(b && typeof b.content === 'string' && b.content.includes('cancel_fee_line')));
    if (filtered.length === blocks.length) continue;
    await knex('email_template_versions')
      .where({ id: version.id })
      .update({ blocks: JSON.stringify(filtered), updated_at: new Date() });
  }
};
