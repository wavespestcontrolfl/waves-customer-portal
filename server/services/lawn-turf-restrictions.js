// Products the label limits to certain grasses, by catalog name: the one authoritative list the lawn
// closeout checks a submitted product against, whatever window, month, track or GATE_LAWN_V13 state the
// visit is in. (The staged v13 row's turfOnly gate drives the plan's own withholding; this list is what
// stops a completion that records the product anyway.) Names are compared normalized.
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const TURF_ONLY_BY_NAME = new Map([
  // EPA 10404-94: St. Augustine and centipede only; injury on any other grass or a mixture.
  ['LESCO Atrazine 1.05% 18-0-10 56% PolyPlus OPTI45 2%Fe 0.5%Mn 0.5%Mg AS MOP', ['st_augustine', 'centipede']],
].map(([name, allowed]) => [normalize(name), allowed]));

const allowedTurfFor = (productName) => TURF_ONLY_BY_NAME.get(normalize(productName)) || null;

// One grass family per free-text description, or null. Conservative on purpose: this decides whether a
// label-restricted product may go on a lawn, so a description that names more than one grass, reads as a
// mix or blend, joins grasses with a separator or a conjunction, or names none we know is NOT a single
// grass. (normalizeGrassType matches the first species it finds, so "St. Augustine / Bahia mix" reads as
// St. Augustine there; that is fine for routing a track, never for eligibility.)
const FAMILIES = [
  ['st_augustine', /augustine|floratam|palmetto|seville|bitter\s*blue|citra\s*blue|provista|captiva/],
  ['bermuda', /bermuda|celebration|tifway|tifgrand|latitude\s*36/],
  ['zoysia', /zoysia|empire|zeon|\bgeo\b|jamur|palisades/],
  ['bahia', /bahia|argentine|pensacola/],
  ['centipede', /centipede/],
  ['other', /fescue|rye|bluegrass|bentgrass|paspalum|buffalo|carpetgrass|dichondra|kikuyu/],
];
const NOT_A_SINGLE_GRASS = /[/\\,;&+]|\b(mix|mixed|mixture|blend|blended|and|with|plus|or|over|some|part|partly|combo)\b|\bx\b/;

function singleTurfFamily(text) {
  const key = String(text || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key || /^(mixed|unknown|n a|none)$/.test(key) || NOT_A_SINGLE_GRASS.test(key)) return null;
  const named = FAMILIES.filter(([, pattern]) => pattern.test(key));
  return named.length === 1 ? named[0][0] : null;
}

module.exports = { allowedTurfFor, singleTurfFamily, TURF_ONLY_BY_NAME };
