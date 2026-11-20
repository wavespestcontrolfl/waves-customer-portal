/**
 * pest-insider-parts.js — MUTATES (dry-run default; no database, no send): draws the Pest Insider part pictures
 *
 * Draws every part picture in server/data/pest-insider-parts-v1.json
 * (checked by server/services/pest-insider/parts.js) as a 582x340 picture at
 * 2x: the heading, then one or two panels, each a cropped photo (or a
 * diagram) with each part circled and labeled. It writes
 * client/public/pest-insider/parts/<id>-<hash>.jpg, where the portal serves
 * it to email readers. Run it on a Mac after any change to the parts file,
 * a photo or the drawing, then commit the pictures with the change.
 *
 *   node ops/agents/pest-insider-parts.js [--execute] [--out <dir>] [--only T03,earwig]
 *
 *     (none)        dry run: lists each picture's file and whether it is drawn yet
 *     --execute     draw the pictures whose file is not there yet
 *     --out <dir>   the folder to draw into (a preview) instead of the portal's
 *     --only ids    only these facts or species
 *
 * The photos live in ops/agents/pest-insider-photos/. A photo whose bytes do
 * not match its sha16 in the parts file, or a crop that does not fit the
 * photo, stops that picture. A picture is written under a temporary name and
 * hard-linked to its own name only when whole. A file, once drawn, is never
 * drawn again, changed or removed: a sent email and the issue archive keep
 * the exact picture URLs they were sent with. A picture that must look
 * different gets a new name (its words, photo or marks change, or
 * PART_DESIGN is bumped); an old file stays until a person removes it, once
 * no sent issue uses it.
 *
 * The drawing uses Anton and Inter from font files the portal ships
 * (pest-insider-fonts.js), so it needs no network. A picture is refused when
 * either font did not load, or when its heading does not fit one line. The
 * frame, circles, lines and labels use Waves colors only (cards.js
 * WAVES_COLORS). Change the drawing below -> bump PART_DESIGN in parts.js,
 * so every picture gets a new file name and the test asks for new pictures.
 */
/* global document */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

for (const name of Object.keys(process.env)) {
  if (/^(DATABASE_|POSTGRES_|PG[A-Z]+$)/.test(name)) delete process.env[name];
}
process.env.WAVES_LOCAL_DEV = '1';

const { chromium } = require('playwright');
const sharp = require('sharp');
const { PARTS, PART_DIR, PHOTO_DIR, PART_WIDTH, PART_HEIGHT } = require('../../server/services/pest-insider/parts');
const { WAVES_COLORS: C } = require('../../server/services/pest-insider/cards');
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
const outDir = path.resolve(cli.values['--out'] || path.join(repoRoot, PART_DIR));
const photoDir = path.join(repoRoot, PHOTO_DIR);
const execute = cli.execute;
const only = cli.values['--only'] === undefined ? null : new Set(cli.values['--only'].split(',').map((s) => s.trim()).filter(Boolean));
if (only && !only.size) { console.error('--only needs fact ids or species slugs, such as --only T03,earwig'); process.exit(2); }

// The frame and the type, in picture pixels. Labels are 15px so they stay
// readable on a phone, where the picture shows at about 60% size.
const FRAME = Object.freeze({ padTop: 14, padSide: 8, headSize: 26, headMin: 16, gap: 8, labelSize: 15, labelPad: 12, pillHeight: 28 });

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
function publish(dir, file, bytes) {
  const temp = path.join(dir, `.${file}.${process.pid}.tmp`);
  fs.writeFileSync(temp, bytes, { flag: 'wx' });
  try {
    fs.linkSync(temp, path.join(dir, file));
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Diagrams in Waves colors, for a part no free photo shows (parts.js DIAGRAMS).
const DIAGRAMS = {
  // L02: a flat leaf blade, an arrow, and the same blade folded in half
  // lengthwise: half as wide, its far half tucked behind, the fold in gold.
  'folded-blade': ([w, h]) => {
    const flat = 150;
    const folded = 410;
    const blade = (cx, half) => `M ${cx - half} ${h + 4} C ${cx - half} ${h - 110}, ${cx - half + 2} 80, ${cx} 30 C ${cx + half - 2} 80, ${cx + half} ${h - 110}, ${cx + half} ${h + 4} Z`;
    const halfBlade = (side) => `M ${folded} ${h + 4} L ${folded} 30 C ${folded + side * 15} 80, ${folded + side * 17} ${h - 110}, ${folded + side * 17} ${h + 4} Z`;
    return `<rect width="${w}" height="${h}" fill="${C.white}"/>`
      + `<path d="${blade(flat, 34)}" fill="${C.wavesBlue}" stroke="${C.navy}" stroke-width="3"/>`
      + `<line x1="${flat}" y1="60" x2="${flat}" y2="${h + 4}" stroke="${C.navy}" stroke-width="2" opacity="0.55"/>`
      + `<path d="${halfBlade(1)}" fill="${C.navy}"/>`
      + `<path d="${halfBlade(-1)}" fill="${C.wavesBlue}" stroke="${C.navy}" stroke-width="3"/>`
      + `<line x1="${folded}" y1="36" x2="${folded}" y2="${h + 4}" stroke="${C.gold}" stroke-width="4"/>`
      + `<path d="M ${flat + 70} ${h / 2} L ${folded - 70} ${h / 2}" stroke="${C.navy}" stroke-width="5" stroke-dasharray="2 10" stroke-linecap="round"/>`
      + `<path d="M ${folded - 82} ${h / 2 - 12} L ${folded - 64} ${h / 2} L ${folded - 82} ${h / 2 + 12}" fill="none" stroke="${C.navy}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  },
};

// A ring in navy and gold, readable on light and dark photos.
const ring = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${C.navy}" stroke-width="5"/><circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${C.gold}" stroke-width="2.5"/>`;

// A line from the label's nearer long edge to the ring's edge; none when they touch.
function leader([x, y], r, [px, py], pw) {
  const sx = Math.max(px + 12, Math.min(px + pw - 12, x));
  const sy = y > py + FRAME.pillHeight / 2 ? py + FRAME.pillHeight : py;
  const d = Math.hypot(x - sx, y - sy);
  if (d <= r + 4) return '';
  const ex = (x - ((x - sx) / d) * r).toFixed(1);
  const ey = (y - ((y - sy) / d) * r).toFixed(1);
  const line = (color, width) => `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  return line(C.navy, 4) + line(C.gold, 2);
}

// Each mark: its rings, a line from the label to each ring, and the label.
// pillWidth(label) is the label's measured width plus its padding.
function marksSvg(marks, pillWidth) {
  return marks.map((mark) => {
    const pw = pillWidth(mark.label);
    const [px, py] = mark.pill;
    const rings = mark.at.map((spot) => leader(spot, mark.r, mark.pill, pw) + ring(spot[0], spot[1], mark.r)).join('');
    return `${rings}<rect x="${px}" y="${py}" width="${pw}" height="${FRAME.pillHeight}" rx="${FRAME.pillHeight / 2}" fill="${C.navy}"/>`
      + `<text x="${px + pw / 2}" y="${py + FRAME.pillHeight / 2}" text-anchor="middle" dominant-baseline="central" font-family="Inter" font-weight="800" font-size="${FRAME.labelSize}" fill="${C.white}">${esc(mark.label)}</text>`;
  }).join('');
}

// A label must sit inside its panel: the pill's far edge too.
function pillProblem(panel, [w, h], pillWidth) {
  const out = panel.marks.find((mark) => mark.pill[0] + pillWidth(mark.label) > w || mark.pill[1] + FRAME.pillHeight > h);
  return out ? `the label "${out.label}" runs past the panel's edge; move its pill` : null;
}

// A panel's photo, checked against its sha16, turned, cropped and sized at 2x.
async function photoUri(panel, [w, h]) {
  const bytes = fs.readFileSync(path.join(photoDir, panel.photo));
  if (crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16) !== panel.sha16) throw new Error(`${panel.photo} does not match its sha16 in the parts file`);
  const turned = await sharp(bytes).rotate(panel.rotate || 0).toBuffer();
  const { width, height } = await sharp(turned).metadata();
  const [left, top, cw, ch] = panel.crop;
  if (left + cw > width || top + ch > height) throw new Error(`the crop of ${panel.photo} runs past the photo (${width}x${height})`);
  const jpeg = await sharp(turned).extract({ left, top, width: cw, height: ch }).resize(w * 2, h * 2).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

async function pictureHtml(picture, fonts, pillWidth) {
  const [w, h] = picture.size;
  const panels = await Promise.all(picture.panels.map(async (panel) => {
    const art = panel.photo ? `<img src="${await photoUri(panel, picture.size)}" width="${w}" height="${h}" alt="">` : '';
    const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${panel.diagram ? DIAGRAMS[panel.diagram](picture.size) : ''}${marksSvg(panel.marks, pillWidth)}</svg>`;
    return `<div>${panel.name ? `<div class="name">${esc(panel.name)}</div>` : ''}<div class="ph" style="width:${w}px;height:${h}px">${art}${svg}</div></div>`;
  }));
  return `<!doctype html><html><head><meta charset="utf-8">
${fonts}
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .f { box-sizing: border-box; width: ${PART_WIDTH}px; height: ${PART_HEIGHT}px; overflow: hidden;
    padding: ${FRAME.padTop}px ${FRAME.padSide}px 0; background: ${C.lightBlue}; box-shadow: inset 0 0 0 2px ${C.rule};
    color: ${C.navy}; font-family: Inter, sans-serif; }
  .head { font: 400 ${FRAME.headSize}px/28px Anton, sans-serif; text-transform: uppercase; padding: 0 8px 10px; white-space: nowrap; }
  .row { display: flex; gap: ${FRAME.gap}px; justify-content: center; }
  .name { font: 400 20px/22px Anton, sans-serif; text-transform: uppercase; padding: 0 2px; }
  .ph { position: relative; border-radius: 10px; overflow: hidden; }
  .ph img, .ph svg { position: absolute; left: 0; top: 0; display: block; }
</style></head><body>
<div class="f"><div class="head">${esc(picture.heading)}</div><div class="row">${panels.join('')}</div></div>
</body></html>`;
}

// Each label's width in the label font, measured once the font has loaded.
async function labelWidths(page, labels) {
  return page.evaluate(({ list, font }) => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = font;
    return Object.fromEntries(list.map((label) => [label, Math.ceil(ctx.measureText(label).width)]));
  }, { list: labels, font: `800 ${FRAME.labelSize}px Inter` });
}

// Largest heading type that fits one line; null when none does.
async function fitHeading(page) {
  return page.evaluate(({ start, min }) => {
    const head = document.querySelector('.head');
    for (let size = start; size >= min; size -= 1) {
      head.style.fontSize = `${size}px`;
      if (head.scrollWidth <= head.clientWidth) return size;
    }
    return null;
  }, { start: FRAME.headSize, min: FRAME.headMin });
}

(async () => {
  const pictures = Object.values(PARTS).flatMap((map) => Object.entries(map)).filter(([, entry]) => entry.picture);
  const known = new Set(Object.values(PARTS).flatMap((map) => Object.keys(map)));
  const unknown = only ? [...only].filter((id) => !known.has(id)) : [];
  if (unknown.length) { console.error(`No parts entry for ${unknown.join(', ')}; nothing drawn.`); process.exit(2); }
  const wanted = pictures.filter(([id]) => !only || only.has(id));
  // An entry whose list names no part has no picture to draw.
  if (only) for (const id of only) if (!wanted.some(([wantedId]) => wantedId === id)) console.log(`${id}  no picture: its list names no part to show`);
  const drawn = (file) => fs.existsSync(path.join(outDir, file));
  if (!execute || !wanted.length) {
    for (const [id, { picture }] of wanted) console.log(`${id}  ${picture.file}  ${drawn(picture.file) ? 'drawn' : 'would draw'}`);
    if (!execute) console.log(`Dry run: nothing written. Add --execute to draw into ${outDir}.`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const fontCss = fontStyle([800]);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: PART_WIDTH, height: PART_HEIGHT }, deviceScaleFactor: 2 });
  const fontsCheck = ['26px Anton', `800 ${FRAME.labelSize}px Inter`];
  // Label widths come from the real font, so each pill fits its words.
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">${fontCss}</head><body></body></html>`, { waitUntil: 'networkidle' });
  if (!(await page.evaluate(fontsLoaded, fontsCheck))) { console.error('Anton or Inter did not load; nothing drawn'); await browser.close(); process.exit(1); }
  const labels = [...new Set(wanted.flatMap(([, { picture }]) => picture.panels.flatMap((panel) => panel.marks.map((mark) => mark.label))))];
  const widths = await labelWidths(page, labels);
  const pillWidth = (label) => widths[label] + 2 * FRAME.labelPad;
  let failed = 0;
  for (const [id, { picture }] of wanted) {
    if (drawn(picture.file)) { console.log(`${id}  ${picture.file}  already drawn; kept`); continue; }
    const problem = picture.panels.map((panel) => pillProblem(panel, picture.size, pillWidth)).find(Boolean);
    if (problem) { console.error(`${id}: ${problem}; not drawn`); failed += 1; continue; }
    let html;
    try { html = await pictureHtml(picture, fontCss, pillWidth); } catch (e) { console.error(`${id}: ${e.message}; not drawn`); failed += 1; continue; }
    await page.setContent(html, { waitUntil: 'networkidle' });
    if (!(await page.evaluate(fontsLoaded, fontsCheck))) { console.error(`${id}: Anton or Inter did not load; not drawn`); failed += 1; continue; }
    const size = await fitHeading(page);
    if (!size) { console.error(`${id}: the heading does not fit one line; shorten it`); failed += 1; continue; }
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: PART_WIDTH, height: PART_HEIGHT }, omitBackground: true });
    // A JPEG has no clear corners, so the frame is square: the email rounds
    // it where the mail app can (render.js), and Outlook shows it square.
    const jpeg = await sharp(shot).flatten({ background: C.lightBlue }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    publish(outDir, picture.file, jpeg);
    console.log(`${id}  ${picture.file}  heading ${size}px  ${Math.round(jpeg.length / 1024)} KB`);
  }
  await browser.close();
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
