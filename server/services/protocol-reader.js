/**
 * Shared protocol reader.
 *
 * Protocols describe scope, cadence, products, preparation, and safety. They
 * never contribute dollars to an estimate; the pricing engine remains the
 * only pricing authority.
 */

const protocols = require('../config/protocols.json');

const LAWN_TRACK_ALIASES = Object.freeze({
  a: 'st_augustine',
  a_st_aug_sun: 'st_augustine',
  b: 'st_augustine',
  b_st_aug_shade: 'st_augustine',
  c1: 'bermuda',
  c1_bermuda: 'bermuda',
  c2: 'zoysia',
  c2_zoysia: 'zoysia',
  d: 'bahia',
  d_bahia: 'bahia',
  'st augustine': 'st_augustine',
});

const PROTOCOL_KEY_ALIASES = Object.freeze({
  pest: 'pest',
  pest_control: 'pest',
  one_time_pest: 'pest',
  one_time_lawn: 'lawn',
  tree: 'tree_shrub',
  tree_shrub: 'tree_shrub',
  mosquito: 'mosquito',
  one_time_mosquito: 'mosquito',
  termite: 'termite',
  termite_bait: 'termite',
  rodent: 'rodent',
  rodent_bait: 'rodent',
  palm: 'palm_injection',
  palm_injection: 'palm_injection',
  cockroach: 'cockroach',
  german_roach: 'cockroach',
  roach: 'cockroach',
  bed_bug: 'bed_bug',
  bedbug: 'bed_bug',
});

function availablePrograms() {
  return Object.keys(protocols);
}

function availableLawnTracks() {
  return Object.keys(protocols.lawn || {});
}

function normalizeLawnTrack(value) {
  const requested = String(value || '').trim().toLowerCase();
  if (!requested) return 'st_augustine';
  if (protocols.lawn?.[requested]) return requested;
  return LAWN_TRACK_ALIASES[requested] || null;
}

function normalizeProtocolKey(value) {
  const requested = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  // one_time_lawn / lawn_pest_knockdown are Agent Estimate service keys that
  // still follow the lawn protocol family — without the alias, get_protocol
  // reports "no program exists" and the required protocol review is skipped.
  if (['lawn', 'lawn_care', 'one_time_lawn', 'lawn_pest_control', 'lawn_pest_knockdown'].includes(requested)) return 'lawn';
  return PROTOCOL_KEY_ALIASES[requested] || requested || null;
}

function getProtocol({ service_type: serviceType, lawn_track: lawnTrack } = {}) {
  const key = normalizeProtocolKey(serviceType);

  if (key === 'lawn') {
    const track = normalizeLawnTrack(lawnTrack);
    if (track && protocols.lawn?.[track]) {
      return { protocol: protocols.lawn[track], track, type: 'lawn_care' };
    }
    return {
      available_tracks: availableLawnTracks(),
      note: 'Specify st_augustine, bermuda, zoysia, or bahia (legacy A/B = St. Augustine, C1 = Bermuda, C2 = Zoysia, D = Bahia).',
    };
  }

  if (key && protocols[key] && key !== 'lawn') {
    return { protocol: protocols[key], type: key };
  }

  return {
    type: serviceType || null,
    available_programs: availablePrograms(),
    note: `No "${serviceType || ''}" program in protocols.json — choose an available program.`,
  };
}

module.exports = {
  LAWN_TRACK_ALIASES,
  PROTOCOL_KEY_ALIASES,
  availableLawnTracks,
  availablePrograms,
  getProtocol,
  normalizeLawnTrack,
  normalizeProtocolKey,
};
