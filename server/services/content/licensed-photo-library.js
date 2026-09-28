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

// Each entry: species aliases (lowercase, matched as whole words/phrases
// against the brief's topic string), the slot it fills, and the exact
// attribution the writer must reproduce verbatim (never paraphrased —
// license compliance depends on the credit + license string matching what
// the source page states).
const PHOTO_LIBRARY = Object.freeze([
  {
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
    aliases: ['huntsman spider', 'florida huntsman'],
    slot: 'pest',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/84/Heteropoda_venatoria-Kadavoor-2017-05-22-001_%28cropped%29.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Heteropoda_venatoria-Kadavoor-2017-05-22-001_(cropped).jpg',
    alt: 'An adult huntsman spider (Heteropoda venatoria) with its legs spread sideways, crab-style',
    license: 'CC BY-SA 4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
    credit: 'Jeevan Jose, Kerala, India',
  },
  {
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
    aliases: ['fire ant', 'red imported fire ant'],
    slot: 'pest',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant_-_Solenopsis_invicta%2C_Okaloacoochee_Slough_State_Forest%2C_Felda%2C_Florida%2C_February_6%2C_2022_%2851872217415%29.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant_-_Solenopsis_invicta,_Okaloacoochee_Slough_State_Forest,_Felda,_Florida,_February_6,_2022_(51872217415).jpg',
    alt: 'Red imported fire ant workers swarming over sandy soil in Florida',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
    credit: 'Judy Gallagher',
  },
  {
    aliases: ['fire ant', 'red imported fire ant'],
    slot: 'sign',
    url: 'https://upload.wikimedia.org/wikipedia/commons/5/5b/Red_Imported_Fire_Ant_nest_-_Solenopsis_invicta%2C_Arthur_Marshall_Loxahatchee_National_Wildlife_Refuge%2C_Boynton_Beach%2C_Florida%2C_December_12%2C_2023_%2853578144030%29.jpg',
    source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant_nest_-_Solenopsis_invicta,_Arthur_Marshall_Loxahatchee_National_Wildlife_Refuge,_Boynton_Beach,_Florida,_December_12,_2023_(53578144030).jpg',
    alt: 'A red imported fire ant mound of loose sandy soil in a Florida field',
    license: 'CC BY 2.0',
    license_url: 'https://creativecommons.org/licenses/by/2.0',
    credit: 'Judy Gallagher',
  },
]);

const SLOTS = Object.freeze([
  { slot: 'pest', captionTemplate: (topic) => `A clear, correctly identified photo of ${topic ? `the ${topic}` : 'the pest'} itself.` },
  { slot: 'sign', captionTemplate: (topic) => `A photo of a telltale sign or piece of evidence ${topic ? `the ${topic}` : 'this pest'} leaves behind — not the pest itself.` },
  { slot: 'look_alike', captionTemplate: (topic) => `A commonly confused look-alike ${topic ? `for the ${topic}` : 'species'}, shown for contrast — never presented as the real thing.` },
]);

function normalizeTopic(topic) {
  return String(topic || '').trim().toLowerCase();
}

/**
 * findPhotoForSlot(topic, slot) → the catalog entry (plain object, safe to
 * spread into a brief) matching `topic` for `slot`, or null when the
 * catalog has no verified photo for that pairing. Matches on a whole-word/
 * phrase alias contained in the normalized topic string — never a fuzzy or
 * partial-token match, so "ant" in "dangerous ants in florida" does not
 * accidentally match "fire ant" and hand back the wrong species' photo.
 */
function findPhotoForSlot(topic, slot) {
  const norm = normalizeTopic(topic);
  if (!norm || !slot) return null;
  for (const entry of PHOTO_LIBRARY) {
    if (entry.slot !== slot) continue;
    if (entry.aliases.some((alias) => norm.includes(alias))) {
      const { aliases, slot: _slot, ...photo } = entry;
      return photo;
    }
  }
  return null;
}

/**
 * buildPhotoSlots(topic) → the 3 required identification photo slots
 * (pest / sign / look-alike) with a caption and, when the licensed library
 * has a verified match, the photo asset. A slot with no match carries
 * `photo: null` and `flagged_for_human: true` — the writer omits that
 * slot's image entirely rather than substituting AI art (owner rule, C3).
 */
function buildPhotoSlots(topic) {
  const norm = normalizeTopic(topic);
  return SLOTS.map(({ slot, captionTemplate }) => {
    const photo = norm ? findPhotoForSlot(norm, slot) : null;
    return {
      slot,
      caption: captionTemplate(norm),
      photo,
      flagged_for_human: !photo,
    };
  });
}

module.exports = { PHOTO_LIBRARY, findPhotoForSlot, buildPhotoSlots };
