// Hands-free field voice, PR 3a (owner 2026-11-01, "ok build"): the tables
// behind the "Waves Tech" voice line, dark behind GATE_TECH_VOICE_LINE.
//
//   tech_voice_pins   one protected PIN per technician (a salted scrypt hash;
//                     the PIN step that writes it comes in its own PR). Its
//                     own table so a `select *` on technicians never carries
//                     it; the lockout counters live beside the hash.
//   tech_voice_usage  the billed-minute ledger. Each call the line answers
//                     reserves 3 minutes BEFORE Twilio answers; the call's
//                     completed status callback settles the billed minutes
//                     (Twilio rounds each call up to a whole minute). An
//                     unsettled row keeps its reservation. The daily and
//                     monthly limits sum COALESCE(billed_minutes,
//                     reserved_minutes) per technician (services/tech-voice-usage.js).
//
// No data is written here; both tables start empty.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tech_voice_pins'))) {
    await knex.schema.createTable('tech_voice_pins', (t) => {
      t.uuid('technician_id').primary().references('id').inTable('technicians').onDelete('CASCADE');
      t.text('pin_hash').notNullable();
      t.integer('failed_attempts').notNullable().defaultTo(0);
      t.timestamp('locked_until', { useTz: true }).nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('tech_voice_usage'))) {
    await knex.schema.createTable('tech_voice_usage', (t) => {
      t.string('call_sid', 64).primary();
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
      t.integer('reserved_minutes').notNullable();
      t.integer('billed_minutes').nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('settled_at', { useTz: true }).nullable();
      t.index(['technician_id', 'created_at'], 'tech_voice_usage_tech_created_idx');
    });
    await knex.raw(`ALTER TABLE tech_voice_usage ADD CONSTRAINT tech_voice_usage_minutes_check
      CHECK (reserved_minutes > 0 AND (billed_minutes IS NULL OR billed_minutes >= 0))`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tech_voice_usage');
  await knex.schema.dropTableIfExists('tech_voice_pins');
};
