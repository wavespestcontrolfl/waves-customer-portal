'use strict';

// One live-reference check and one "leave nothing to revert" helper for the v13 matrix migrations'
// rollbacks (20261007180000 and later). Rolling a migration back on a protocol that a scheduled visit or a
// completion already references must not change the protocol or catalog facts that visit was planned and
// reported against. A migration's down() reverts what its audit rows say it wrote; to make a rollback a
// no-op while live, the down() that runs first rewrites those audit rows (the originals are kept under
// `keptLive`) so the later down() finds nothing to revert. Shared here so the guard is written once.

const V13_VERSION = '2026.10-v13';

// True when any v13 protocol is referenced by a scheduled visit (pinned to its key and version) or by a
// completion (ledger row). A table that does not exist references nothing.
async function anyV13ProtocolReferenced(knex) {
  if (!(await knex.schema.hasTable('lawn_protocols'))) return false;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  const hasVisits = await knex.schema.hasTable('scheduled_services');
  const hasCompletions = await knex.schema.hasTable('lawn_protocol_service_completions');
  for (const protocol of protocols) {
    if (hasVisits && await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id')) return true;
    if (hasCompletions && await knex('lawn_protocol_service_completions')
      .where({ lawn_protocol_id: protocol.id })
      .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
      .first('id')) return true;
  }
  return false;
}

function parse(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// For each audit action, rewrite its rows to `empty` (what that migration's down() reads as "nothing to do"),
// keeping the original snapshot under `keptLive`. A row already neutralized is left as it is.
async function neutralizeAuditRows(knex, emptyByAction) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return 0;
  let changed = 0;
  for (const [action, empty] of Object.entries(emptyByAction)) {
    for (const log of await knex('lawn_protocol_audit_log').where({ action }).select('id', 'after_snapshot')) {
      const after = parse(log.after_snapshot);
      if (after.keptLive) continue;
      await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify({ ...empty, keptLive: after }) });
      changed += 1;
    }
  }
  return changed;
}

module.exports = { V13_VERSION, anyV13ProtocolReferenced, neutralizeAuditRows };
