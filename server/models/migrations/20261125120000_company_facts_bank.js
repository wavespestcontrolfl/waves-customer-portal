'use strict';

/**
 * Company facts bank (owner 2026-11-25 "all rec"): the owner-approved lines the agents may state beside the 26
 * code lines in COMPANY_FACTS. PR 1 only: two tables, the guard triggers and the indexes. No agent reads the bank
 * yet; an empty bank changes nothing, so there is no gate.
 *
 * company_facts: one row per line. Life cycle draft -> approved -> retired. A retired line comes back only as a NEW
 * draft (the service copies it). An edit of an approved line is a new draft with supersedes_id; approving it retires
 * the old row in the same transaction (server/services/company-facts-bank.js).
 *  - the partial unique index on text_sha256 (status draft or approved) refuses a second live copy of one line;
 *  - the guard trigger refuses an UPDATE of fact_text / text_sha256 on a row that is not a draft, any move of
 *    status other than draft -> approved or approved -> retired (retired is final), and a DELETE of a row that is
 *    not a draft. So an approved line cannot be reworded, un-retired or erased, whoever writes the SQL.
 *  - created_by / approved_by / retired_by are loose uuids (no foreign key): a deleted staff row must never
 *    rewrite an approved line, and the history keeps the id.
 *
 * company_fact_events: append-only history (drafted, edited, approved, retired, restored_as_draft, discarded).
 * fact_id has no foreign key on purpose: a discarded draft is deleted and its history stays. A trigger refuses
 * UPDATE and DELETE.
 *
 * Down drops the triggers, functions and tables. Rows are lost: acceptable only because nothing reads the bank in
 * this release; a later release that reads it must not roll this migration back.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('company_facts'))) {
    await knex.schema.createTable('company_facts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('topic', 120).notNullable();
      t.string('question', 300);
      t.text('fact_text').notNullable();
      t.specificType('text_sha256', 'char(64)').notNullable();
      t.string('status', 16).notNullable().defaultTo('draft');
      t.string('source', 24).notNullable().defaultTo('admin_page');
      t.string('source_ref', 200);
      t.text('owner_words');
      t.jsonb('check_result');
      t.boolean('warnings_acknowledged').notNullable().defaultTo(false);
      t.uuid('supersedes_id').references('id').inTable('company_facts').onDelete('SET NULL');
      t.uuid('created_by');
      t.uuid('approved_by');
      t.timestamp('approved_at', { useTz: true });
      t.uuid('retired_by');
      t.timestamp('retired_at', { useTz: true });
      t.string('retire_reason', 300);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  await knex.raw(`
    ALTER TABLE company_facts
      ADD CONSTRAINT company_facts_status_chk CHECK (status IN ('draft', 'approved', 'retired')),
      ADD CONSTRAINT company_facts_source_chk CHECK (source IN ('admin_page', 'owner_paste', 'mac_sms_job', 'mac_call_job', 'import')),
      ADD CONSTRAINT company_facts_sha_chk CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT company_facts_approved_at_chk CHECK (status = 'draft' OR approved_at IS NOT NULL OR status = 'retired'),
      ADD CONSTRAINT company_facts_retired_chk CHECK (status <> 'retired' OR (retired_at IS NOT NULL AND retire_reason IS NOT NULL))
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX company_facts_live_text_uq
      ON company_facts (text_sha256) WHERE status IN ('draft', 'approved')
  `);
  await knex.raw('CREATE INDEX company_facts_status_idx ON company_facts (status, approved_at)');
  await knex.raw('CREATE INDEX company_facts_supersedes_idx ON company_facts (supersedes_id) WHERE supersedes_id IS NOT NULL');

  await knex.raw(`
    CREATE FUNCTION company_facts_guard() RETURNS trigger AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
          RAISE EXCEPTION 'company_facts: a % row cannot be deleted', OLD.status USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status <> 'draft' AND (NEW.fact_text IS DISTINCT FROM OLD.fact_text OR NEW.text_sha256 IS DISTINCT FROM OLD.text_sha256) THEN
        RAISE EXCEPTION 'company_facts: fact_text of a % row cannot change', OLD.status USING ERRCODE = '23514';
      END IF;
      IF NEW.status IS DISTINCT FROM OLD.status
         AND NOT ((OLD.status = 'draft' AND NEW.status = 'approved') OR (OLD.status = 'approved' AND NEW.status = 'retired')) THEN
        RAISE EXCEPTION 'company_facts: status cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER company_facts_guard_trg
      BEFORE UPDATE OR DELETE ON company_facts
      FOR EACH ROW EXECUTE FUNCTION company_facts_guard()
  `);

  if (!(await knex.schema.hasTable('company_fact_events'))) {
    await knex.schema.createTable('company_fact_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('fact_id').notNullable();
      t.string('action', 24).notNullable();
      t.uuid('actor_id');
      t.jsonb('detail').notNullable().defaultTo('{}');
      t.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['fact_id', 'at'], 'company_fact_events_fact_idx');
    });
  }
  await knex.raw(`
    ALTER TABLE company_fact_events
      ADD CONSTRAINT company_fact_events_action_chk
      CHECK (action IN ('drafted', 'edited', 'approved', 'retired', 'restored_as_draft', 'discarded'))
  `);
  await knex.raw(`
    CREATE FUNCTION company_fact_events_append_only() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'company_fact_events is append-only' USING ERRCODE = '23514';
    END;
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER company_fact_events_append_only_trg
      BEFORE UPDATE OR DELETE ON company_fact_events
      FOR EACH ROW EXECUTE FUNCTION company_fact_events_append_only()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS company_fact_events_append_only_trg ON company_fact_events');
  await knex.raw('DROP FUNCTION IF EXISTS company_fact_events_append_only()');
  await knex.schema.dropTableIfExists('company_fact_events');
  await knex.raw('DROP TRIGGER IF EXISTS company_facts_guard_trg ON company_facts');
  await knex.raw('DROP FUNCTION IF EXISTS company_facts_guard()');
  await knex.schema.dropTableIfExists('company_facts');
};
