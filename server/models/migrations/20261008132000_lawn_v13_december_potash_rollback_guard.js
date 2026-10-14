/**
 * Lawn protocol v13, December 10-0-22: a rollback guard for 20261008130000 and 20261008131000 (Codex round 2 on
 * #6137). Both are pushed and frozen; this one edits neither. The pattern is the one 20261007187000 and
 * 20261007189600 use: up() writes nothing new, the guard is its down(), which runs before the frozen downs.
 *
 * The gap. When 20261008130000 finds the 10-0-22 already in the catalog it fills the row's empty analysis,
 * slow-release and watering fields (and, as an insert, writes a whole row). Its down() decides whether to give them back
 * by counting `kept`, and `kept` counts ONLY the protocols with a December swap log that a visit or a completion
 * references. Its Arena and weed-season helpers skip a referenced protocol too, but their return value is discarded.
 * A referenced v13 protocol with NO December swap log (its December row already named the 10-0-22, or it had no
 * 24-0-11 row to swap) is therefore never counted: `kept` stays 0, revertCatalog() clears the fills on the catalog row
 * that protocol still uses, and its lb_n December step can no longer derive 4.5 lb from its 0.45 lb N target. The
 * follow-up's down() returns early when a protocol is referenced, which leaves the frozen down to run with the same
 * blind spot (Codex, round 2).
 *
 * The change. The decision has to be made when the rollback runs, not when this migration ran: a protocol can become
 * referenced at any time. This down() runs first in a full rollback. When any v13 protocol is referenced by a scheduled
 * visit or a completion it rewrites the frozen CATALOG audit row ('v13_december_potash_catalog') with
 * neutralizeAuditRows, the helper the earlier guards use: the originals stay under `keptLive` and the row now reads
 * "nothing inserted, nothing filled", so the frozen revertCatalog() changes nothing. The catalog row, the fields it
 * filled and the follow-up's rate (whose own down() already keeps it under the same test) all stay.
 * With nothing referenced nothing is rewritten and the frozen downs run a clean undo.
 *
 * Why only the catalog row. Every per-protocol log (December swap, weed season, Arena) already asks "is THIS
 * protocol referenced?" itself at rollback time and leaves a referenced protocol whole, which is what the frozen files
 * mean; an unreferenced protocol in the same rollback goes back to the staged state. Neutralizing those too would
 * keep the unreferenced ones swapped for no reason. The catalog is the one thing shared by all protocols, so the
 * frozen files' own rule (a referenced protocol still uses it) is applied to it by this guard for every case.
 *
 * Rolling this migration back alone. down() cannot know whether the frozen downs will follow, so with a protocol
 * referenced it neutralizes anyway; the frozen files stay applied. up() puts every neutralized catalog row back from
 * `keptLive`, so down then up is stable and a later rollback of the frozen files, once nothing is referenced, runs as
 * the frozen files intend. If the frozen files are instead rolled back after this down and the reference has gone, the
 * fills on a row that existed before stay where they are (residue, never a loss; the row is only ever deleted by
 * the frozen down when it is unchanged, unpriced and unreferenced).
 */

const { anyV13ProtocolReferenced, neutralizeAuditRows } = require('../../services/lawn-v13-rollback-guard');
const december = require('./20261008130000_lawn_v13_december_potash');

const MIGRATION = '20261008132000_lawn_v13_december_potash_rollback_guard';

// What the frozen revertCatalog() reads as "nothing inserted, nothing filled".
const EMPTY_BY_ACTION = { [december.CATALOG_ACTION]: { inserted: null, filled: [] } };

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Puts every neutralized catalog audit row back as it was (the original is kept under `keptLive`).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: december.CATALOG_ACTION }).select('id', 'after_snapshot')) {
    const after = asObject(log.after_snapshot);
    if (!after.keptLive || typeof after.keptLive !== 'object') continue;
    await knex('lawn_protocol_audit_log').where({ id: log.id }).update({ after_snapshot: JSON.stringify(after.keptLive) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_protocol_audit_log'))) return;
  if (!(await anyV13ProtocolReferenced(knex))) return;
  const changed = await neutralizeAuditRows(knex, EMPTY_BY_ACTION);
  console.log(`[lawn-v13-december-potash-rollback-guard] a visit or completion references 2026.10-v13: ${changed} catalog rollback entries kept as they are; the 10-0-22 row and its fills stay`);
};

exports.EMPTY_BY_ACTION = EMPTY_BY_ACTION;
exports.MIGRATION = MIGRATION;
