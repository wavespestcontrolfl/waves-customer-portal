/**
 * Lawn protocol v13 matrix adds, Codex round 7 (PR #6116). Migrations 20261007180000 to 20261007186000 are
 * pushed and frozen. This one writes no data (up() is empty); it exists for its down(), which runs first when
 * the matrix migrations are rolled back, to close one CLASS of rollback bug at once.
 *
 * The class: several matrix migrations revert catalog or staged-row facts in down() without asking whether a
 * v13 protocol is already referenced by a scheduled visit or a completion. Each earlier round added a guard
 * for the migration before it, and the next round found the next unguarded one (185000's Headway approval,
 * 186000's Advion rate). So now, when any v13 protocol is referenced, this down() rewrites the audit rows of
 * EVERY earlier matrix migration that reverts protocol or catalog facts, leaving their down() nothing to do
 * (the originals are kept under `keptLive`): 181000 (Arena name, Headway rate, Advion fields), 182000 (gates,
 * Advion limits), 183000 (Talak rate and gate, Headway fields), 184000 (catalog approvals), 185000 (July row,
 * Headway approval) and 186000 (Advion rate, catalog default). 180000 keeps its own per-protocol guard (it
 * deletes the rows it inserted only from a protocol nothing references, and its catalog step is skipped while
 * one is referenced). A rollback on a live protocol is then a no-op for those facts. With nothing referenced,
 * nothing is rewritten and the full rollback runs. The check and the rewrite live in
 * services/lawn-v13-rollback-guard.js, once.
 */

const { anyV13ProtocolReferenced, neutralizeAuditRows } = require('../../services/lawn-v13-rollback-guard');
const fixes = require('./20261007181000_lawn_v13_matrix_adds_fixes');
const round2 = require('./20261007182000_lawn_v13_matrix_adds_round2');
const round3 = require('./20261007183000_lawn_v13_matrix_adds_round3');
const round4 = require('./20261007184000_lawn_v13_matrix_adds_round4');
const round5 = require('./20261007185000_lawn_v13_matrix_adds_round5');
const round6 = require('./20261007186000_lawn_v13_matrix_adds_round6');

// What each earlier down() reads as "nothing to revert".
const EMPTY_BY_ACTION = {
  [fixes.ACTION]: { arena: null, headway: [], advion: null },
  [round2.ACTION]: { updates: [] },
  [round2.CATALOG_ACTION]: { limits: [] },
  [round3.ACTION]: { changes: [] },
  [round3.CATALOG_ACTION]: { headway: null },
  [round4.ACTION]: { approved: [] },
  [round5.ACTION]: { change: null },
  [round5.CATALOG_ACTION]: { approved: [] },
  [round6.ACTION]: { rowIds: [] },
  [round6.CATALOG_ACTION]: { productId: null },
};

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await anyV13ProtocolReferenced(knex))) return;
  const changed = await neutralizeAuditRows(knex, EMPTY_BY_ACTION);
  console.log(`[lawn-v13-matrix-adds-round7] a visit or completion references 2026.10-v13: ${changed} earlier rollback entries kept as they are; protocol and catalog facts stay`);
};

exports.EMPTY_BY_ACTION = EMPTY_BY_ACTION;
