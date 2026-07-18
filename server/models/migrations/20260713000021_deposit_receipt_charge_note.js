// Deposit surcharge revert (owner ruling 2026-07-13): receipts must state
// the ACTUAL card charge when a surcharge was collected — a $49 deposit
// paid on a credit card charges $50.42, and a receipt saying only "$49"
// is not proof of the charge. Adds an optional {charge_note} variable to
// both deposit-receipt templates; the sender fills it with
// " (card charge total $50.42, includes the $1.42 card processing fee)"
// on surcharged captures and an EMPTY string otherwise (wallets, debit,
// pre-revert deposits), so face-value receipts read exactly as before.
//
// Read-modify-write per the template-migration rule: the body is only
// rewritten when it still matches the seeded text — an admin-edited body
// is left alone (the variable is still registered so the admin can adopt
// it), and `down` only reverts bodies this migration wrote.
const SMS_KEY = 'deposit_receipt';
const SMS_SEEDED_BODY = 'Hello {first_name}! We received your ${amount} deposit — it will be applied toward your first visit. Thank you for choosing Waves!\n\nQuestions or requests? Reply here. Reply STOP to opt out.';
const SMS_NEW_BODY = 'Hello {first_name}! We received your ${amount} deposit{charge_note} — it will be applied toward your first visit. Thank you for choosing Waves!\n\nQuestions or requests? Reply here. Reply STOP to opt out.';

const EMAIL_KEY = 'deposit.receipt';
const EMAIL_SEEDED_PARAGRAPH = 'Hi {{first_name}}, we received your {{amount}} deposit — thank you.';
const EMAIL_NEW_PARAGRAPH = 'Hi {{first_name}}, we received your {{amount}} deposit{{charge_note}} — thank you.';

function addVariable(list, name) {
  const vars = Array.isArray(list) ? list : JSON.parse(list || '[]');
  if (!vars.includes(name)) vars.push(name);
  return JSON.stringify(vars);
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    const row = await knex('sms_templates').where({ template_key: SMS_KEY }).first();
    if (row) {
      const patch = { variables: addVariable(row.variables, 'charge_note') };
      if (String(row.body) === SMS_SEEDED_BODY) patch.body = SMS_NEW_BODY;
      await knex('sms_templates').where({ id: row.id }).update(patch);
    }
  }
  // Email templates are VERSIONED (prod-verified 2026-07-13): the body
  // lives in email_template_versions.blocks; email_templates carries the
  // variable allowlist the send-time validator enforces (a referenced-but-
  // not-allowed variable FAILS the send), so both must move together.
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    const tpl = await knex('email_templates').where({ template_key: EMAIL_KEY }).first();
    if (tpl) {
      await knex('email_templates').where({ id: tpl.id }).update({
        allowed_variables: addVariable(tpl.allowed_variables, 'charge_note'),
        optional_variables: addVariable(tpl.optional_variables, 'charge_note'),
      });
      const versions = await knex('email_template_versions').where({ template_id: tpl.id }).select('id', 'blocks', 'text_body');
      for (const v of versions) {
        const patch = {};
        const blocksText = typeof v.blocks === 'string' ? v.blocks : JSON.stringify(v.blocks || []);
        if (blocksText.includes(EMAIL_SEEDED_PARAGRAPH)) {
          patch.blocks = blocksText.replace(EMAIL_SEEDED_PARAGRAPH, EMAIL_NEW_PARAGRAPH);
        }
        if (typeof v.text_body === 'string' && v.text_body.includes(EMAIL_SEEDED_PARAGRAPH)) {
          patch.text_body = v.text_body.replace(EMAIL_SEEDED_PARAGRAPH, EMAIL_NEW_PARAGRAPH);
        }
        if (Object.keys(patch).length) {
          await knex('email_template_versions').where({ id: v.id }).update(patch);
        }
      }
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    const row = await knex('sms_templates').where({ template_key: SMS_KEY }).first();
    if (row && String(row.body) === SMS_NEW_BODY) {
      await knex('sms_templates').where({ id: row.id }).update({ body: SMS_SEEDED_BODY });
    }
  }
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    const tpl = await knex('email_templates').where({ template_key: EMAIL_KEY }).first();
    if (tpl) {
      const versions = await knex('email_template_versions').where({ template_id: tpl.id }).select('id', 'blocks', 'text_body');
      for (const v of versions) {
        const patch = {};
        const blocksText = typeof v.blocks === 'string' ? v.blocks : JSON.stringify(v.blocks || []);
        if (blocksText.includes(EMAIL_NEW_PARAGRAPH)) {
          patch.blocks = blocksText.replace(EMAIL_NEW_PARAGRAPH, EMAIL_SEEDED_PARAGRAPH);
        }
        if (typeof v.text_body === 'string' && v.text_body.includes(EMAIL_NEW_PARAGRAPH)) {
          patch.text_body = v.text_body.replace(EMAIL_NEW_PARAGRAPH, EMAIL_SEEDED_PARAGRAPH);
        }
        if (Object.keys(patch).length) {
          await knex('email_template_versions').where({ id: v.id }).update(patch);
        }
      }
      // The allowlist entry stays on down — an inert allowed variable is
      // harmless, while removing one a re-edited body still references
      // would break sends.
    }
  }
};
