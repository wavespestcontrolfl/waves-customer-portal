'use strict';

/**
 * Records the 'AI Assistant Referrals' lead_sources seed
 * (20260928030000_ai_assistant_lead_source.js, already deployed/frozen — see
 * waves-db skill: never edit an applied migration, supersede with a new
 * file) in the generic audit_log table.
 *
 * Codex pre-push P1-b on the AI-referral attribution PR: "Migrations that
 * touch seeded/admin-editable rows must ... write an audit row when an audit
 * table exists" (waves-db skill). 20260928030000 seeded a lead_sources row
 * with no audit_log entry. This is a SEPARATE migration, not an edit to that
 * one — it only reads the row 20260928030000 already created and appends
 * the audit event 20260928030000 should have written.
 *
 * Idempotent: looks up the seeded row by source_type (the same key
 * 20260928030000 upserts by), then checks for an existing
 * 'lead_sources.seeded' audit_log event for that row before writing —
 * running this migration twice (or on an environment where an admin has
 * since renamed the row) never double-writes.
 */
const SOURCE_TYPE = 'ai_assistant';
const ACTION = 'lead_sources.seeded';
const STAMP = '20260928040000_ai_assistant_lead_source_audit';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;
  if (!(await knex.schema.hasTable('audit_log'))) return;

  const row = await knex('lead_sources').where({ source_type: SOURCE_TYPE }).first('id', 'name');
  // Nothing to audit yet (e.g. 20260928030000 hasn't run in this
  // environment for some reason) — no-op rather than fabricate a row.
  if (!row) return;

  const existing = await knex('audit_log')
    .where({ action: ACTION, resource_type: 'lead_sources', resource_id: row.id })
    .first('id');
  if (existing) return;

  await require('../../services/audit-log').recordAuditEvent({
    actor_type: 'system',
    action: ACTION,
    resource_type: 'lead_sources',
    resource_id: row.id,
    metadata: {
      source_type: SOURCE_TYPE,
      name: row.name,
      migration: STAMP,
      seededBy: '20260928030000_ai_assistant_lead_source',
      reason: 'AI-assistant referral attribution lane (owner-approved 2026-09-27) — codex pre-push P1-b',
    },
    trx: knex,
    critical: true,
  });
};

// Audit history is append-only — never delete an audit_log row. The seed
// row itself is handled by 20260928030000's own (also documented no-op)
// down(); this migration owns only the audit trail entry.
exports.down = async function down() {};

exports.ACTION = ACTION;
