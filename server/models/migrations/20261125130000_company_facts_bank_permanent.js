'use strict';

/**
 * The company facts bank is permanent (pre-push audit, P0): migration 20261125120000 made company_facts and
 * company_fact_events with a down() that drops them, and that file is pushed, so it cannot be edited. A rollback of it
 * would erase the only copy of the owner's approved wording and the append-only history.
 *
 * Remedy, the pattern of 20261120020000 (voice_gpt_live_ledger): up() RENAMES the tables (with their triggers,
 * trigger functions, indexes and constraints) so the old file's down() finds nothing under its names: its
 * dropTableIfExists and DROP ... IF EXISTS statements become no-ops (checked: `DROP TRIGGER IF EXISTS .. ON <missing table>`
 * only raises a notice), and its DROP FUNCTION IF EXISTS no longer matches either. THIS file's down() always refuses.
 * Roll forward, never back; to remove the bank, delete the rows by hand on the owner's word.
 *
 * Also adds the one constraint the audit asked for: an approved or retired row must name its approver (NOT VALID, so it
 * binds every new write and cannot fail on a row already stored; the service always sets approved_by).
 *
 * Code reads the new names: company_fact_bank and company_fact_bank_events.
 */
const TABLES = [['company_facts', 'company_fact_bank'], ['company_fact_events', 'company_fact_bank_events']];
const FUNCTIONS = [['company_facts_guard', 'company_fact_bank_guard'], ['company_fact_events_append_only', 'company_fact_bank_events_append_only']];
// [table (new name), old trigger name, new trigger name]
const TRIGGERS = [
  ['company_fact_bank', 'company_facts_guard_trg', 'company_fact_bank_guard_trg'],
  ['company_fact_bank_events', 'company_fact_events_append_only_trg', 'company_fact_bank_events_append_only_trg'],
];
// Constraints by table (new name): the primary keys carry their index with them.
const CONSTRAINTS = [
  ['company_fact_bank', 'company_facts_pkey', 'company_fact_bank_pkey'],
  ['company_fact_bank', 'company_facts_status_chk', 'company_fact_bank_status_chk'],
  ['company_fact_bank', 'company_facts_source_chk', 'company_fact_bank_source_chk'],
  ['company_fact_bank', 'company_facts_sha_chk', 'company_fact_bank_sha_chk'],
  ['company_fact_bank', 'company_facts_approved_at_chk', 'company_fact_bank_approved_at_chk'],
  ['company_fact_bank', 'company_facts_retired_chk', 'company_fact_bank_retired_chk'],
  ['company_fact_bank', 'company_facts_supersedes_id_foreign', 'company_fact_bank_supersedes_id_foreign'],
  ['company_fact_bank_events', 'company_fact_events_pkey', 'company_fact_bank_events_pkey'],
  ['company_fact_bank_events', 'company_fact_events_action_chk', 'company_fact_bank_events_action_chk'],
];
const INDEXES = [
  ['company_facts_live_text_uq', 'company_fact_bank_live_text_uq'],
  ['company_facts_status_idx', 'company_fact_bank_status_idx'],
  ['company_facts_supersedes_idx', 'company_fact_bank_supersedes_idx'],
  ['company_fact_events_fact_idx', 'company_fact_bank_events_fact_idx'],
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('company_fact_bank')) return; // already renamed
  if (!(await knex.schema.hasTable('company_facts')) || !(await knex.schema.hasTable('company_fact_events'))) {
    throw new Error('company facts bank: neither the old nor the new tables exist; 20261125120000 must run first');
  }
  for (const [from, to] of TABLES) await knex.raw('ALTER TABLE ?? RENAME TO ??', [from, to]);
  for (const [from, to] of FUNCTIONS) await knex.raw(`ALTER FUNCTION ${from}() RENAME TO ${to}`);
  for (const [table, from, to] of TRIGGERS) await knex.raw('ALTER TRIGGER ?? ON ?? RENAME TO ??', [from, table, to]);
  for (const [table, from, to] of CONSTRAINTS) await knex.raw('ALTER TABLE ?? RENAME CONSTRAINT ?? TO ??', [table, from, to]);
  for (const [from, to] of INDEXES) await knex.raw('ALTER INDEX IF EXISTS ?? RENAME TO ??', [from, to]);
  await knex.raw(`
    ALTER TABLE company_fact_bank
      ADD CONSTRAINT company_fact_bank_approver_chk CHECK (status = 'draft' OR approved_by IS NOT NULL) NOT VALID
  `);
};

exports.down = async function down() {
  throw new Error('company_fact_bank holds the owner-approved wording and its history and is permanent: roll forward, not back. Remove rows by hand only on the owner\'s word.');
};
