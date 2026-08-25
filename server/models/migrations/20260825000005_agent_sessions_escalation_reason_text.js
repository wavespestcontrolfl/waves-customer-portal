/**
 * agent_sessions.escalation_reason was created as varchar(255) (as
 * ai_conversations in 20260401000039, renamed in 20260418000006). The
 * escalate tool passes a model-written reason straight into this column,
 * and reasons over 255 chars made the UPDATE throw — turning a successful
 * escalation into the generic "I'm having trouble right now" fallback for
 * the customer (live case 2026-08-25, portal chat). Widen to text.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('agent_sessions'))) return;
  if (!(await knex.schema.hasColumn('agent_sessions', 'escalation_reason'))) return;
  await knex.schema.alterTable('agent_sessions', t => {
    t.text('escalation_reason').alter();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('agent_sessions'))) return;
  if (!(await knex.schema.hasColumn('agent_sessions', 'escalation_reason'))) return;
  // Truncate any long values first so the narrowing alter cannot fail.
  await knex('agent_sessions')
    .whereRaw('length(escalation_reason) > 255')
    .update({ escalation_reason: knex.raw('left(escalation_reason, 255)') });
  await knex.schema.alterTable('agent_sessions', t => {
    t.string('escalation_reason').alter();
  });
};
