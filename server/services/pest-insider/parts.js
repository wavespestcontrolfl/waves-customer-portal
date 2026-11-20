/**
 * Waves Pest Insider part pictures (owner 2026-11-19: "if we mention things
 * like waist or antennae, features, we should show a picture"; approved
 * plan step 2, part 2).
 *
 * The rule. Each lead fact and "What's this?" species whose shown text (a
 * fact's title and lead sentences, a species' fact) has a part word
 * (PART_WORDS) has a reviewed entry in server/data/pest-insider-parts-v1.json:
 *   - parts: the parts the text names that a reader can look for, in the
 *     text's words. [] means a person read the text and it names no part to
 *     show; `why` says so in a line. A word list alone is not enough: "eight
 *     feet" is a distance, and "no stinger" cannot be shown.
 *   - an entry with parts has a picture. Each panel is a real photo (never an
 *     AI picture), cropped, with each part circled and labeled; a diagram
 *     drawn in Waves colors stands in only where no free photo shows the
 *     part. The heading, the panel names and the labels are the text's own
 *     words. Photos are CC0, CC BY or public domain only (no share-alike, no
 *     non-commercial), and the email shows a credit line under the picture.
 *   - text16 binds the review to the text a person read: the first 16 hex
 *     characters of its sha256 (textHash). When the text changes, the old
 *     review no longer counts (staleReviews), so new words get a fresh look.
 * The tests fail when a text with a part word has no entry, when an entry's
 * text changed since its review, when any entry fails its checks, or when
 * an issue that names a part would go out without its picture. At run time
 * an entry that fails its checks only loses its picture (checkParts).
 *
 * ops/agents/pest-insider-parts.js draws each picture from the photos in
 * PHOTO_DIR into PART_DIR as <id>-<hash>.jpg. The hash covers everything
 * drawn (photo bytes, crop, marks, words), so a URL never changes what it
 * shows: change the drawing -> bump PART_DESIGN.
 */
'use strict';

const crypto = require('crypto');
const data = require('../../data/pest-insider-parts-v1.json');
const { factById } = require('./facts');
const { SPECIES } = require('./plan');

/** Bump when the drawing changes (ops/agents/pest-insider-parts.js): every part picture gets a new file name. */
const PART_DESIGN = 1;
const PART_WIDTH = 582;
const PART_HEIGHT = 340;
const PART_BASE_URL = 'https://portal.wavespestcontrol.com/pest-insider/parts/';
const PART_DIR = 'client/public/pest-insider/parts';
const PHOTO_DIR = 'ops/agents/pest-insider-photos';

/**
 * A panel's size in picture pixels: one panel spans the picture; two sit side
 * by side, shorter when they carry names. Marks are in these pixels.
 */
function panelSize(count, named) {
  if (count === 1) return [566, 272];
  return named ? [279, 250] : [279, 272];
}

/** The licenses a photo may carry, with the page that states each one. */
const LICENSES = Object.freeze({
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'Public domain': null,
});
/** Where a photo may come from: its page's host and the name the credit line gives it. */
const PHOTO_SITES = Object.freeze({
  'www.inaturalist.org': 'iNaturalist',
  'commons.wikimedia.org': 'Wikimedia Commons',
});
/** Diagrams the drawer can draw, for a part no free photo shows. */
const DIAGRAMS = Object.freeze(['folded-blade']);

/**
 * Words that may name a body or plant part. A tripwire only: a text with one
 * needs a reviewed entry, and a person decides what, if anything, it shows.
 * It covers body parts and markings, plant parts, and droppings and pellets
 * (the plan's T01 and D03 cases). It leaves out what a pest builds (nest, web,
 * mud tubes) and life stages (eggs, larvae), and "back", which here means
 * "come back". Each word is matched whole, so "ear" never matches "year".
 */
const PART_WORDS = Object.freeze([
  'abdomen', 'antenna', 'antennae', 'antennas', 'bark', 'beak', 'belly', 'blade', 'blades', 'body', 'bodies',
  'branch', 'branches', 'carapace', 'claw', 'claws', 'color', 'colors', 'crown', 'crowns', 'droppings', 'ear',
  'ears', 'exoskeleton', 'eye', 'eyes', 'eyespot', 'eyespots', 'fang', 'fangs', 'feet', 'foot', 'forewing',
  'forewings', 'frond', 'fronds', 'fur', 'gill', 'gills', 'gland', 'glands', 'hair', 'hairs', 'head', 'heads',
  'hindwing', 'hindwings', 'horn', 'horns', 'hourglass', 'jaw', 'jaws', 'leaf', 'leaves', 'leg', 'legs', 'lung',
  'lungs', 'mandible', 'mandibles', 'marking', 'markings', 'mouth', 'mouthparts', 'organ', 'organs', 'pellet',
  'pellets', 'pincer', 'pincers', 'proboscis', 'root', 'roots', 'scale', 'scales', 'seed', 'seeds', 'segment',
  'segments', 'shell', 'skin', 'snout', 'spine', 'spines', 'spot', 'spots', 'stem', 'stems', 'stinger',
  'stingers', 'stripe', 'stripes', 'tail', 'tails', 'teeth', 'thorax', 'tongue', 'tooth', 'trunk', 'underside',
  'waist', 'whisker', 'whiskers', 'wing', 'wings',
]);
const WORD_RE = new RegExp(`\\b(${PART_WORDS.join('|')})\\b`, 'gi');

/** The part words in a text, lowercased, each once, in order. */
function partWordsIn(text) {
  return [...new Set((String(text).match(WORD_RE) || []).map((word) => word.toLowerCase()))];
}

// Words compared as a reader sees them: case, curly quotes and spacing aside.
const normalize = (text) => String(text).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\r\n<>]/.test(v);
/** The first 16 hex characters of a shown text's sha256: an entry's text16. */
const textHash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
const isOwnWords = (text, words, max) => isText(words, max) && normalize(text).includes(normalize(words));
const names = (text, part) => new RegExp(`\\b${normalize(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(normalize(text));
const keysOnly = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

/** The text a reader sees for a lead fact: its title and lead sentences; null for no such fact. */
function factText(id) {
  const fact = factById(id);
  return fact ? [fact.title, ...(fact.lead || [])].join(' ') : null;
}
// The "What's this?" species and the fact each one shows (plan.js SPECIES).
const SPECIES_TEXT = new Map(SPECIES.map((species) => [species.slug, species.fact]));
/** The text a reader sees for a species: its fact; null for no such species. */
const speciesText = (slug) => (SPECIES_TEXT.has(slug) ? SPECIES_TEXT.get(slug) : null);

const isInt = (v, low, high) => Number.isInteger(v) && v >= low && v <= high;
const isPoint = (p, w, h) => Array.isArray(p) && p.length === 2 && isInt(p[0], 0, w) && isInt(p[1], 0, h);

function photoProblem(file, photo) {
  if (!/^[a-z][a-z0-9-]*\.jpg$/.test(file)) return `photo ${file}: a name like termite-340864961.jpg`;
  if (!photo || typeof photo !== 'object' || Array.isArray(photo)) return `photo ${file}: not an object`;
  const extra = keysOnly(photo, ['sha16', 'source', 'license', 'author', 'subject']);
  if (extra.length) return `photo ${file}: no ${extra.join(', ')}`;
  if (!/^[0-9a-f]{16}$/.test(photo.sha16)) return `photo ${file}: sha16 is the first 16 hex characters of the file's sha256`;
  let source;
  try { source = new URL(photo.source); } catch { return `photo ${file}: source is the photo's page`; }
  if (source.protocol !== 'https:' || !Object.prototype.hasOwnProperty.call(PHOTO_SITES, source.host)) return `photo ${file}: source is an https page on ${Object.keys(PHOTO_SITES).join(' or ')}`;
  if (!Object.prototype.hasOwnProperty.call(LICENSES, photo.license)) return `photo ${file}: license is one of ${Object.keys(LICENSES).join(', ')} (no share-alike, no non-commercial)`;
  if (photo.author !== null && !isText(photo.author, 60)) return `photo ${file}: author is a name (60 characters at most) or null`;
  if (photo.license === 'CC BY 4.0' && photo.author === null) return `photo ${file}: a CC BY photo names its author`;
  if (!(typeof photo.subject === 'string' && /^[a-z][a-z -]{1,30}$/.test(photo.subject))) return `photo ${file}: subject is a few lowercase words, such as "fire ant"`;
  return null;
}

function markProblem(mark, [w, h], text) {
  if (!mark || typeof mark !== 'object' || keysOnly(mark, ['at', 'r', 'label', 'pill']).length) return 'a mark has at, r, label and pill only';
  if (!Array.isArray(mark.at) || ![1, 2].includes(mark.at.length) || !mark.at.every((p) => isPoint(p, w, h))) return `a mark's at is 1 or 2 spots [x, y] inside the ${w}x${h} panel`;
  if (!isInt(mark.r, 6, 40)) return 'a mark\'s circle r is 6 to 40 panel pixels';
  if (!isOwnWords(text, mark.label, 24)) return `the label "${mark.label}" is not the text's own words (24 characters at most)`;
  if (!isPoint(mark.pill, w, h)) return `the label "${mark.label}" sits at [x, y] inside the panel`;
  return null;
}

function photoPanelProblem(panel, size, photos) {
  if (!Object.prototype.hasOwnProperty.call(photos, panel.photo)) return `no photo ${panel.photo} in the photos list`;
  if (panel.rotate !== undefined && ![90, 180, 270].includes(panel.rotate)) return 'rotate is 90, 180 or 270';
  const crop = panel.crop;
  if (!(Array.isArray(crop) && crop.length === 4 && crop.every((v) => isInt(v, 0, 8000)) && crop[2] >= size[0] && crop[3] >= size[1])) return `the crop is [left, top, width, height] in photo pixels, at least ${size[0]}x${size[1]}`;
  if (Math.abs(crop[2] / crop[3] - size[0] / size[1]) > 0.02) return `the crop keeps the panel's shape (${size[0]}:${size[1]})`;
  return null;
}

function panelProblem(panel, size, count, text, photos) {
  if (!panel || typeof panel !== 'object' || Array.isArray(panel)) return 'a panel is not an object';
  const extra = keysOnly(panel, ['name', 'photo', 'rotate', 'crop', 'diagram', 'marks']);
  if (extra.length) return `a panel has no ${extra.join(', ')}`;
  if (panel.name !== undefined && count === 1) return 'one panel has no name: the heading names it';
  if (panel.name !== undefined && !isOwnWords(text, panel.name, 30)) return `the panel name "${panel.name}" is not the text's own words`;
  let problem;
  if (panel.diagram === undefined) problem = photoPanelProblem(panel, size, photos);
  else if (!DIAGRAMS.includes(panel.diagram)) problem = `no diagram ${panel.diagram} (diagrams: ${DIAGRAMS.join(', ')})`;
  else if (['photo', 'crop', 'rotate'].some((k) => panel[k] !== undefined)) problem = 'a diagram panel has no photo, crop or rotate';
  if (problem) return problem;
  if (!Array.isArray(panel.marks) || !panel.marks.length || panel.marks.length > 3) return 'a panel has 1 to 3 marks';
  return panel.marks.map((mark) => markProblem(mark, size, text)).find(Boolean) || null;
}

function pictureProblem(entry, text, photos) {
  const extra = keysOnly(entry, ['parts', 'why', 'text16', 'heading', 'panels']);
  if (extra.length) return `an entry has parts, why, heading and panels only, not ${extra.join(', ')}`;
  if (!isOwnWords(text, entry.heading, 60)) return 'the heading is the text\'s own words (60 characters at most)';
  if (!Array.isArray(entry.panels) || ![1, 2].includes(entry.panels.length)) return 'a picture has 1 or 2 panels';
  const named = entry.panels.filter((panel) => panel && panel.name !== undefined).length;
  if (named && named !== entry.panels.length) return 'two panels both have names or neither does';
  const size = panelSize(entry.panels.length, named > 0);
  const problem = entry.panels.map((panel) => panelProblem(panel, size, entry.panels.length, text, photos)).find(Boolean);
  if (problem) return problem;
  const labels = entry.panels.flatMap((panel) => panel.marks.map((mark) => mark.label));
  const unmarked = entry.parts.filter((part) => !labels.some((label) => names(label, part)));
  return unmarked.length ? `no label circles ${unmarked.join(', ')}` : null;
}

function entryProblem(entry, text, photos) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  if (!Array.isArray(entry.parts) || !entry.parts.every((p) => isText(p, 30))) return 'parts is a list of words, [] when the text names no part to show';
  const missing = entry.parts.filter((part) => !names(text, part));
  if (missing.length) return `the text does not name ${missing.join(', ')}`;
  if (entry.why !== undefined && !isText(entry.why, 160)) return 'why is one line (160 characters at most)';
  if (typeof entry.text16 !== 'string' || !/^[0-9a-f]{16}$/.test(entry.text16)) return 'text16 is the reviewed text\'s textHash (16 hex characters)';
  if (entry.parts.length) return pictureProblem(entry, text, photos);
  if (entry.why === undefined) return 'a list with no parts says why in a line';
  const extra = keysOnly(entry, ['parts', 'why', 'text16']);
  return extra.length ? `a list with no parts has no picture (${extra.join(', ')})` : null;
}

const hash10 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

// One checked picture: what is drawn, its file, its alt text and its credits.
function picture(id, entry, photos) {
  const named = entry.panels[0].name !== undefined;
  const size = panelSize(entry.panels.length, named);
  const panels = entry.panels.map((panel) => Object.freeze({
    ...panel,
    ...(panel.photo ? { sha16: photos[panel.photo].sha16 } : {}),
    marks: Object.freeze(panel.marks.map((mark) => Object.freeze({ ...mark, at: Object.freeze(mark.at.map((p) => Object.freeze([...p]))) }))),
  }));
  const file = `${id.toLowerCase()}-${hash10({ design: PART_DESIGN, heading: entry.heading, size, panels })}.jpg`;
  const labelsOf = (panel) => panel.marks.map((mark) => mark.label).join(', ');
  // The alt text says what the picture says: its heading, then each panel's name and labels.
  const alt = `${entry.heading} (${named ? entry.panels.map((panel) => `${panel.name}: ${labelsOf(panel)}`).join('; ') : entry.panels.map(labelsOf).join(', ')})`;
  const credits = [...new Set(entry.panels.filter((panel) => panel.photo).map((panel) => panel.photo))].map((name) => {
    const photo = photos[name];
    return Object.freeze({
      subject: photo.subject, author: photo.author, license: photo.license, licenseUrl: LICENSES[photo.license],
      source: photo.source, site: PHOTO_SITES[new URL(photo.source).host],
    });
  });
  return Object.freeze({
    heading: entry.heading, size: Object.freeze(size), panels: Object.freeze(panels),
    file, url: `${PART_BASE_URL}${file}`, alt, credits: Object.freeze(credits),
  });
}

/**
 * Checks the parts file against the shown texts (`textOf.facts(id)`,
 * `textOf.species(slug)`: the text, or null for no such entry). Returns
 * { parts, problems }: parts = frozen { facts, species } maps of
 * { parts, picture|null } with only the entries that pass; problems = one
 * line for each photo or entry that does not. It never throws, so a species
 * that loses its catalog approval, or a copy edit, costs that entry its
 * picture and never breaks an issue. The tests require no problems.
 */
function checkParts(raw, textOf = { facts: factText, species: speciesText }) {
  if (!raw || typeof raw !== 'object' || [raw.photos, raw.facts, raw.species].some((m) => !m || typeof m !== 'object' || Array.isArray(m))) {
    return { parts: Object.freeze({ facts: Object.freeze({}), species: Object.freeze({}) }), problems: Object.freeze(['the file has photos, facts and species maps']) };
  }
  const problems = [];
  const photos = {};
  for (const [file, photo] of Object.entries(raw.photos)) {
    const problem = photoProblem(file, photo);
    if (problem) problems.push(problem);
    else photos[file] = photo;
  }
  const out = {};
  for (const kind of ['facts', 'species']) {
    const checked = {};
    for (const [id, entry] of Object.entries(raw[kind])) {
      const text = textOf[kind](id);
      // A photo with a problem is left out above, so an entry using it fails here too.
      const problem = text === null ? `no such ${kind === 'facts' ? 'fact' : 'species'}` : entryProblem(entry, text, photos);
      if (problem) {
        problems.push(`${kind}.${id}: ${problem}`);
        continue;
      }
      checked[id] = Object.freeze({ parts: Object.freeze([...entry.parts]), picture: entry.parts.length ? picture(id, entry, photos) : null });
    }
    out[kind] = Object.freeze(checked);
  }
  return { parts: Object.freeze(out), problems: Object.freeze(problems) };
}

/** checkParts for the tests and the drawer: the parts maps, or a throw on the first problem. */
function validateParts(raw, textOf) {
  const { parts, problems } = checkParts(raw, textOf);
  if (problems.length) throw new Error(`pest-insider parts: ${problems[0]}`);
  return parts;
}

/** { facts: { id: { parts, picture } }, species: { slug: { parts, picture } } }, checked and frozen. */
const { parts: PARTS, problems: PART_PROBLEMS } = checkParts(data);
if (PART_PROBLEMS.length) {
  // Lazy, as in schedule.js: the logger loads only when there is something to say.
  require('../logger').warn(`[pest-insider parts] ${PART_PROBLEMS.length} part entries show no picture: ${PART_PROBLEMS.join('; ')}`);
}

/**
 * Entries whose text changed since a person reviewed it: [{ kind, id, text16, now }].
 * checkParts still checks own words and named parts against the new text;
 * the test fails on any stale entry and asks for a review.
 */
function staleReviews(raw = data, textOf = { facts: factText, species: speciesText }) {
  return ['facts', 'species'].flatMap((kind) => Object.entries(raw[kind])
    .map(([id, entry]) => ({ kind, id, text16: entry.text16, text: textOf[kind](id) }))
    // A missing text is a problem checkParts reports; here it has no hash.
    .filter((row) => row.text !== null && row.text16 !== textHash(row.text))
    .map(({ kind: k, id, text16, text }) => ({ kind: k, id, text16, now: textHash(text) })));
}

const entryOf = (map, key) => (typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);
/** A lead fact's part picture ({ url, alt, credits, ... }), or null. */
const partPictureForFact = (id) => entryOf(PARTS.facts, id)?.picture || null;
/** A "What's this?" species' part picture, or null. */
const partPictureForSpecies = (slug) => entryOf(PARTS.species, slug)?.picture || null;

module.exports = {
  PART_DESIGN, PART_WIDTH, PART_HEIGHT, PART_BASE_URL, PART_DIR, PHOTO_DIR, LICENSES, PHOTO_SITES, DIAGRAMS, PART_WORDS, PARTS, PART_PROBLEMS,
  panelSize, partWordsIn, factText, speciesText, textHash, checkParts, validateParts, staleReviews, partPictureForFact, partPictureForSpecies,
};
