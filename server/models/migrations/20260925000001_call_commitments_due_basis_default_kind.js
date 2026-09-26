// Widens call_commitments.due_basis to allow 'default_kind' (SMS ops closure
// lane, owner ruling 2026-09-24: per-kind default deadlines).
//
// 'stated' = the caller/agent/customer named a time; 'suggested' = a call's
// derived-from-context default (services/call-commitments.js). 'default_kind'
// is a third, distinct concept the SMS lane needs: an obligation with NO
// stated timing at all gets a fixed per-kind SLA deadline
// (server/services/sms-operational-actions.js, DEFAULT_DEADLINE_HOURS) —
// never a value inferred from the conversation, so it must not read as
// 'suggested'. No existing reader (listSmsCommitments does not even select
// due_basis; the Call Intelligence panel only ever sees call-derived rows)
// breaks by adding a third allowed value.
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS call_commitments_due_basis_check');
  await knex.raw(
    `ALTER TABLE call_commitments ADD CONSTRAINT call_commitments_due_basis_check
      CHECK (due_basis IS NULL OR due_basis IN ('stated', 'suggested', 'default_kind'))`,
  );
};

exports.down = async function down(knex) {
  // Any row already stamped 'default_kind' would violate the restored
  // constraint. It is still an SMS-lane default deadline, never a
  // human-stated one — 'suggested' (derived default) is the closest legacy
  // value, never 'stated'.
  await knex('call_commitments').where({ due_basis: 'default_kind' }).update({ due_basis: 'suggested' });
  await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS call_commitments_due_basis_check');
  await knex.raw(
    `ALTER TABLE call_commitments ADD CONSTRAINT call_commitments_due_basis_check
      CHECK (due_basis IS NULL OR due_basis IN ('stated', 'suggested'))`,
  );
};
