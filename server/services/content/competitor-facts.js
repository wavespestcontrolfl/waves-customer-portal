/**
 * competitor-facts.js — the ONLY place a competitor business may be NAMED in
 * autonomously generated content.
 *
 * The autonomous writer can anchor a buyer's-guide post on a <ComparisonTable>
 * "listicle" (see agents/writer-agent-config.js). Two modes:
 *   - CATEGORY mode (always allowed): compares provider CATEGORIES
 *     ("National chain" / "Local SWFL company" / "DIY") on neutral buying
 *     criteria. Names no real business — zero verification/legal surface.
 *   - NAMED-COMPETITOR mode (gated): names real competitors. To stay honest
 *     and legally safe, a competitor may be named ONLY if it appears in
 *     COMPETITORS below (comparison-table-gate.js enforces the allowlist, the
 *     attribution requirement, and the no-disparagement / no-rigged-ranking
 *     rules). An autonomous blog publishes unattended only when every name is
 *     on OWNER_APPROVED_AUTOPUBLISH_IDS; other lanes route to human review.
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
    // "Terminix Global Holdings" is the parent company's real legal name
    // (curated alias, not suffix-stripped — #5146 r9: stripping generic
    // words like "Global"/"Holdings" off an unrecognized name can misread an
    // unrelated company as an approved one, so only true legal-entity
    // suffixes are stripped; a genuine variant belongs here instead).
    aliases: ['terminix pest control', 'terminix global holdings'],
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
    // Case-sensitive bare brand (owner ruling 2026-09-27 D2 names it
    // "Turner", and intercept copy uses the short form): "Turner" /
    // "TURNER" only — never a lowercase word.
    aliasesCS: ['Turner'],
    // Link destinations: "turnerpest" (turnerpest.com, /turnerpest/) is
    // specific; bare "turner" is a surname / common noun ("/tina-turner/",
    // "compost-turner"), so it counts only in a pest-context URL (#5146 r8).
    urlAliases: ['turnerpest'],
    urlAliasesInContext: ['turner'],
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
    // TAEXX is HomeTeam's tubes-in-the-wall product name, sold under the
    // brand (owner ruling 2026-09-27, D2: "HomeTeam (also sold as TAEXX)").
    aliases: ['hometeam pest', 'home team pest defense', 'taexx'], // not bare case-insensitive 'hometeam'
    // Case-sensitive bare brand: "HomeTeam" / "HOMETEAM" name the company;
    // lowercase "hometeam" / "home team" stay ordinary prose.
    aliasesCS: ['HomeTeam'],
    // Link destinations lowercase their slugs ("/providers/hometeam"): the
    // bare brand matches case-insensitively in URL tokens ONLY, and only in
    // a pest-context URL ("hometeam" is also a sports word).
    urlAliasesInContext: ['hometeam'],
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
  {
    // Promoted from COMPETITOR_BRAND_SIGNALS 2026-07-28 (owner GO on the
    // named-competitor lawn lane): the two TruGreen intercepts (B2/D1) died
    // on gates precisely because TruGreen had no curated record — no
    // sourced facts to compare with and trugreen.com absent from the
    // curated citation hosts.
    id: 'trugreen',
    name: 'TruGreen',
    aliases: ['trugreen lawn care', 'tru green'],
    attributes: {
      // Deliberately neutral — no market-share/"#1" language: the comparison
      // gate rejects ranking tokens even when they quote a curated value.
      reach: { value: 'National (US)', source: 'https://www.trugreen.com/why-choose-trugreen/professional-lawn-care', asOf: '2026-07-28' },
      residential_recurring: { value: 'Yes — annual residential lawn plans (TruPro / TruCore / TruBasic tiers)', source: 'https://www.trugreen.com/why-choose-trugreen/professional-lawn-care', asOf: '2026-07-28' },
      guarantee: { value: 'Healthy Lawn Guarantee — "we\'ll gladly visit your property as often as needed between scheduled visits to make any necessary adjustments and to ensure your satisfaction"; site footnote: "Guarantee applies to full program customers only"', source: 'https://www.trugreen.com/why-choose-trugreen/professional-lawn-care', asOf: '2026-07-28' },
    },
  },
  {
    // Owner ruling 2026-09-28 added Aptive to the unattended list (it was a
    // detection-only signal before). Official host is aptivepestcontrol.com
    // (goaptive.com is the company's older domain) — NOT aptive.com, which
    // is an unrelated software company. Both values verified against
    // aptivepestcontrol.com on 2026-09-28 (WebFetch): "Aptive provides
    // residential pest control services in 6,000+ cities across 37 states"
    // and "Aptive schedules recurring services during the year based on the
    // service plan you select" (/pest-control/). Nothing else is curated.
    id: 'aptive',
    name: 'Aptive Environmental',
    aliases: ['aptive', 'aptive pest control', 'aptive environmental llc'],
    // The company's official domains (verified 2026-09-28). Never aptive.com.
    hosts: ['aptivepestcontrol.com', 'goaptive.com'],
    // Link-path tokens: the older goaptive.com host tokenizes to "goaptive".
    urlAliases: ['goaptive'],
    attributes: {
      reach: { value: 'Multi-state (37 US states, per the company)', source: 'https://aptivepestcontrol.com/', asOf: '2026-09-28' },
      residential_recurring: { value: 'Yes — recurring residential plans', source: 'https://aptivepestcontrol.com/pest-control/', asOf: '2026-09-28' },
    },
  },
];

// Competitors the owner approved for UNATTENDED blog publishing (owner
// rulings 2026-09-27 D2 + 2026-09-28: comparison/alternatives blog posts may
// name Orkin, Terminix, HomeTeam (also sold as TAEXX), Turner, Massey and
// TruGreen and publish with no human sign-off; Aptive and Truly Nolen added
// 2026-09-28 ~07:05Z). A draft naming ANY other
// business — including a COMPETITORS record not listed here, or a name only
// an operator brief authorized — does not autopublish; naming anyone else
// needs a new owner ruling. Ids, not display names, so every alias of an
// approved record resolves through findCompetitor().
const OWNER_APPROVED_AUTOPUBLISH_IDS = Object.freeze([
  'orkin', 'terminix', 'hometeam-pest-defense', 'turner-pest', 'massey-services', 'trugreen',
  'aptive', 'truly-nolen',
]);

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
  'Hawx',
  'Catseye',
  // Suffix-less lawn/mosquito franchise brands — no pest-industry suffix, so
  // the comparison gate's provider-name shape can't catch them in option
  // headers; recognition must come from this curated list. ONLY unambiguous
  // brand-tokens belong here (invented words, brand-only phrases). Brands
  // built from ordinary English words ("Lawn Doctor", "Bug Out", "Moxie")
  // are deliberately ABSENT in every casing: case-insensitive matching flags
  // lowercase prose ("ask a lawn doctor"), and case-sensitive matching flags
  // title-cased headings ("Why Ants Bug Out After Rain") — four Codex rounds
  // on PR #2590 demonstrated there is no safe automatic casing rule. When
  // such a brand matters, add a full COMPETITORS record with aliasesCS (see
  // Rodent Solutions Inc above) — scoped, sourced, and always human-reviewed.
  'TruGreen',
  'Mosquito Joe',
  'Greenix',
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
  for (const a of [...(c.urlAliases || []), ...(c.urlAliasesInContext || [])]) ALLOWLIST_INDEX.set(normalize(a), c);
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

// Case-INSENSITIVE aliases honored in link-destination tokens only:
// `urlAliases` are specific on their own ("goaptive", "turnerpest");
// `urlAliasesInContext` ("turner", "hometeam") count only when the same URL
// carries pest / provider wording (URL_PEST_CONTEXT_RE) — never
// "/wiki/Tina_Turner" or "/tools/compost-turner" (#5146 r8).
const URL_ALIAS_NAMES = (() => {
  const set = new Set();
  for (const c of COMPETITORS) for (const a of c.urlAliases || []) set.add(a);
  return [...set].sort((a, b) => b.length - a.length);
})();
const URL_CONTEXT_ALIAS_NAMES = (() => {
  const set = new Set();
  for (const c of COMPETITORS) for (const a of c.urlAliasesInContext || []) set.add(a);
  return [...set].sort((a, b) => b.length - a.length);
})();
const URL_PEST_CONTEXT_RE = /\b(?:pests?|termites?|exterminat\w*|bugs?|lawns?|mosquito(?:es)?|rodents?|wildlife|providers?|compan(?:y|ies)|reviews?|alternatives?|vs|versus|plans?|pricing|cancel\w*|contracts?)\b/i;

// Trailing legal / corporate suffixes stripped (repeatedly) when an exact
// name/alias lookup misses: "Orkin, LLC", "Massey Services, Inc.",
// "HomeTeam Pest Defense, Inc." resolve to their curated record instead of
// reading as a distinct company (#5146 r7). ONLY true legal-entity suffixes
// belong here — a DESCRIPTIVE word (Services, Global, Group, Holdings, "the")
// must never be stripped: an off-list company that happens to share an
// approved short prefix ("Turner Services LLC" is not Turner Pest Control;
// "HomeTeam Services LLC" is not HomeTeam Pest Defense) would otherwise read
// as approved and bypass the owner-list restriction (#5146 r9). A genuine
// legal-name variant that needs a descriptive word (e.g. "Terminix Global
// Holdings") is a curated alias on its record instead — see COMPETITORS.
const LEGAL_SUFFIX_TOKENS = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'lp', 'llp', 'pllc']);

/** findCompetitor(name) → allowlist record | null (matches name or alias, legal suffixes ignored). */
function findCompetitor(name) {
  const key = normalize(name);
  const exact = ALLOWLIST_INDEX.get(key);
  if (exact) return exact;
  const words = key.split(' ').filter(Boolean);
  // A dotted suffix ("L.L.C.", "P.L.L.C.") normalizes to one-letter words;
  // rejoin the longest trailing run of them that spells a legal suffix.
  let run = words.length;
  while (run > 0 && words[run - 1].length === 1) run -= 1;
  for (let i = run; i < words.length - 1; i += 1) {
    const joined = words.slice(i).join('');
    if (LEGAL_SUFFIX_TOKENS.has(joined)) {
      words.splice(i, words.length - i, joined);
      break;
    }
  }
  while (words.length > 1 && LEGAL_SUFFIX_TOKENS.has(words[words.length - 1])) {
    words.pop();
    const hit = ALLOWLIST_INDEX.get(words.join(' '));
    if (hit) return hit;
  }
  return null;
}

/** isKnownCompetitor(name) → true iff `name` is on the curated allowlist. */
function isKnownCompetitor(name) {
  return findCompetitor(name) !== null;
}

/** isOwnerApprovedForAutopublish(name) → true iff `name` resolves to a record on OWNER_APPROVED_AUTOPUBLISH_IDS. */
function isOwnerApprovedForAutopublish(name) {
  const rec = findCompetitor(name);
  return Boolean(rec && OWNER_APPROVED_AUTOPUBLISH_IDS.includes(rec.id));
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
function findBusinessMentions(text, { url = false } = {}) {
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
  // `url: true` — the text is link-destination tokens: specific URL aliases
  // (urlAliases) always match; bare brand aliases that are case-sensitive
  // in prose (HomeTeam, Turner) match their lowercase slug form only in a
  // pest-context URL (urlAliasesInContext).
  const candidates = [
    ...DETECTABLE_NAMES.map((display) => ({ display, ci: true })),
    // Prose-casing aliases say nothing in a URL ("/wiki/Tina_Turner"): link
    // tokens use the URL alias lists instead.
    ...(url ? [] : DETECTABLE_NAMES_CS.map((display) => ({ display, ci: false }))),
    ...(url ? URL_ALIAS_NAMES.map((display) => ({ display, ci: true })) : []),
    ...(url && URL_PEST_CONTEXT_RE.test(haystack) ? URL_CONTEXT_ALIAS_NAMES.map((display) => ({ display, ci: true })) : []),
  ].sort((a, b) => b.display.length - a.display.length);
  for (const { display, ci } of candidates) {
    // Escape regex metachars, then let any whitespace match between words so
    // "Truly Nolen" matches "Truly  Nolen" / a line-wrapped mention too.
    const pattern = escapeRegExp(display).replace(/ /g, '\\s+');
    // Case-sensitive tokens also match their ALL-CAPS styling ("LAWN DOCTOR"
    // in an uppercased table heading is the same brand) — what stays
    // unmatched is ordinary lowercase prose ("ask a lawn doctor").
    const upperPattern = escapeRegExp(display.toUpperCase()).replace(/ /g, '\\s+');
    const re = ci
      ? new RegExp(`\\b${pattern}\\b`, 'ig')
      : new RegExp(`\\b(?:${pattern}${upperPattern !== pattern ? `|${upperPattern}` : ''})\\b`, 'g');
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
  OWNER_APPROVED_AUTOPUBLISH_IDS,
  findCompetitor,
  isKnownCompetitor,
  isOwnerApprovedForAutopublish,
  attributeValues,
  findBusinessMentions,
  listForPrompt,
  _internals: { normalize, DETECTABLE_NAMES, ALLOWLIST_INDEX },
};
