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
// asOf). CONSERVATIVE SCOPE: only `reach` (service area) + `residential_recurring`
// — publicly-stated, non-comparative facts. Each was verified against the
// company's own site (WebFetch) or its official site via web search on the asOf
// date, EXCEPT Terminix (terminix.com returned HTTP 403 to automated fetch on
// 2026-06-22) whose two values rest on well-established public knowledge —
// re-verify before relying on it. Richer / comparative attributes (guarantee
// terms, pricing, response time, ratings) are intentionally NOT here — add them
// only with your own verified first-party source. Local SWFL competitor list
// supplied by the owner 2026-06-22.
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
      // NOTE: not re-fetched 2026-06-22 (site returned 403); values are
      // well-established public knowledge — re-verify before relying on them.
      reach: { value: 'National (US)', source: 'https://www.terminix.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.terminix.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'truly-nolen',
    name: 'Truly Nolen',
    aliases: ['truly nolen pest control', 'truly nolen of america'],
    attributes: {
      reach: { value: 'National (US)', source: 'https://www.trulynolen.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.trulynolen.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'massey-services',
    name: 'Massey Services',
    aliases: ['massey', 'massey service'],
    attributes: {
      reach: { value: 'Regional (10 US states, incl. Florida)', source: 'https://www.masseyservices.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.masseyservices.com', asOf: '2026-06-22' },
    },
  },
  // ── Owner-supplied local / Florida competitors (06-22), verified via each
  //    company's official site (web search).
  {
    id: 'prodigy-pest',
    name: 'Prodigy Pest Solutions',
    aliases: ['prodigy pest'], // not bare 'prodigy' — too generic ("be a prodigy")
    attributes: {
      reach: { value: 'Florida (multiple markets, incl. SWFL)', source: 'https://prodigypest.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://prodigypest.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'kellers-pest',
    name: "Keller's Pest Control",
    aliases: ['kellers pest control', 'kellers pest', "keller's pest"],
    attributes: {
      reach: { value: 'Local (Southwest Florida)', source: 'https://www.kellerspestcontrol.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.kellerspestcontrol.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'all-u-need-pest',
    name: 'All U Need Pest Control',
    aliases: ['all u need pest', 'all u need pest control', 'all "u" need pest control'],
    attributes: {
      reach: { value: 'Multi-state (FL, SC, TX)', source: 'https://alluneedpest.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://alluneedpest.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'arrow-environmental',
    name: 'Arrow Environmental',
    aliases: ['arrow environmental services', 'arrow services'],
    attributes: {
      reach: { value: 'Regional (West & Central Florida)', source: 'https://www.arrowservices.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.arrowservices.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'farrow-pest',
    name: 'Farrow Pest Services',
    aliases: ['farrow pest', 'farrow pest control'],
    attributes: {
      reach: { value: 'Local (Southwest Florida)', source: 'https://farrowpestservices.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://farrowpestservices.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'rodent-solutions',
    // Use the full legal name as the canonical/detected token: the bare phrase
    // "rodent solutions" is generic ("compare rodent solutions before…"), so
    // detecting it case-insensitively would false-flag ordinary rodent copy.
    name: 'Rodent Solutions Inc',
    aliases: ['rodent solutions inc.'],
    // Case-sensitive: matches "Rodent Solutions" / "Rodent Solutions, Inc."
    // (capitalized brand) but NOT lower-case generic "rodent solutions" copy.
    aliasesCS: ['Rodent Solutions'],
    attributes: {
      reach: { value: 'Local (Southwest Florida)', source: 'https://rodentsolutioninc.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://rodentsolutioninc.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'turner-pest',
    name: 'Turner Pest Control',
    aliases: ['turner pest'],
    attributes: {
      reach: { value: 'Florida (statewide)', source: 'https://www.turnerpest.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.turnerpest.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'good-news-pest',
    name: 'Good News Pest Solutions',
    aliases: ['good news pest'],
    attributes: {
      reach: { value: 'Local (Southwest Florida)', source: 'https://www.goodnewspestsolutions.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.goodnewspestsolutions.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'hometeam-pest-defense',
    name: 'HomeTeam Pest Defense',
    aliases: ['hometeam pest', 'home team pest defense'], // not bare 'hometeam'
    attributes: {
      reach: { value: 'Multi-state (US, incl. Florida)', source: 'https://pestdefense.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://pestdefense.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'ecoshield-pest',
    name: 'EcoShield Pest Solutions',
    aliases: ['ecoshield pest', 'ecoshield'],
    attributes: {
      reach: { value: 'National (US — multi-state, incl. Florida)', source: 'https://www.ecoshieldpest.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.ecoshieldpest.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'greenhouse-pest',
    name: 'Greenhouse Termite & Pest Control',
    // not bare 'greenhouse pest' — matches generic "greenhouse pest control" copy
    aliases: ['greenhouse termite and pest control', 'greenhouse termite & pest'],
    attributes: {
      reach: { value: 'Regional (Florida West Coast — incl. Manatee/Sarasota/Charlotte)', source: 'https://mygreenhousepro.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://mygreenhousepro.com', asOf: '2026-06-22' },
    },
  },
  {
    id: 'hughes-exterminators',
    name: 'Hughes Exterminators',
    aliases: ['hughes pest control', 'hughes exterminators'], // not bare 'hughes' (surname)
    attributes: {
      reach: { value: 'Regional (Southwest Florida — Tampa Bay to Naples)', source: 'https://www.hughes-exterminators.com', asOf: '2026-06-22' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://www.hughes-exterminators.com', asOf: '2026-06-22' },
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

// name/alias → canonical competitor record (allowlist only). Includes
// `aliasesCS` (case-sensitive aliases) so findCompetitor() resolves them too.
const ALLOWLIST_INDEX = new Map();
for (const c of COMPETITORS) {
  ALLOWLIST_INDEX.set(normalize(c.name), c);
  for (const a of c.aliases || []) ALLOWLIST_INDEX.set(normalize(a), c);
  for (const a of c.aliasesCS || []) ALLOWLIST_INDEX.set(normalize(a), c);
}

// Case-INSENSITIVE detectable tokens: allowlist names/aliases + detection-only
// signals. Sorted longest-first so "Massey Services" matches before "Massey".
const DETECTABLE_NAMES = (() => {
  const set = new Set();
  for (const c of COMPETITORS) {
    set.add(c.name);
    for (const a of c.aliases || []) set.add(a);
  }
  for (const s of COMPETITOR_BRAND_SIGNALS) set.add(s);
  return [...set].sort((a, b) => b.length - a.length);
})();

// Case-SENSITIVE detectable tokens: for brand names built from otherwise-generic
// words (e.g. "Rodent Solutions") — matched only when capitalized, so ordinary
// lower-case copy ("compare rodent solutions") is NOT treated as a competitor.
const DETECTABLE_NAMES_CS = (() => {
  const set = new Set();
  for (const c of COMPETITORS) for (const a of c.aliasesCS || []) set.add(a);
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
  // Normalize curly quotes/apostrophes → straight so a stylized spelling like
  // All "U" Need or Keller's still matches the straight-quote aliases.
  const haystack = String(text || '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"');
  if (!haystack) return [];
  const out = new Map(); // key → { name, inAllowlist }
  const claimedRanges = []; // [start,end) already attributed to a longer name
  // Case-insensitive tokens + case-sensitive ones (generic-word brands), merged
  // longest-first so the longest match wins regardless of which list it came from.
  const candidates = [
    ...DETECTABLE_NAMES.map((display) => ({ display, ci: true })),
    ...DETECTABLE_NAMES_CS.map((display) => ({ display, ci: false })),
  ].sort((a, b) => b.display.length - a.display.length);
  for (const { display, ci } of candidates) {
    // Escape regex metachars, then let any whitespace match between words so
    // "Truly Nolen" matches "Truly  Nolen" / a line-wrapped mention too.
    const pattern = escapeRegExp(display).replace(/ /g, '\\s+');
    const re = new RegExp(`\\b${pattern}\\b`, ci ? 'ig' : 'g');
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
