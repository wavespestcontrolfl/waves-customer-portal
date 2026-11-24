'use strict';

/**
 * Stores the two new_lead drip steps seeded by 20261124140000_new_lead_drip_steps as enabled=false (that file was pushed
 * before this was decided, so it is superseded here instead of edited, waves-db skill §4).
 *
 * Why: a runner from before the drip change, or a revert of it (the normal undo), selects only ENABLED rows. With the rows
 * enabled, such a runner would schedule and send them with neither GATE_NEW_LEAD_DRIP_STEPS nor the stops in
 * services/new-lead-drip-stops.js. With enabled=false it can never see them. With the gate on, the runner of this change loads
 * these two ids whatever the flag says (automation-runner.js enabledSequenceSteps), so the gate is their switch.
 *
 * Touches only the two seeded ids; a step the owner added by hand is left alone. Idempotent. down() is a documented no-op: it
 * must not re-enable rows that an older runner could then send.
 */

const DRIP_STEP_IDS = ['c215d7f2-8052-47ac-94ac-e5c049ed2ca2', '04ca91c9-8bcf-49f2-95a3-5b6c3a359602'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  await knex('automation_steps')
    .where({ template_key: 'new_lead' })
    .whereIn('id', DRIP_STEP_IDS)
    .update({ enabled: false, updated_at: knex.fn.now() });
};

exports.down = async function down() {};
