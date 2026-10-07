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

module.exports = { allowedTurfFor, TURF_ONLY_BY_NAME };
