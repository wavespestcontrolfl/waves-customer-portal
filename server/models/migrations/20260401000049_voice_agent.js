/**
 * Migration 049 — Voice Agent support columns
 */
exports.up = async function (knex) {
  // Add voice agent columns to call_log (answered_by already exists from 039)
  const clCols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (!clCols.voice_agent_classification) t.text('voice_agent_classification');
    if (!clCols.voice_agent_outcome) t.string('voice_agent_outcome');
    if (!clCols.voice_agent_lead_id) t.uuid('voice_agent_lead_id');
  });

  // Add agent_type to csr_call_scores
  const csCols = await knex('csr_call_scores').columnInfo();
  if (!csCols.agent_type) {
    await knex.schema.alterTable('csr_call_scores', t => {
      t.string('agent_type').defaultTo('human');
    });
  }

  // System config table
  const hasConfig = await knex.schema.hasTable('system_config');
  if (!hasConfig) {
    await knex.schema.createTable('system_config', t => {
      t.string('key').primary();
      t.text('value');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function (knex) {
  const clCols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (clCols.voice_agent_classification) t.dropColumn('voice_agent_classification');
    if (clCols.voice_agent_outcome) t.dropColumn('voice_agent_outcome');
    if (clCols.voice_agent_lead_id) t.dropColumn('voice_agent_lead_id');
  });
  const csCols = await knex('csr_call_scores').columnInfo();
  if (csCols.agent_type) {
    await knex.schema.alterTable('csr_call_scores', t => { t.dropColumn('agent_type'); });
  }
  await knex.schema.dropTableIfExists('system_config');
};
