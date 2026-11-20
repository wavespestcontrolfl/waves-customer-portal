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
 *
 * Motion (owner 2026-11-19, approved plan step 2: "ChatGPT art, moved by
 * code"): a top picture may also move. Its entry then names one kind of
 * motion from MOTION_KINDS (a light whose glow pulses, a drop that falls,
 * rain, rings that point at a spot...), placed on its art by a person. Code
 * draws the motion over the finished picture, right of the title panel only
 * (HERO_ART_LEFT), in Waves colors, as a GIF that plays 3 times. The motion
 * adds no words and no fact: it moves what the art already shows. Motion is
 * placed on one art: new art for a fact drops its motion
 * (pest-insider-art-import.js), and a person places it again.
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

/** Bump when the motion drawing changes (ops/agents/pest-insider-motion.js): every moving picture gets a new file name. */
const HERO_MOTION_DESIGN = 1;
/** Motion never shows left of this share of the width: the title panel (its words end at 0.47). */
const HERO_ART_LEFT = 0.52;
/** Each kind of motion and the numbers it takes, in this order (drawn by ops/agents/pest-insider-motion.js). */
const MOTION_KINDS = Object.freeze({
  swarm: Object.freeze(['x', 'y']), // a light at x,y: its glow pulses and specks circle it
  rise: Object.freeze(['x', 'y', 'x2', 'y2']), // specks drift from x,y to x2,y2
  drop: Object.freeze(['x', 'y', 'to', 'size']), // a drop forms at x,y, falls to the height `to` and splashes
  rain: Object.freeze(['x']), // rain falls across the art right of x
  march: Object.freeze(['x', 'y', 'cx', 'cy', 'x2', 'y2']), // specks walk a curve from x,y to x2,y2, bent toward cx,cy
  pulse: Object.freeze(['x', 'y', 'r0', 'r1']), // rings grow from r0 to r1 around x,y, to point at it
  spray: Object.freeze(['x', 'y', 'angle', 'spread', 'reach', 'fall', 'size']), // drops fly out of a nozzle at x,y and fall by `fall`
  heat: Object.freeze(['x', 'y']), // wavy lines rise from x,y and fade
});
/** The colors motion is drawn in: names in cards.js WAVES_COLORS. */
const MOTION_COLORS = Object.freeze(['navy', 'gold', 'wavesBlue', 'white']);
// What each number may be: a spot as a share of the width (never over the
// title panel) or height, a size in pixels on the 582-wide picture, an angle
// in degrees (0 = right, 90 = up).
const MOTION_RANGES = Object.freeze({
  x: [HERO_ART_LEFT, 1], x2: [HERO_ART_LEFT, 1], cx: [HERO_ART_LEFT, 1],
  y: [0, 1], y2: [0, 1], cy: [0, 1], to: [0, 1],
  size: [1, 8], r0: [4, 40], r1: [8, 60], angle: [0, 360], spread: [0, 90], reach: [10, 200], fall: [0, 100],
});

// The motion, checked and in a fixed key order (its hash names the GIF), or a problem.
function motionOf(motion) {
  if (!motion || typeof motion !== 'object' || Array.isArray(motion)) return { problem: 'motion must be an object' };
  // The kind is text: a lookup would read a list such as ["rain"] as "rain".
  if (typeof motion.kind !== 'string' || !Object.prototype.hasOwnProperty.call(MOTION_KINDS, motion.kind)) return { problem: `motion kind must be one of ${Object.keys(MOTION_KINDS).join(', ')}` };
  if (!MOTION_COLORS.includes(motion.color)) return { problem: `motion color must be one of ${MOTION_COLORS.join(', ')}` };
  const names = MOTION_KINDS[motion.kind];
  const extra = Object.keys(motion).filter((key) => !['kind', 'color', ...names].includes(key));
  if (extra.length) return { problem: `${motion.kind} motion takes no ${extra.join(', ')}` };
  const out = { kind: motion.kind, color: motion.color };
  for (const name of names) {
    const [low, high] = MOTION_RANGES[name];
    const value = motion[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) return { problem: `${motion.kind} motion needs ${name} from ${low} to ${high}` };
    out[name] = value;
  }
  if (out.kind === 'pulse' && out.r1 <= out.r0) return { problem: 'pulse motion needs r1 larger than r0' };
  if (out.kind === 'drop' && out.to <= out.y) return { problem: 'a drop falls: its `to` must be below its y' };
  return { motion: Object.freeze(out) };
}

function heroProblem(id, hero) {
  const fact = factById(id);
  if (!fact || fact.reserve) return 'is not a main fact in the fact bank';
  // The tag on the picture is the fact's card tag, so the two always agree.
  if (!cardFor(id)) return 'has no card in cards.js, so it has no topic tag';
  if (!hero || typeof hero !== 'object' || Array.isArray(hero)) return 'entry is not an object';
  if (hero.art !== null && !/^[0-9a-f]{16}$/.test(String(hero.art))) {
    return "art must be null or the first 16 hex of the art file's sha256";
  }
  const extra = Object.keys(hero).filter((key) => key !== 'art' && key !== 'motion');
  if (extra.length) return `an entry has art and motion only, not ${extra.join(', ')}`;
  if (hero.motion === undefined) return null;
  // Motion moves what the art shows, so a picture with no art has none.
  if (hero.art === null) return 'a picture with no art has no motion';
  return motionOf(hero.motion).problem || null;
}

const hash10 = (shown) => crypto.createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 10);

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
    const file = `${id.toLowerCase()}-${hash10(shown)}.jpg`;
    // The moving picture: the same picture with its motion, named by both.
    const motion = hero.motion === undefined ? null : motionOf(hero.motion).motion;
    const gifFile = motion ? `${id.toLowerCase()}-${hash10({ ...shown, motion, motionDesign: HERO_MOTION_DESIGN })}.gif` : null;
    heroes[id] = Object.freeze({
      ...shown,
      artFile: hero.art ? `${id.toLowerCase()}-${hero.art}.webp` : null,
      file,
      url: `${HERO_BASE_URL}${file}`,
      motion,
      gifFile,
      gifUrl: gifFile && `${HERO_BASE_URL}${gifFile}`,
      // The picture's words are the title; the art and its motion have none.
      alt: shown.title,
    });
  }
  return Object.freeze(heroes);
}

/** Fact id -> its top picture: { title, tag, kicker, art, artFile, file, url, motion, gifFile, gifUrl, alt }. Frozen. */
const HEROES = validateHeroes(data);

const heroFor = (factId) => (typeof factId === 'string' && Object.prototype.hasOwnProperty.call(HEROES, factId) ? HEROES[factId] : null);

module.exports = {
  HEROES, HERO_DESIGN, HERO_WIDTH, HERO_HEIGHT, HERO_BASE_URL, HERO_DIR, ART_DIR, HERO_KICKER,
  HERO_MOTION_DESIGN, HERO_ART_LEFT, MOTION_KINDS, MOTION_COLORS,
  heroFor, validateHeroes,
};
