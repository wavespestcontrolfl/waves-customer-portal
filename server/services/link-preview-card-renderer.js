// =============================================================================
// Per-link Open Graph preview card renderer — 1200x630 branded JPEG for the
// customer-portal token routes (report, estimate, appointment, pay, ...).
//
// A SEPARATE module from social-card-renderer.js (those are the Instagram /
// Facebook / GBP post cards and stay untouched); it borrows only the brand
// palette and the shared logo loader so a logo swap still propagates here.
//
// Text is drawn as vector outlines from font files shipped in
// server/assets/fonts (Anton + Montserrat, both SIL OFL), not as SVG <text>:
// the server image has no brand fonts installed, so <text> silently fell
// back to a generic face in production. Outlines render identically on
// every host.
// =============================================================================

const path = require('path');
const { COLORS, getLogoPngBuffer } = require('./social-card-renderer');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
let fonts = null;
function loadFonts() {
  if (fonts) return fonts;
  const fontkit = require('fontkit');
  const anton = fontkit.openSync(path.join(FONT_DIR, 'Anton-Regular.ttf'));
  const montserrat = fontkit.openSync(path.join(FONT_DIR, 'Montserrat-Variable.ttf'));
  fonts = {
    headline: anton,
    eyebrow: montserrat.getVariation({ wght: 800 }),
    subline: montserrat.getVariation({ wght: 600 }),
  };
  return fonts;
}

function cleanText(value, max = 300) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// One line of text as SVG path data at `size` px, baseline at y=0.
function outline(font, text, size, tracking = 0) {
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  let x = 0;
  const parts = [];
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    parts.push(glyph.path.scale(scale, -scale).translate(x + pos.xOffset * scale, -pos.yOffset * scale).toSVG());
    x += pos.xAdvance * scale + tracking;
  });
  return { d: parts.join(''), width: Math.max(0, x - tracking) };
}

// Greedy word wrap by measured width; null when it needs more than maxLines.
function wrapMeasured(font, text, size, maxW, maxLines) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || outline(font, candidate, size).width <= maxW) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length <= maxLines ? lines : null;
}

// Largest headline size (phone thumbnails show this card at ~1/4 scale, so
// bigger is better) that still fits in two lines.
function fitHeadline(font, text, maxW) {
  for (const size of [150, 132, 116, 100, 88, 76]) {
    const lines = wrapMeasured(font, text, size, maxW, 2);
    if (lines) return { size, lines };
  }
  return { size: 64, lines: (wrapMeasured(font, text, 64, maxW, 99) || [text]).slice(0, 2) };
}

// Renders the card SVG (everything but the logo, which is composited on top).
// Input is ALWAYS deterministic, privacy-scrubbed content the caller
// resolved — this module never talks to the database.
function renderLinkPreviewSvg({ eyebrow, headline, subline } = {}) {
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const f = loadFonts();
  const x = 80;
  const textW = 580;

  const eyebrowText = cleanText(eyebrow, 40).toUpperCase() || 'WAVES PEST CONTROL';
  const headlineText = (cleanText(headline, 80) || 'Waves Pest Control').toUpperCase();
  const sublineText = cleanText(subline, 120);

  const eb = outline(f.eyebrow, eyebrowText, 30, 2.5);
  const hl = fitHeadline(f.headline, headlineText, textW);
  const slSize = 44;
  // "October 2, 2026 · 9:00 AM - 11:00 AM" reads better as a date line and
  // a time line than wrapped mid-range, when each part fits on its own.
  const parts = sublineText.split(' · ');
  const partsFit = parts.length === 2 && parts.every((part) => outline(f.subline, part, slSize).width <= textW + 40);
  const slLines = !sublineText ? []
    : partsFit ? parts
      : (wrapMeasured(f.subline, sublineText, slSize, textW + 40, 2) || [sublineText]);

  const pillH = 60;
  const pillW = Math.round(eb.width + 56);
  const hlLead = hl.size;
  const slLead = slSize * 1.25;
  const gapAfterPill = 34;
  const gapAfterHeadline = 20;
  const waveBand = 60;
  const blockH = pillH + gapAfterPill + hl.lines.length * hlLead
    + (slLines.length ? gapAfterHeadline + slLines.length * slLead : 0);
  const top = Math.round((H - waveBand - blockH) / 2) + 4;

  const shapes = [
    `<rect x="${x}" y="${top}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${COLORS.gold}"/>`,
    `<path transform="translate(${x + 28} ${top + pillH / 2 + 11})" d="${eb.d}" fill="${COLORS.blueDeeper}"/>`,
  ];
  let y = top + pillH + gapAfterPill;
  for (const text of hl.lines) {
    shapes.push(`<path transform="translate(${x} ${Math.round(y + hlLead * 0.86)})" d="${outline(f.headline, text, hl.size).d}" fill="${COLORS.white}"/>`);
    y += hlLead;
  }
  y += gapAfterHeadline;
  for (const text of slLines) {
    shapes.push(`<path transform="translate(${x} ${Math.round(y + slLead * 0.8)})" d="${outline(f.subline, text, slSize).d}" fill="#BFE9FB"/>`);
    y += slLead;
  }

  const { cx, cy, r } = badgeGeometry();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.blueDeeper}"/><stop offset="1" stop-color="${COLORS.blueDark}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <path d="M0 ${H - 66} C 200 ${H - 116}, 400 ${H - 16}, 600 ${H - 66} S 1000 ${H - 116}, 1200 ${H - 66} L1200 ${H} L0 ${H} Z" fill="${COLORS.wavesBlue}" opacity="0.6"/>
    <path d="M0 ${H - 30} C 220 ${H - 72}, 420 ${H + 8}, 640 ${H - 30} S 1020 ${H - 72}, 1200 ${H - 30} L1200 ${H} L0 ${H} Z" fill="${COLORS.sky}" opacity="0.55"/>
    <circle cx="${cx}" cy="${cy}" r="${r + 12}" fill="${COLORS.gold}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS.white}"/>
    ${shapes.join('\n    ')}
  </svg>`;
}

function badgeGeometry() {
  const r = 190;
  return { r, cx: OG_WIDTH - 84 - r, cy: Math.round((OG_HEIGHT - 40) / 2) };
}

async function renderLinkPreviewJpeg(content = {}) {
  const sharp = require('sharp');
  const layers = [];
  const logoBuf = await getLogoPngBuffer();
  if (logoBuf) {
    const size = 300;
    const logo = await sharp(logoBuf)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png().toBuffer();
    const { cx, cy } = badgeGeometry();
    layers.push({ input: logo, left: Math.round(cx - size / 2), top: Math.round(cy - size / 2) });
  }
  return sharp(Buffer.from(renderLinkPreviewSvg(content)))
    .composite(layers)
    .jpeg({ quality: 86, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

module.exports = {
  OG_WIDTH,
  OG_HEIGHT,
  renderLinkPreviewSvg,
  renderLinkPreviewJpeg,
};
