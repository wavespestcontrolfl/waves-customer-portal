/**
 * Species Catalog v1 loader (PR-1 of the Waves photo ID v2 upgrade).
 *
 * Pure, synchronous, read-only data access over
 * `server/data/species-catalog-v1/`. Nothing in this module has a runtime
 * caller yet — no route, no gate, no change to existing behavior. It exists
 * so PR-1 can be reviewed and merged as data + pure code while later PRs
 * (the photo ID v2 runtime) build on top of it.
 *
 * Loading is a straight merge of `index.json` (categories, groups,
 * subgroups, look-alike-group notes, the v1→v2 legacy slug map, and the
 * cross-worker `planned_slugs` placeholder list) plus every
 * `entries/<group>.json` file (each a flat array of entries belonging to
 * that group). A later PR can add new `entries/*.json` files, or append to
 * an existing one, without touching this loader — see docs/photo-id/
 * species-catalog.md for the "how to add a species" walkthrough.
 *
 * Every object handed back — categories, groups, subgroups, entries — is
 * deep-frozen the moment it is loaded, so a caller cannot mutate shared
 * catalog state. Every node also gets a `level` field injected at load time
 * (`'category' | 'group' | 'subgroup' | 'entry'`) so a bare node handed back
 * from `getNode`/`resolveName`/etc. can self-report what it is, without the
 * caller needing to know which internal map it came from.
 *
 * `resolveName` ports the whole-word, plural-aware, longest-alias-wins
 * matching approach `resolveLibraryMatch` uses in
 * `./pest-identification.js` (the live v1 engine) — see the comment on
 * `buildWholeWordIndex` below for why a naive substring check is unsafe
 * ("walkingstick" must never resolve as a tick; "antenna" must never
 * resolve as an ant).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'species-catalog-v1');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return value;
}

function readJson(relPath) {
  const full = path.join(DATA_DIR, relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function loadCatalog() {
  const index = readJson('index.json');

  const categories = new Map();
  for (const [id, cat] of Object.entries(index.categories || {})) {
    categories.set(id, deepFreeze(Object.assign({}, cat, { level: 'category' })));
  }

  const groups = new Map();
  for (const g of index.groups || []) {
    groups.set(g.id, deepFreeze(Object.assign({}, g, { level: 'group' })));
  }

  const subgroups = new Map();
  for (const sg of index.subgroups || []) {
    subgroups.set(sg.id, deepFreeze(Object.assign({}, sg, { level: 'subgroup' })));
  }

  const entriesDir = path.join(DATA_DIR, 'entries');
  const entries = new Map();
  const entriesByGroup = new Map();
  let entryFiles = [];
  try {
    entryFiles = fs.readdirSync(entriesDir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const file of entryFiles) {
    const arr = JSON.parse(fs.readFileSync(path.join(entriesDir, file), 'utf8'));
    for (const e of arr) {
      if (entries.has(e.slug)) {
        throw new Error(`species-catalog: duplicate entry slug "${e.slug}" (in ${file})`);
      }
      const frozen = deepFreeze(Object.assign({}, e, { level: 'entry' }));
      entries.set(e.slug, frozen);
      if (!entriesByGroup.has(e.group)) entriesByGroup.set(e.group, []);
      entriesByGroup.get(e.group).push(frozen);
    }
  }
  for (const list of entriesByGroup.values()) deepFreeze(list);

  const lookAlikeGroups = deepFreeze((index.look_alike_groups || []).map((g) => Object.assign({}, g)));
  const legacySlugMap = deepFreeze(Object.assign({}, index.legacy_slug_map || {}));
  const plannedSlugs = deepFreeze((index.planned_slugs || []).slice());

  return {
    catalogVersion: index.catalog_version,
    section: index.section,
    categories,
    groups,
    subgroups,
    entries,
    entriesByGroup,
    lookAlikeGroups,
    legacySlugMap,
    plannedSlugs,
  };
}

const CATALOG = loadCatalog();

const CATALOG_VERSION = CATALOG.catalogVersion;

// ── plain getters ───────────────────────────────────────────────────────

function getEntry(slug) {
  return CATALOG.entries.get(slug) || null;
}

function getGroup(id) {
  return CATALOG.groups.get(id) || null;
}

function getSubgroup(id) {
  return CATALOG.subgroups.get(id) || null;
}

function getCategory(id) {
  return CATALOG.categories.get(id) || null;
}

/** Any node — category, group, subgroup, or entry — by id/slug. Category
 * ids (`insect`, `arachnid`, …), group/subgroup ids, and entry slugs are
 * disjoint curated namespaces (see index.json), so checking them in any
 * order is safe. */
function getNode(id) {
  return getGroup(id) || getSubgroup(id) || getEntry(id) || getCategory(id) || null;
}

function listEntries(filter = {}) {
  const { group, subgroup, kind } = filter || {};
  let list = group ? (CATALOG.entriesByGroup.get(group) || []) : Array.from(CATALOG.entries.values());
  if (subgroup) list = list.filter((e) => e.subgroup === subgroup);
  if (kind) list = list.filter((e) => e.kind === kind);
  return list;
}

/**
 * Ordered ladder from category down to `id`: category → group → subgroup
 * (if any) → entry (if `id` is an entry). Each rung is
 * `{ level, id, label, generic }`. Returns [] if `id` is unknown.
 */
function lineage(id) {
  const node = getNode(id);
  if (!node) return [];

  if (node.level === 'category') {
    return [{ level: 'category', id: node.id, label: node.label, generic: node.generic }];
  }

  let group = null;
  let subgroup = null;
  let entry = null;

  if (node.level === 'group') {
    group = node;
  } else if (node.level === 'subgroup') {
    subgroup = node;
    group = getGroup(node.group);
  } else {
    entry = node;
    if (node.subgroup) subgroup = getSubgroup(node.subgroup);
    group = getGroup(node.group);
  }

  const rungs = [];
  if (group) {
    const category = getCategory(group.category);
    if (category) rungs.push({ level: 'category', id: category.id, label: category.label, generic: category.generic });
    rungs.push({ level: 'group', id: group.id, label: group.label, generic: group.generic });
  }
  if (subgroup) rungs.push({ level: 'subgroup', id: subgroup.id, label: subgroup.label, generic: subgroup.generic });
  if (entry) rungs.push({ level: 'entry', id: entry.slug, label: entry.common_name, generic: null });
  return rungs;
}

/**
 * The one photo that would narrow this node further.
 * Groups and subgroups carry their own `next_photo` (authored in
 * index.json). An entry has no top-level `next_photo` in the BRIEF schema —
 * its closest equivalent is the `next_photo` on its first look-alike pair,
 * which is what this falls back to. Returns null if neither is available.
 */
function nextPhoto(id) {
  const node = getNode(id);
  if (!node) return null;
  if (node.next_photo) return node.next_photo;
  if (node.level === 'entry' && Array.isArray(node.look_alikes) && node.look_alikes[0]) {
    return { ask: node.look_alikes[0].next_photo, why: node.look_alikes[0].difference || null };
  }
  return null;
}

/**
 * Entries this entry is commonly confused with, resolved to their catalog
 * node where one exists yet (a look-alike may point at a `planned_slugs`
 * placeholder another owner has not built in this batch — see
 * index.json#planned_slugs and the "cross-worker slugs" note in the test).
 */
function lookAlikes(slug) {
  const entry = getEntry(slug);
  if (!entry) return [];
  return (entry.look_alikes || []).map((la) => ({
    slug: la.slug,
    node: getNode(la.slug),
    difference: la.difference,
    next_photo: la.next_photo,
  }));
}

// ── name resolution ──────────────────────────────────────────────────────
//
// Ported from `resolveLibraryMatch` in ./pest-identification.js. A naive
// substring check is unsafe for pest names: "walkingstick" contains "tick",
// "antenna" contains "ant". The fix is the same one the live engine uses —
// build an index of normalized names, try an exact (plural-aware) lookup
// first, then a whole-word regex scan that prefers the longest match and
// skips anything under 4 characters (too likely to false-positive as a
// substring of an unrelated word).

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWholeWordIndex(pairs) {
  // pairs: [[name, slug], ...]. Later entries do not overwrite earlier ones
  // for exact-match purposes, but every collision is recorded so a caller
  // (the species-catalog test) can flag "alias maps to two different
  // entries" instead of silently picking one.
  const index = new Map();
  const collisions = [];
  for (const [name, slug] of pairs) {
    const key = normalizeName(name);
    if (!key) continue;
    if (index.has(key) && index.get(key) !== slug) {
      collisions.push({ name: key, slugs: [index.get(key), slug] });
      continue;
    }
    index.set(key, slug);
  }
  return { index, collisions };
}

// An exact (plural-aware) match against a whole normalized name — no regex
// scan, so this is the highest-confidence hit and must be tried across
// every index before any index's fuzzy whole-word scan runs. Otherwise a
// short alias's fuzzy match (e.g. "honey bee" inside "honey bee wall
// colony") would win over another entry's exact common-name match, purely
// because its index happened to be checked first (Codex r1 P1).
function exactMatch(normalized, index) {
  const variants = [normalized, `${normalized}s`, normalized.replace(/s$/, '')];
  for (const variant of variants) {
    const direct = variant && index.get(variant);
    if (direct) return direct;
  }
  return null;
}

// Fuzzy (whole-word substring) scan across MULTIPLE indices at once,
// returning the single longest match overall — never the first index's
// best match regardless of length. A longer, more specific name (an exact
// common name in one index) must beat a shorter one (a generic alias in
// another index) that merely happens to be a substring of it, even when
// the shorter name's index would otherwise be checked first (Codex r2 P1,
// following r1's identical bug one level up in exactMatch priority).
// `indexed` is `[{ via, index }, ...]` in priority order, used only as a
// tie-break when two matches are the same length.
function fuzzyScanAcross(normalized, indexed) {
  let best = null; // { slug, via, len }
  for (const { via, index } of indexed) {
    for (const [name, slug] of index.entries()) {
      if (name.length < 4) continue;
      if (best && name.length <= best.len) continue;
      const pluralSuffix = name.endsWith('larva') ? 'e?' : '(?:s|es)?';
      if (new RegExp(`\\b${name}${pluralSuffix}\\b`).test(normalized)) {
        best = { slug, via, len: name.length };
      }
    }
  }
  return best;
}

function buildNameIndices() {
  const scientificPairs = [];
  const aliasPairs = [];
  const commonPairs = [];
  for (const e of CATALOG.entries.values()) {
    for (const part of String(e.scientific_name || '').split('/')) {
      scientificPairs.push([part, e.slug]);
    }
    for (const alias of e.aliases || []) aliasPairs.push([alias, e.slug]);
    commonPairs.push([e.common_name, e.slug]);
    for (const a of e.aka || []) commonPairs.push([a, e.slug]);
  }
  return {
    scientific: buildWholeWordIndex(scientificPairs),
    alias: buildWholeWordIndex(aliasPairs),
    common: buildWholeWordIndex(commonPairs),
  };
}

const NAME_INDICES = buildNameIndices();

/**
 * Resolve free text (from a model, or typed by a customer) to a catalog
 * entry. Priority is scientific > alias > common name, but within that an
 * EXACT match always wins over a fuzzy (whole-word substring) match from a
 * lower-priority index — an exact common-name match for "Honey Bee (wall
 * colony)" must not lose to the shorter "honey bee" alias fuzzy-matching
 * inside it. So this tries an exact match against all three indices first
 * (priority order breaks a same-string tie), then a SINGLE fuzzy scan
 * across all three indices together, which picks the overall longest
 * whole-word match rather than the first index's best match — a longer,
 * more specific common name must beat a shorter alias that happens to be
 * a substring of it, even when the alias index would otherwise be checked
 * first. Finally checks whether the raw text is itself a known v1 legacy
 * slug. Returns `{ node, via: 'scientific' | 'alias' | 'common' | 'legacy' }`
 * or `null`.
 */
function resolveName(text) {
  const normalized = normalizeName(text);
  if (!normalized) return null;

  const exactSci = exactMatch(normalized, NAME_INDICES.scientific.index);
  if (exactSci) return { node: getEntry(exactSci), via: 'scientific' };
  const exactAlias = exactMatch(normalized, NAME_INDICES.alias.index);
  if (exactAlias) return { node: getEntry(exactAlias), via: 'alias' };
  const exactCommon = exactMatch(normalized, NAME_INDICES.common.index);
  if (exactCommon) return { node: getEntry(exactCommon), via: 'common' };

  const fuzzy = fuzzyScanAcross(normalized, [
    { via: 'scientific', index: NAME_INDICES.scientific.index },
    { via: 'alias', index: NAME_INDICES.alias.index },
    { via: 'common', index: NAME_INDICES.common.index },
  ]);
  if (fuzzy) return { node: getEntry(fuzzy.slug), via: fuzzy.via };

  const rawSlug = String(text || '').trim().toLowerCase();
  if (CATALOG.legacySlugMap[rawSlug]) {
    const legacy = resolveLegacySlug(rawSlug);
    if (legacy && legacy.node) return { node: legacy.node, via: 'legacy' };
  }

  return null;
}

/** Every collision found while building the name indices (an alias/common
 * name that would otherwise resolve to two different entries). Exposed for
 * the species-catalog test; empty in a healthy catalog. */
function nameIndexCollisions() {
  return NAME_INDICES.scientific.collisions
    .concat(NAME_INDICES.alias.collisions)
    .concat(NAME_INDICES.common.collisions);
}

/**
 * Resolve a v1 `PEST_LIBRARY` slug (`./pest-identification.js`) to its v2
 * catalog node. Returns `{ node, note }` (node may be `null` — see the
 * "beneficial" entry in index.json#legacy_slug_map) or `null` if `v1Slug`
 * is not a recognized legacy slug at all.
 */
function resolveLegacySlug(v1Slug) {
  const mapped = CATALOG.legacySlugMap[v1Slug];
  if (!mapped) return null;
  return { node: mapped.node ? getNode(mapped.node) : null, note: mapped.note || '' };
}

module.exports = {
  CATALOG_VERSION,
  getEntry,
  getGroup,
  getSubgroup,
  getCategory,
  getNode,
  listEntries,
  lineage,
  nextPhoto,
  lookAlikes,
  resolveName,
  resolveLegacySlug,
  nameIndexCollisions,
  // Test-only escape hatch: the full merged index data, for cross-checks
  // (planned_slugs, look_alike_groups) that don't warrant their own getter.
  _index: () => readJson('index.json'),
};
