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
const { approvalContentHash, isApproved } = require('./species-catalog-approval');

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
  // Null prototype: an input like "constructor" or "__proto__" is not a
  // legacy slug (Codex #4873 r2).
  const legacySlugMap = deepFreeze(Object.assign(Object.create(null), index.legacy_slug_map || {}));
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
  const { group, subgroup, kind, section } = filter || {};
  let list = group ? (CATALOG.entriesByGroup.get(group) || []) : Array.from(CATALOG.entries.values());
  if (subgroup) list = list.filter((e) => e.subgroup === subgroup);
  if (kind) list = list.filter((e) => e.kind === kind);
  if (section) list = list.filter((e) => sectionOf(e) === section);
  return list;
}

/**
 * The section (`'pest' | 'plant' | 'condition'`) a catalog node lives under,
 * climbing entry/subgroup → group → category the same way `lineage` does.
 * Accepts either a node object (as returned by `getNode`/`listEntries`) or a
 * bare id/slug. Returns `null` for an unknown node. A category with no
 * declared `section` (shouldn't happen post-migration, but keeps this
 * defensive rather than throwing) defaults to `'pest'` — every category this
 * catalog shipped with before the plant/condition sections existed.
 */
function sectionOf(nodeOrSlug) {
  const node = (nodeOrSlug && typeof nodeOrSlug === 'object' && nodeOrSlug.level)
    ? nodeOrSlug
    : getNode(nodeOrSlug);
  if (!node) return null;
  if (node.level === 'category') return node.section || 'pest';
  const group = node.level === 'group' ? node : getGroup(node.group);
  const category = group ? getCategory(group.category) : null;
  return category ? (category.section || 'pest') : null;
}

/**
 * Ordered ladder from category down to `id`: category → group → every
 * parent subgroup → subgroup → entry (if `id` is an entry). Each rung is
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
  if (subgroup) {
    const chain = [];
    const seen = new Set();
    for (let current = subgroup; current;) {
      if (seen.has(current.id)) throw new Error(`species-catalog: subgroup parent cycle at "${current.id}"`);
      seen.add(current.id);
      chain.unshift(current);
      const parent = current.parent ? getSubgroup(current.parent) : null;
      if (current.parent && !parent) {
        throw new Error(`species-catalog: subgroup "${current.id}" has unknown parent "${current.parent}"`);
      }
      current = parent;
    }
    for (const rung of chain) {
      if (rung.group !== group?.id) {
        throw new Error(`species-catalog: subgroup "${rung.id}" is outside group "${group?.id || ''}"`);
      }
      rungs.push({ level: 'subgroup', id: rung.id, label: rung.label, generic: rung.generic });
    }
  }
  if (entry) rungs.push({ level: 'entry', id: entry.slug, label: entry.common_name, generic: null });
  return rungs;
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
    photo_can_confirm: la.photo_can_confirm !== false,
  }));
}

// ── name resolution ──────────────────────────────────────────────────────
//
// Ported from `resolveLibraryMatch` in ./pest-identification.js. A naive
// substring check is unsafe for pest names: "walkingstick" contains "tick",
// "antenna" contains "ant". The fix is the same one the live engine uses —
// build an index of normalized names, try an exact (plural-aware) lookup
// first, then a whole-word regex scan that prefers the longest match and
// skips anything under 4 characters unless it is a curated short alias.
//
// Names resolve to the node they honestly name, at any level (Codex #4873
// r1): a group or subgroup name ("termite", "fire ants") resolves to that
// node, never to one arbitrary species in it, and a name shared by several
// entries (Apis mellifera: the swarm and the wall colony) resolves to their
// deepest common ancestor. Hyphens and spaces are the same character.

// Short aliases that are real names people use for a hazard; everything else
// under 4 characters is too likely to match inside an unrelated word.
const SHORT_ALIASES = new Set(['asp']);

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "an ant" → "ant", "a fire ant" → "fire ant": generic phrases index without
// their article.
function withoutArticle(value) {
  return normalizeName(value).replace(/^(a|an|the) /, '');
}

// Whether a nickname identifies the entry itself: it spells one of the
// entry's OWN names (the common name with or without its parenthetical, a
// name inside that parenthetical, or a scientific name — case, spaces,
// hyphens and a plural ending never matter), or it is a qualified form of
// the common name that keeps every one of its words ("tomato hornworm" for
// Hornworm). A nickname that drops or swaps words ("velvet ant" for Eastern
// Velvet Ant, "palmetto bug") can't be told apart from a name several
// species share, so it never identifies one.
function identifiesEntry(entry, name) {
  const key = (value) => normalizeName(value).replace(/ /g, '');
  const common = String(entry.common_name || '');
  const bare = common.replace(/\([^)]*\)/g, '');
  const own = [common, bare, ...(common.match(/\(([^)]*)\)/g) || []),
    ...String(entry.scientific_name || '').split('/').map((part) => part.replace(/\([^)]*\)/g, ''))]
    .map(key).filter(Boolean);
  const candidate = key(name);
  if (own.some((o) => [o, `${o}s`, `${o}es`].includes(candidate) || [candidate, `${candidate}s`, `${candidate}es`].includes(o))) {
    return true;
  }
  const words = new Set(normalizeName(name).split(' ').filter(Boolean).map(singularName));
  const commonWords = normalizeName(bare).split(' ').filter(Boolean).map(singularName);
  return commonWords.length > 0 && commonWords.every((w) => words.has(w));
}

// The deepest node every id's ladder passes through, or null when they only
// meet at a category (too broad to call a match).
function commonAncestor(ids) {
  const ladders = ids.map((id) => lineage(id).map((rung) => rung.id));
  if (ladders.some((ladder) => !ladder.length)) return null;
  let shared = null;
  for (let depth = 0; ladders.every((ladder) => depth < ladder.length); depth += 1) {
    const id = ladders[0][depth];
    if (!ladders.every((ladder) => ladder[depth] === id)) break;
    shared = id;
  }
  const node = shared ? getNode(shared) : null;
  return node && node.level !== 'category' ? shared : null;
}

function buildWholeWordIndex(pairs) {
  // pairs: [[name, nodeId], ...]. A name claimed by two or more different
  // nodes resolves to their deepest common ancestor (or is left out when they
  // only share a category); every such name is recorded in `collisions` so
  // the species-catalog test can check each one resolves somewhere sensible.
  const claims = new Map();
  for (const [name, id] of pairs) {
    const key = normalizeName(name);
    if (!key) continue;
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key).add(id);
  }
  const index = new Map();
  const collisions = [];
  for (const [key, ids] of claims) {
    const list = [...ids];
    if (list.length === 1) { index.set(key, list[0]); continue; }
    const ancestor = commonAncestor(list);
    collisions.push({ name: key, slugs: list, resolvesTo: ancestor });
    if (ancestor) index.set(key, ancestor);
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
  const variants = [
    normalized, `${normalized}s`, normalized.replace(/s$/, ''),
    normalized.replace(/ies$/, 'y'), normalized.replace(/y$/, 'ies'),
  ];
  for (const variant of variants) {
    const direct = variant && index.get(variant);
    if (direct) return direct;
  }
  return null;
}

// "flies" -> "fly", "termites" -> "termite"; "grass", "Latrodectus" and
// "cactus" stay as they are.
function singularName(name) {
  if (/[^aeiou]ies$/.test(name)) return name.replace(/ies$/, 'y');
  if (/(?:ss|us|is)$/.test(name)) return name;
  return name.replace(/s$/, '');
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
  const matches = []; // { id, via, len, start, end }
  for (const { via, index } of indexed) {
    for (const [name, id] of index.entries()) {
      if (name.length < 4 && !SHORT_ALIASES.has(name)) continue;
      // A plural name ("termites") is matched and measured by its singular,
      // so it still answers "a termite" and ties — rather than loses — to a
      // singular alias of the same word, leaving index priority to decide
      // (the group beats a species alias; Codex #4873 pre-push P1).
      const stem = singularName(name);
      // "whitefly" also matches "whiteflies"; "larva" matches "larvae".
      const pattern = stem.endsWith('larva') ? `${stem}e?`
        : /[^aeiou]y$/.test(stem) ? `${stem.slice(0, -1)}(?:y|ies)`
          : `${stem}(?:s|es)?`;
      const hit = new RegExp(`\\b${pattern}\\b`).exec(normalized);
      if (hit) matches.push({ id, via, len: stem.length, start: hit.index, end: hit.index + hit[0].length });
    }
  }
  if (!matches.length) return null;
  // Longest match wins; on a tie the earlier index in `indexed` does.
  let best = matches[0];
  for (const m of matches) if (m.len > best.len) best = m;
  // A descendant of the winner that names words the winner's own match
  // doesn't cover is the more specific claim: "brown widow spider" is the
  // brown widow, not just "widow spider" (Codex #4873 r3). A descendant
  // wholly inside the winner's span ("termite" within "termites") adds
  // nothing, so the group keeps it.
  let deeper = null;
  for (const m of matches) {
    if (m.id === best.id || (m.start >= best.start && m.end <= best.end)) continue;
    if (!lineage(m.id).some((r) => r.id === best.id)) continue;
    if (!deeper || m.len > deeper.len) deeper = m;
  }
  return deeper || best;
}

function representativeTaxonPair(name, slug) {
  const match = name.match(/^([A-Z][a-z]+ [a-z][a-z-]+) and others$/);
  return [match ? match[1] : null, slug];
}

// A bare genus names the deepest node holding EVERY catalog entry of that
// genus, computed from the entries' own scientific names — so one subgroup's
// taxon can't claim a genus that also lives elsewhere (Solenopsis: fire ants
// and the thief ant). A genus never names one species; an entry that IS the
// genus ("Phyllophaga spp.") may.
function bareGenusPairs() {
  const members = new Map();
  for (const e of CATALOG.entries.values()) {
    if (e.kind === 'sign') continue;
    for (const part of String(e.scientific_name || '').split('/')) {
      const genus = part.trim().match(/^([A-Z][a-z]+)(?: [a-z]| spp?\.?$)/);
      if (!genus) continue;
      if (!members.has(genus[1])) members.set(genus[1], new Set());
      members.get(genus[1]).add(e.slug);
    }
  }
  const pairs = [];
  for (const [genus, slugs] of members) {
    const list = [...slugs];
    const only = list.length === 1 ? getEntry(list[0]) : null;
    let target = commonAncestor(list);
    if (only) target = ['species', 'subspecies'].includes(only.rank) ? (only.subgroup || only.group) : only.slug;
    if (target) pairs.push([genus, target]);
  }
  return pairs;
}

function buildNameIndices() {
  const scientificPairs = [];
  const aliasPairs = [];
  const commonPairs = [];
  const nodePairs = [];
  for (const e of CATALOG.entries.values()) {
    // A sign's "scientific name" describes the sign ("Rattus / Mus (sign)"),
    // not a taxon, so it never answers a genus or species query — those
    // resolve to the organism (Codex #4974 r8).
    const taxonNames = e.kind === 'sign' ? '' : String(e.scientific_name || '');
    for (const part of taxonNames.split('/')) {
      // buildWholeWordIndex centrally discards blank names from every source.
      scientificPairs.push([part, e.slug]);
      // A stage annotation is still the same taxon. Index its bare binomial
      // too, so an adult and larval entry sharing one species resolve the
      // unqualified name to their common ancestor. Keep explicit stage
      // names pointed at the corresponding entry.
      const binomial = part.trim().replace(/ \((?:adult|larva|larvae|nymph)\)$/, '');
      scientificPairs.push([binomial, e.slug]);
      scientificPairs.push(...e.stages
        .filter((stage) => /^[A-Z][a-z]+ [a-z][a-z-]+$/.test(binomial) && /^(adult|larva|larvae|nymph)$/.test(stage))
        .map((stage) => [`${binomial} ${stage}`, e.slug]));
      // A grouped entry may name one representative species followed by
      // "and others". The leading binomial is still an exact taxon name.
      scientificPairs.push(representativeTaxonPair(part.trim(), e.slug));
    }
    // A nickname names THIS species only when it identifies it (see
    // identifiesEntry). Any other nickname ("palmetto bug", "tree
    // squirrel") resolves to the entry's GROUP — never a subgroup, which may
    // itself claim a risk class ("venomous snakes") the nickname never
    // established. One rule, instead of deciding species by species which
    // nicknames are specific.
    const nicknameTarget = (name) => (identifiesEntry(e, name) ? e.slug : e.group);
    for (const alias of e.aliases || []) aliasPairs.push([alias, nicknameTarget(alias)]);
    commonPairs.push([e.common_name, e.slug]);
    for (const a of e.aka || []) commonPairs.push([a, nicknameTarget(a)]);
  }
  scientificPairs.push(...bareGenusPairs());
  // Category names ("insect", "arachnid") name the category itself; a group
  // whose generic is just its category's name ("an insect") must not claim it.
  const categoryNames = new Set();
  for (const c of CATALOG.categories.values()) {
    for (const name of [c.label, c.id]) categoryNames.add(normalizeName(name));
    nodePairs.push([c.label, c.id], [c.id, c.id]);
  }
  const generic = (value) => {
    const name = withoutArticle(value);
    return categoryNames.has(name) ? null : name;
  };
  // Only a taxon ("Solenopsis", "Latrodectus mactans") indexes as a
  // scientific name — never descriptive text like "several families".
  const TAXON = /^[A-Z][a-z]+( [a-z]+)?$/;
  for (const node of [...CATALOG.groups.values(), ...CATALOG.subgroups.values()]) {
    // The shared index builder already drops blank/category-only generics.
    nodePairs.push([node.label, node.id], [node.id, node.id], [generic(node.generic), node.id]);
    for (const alias of node.aliases || []) nodePairs.push([alias, node.id]);
  }
  for (const sg of CATALOG.subgroups.values()) {
    // Species-level situation nodes must not shadow their exact entry taxon.
    // Multiple entries for that taxon already resolve to their shared ancestor.
    if (sg.rank === 'species') continue;
    const taxa = String(sg.scientific || '').split('/').map((part) => part.trim()).filter((part) => TAXON.test(part));
    for (const taxon of taxa) {
      const taxonMembers = [...CATALOG.entries.values()].filter((entry) => entry.kind !== 'sign'
        && String(entry.scientific_name || '').split('/')
          .some((name) => name.trim() === taxon || name.trim().startsWith(`${taxon} `)))
        .map((entry) => entry.slug);
      // A subgroup may contain only part of a taxon. Include every known
      // member before assigning the unqualified query to that subgroup.
      const target = commonAncestor([sg.id, ...taxonMembers]);
      if (!target) continue;
      nodePairs.push([taxon, target]);
      // An entry belonging to this same named family/genus must not
      // claim the whole taxon (for example, native vs Asian lady beetles).
      scientificPairs.push([taxon, target]);
    }
  }
  return {
    scientific: buildWholeWordIndex(scientificPairs),
    node: buildWholeWordIndex(nodePairs),
    alias: buildWholeWordIndex(aliasPairs),
    common: buildWholeWordIndex(commonPairs),
  };
}

const NAME_INDICES = buildNameIndices();
const NAME_ORDER = ['scientific', 'node', 'alias', 'common'];
const FUZZY_ORDER = ['scientific', 'common', 'node', 'alias'];

/**
 * Resolve free text (from a model, or typed by a customer) to the catalog
 * node it names — an entry, subgroup or group. A raw v1 legacy slug resolves
 * first, through the legacy map. Then an EXACT match across the indices in
 * priority order (scientific > group/subgroup names > aliases > common
 * names), then a SINGLE fuzzy scan across all of them that picks the overall
 * longest whole-word match. Returns `{ node, via: 'legacy' | 'scientific' |
 * 'node' | 'alias' | 'common' }` or `null`.
 */
function resolveName(text) {
  const rawSlug = String(text || '').trim().toLowerCase();
  if (CATALOG.legacySlugMap[rawSlug]) {
    const legacy = resolveLegacySlug(rawSlug);
    return legacy && legacy.node ? { node: legacy.node, via: 'legacy' } : null;
  }

  const normalized = normalizeName(text);
  if (!normalized) return null;

  // An entry can list phrases that name something else despite containing
  // its name ("plaster bagworm" is an indoor casebearer, not the outdoor
  // bagworm): such text never resolves to it (Codex #4974 r10).
  const allowed = (node) => !(node && Array.isArray(node.not_matches)
    && node.not_matches.some((phrase) => new RegExp(`\\b${normalizeName(phrase)}(?:s|es)?\\b`).test(normalized)));

  for (const via of NAME_ORDER) {
    const exact = exactMatch(normalized, NAME_INDICES[via].index);
    if (exact) return allowed(getNode(exact)) ? { node: getNode(exact), via } : null;
  }

  // On an equal-length fuzzy tie an entry's own common name ("drywood
  // termite") is the most specific claim and beats its group's plural
  // ("drywood termites"), while a group still beats a bare generic alias
  // on one species ("termite" on subterranean termite).
  const fuzzy = fuzzyScanAcross(normalized, FUZZY_ORDER.map((via) => ({ via, index: NAME_INDICES[via].index })));
  return fuzzy && allowed(getNode(fuzzy.id)) ? { node: getNode(fuzzy.id), via: fuzzy.via } : null;
}

/** Every name claimed by two or more nodes while building the indices, with
 * the ancestor it resolves to (null = too broad, left unresolved). Exposed
 * for the species-catalog test. */
function nameIndexCollisions() {
  return NAME_ORDER.flatMap((via) => NAME_INDICES[via].collisions.map((c) => ({ ...c, via })));
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
  sectionOf,
  lineage,
  lookAlikes,
  resolveName,
  resolveLegacySlug,
  nameIndexCollisions,
  approvalContentHash,
  isApproved,
  // Test-only escape hatch: the full merged index data, for cross-checks
  // (planned_slugs, look_alike_groups) that don't warrant their own getter.
  _index: () => readJson('index.json'),
};
