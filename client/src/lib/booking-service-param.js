// Reads the /book `?service=` query param. Links built by the marketing site
// use website slugs (`mosquito-control`), not the booking catalog ids
// (`mosquito`); a part that matched nothing used to fall through to Pest
// Control, so a mosquito lead was shown (and, on an estimate link, locked
// into) the wrong service. Pure and network-free.

// Website / marketing names -> catalog id. Keys are the lowercase, hyphenated
// form (see slugify). Exact catalog ids need no entry: the generic
// hyphen -> underscore try below covers `pest_control`, `bora-care`, etc.
export const SERVICE_PARAM_ALIASES = Object.freeze({
  'pest-control': 'pest_control',
  'lawn-care': 'lawn_care',
  'mosquito-control': 'mosquito',
  'tree-shrub': 'tree_shrub',
  'tree-and-shrub': 'tree_shrub',
  'tree-shrub-care': 'tree_shrub',
  'termite-control': 'termite',
  'termite-inspection': 'termite',
  'rodent-control': 'rodent',
  'bora-care': 'bora_care',
});

export const MAX_BOOKING_SERVICES = 3;

// "Mosquito Control", "mosquito_control", " MOSQUITO-CONTROL " -> "mosquito-control"
function slugify(part) {
  return String(part ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// One `?service=` part -> a catalog id from `validIds`, or null.
export function normalizeServiceId(part, validIds) {
  const valid = new Set(validIds);
  const slug = slugify(part);
  if (!slug) return null;
  const candidates = [
    String(part).trim(), // exact id, untouched
    slug.replace(/-/g, '_'), // generic hyphen -> underscore
    SERVICE_PARAM_ALIASES[slug],
  ];
  return candidates.find((id) => id && valid.has(id)) || null;
}

// The whole param (`a`, or composite `a+b+c`) -> deduped catalog ids, capped
// at 3. Unknown parts drop. [] when nothing is readable.
export function parseServiceParam(param, validIds) {
  if (param == null) return [];
  const ids = String(param).split('+')
    .map((part) => normalizeServiceId(part, validIds))
    .filter(Boolean);
  return [...new Set(ids)].slice(0, MAX_BOOKING_SERVICES);
}
