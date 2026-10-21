// Shareable lawn card (GATE_REPORT_WEB_SHARE, owner 2026-10-20, idea 8).
// The picture is drawn in the browser from four things only: the front-yard
// photo, the score, the Waves logo and the customer's referral link (text and
// QR code). Nothing else is ever drawn: no address, no name, no date, no
// technician. The photo comes from the report's own same-origin route
// (server resized, metadata removed), so the canvas can export it.
import QRCode from 'qrcode';

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;
const PHOTO_HEIGHT = 900;
const NAVY = '#04395E';
const GOLD = '#F5C242';
const QR_SIZE = 250;
const PAD = 56;

// The link as people read it: no scheme, no trailing slash.
export function bareLink(link) {
  return String(link || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// Largest source rectangle with the target's shape, centred (CSS "cover").
export function coverRect(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = dstW / scale;
  const h = dstH / scale;
  return { sx: (srcW - w) / 2, sy: (srcH - h) / 2, sw: w, sh: h };
}

function fitFont(ctx, text, maxWidth, startPx, minPx, weight) {
  let size = startPx;
  ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  while (size > minPx && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  }
  return size;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw the card on a 1080 x 1350 context. `photo`, `logo` and `qr` are drawable
 * images (image, bitmap or canvas) with width/height. Pure drawing: no I/O.
 */
export function drawLawnShareCard(ctx, { photo, logo, qr, score, link }) {
  const sansFont = (px, weight = 400) => `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Photo, cropped to fill the top block.
  const { sx, sy, sw, sh } = coverRect(photo.width, photo.height, CARD_WIDTH, PHOTO_HEIGHT);
  ctx.drawImage(photo, sx, sy, sw, sh, 0, 0, CARD_WIDTH, PHOTO_HEIGHT);

  // Darken the foot of the photo so the score reads on any lawn.
  const fade = ctx.createLinearGradient(0, PHOTO_HEIGHT - 360, 0, PHOTO_HEIGHT);
  fade.addColorStop(0, 'rgba(4, 57, 94, 0)');
  fade.addColorStop(1, 'rgba(4, 57, 94, 0.92)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, PHOTO_HEIGHT - 360, CARD_WIDTH, 360);

  // Score.
  const scoreText = String(Math.round(Number(score)));
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = sansFont(190, 700);
  ctx.fillText(scoreText, PAD, PHOTO_HEIGHT - 86);
  const scoreWidth = ctx.measureText(scoreText).width;
  ctx.font = sansFont(60, 600);
  ctx.fillText('/ 100', PAD + scoreWidth + 20, PHOTO_HEIGHT - 86);
  ctx.fillStyle = GOLD;
  ctx.font = sansFont(40, 700);
  ctx.fillText('LAWN HEALTH SCORE', PAD + 6, PHOTO_HEIGHT - 28);

  // Logo on a white plate, top right of the photo.
  const plate = 150;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, CARD_WIDTH - PAD - plate, PAD, plate, plate, 28);
  ctx.fill();
  const inset = 14;
  ctx.drawImage(logo, CARD_WIDTH - PAD - plate + inset, PAD + inset, plate - inset * 2, plate - inset * 2);

  // Foot: the invitation, the link text and the QR code.
  const textMax = CARD_WIDTH - PAD * 2 - QR_SIZE - 40;
  ctx.fillStyle = '#FFFFFF';
  ctx.font = sansFont(54, 700);
  ctx.fillText('Want a lawn like this?', PAD, PHOTO_HEIGHT + 100);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.font = sansFont(34, 500);
  ctx.fillText('Waves Pest Control', PAD, PHOTO_HEIGHT + 152);
  ctx.fillStyle = GOLD;
  ctx.font = sansFont(30, 700);
  ctx.fillText('SCAN OR TYPE MY LINK', PAD, PHOTO_HEIGHT + 232);
  const text = bareLink(link);
  fitFont(ctx, text, textMax, 40, 22, 700);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(text, PAD, PHOTO_HEIGHT + 282);

  ctx.fillStyle = '#FFFFFF';
  const qrX = CARD_WIDTH - PAD - QR_SIZE;
  const qrY = PHOTO_HEIGHT + 60;
  roundRect(ctx, qrX - 12, qrY - 12, QR_SIZE + 24, QR_SIZE + 24, 20);
  ctx.fill();
  ctx.drawImage(qr, qrX, qrY, QR_SIZE, QR_SIZE);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

async function fetchImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    return await loadImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Build the card and resolve to a JPEG Blob. Throws if any piece is missing. */
export async function buildLawnShareCard({ photoUrl, logoUrl, score, link }) {
  const [photo, logo, qrCanvas] = await Promise.all([
    fetchImage(photoUrl),
    fetchImage(logoUrl),
    QRCode.toCanvas(document.createElement('canvas'), link, { margin: 1, width: QR_SIZE, errorCorrectionLevel: 'M' }),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  drawLawnShareCard(canvas.getContext('2d'), { photo, logo, qr: qrCanvas, score, link });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('card export failed');
  return blob;
}
