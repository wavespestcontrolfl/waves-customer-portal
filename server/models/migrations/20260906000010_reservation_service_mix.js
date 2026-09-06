/** Preserve the combined reservation's capacity policy across deploys and gate changes. */
const ARRIVAL_SQL = `
CREATE OR REPLACE FUNCTION reservation_arrival_start(p_service_id uuid)
RETURNS time AS $$
DECLARE
  member scheduled_services%ROWTYPE;
  stamp jsonb;
  allocation_index integer;
  arrival time;
BEGIN
  SELECT * INTO member FROM scheduled_services WHERE id = p_service_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF member.window_start IS NULL THEN
    RETURN member.window_start;
  END IF;
  stamp := member.reservation_service_mix;
  IF jsonb_typeof(stamp->'allocatedServiceIds') IS DISTINCT FROM 'array' THEN
    RETURN member.window_start;
  END IF;
  allocation_index := array_position(ARRAY(
    SELECT jsonb_array_elements_text(stamp->'allocatedServiceIds')
  ), member.id::text) - 1;
  IF allocation_index IS NULL OR stamp->>'scheduledDate' IS DISTINCT FROM member.scheduled_date::text
     OR COALESCE(stamp->>'arrivalWindowStart', '') !~ '^([01][0-9]|2[0-3]):00$' THEN
    RETURN member.window_start;
  END IF;
  arrival := (stamp->>'arrivalWindowStart')::time;
  -- The original promise survives a skipped member. A service moved out of
  -- its booked work slot has a new arrival and returns to ordinary handling.
  IF member.window_start = arrival + allocation_index * INTERVAL '60 minutes' THEN
    RETURN arrival;
  END IF;
  RETURN member.window_start;
END;
$$ LANGUAGE plpgsql;
`;

// Extend the existing reminder sync and sibling promotion functions in place.
// Exact replacements fail visibly if their contract changes in another migration.
// Reverse the same edits on rollback; no second trigger or delivery mechanism.
const REMINDER_EDITS = [
  ['sync_appointment_reminder_on_service_change', [
    ["old_appt_time := ((OLD.scheduled_date + COALESCE(OLD.window_start, TIME '08:00'))::timestamp\n                    AT TIME ZONE 'America/New_York');",
      "old_appt_time := COALESCE((SELECT appointment_time FROM appointment_reminders WHERE scheduled_service_id = OLD.id LIMIT 1),\n                    ((OLD.scheduled_date + COALESCE(OLD.window_start, TIME '08:00'))::timestamp AT TIME ZONE 'America/New_York'));"],
    ["COALESCE(NEW.window_start, TIME '08:00')", "COALESCE(reservation_arrival_start(NEW.id), TIME '08:00')"],
    ['OLD.scheduled_date, OLD.window_start,', "(old_appt_time AT TIME ZONE 'America/New_York')::date, (old_appt_time AT TIME ZONE 'America/New_York')::time,"],
  ]],
  ['promote_suppressed_reminder_sibling', [
    ["COALESCE(ss2.window_start, TIME '08:00')", "COALESCE(reservation_arrival_start(ss2.id), TIME '08:00')"],
  ]],
];

async function updateReminderFunctions(knex, reverse = false) {
  if (!(await knex.schema.hasTable('appointment_reminders'))) return;
  for (const [name, edits] of REMINDER_EDITS) {
    const result = await knex.raw(`SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = ? AND n.nspname = current_schema()`, [name]);
    if (result.rows.length !== 1) throw new Error(`Expected one ${name} reminder function`);
    let definition = result.rows[0].definition;
    for (const pair of edits) {
      const [before, after] = reverse ? [...pair].reverse() : pair;
      if (definition.includes(after)) continue;
      if (!definition.includes(before)) throw new Error(`Reminder function contract changed: ${name}`);
      definition = definition.replaceAll(before, after);
    }
    await knex.raw(definition);
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'reservation_service_mix'))) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.jsonb('reservation_service_mix').nullable();
    });
  }
  await knex.raw(ARRIVAL_SQL);
  await updateReminderFunctions(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  await updateReminderFunctions(knex, true);
  await knex.raw('DROP FUNCTION IF EXISTS reservation_arrival_start(uuid)');
  if (await knex.schema.hasColumn('scheduled_services', 'reservation_service_mix')) {
    await knex.schema.alterTable('scheduled_services', (table) => {
      table.dropColumn('reservation_service_mix');
    });
  }
};
