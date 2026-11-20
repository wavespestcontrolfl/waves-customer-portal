/**
 * pest-insider-cards.js — MUTATES (dry-run default; no database, no send): draws the Pest Insider fact cards
 *
 * Draws every card in server/data/pest-insider-cards-v1.json (checked by
 * server/services/pest-insider/cards.js) as a 582x300 picture at 2x, and
 * writes it to client/public/pest-insider/cards/<fact>-<hash>.png, where the
 * portal serves it to email readers. Run it on a Mac after any change to the
 * card file or the drawing, then commit the pictures with the change.
 *
 *   node ops/agents/pest-insider-cards.js [--execute] [--out <dir>] [--only A01,T03]
 *
 *     (none)        dry run: lists each card's file and whether it is drawn yet
 *     --execute     draw the cards whose file is not there yet
 *     --out <dir>   the folder to draw into (a preview) instead of the portal's
 *     --only ids    only these cards
 *
 * A file, once drawn, is never drawn again, changed or removed: a sent
 * email and the issue archive keep the exact picture URLs they were sent
 * with. A card that must look different gets a new name (its words change,
 * or CARD_DESIGN is bumped); an old file stays until a person removes it,
 * once no sent issue uses it.
 *
 * The drawing loads Anton and Inter from Google Fonts. A card is refused
 * when either font did not load, so no card ships in a fallback font. Each
 * card uses its color set from cards.js SCHEMES, and no other color.
 * Change the drawing below -> bump CARD_DESIGN in cards.js, so every card
 * gets a new file name and the test asks for new pictures.
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

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const repoRoot = path.resolve(__dirname, '../..');
const outDir = path.resolve(opt('--out') || path.join(repoRoot, CARD_DIR));
const execute = args.includes('--execute');
const only = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : null;

// How strongly the thin edge line and the unlit month chips show, per color
// set. Every color comes from SCHEMES (cards.js); a test refuses any other.
const EDGE_ALPHA = { navy: 0.28, gold: 0.18, light: 1 };
const CHIP_ALPHA = { navy: 0.12, gold: 0.1, light: 0.08 };
const tint = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
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

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function lit(month, [first, last]) {
  return first <= last ? month >= first && month <= last : month >= first || month <= last;
}

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

function cardHtml(card) {
  const c = SCHEMES[card.scheme];
  const main = card.layout === 'versus'
    ? `<div class="vs">${pieceHtml(card.pieces[0], 'side')}<div class="vsmark">VS</div>${pieceHtml(card.pieces[1], 'side')}</div>`
    : pieceHtml(card.pieces[0]);
  const strip = card.layout === 'months'
    ? `<div class="strip">${MONTH_LETTERS.map((m, i) => `<span class="m${lit(i + 1, card.months) ? ' on' : ''}">${m}</span>`).join('')}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@600;700;800&display=block">
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
  if (!execute) {
    for (const [id, card] of wanted) console.log(`${id}  ${card.file}  ${fs.existsSync(path.join(outDir, card.file)) ? 'drawn' : 'would draw'}`);
    console.log(`Dry run: nothing written. Add --execute to draw into ${outDir}.`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: CARD_WIDTH, height: CARD_HEIGHT }, deviceScaleFactor: 2 });
  let failed = 0;
  for (const [id, card] of wanted) {
    if (fs.existsSync(path.join(outDir, card.file))) { console.log(`${id}  ${card.file}  already drawn; kept`); continue; }
    await page.setContent(cardHtml(card), { waitUntil: 'networkidle' });
    const fonts = await page.evaluate(fontsLoaded, ['40px Anton', '700 17px Inter']);
    if (!fonts) { console.error(`${id}: Anton or Inter did not load; not drawn`); failed += 1; continue; }
    const size = await fitText(page, card.layout);
    if (!size) { console.error(`${id}: the words do not fit the card; shorten the piece`); failed += 1; continue; }
    // Clear corners: the card keeps its round shape in every mail app, Outlook too.
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT }, omitBackground: true });
    const png = await sharp(shot).png({ palette: true, quality: 95, effort: 10, compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(path.join(outDir, card.file), png, { flag: 'wx' });
    console.log(`${id}  ${card.file}  ${card.layout}  big ${size}px  ${Math.round(png.length / 1024)} KB`);
  }
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
