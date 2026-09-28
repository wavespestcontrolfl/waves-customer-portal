/**
 * licensed-photo-library.js — the ONLY source of photo assets a writer may
 * place in the pest / sign / look-alike slots of an identification
 * ("diagnostic" post_type) brief (C3, blog work order 2026-09-28).
 *
 * Every entry here is a REAL, licensed photo already vetted for a Waves
 * blog post — the same catalog shape and the same seven photos the B2
 * photo-accuracy pass placed on the astro site (see
 * ~/blog-engagement-research-20260926/photo-manifest.json and astro PR
 * #609/#613). This module does not generate, guess, or invent a photo for
 * a species this catalog does not carry: buildPhotoSlots() returns `photo:
 * null` for any slot with no verified match, and the writer prompt +
 * content-quality-gate's photo_slots_licensed_only check both treat that
 * as "omit this slot, flag for a human" — never a reason to fall back to
 * AI-generated art (owner rule: AI art is not allowed in an identification
 * slot, ever).
 *
 * Expanding the catalog is a deliberate, human-reviewed edit to this file
 * (or its DB-backed successor, if one is ever built) — never inferred at
 * generation time from a search or a generative model.
 */

// Each entry: `species` is the canonical display name (shared across every
// slot entry for that species); `aliases` are the phrases matched — as
// WHOLE WORDS/PHRASES via a word-boundary regex, never a bare substring —
// against the brief's topic string. `url`/`alt`/`credit`/`license`/
// `license_url`/`source_page` are the exact attribution the writer must
// reproduce verbatim (CC BY / BY-SA requires linking the license and,
// where practicable, the source — never a bare credit/license STRING with
// no link).
const PHOTO_LIBRARY = Object.freeze([
  {
    species: 'American cockroach',
    aliases: ['american cockroach', 'palmetto bug'],
    slot: 'pest',
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/bd/American_cockroach.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:American_cockroach.jpg',
    alt: 'An adult American cockroach, the large reddish-brown roach Floridians call a palmetto bug',
    license: 'CC BY-SA 2.5',
    license_url: 'https://creativecommons.org/licenses/by-sa/2.5',
    credit: 'Muhammad Mahdi Karim',
  },
  {
    species: 'huntsman spider',
    aliases: ['huntsman spider', 'florida huntsman'],
    slot: 'pest',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/84/Heteropoda_venatoria-Kadavoor-2017-05-22-001_%28cropped%29.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Heteropoda_venatoria-Kadavoor-2017-05-22-001_%28cropped%29.jpg',
    alt: 'An adult huntsman spider (Heteropoda venatoria) with its legs spread sideways, crab-style',
    license: 'CC BY-SA 4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
    credit: 'Jeevan Jose, Kerala, India',
  },
  {
    species: 'huntsman spider',
    aliases: ['huntsman spider', 'florida huntsman'],
    slot: 'look_alike',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/c8/Hogna_carolinensis_female_dorsal.jpeg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Hogna_carolinensis_female_dorsal.jpeg',
    alt: 'A female Carolina wolf spider (Hogna carolinensis): stockier body, legs held under the body, not flattened sideways',
    license: 'CC BY 4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0',
    credit: 'codystricker',
  },
  {
    species: 'fire ant',
    aliases: ['fire ant', 'red imported fire ant'],
    slot: 'pest',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant_-_Solenopsis_invicta%2C_Okaloacoochee_Slough_State_Forest%2C_Felda%2C_Florida%2C_February_6%2C_2022_%2851872217415%29.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant_-_Solenopsis_invicta,_Okaloacoochee_Slough_State_Forest,_Felda,_Florida,_February_6,_2022_%2851872217415%29.jpg',
    alt: 'Red imported fire ant workers swarming over sandy soil in Florida',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
    credit: 'Judy Gallagher',
  },
  {
    species: 'fire ant',
    aliases: ['fire ant', 'red imported fire ant'],
    slot: 'sign',
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/5b/Red_Imported_Fire_Ant_nest_-_Solenopsis_invicta%2C_Arthur_Marshall_Loxahatchee_National_Wildlife_Refuge%2C_Boynton_Beach%2C_Florida%2C_December_12%2C_2023_%2853578144030%29.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant_nest_-_Solenopsis_invicta,_Arthur_Marshall_Loxahatchee_National_Wildlife_Refuge,_Boynton_Beach,_Florida,_December_12,_2023_%2853578144030%29.jpg',
    alt: 'A red imported fire ant mound of loose sandy soil in a Florida field',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
    credit: 'Judy Gallagher',
  },
]);

const SLOTS = Object.freeze([
  { slot: 'pest', captionTemplate: (species) => `A clear, correctly identified photo of ${species ? `the ${species}` : 'the pest'} itself.` },
  { slot: 'sign', captionTemplate: (species) => `A photo of a telltale sign or piece of evidence ${species ? `the ${species}` : 'this pest'} leaves behind — not the pest itself.` },
  { slot: 'look_alike', captionTemplate: (species) => `A commonly confused look-alike ${species ? `for the ${species}` : 'species'}, shown for contrast — never presented as the real thing.` },
]);

function normalizeTopic(topic) {
  return String(topic || '').trim().toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Every distinct species the catalog carries (aliases across its slot
// entries are identical per species, so the first entry's list suffices).
const SPECIES_ALIASES = (() => {
  const bySpecies = new Map();
  for (const entry of PHOTO_LIBRARY) {
    if (!bySpecies.has(entry.species)) bySpecies.set(entry.species, entry.aliases);
  }
  return bySpecies;
})();

/**
 * matchSpecies(topic) → the ONE canonical species name whose alias matches
 * `topic` as a whole word/phrase (word-boundary regex, never a bare
 * substring — "ant" in "carpenter ant" must never match the "fire ant"
 * alias). Returns null when NO species matches, or when MORE THAN ONE
 * distinct species matches (an ambiguous multi-species topic, e.g. "wolf
 * spider vs huntsman spider" naming two catalog species, must never guess
 * which one the identification slots are about) — the caller then treats
 * every slot as unmatched rather than risk the wrong species' photo.
 */
// Codex P1 (2 rounds): the "more than one CATALOG species matched" guard
// alone missed a comparison topic naming ONE catalog species plus an
// UNCATALOGUED one ("brown recluse vs huntsman spider" — only "huntsman
// spider" is in the catalog, so it matched exactly one and would have
// filled the pest slot with the huntsman photo even when the post is
// actually about the brown recluse). Safety content can't risk presenting
// a licensed-but-wrong species as THE pest, so ANY comparison-shaped topic
// fails closed — deliberately broad (a wide connector list plus every
// specific phrasing raised in review: and/between/compared to/than/
// instead of/mistaken for/confused with/like/look-alike/difference).
// Over-flagging for a human beats a confident wrong photo; a false
// trigger just means one more slot goes to a human. This is a denylist,
// not a parser — expand it on the same evidence standard as the rest of
// this file's guardrails (a real example that slipped through), not
// preemptively for every imaginable phrasing.
const COMPARISON_RE = /\b(vs\.?|versus|or|from|not|and|between|compared\s+to|than|instead\s+of|mistaken\s+for|confused\s+with|like|look-?alikes?|difference|differences)\b/i;

function matchSpecies(topic) {
  const norm = normalizeTopic(topic);
  if (!norm) return null;
  if (COMPARISON_RE.test(norm)) return null;
  const matched = new Set();
  for (const [species, aliases] of SPECIES_ALIASES) {
    // Trailing e?s? tolerates the ordinary plural of the alias's last word
    // ("fire ants", "cockroaches") without opening the door to an unrelated
    // longer word ("fire antique" still fails the boundary check).
    const hit = aliases.some((alias) => new RegExp(`\\b${escapeRegExp(alias)}e?s?\\b`, 'i').test(norm));
    if (hit) matched.add(species);
  }
  return matched.size === 1 ? [...matched][0] : null;
}

/**
 * findPhotoForSlot(topic, slot) → the catalog entry (plain object, safe to
 * spread into a brief) matching `topic` for `slot`, or null when the
 * catalog has no verified photo for that pairing, the topic names no
 * catalog species, or it names more than one (ambiguous — see
 * matchSpecies).
 */
function findPhotoForSlot(topic, slot) {
  if (!slot) return null;
  const species = matchSpecies(topic);
  if (!species) return null;
  const entry = PHOTO_LIBRARY.find((e) => e.species === species && e.slot === slot);
  if (!entry) return null;
  const photo = { ...entry };
  delete photo.aliases;
  delete photo.slot;
  delete photo.species;
  return photo;
}

/**
 * buildPhotoSlots(topic) → the 3 required identification photo slots
 * (pest / sign / look-alike) with a caption and, when the licensed library
 * has a verified, UNAMBIGUOUS match, the photo asset. A slot with no match
 * carries `photo: null` and `flagged_for_human: true` — the writer omits
 * that slot's image entirely rather than substituting AI art (owner rule,
 * C3). The caption names the matched CANONICAL species (never the raw,
 * possibly question-shaped topic string, which reads ungrammatically —
 * e.g. "is a huntsman spider dangerous" is never interpolated verbatim).
 */
function buildPhotoSlots(topic) {
  const species = matchSpecies(topic);
  return SLOTS.map(({ slot, captionTemplate }) => {
    const entry = species ? PHOTO_LIBRARY.find((e) => e.species === species && e.slot === slot) : null;
    let photo = null;
    if (entry) {
      photo = { ...entry };
      delete photo.aliases;
      delete photo.slot;
      delete photo.species;
    }
    return {
      slot,
      caption: captionTemplate(species),
      photo,
      flagged_for_human: !photo,
    };
  });
}

// ── The ONE definition of a publishable identification-photo placement ──
// content-quality-gate (what it approves) and astro-publisher (what it
// re-hosts) both import this, so the two can never disagree about which
// placements are valid — every prior gate/publisher split on #5216 came
// from two hand-kept copies of this logic drifting. A placement is a bare
// inline markdown image `![alt](url)` or a src-only `<img src alt>` tag,
// ALONE on its own line. An <img> carrying srcset is not a match (the
// publisher re-hosts src only and would silently drop the other sources).
const STANDALONE_INLINE_IMAGE_LINE_RE = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/;
// Quote-aware attrs (a literal `>` inside alt="… > 1/4 inch" must not end
// the tag) — same shape as content-quality-gate's BOTTOM_LINE_BOX_TAG_RE.
const STANDALONE_IMG_TAG_LINE_RE = /^\s*<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>\s*$/i;

function htmlAttrValue(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(String(attrs || ''));
  return m ? (m[2] ?? m[3] ?? '') : null;
}

// → { alt, url } for a standalone licensed-photo placement, or null.
function matchStandaloneImageLine(line) {
  const inline = STANDALONE_INLINE_IMAGE_LINE_RE.exec(String(line || ''));
  if (inline) return { alt: String(inline[1] || '').trim(), url: String(inline[2] || '').trim() };
  const tag = STANDALONE_IMG_TAG_LINE_RE.exec(String(line || ''));
  if (!tag) return null;
  const attrs = tag[1] || '';
  if (htmlAttrValue(attrs, 'srcset') != null) return null;
  const src = (htmlAttrValue(attrs, 'src') || '').trim();
  if (!src) return null;
  return { alt: String(htmlAttrValue(attrs, 'alt') || '').trim(), url: src };
}

// ONE predicate for "this post is an identification post" (Codex r2 on
// #5216): the publisher's re-host / no-AI-art path, the merge-time image
// assertion and the quality gate all read post_type through here, so they
// can never disagree about which posts are exempt from the generated-image
// minimum.
function isIdentificationPost(frontmatter) {
  return String(frontmatter?.post_type || '').trim().toLowerCase() === 'diagnostic';
}

// The EXACT attribution line a licensed slot photo carries (the PHOTO
// SLOTS writer instruction): credit and license are the visible LINK TEXT,
// the source page and license deed are the link destinations. Shared by the
// quality gate so the instruction and its check cannot drift.
function photoAttributionLine(photo) {
  return `Photo: [${photo.credit}](${photo.source_page}) ([${photo.license}](${photo.license_url}))`;
}
const PHOTO_ATTRIBUTION_LINE_RE = /^\s*Photo: \[([^\]\n]+)\]\(([^)\s]+)\) \(\[([^\]\n]+)\]\(([^)\s]+)\)\)\s*$/;
// Our own committed body images (the re-hosted copies) live here.
const LOCAL_BLOG_IMAGE_PREFIX = '/images/blog/';

// Refresh grandfathering for re-hosted licensed photos (Codex r2 on #5216):
// a refresh brief carries no photo_slots, so the gate recognizes a
// preserved photo only from the LIVE previous version — a standalone local
// /images/blog/ image line immediately followed (blank lines aside) by an
// exact-form attribution line. `renderedPriorBody` must already have
// comments/code blanked (content-guardrails.blankNonRenderedMarkdown) so a
// commented-out example grants nothing. Returns one grant per occurrence:
// { url, alt, attribution, sourcePage, licenseUrl }.
function priorLicensedPhotoGrants(renderedPriorBody) {
  const lines = String(renderedPriorBody || '').split('\n');
  const grants = [];
  for (let i = 0; i < lines.length; i++) {
    const img = matchStandaloneImageLine(lines[i]);
    if (!img || !img.url.startsWith(LOCAL_BLOG_IMAGE_PREFIX)) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const attr = j < lines.length ? PHOTO_ATTRIBUTION_LINE_RE.exec(lines[j]) : null;
    if (!attr) continue;
    grants.push({ url: img.url, alt: img.alt, attribution: lines[j].trim(), sourcePage: attr[2], licenseUrl: attr[4] });
  }
  return grants;
}

module.exports = {
  PHOTO_LIBRARY,
  matchSpecies,
  findPhotoForSlot,
  buildPhotoSlots,
  matchStandaloneImageLine,
  htmlAttrValue,
  isIdentificationPost,
  photoAttributionLine,
  priorLicensedPhotoGrants,
  PHOTO_ATTRIBUTION_LINE_RE,
};
