// The acceptance-terms copy (GATE_ESTIMATE_ACCEPTANCE_TERMS, owner ruling
// 2026-08-28) tells the customer "we ... email you a copy". The accepted
// onboarding email is the one email every accepting customer gets, so it
// carries that copy: an optional {{acceptance_note}} paragraph the sender
// fills from the recorded estimate_acceptances row (verbatim line, instant,
// where the full terms print) and leaves EMPTY when nothing was recorded —
// renderBlocks drops empty blocks, so gate-off emails read exactly as before.
//
// Read-modify-write per the template-migration rule (20260812000000
// precedent): the allowlist entry always lands; the version body is only
// rewritten when the seeded "After every visit" report paragraph is still
// present and no block already references the variable — an admin-edited
// body is left alone, and `down` removes only the exact block inserted.
const TEMPLATE_KEY = 'estimate.accepted_onboarding';
const VARIABLE = 'acceptance_note';
const ANCHOR_CONTENT = 'You’ll get a full service report — what we treated, what we found, and photos from your property. It lands in your email and lives in your customer portal.';
const NEW_BLOCK = { type: 'paragraph', content: '{{acceptance_note}}' };
const FIXTURE_VALUE = 'You accepted electronically on Friday, August 28, 2026 at 3:04 PM ET (terms v2026-09): “Accepting authorizes these services at the price shown. Cancel anytime — completed visits are still due.” The full terms are printed on your accepted estimate: https://portal.wavespestcontrol.com/estimate/example';

function addVariable(list, name) {
  const vars = Array.isArray(list) ? list : JSON.parse(list || '[]');
  if (!vars.includes(name)) vars.push(name);
  return JSON.stringify(vars);
}

function parseBlocks(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const referencesVariable = (block) => JSON.stringify(block || {}).includes(VARIABLE);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const tpl = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
  if (!tpl) return;

  await knex('email_templates').where({ id: tpl.id }).update({
    allowed_variables: addVariable(tpl.allowed_variables, VARIABLE),
    optional_variables: addVariable(tpl.optional_variables, VARIABLE),
    updated_at: new Date(),
  });

  const versions = await knex('email_template_versions').where({ template_id: tpl.id }).select('id', 'blocks', 'text_body');
  for (const v of versions) {
    const patch = {};
    const blocks = parseBlocks(v.blocks);
    if (blocks && !blocks.some(referencesVariable)) {
      const anchorIdx = blocks.findIndex((b) => b && b.content === ANCHOR_CONTENT);
      if (anchorIdx !== -1) {
        blocks.splice(anchorIdx + 1, 0, { ...NEW_BLOCK });
        patch.blocks = JSON.stringify(blocks);
      }
    }
    if (typeof v.text_body === 'string' && v.text_body.includes(ANCHOR_CONTENT) && !v.text_body.includes(VARIABLE)) {
      patch.text_body = v.text_body.replace(ANCHOR_CONTENT, `${ANCHOR_CONTENT}\n\n{{${VARIABLE}}}`);
    }
    if (Object.keys(patch).length) {
      await knex('email_template_versions').where({ id: v.id }).update(patch);
    }
  }

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixtures = await knex('email_template_fixtures').where({ template_id: tpl.id }).select('id', 'payload');
    for (const f of fixtures) {
      const payload = typeof f.payload === 'string' ? JSON.parse(f.payload || '{}') : (f.payload || {});
      if (payload[VARIABLE] === undefined) {
        payload[VARIABLE] = FIXTURE_VALUE;
        await knex('email_template_fixtures').where({ id: f.id }).update({ payload: JSON.stringify(payload) });
      }
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const tpl = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!tpl) return;

  const versions = await knex('email_template_versions').where({ template_id: tpl.id }).select('id', 'blocks', 'text_body');
  for (const v of versions) {
    const patch = {};
    const blocks = parseBlocks(v.blocks);
    if (blocks) {
      const filtered = blocks.filter((b) => !(b && b.type === NEW_BLOCK.type && b.content === NEW_BLOCK.content));
      if (filtered.length !== blocks.length) patch.blocks = JSON.stringify(filtered);
    }
    if (typeof v.text_body === 'string' && v.text_body.includes(`\n\n{{${VARIABLE}}}`)) {
      patch.text_body = v.text_body.replace(`\n\n{{${VARIABLE}}}`, '');
    }
    if (Object.keys(patch).length) {
      await knex('email_template_versions').where({ id: v.id }).update(patch);
    }
  }

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixtures = await knex('email_template_fixtures').where({ template_id: tpl.id }).select('id', 'payload');
    for (const f of fixtures) {
      const payload = typeof f.payload === 'string' ? JSON.parse(f.payload || '{}') : (f.payload || {});
      if (payload[VARIABLE] !== undefined) {
        delete payload[VARIABLE];
        await knex('email_template_fixtures').where({ id: f.id }).update({ payload: JSON.stringify(payload) });
      }
    }
  }
  // The allowlist entry stays on down — an inert allowed variable is
  // harmless, while removing one a re-edited body still references
  // would break sends.
};
