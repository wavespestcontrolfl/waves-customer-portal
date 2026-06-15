const CARD_SIZE = 1080;

const COLORS = {
  page: '#f6f8f5',
  card: '#ffffff',
  ink: '#17221d',
  muted: '#5f6c63',
  border: '#dce5de',
  teal: '#007f83',
  green: '#2f7d32',
  gold: '#d9a441',
  blue: '#145c9e',
};

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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

function textBlock(lines, {
  x,
  y,
  size,
  weight = 500,
  fill = COLORS.ink,
  lineHeight = 1.25,
  family = 'Arial, Helvetica, sans-serif',
  anchor = 'start',
}) {
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + (index * size * lineHeight)}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`
  )).join('');
}

function badge(label, x, y, fill = COLORS.teal) {
  const safe = cleanText(label, 80).toUpperCase();
  const width = Math.max(220, Math.min(520, 34 + (safe.length * 13)));
  return `
    <rect x="${x}" y="${y}" width="${width}" height="46" rx="23" fill="${fill}"/>
    <text x="${x + 24}" y="${y + 30}" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="700" fill="#ffffff" letter-spacing="1">${escapeXml(safe)}</text>
  `;
}

function baseFrame({ city, service }) {
  const cityLabel = cleanText(city, 80).toUpperCase();
  const serviceLabel = cleanText(service, 90);
  return `
    <rect width="${CARD_SIZE}" height="${CARD_SIZE}" fill="${COLORS.page}"/>
    <rect x="48" y="48" width="984" height="984" rx="34" fill="${COLORS.card}" stroke="${COLORS.border}" stroke-width="2"/>
    <rect x="48" y="48" width="18" height="984" rx="9" fill="${COLORS.teal}"/>
    <rect x="820" y="48" width="212" height="984" rx="34" fill="#f1f6f2"/>
    <text x="108" y="132" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="800" fill="${COLORS.ink}" letter-spacing="1">WAVES</text>
    <text x="108" y="168" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="600" fill="${COLORS.muted}">Pest Control &amp; Lawn Care</text>
    ${cityLabel ? `<text x="972" y="130" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="${COLORS.teal}" letter-spacing="1">${escapeXml(cityLabel)}</text>` : ''}
    ${serviceLabel ? `<text x="972" y="166" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="600" fill="${COLORS.muted}">${escapeXml(serviceLabel)}</text>` : ''}
  `;
}

function renderCampaignSvg(input = {}) {
  const city = cleanText(input.city || input.location, 80);
  const topic = cleanText(input.topic || input.title || 'Seasonal pest pressure', 150);
  const service = cleanText(input.service || 'Pest control', 90);
  const detail = cleanText(input.detail || input.fact || input.description, 360);
  const cta = cleanText(input.cta || 'Schedule an inspection', 80);
  const titleLines = wrapText(topic, 18, 4);
  const titleSize = titleLines.length > 2 ? 60 : 68;
  const detailLines = wrapText(detail || 'Local pest pressure changes quickly with heat, rain, and property conditions.', 40, 4);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
      ${baseFrame({ city, service })}
      ${badge('Local pest pressure', 108, 250, COLORS.blue)}
      ${textBlock(titleLines, { x: 108, y: 382, size: titleSize, weight: 800, lineHeight: 1.08 })}
      <line x1="108" y1="660" x2="760" y2="660" stroke="${COLORS.border}" stroke-width="3"/>
      ${textBlock(detailLines, { x: 108, y: 724, size: 32, weight: 500, fill: COLORS.ink, lineHeight: 1.32 })}
      <rect x="108" y="922" width="430" height="64" rx="32" fill="${COLORS.green}"/>
      <text x="138" y="963" font-family="Arial, Helvetica, sans-serif" font-size="25" font-weight="700" fill="#ffffff">${escapeXml(cta)}</text>
      <text x="972" y="962" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="600" fill="${COLORS.muted}">wavespestcontrol.com</text>
      <circle cx="900" cy="408" r="58" fill="${COLORS.teal}" opacity="0.12"/>
      <circle cx="900" cy="408" r="34" fill="${COLORS.teal}" opacity="0.22"/>
      <circle cx="900" cy="408" r="12" fill="${COLORS.teal}"/>
      <path d="M870 558 C905 518, 936 515, 965 558" fill="none" stroke="${COLORS.gold}" stroke-width="16" stroke-linecap="round"/>
      <path d="M852 600 C903 548, 946 548, 984 600" fill="none" stroke="${COLORS.gold}" stroke-width="10" stroke-linecap="round" opacity="0.72"/>
    </svg>
  `;
}

function renderReviewSvg(input = {}) {
  const city = cleanText(input.city || input.location, 80);
  const reviewer = cleanText(input.reviewerDisplayName || input.reviewer || `Waves customer${city ? `, ${city}` : ''}`, 120);
  const excerpt = cleanText(input.excerpt || input.reviewText || 'Helpful, professional, and local service.', 420);
  const service = cleanText(input.service || 'Google review', 90);
  const quoteLines = wrapText(`"${excerpt}"`, 42, 6);

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${CARD_SIZE}" height="${CARD_SIZE}" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}">
      ${baseFrame({ city, service })}
      ${badge('5-star Google review', 108, 250, COLORS.green)}
      <g transform="translate(108 352)">
        ${[0, 1, 2, 3, 4].map((i) => `<circle cx="${i * 44}" cy="0" r="17" fill="${COLORS.gold}"/>`).join('')}
      </g>
      ${textBlock(quoteLines, { x: 108, y: 460, size: 48, weight: 650, fill: COLORS.ink, lineHeight: 1.28 })}
      <line x1="108" y1="842" x2="720" y2="842" stroke="${COLORS.border}" stroke-width="3"/>
      <text x="108" y="910" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="800" fill="${COLORS.ink}">${escapeXml(reviewer)}</text>
      <text x="108" y="952" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="600" fill="${COLORS.muted}">Real Google review. Privacy-safe customer display.</text>
      <rect x="850" y="702" width="112" height="112" rx="28" fill="${COLORS.teal}" opacity="0.14"/>
      <path d="M876 764 L899 787 L939 735" fill="none" stroke="${COLORS.teal}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function renderSocialCardSvg(input = {}) {
  return input.variant === 'review'
    ? renderReviewSvg(input)
    : renderCampaignSvg(input);
}

async function renderSocialCardJpegBase64(input = {}) {
  const sharp = require('sharp');
  const svg = renderSocialCardSvg(input);
  const buffer = await sharp(Buffer.from(svg))
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return buffer.toString('base64');
}

function filenameSlug(value, fallback = 'social-card') {
  const slug = cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

module.exports = {
  CARD_SIZE,
  filenameSlug,
  renderSocialCardJpegBase64,
  renderSocialCardSvg,
  wrapText,
};
