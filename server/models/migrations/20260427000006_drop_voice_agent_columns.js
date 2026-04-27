/**
 * Migration — drop unused voice-agent DB columns
 *
 * PR #233 retired the voice-agent code paths; PR #334 + the Twilio API
 * batch on 2026-04-27 cleared the last live dependency. The corresponding
 * columns have no readers or writers in active code and are dropped here.
 *
 * system_config (created in 20260401000049) is intentionally retained —
 * repurposed for the ai_sms_auto_reply toggle (admin-communications.js,
 * twilio-webhook.js).
 */
exports.up = async function (knex) {
  const clCols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', (t) => {
    if (clCols.voice_agent_classification) t.dropColumn('voice_agent_classification');
    if (clCols.voice_agent_outcome) t.dropColumn('voice_agent_outcome');
    if (clCols.voice_agent_lead_id) t.dropColumn('voice_agent_lead_id');
  });

  const csCols = await knex('csr_call_scores').columnInfo();
  if (csCols.agent_type) {
    await knex.schema.alterTable('csr_call_scores', (t) => {
      t.dropColumn('agent_type');
    });
  }
};

exports.down = async function (knex) {
  const clCols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', (t) => {
    if (!clCols.voice_agent_classification) t.text('voice_agent_classification');
    if (!clCols.voice_agent_outcome) t.string('voice_agent_outcome');
    if (!clCols.voice_agent_lead_id) t.uuid('voice_agent_lead_id');
  });

  const csCols = await knex('csr_call_scores').columnInfo();
  if (!csCols.agent_type) {
    await knex.schema.alterTable('csr_call_scores', (t) => {
      t.string('agent_type').defaultTo('human');
    });
  }
};
