// Owner ruling 2026-07-30 (email leg of the same disclosure as
// 20260730000010): the autopay setup-invitation emails carry the
// late-cancel/no-show fee line via a {{cancel_fee_line}} token, composed at
// send time from pricing_config. Three coordinated pieces per template
// (Codex #3077):
//   1. blocks       — token paragraph appended to the ACTIVE version.
//   2. text_body    — an admin-authored plain-text body overrides
//                     block-generated text at render time, so the token is
//                     appended there too or the MIME parts would disagree.
//   3. variable metadata — cancel_fee_line added to allowed/optional
//                     variables so future admin drafts of these templates
//                     still validate and publish.
// All read-modify-write, applied only when absent — admin edits preserved.
const KEYS = ['autopay.setup_invitation', 'autopay.plan_choice_invitation'];
const TOKEN = '{{cancel_fee_line}}';

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const key of KEYS) {
    const template = await knex('email_templates')
      .where({ template_key: key })
      .first('id', 'active_version_id', 'allowed_variables', 'optional_variables');
    if (!template) continue;

    const allowed = parseArray(template.allowed_variables);
    const optional = parseArray(template.optional_variables);
    const metaPatch = {};
    if (!allowed.includes('cancel_fee_line')) metaPatch.allowed_variables = JSON.stringify([...allowed, 'cancel_fee_line']);
    if (!optional.includes('cancel_fee_line')) metaPatch.optional_variables = JSON.stringify([...optional, 'cancel_fee_line']);
    if (Object.keys(metaPatch).length) {
      await knex('email_templates').where({ id: template.id }).update({ ...metaPatch, updated_at: new Date() });
    }

    if (!template.active_version_id) continue;
    const version = await knex('email_template_versions')
      .where({ id: template.active_version_id })
      .first('id', 'blocks', 'text_body');
    if (!version) continue;

    const patch = {};
    const blocks = parseArray(version.blocks);
    if (blocks.length && !JSON.stringify(blocks).includes('cancel_fee_line')) {
      blocks.push({ type: 'paragraph', content: TOKEN });
      patch.blocks = JSON.stringify(blocks);
    }
    if (typeof version.text_body === 'string' && version.text_body.trim() && !version.text_body.includes('cancel_fee_line')) {
      patch.text_body = `${version.text_body}\n\n${TOKEN}`;
    }
    if (Object.keys(patch).length) {
      await knex('email_template_versions').where({ id: version.id }).update({ ...patch, updated_at: new Date() });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const key of KEYS) {
    const template = await knex('email_templates')
      .where({ template_key: key })
      .first('id', 'active_version_id', 'allowed_variables', 'optional_variables');
    if (!template) continue;

    const allowed = parseArray(template.allowed_variables).filter((v) => v !== 'cancel_fee_line');
    const optional = parseArray(template.optional_variables).filter((v) => v !== 'cancel_fee_line');
    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: JSON.stringify(allowed),
      optional_variables: JSON.stringify(optional),
      updated_at: new Date(),
    });

    if (!template.active_version_id) continue;
    const version = await knex('email_template_versions')
      .where({ id: template.active_version_id })
      .first('id', 'blocks', 'text_body');
    if (!version) continue;

    const patch = {};
    const blocks = parseArray(version.blocks);
    const filtered = blocks.filter((b) => !(b && typeof b.content === 'string' && b.content.includes('cancel_fee_line')));
    if (filtered.length !== blocks.length) patch.blocks = JSON.stringify(filtered);
    if (typeof version.text_body === 'string' && version.text_body.includes(TOKEN)) {
      patch.text_body = version.text_body.replace(`\n\n${TOKEN}`, '').replace(TOKEN, '');
    }
    if (Object.keys(patch).length) {
      await knex('email_template_versions').where({ id: version.id }).update({ ...patch, updated_at: new Date() });
    }
  }
};
