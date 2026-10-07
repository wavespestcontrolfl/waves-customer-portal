// Products the label limits to certain grasses: what the plan, the tank sheet and the lawn closeout check a
// product against, whatever window, month, track or GATE_LAWN_V13 state the visit is in.
//
// The restriction is read from the catalog row itself, by product id (so renaming the product in inventory
// changes nothing): a row whose labeled_turf_species is a non-empty list that leaves out at least two of the
// four lawn tracks, with every track grass it leaves out named in excluded_turf_species, is limited to the
// labeled grasses. A product that is merely labeled for several grasses and excludes one (or none) is not a
// turf-only product and is never refused here. A row whose lists are empty or not that shape falls back to
// the name map below (compared normalized), the only name-keyed piece left.
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const TURF_ONLY_BY_NAME = new Map([
  // EPA 10404-94: St. Augustine and centipede only; injury on any other grass or a mixture.
  ['LESCO Atrazine 1.05% 18-0-10 56% PolyPlus OPTI45 2%Fe 0.5%Mn 0.5%Mg AS MOP', ['st_augustine', 'centipede']],
].map(([name, allowed]) => [normalize(name), allowed]));

const TRACK_GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const asList = (value) => {
  let list = value;
  if (typeof value === 'string') { try { list = JSON.parse(value); } catch { list = []; } }
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : [];
};

function allowedTurfFromFields(product) {
  const labeled = asList(product?.labeled_turf_species);
  const excluded = asList(product?.excluded_turf_species);
  const outside = TRACK_GRASSES.filter((grass) => !labeled.includes(grass));
  return labeled.length && outside.length >= 2 && outside.every((grass) => excluded.includes(grass)) ? labeled : null;
}

// product = a catalog row ({ name, labeled_turf_species, excluded_turf_species }); the allowed grasses, or null.
const allowedTurfFor = (product) => allowedTurfFromFields(product) || TURF_ONLY_BY_NAME.get(normalize(product?.name)) || null;

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

module.exports = { allowedTurfFor, allowedTurfFromFields, singleTurfFamily, TURF_ONLY_BY_NAME };
