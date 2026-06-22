/**
 * competitor-facts.js — the ONLY place a competitor business may be NAMED in
 * autonomously generated content.
 *
 * The autonomous writer can anchor a buyer's-guide post on a <ComparisonTable>
 * "listicle" (see agents/writer-agent-config.js). Two modes:
 *   - CATEGORY mode (always allowed): compares provider CATEGORIES
 *     ("National chain" / "Local SWFL company" / "DIY") on neutral buying
 *     criteria. Names no real business — zero verification/legal surface.
 *   - NAMED-COMPETITOR mode (gated + always human-reviewed): names real
 *     competitors. To stay honest and legally safe, a competitor may be named
 *     ONLY if it appears in COMPETITORS below, and the post is ALWAYS routed to
 *     human review before it can publish (comparison-table-gate.js enforces the
 *     allowlist, the attribution requirement, and the no-disparagement /
 *     no-rigged-ranking rules).
 *
 * MAINTENANCE (owner): this is a hand-curated, first-party reference — like
 * gbp-reviews.json. Only NEUTRAL, PUBLICLY-VERIFIABLE, NON-COMPARATIVE
 * attributes belong here, each with a `source` URL and an `asOf` date. Do NOT
 * add subjective or derogatory attributes ("slower", "overpriced", "worse") —
 * a comparison states facts and lets the reader conclude. Stale or
 * unverifiable facts are a legal liability; remove anything you can't stand
 * behind. Expand `attributes` as you verify more; thin-and-true beats
 * rich-and-fabricated.
 *
 * Pure data + string helpers. No I/O.
 */

// Curated allowlist. A competitor here MAY be named in a comparison table; the
// writer may state ONLY the attributes listed (each carries its own source +
// asOf). Seeded with widely-published, non-comparative facts; owner extends.
const COMPETITORS = [
  {
    id: 'orkin',
    name: 'Orkin',
    aliases: ['orkin pest control'],
    attributes: {
      reach: { value: 'National (US)', source: 'https://www.orkin.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.orkin.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'terminix',
    name: 'Terminix',
    aliases: ['terminix pest control'],
    attributes: {
      reach: { value: 'National (US)', source: 'https://www.terminix.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.terminix.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'truly-nolen',
    name: 'Truly Nolen',
    aliases: ['truly nolen pest control', 'truly nolen of america'],
    attributes: {
      reach: { value: 'National (US); Florida-founded', source: 'https://www.trulynolen.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.trulynolen.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'massey-services',
    name: 'Massey Services',
    aliases: ['massey', 'massey service'],
    attributes: {
      reach: { value: 'Regional (Southeast US)', source: 'https://www.masseyservices.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.masseyservices.com', asOf: '2026-06-22' },
    },
  },
];

// Detection-only list of pest-control BUSINESS names that may plausibly appear
// in a draft. Used purely to recognize that "a real business is being named"
// so the gate can require it to be on the allowlist above. A name here that is
// NOT in COMPETITORS is an UNKNOWN competitor (no curated/sourced facts) and
// the gate blocks it — the writer must use a provider CATEGORY instead, or the
// owner must add it to COMPETITORS with sourced attributes. This is NOT an
// endorsement or a comparison; it is a recognizer. "Waves" is deliberately
// absent (we are not our own competitor).
const COMPETITOR_BRAND_SIGNALS = [
  'Orkin',
  'Terminix',
  'Truly Nolen',
  'Massey Services',
  'Massey',
  'Hulett',
  'Hulett Environmental',
  'Arrow Exterminators',
  'Arrow Environmental',
  'Turner Pest Control',
  'Nozzle Nolen',
  'Rentokil',
  'Aptive',
  'Aptive Environmental',
  'Hawx',
  'Catseye',
];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// name/alias → canonical competitor record (allowlist only).
const ALLOWLIST_INDEX = new Map();
for (const c of COMPETITORS) {
  ALLOWLIST_INDEX.set(normalize(c.name), c);
  for (const a of c.aliases || []) ALLOWLIST_INDEX.set(normalize(a), c);
}

// Every recognizable business token (canonical display name) we can detect:
// the allowlist names/aliases plus the detection-only signals. Sorted longest
// first so "Massey Services" matches before the shorter "Massey".
const DETECTABLE_NAMES = (() => {
  const set = new Set();
  for (const c of COMPETITORS) {
    set.add(c.name);
    for (const a of c.aliases || []) set.add(a);
  }
  for (const s of COMPETITOR_BRAND_SIGNALS) set.add(s);
  return [...set].sort((a, b) => b.length - a.length);
})();

/** findCompetitor(name) → allowlist record | null (matches name or alias). */
function findCompetitor(name) {
  return ALLOWLIST_INDEX.get(normalize(name)) || null;
}

/** isKnownCompetitor(name) → true iff `name` is on the curated allowlist. */
function isKnownCompetitor(name) {
  return ALLOWLIST_INDEX.has(normalize(name));
}

/**
 * attributeValues(name) → the curated attribute value strings for a competitor
 * (e.g. ["National (US)", "Yes — recurring residential plans"]). The comparison
 * gate checks a named competitor's table cells against these so the writer can
 * only state facts that are actually curated/sourced. [] for unknown names.
 */
function attributeValues(name) {
  const rec = findCompetitor(name);
  if (!rec) return [];
  return Object.values(rec.attributes || {}).map((a) => a && a.value).filter(Boolean);
}

/**
 * findBusinessMentions(text) → [{ name, inAllowlist }]
 *
 * Detects pest-control business names mentioned in `text` (word-boundary,
 * case-insensitive), de-duplicated by the allowlist record (or canonical
 * detected name). `inAllowlist` is true when the named business has curated,
 * sourced facts and may therefore be named. A longer name shadows the shorter
 * names it contains (so "Massey Services" does not also report bare "Massey").
 */
function findBusinessMentions(text) {
  const haystack = String(text || '');
  if (!haystack) return [];
  const out = new Map(); // key → { name, inAllowlist }
  const claimedRanges = []; // [start,end) already attributed to a longer name
  for (const display of DETECTABLE_NAMES) {
    // Escape regex metachars, then let any whitespace match between words so
    // "Truly Nolen" matches "Truly  Nolen" / a line-wrapped mention too.
    const pattern = escapeRegExp(display).replace(/ /g, '\\s+');
    const re = new RegExp(`\\b${pattern}\\b`, 'ig');
    let m;
    while ((m = re.exec(haystack)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      // Skip if this span sits inside a longer, already-matched business name.
      if (claimedRanges.some(([a, b]) => a <= start && end <= b)) continue;
      claimedRanges.push([start, end]);
      const record = findCompetitor(display);
      const key = record ? record.id : normalize(display);
      if (!out.has(key)) {
        out.set(key, { name: record ? record.name : display, inAllowlist: !!record });
      }
    }
  }
  return [...out.values()];
}

/**
 * listForPrompt() → the allowlist shaped for the writer's get_competitor_facts
 * tool: each competitor with its name and the neutral attributes it may state
 * (value + source + asOf). An empty array means "no named competitors are
 * curated — use a category comparison."
 */
function listForPrompt() {
  return COMPETITORS.map((c) => ({
    name: c.name,
    attributes: Object.fromEntries(
      Object.entries(c.attributes || {}).map(([k, v]) => [k, { value: v.value, source: v.source, as_of: v.asOf }]),
    ),
  }));
}

module.exports = {
  COMPETITORS,
  COMPETITOR_BRAND_SIGNALS,
  findCompetitor,
  isKnownCompetitor,
  attributeValues,
  findBusinessMentions,
  listForPrompt,
  _internals: { normalize, DETECTABLE_NAMES, ALLOWLIST_INDEX },
};
