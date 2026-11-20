/**
 * pest-insider-heroes.js — MUTATES (dry-run default; no database, no send): draws the Pest Insider top pictures
 *
 * Draws every top picture in server/data/pest-insider-heroes-v1.json
 * (checked by server/services/pest-insider/heroes.js) as a 582x326 JPEG at
 * 2x, and writes it to client/public/pest-insider/heroes/<fact>-<hash>.jpg,
 * where the portal serves it to email readers. Run it on a Mac after any
 * change to the heroes file, a fact's title or the drawing, then commit the
 * pictures with the change.
 *
 *   node ops/agents/pest-insider-heroes.js [--execute] [--out <dir>] [--only T03,R01]
 *
 *     (none)        dry run: lists each picture's file and whether it is drawn yet
 *     --execute     draw the pictures whose file is not there yet
 *     --out <dir>   the folder to draw into (a preview) instead of the portal's
 *     --only ids    only these facts
 *
 * New art comes in through ops/agents/pest-insider-art-import.js.
 *
 * A picture is written under a temporary name and hard-linked to its own
 * name only when whole. A file, once drawn, is never drawn again, changed
 * or removed: a sent
 * email and the issue archive keep the exact picture URLs they were sent
 * with. A picture that must look different gets a new name (new art, a new
 * title, or HERO_DESIGN bumped); an old file stays until a person removes
 * it, once no sent issue uses it.
 *
 * The title, tag and kicker are drawn here, in Anton and Inter from Google
 * Fonts; a picture is refused when either font did not load, so none ships
 * in a fallback font. Every color comes from cards.js WAVES_COLORS, and a
 * test refuses any other. Change the drawing below -> bump HERO_DESIGN in
 * heroes.js, so every picture gets a new file name.
 */
/* global document */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

for (const name of Object.keys(process.env)) {
  if (/^(DATABASE_|POSTGRES_|PG[A-Z]+$)/.test(name)) delete process.env[name];
}
process.env.WAVES_LOCAL_DEV = '1';

const { chromium } = require('playwright');
const sharp = require('sharp');
const { WAVES_COLORS: C } = require('../../server/services/pest-insider/cards');

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
const only = cli.values['--only'] === undefined ? null : new Set(cli.values['--only'].split(',').map((s) => s.trim()).filter(Boolean));
if (only && !only.size) { console.error('--only needs fact ids, such as --only T03,R01'); process.exit(2); }
const execute = cli.execute;

const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
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
const tint = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
// Line breaks only: a number stays with the word after it ("8 months"). No word changes.
const keepTogether = (t) => t.replace(/(\d) (?=[A-Za-z])/g, '$1 ');

// With art: a navy panel on the left (solid, then fading into the art) holds
// the tag, the kicker and the title, so gold on navy reads 6.3:1 whatever the
// art shows. Without art: the title across the whole picture on navy, over
// the Waves wave band.
function heroHtml(hero, artUrl, { HERO_WIDTH, HERO_HEIGHT }) {
  const box = artUrl ? { width: 250, height: 250 } : { width: 534, height: 220 };
  const backdrop = artUrl
    ? `<div class="art" style="background-image:url(${artUrl})"></div><div class="scrim"></div>`
    : `<svg class="wave" viewBox="0 0 582 70" preserveAspectRatio="none"><path d="M0 44 C 60 24, 120 24, 180 44 S 300 64, 360 44 S 480 24, 582 42 L582 70 L0 70 Z" fill="${C.wavesBlue}" opacity="0.22"/><path d="M0 56 C 70 40, 140 40, 210 56 S 350 72, 420 56 S 520 44, 582 54 L582 70 L0 70 Z" fill="${C.wavesBlue}" opacity="0.34"/></svg>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@700;800&display=block">
<style>
  html, body { margin: 0; padding: 0; background: ${C.navy}; }
  .p { position: relative; width: ${HERO_WIDTH}px; height: ${HERO_HEIGHT}px; overflow: hidden; background: ${C.navy}; font-family: Inter, sans-serif; }
  .art { position: absolute; inset: 0; background-size: cover; background-position: center; }
  .scrim { position: absolute; inset: 0; background: linear-gradient(90deg, ${C.navy} 0%, ${C.navy} 46%, ${tint(C.navy, 0.85)} 52%, ${tint(C.navy, 0)} 64%); }
  .wave { position: absolute; left: 0; bottom: 0; width: 100%; height: 70px; }
  .top { position: absolute; left: 24px; top: 20px; display: flex; gap: 10px; align-items: center; }
  .tag { font: 800 11px/1 Inter, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; background: ${C.gold}; color: ${C.navy}; padding: 6px 10px; border-radius: 999px; }
  .kicker { font: 800 11px/1 Inter, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.white}; }
  h1 { position: absolute; left: 24px; top: 52px; width: ${box.width}px; height: ${box.height}px; margin: 0; display: flex; align-items: center;
    font-family: Anton, sans-serif; font-weight: 400; text-transform: uppercase; color: ${C.gold}; line-height: 1.02; letter-spacing: 0.01em; }
</style></head><body>
<div class="p">${backdrop}
  <div class="top"><span class="tag">${esc(hero.tag)}</span><span class="kicker">${esc(hero.kicker)}</span></div>
  <h1><span id="t">${esc(keepTogether(hero.title))}</span></h1>
</div></body></html>`;
}

// Largest title that fits its box: no word wider than the box, all lines within it.
async function fitTitle(page, box) {
  return page.evaluate(({ width, height }) => {
    const h1 = document.querySelector('h1');
    const t = document.getElementById('t');
    for (let size = 64; size >= 26; size -= 2) {
      h1.style.fontSize = `${size}px`;
      const r = t.getBoundingClientRect();
      if (h1.scrollWidth <= width + 1 && r.width <= width + 1 && r.height <= height) return size;
    }
    return null;
  }, box);
}

async function draw(H) {
  const { HEROES, HERO_DIR, HERO_WIDTH, HERO_HEIGHT, ART_DIR } = H;
  const outDir = path.resolve(cli.values['--out'] || path.join(repoRoot, HERO_DIR));
  const wanted = Object.entries(HEROES).filter(([key]) => !only || only.has(key));
  const unknown = only ? [...only].filter((id) => !Object.prototype.hasOwnProperty.call(HEROES, id)) : [];
  if (unknown.length) { console.error(`No top picture for ${unknown.join(', ')}; nothing drawn.`); process.exit(2); }
  if (!execute) {
    for (const [id, hero] of wanted) console.log(`${id}  ${hero.file}  ${fs.existsSync(path.join(outDir, hero.file)) ? 'drawn' : 'would draw'}`);
    console.log(`Dry run: nothing written. Add --execute to draw into ${outDir}.`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: HERO_WIDTH, height: HERO_HEIGHT }, deviceScaleFactor: 2 });
  let failed = 0;
  for (const [id, hero] of wanted) {
    if (fs.existsSync(path.join(outDir, hero.file))) { console.log(`${id}  ${hero.file}  already drawn; kept`); continue; }
    let artUrl = null;
    if (hero.art) {
      const art = fs.readFileSync(path.join(repoRoot, ART_DIR, hero.artFile));
      if (sha16(art) !== hero.art) { console.error(`${id}: ${hero.artFile} is not the art the heroes file names; import it again with pest-insider-art-import.js`); failed += 1; continue; }
      artUrl = `data:image/webp;base64,${art.toString('base64')}`;
    }
    await page.setContent(heroHtml(hero, artUrl, H), { waitUntil: 'networkidle' });
    const fonts = await page.evaluate(fontsLoaded, ['40px Anton', '800 11px Inter']);
    if (!fonts) { console.error(`${id}: Anton or Inter did not load; not drawn`); failed += 1; continue; }
    const size = await fitTitle(page, hero.art ? { width: 250, height: 250 } : { width: 534, height: 220 });
    if (!size) { console.error(`${id}: the title does not fit`); failed += 1; continue; }
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: HERO_WIDTH, height: HERO_HEIGHT } });
    const jpg = await sharp(shot).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    publish(outDir, hero.file, jpg);
    console.log(`${id}  ${hero.file}  ${hero.art ? 'art' : 'no art'}  title ${size}px  ${Math.round(jpg.length / 1024)} KB`);
  }
  await browser.close();
  if (failed) process.exit(1);
}

draw(require('../../server/services/pest-insider/heroes')).catch((e) => { console.error(e); process.exit(1); });
