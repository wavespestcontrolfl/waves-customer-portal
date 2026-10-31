/**
 * GATE_TECH_START_POINTS (owner 2026-10-22): the commit-time fence for an
 * auto-dispatch move.
 *
 * A move is scored from the start points in the run's cache (candidate-slots.js
 * loadStartPoints), read once per run. A Team-tab start-address edit during the
 * run leaves that cache stale, so the claimed drive saving may no longer exist.
 * index.js hands `config.startPointFor` (a lookup over the same cache) to the
 * apply; apply.js's move guard calls assertScoredStartPoints on the move
 * transaction, after the tech-day locks, for the source technician (for an
 * unassigned visit, the one whose day its current placement was scored on,
 * `config.sourceDayTechnicianId`) and the receiving technician. Gate-aware
 * through assertStartPointUnchanged: gate off, no query.
 *
 * A caller that hands no lookup scored from the office and is not fenced.
 * The coordinates are a staff home address: never put them in an error or log.
 */
const { assertStartPointUnchanged } = require('../scheduling/tech-start-point');

const START_POINT_CHANGED = 'START_POINT_CHANGED';

const startPointChanged = () => Object.assign(
  new Error('Cannot auto-move this stop: a technician\'s start address changed after the move was scored'),
  { statusCode: 409, code: START_POINT_CHANGED, isOperational: true },
);

async function assertScoredStartPoints(trx, technicianIds, startPointFor) {
  if (typeof startPointFor !== 'function') return;
  for (const id of new Set(technicianIds.filter(Boolean).map(String))) {
    // Sequential on purpose: at most two single-row FOR SHARE reads.
    await assertStartPointUnchanged(trx, id, startPointFor(id), startPointChanged);
  }
}

// The audit reason for an apply that the fence refused, else null. Nothing was
// written (the guard runs before the first write), so the visit stays and the
// next run scores it from the new start address. A partial grouped move that
// already wrote rows stays a failure.
function startPointRefusal(err) {
  if (!err || err.code !== START_POINT_CHANGED || err.movedCount) return null;
  return {
    reason_code: START_POINT_CHANGED,
    reason_description: 'A technician\'s start address changed after the move was scored; the visit stays and the next run scores it again',
  };
}

module.exports = { START_POINT_CHANGED, startPointChanged, assertScoredStartPoints, startPointRefusal };
