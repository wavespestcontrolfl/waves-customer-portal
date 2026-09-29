/**
 * licensed-photo-library.js — the ONLY photos a writer may place in the
 * pest / sign / look-alike slots of an identification ("diagnostic"
 * post_type) brief (C3, blog work order 2026-09-28).
 *
 * Every entry is a real, licensed photo ALREADY COMMITTED in the Astro repo
 * under public/images/ (vetted and license-checked, added by astro #613).
 * The list mirrors the Astro file src/data/lookalikePhotos.ts (look-alike
 * hubs, astro #625): the same local `src`, alt text and credit fields,
 * copied verbatim, keyed by the same species-catalog slug. Only entries
 * whose file exists on astro origin/main are listed (checked 2026-09-28
 * with `git cat-file -e origin/main:public<src>`).
 *
 * The writer embeds the LOCAL path directly. Nothing is fetched at publish
 * time: the bytes are pinned by the Astro commit that added them, so no
 * digest or revision id is needed here, and there is no remote source that
 * can change or time out under a vetted entry.
 *
 * Left out on purpose:
 *   - brown-anole: public domain with no license URL, so it cannot carry
 *     the exact attribution line (credit AND license as links) the gate
 *     requires.
 *   - the Astro "case-on-wall" photo: a household casebearer, not the
 *     catalog's bagworm (the Astro file explains it).
 *
 * This module never generates, guesses or invents a photo. A slot with no
 * library match comes back `photo: null` + flagged for a human, and the
 * writer omits it — never AI art (owner rule). Adding a photo is a
 * deliberate, reviewed edit here AND in the Astro file.
 */

// Parens in a Commons file-page URL would end a Markdown link destination
// early; the percent-encoded form is the same page.
function encodeParens(url) {
  return String(url).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// catalog_slug: the species-catalog slug (Astro speciesLookalikes.ts).
// species / aliases: the display name and the topic phrases matched as
// WHOLE words/phrases (see matchSpecies). An entry with no aliases is
// never a topic on its own (a sign photo, e.g. the fire-ant mound).
// Aliases are kept SPECIFIC: a bare "gecko" or "carpenter ant" would put
// this photo on a different species' post (tokay gecko, black carpenter
// ant). not_if lists more specific names that must not match.
// sign / look_alikes: catalog slugs whose photos fill that slot for this
// species (look-alike pairs come from the catalog's lookAlikes).
const ENTRIES = [
  {
    catalog_slug: 'ghost-ant',
    species: 'ghost ant',
    aliases: ['ghost ant'],
    src: '/images/blog/dangerous-ants-in-florida/ghost-ants.webp',
    alt: 'Ghost ants: tiny ants with dark heads and pale, see-through abdomens and legs',
    credit: 'Dr.Kalesh Sadasivan',
    source_page: 'https://commons.wikimedia.org/wiki/File:Tapinoma_melanocephalum,_Kerala,_India,_Kalesh_Sadasivan.jpg',
    license: 'CC BY-SA 3.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/3.0',
  },
  {
    catalog_slug: 'american-cockroach',
    species: 'American cockroach',
    aliases: ['american cockroach', 'palmetto bug'],
    src: '/images/blog/pest-control/can-cockroaches-play-dead/american-cockroach.webp',
    alt: 'An adult American cockroach, the large reddish-brown roach Floridians call a palmetto bug',
    credit: 'Muhammad Mahdi Karim',
    source_page: 'https://commons.wikimedia.org/wiki/File:American_cockroach.jpg',
    license: 'CC BY-SA 2.5',
    license_url: 'https://creativecommons.org/licenses/by-sa/2.5',
  },
  {
    catalog_slug: 'gecko',
    species: 'house gecko',
    aliases: ['house gecko'],
    src: '/images/blog/pest-control/lizard-faeces-swfl-guide/house-gecko.webp',
    alt: 'A tropical house gecko on a wooden wall at night',
    credit: 'Donald Hobern from Copenhagen, Denmark',
    source_page: 'https://commons.wikimedia.org/wiki/File:Hemidactylus_mabouia_(14374998150).jpg',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
  },
  {
    catalog_slug: 'huntsman-spider',
    species: 'huntsman spider',
    aliases: ['huntsman spider', 'florida huntsman'],
    look_alikes: ['wolf-spider'],
    src: '/images/blog/pest-control/florida-huntsman-spider/huntsman-adult.webp',
    alt: 'An adult huntsman spider (Heteropoda venatoria) with its legs spread sideways, crab-style',
    credit: 'Jeevan Jose, Kerala, India',
    source_page: 'https://commons.wikimedia.org/wiki/File:Heteropoda_venatoria-Kadavoor-2017-05-22-001_(cropped).jpg',
    license: 'CC BY-SA 4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
  },
  {
    catalog_slug: 'wolf-spider',
    species: 'wolf spider',
    aliases: ['wolf spider'],
    look_alikes: ['huntsman-spider'],
    src: '/images/blog/pest-control/florida-huntsman-spider/wolf-spider.webp',
    alt: 'A female Carolina wolf spider (Hogna carolinensis): stockier body, legs held under the body, not flattened sideways',
    credit: 'codystricker',
    source_page: 'https://www.inaturalist.org/photos/227529967',
    license: 'CC BY 4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0',
  },
  {
    catalog_slug: 'fire-ant',
    species: 'fire ant',
    aliases: ['fire ant', 'red imported fire ant'],
    // Other catalog fire ants must not match the bare "fire ant" alias.
    not_if: ['tropical fire ant', 'southern fire ant', 'black imported fire ant'],
    sign: 'fire-ant-mound',
    src: '/images/blog/dangerous-ants-in-florida/fire-ant-workers.webp',
    alt: 'Red imported fire ant workers swarming over sandy soil in Florida',
    credit: 'Judy Gallagher',
    source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant_-_Solenopsis_invicta,_Okaloacoochee_Slough_State_Forest,_Felda,_Florida,_February_6,_2022_(51872217415).jpg',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
  },
  {
    catalog_slug: 'fire-ant-mound',
    species: 'fire ant mound',
    aliases: [],
    src: '/images/blog/dangerous-ants-in-florida/fire-ant-mound.webp',
    alt: 'A red imported fire ant mound of loose sandy soil in a Florida field',
    credit: 'Judy Gallagher',
    source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant_nest_-_Solenopsis_invicta,_Arthur_Marshall_Loxahatchee_National_Wildlife_Refuge,_Boynton_Beach,_Florida,_December_12,_2023_(53578144030).jpg',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
  },
  {
    catalog_slug: 'carpenter-ant',
    species: 'Florida carpenter ant',
    aliases: ['florida carpenter ant'],
    src: '/images/blog/dangerous-ants-in-florida/florida-carpenter-ant.webp',
    alt: 'A Florida carpenter ant with a reddish-orange head and thorax and a black abdomen',
    credit: 'User:MrX',
    source_page: 'https://commons.wikimedia.org/wiki/File:Florida_Carpenter_ant.jpg',
    license: 'CC BY-SA 3.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/3.0',
  },
  {
    catalog_slug: 'tawny-crazy-ant',
    species: 'tawny crazy ant',
    aliases: ['tawny crazy ant'],
    src: '/images/blog/dangerous-ants-in-florida/tawny-crazy-ant.webp',
    alt: 'A tawny crazy ant worker tending pupae',
    credit: 'Insects Unlocked',
    source_page: 'https://commons.wikimedia.org/wiki/File:Nylanderia_fulva_-_Tawny_Crazy_Ant_(31569780261).jpg',
    license: 'CC0',
    license_url: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en',
  },
];

const PHOTO_LIBRARY = Object.freeze(ENTRIES.map((e) => Object.freeze({
  ...e,
  aliases: Object.freeze([...(e.aliases || [])]),
  not_if: Object.freeze([...(e.not_if || [])]),
  look_alikes: Object.freeze([...(e.look_alikes || [])]),
  source_page: encodeParens(e.source_page),
})));
const BY_SLUG = new Map(PHOTO_LIBRARY.map((e) => [e.catalog_slug, e]));
const BY_SRC = new Map(PHOTO_LIBRARY.map((e) => [e.src, e]));

// The photo object a brief slot carries (and the writer copies verbatim).
function photoOf(entry) {
  if (!entry) return null;
  const { src, alt, credit, source_page, license, license_url } = entry;
  return { src, alt, credit, source_page, license, license_url };
}

// ONE lookup for "is this a library photo": the quality gate (what it
// approves), guardrail link allowances, and the publisher's stale-image
// pass (what it must never strip) all go through here. Works the same for
// new posts, refreshes and remediation revalidation — no grants, no
// provenance.
function libraryPhotoBySrc(src) {
  return BY_SRC.get(String(src || '').trim()) || null;
}
function isLibraryPhotoSrc(src) {
  return Boolean(libraryPhotoBySrc(src));
}

const SLOTS = Object.freeze([
  { slot: 'pest', captionTemplate: (species) => `A clear, correctly identified photo of ${species ? `the ${species}` : 'the pest'} itself.` },
  { slot: 'sign', captionTemplate: (species) => `A photo of a telltale sign or piece of evidence ${species ? `the ${species}` : 'this pest'} leaves behind — not the pest itself.` },
  { slot: 'look_alike', captionTemplate: (species) => `A commonly confused look-alike ${species ? `for the ${species}` : 'species'}, shown for contrast — never presented as the real thing.` },
]);

function escapeRegExp(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Comparison-shaped topics fail closed (Codex P1, 2 rounds): "brown recluse
// vs huntsman spider" names one catalog species plus an uncatalogued one,
// and a safety post must never show a licensed-but-wrong species as THE
// pest. Deliberately broad; a false trigger only sends a slot to a human.
// These words are unambiguous comparison constructions on their own, so
// any occurrence anywhere in the topic fails it closed. Bare `like` is one
// of them ("bugs like fire ants", Codex r1 on #5272): only the terminal
// "what do X look like" identification phrase is exempt, and it is already
// stripped from comparisonTestText below before this runs (Codex r5/r7).
// Main's connector words stay UNCONDITIONAL comparison markers — and, or,
// from, not (Codex r6–r9 on #5272: every narrowing of them let a two-subject
// topic through: "fire ants and insects", "…or pests", "…and gnats",
// "this is not a fire ant"). The catalog pest count below is an extra
// check on top, never a replacement. Cost: "where do fire ants come from"
// gets no automatic photo — the slot goes to a human (fail closed).
const COMPARISON_WORDS_RE = /\b(vs\.?|versus|between|compared\s+to|than|instead\s+of|mistaken\s+for|confused\s+with|like|look-?alikes?|difference|differences|comparisons?|not|and|or|from)\b/i;
// A hyphenated "-like" suffix ("ant-like insects") is the same look-alike
// construction without the word "look" — still a comparison, not an
// identification of the named species itself.
const SUFFIX_LIKE_RE = /\w-like\b/i;

// Codex r3 on #5272 (the third round on connector words): a comparison is
// judged by COUNTING the pests a topic names, not by reading the words
// between them. Once the matched species' own names are taken out (its
// library aliases plus every catalog name/alias of that species), the topic
// must name no other pest: no generic pest noun (below) and no complete
// name or alias of any other organism in the approved species catalog
// (species-catalog.js, read on first use). "brown recluse and huntsman
// spider", "huntsman spider and daddy long legs" and "fire ants and
// no-see-ums" name two; "where do fire ants come from" and "fire ant signs
// and identification" name one. An unreadable catalog fails closed.
const PEST_NOUN_RE = /\b(ants?|roach(?:es)?|cockroach(?:es)?|spiders?|beetles?|bugs?|termites?|wasps?|bees?|hornets?|fl(?:y|ies)|moths?|mosquito(?:e?s)?|ticks?|fleas?|mites?|lizards?|geckos?|anoles?|snakes?|rodents?|rats?|mouse|mice|caterpillars?|worms?|grubs?|earwigs?|silverfish|centipedes?|millipedes?|scorpions?|weevils?|aphids?|whitefl(?:y|ies)|crickets?|grasshoppers?)\b/i;
// A name as a whole word/phrase, ordinary plural tolerated.
function namePattern(name, flags = 'i') {
  return new RegExp(`\\b${escapeRegExp(name)}(?:e?s)?\\b`, flags);
}
// undefined = not loaded yet, null = unreadable.
let catalogOrganisms;
function getCatalogOrganisms() {
  if (catalogOrganisms === undefined) {
    try {
      catalogOrganisms = require('../species-catalog').listEntries({ kind: 'organism' }).map((entry) => {
        const names = [entry.common_name, ...(entry.aliases || [])]
          .map((name) => String(name || '').trim().toLowerCase())
          .filter((name) => name.length >= 3);
        // Global patterns, compiled once: matchAll clones them, so their
        // lastIndex is never shared between scans.
        return { slug: entry.slug, names, patterns: names.map((name) => namePattern(name, 'gi')) };
      });
    } catch {
      catalogOrganisms = null;
    }
  }
  return catalogOrganisms;
}
function namesAnotherPest(text, entry) {
  const organisms = getCatalogOrganisms();
  if (!organisms) return true;
  const own = organisms.find((o) => o.slug === entry.catalog_slug);
  // Spans the matched species' own names cover (overlapping names —
  // "florida huntsman" + "huntsman spider" — merge into one covered range).
  const ownSpans = [];
  for (const name of [...(entry.aliases || []), ...(own ? own.names : [])]) {
    for (const m of text.matchAll(namePattern(name, 'gi'))) ownSpans.push([m.index, m.index + m[0].length]);
  }
  const insideOwn = (start, end) => ownSpans.some(([s, e]) => s <= start && e >= end);
  // Another organism's name counts unless it sits wholly inside one of the
  // species' own names ("carpenter ant" inside "florida carpenter ant").
  // Checked BEFORE blanking, so a longer name that CONTAINS an own alias —
  // "little fire ants" around "fire ants" — is still seen (Codex r6 on
  // #5272).
  for (const o of organisms) {
    if (o.slug === entry.catalog_slug) continue;
    for (const re of o.patterns) {
      for (const m of text.matchAll(re)) {
        if (!insideOwn(m.index, m.index + m[0].length)) return true;
      }
    }
  }
  const covered = new Array(text.length).fill(false);
  for (const [s, e] of ownSpans) covered.fill(true, s, e);
  const rest = [...text].map((ch, i) => (covered[i] ? ' ' : ch)).join('');
  return PEST_NOUN_RE.test(rest) || OTHER_ORGANISM_CLASS_RE.test(rest);
}
// "…and other insects", "…or other stinging pests": a broad class after
// "other"/"similar"/"related" is a second subject too (Codex r7 on #5272).
const OTHER_ORGANISM_CLASS_RE = /\b(?:other|similar|related|different)\s+(?:[a-z-]+\s+){0,2}?(?:insects?|pests?|arachnids?|reptiles?|amphibians?|critters?|creatures?|animals?|wildlife|vermin|invertebrates?|arthropods?|mammals?|birds?|species)\b/i;

// Codex r5 on #5216 ("Do not classify identification phrasing as
// comparison"): the `looks?\s+like` alternative above makes ordinary TERMINAL
// identification phrasing — "what do fire ants look like", optional
// trailing "?" — comparison-shaped, nulling every photo slot on the most
// common identification-post phrasing there is. Only a trailing "look(s)
// like" is stripped before the comparison test; "bugs that look like fire
// ants" and "fire ant-like insects" still have "like" mid-string and stay
// comparison-shaped (fail closed, unchanged).
// Codex r7: an ordinary place/viewing qualifier may follow ("look like in
// Florida?", "look like up close"); the qualifier itself stays in the
// comparison test, only the identification phrase is removed.
const TERMINAL_LOOKS_LIKE_RE = /\blooks?\s+like\b(?=\s*(?:\?|$|(?:in|around|near|on|at|up)\b))/i;

/**
 * matchSpecies(topic) → the ONE library entry whose alias matches `topic`
 * as a whole word/phrase, or null when none matches, more than one
 * distinct species matches, or the topic is comparison-shaped.
 */
function matchSpeciesEntry(topic) {
  const norm = String(topic || '').trim().toLowerCase();
  if (!norm) return null;
  const comparisonTestText = norm.replace(TERMINAL_LOOKS_LIKE_RE, '').trim();
  if (COMPARISON_WORDS_RE.test(comparisonTestText) || SUFFIX_LIKE_RE.test(comparisonTestText)) return null;
  const matched = new Set();
  for (const entry of PHOTO_LIBRARY) {
    // Trailing e?s? tolerates the ordinary plural ("fire ants").
    const hits = (phrases) => phrases.some((p) => new RegExp(`\\b${escapeRegExp(p)}e?s?\\b`, 'i').test(norm));
    if (hits(entry.aliases) && !hits(entry.not_if)) matched.add(entry);
  }
  // "florida carpenter ant" and "carpenter ant" are one entry; a topic
  // matching two ENTRIES is ambiguous, and so is one that names any other
  // pest besides the matched species.
  if (matched.size !== 1) return null;
  const [entry] = matched;
  return namesAnotherPest(comparisonTestText, entry) ? null : entry;
}
function matchSpecies(topic) {
  return matchSpeciesEntry(topic)?.species || null;
}

function entryForSlot(entry, slot) {
  if (!entry) return null;
  if (slot === 'pest') return entry;
  if (slot === 'sign') return entry.sign ? BY_SLUG.get(entry.sign) || null : null;
  if (slot === 'look_alike') return entry.look_alikes.map((s) => BY_SLUG.get(s)).find(Boolean) || null;
  return null;
}

/** findPhotoForSlot(topic, slot) → the slot's photo object, or null. */
function findPhotoForSlot(topic, slot) {
  return photoOf(entryForSlot(matchSpeciesEntry(topic), slot));
}

/**
 * buildPhotoSlots(topic) → the 3 identification photo slots (pest / sign /
 * look-alike). A slot with no library photo carries `photo: null` and
 * `flagged_for_human: true`; the writer omits it (never AI art). The
 * caption names the matched canonical species, never the raw topic.
 */
function buildPhotoSlots(topic) {
  const entry = matchSpeciesEntry(topic);
  return SLOTS.map(({ slot, captionTemplate }) => {
    const photo = photoOf(entryForSlot(entry, slot));
    return { slot, caption: captionTemplate(entry?.species || null), photo, flagged_for_human: !photo };
  });
}

function htmlAttrValue(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(String(attrs || ''));
  return m ? (m[2] ?? m[3] ?? '') : null;
}

// ONE predicate for "this post is an identification post": the publisher
// (no AI art), the merge-time image check (minimum exemption) and the
// quality gate all read it here. It judges the post type the publisher
// will SHIP — normalizeAutonomousBlogFrontmatter takes
// normalizePostType(post_type || page_type), exact-case — so a draft that
// names the type only as page_type: "diagnostic" is held to the same checks
// it will publish under (Codex r9 on #5216).
function isIdentificationPost(frontmatter) {
  return String(frontmatter?.post_type || frontmatter?.page_type || '').trim() === 'diagnostic';
}

// The EXACT attribution line a library photo carries: credit and license
// are the visible link TEXT; source page and license deed the destinations.
function photoAttributionLine(photo) {
  return `Photo: [${photo.credit}](${photo.source_page}) ([${photo.license}](${photo.license_url}))`;
}

// Codex r7 on #5216: an exact catalog attribution line is fixed, reviewed
// catalog text (a photographer's name, a percent-encoded Commons URL), so
// the generic syntax and customer-PII scans must not judge it — the photo
// gate already requires it verbatim. Blanked to equal-length spaces, so
// offsets and line structure are unchanged for every other rule.
function blankLibraryPhotoAttributions(text) {
  let out = String(text || '');
  for (const photo of PHOTO_LIBRARY) {
    const line = photoAttributionLine(photo);
    if (out.includes(line)) out = out.split(line).join(' '.repeat(line.length));
  }
  return out;
}

module.exports = {
  PHOTO_LIBRARY,
  matchSpecies,
  findPhotoForSlot,
  buildPhotoSlots,
  libraryPhotoBySrc,
  isLibraryPhotoSrc,
  htmlAttrValue,
  isIdentificationPost,
  photoAttributionLine,
  blankLibraryPhotoAttributions,
};
