/**
 * Visit prep reads — the read KEY: which read a stop wants, and which read a
 * finished row holds, in one vocabulary shared by the dispatcher
 * (visit-prep-read-dispatch.js), the three engines' locked claim / settle
 * rechecks and the recovery sweep.
 *
 *   'pest'               the pest read alone
 *   'plant:<subject>'    the lawn / tree & shrub read alone ('lawn' | 'tree_shrub')
 *   'combo:<subject>'    BOTH reads under one claim (visit-prep-combo-read.js)
 *
 * Owner ruling 2026-09-30: a combined Lawn & Pest visit gets both reads. A
 * stop's shape (visit-prep-plant-applicability.js stopReadShape) is
 * `{ pest, plantSubject }`; the key applies the LIVE gates to it:
 *
 *   pest part + plant part, both gates live  -> 'combo:<subject>'
 *   pest part, pest gate live                -> 'pest'   (a pest + lawn stop with
 *                                               only the pest gate live: pest alone)
 *   plant part, plant gate live              -> 'plant:<subject>' (likewise)
 *   otherwise                                -> null
 *
 * so a combo stop with one gate dark degrades to the one live engine, and a
 * stop no live engine reads has no key. Kept apart from the dispatcher so the
 * engines can recheck applicability under the stop lock without requiring it
 * (the dispatcher requires the engines).
 */
const { stopReadShape, readShapeForMembers } = require('./visit-prep-plant-applicability');

function keyForShape(shape, { pestLive, plantLive }) {
  const { pest, plantSubject } = shape || {};
  if (pest && plantSubject && pestLive && plantLive) return `combo:${plantSubject}`;
  if (pest && pestLive) return 'pest';
  if (plantSubject && plantLive) return `plant:${plantSubject}`;
  return null;
}

// The live gates, read fresh (they are cheap env/flag reads).
function liveGates() {
  const gates = require('../config/feature-gates');
  return { pestLive: !!gates.visitPrepPestReadLive(), plantLive: !!gates.visitPrepPlantReadLive() };
}

// The read the stop wants as it is now, among the live engines.
async function currentReadKey(svc, conn, live = liveGates()) {
  return keyForShape(await stopReadShape(svc, conn), live);
}

// The same, over an ALREADY-RESOLVED member set (the tech facts read).
async function currentReadKeyForMembers(memberIds, conn, live = liveGates()) {
  return keyForShape(await readShapeForMembers(memberIds, conn), live);
}

// The read a finished row holds, in the same terms: a plant read carries its
// engine marker and subject in read_result, a combo read likewise; anything
// else is a pest read (whose result lives behind read_ref).
function storedReadKey(readResult) {
  let parsed = readResult;
  if (typeof readResult === 'string') {
    try { parsed = JSON.parse(readResult); } catch { parsed = null; }
  }
  if (parsed?.engine === 'plant') return `plant:${parsed.subject_type}`;
  if (parsed?.engine === 'combo') return `combo:${parsed.subject_type}`;
  return 'pest';
}

// The engine a key names: 'pest' | 'plant' | 'combo' | null.
const engineOfKey = (key) => (key ? key.split(':')[0] : null);
const subjectOfKey = (key) => (key && key.includes(':') ? key.slice(key.indexOf(':') + 1) : null);

module.exports = {
  keyForShape, liveGates, currentReadKey, currentReadKeyForMembers, storedReadKey, engineOfKey, subjectOfKey,
};
