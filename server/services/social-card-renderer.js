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

// Star row depicting a REAL average: each star is an outline, filled to the
// fractional share it represents (4.7 → four full, one 70%). Shared by the
// milestone card and its photo overlay so both tell the same truth; no
// average → no stars, so a card never implies a 5.0.
const STAR_PATH = 'M0 -18 L5.3 -5.5 L18.6 -5.5 L7.9 2.9 L12 15.7 L0 7.9 L-12 15.7 L-7.9 2.9 L-18.6 -5.5 L-5.3 -5.5 Z';
function ratingStars(x0, y, avg, { emptyFill = COLORS.white, idPrefix = 'star-clip' } = {}) {
  if (!Number.isFinite(avg) || avg <= 0) return '';
  return [0, 1, 2, 3, 4].map((i) => {
    const share = Math.max(0, Math.min(1, avg - i));
    const x = x0 + i * 50;
    const fillW = Math.round(37.2 * share * 10) / 10;
    return `
      <path transform="translate(${x} ${y})" d="${STAR_PATH}" fill="${emptyFill}" stroke="${COLORS.star}" stroke-width="2"/>
      ${share > 0 ? `<clipPath id="${idPrefix}-${i}"><rect x="${-18.6}" y="-20" width="${fillW}" height="40"/></clipPath>
      <path transform="translate(${x} ${y})" d="${STAR_PATH}" fill="${COLORS.star}" clip-path="url(#${idPrefix}-${i})"/>` : ''}
    `;
  }).join('');
}

// The VS badge: gold disc, navy ring, centred "VS".
function vsBadge(cx, cy, r = 44) {
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLORS.gold}" stroke="${COLORS.blueDeeper}" stroke-width="3"/>
    <text x="${cx}" y="${cy + Math.round(r * 0.28)}" text-anchor="middle" font-family="${FONTS.display}" font-size="${Math.round(r * 0.8)}" font-weight="800" fill="${COLORS.blueDeeper}">VS</text>
  `;
}

// Largest size in `sizes` at which `text` wraps into ≤ maxLines without
// truncation; falls back to the smallest size (truncated) so a runaway string
// still renders. Returns { size, lines }.
function fitText(text, availW, sizes, maxLines, factor = 0.56) {
  let last = null;
  for (const size of sizes) {
    const lines = wrapText(text, fitChars(availW, size, factor), maxLines);
    last = { size, lines };
    if (!lines.length || !lines[lines.length - 1].endsWith('...')) return last;
  }
  return last;
}

// Row-based versus layout shared by the text card and the photo overlay. Both
// columns are wrapped FIRST so the two names share one baseline and bullet i
// sits on the same row in both columns — a two-line name or point on one side
// pushes both sides down together instead of colliding with what's below.
function versusLayout({ left, right, colW, nameSize: baseNameSize, pointSize }) {
  // Prefer both names on ONE line (stepping the shared size down to ~70%)
  // before letting either wrap to two — a wrapped name is the exception for
  // long species names, not the default look.
  let nameSize = baseNameSize;
  let names = null;
  for (const step of [1, 0.86, 0.72]) {
    const size = Math.round(baseNameSize * step);
    const chars = fitChars(colW, size, 0.60);
    if ([left.name, right.name].every((name) => cleanText(name, 40).length <= chars)) {
      nameSize = size;
      names = [left.name, right.name].map((name) => wrapText(name, chars, 1));
      break;
    }
  }
  if (!names) names = [left.name, right.name].map((name) => wrapText(name, fitChars(colW, nameSize, 0.60), 2));
  const pointChars = fitChars(colW - Math.round(pointSize * 1.2), pointSize, 0.52);
  const rowCount = Math.max(left.points.length, right.points.length);
  const rows = [];
  for (let i = 0; i < rowCount; i += 1) {
    const cells = [left.points[i], right.points[i]].map((point) => (point ? wrapText(point, pointChars, 3) : []));
    const lineCount = Math.max(1, ...cells.map((c) => c.length));
    rows.push({ cells, h: Math.round(lineCount * pointSize * 1.22) + Math.round(pointSize * 0.9) });
  }
  const nameLineH = Math.round(nameSize * 1.06);
  const nameBlockH = Math.max(1, ...names.map((n) => n.length)) * nameLineH;
  const pointsH = rows.reduce((sum, row) => sum + row.h, 0);
  return { names, rows, nameSize, nameLineH, nameBlockH, pointsH, gap: Math.round(nameSize * 0.55) };
}

// Render a versusLayout at the given column x positions. `nameY` is the
// first name baseline; `stretchTo` (optional) is the height the point rows
// should fill, distributing the slack evenly so short points spread over a
// tile instead of huddling under the name.
function versusColumns(layout, { xs, nameY, pointSize, nameFills, pointFill, stretchTo = 0 }) {
  const slack = Math.max(0, stretchTo - layout.pointsH);
  const extra = layout.rows.length ? Math.floor(slack / layout.rows.length) : 0;
  let svg = layout.names.map((lines, i) => textBlock(lines, {
    x: xs[i], y: nameY, size: layout.nameSize, weight: 800, fill: nameFills[i], family: FONTS.display, lineHeight: 1.06,
  })).join('');
  let cursor = nameY + layout.nameBlockH - layout.nameLineH + layout.gap + pointSize;
  for (const row of layout.rows) {
    row.cells.forEach((lines, i) => {
      if (!lines.length) return;
      svg += `<circle cx="${xs[i] + Math.round(pointSize * 0.3)}" cy="${cursor - pointSize * 0.34}" r="${Math.round(pointSize * 0.22)}" fill="${COLORS.gold}"/>`;
      svg += textBlock(lines, { x: xs[i] + Math.round(pointSize * 1.1), y: cursor, size: pointSize, weight: 600, fill: pointFill, family: FONTS.body, lineHeight: 1.22 });
    });
    cursor += row.h + extra;
  }
  return svg;
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

// Blog-share card: brand frame with a "From the blog" eyebrow, the post title as
// the headline, an excerpt, and a read-more CTA. Used when autonomous blog posts
// are shared to social so they match the studio's branding (vs a generic image).
function renderBlogSvg(input = {}, logoDataUri = null) {
  const { w: W, h: H } = resolveSize(input.platform);
  const city = cleanText(input.city || input.location, 60);
  const title = cleanText(input.title || input.topic, 160) || 'New on the Waves blog';
  const service = cleanText(input.service, 70);
  const excerpt = cleanText(input.excerpt || input.detail || input.description, 360)
    || 'A new guide from the Waves team on keeping Southwest Florida homes and lawns protected.';
  const cta = cleanText(input.cta || 'Read the full guide', 40);

  const { svg: frame, box } = chrome({ W, H, city, service, logoDataUri });
  const availW = box.padR - box.padL;
  const titleSize = title.length > 38 ? Math.round(W * 0.054) : Math.round(W * 0.064);
  const titleLines = wrapText(title, fitChars(availW, titleSize, 0.60), H >= 1000 ? 4 : 3);
  const eyebrowY = box.panelY + 128;
  const titleY = eyebrowY + 50 + Math.round(titleSize * 0.92);
  const detailSize = Math.round(W * 0.03);
  const detailLines = wrapText(excerpt, fitChars(availW, detailSize, 0.52), H >= 1000 ? 4 : 3);
  const detailY = titleY + (titleLines.length * titleSize * 1.06) + 58;
  const ctaY = box.panelY + box.panelH - 150;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${eyebrow(cleanText(input.eyebrow, 40) || 'From the Waves blog', box.padL, eyebrowY, COLORS.blueDark)}
      ${textBlock(titleLines, { x: box.padL, y: titleY, size: titleSize, weight: 800, fill: COLORS.blueDeeper, family: FONTS.display, lineHeight: 1.06 })}
      <line x1="${box.padL}" y1="${detailY - 42}" x2="${box.padR - 180}" y2="${detailY - 42}" stroke="${COLORS.blueLight}" stroke-width="4"/>
      ${textBlock(detailLines, { x: box.padL, y: detailY, size: detailSize, weight: 500, fill: COLORS.textBody, family: FONTS.body, lineHeight: 1.34 })}
      ${ctaButton(cta, box.padL, ctaY)}
      ${waveMotif(box.padR - 60, ctaY + 30, W / 1080)}
    </svg>
  `;
}

// Versus card: side-by-side pest ID comparison (the "X vs Y" format local pest
// audiences engage with most). Two named columns of short diagnostic points, a
// center VS badge, and a one-line verdict. Deterministic text-only render — no
// pest imagery — so it is GBP-eligible (no AI imagery on GBP) by construction.
function renderVersusSvg(input = {}, logoDataUri = null) {
  const { w: W, h: H } = resolveSize(input.platform);
  const city = cleanText(input.city || input.location, 60);
  const service = cleanText(input.service, 70) || 'Pest ID';
  const left = input.left || {};
  const right = input.right || {};
  const leftName = cleanText(left.name, 40) || 'Pest A';
  const rightName = cleanText(right.name, 40) || 'Pest B';
  const leftPoints = (Array.isArray(left.points) ? left.points : []).slice(0, 3);
  const rightPoints = (Array.isArray(right.points) ? right.points : []).slice(0, 3);
  const verdict = cleanText(input.verdict, 120);

  const { svg: frame, box } = chrome({ W, H, city, service, logoDataUri });
  const S = Math.min(W, H) / 1080; // type scale — the 4:3 GBP card is shorter, not just wider
  const eyebrowY = box.panelY + 128;

  // Two tinted tiles fill the panel between the eyebrow and the verdict —
  // blue for the left pest, gold for the right — with the VS badge riding
  // the seam. Everything is sized from the tile, so three short points read
  // as a full card instead of a header over empty space.
  // Up to three lines: the bank's verdicts run to ~90 chars and the tiles
  // above give up height (the type-step loop below) rather than elide.
  const { size: verdictSize, lines: verdictLines } = fitText(
    verdict, box.padR - box.padL - 200, [58, 50, 42].map((s) => Math.round(s * S)), 3
  );
  const verdictBlockH = verdictLines.length ? Math.round(verdictLines.length * verdictSize * 1.18) : 0;
  const verdictBottom = box.panelY + box.panelH - 96;
  const tileY = eyebrowY + 78;
  const tileBottom = verdictLines.length ? verdictBottom - verdictBlockH - 54 : verdictBottom;
  const tileH = tileBottom - tileY;
  const seamGap = 22;
  const tileW = Math.round((box.padR - box.padL - seamGap) / 2);
  const tileX = [box.padL, box.padL + tileW + seamGap];
  const tilePad = Math.round(34 * S);
  const midX = box.padL + tileW + Math.round(seamGap / 2);

  // Type steps down until the two columns fit inside the tile.
  let nameSize; let pointSize; let layout;
  for (const step of [1, 0.9, 0.8, 0.7]) {
    nameSize = Math.round(56 * S * step);
    pointSize = Math.round(31 * S * step);
    layout = versusLayout({
      left: { name: leftName, points: leftPoints }, right: { name: rightName, points: rightPoints },
      colW: tileW - tilePad * 2, nameSize, pointSize,
    });
    if (layout.nameBlockH + layout.gap + layout.pointsH <= tileH - tilePad * 2) break;
  }
  const nameY = tileY + tilePad + layout.nameSize;
  const tiles = [COLORS.blueLight, '#FFF6CC'].map((fill, i) => (
    `<rect x="${tileX[i]}" y="${tileY}" width="${tileW}" height="${tileH}" rx="26" fill="${fill}"/>`
  )).join('');
  const columns = versusColumns(layout, {
    xs: tileX.map((x) => x + tilePad), nameY, pointSize,
    nameFills: [COLORS.blueDeeper, COLORS.blueDark], pointFill: COLORS.blueDeeper,
    stretchTo: tileH - tilePad * 2 - layout.nameBlockH - layout.gap,
  });

  const verdictY = verdictBottom - verdictBlockH + verdictSize;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${eyebrow('Pest ID: know the difference', box.padL, eyebrowY, COLORS.wavesBlue)}
      ${tiles}
      ${columns}
      ${vsBadge(midX, tileY, Math.round(44 * S))}
      ${verdictLines.length ? `<rect x="${box.padL}" y="${verdictY - verdictSize + Math.round(verdictSize * 0.12)}" width="10" height="${verdictBlockH}" rx="5" fill="${COLORS.gold}"/>` : ''}
      ${textBlock(verdictLines, { x: box.padL + 30, y: verdictY, size: verdictSize, weight: 800, fill: COLORS.blueDeeper, family: FONTS.display, lineHeight: 1.18 })}
      ${waveMotif(box.padR - 60, verdictBottom - 40, W / 1080)}
    </svg>
  `;
}

// Milestone card: a review-count celebration ("300 Google reviews") — the
// format local service companies get their best organic engagement on. Big
// number, star row with the real average, and a thank-you line. Deterministic
// text-only render (GBP-eligible; no AI imagery).
function renderMilestoneSvg(input = {}, logoDataUri = null) {
  const { w: W, h: H } = resolveSize(input.platform);
  const count = Math.max(0, Math.round(Number(input.count) || 0));
  const countLabel = count.toLocaleString('en-US');
  const avg = Number(input.averageRating);
  const avgLabel = Number.isFinite(avg) && avg > 0 ? `${avg.toFixed(1)} average rating` : '';
  const thanks = cleanText(input.thanks, 140) || 'Thank you, Southwest Florida.';
  const service = cleanText(input.service, 70) || 'Google reviews';

  const { svg: frame, box } = chrome({ W, H, city: input.city, service, logoDataUri });
  const eyebrowY = box.panelY + 128;
  const numberSize = Math.round(W * 0.2);
  const numberY = eyebrowY + 70 + numberSize;
  const labelSize = Math.round(W * 0.05);
  const labelY = numberY + Math.round(labelSize * 1.3);
  const starsY = labelY + Math.round(labelSize * 1.5);
  const stars = ratingStars(box.padL + 20, starsY, avg);
  const thanksY = box.panelY + box.panelH - 128;
  const thanksLines = wrapText(thanks, fitChars(box.padR - box.padL - 200, Math.round(W * 0.032), 0.56), 2);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${eyebrow('Milestone', box.padL, eyebrowY, COLORS.gold).replace(`fill="${COLORS.white}"`, `fill="${COLORS.blueDeeper}"`)}
      <text x="${box.padL}" y="${numberY}" font-family="${FONTS.display}" font-size="${numberSize}" font-weight="800" fill="${COLORS.blueDeeper}" letter-spacing="-2">${escapeXml(countLabel)}</text>
      <text x="${box.padL}" y="${labelY}" font-family="${FONTS.display}" font-size="${labelSize}" font-weight="800" fill="${COLORS.wavesBlue}" letter-spacing="1">GOOGLE REVIEWS</text>
      ${stars}
      ${avgLabel ? `<text x="${box.padL + 270}" y="${starsY + 9}" font-family="${FONTS.body}" font-size="${Math.round(W * 0.024)}" font-weight="600" fill="${COLORS.textBody}">${escapeXml(avgLabel)}</text>` : ''}
      <line x1="${box.padL}" y1="${thanksY - 44}" x2="${box.padR - 180}" y2="${thanksY - 44}" stroke="${COLORS.blueLight}" stroke-width="4"/>
      ${textBlock(thanksLines, { x: box.padL, y: thanksY, size: Math.round(W * 0.032), weight: 700, fill: COLORS.blueDeeper, family: FONTS.heading, lineHeight: 1.3 })}
      ${waveMotif(box.padR - 60, thanksY - 8, W / 1080)}
    </svg>
  `;
}

function renderSocialCardSvg(input = {}, logoDataUri = null) {
  if (input.variant === 'milestone') return renderMilestoneSvg(input, logoDataUri);
  if (input.variant === 'review') return renderReviewSvg(input, logoDataUri);
  if (input.variant === 'blog') return renderBlogSvg(input, logoDataUri);
  if (input.variant === 'versus') return renderVersusSvg(input, logoDataUri);
  return renderCampaignSvg(input, logoDataUri);
}

// ── Photo cards (creative engine) ────────────────────────────────────────────
// An AI-generated photoreal scene is the full-bleed background; the brand layer
// (scrim, eyebrow, logo chip, headline, gold CTA, footer) is composited over it
// deterministically — so the photo changes every day but the logo, palette, and
// CTA can never come out AI-mangled. Overlays are TRANSPARENT SVGs (no ground
// rect) rasterized onto the photo by sharp in renderPhotoCardJpegBase64.

// Shared photo-card chrome: legibility gradients (top + bottom), eyebrow pill,
// the transparent logo mark with a soft drop shadow (owner ruling 2026-09-06:
// never a white chip behind the logo — the mark sits on the photo), and the
// footer domain. Returns { svg, box } like chrome().
function photoChrome({ W, H, eyebrowLabel, eyebrowFill, logoDataUri }) {
  const padX = Math.round(W * 0.052);
  const logoSize = Math.round(H * 0.14);
  const logoX = W - padX - logoSize;
  const logoY = Math.round(H * 0.034);
  const logo = logoDataUri
    ? `<image x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" href="${logoDataUri}" preserveAspectRatio="xMidYMid meet" filter="url(#logoShadow)"/>`
    : `<text x="${W - padX}" y="${logoY + 52}" text-anchor="end" font-family="${FONTS.display}" font-size="46" font-weight="800" fill="${COLORS.white}" letter-spacing="1">WAVES</text>`;

  const svg = `
    <defs>
      <filter id="logoShadow" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="4" stdDeviation="7" flood-color="${COLORS.navy}" flood-opacity="0.55"/>
      </filter>
      <linearGradient id="scrimBottom" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${COLORS.navy}" stop-opacity="0"/>
        <stop offset="0.42" stop-color="${COLORS.navy}" stop-opacity="0.62"/>
        <stop offset="1" stop-color="${COLORS.navy}" stop-opacity="0.94"/>
      </linearGradient>
      <linearGradient id="scrimTop" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${COLORS.navy}" stop-opacity="0.5"/>
        <stop offset="1" stop-color="${COLORS.navy}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${Math.round(H * 0.42)}" width="${W}" height="${Math.round(H * 0.58)}" fill="url(#scrimBottom)"/>
    <rect x="0" y="0" width="${W}" height="${Math.round(H * 0.2)}" fill="url(#scrimTop)"/>
    ${eyebrow(eyebrowLabel, padX, Math.round(H * 0.045), eyebrowFill)}
    ${logo}
    <text x="${padX}" y="${H - Math.round(H * 0.037)}" font-family="${FONTS.body}" font-size="${Math.round(W * 0.02)}" font-weight="700" fill="${COLORS.white}" opacity="0.95">wavespestcontrol.com</text>
  `;
  return { svg, box: { padX, padR: W - padX } };
}

function renderPhotoCampaignOverlaySvg(input = {}) {
  const { w: W, h: H } = resolveSize(input.platform);
  const city = cleanText(input.city || input.location, 60);
  const topic = cleanText(input.topic || input.title, 150) || 'Seasonal pest pressure';
  const service = cleanText(input.service, 70);
  const cta = cleanText(input.cta || 'Schedule an inspection', 40);

  const { svg: frame, box } = photoChrome({
    W, H,
    eyebrowLabel: city ? `${city} · local pest pressure` : 'Local pest pressure',
    eyebrowFill: COLORS.wavesBlue,
    logoDataUri: input.logoDataUri,
  });

  const availW = box.padR - box.padX;
  const titleSize = topic.length > 38 ? Math.round(W * 0.052) : Math.round(W * 0.062);
  const titleLines = wrapText(topic, fitChars(availW, titleSize, 0.60), 3);
  // Bottom-anchor the text stack: footer < CTA < headline < service caption.
  const ctaH = 76;
  const ctaY = H - Math.round(H * 0.075) - ctaH;
  const titleBlockH = titleLines.length * titleSize * 1.08;
  const titleY = ctaY - 38 - titleBlockH + titleSize;
  const captionY = titleY - titleSize - 22;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${service ? `<text x="${box.padX}" y="${captionY}" font-family="${FONTS.heading}" font-size="${Math.round(W * 0.021)}" font-weight="700" fill="${COLORS.gold}" letter-spacing="2">${escapeXml(service.toUpperCase())}</text>` : ''}
      ${textBlock(titleLines, { x: box.padX, y: titleY, size: titleSize, weight: 800, fill: COLORS.white, family: FONTS.display, lineHeight: 1.08 })}
      ${ctaButton(cta, box.padX, ctaY)}
      ${waveMotif(box.padR - 70, ctaY + 30, W / 1080)}
    </svg>
  `;
}

function renderPhotoReviewOverlaySvg(input = {}) {
  const { w: W, h: H } = resolveSize(input.platform);
  const city = cleanText(input.city || input.location, 60);
  const reviewer = cleanText(input.reviewerDisplayName || input.reviewer || `Waves customer${city ? `, ${city}` : ''}`, 100);
  const excerpt = cleanText(input.excerpt || input.reviewText, 300) || 'Helpful, professional, and local service.';

  const { svg: frame, box } = photoChrome({
    W, H,
    eyebrowLabel: '5-star Google review',
    eyebrowFill: COLORS.green,
    logoDataUri: input.logoDataUri,
  });

  const availW = box.padR - box.padX;
  const quoteSize = excerpt.length > 160 ? Math.round(W * 0.036) : Math.round(W * 0.043);
  const quoteLines = wrapText(`“${excerpt}”`, fitChars(availW, quoteSize, 0.56), 5);
  // Bottom-anchor: footer < caption < reviewer < quote < stars.
  const reviewerY = H - Math.round(H * 0.078) - 34;
  const captionY = reviewerY + 32;
  const quoteBlockH = quoteLines.length * quoteSize * 1.28;
  const quoteY = reviewerY - 44 - quoteBlockH + quoteSize;
  const starsY = quoteY - quoteSize - 30;
  const stars = [0, 1, 2, 3, 4].map((i) => (
    `<path transform="translate(${box.padX + 20 + i * 48} ${starsY})" d="M0 -18 L5.3 -5.5 L18.6 -5.5 L7.9 2.9 L12 15.7 L0 7.9 L-12 15.7 L-7.9 2.9 L-18.6 -5.5 L-5.3 -5.5 Z" fill="${COLORS.star}"/>`
  )).join('');

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${stars}
      ${textBlock(quoteLines, { x: box.padX, y: quoteY, size: quoteSize, weight: 700, fill: COLORS.white, family: FONTS.heading, lineHeight: 1.28 })}
      <text x="${box.padX}" y="${reviewerY}" font-family="${FONTS.display}" font-size="${Math.round(W * 0.028)}" font-weight="800" fill="${COLORS.gold}" letter-spacing="0.5">${escapeXml(reviewer)}</text>
      <text x="${box.padX}" y="${captionY}" font-family="${FONTS.body}" font-size="${Math.round(W * 0.017)}" font-weight="600" fill="${COLORS.white}" opacity="0.85">Verified Google review · privacy-safe display</text>
    </svg>
  `;
}

// Versus over a photo: two white columns (name + points) on the bottom scrim,
// the gold VS badge on the seam, and the verdict as the gold hero line. No CTA
// button — the caption carries the ask; the card's job is the comparison.
function renderPhotoVersusOverlaySvg(input = {}) {
  const { w: W, h: H } = resolveSize(input.platform);
  const S = Math.min(W, H) / 1080;
  const city = cleanText(input.city || input.location, 60);
  const left = input.left || {};
  const right = input.right || {};
  const leftName = cleanText(left.name, 40) || 'Pest A';
  const rightName = cleanText(right.name, 40) || 'Pest B';
  const leftPoints = (Array.isArray(left.points) ? left.points : []).slice(0, 3);
  const rightPoints = (Array.isArray(right.points) ? right.points : []).slice(0, 3);
  const verdict = cleanText(input.verdict, 120);

  const { svg: frame, box } = photoChrome({
    W, H,
    eyebrowLabel: city ? `${city} · pest ID` : 'Pest ID: know the difference',
    eyebrowFill: COLORS.wavesBlue,
    logoDataUri: input.logoDataUri,
  });

  const badgeR = Math.round(32 * S);
  const seamGap = badgeR * 2 + Math.round(28 * S);
  const colW = Math.round((box.padR - box.padX - seamGap) / 2);
  const colX = [box.padX, box.padX + colW + seamGap];
  const midX = box.padX + colW + Math.round(seamGap / 2);
  const nameSize = Math.round(48 * S);
  const pointSize = Math.round(27 * S);

  // Bottom-anchor: footer < verdict < columns. The whole stack must stay on
  // the bottom scrim (legibility), so the columns start no higher than ~52%.
  const { size: verdictSize, lines: verdictLines } = fitText(
    verdict, box.padR - box.padX, [34, 30, 26].map((s) => Math.round(s * S)), 2
  );
  const verdictBlockH = verdictLines.length ? Math.round(verdictLines.length * verdictSize * 1.25) : 0;
  const verdictBottom = H - Math.round(H * 0.082);
  const verdictY = verdictBottom - verdictBlockH + verdictSize;
  const columnsBottom = verdictLines.length ? verdictY - verdictSize - Math.round(30 * S) : verdictBottom;
  const layout = versusLayout({
    left: { name: leftName, points: leftPoints }, right: { name: rightName, points: rightPoints },
    colW, nameSize, pointSize,
  });
  const nameY = columnsBottom - layout.pointsH - layout.gap - layout.nameBlockH + layout.nameSize;
  const columns = versusColumns(layout, {
    xs: colX, nameY, pointSize, nameFills: [COLORS.white, COLORS.white], pointFill: COLORS.white,
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame}
      ${columns}
      ${vsBadge(midX, nameY - Math.round(layout.nameSize * 0.32), badgeR)}
      ${textBlock(verdictLines, { x: box.padX, y: verdictY, size: verdictSize, weight: 800, fill: COLORS.gold, family: FONTS.heading, lineHeight: 1.25 })}
    </svg>
  `;
}

// Milestone over a photo: the count as the hero, "GOOGLE REVIEWS" in gold, the
// real-average star row, and the thank-you line — bottom-anchored on the scrim.
function renderPhotoMilestoneOverlaySvg(input = {}) {
  const { w: W, h: H } = resolveSize(input.platform);
  const S = Math.min(W, H) / 1080;
  const count = Math.max(0, Math.round(Number(input.count) || 0));
  const countLabel = count.toLocaleString('en-US');
  const avg = Number(input.averageRating);
  const avgLabel = Number.isFinite(avg) && avg > 0 ? `${avg.toFixed(1)} average rating` : '';
  const thanks = cleanText(input.thanks, 140) || 'Thank you, Southwest Florida.';

  const { svg: frame, box } = photoChrome({
    W, H,
    eyebrowLabel: 'Milestone',
    eyebrowFill: COLORS.gold,
    logoDataUri: input.logoDataUri,
  });

  const thanksSize = Math.round(34 * S);
  const thanksLines = wrapText(thanks, fitChars(box.padR - box.padX, thanksSize, 0.56), 2);
  const thanksBottom = H - Math.round(H * 0.082);
  const thanksY = thanksBottom - Math.round(thanksLines.length * thanksSize * 1.25) + thanksSize;
  const starsY = thanksY - thanksSize - Math.round(34 * S);
  const labelSize = Math.round(52 * S);
  const labelY = starsY - Math.round(44 * S);
  const numberSize = Math.round(210 * S);
  const numberY = labelY - Math.round(labelSize * 1.1);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      ${frame.replace(`fill="${COLORS.white}" letter-spacing="1.5">MILESTONE`, `fill="${COLORS.blueDeeper}" letter-spacing="1.5">MILESTONE`)}
      <text x="${box.padX}" y="${numberY}" font-family="${FONTS.display}" font-size="${numberSize}" font-weight="800" fill="${COLORS.white}" letter-spacing="-2">${escapeXml(countLabel)}</text>
      <text x="${box.padX}" y="${labelY}" font-family="${FONTS.display}" font-size="${labelSize}" font-weight="800" fill="${COLORS.gold}" letter-spacing="1">GOOGLE REVIEWS</text>
      ${ratingStars(box.padX + 20, starsY, avg, { emptyFill: 'none', idPrefix: 'photo-star-clip' })}
      ${avgLabel ? `<text x="${box.padX + 270}" y="${starsY + 9}" font-family="${FONTS.body}" font-size="${Math.round(26 * S)}" font-weight="600" fill="${COLORS.white}">${escapeXml(avgLabel)}</text>` : ''}
      ${textBlock(thanksLines, { x: box.padX, y: thanksY, size: thanksSize, weight: 700, fill: COLORS.white, family: FONTS.heading, lineHeight: 1.25 })}
    </svg>
  `;
}

function renderPhotoOverlaySvg(input = {}, logoDataUri = null) {
  const withLogo = { ...input, logoDataUri };
  if (input.variant === 'photo_review') return renderPhotoReviewOverlaySvg(withLogo);
  if (input.variant === 'photo_versus') return renderPhotoVersusOverlaySvg(withLogo);
  if (input.variant === 'photo_milestone') return renderPhotoMilestoneOverlaySvg(withLogo);
  return renderPhotoCampaignOverlaySvg(withLogo);
}

// Composite an AI scene (base64 image bytes) under the brand overlay and return
// JPEG base64. The scene is cover-cropped to the platform size ('attention'
// keeps the salient region when squaring/cropping to 4:3), so ONE generated 1:1
// scene serves both the square and GBP renditions.
async function renderPhotoCardJpegBase64(input = {}, opts = {}) {
  const sharp = require('sharp');
  const platform = opts.platform || input.platform;
  const { w: W, h: H } = resolveSize(platform);
  if (!opts.backgroundBase64) throw new Error('renderPhotoCardJpegBase64 requires backgroundBase64');
  const logoDataUri = await getLogoDataUri();
  const overlaySvg = renderPhotoOverlaySvg({ ...input, platform }, logoDataUri);
  const background = await sharp(Buffer.from(opts.backgroundBase64, 'base64'))
    .resize(W, H, { fit: 'cover', position: sharp.strategy.attention })
    .toBuffer();
  const buffer = await sharp(background)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .jpeg({ quality: 84, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
  return buffer.toString('base64');
}

// Load + downscale the brand logo once, cached. librsvg renders <image> data
// URIs reliably (unlike @font-face), so the real mark always appears.
let _logoPromise = null;
function getLogoDataUri() {
  if (_logoPromise) return _logoPromise;
  _logoPromise = getLogoPngBuffer()
    .then((buf) => (buf ? `data:image/png;base64,${buf.toString('base64')}` : null));
  return _logoPromise;
}

// Raw current-logo PNG (waves-logo-2026), resized to fit 260px. Shared by the
// card chrome above and the GBP watermark in social-media.js — one asset
// source, so a logo swap propagates everywhere.
let _logoBufferPromise = null;
function getLogoPngBuffer() {
  if (_logoBufferPromise) return _logoBufferPromise;
  _logoBufferPromise = (async () => {
    const candidates = [
      path.join(__dirname, '..', '..', 'client', 'public', 'waves-logo-2026.png'),
      path.join(__dirname, '..', '..', 'client', 'dist', 'waves-logo-2026.png'),
      path.join(__dirname, '..', 'assets', 'waves-logo-2026.png'),
    ];
    try {
      const sharp = require('sharp');
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          return await sharp(p).resize(260, 260, { fit: 'inside' }).png().toBuffer();
        }
      }
    } catch { /* fall through to text wordmark */ }
    return null;
  })();
  return _logoBufferPromise;
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
  getLogoPngBuffer,
  renderPhotoCardJpegBase64,
  renderPhotoOverlaySvg,
  renderSocialCardJpegBase64,
  renderSocialCardSvg,
  wrapText,
};
