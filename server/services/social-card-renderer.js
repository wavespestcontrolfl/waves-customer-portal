const fs = require('fs');
const path = require('path');

// =============================================================================
// Brand-accurate social card renderer (deterministic SVG -> JPEG via sharp).
// Palette + type mirror client/src/theme-brand.js (the live wavespestcontrol.com
// brand): Waves Blue + Gold on a warm Sand ground, navy headings, and the
// gold-pill / navy-offset-shadow CTA identity. NOT the admin monochrome, and
// explicitly NO teal (the brand brief forbids it).
//
// Per-platform sizing: Instagram/Facebook feed photos are square (1080x1080);
// Google Business Profile favors 4:3 (1200x900). Pass { platform } to pick.
// =============================================================================

const COLORS = {
  wavesBlue: '#009CDE',
  blueDark: '#065A8C',
  blueDeeper: '#1B2C5B',
  blueLight: '#E3F5FD',
  sky: '#4DC9F6',
  gold: '#FFD700',
  goldHover: '#FFF176',
  sand: '#FEF7E0',
  navy: '#0F172A',
  textBody: '#334155',
  textCaption: '#64748B',
  border: '#E2E8F0',
  white: '#FFFFFF',
  green: '#16A34A',
  red: '#C8102E',
  star: '#FFC400',
};

// Font stacks: name the brand faces first (Anton display / Montserrat heading /
// Inter body) so they apply wherever fontconfig has them, with condensed/strong
// fallbacks for environments that don't (sharp's librsvg falls back to DejaVu).
const FONTS = {
  display: "'Anton','Oswald','Bebas Neue','Arial Narrow Bold','DejaVu Sans',sans-serif",
  heading: "'Montserrat','Inter','DejaVu Sans',Arial,sans-serif",
  body: "'Inter','DejaVu Sans',Arial,Helvetica,sans-serif",
};

// Recommended output dimensions per destination.
const PLATFORM_SIZES = {
  square: { w: 1080, h: 1080 },     // Instagram / Facebook feed photo (1:1)
  instagram: { w: 1080, h: 1080 },
  facebook: { w: 1080, h: 1080 },
  gbp: { w: 1200, h: 900 },         // Google Business Profile post (4:3)
  landscape: { w: 1200, h: 900 },
};
const CARD_SIZE = PLATFORM_SIZES.square.w; // back-compat export

function resolveSize(platform) {
  return PLATFORM_SIZES[String(platform || 'square').toLowerCase()] || PLATFORM_SIZES.square;
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function escapeXml(value) {
  return cleanText(value, 4000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(value, maxChars, maxLines = 6) {
  const text = cleanText(value, 1200);
  if (!text) return [];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:!?]*$/, '').slice(0, Math.max(0, maxChars - 3)).trim()}...`;
  }
  return lines;
}

// Conservative chars-per-line for a given width/size. Uses a wide width factor
// (DejaVu Sans is sharp/librsvg's Linux fallback and is wider than the brand
// faces) so cards NEVER overflow on the deploy target — narrower fonts just
// leave extra right margin.
function fitChars(availW, size, factor = 0.56) {
  return Math.max(8, Math.floor(availW / (size * factor)));
}

function textBlock(lines, { x, y, size, weight = 500, fill = COLORS.textBody, lineHeight = 1.25, family = FONTS.body, anchor = 'start', spacing = 0 }) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + (index * size * lineHeight)}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}">${escapeXml(line)}</text>`
  )).join('');
}

// Eyebrow pill — small uppercase label in a solid rounded chip.
function eyebrow(label, x, y, fill = COLORS.wavesBlue) {
  const safe = cleanText(label, 60).toUpperCase();
  const width = Math.max(180, Math.min(560, 48 + (safe.length * 13)));
  return `
    <rect x="${x}" y="${y}" width="${width}" height="50" rx="25" fill="${fill}"/>
    <text x="${x + 26}" y="${y + 33}" font-family="${FONTS.heading}" font-size="19" font-weight="700" fill="${COLORS.white}" letter-spacing="1.5">${escapeXml(safe)}</text>
  `;
}

// Brand CTA — gold pill, navy text, navy offset shadow + 2px navy border (the
// .btn identity from theme-brand). UPPERCASE per brand.
function ctaButton(label, x, y) {
  const safe = cleanText(label, 40).toUpperCase();
  const width = Math.max(280, Math.min(620, 60 + (safe.length * 17)));
  const h = 76;
  return `
    <rect x="${x + 6}" y="${y + 6}" width="${width}" height="${h}" rx="14" fill="${COLORS.blueDeeper}"/>
    <rect x="${x}" y="${y}" width="${width}" height="${h}" rx="14" fill="${COLORS.gold}" stroke="${COLORS.blueDeeper}" stroke-width="2.5"/>
    <text x="${x + width / 2}" y="${y + 50}" text-anchor="middle" font-family="${FONTS.heading}" font-size="27" font-weight="800" fill="${COLORS.blueDeeper}" letter-spacing="0.5">${escapeXml(safe)}</text>
  `;
}

// Decorative brand wave (gold over blue), bottom-right flourish.
function waveMotif(cx, cy, scale = 1) {
  const s = scale;
  return `
    <g opacity="0.9" transform="translate(${cx} ${cy}) scale(${s})">
      <path d="M-90 28 C-50 -16, -16 -16, 0 20 C16 -16, 50 -16, 90 28" fill="none" stroke="${COLORS.wavesBlue}" stroke-width="14" stroke-linecap="round" opacity="0.45"/>
      <path d="M-78 56 C-44 16, -12 16, 4 48 C20 16, 52 16, 86 56" fill="none" stroke="${COLORS.gold}" stroke-width="14" stroke-linecap="round"/>
    </g>
  `;
}

// Shared card chrome: sand ground, white rounded panel, blue left rail, logo,
// city/service line, footer URL. Returns { svg, box } where box is the safe
// content rectangle.
function chrome({ W, H, city, service, logoDataUri }) {
  const M = Math.round(W * 0.037);
  const panelX = M;
  const panelY = M;
  const panelW = W - M * 2;
  const panelH = H - M * 2;
  const railW = 16;
  const padL = panelX + railW + 44;
  const padR = panelX + panelW - 44;

  const cityLabel = cleanText(city, 60).toUpperCase();
  const serviceLabel = cleanText(service, 70);

  const logoSize = Math.round(H * 0.135);
  const logoX = panelX + panelW - logoSize - 36;
  const logoY = panelY + 30;
  const logo = logoDataUri
    ? `<image x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" href="${logoDataUri}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${panelX + panelW - 36}" y="${logoY + 56}" text-anchor="end" font-family="${FONTS.display}" font-size="48" font-weight="800" fill="${COLORS.blueDeeper}" letter-spacing="1">WAVES</text>`;

  const svg = `
    <rect width="${W}" height="${H}" fill="${COLORS.sand}"/>
    <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="34" fill="${COLORS.white}" stroke="${COLORS.border}" stroke-width="2"/>
    <rect x="${panelX}" y="${panelY}" width="${railW}" height="${panelH}" rx="8" fill="${COLORS.wavesBlue}"/>
    ${logo}
    ${cityLabel ? `<text x="${padL}" y="${panelY + 66}" font-family="${FONTS.display}" font-size="34" font-weight="800" fill="${COLORS.blueDeeper}" letter-spacing="1">${escapeXml(cityLabel)}</text>` : ''}
    ${serviceLabel ? `<text x="${padL}" y="${panelY + 98}" font-family="${FONTS.body}" font-size="20" font-weight="600" fill="${COLORS.textCaption}">${escapeXml(serviceLabel)}</text>` : ''}
    <text x="${padL}" y="${panelY + panelH - 40}" font-family="${FONTS.body}" font-size="22" font-weight="700" fill="${COLORS.wavesBlue}">wavespestcontrol.com</text>
  `;
  return { svg, box: { panelX, panelY, panelW, panelH, padL, padR, railW } };
}

function renderCampaignSvg(input = {}, logoDataUri = null) {
  const { w: W, h: H } = resolveSize(input.platform);
  const city = cleanText(input.city || input.location, 60);
  const topic = cleanText(input.topic || input.title || 'Seasonal pest pressure', 150);
  const service = cleanText(input.service || 'Pest control', 70);
  const detail = cleanText(input.detail || input.fact || input.description, 360)
    || 'Local pest pressure changes quickly with Florida heat, rain, and property conditions.';
  const cta = cleanText(input.cta || 'Schedule an inspection', 40);

  const { svg: frame, box } = chrome({ W, H, city, service, logoDataUri });
  const availW = box.padR - box.padL;
  // Size the headline to the copy length, then wrap conservatively.
  const titleSize = topic.length > 38 ? Math.round(W * 0.056) : Math.round(W * 0.066);
  const titleLines = wrapText(topic, fitChars(availW, titleSize, 0.60), H >= 1000 ? 4 : 3);
  const eyebrowY = box.panelY + 128;
  // Anchor the title BELOW the eyebrow (not by card height) so the 4:3 GBP card
  // doesn't ride the headline up into the pill.
  const titleY = eyebrowY + 50 + Math.round(titleSize * 0.92);
  const detailSize = Math.round(W * 0.03);
  const detailLines = wrapText(detail, fitChars(availW, detailSize, 0.52), H >= 1000 ? 4 : 3);
  const detailY = titleY + (titleLines.length * titleSize * 1.06) + 58;
  const ctaY = box.panelY + box.panelH - 150;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${eyebrow('Local pest pressure', box.padL, eyebrowY, COLORS.wavesBlue)}
      ${textBlock(titleLines, { x: box.padL, y: titleY, size: titleSize, weight: 800, fill: COLORS.blueDeeper, family: FONTS.display, lineHeight: 1.06 })}
      <line x1="${box.padL}" y1="${detailY - 42}" x2="${box.padR - 180}" y2="${detailY - 42}" stroke="${COLORS.blueLight}" stroke-width="4"/>
      ${textBlock(detailLines, { x: box.padL, y: detailY, size: Math.round(W * 0.03), weight: 500, fill: COLORS.textBody, family: FONTS.body, lineHeight: 1.34 })}
      ${ctaButton(cta, box.padL, ctaY)}
      ${waveMotif(box.padR - 60, ctaY + 30, W / 1080)}
    </svg>
  `;
}

function renderReviewSvg(input = {}, logoDataUri = null) {
  const { w: W, h: H } = resolveSize(input.platform);
  const city = cleanText(input.city || input.location, 60);
  const reviewer = cleanText(input.reviewerDisplayName || input.reviewer || `Waves customer${city ? `, ${city}` : ''}`, 100);
  const excerpt = cleanText(input.excerpt || input.reviewText || 'Helpful, professional, and local service.', 420);
  const service = cleanText(input.service || 'Customer review', 70);

  const { svg: frame, box } = chrome({ W, H, city, service, logoDataUri });
  const availW = box.padR - box.padL;
  // Pick a size that keeps the quote to ~6 lines, then wrap conservatively.
  const quoteSize = excerpt.length > 180 ? Math.round(W * 0.038) : Math.round(W * 0.045);
  const quoteLines = wrapText(`“${excerpt}”`, fitChars(availW, quoteSize, 0.56), 6);

  // Eyebrow, then a clear row of stars BELOW it (no overlap).
  const eyebrowY = box.panelY + 118;
  const starsY = eyebrowY + 92;
  const stars = [0, 1, 2, 3, 4].map((i) => (
    `<path transform="translate(${box.padL + 20 + i * 50} ${starsY})" d="M0 -18 L5.3 -5.5 L18.6 -5.5 L7.9 2.9 L12 15.7 L0 7.9 L-12 15.7 L-7.9 2.9 L-18.6 -5.5 L-5.3 -5.5 Z" fill="${COLORS.star}"/>`
  )).join('');

  // Vertically center the quote block between the stars and the reviewer footer.
  const topAnchor = starsY + 56;
  const bottomAnchor = box.panelY + box.panelH - 168;
  const blockH = quoteLines.length * quoteSize * 1.3;
  const quoteY = Math.round(topAnchor + Math.max(0, (bottomAnchor - topAnchor - blockH) / 2)) + quoteSize;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${eyebrow('5-star Google review', box.padL, eyebrowY, COLORS.green)}
      ${stars}
      ${textBlock(quoteLines, { x: box.padL, y: quoteY, size: quoteSize, weight: 700, fill: COLORS.blueDeeper, family: FONTS.heading, lineHeight: 1.3 })}
      <line x1="${box.padL}" y1="${box.panelY + box.panelH - 150}" x2="${box.padR - 120}" y2="${box.panelY + box.panelH - 150}" stroke="${COLORS.blueLight}" stroke-width="4"/>
      <text x="${box.padL}" y="${box.panelY + box.panelH - 104}" font-family="${FONTS.display}" font-size="${Math.round(W * 0.03)}" font-weight="800" fill="${COLORS.blueDeeper}" letter-spacing="0.5">${escapeXml(reviewer)}</text>
      <text x="${box.padL}" y="${box.panelY + box.panelH - 72}" font-family="${FONTS.body}" font-size="20" font-weight="600" fill="${COLORS.textCaption}">Verified Google review · privacy-safe display</text>
      ${waveMotif(box.padR - 60, box.panelY + box.panelH - 96, W / 1080)}
    </svg>
  `;
}

function renderSocialCardSvg(input = {}, logoDataUri = null) {
  return input.variant === 'review'
    ? renderReviewSvg(input, logoDataUri)
    : renderCampaignSvg(input, logoDataUri);
}

// Load + downscale the brand logo once, cached. librsvg renders <image> data
// URIs reliably (unlike @font-face), so the real mark always appears.
let _logoPromise = null;
function getLogoDataUri() {
  if (_logoPromise) return _logoPromise;
  _logoPromise = (async () => {
    const candidates = [
      path.join(__dirname, '..', '..', 'client', 'public', 'waves-logo-2026.png'),
      path.join(__dirname, '..', '..', 'client', 'dist', 'waves-logo-2026.png'),
      path.join(__dirname, '..', 'assets', 'waves-logo-2026.png'),
    ];
    try {
      const sharp = require('sharp');
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const buf = await sharp(p).resize(260, 260, { fit: 'inside' }).png().toBuffer();
          return `data:image/png;base64,${buf.toString('base64')}`;
        }
      }
    } catch { /* fall through to text wordmark */ }
    return null;
  })();
  return _logoPromise;
}

async function renderSocialCardJpegBase64(input = {}, opts = {}) {
  const sharp = require('sharp');
  const platform = opts.platform || input.platform;
  const logoDataUri = await getLogoDataUri();
  const svg = renderSocialCardSvg({ ...input, platform }, logoDataUri);
  const buffer = await sharp(Buffer.from(svg))
    .jpeg({ quality: 82, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
  return buffer.toString('base64');
}

function filenameSlug(value, fallback = 'social-card') {
  const slug = cleanText(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

module.exports = {
  CARD_SIZE,
  COLORS,
  PLATFORM_SIZES,
  filenameSlug,
  renderSocialCardJpegBase64,
  renderSocialCardSvg,
  wrapText,
};
