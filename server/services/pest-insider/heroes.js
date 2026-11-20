/**
 * Pest Insider top pictures: one per lead fact, at the top of the issue
 * (owner 2026-11-19: "the thumbnail should always have text, like the
 * newsletter, big bold"; then "just use chatgpt").
 *
 * A top picture is the fact's title in big gold letters on a navy panel,
 * drawn by code, beside art that ChatGPT drew for the fact with no words in
 * it. The title is the issue's headline and the words of its subject line
 * (claim-check.js checkIssueCopy), so the picture states nothing the send
 * check has not read. The art only sets the scene: bugs appear as cartoons,
 * and a body part is never shown by AI. A fact whose art did not pass the
 * check has `art: null`: its picture is the title on navy over the Waves
 * wave band, drawn by code alone.
 *
 * Loaded from server/data/pest-insider-heroes-v1.json: fact id -> { art },
 * where art is the first 16 hex of the sha256 of the fact's art file, or
 * null. The art file carries that hash in its name
 * (ops/agents/pest-insider-art/<fact>-<art>.webp), so new art never
 * overwrites the art the heroes file names. The pictures are drawn
 * on a Mac by ops/agents/pest-insider-heroes.js and ship with the portal
 * (client/public/pest-insider/heroes/). Each file name carries a hash of
 * everything drawn on it (title, tag, art), so a changed title or new art
 * gets a new file, and a test fails until it is drawn.
 */
'use strict';

const crypto = require('crypto');
const data = require('../../data/pest-insider-heroes-v1.json');
const { factById } = require('./facts');
const { cardFor } = require('./cards');

/** Bump when the drawing changes: every top picture gets a new file name. */
const HERO_DESIGN = 1;
const HERO_WIDTH = 582;
const HERO_HEIGHT = 326;
const HERO_BASE_URL = 'https://portal.wavespestcontrol.com/pest-insider/heroes/';
const HERO_DIR = 'client/public/pest-insider/heroes';
const ART_DIR = 'ops/agents/pest-insider-art';
/** The fixed line over the title: no fact in it. */
const HERO_KICKER = 'Waves Pest Insider';

function heroProblem(id, hero) {
  const fact = factById(id);
  if (!fact || fact.reserve) return 'is not a main fact in the fact bank';
  // The tag on the picture is the fact's card tag, so the two always agree.
  if (!cardFor(id)) return 'has no card in cards.js, so it has no topic tag';
  if (!hero || typeof hero !== 'object' || Array.isArray(hero)) return 'entry is not an object';
  if (hero.art !== null && !/^[0-9a-f]{16}$/.test(String(hero.art))) {
    return "art must be null or the first 16 hex of the art file's sha256";
  }
  return null;
}

function validateHeroes(raw) {
  if (!raw || typeof raw.heroes !== 'object' || raw.heroes === null || Array.isArray(raw.heroes)) {
    throw new Error('pest-insider heroes: the file has no heroes map');
  }
  const heroes = {};
  for (const [id, hero] of Object.entries(raw.heroes)) {
    const problem = heroProblem(id, hero);
    if (problem) throw new Error(`pest-insider heroes: ${id}: ${problem}`);
    // Everything drawn on the picture, in a fixed order: the hash names the file.
    const shown = { design: HERO_DESIGN, title: factById(id).title, tag: cardFor(id).tag, kicker: HERO_KICKER, art: hero.art };
    const hash = crypto.createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 10);
    const file = `${id.toLowerCase()}-${hash}.jpg`;
    heroes[id] = Object.freeze({
      ...shown,
      artFile: hero.art ? `${id.toLowerCase()}-${hero.art}.webp` : null,
      file,
      url: `${HERO_BASE_URL}${file}`,
      // The picture's words are the title; the art has none.
      alt: shown.title,
    });
  }
  return Object.freeze(heroes);
}

/** Fact id -> its top picture: { title, tag, kicker, art, artFile, file, url, alt }. Frozen. */
const HEROES = validateHeroes(data);

const heroFor = (factId) => (typeof factId === 'string' && Object.prototype.hasOwnProperty.call(HEROES, factId) ? HEROES[factId] : null);

module.exports = {
  HEROES, HERO_DESIGN, HERO_WIDTH, HERO_HEIGHT, HERO_BASE_URL, HERO_DIR, ART_DIR, HERO_KICKER,
  heroFor, validateHeroes,
};
