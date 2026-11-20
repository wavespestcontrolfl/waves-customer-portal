/**
 * pest-insider-cards.js — MUTATES (dry-run default; no database, no send): draws the Pest Insider fact cards
 *
 * Draws every card in server/data/pest-insider-cards-v1.json (checked by
 * server/services/pest-insider/cards.js) as a 582x300 picture at 2x, and
 * writes it to client/public/pest-insider/cards/<fact>-<hash>.png, where the
 * portal serves it to email readers. A months card also gets
 * <fact>-<hash>.gif: the whole card, then its months light one by one; it
 * plays 3 times and stops on the whole card. Run it on a Mac after any change
 * to the card file or the drawing, then commit the pictures with the change.
 *
 *   node ops/agents/pest-insider-cards.js [--execute] [--out <dir>] [--only A01,T03]
 *
 *     (none)        dry run: lists each card's file and whether it is drawn yet
 *     --execute     draw the cards whose file is not there yet
 *     --out <dir>   the folder to draw into (a preview) instead of the portal's
 *     --only ids    only these cards
 *
 * A picture is written under a temporary name and hard-linked to its own
 * name only when whole. A file, once drawn, is never drawn again, changed
 * or removed: a sent
 * email and the issue archive keep the exact picture URLs they were sent
 * with. A card that must look different gets a new name (its words change,
 * or CARD_DESIGN is bumped); an old file stays until a person removes it,
 * once no sent issue uses it.
 *
 * The drawing uses Anton and Inter from font files the portal ships
 * (pest-insider-fonts.js), so it needs no network. A card is refused when
 * either font did not load, so no card ships in a fallback font. Each
 * card uses its color set from cards.js SCHEMES, and no other color.
 * Change the drawing below -> bump CARD_DESIGN in cards.js, so every card
 * gets a new file name and the test asks for new pictures; change the months
 * card's motion -> bump CARD_MOTION_DESIGN.
 */
/* global document, getComputedStyle */
'use strict';

const fs = require('fs');
const path = require('path');

for (const name of Object.keys(process.env)) {
  if (/^(DATABASE_|POSTGRES_|PG[A-Z]+$)/.test(name)) delete process.env[name];
}
process.env.WAVES_LOCAL_DEV = '1';

const { chromium } = require('playwright');
const sharp = require('sharp');
const { CARDS, CARD_DIR, CARD_WIDTH, CARD_HEIGHT, SCHEMES } = require('../../server/services/pest-insider/cards');
const { fontStyle } = require('./pest-insider-fonts');

// The command line, checked whole: an unknown flag, a flag with no value,
// a flag given twice or an extra word stops the run (exit 2), so a typo
// such as "--olny" never widens what it touches.
function readArgs(argv, valueFlags, words) {
  const out = { execute: false, values: {}, words: [] };
  const stop = (why) => { console.error(`${why}. See the top of ${path.basename(__filename)}.`); process.exit(2); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') out.execute = true;
    else if (valueFlags.includes(arg)) {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('-') || !value.trim()) stop(`${arg} needs a value`);
      if (Object.prototype.hasOwnProperty.call(out.values, arg)) stop(`${arg} is given twice`);
      out.values[arg] = value;
      i += 1;
    } else if (!arg.startsWith('-') && out.words.length < words) out.words.push(arg);
    else stop(`Unknown argument: ${arg}`);
  }
  return out;
}
const cli = readArgs(process.argv.slice(2), ['--out', '--only'], 0);
const repoRoot = path.resolve(__dirname, '../..');
const outDir = path.resolve(cli.values['--out'] || path.join(repoRoot, CARD_DIR));
const execute = cli.execute;
const only = cli.values['--only'] === undefined ? null : new Set(cli.values['--only'].split(',').map((s) => s.trim()).filter(Boolean));
if (only && !only.size) { console.error('--only needs fact ids, such as --only T03,R01'); process.exit(2); }

// How strongly the thin edge line and the unlit month chips show, per color
// set. Every color comes from SCHEMES (cards.js); a test refuses any other.
const EDGE_ALPHA = { navy: 0.28, gold: 0.18, light: 1 };
const CHIP_ALPHA = { navy: 0.12, gold: 0.1, light: 0.08 };
const tint = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
// The moving months card: the whole card (all Outlook-like readers see it
// first), a blink with no month lit, the months lighting one by one from the
// first, and the whole card held. It plays 3 times and stops on the whole card.
const MONTHS_GIF = Object.freeze({ wholeMs: 1800, darkMs: 350, stepMs: 300, endMs: 2600, loops: 3 });

// A fixed label per layout: no fact in it.
const KICKER = { number: 'By the numbers', statement: 'Did you know?', months: 'Season', versus: 'Side by side' };
const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

// True only when every font really loaded: load() resolves to the faces it
// loaded, an empty list when the stylesheet never defined the font (then
// check() would still say true and the drawing would use a fallback font).
async function fontsLoaded(fonts) {
  const loaded = await Promise.all(fonts.map((f) => document.fonts.load(f)));
  return loaded.every((faces) => faces.length > 0 && faces.every((face) => face.status === 'loaded'));
}

// Publishes a finished picture: written in full under a temporary name,
// then hard-linked to its own name. The link is atomic and never replaces a
// file, so a picture is either whole at its name or not there at all.
function publish(outDir, file, bytes) {
  const temp = path.join(outDir, `.${file}.${process.pid}.tmp`);
  fs.writeFileSync(temp, bytes, { flag: 'wx' });
  try {
    fs.linkSync(temp, path.join(outDir, file));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function lit(month, [first, last]) {
  return first <= last ? month >= first && month <= last : month >= first || month <= last;
}

// The lit months in order from the first, across the new year: [12, 5] -> 12, 1, 2, 3, 4, 5.
const litInOrder = ([first, last]) => Array.from({ length: ((last - first + 12) % 12) + 1 }, (_, i) => ((first - 1 + i) % 12) + 1);

// Line breaks only: a number stays with the word after it ("3 million") and a
// month with its day ("Sept. 30"); a comma that opens the after line moves to
// the end of the big words. No word changes.
const MONTH_THEN_DAY = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.|Feb\.|Mar\.|Apr\.|Jun\.|Jul\.|Aug\.|Sept\.|Sep\.|Oct\.|Nov\.|Dec\.) (?=\d)/g;
const keepTogether = (t) => t.replace(/(\d) (?=[A-Za-z])/g, '$1\u00A0').replace(MONTH_THEN_DAY, '$1\u00A0');

function pieceHtml(p, cls = '') {
  let { big, after } = p;
  const lead = /^[,;:]/.exec(after || '');
  if (lead) { big = `${big}${lead[0]}`; after = after.slice(1).trim(); }
  return `<div class="piece ${cls}">${p.before ? `<div class="small">${esc(p.before)}</div>` : ''}<div class="big">${esc(keepTogether(big))}</div>${after ? `<div class="small">${esc(after)}</div>` : ''}</div>`;
}

// The Waves wave band along the bottom: two soft waves in the set's wave
// color. Waves Blue carries no words, so the source line on it stays readable.
const waveBand = (color) => `<svg class="wave" viewBox="0 0 582 64" preserveAspectRatio="none"><path d="M0 40 C 60 22, 120 22, 180 40 S 300 58, 360 40 S 480 22, 582 38 L582 64 L0 64 Z" fill="${color}" opacity="0.18"/><path d="M0 52 C 70 38, 140 38, 210 52 S 350 66, 420 52 S 520 40, 582 50 L582 64 L0 64 Z" fill="${color}" opacity="0.28"/></svg>`;

function cardHtml(card, fonts) {
  const c = SCHEMES[card.scheme];
  const main = card.layout === 'versus'
    ? `<div class="vs">${pieceHtml(card.pieces[0], 'side')}<div class="vsmark">VS</div>${pieceHtml(card.pieces[1], 'side')}</div>`
    : pieceHtml(card.pieces[0]);
  const strip = card.layout === 'months'
    ? `<div class="strip">${MONTH_LETTERS.map((m, i) => `<span class="m${lit(i + 1, card.months) ? ' on' : ''}">${m}</span>`).join('')}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
${fonts}
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .card { position: relative; box-sizing: border-box; width: ${CARD_WIDTH}px; height: ${CARD_HEIGHT}px; overflow: hidden;
    padding: 20px 26px 16px; display: flex; flex-direction: column; gap: 8px; border-radius: 12px;
    background: ${c.background}; box-shadow: inset 0 0 0 2px ${tint(c.edge, EDGE_ALPHA[card.scheme])};
    color: ${c.small}; font-family: Inter, sans-serif; }
  .wave { position: absolute; left: 0; right: 0; bottom: 0; width: 100%; height: 64px; }
  .top, .bottom { position: relative; display: flex; justify-content: space-between; align-items: center; }
  .tag { font: 800 11px/1 Inter, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: ${c.tagText}; background: ${c.tag}; padding: 6px 10px; border-radius: 999px; }
  .kicker { font: 700 11px/1 Inter, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: ${c.small}; }
  .main { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
  .small { font: 600 17px/1.3 Inter, sans-serif; color: ${c.small}; }
  .big { font-family: Anton, sans-serif; text-transform: uppercase; color: ${c.big}; line-height: 1.04; letter-spacing: 0.01em; margin: 2px 0 4px; overflow-wrap: normal; }
  .vs { display: flex; align-items: center; gap: 14px; }
  .vs .side { flex: 1; min-width: 0; }
  .vsmark { flex: none; width: 42px; height: 42px; border-radius: 50%; border: 2px solid ${c.small}; display: flex; align-items: center; justify-content: center; font: 400 17px/1 Anton, sans-serif; color: ${c.small}; }
  .strip { display: flex; gap: 4px; margin-top: 10px; }
  .m { flex: 1; text-align: center; font: 800 12px/1 Inter, sans-serif; padding: 7px 0; border-radius: 6px; background: ${tint(c.small, CHIP_ALPHA[card.scheme])}; color: ${c.small}; }
  .m.on { background: ${c.tag}; color: ${c.tagText}; }
  .bottom { font: 600 11px/1.3 Inter, sans-serif; color: ${c.small}; }
  .brand { font: 800 11px/1 Inter, sans-serif; letter-spacing: 0.16em; text-transform: uppercase; }
</style></head><body>
<div class="card">${waveBand(c.wave)}
  <div class="top"><span class="tag">${esc(card.tag)}</span><span class="kicker">${esc(KICKER[card.layout])}</span></div>
  <div class="main">${main}${strip}</div>
  <div class="bottom"><span>${esc(card.source)}</span><span class="brand">Waves Pest Insider</span></div>
</div></body></html>`;
}

// Largest big type that fits: each big line within its box, the main area
// within the card, and no big phrase over two lines (three for versus).
async function fitText(page, layout) {
  return page.evaluate(({ start, maxLines }) => {
    const main = document.querySelector('.main');
    const bigs = [...document.querySelectorAll('.big')];
    const fits = () => main.scrollHeight <= main.clientHeight + 1
      && bigs.every((b) => b.scrollWidth <= b.clientWidth + 1
        && Math.round(b.getBoundingClientRect().height / (parseFloat(getComputedStyle(b).fontSize) * 1.04)) <= maxLines);
    let size = start;
    for (; size >= 24; size -= 2) {
      bigs.forEach((b) => { b.style.fontSize = `${size}px`; });
      if (fits()) return size;
    }
    return null;
  }, { start: layout === 'versus' ? 40 : 72, maxLines: layout === 'versus' ? 3 : 2 });
}

(async () => {
  const wanted = Object.entries(CARDS).filter(([id]) => !only || only.has(id));
  const unknown = only ? [...only].filter((id) => !Object.prototype.hasOwnProperty.call(CARDS, id)) : [];
  if (unknown.length) { console.error(`No card for ${unknown.join(', ')}; nothing drawn.`); process.exit(2); }
  const state = (file) => (fs.existsSync(path.join(outDir, file)) ? 'drawn' : 'would draw');
  if (!execute) {
    for (const [id, card] of wanted) console.log(`${id}  ${card.file}  ${state(card.file)}${card.gifFile ? `  ${card.gifFile}  ${state(card.gifFile)}` : ''}`);
    console.log(`Dry run: nothing written. Add --execute to draw into ${outDir}.`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const fontCss = fontStyle([600, 700, 800]);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT }, deviceScaleFactor: 2 });
  let failed = 0;
  for (const [id, card] of wanted) {
    const needStill = !fs.existsSync(path.join(outDir, card.file));
    const needGif = Boolean(card.gifFile) && !fs.existsSync(path.join(outDir, card.gifFile));
    if (!needStill && !needGif) { console.log(`${id}  ${card.file}  already drawn; kept`); continue; }
    await page.setContent(cardHtml(card, fontCss), { waitUntil: 'networkidle' });
    const fonts = await page.evaluate(fontsLoaded, ['40px Anton', '700 17px Inter']);
    if (!fonts) { console.error(`${id}: Anton or Inter did not load; not drawn`); failed += 1; continue; }
    const size = await fitText(page, card.layout);
    if (!size) { console.error(`${id}: the words do not fit the card; shorten the piece`); failed += 1; continue; }
    // Clear corners: the card keeps its round shape in every mail app, Outlook too.
    const grab = () => page.screenshot({ clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }, omitBackground: true });
    if (needStill) {
      const png = await sharp(await grab()).png({ palette: true, quality: 95, effort: 10, compressionLevel: 9 }).toBuffer();
      publish(outDir, card.file, png);
      console.log(`${id}  ${card.file}  ${card.layout}  big ${size}px  ${Math.round(png.length / 1024)} KB`);
    }
    if (needGif) {
      // The words keep the size fitted above: only which month chips are lit changes.
      const light = (months) => page.evaluate((on) => {
        document.querySelectorAll('.m').forEach((chip, i) => chip.classList.toggle('on', on.includes(i + 1)));
      }, months);
      const order = litInOrder(card.months);
      const frames = [];
      const delay = [];
      const frame = async (months, ms) => { await light(months); frames.push(await grab()); delay.push(ms); };
      await frame(order, MONTHS_GIF.wholeMs);
      await frame([], MONTHS_GIF.darkMs);
      for (let i = 1; i <= order.length; i += 1) await frame(order.slice(0, i), i === order.length ? MONTHS_GIF.endMs : MONTHS_GIF.stepMs);
      const gif = await sharp(frames, { join: { animated: true } })
        .gif({ delay, loop: MONTHS_GIF.loops, dither: 0, effort: 10, reuse: true })
        .toBuffer();
      publish(outDir, card.gifFile, gif);
      console.log(`${id}  ${card.gifFile}  ${frames.length} frames  ${Math.round(gif.length / 1024)} KB`);
    }
  }
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
