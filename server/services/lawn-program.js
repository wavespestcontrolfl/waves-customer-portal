/**
 * The lawn recipe every reader shares: one place that decides which lawn
 * program the portal runs.
 *
 * GATE_LAWN_V13 off (the default) returns protocols.json `lawn`, the object
 * every reader used before. On, it returns server/config/lawn-protocol-v13.json:
 * the same four track keys (st_augustine, bermuda, zoysia, bahia) in the same
 * visit shape, each holding the one universal v13 program (owner 2026-10-05,
 * no per-grass tracks).
 *
 * Read at call time so unsetting the gate is the kill switch with no redeploy.
 * The structured (database) side of the same switch is
 * lawn-protocol-operating-layer.js getActiveLawnProtocol; both read
 * lawnV13Live().
 */
const protocols = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const featureGates = require('../config/feature-gates');

// The lawn_protocols.version the v13 rows carry (migration
// 20261005120000_lawn_protocol_v13_staged). One constant for the reader and the
// migration's test.
const LAWN_V13_VERSION = '2026.10-v13';

// `?.()`: many suites mock feature-gates with a partial object. A reader the
// mock lacks reads as off, the fail-closed answer.
function lawnProtocols() {
  return featureGates.lawnV13Live?.() ? v13 : protocols.lawn;
}

// A protocol version that can serve a visit: the published one, or the staged
// v13 version (loaded by the migration, never active until the follow-up PR
// retires the old program). Every reader that asked "status === 'active'" asks
// this. It lives here, not in the operating layer, because suites mock that
// module with partial objects.
function isServingProtocolStatus(status) {
  return status === 'active' || status === 'staged';
}

module.exports = { lawnProtocols, LAWN_V13_VERSION, isServingProtocolStatus };
