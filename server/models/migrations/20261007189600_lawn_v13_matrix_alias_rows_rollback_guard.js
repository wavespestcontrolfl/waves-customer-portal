/**
 * Lawn protocol v13 matrix adds: rollback guard for 20261007189500 (pushed and frozen).
 *
 * This one writes no data (up() is empty); it exists for its down(), which runs before 189500's.
 * 189500's down() restores catalog facts and the earlier Advion limits without asking whether a v13
 * protocol is already referenced by a scheduled visit or a completion. When one is, this down()
 * rewrites 189500's audit rows so its down() finds nothing to revert (the originals are kept under
 * `keptLive`): the report approvals, the FRAC and label facts and the label limits stay. With nothing
 * referenced, nothing is rewritten and the full rollback runs. Same guard as 20261007187000.
 */
const { anyV13ProtocolReferenced, neutralizeAuditRows } = require('../../services/lawn-v13-rollback-guard');
const aliasRows = require('./20261007189500_lawn_v13_matrix_alias_rows_and_advion_limits');

// What 189500's down() reads as "nothing to revert".
const EMPTY_BY_ACTION = { [aliasRows.ACTION]: { catalog: [], limits: null } };

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await anyV13ProtocolReferenced(knex))) return;
  const changed = await neutralizeAuditRows(knex, EMPTY_BY_ACTION);
  console.log(`[lawn-v13-matrix-alias-rows-rollback-guard] a visit or completion references 2026.10-v13: ${changed} rollback entries kept as they are; catalog facts and limits stay`);
};

exports.EMPTY_BY_ACTION = EMPTY_BY_ACTION;
