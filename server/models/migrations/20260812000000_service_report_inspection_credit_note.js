// Inspection-credit terms ride the service-report email (owner ruling
// 2026-08-12): the report is the one write-up every inspection customer
// receives — a comped or payer-billed inspection produces no customer
// receipt, so without this line the customer holds a credit promise they
// were never told about and watch it lapse. Adds an optional
// {{inspection_credit_note}} variable to service.report_ready; the sender
// fills it with the shared receipt-memo sentence (frozen amount + frozen
// last-bookable day) when the visit has an open unexpired offer, and an
// EMPTY string otherwise — renderBlocks drops empty blocks, so every
// non-credit report reads exactly as before.
//
// Read-modify-write per the template-migration rule (20260713000021
// precedent): the allowlist entry always lands (send-time validation
// fails a referenced-but-not-allowed variable), but the version body is
// only rewritten when the seeded {{pressure_summary}} paragraph is still
// present and no block already references the new variable — an
// admin-edited body is left alone, and `down` removes only the exact
// block this migration inserts.
const TEMPLATE_KEY = 'service.report_ready';
const VARIABLE = 'inspection_credit_note';
const ANCHOR_CONTENT = '{{pressure_summary}}';
const NEW_BLOCK = { type: 'paragraph', content: '{{inspection_credit_note}}' };
// Realistic preview copy for the admin template editor — mirrors
// inspectionCreditReceiptMemo's exact sentence shape.
const FIXTURE_VALUE = 'You have a $75.00 service credit from your inspection — it applies to any service you book by June 22, 2026.';

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
  const tpl = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!tpl) return;

  await knex('email_templates').where({ id: tpl.id }).update({
    allowed_variables: addVariable(tpl.allowed_variables, VARIABLE),
    optional_variables: addVariable(tpl.optional_variables, VARIABLE),
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
