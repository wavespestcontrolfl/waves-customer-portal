/**
 * Migration 051 — Voice Agent v2 columns
 * Adds caller_city, caller_state to call_log (from Twilio request params)
 */
exports.up = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (!cols.caller_city) t.string('caller_city');
    if (!cols.caller_state) t.string('caller_state');
    if (!cols.call_sid) t.string('call_sid', 64); // alias for twilio_call_sid
  });
};

exports.down = async function (knex) {
  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', t => {
    if (cols.caller_city) t.dropColumn('caller_city');
    if (cols.caller_state) t.dropColumn('caller_state');
    if (cols.call_sid) t.dropColumn('call_sid');
  });
};
