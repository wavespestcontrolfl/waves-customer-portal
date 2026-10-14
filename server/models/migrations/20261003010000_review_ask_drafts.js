/**
 * review_ask_drafts — what the technician's-voice review writer did for each
 * cadence touch (GATE_REVIEW_ASK_TECH_VOICE; build plan PR 3, the review
 * page): the text it drafted, the record lines the fact check cited for each
 * sentence, a draft held as a repeat of an earlier touch, or the reason the
 * touch fell back to the fixed text. Written only by review-ask-drafter.js
 * (best effort, never blocks a send) and read by the Reviews page so the owner
 * can spot-check the texts once the switch is on. Rows go with their customer
 * and their cadence.
 */

const TABLE = 'review_ask_drafts';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('sequence_id').references('id').inTable('review_sequences').onDelete('CASCADE');
    t.integer('sequence_step');
    t.string('channel', 10);
    // 'drafted' = passed every check (the text the customer gets);
    // 'held' = repeats an earlier touch, nothing sent for the step;
    // 'fallback' = no draft passed, the fixed text sends (reason says why)
    t.string('outcome', 12).notNullable();
    t.string('reason', 80);
    t.text('body');
    // { sentences: [{ sentence, quotes, ask_only, greeting_only }], repeat: { sentence, earlierQuote, earlierStep } }
    t.jsonb('evidence');
    t.string('technician_name', 80);
    t.string('service_type', 120);
    t.date('service_date');
    t.timestamps(true, true);
    t.index(['created_at']);
    t.index(['sequence_id', 'sequence_step']);
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT review_ask_drafts_outcome_check CHECK (outcome IN ('drafted', 'held', 'fallback'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
