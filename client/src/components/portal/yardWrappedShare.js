// Yard Wrapped sharing: the share text, a stats-only picture and the share /
// copy calls. The picture is drawn on a canvas from the card's counts and the
// registered company name only: no photo, no address, no customer name, no
// outside image, so the canvas is never tainted and nothing personal leaves
// the phone. No tracking. Words come from yardWrappedCopy.js.
import { COLORS, FONTS } from '../../theme-brand';
import { WAVES_BUSINESS_NAME, WAVES_WEBSITE_URL } from '../../constants/business';
import { LINE_LABELS, YARD_WRAPPED_COPY as COPY } from './yardWrappedCopy';

const PICTURE = { width: 1080, height: 1350 };

export function linesWithLabels(data) {
  return (data?.visits?.byLine || [])
    .filter((entry) => LINE_LABELS[entry.line])
    .map((entry) => ({ line: entry.line, count: entry.count, label: LINE_LABELS[entry.line] }));
}

export function businessNameOf(data) {
  return data?.businessName || WAVES_BUSINESS_NAME;
}

export function buildShare(data) {
  const lawnScore = data.lawnScore ? { first: data.lawnScore.first, last: data.lawnScore.last } : null;
  return {
    title: COPY.shareTitle(data.year),
    text: COPY.shareText({
      year: data.year, businessName: businessNameOf(data), total: data.visits.total, lines: linesWithLabels(data), lawnScore,
    }),
    url: WAVES_WEBSITE_URL,
  };
}

// Draws the stats picture. `ctx` is any 2D canvas context.
export function drawPicture(ctx, data) {
  const { width, height } = PICTURE;
  const centered = (text, y, font, color) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, width / 2, y);
  };
  ctx.fillStyle = COLORS.glassNavy;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = COLORS.wavesBlue;
  ctx.fillRect(0, 0, width, 14);

  centered(COPY.picture.kicker.toUpperCase(), 190, `700 40px ${FONTS.body}`, COLORS.yellow);
  centered(COPY.picture.title(data.year), 290, `700 72px ${FONTS.body}`, COLORS.white);
  centered(String(data.visits.total), 560, `700 260px ${FONTS.body}`, COLORS.white);
  centered(COPY.picture.visitsWord(data.visits.total), 640, `700 56px ${FONTS.body}`, COLORS.blueLight);

  let y = 780;
  for (const entry of linesWithLabels(data).slice(0, 4)) {
    centered(`${entry.label}: ${entry.count}`, y, `600 48px ${FONTS.body}`, COLORS.white);
    y += 70;
  }
  if (data.lawnScore) {
    centered(COPY.picture.lawn(data.lawnScore.first, data.lawnScore.last), Math.max(y + 40, 1060), `700 52px ${FONTS.body}`, COLORS.yellow);
  }
  centered(businessNameOf(data), 1250, `600 44px ${FONTS.body}`, COLORS.blueLight);
}

// A PNG File of the picture, or null where canvas is not available.
export async function makePictureFile(data, doc = typeof document !== 'undefined' ? document : null) {
  try {
    const canvas = doc && doc.createElement('canvas');
    const ctx = canvas && canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    canvas.width = PICTURE.width;
    canvas.height = PICTURE.height;
    drawPicture(ctx, data);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new File([blob], `my-${data.year}-with-waves.png`, { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}

export function canShareText(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return !!nav && typeof nav.share === 'function';
}

export function canCopyText(nav = typeof navigator !== 'undefined' ? navigator : null) {
  return !!nav && !!nav.clipboard && typeof nav.clipboard.writeText === 'function';
}

// Opens the phone's share sheet. Returns 'shared', 'cancelled' or 'failed'.
export async function shareYardWrapped(data, file = null, nav = navigator) {
  const { title, text, url } = buildShare(data);
  const withPicture = file && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
  try {
    await nav.share({ title, text, url, ...(withPicture ? { files: [file] } : {}) });
    return 'shared';
  } catch (err) {
    return err && err.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export async function copyYardWrapped(data, nav = navigator) {
  const { text, url } = buildShare(data);
  try {
    await nav.clipboard.writeText(`${text} ${url}`);
    return true;
  } catch {
    return false;
  }
}
