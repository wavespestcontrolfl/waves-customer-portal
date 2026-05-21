const {
  applyAutomationStepContactPhoneRepair,
  revertAutomationStepContactPhoneRepair,
  hasMigration,
} = require('./20260518000006_repair_automation_step_contact_phone');

exports.up = async function (knex) {
  if (await hasMigration(knex, '20260518000006_repair_automation_step_contact_phone.js')) return;
  await applyAutomationStepContactPhoneRepair(knex);
};

exports.down = async function (knex) {
  if (await hasMigration(knex, '20260518000006_repair_automation_step_contact_phone.js')) return;
  await revertAutomationStepContactPhoneRepair(knex);
};
