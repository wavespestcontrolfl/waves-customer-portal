/**
 * Autonomous Content Engine — persist the remaining gate verdicts.
 *
 * Phase 11 (20260521000014) only created uniqueness_gate_result +
 * quality_gate_result jsonb columns. The runner computes five more gate
 * results in memory and threw them away on persist: claims_ledger,
 * content_guardrails, seo_completion, facts_sufficiency, protected_check —
 * plus the seo_completion_gate_ms timing. With blog auto-publish live, a
 * silently-skipped draft (skip_reason='auto_publish_gate_fail') left no
 * trail of WHICH gate blocked it. These append-only columns close that gap
 * and are the prerequisite for the digest/alerting/dashboard work.
 *
 * Append-only + idempotent (per-column hasColumn guard) — safe to re-run.
 */

const COLUMNS = {
  claims_ledger_result: (t) => t.jsonb('claims_ledger_result').notNullable().defaultTo('{}'),
  content_guardrails_result: (t) => t.jsonb('content_guardrails_result').notNullable().defaultTo('{}'),
  seo_completion_gate_result: (t) => t.jsonb('seo_completion_gate_result').notNullable().defaultTo('{}'),
  facts_sufficiency: (t) => t.jsonb('facts_sufficiency').notNullable().defaultTo('{}'),
  protected_check: (t) => t.jsonb('protected_check').notNullable().defaultTo('{}'),
  seo_completion_gate_ms: (t) => t.integer('seo_completion_gate_ms'),
};

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;
  for (const [name, builder] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasColumn('autonomous_runs', name))) {
      await knex.schema.alterTable('autonomous_runs', builder);
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;
  for (const name of Object.keys(COLUMNS)) {
    if (await knex.schema.hasColumn('autonomous_runs', name)) {
      await knex.schema.alterTable('autonomous_runs', (t) => t.dropColumn(name));
    }
  }
};
