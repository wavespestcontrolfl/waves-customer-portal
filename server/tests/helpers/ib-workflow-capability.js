'use strict';

/**
 * Which dev cases cannot be scored on THIS branch, and why. A case is
 * `not_runnable` when the manifest says its target behavior needs a capability
 * that does not exist here: `requires` is an array of gap keys
 * (CAPABILITY_GAPS in fixtures/ib-workflows/execution-matrix.js). It is never
 * counted as a pass or a fail, and never skipped silently: the gap key, what is
 * missing and the owning slice are recorded in the baseline, and the case is
 * still probed with the nearest existing tool path.
 *
 * Owner-direct mode (#5563) is merged, so a card-free owner write is an
 * ordinary scored case: the harness turns GATE_IB_OWNER_DIRECT on for the
 * cases whose mode is owner_direct_on.
 *
 * When a gap lands, add its key to BUILT_GAPS; the cases that required it are
 * scored from then on, and the snapshot diff shows what changed.
 */
const { CAPABILITY_GAPS, asList } = require('../fixtures/ib-workflows/execution-matrix');

const BUILT_GAPS = new Set();

const unbuiltGaps = (c) => asList(c.requires).filter((key) => !BUILT_GAPS.has(key));

function capabilityGaps(c) {
  return unbuiltGaps(c).map((key) => {
    const gap = CAPABILITY_GAPS[key];
    if (!gap) throw new Error(`${c.id} requires ${key}, which CAPABILITY_GAPS does not define`);
    return { code: key, owner: gap.owner_pr, reason: gap.what };
  });
}

module.exports = { capabilityGaps, unbuiltGaps, BUILT_GAPS };
