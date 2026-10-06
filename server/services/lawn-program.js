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

// v13 is one program for every grass, still filed under the four track keys.
// A lawn whose recorded grass names none of them (mixed, unknown, free text)
// plans from this key while GATE_LAWN_V13 is live: the four copies are the same
// steps and the same safety rules, so the key changes nothing but the lookup.
// Gate off: null, and such a lawn has no track, as before. Planning only (the
// plan engine): historical readers never synthesize a track for a past visit.
const LAWN_V13_ANY_GRASS_TRACK = 'st_augustine';
function lawnV13AnyGrassTrack() {
  return featureGates.lawnV13Live?.() === true ? LAWN_V13_ANY_GRASS_TRACK : null;
}

// A protocol version that can serve a visit: the published one, or the staged
// v13 version (loaded by the migration, never active until the follow-up PR
// retires the old program) ONLY while GATE_LAWN_V13 is live. Unsetting the gate
// fails closed for a visit pinned to v13: its recipe would be the old program
// against v13 windows. Every reader that asked "status === 'active'" asks this.
// It lives here, not in the operating layer, because suites mock that module
// with partial objects.
function isServingProtocol(protocol) {
  if (protocol?.status === 'active') return true;
  return protocol?.status === 'staged' && protocol.version === LAWN_V13_VERSION && featureGates.lawnV13Live?.() === true;
}

// getProtocolWindowContext options for a live visit's own assignment: its window
// key AND its protocol key and version, so a visit pinned to an older version gets
// that version's context and never a newer version's window by key collision.
// Unpinned, those fields are null and the planning lookup picks the protocol.
function visitProtocolQuery({ serviceDate, grassTrack, scheduledService }) {
  return {
    serviceDate,
    grassTrack,
    windowKey: scheduledService?.lawn_protocol_window_key || null,
    protocolKey: scheduledService?.lawn_protocol_key || null,
    protocolVersion: scheduledService?.lawn_protocol_version || null,
    planning: true,
  };
}

// A recipe visit can carry `cadenceVariants`: { "<applications a year>": { primary } },
// the whole-lawn step a plan of that many applications runs INSTEAD of the visit's
// own step (the 12x one, also the default). v13 has one: April on the 9x plan
// (LESCO Dimension 0.21% 18-0-10 in place of the 24-0-11). This is the one
// decision of which step a visit runs; the plan, the tank sheet and the
// completion defaults all read it. `visitsPerYear` is the plan's count, or null
// when unknown: the visit keeps its own step and `unknownCadence` names the
// variant products a known plan would have used (the caller warns).
function visitForCadence(visit, visitsPerYear) {
  const variants = visit?.cadenceVariants;
  if (!variants || typeof variants !== 'object') return { visit, branch: null, unknownCadence: null };
  const variant = variants[String(Number(visitsPerYear))];
  if (visitsPerYear != null && variant) {
    return { visit: { ...visit, primary: variant.primary, ...(variant.secondary ? { secondary: variant.secondary } : {}) }, branch: String(Number(visitsPerYear)), unknownCadence: null };
  }
  if (visitsPerYear != null) return { visit, branch: null, unknownCadence: null };
  const names = Object.values(variants).flatMap((entry) => String(entry.primary || '').split('\n').map((line) => line.split(' \u2014 ')[0].trim()).filter(Boolean));
  return { visit, branch: null, unknownCadence: { variantProducts: [...new Set(names)], cadences: Object.keys(variants) } };
}

// The warning for a visit whose plan cadence is unknown (visitForCadence's
// unknownCadence): it kept the 12x step and says what a known plan would have used.
function unknownCadenceWarning(unknownCadence) {
  return {
    code: 'lawn_v13_plan_cadence_unknown', severity: 'warning',
    message: `This visit's lawn plan (applications a year) is not on file, so the plan keeps the 12x step. On a ${unknownCadence.cadences.join('x or ')}x plan, use ${unknownCadence.variantProducts.join(' or ')} instead.`,
  };
}

module.exports = { lawnProtocols, LAWN_V13_VERSION, LAWN_V13_ANY_GRASS_TRACK, lawnV13AnyGrassTrack, isServingProtocol, visitProtocolQuery, visitForCadence, unknownCadenceWarning };
