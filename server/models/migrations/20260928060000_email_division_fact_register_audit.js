'use strict';

/**
 * Records the email-division fact register seed
 * (20260928050000_email_division_fact_register.js, already pushed/frozen —
 * see waves-db skill: never edit an applied migration, supersede with a new
 * file) in the generic audit_log table with an atomic write.
 *
 * Codex pre-push P1 on that migration: its own audit_log write went
 * through recordAuditEvent's default (non-critical, non-trx) path — the
 * application's separate DB handle, not this migration's own transaction —
 * so a write failure was only logged, never propagated, and could let a
 * seed row commit with no matching audit row. This is a SEPARATE migration,
 * not an edit to that one: it only reads the facts 20260928050000 already
 * seeded and appends the audit_log.knowledge_base.fact_seeded event each
 * one should have, this time with `trx: knex` + `critical: true` so the
 * audit row commits atomically.
 *
 * Idempotent: for every knowledge_base row this register's source seeded,
 * checks for an existing 'knowledge_base.fact_seeded' audit_log event for
 * that row's id before writing — running this migration twice (or on an
 * environment where an admin has since edited a row) never double-writes.
 */
const SOURCE = 'email-division-fact-register';
const ACTION = 'knowledge_base.fact_seeded';
const STAMP = '20260928060000_email_division_fact_register_audit';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  if (!(await knex.schema.hasTable('audit_log'))) return;

  const rows = await knex('knowledge_base')
    .where({ category: 'facts', source: SOURCE })
    .select('id', 'slug');
  if (!rows.length) return; // nothing to audit yet in this environment

  const { recordAuditEvent } = require('../../services/audit-log');
  for (const row of rows) {
    const existing = await knex('audit_log')
      .where({ action: ACTION, resource_type: 'knowledge_base', resource_id: row.id })
      .first('id');
    if (existing) continue;

    await recordAuditEvent({
      actor_type: 'migration',
      actor_id: null,
      action: ACTION,
      resource_type: 'knowledge_base',
      resource_id: row.id,
      metadata: {
        slug: row.slug,
        migration: STAMP,
        seededBy: '20260928050000_email_division_fact_register',
        source: SOURCE,
      },
      trx: knex,
      critical: true,
    });
  }
};

// Audit history is append-only — never delete an audit_log row. The seed
// rows themselves are handled by 20260928050000's own (also documented
// no-op) down(); this migration owns only the audit trail entries.
exports.down = async function down() {};

exports.ACTION = ACTION;
