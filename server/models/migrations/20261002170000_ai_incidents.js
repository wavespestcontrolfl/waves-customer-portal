/**
 * ai_incidents — the general "was this AI output actually a mistake?" ledger
 * (correction-loop scope 2026-10-02, owner rulings Q1 + Q5).
 *
 * One row per ADJUDICATED piece of correction evidence, any AI area. `area`
 * names the lane family ('sms' first); `incident_key` is the one unit of AI
 * work the evidence is about (for sms: message_drafts.id), so a judgment, a
 * corrected Agent Review decision and a rejected draft about the same reply
 * count as ONE incident.
 *
 *   - UNIQUE (area, evidence_type, evidence_id): the nightly adjudicator is
 *     idempotent (anti-join + this key).
 *   - partial UNIQUE (area, incident_key, surface, failure_mode) WHERE
 *     disposition = 'confirmed_mistake': one incident never counts twice in a
 *     cell, whatever number of evidence rows describe it. A second piece of
 *     evidence for an already-confirmed incident is stored as 'duplicate'.
 *
 * Dispositions: confirmed_mistake (counts toward a fix proposal), lead (worth
 * a look, never counted), not_a_mistake, duplicate.
 *
 * Nothing reads this table at runtime yet: the sms_pathology_entries ledger and
 * its weekly proposer are untouched. PII: `summary` is model-written with a
 * no-names rule and `adjudication.model.quote` is a span of the AI's own draft;
 * same internal-ops posture as message_drafts. Deliberately NOT granted to the
 * read-only chart role.
 */

const DISPOSITIONS = ['confirmed_mistake', 'lead', 'not_a_mistake', 'duplicate'];

exports.DISPOSITIONS = DISPOSITIONS;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ai_incidents')) return;
  await knex.schema.createTable('ai_incidents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('area', 30).notNullable();
    t.string('evidence_type', 30).notNullable();
    // Text, not uuid: other areas key their rows on bigint/integer ids
    // (service_recaps, llm_dispatch_log), and this table is every area's.
    t.string('evidence_id', 64).notNullable();
    t.string('incident_key', 64).notNullable();
    t.string('disposition', 20).notNullable();
    t.string('surface', 40).notNullable().defaultTo('other');
    t.string('failure_mode', 60).notNullable().defaultTo('other');
    t.string('intent', 50);
    t.string('prompt_version', 40);
    // When the AI produced the output — recurrence is attributed by THIS, never
    // by when the evidence was judged or adjudicated (the judge runs days late).
    t.timestamp('produced_at');
    t.jsonb('adjudication').notNullable().defaultTo('{}');
    t.text('summary');
    t.string('model', 80);
    t.string('schema_version', 40).notNullable().defaultTo('ai-incidents.v1');
    t.timestamp('adjudicated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['area', 'evidence_type', 'evidence_id'], { indexName: 'ai_incidents_evidence_unique' });
    t.index(['area', 'disposition', 'surface', 'failure_mode'], 'ai_incidents_cell_idx');
    t.index(['area', 'prompt_version'], 'ai_incidents_version_idx');
  });
  await knex.raw(`
    ALTER TABLE ai_incidents
      ADD CONSTRAINT ai_incidents_disposition_check
      CHECK (disposition IN (${DISPOSITIONS.map((d) => `'${d}'`).join(', ')}))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX ai_incidents_one_confirmed_per_cell
      ON ai_incidents (area, incident_key, surface, failure_mode)
      WHERE disposition = 'confirmed_mistake'
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_incidents');
};
