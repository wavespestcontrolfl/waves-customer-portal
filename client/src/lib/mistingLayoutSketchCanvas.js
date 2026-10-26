// Misting layout sketch, step 3: the canvas drawing and PNG export (GATE_MISTING_LAYOUT_DESIGNER).
//
// Draws the model from mistingLayoutSketch.js as one still frame of the glass designer: the satellite photo
// fills the frame, with frosted-glass panels floating over it (title, address and date with the logo; the counts
// and a key; the concept note; the scale bar). Over the photo go the no-mist zones, lines, risers, pump, and each
// nozzle's numbered dot with its aim arrow and a translucent mist wedge (a PNG cannot animate, so no particles).
// No panel reaches into the photo's bottom strip, where Google's own attribution sits.
import { MAP_HEIGHT, MAP_WIDTH } from '../components/tech/treatmentZoneSpray';
import { SKETCH_ATTRIBUTION_H, SKETCH_HEIGHT, SKETCH_WIDTH, zoneLabel } from './mistingLayoutSketch';
import { drawAimArrow, drawMistWedge } from './mistingLayoutMistDraw';

const COPPER = '#b87333';
const WARN = '#dc2626';
const PUMP = '#1d4ed8';
const NOZZLE_BLUE = '#0b6fb8';
// A nozzle near water or inside a no-mist zone: amber with a dark ring. One inside a zone also gets a dashed
// ring and a "!", so that warning does not rely on color alone.
const AMBER = '#f59e0b';
const AMBER_DARK = '#92400e';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const LOGO_URL = '/waves-logo.png';

function outlinedText(ctx, text, x, y, size, { fill = '#000', align = 'center', weight = 700 } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, size / 4);
  ctx.strokeStyle = '#fff';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function polyline(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
}

function drawZone(ctx, zone) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(zone.x, zone.y, zone.radiusPx, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(220, 38, 38, 0.22)';
  ctx.fill();
  ctx.setLineDash([14, 8]);
  ctx.lineWidth = 4;
  ctx.strokeStyle = WARN;
  ctx.stroke();
  ctx.restore();
}

// Labels are drawn after the nozzles so a nozzle never covers them. Each label takes the candidate spot
// that stays on the photo, clears the labels already placed, and covers the fewest nozzles (ties keep the
// first candidate, so the same layout always draws the same way).
const BOTTOM_LIMIT = SKETCH_HEIGHT - SKETCH_ATTRIBUTION_H;
const LABEL_SIZE = 26;
const NOZZLE_R = 17;

function labelBox(ctx, text, x, y) {
  ctx.font = `700 ${LABEL_SIZE}px ${FONT}`;
  const w = ctx.measureText(text).width;
  return { x0: x - w / 2, x1: x + w / 2, y0: y - LABEL_SIZE / 2, y1: y + LABEL_SIZE / 2 };
}

function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function labelCost(box, nozzles, placed) {
  // Off the photo, or into the strip at its bottom where Google's attribution sits.
  const offMap = box.x0 < 0 || box.x1 > MAP_WIDTH || box.y0 < 0 || box.y1 > BOTTOM_LIMIT ? 10000 : 0;
  const clash = placed.filter((p) => boxesOverlap(box, p)).length * 1000;
  const covered = nozzles.filter((n) => n.x > box.x0 - NOZZLE_R && n.x < box.x1 + NOZZLE_R
    && n.y > box.y0 - NOZZLE_R && n.y < box.y1 + NOZZLE_R).length;
  return offMap + clash + covered;
}

// `around` is the marker: its center and how far the label must stay from it.
function drawLabelNear(ctx, text, around, nozzles, placed) {
  const half = labelBox(ctx, text, 0, 0).x1;
  const { x, y, gap } = around;
  const candidates = [
    { x, y: y - gap - LABEL_SIZE / 2 },
    { x, y: y + gap + LABEL_SIZE / 2 },
    { x: x - gap - half - 6, y },
    { x: x + gap + half + 6, y },
  ];
  let best = null;
  candidates.forEach((c) => {
    const box = labelBox(ctx, text, c.x, c.y);
    const cost = labelCost(box, nozzles, placed);
    if (!best || cost < best.cost) best = { ...c, box, cost };
  });
  placed.push(best.box);
  outlinedText(ctx, text, best.x, best.y, LABEL_SIZE);
}

// `panels` are the glass panels' rectangles: a label never lands on one.
function drawLabels(ctx, model, panels) {
  const placed = panels.map((r) => ({ x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h }));
  model.zones.forEach((z) => drawLabelNear(ctx, zoneLabel(z), { x: z.x, y: z.y, gap: z.radiusPx + 6 }, model.nozzles, placed));
  if (model.pump) drawLabelNear(ctx, 'Pump', { x: model.pump.x, y: model.pump.y, gap: 22 }, model.nozzles, placed);
}

function drawLine(ctx, line) {
  if (line.points.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  polyline(ctx, line.points);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 11;
  ctx.stroke();
  polyline(ctx, line.points);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5;
  ctx.setLineDash(line.kind === 'fence' ? [18, 12] : []);
  ctx.stroke();
  ctx.restore();
}

// A blue dot with a white ring. Amber with a dark ring when it stands near water or inside a no-mist zone;
// inside a zone it also gets a dashed ring and a "!". The digit is drawn apart (drawNozzleNumber), after the
// arrows, so an arrow that runs past a neighbouring dot never hides that dot's number.
const isAmber = (nozzle) => Boolean(nozzle.flagged) || Boolean(nozzle.nearWater);

function drawNozzle(ctx, nozzle) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(nozzle.x, nozzle.y, NOZZLE_R, 0, Math.PI * 2);
  ctx.fillStyle = isAmber(nozzle) ? AMBER : NOZZLE_BLUE;
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = isAmber(nozzle) ? AMBER_DARK : '#fff';
  ctx.stroke();
  ctx.restore();
  if (nozzle.flagged) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(nozzle.x, nozzle.y, 24, 0, Math.PI * 2);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 4;
    ctx.strokeStyle = AMBER_DARK;
    ctx.stroke();
    ctx.restore();
    outlinedText(ctx, '!', nozzle.x + 26, nozzle.y - 20, 26, { fill: AMBER_DARK });
  }
}

function drawNozzleNumber(ctx, nozzle) {
  ctx.save();
  ctx.font = `700 ${nozzle.number > 99 ? 15 : 20}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isAmber(nozzle) ? '#000' : '#fff';
  ctx.fillText(String(nozzle.number), nozzle.x, nozzle.y + 1);
  ctx.restore();
}

function triangle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.9, y + r * 0.7);
  ctx.lineTo(x - r * 0.9, y + r * 0.7);
  ctx.closePath();
}

function drawRiser(ctx, riser) {
  ctx.save();
  triangle(ctx, riser.x, riser.y, 17);
  ctx.fillStyle = COPPER;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}

function drawPump(ctx, pump) {
  ctx.save();
  ctx.fillStyle = PUMP;
  ctx.fillRect(pump.x - 14, pump.y - 14, 28, 28);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(pump.x - 14, pump.y - 14, 28, 28);
  ctx.restore();
}

// ── Glass panels ─────────────────────────────────────────────────────────────
// White at 16% with a 1px white 38% border and a blurred, more saturated copy of the photo behind it, as the
// designer's CSS glass. A browser canvas with no `filter` (older Safari) cannot blur, so it gets a darker tint
// instead, which keeps the white text readable.
const MARGIN = 24;
const PANEL_R = 16;
const PAD = 18;
const ROW_H = 28;
// White 16% over a thin navy tint, as the designer: the tint keeps white text readable on a bright roof or road.
const GLASS_TINT = 'rgba(10, 25, 50, 0.16)';
const GLASS_FILL = 'rgba(255, 255, 255, 0.16)';
const GLASS_FALLBACK_FILL = 'rgba(15, 30, 50, 0.4)';
const GLASS_BORDER = 'rgba(255, 255, 255, 0.38)';
const KEY_ROWS = [
  'Nozzle (number = walking order)',
  'Near water or in a no-mist zone',
  'Arrow and mist = spray direction',
  'Riser',
  'Pump',
  'No-mist zone',
];

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function glassBody(ctx, r, photo) {
  ctx.save();
  roundedRect(ctx, r.x, r.y, r.w, r.h, PANEL_R);
  ctx.clip();
  if ('filter' in ctx) {
    ctx.filter = 'blur(12px) saturate(1.4)';
    ctx.drawImage(photo, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.filter = 'none';
    ctx.fillStyle = GLASS_TINT;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = GLASS_FILL;
  } else {
    ctx.fillStyle = GLASS_FALLBACK_FILL;
  }
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
  ctx.save();
  roundedRect(ctx, r.x, r.y, r.w, r.h, PANEL_R);
  ctx.lineWidth = 2;
  ctx.strokeStyle = GLASS_BORDER;
  ctx.stroke();
  ctx.restore();
}

// White text with a soft shadow, left aligned on a middle baseline. Squeezed to `maxWidth` if it would overrun.
function glassText(ctx, text, x, y, size, { weight = 400, maxWidth, align = 'left' } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  if (maxWidth) ctx.fillText(text, x, y, maxWidth);
  else ctx.fillText(text, x, y);
  ctx.restore();
}

// Where each panel sits. All of them stay above BOTTOM_LIMIT, clear of the attribution strip.
// Exported for the tests, which check that and that no two panels overlap.
export function glassPanelRects(model, hasLogo) {
  const titleW = 600;
  const countsW = 410;
  const countsH = PAD * 2 + model.legend.length * ROW_H + 14 + KEY_ROWS.length * ROW_H;
  const lowest = BOTTOM_LIMIT - 12; // panels end a little above the attribution strip
  const concept = { x: MARGIN, y: lowest - 46, w: 800, h: 46 };
  const scaleW = Math.max(model.scale.px + 2 * PAD, 130);
  const scale = { x: SKETCH_WIDTH - MARGIN - scaleW, y: lowest - 78, w: scaleW, h: 78 };
  return {
    title: { x: MARGIN, y: MARGIN, w: titleW, h: hasLogo ? 112 : 96 },
    counts: { x: SKETCH_WIDTH - MARGIN - countsW, y: MARGIN, w: countsW, h: countsH },
    concept,
    scale,
  };
}

function drawTitlePanel(ctx, model, r, logo) {
  const left = r.x + PAD + (logo ? 92 : 0);
  if (logo) ctx.drawImage(logo, r.x + PAD, r.y + 14, 84, 84);
  const width = r.x + r.w - PAD - left;
  glassText(ctx, model.title, left, r.y + 32, 36, { weight: 700, maxWidth: width });
  glassText(ctx, model.address, left, r.y + 66, 24, { maxWidth: width });
  if (logo) glassText(ctx, model.dateLabel, left, r.y + 94, 22, { maxWidth: width });
  else glassText(ctx, model.dateLabel, left, r.y + 84, 22, { maxWidth: width });
}

// The key's little symbols, each centered at (x, y).
function drawKeySymbol(ctx, index, x, y) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.lineJoin = 'round';
  if (index <= 1) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = index === 0 ? NOZZLE_BLUE : AMBER;
    ctx.fill();
    ctx.strokeStyle = index === 0 ? '#fff' : AMBER_DARK;
    ctx.stroke();
  } else if (index === 2) {
    drawAimArrow(ctx, { x: x - 14, y }, 90, false);
  } else if (index === 3) {
    triangle(ctx, x, y, 10);
    ctx.fillStyle = COPPER;
    ctx.fill();
    ctx.stroke();
  } else if (index === 4) {
    ctx.fillStyle = PUMP;
    ctx.fillRect(x - 9, y - 9, 18, 18);
    ctx.strokeRect(x - 9, y - 9, 18, 18);
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220, 38, 38, 0.35)';
    ctx.fill();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = WARN;
    ctx.stroke();
  }
  ctx.restore();
}

function drawCountsPanel(ctx, model, r) {
  const textW = r.w - 2 * PAD;
  model.legend.forEach((row, i) => glassText(ctx, row, r.x + PAD, r.y + PAD + ROW_H / 2 + i * ROW_H, 20, { maxWidth: textW }));
  const rule = r.y + PAD + model.legend.length * ROW_H + 7;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(r.x + PAD, rule);
  ctx.lineTo(r.x + r.w - PAD, rule);
  ctx.lineWidth = 1;
  ctx.strokeStyle = GLASS_BORDER;
  ctx.stroke();
  ctx.restore();
  KEY_ROWS.forEach((row, i) => {
    const y = rule + 7 + ROW_H / 2 + i * ROW_H;
    drawKeySymbol(ctx, i, r.x + PAD + 22, y);
    glassText(ctx, row, r.x + PAD + 54, y, 20, { maxWidth: textW - 54 });
  });
}

function drawScalePanel(ctx, model, r) {
  const x = r.x + (r.w - model.scale.px) / 2;
  const y = r.y + 28;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 4;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x, y - 10);
  ctx.lineTo(x, y);
  ctx.lineTo(x + model.scale.px, y);
  ctx.lineTo(x + model.scale.px, y - 10);
  ctx.stroke();
  ctx.restore();
  glassText(ctx, `${model.scale.feet} ft`, r.x + r.w / 2, r.y + 54, 24, { weight: 700, align: 'center' });
}

/**
 * Draw the whole sketch on a 2D context of SKETCH_WIDTH x SKETCH_HEIGHT.
 * Order: the photo, the glass panel bodies (blurred photo behind them), a light darkening so white text and
 * white lines read on bright roofs, the map marks, then the panel text. The marks go over the glass bodies and
 * the text over the marks, so a nozzle under a panel is still drawn whole.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} model from buildSketchModel
 * @param {{map: CanvasImageSource, logo?: CanvasImageSource|null}} images
 */
export function drawSketch(ctx, model, { map, logo = null }) {
  const rects = glassPanelRects(model, Boolean(logo));
  ctx.drawImage(map, 0, 0, MAP_WIDTH, MAP_HEIGHT);
  Object.values(rects).forEach((r) => glassBody(ctx, r, map));
  ctx.fillStyle = 'rgba(8, 20, 40, 0.12)';
  ctx.fillRect(0, 0, MAP_WIDTH, BOTTOM_LIMIT); // not over the attribution strip
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  ctx.clip();
  model.zones.forEach((z) => drawZone(ctx, z));
  model.lines.forEach((l) => drawLine(ctx, l));
  model.risers.forEach((r) => drawRiser(ctx, r));
  if (model.pump) drawPump(ctx, model.pump);
  model.nozzles.forEach((n) => drawMistWedge(ctx, n, n.aimHeading, n.reachPx));
  model.nozzles.forEach((n) => drawNozzle(ctx, n));
  // Arrows over the dots, so a neighbour's dot never hides one (a nozzle aimed along its line points at the
  // next dot); the digits over the arrows, so an arrow never hides a number.
  model.nozzles.forEach((n) => drawAimArrow(ctx, n, n.aimHeading, n.nearWater, NOZZLE_R + 3, n.arrowPx));
  model.nozzles.forEach((n) => drawNozzleNumber(ctx, n));
  drawLabels(ctx, model, Object.values(rects));
  ctx.restore();
  drawTitlePanel(ctx, model, rects.title, logo);
  drawCountsPanel(ctx, model, rects.counts);
  glassText(ctx, model.concept, rects.concept.x + PAD, rects.concept.y + rects.concept.h / 2, 22, {
    weight: 700,
    maxWidth: rects.concept.w - 2 * PAD,
  });
  drawScalePanel(ctx, model, rects.scale);
}

function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = LOGO_URL;
  });
}

function renderToBlob(model, images) {
  const canvas = document.createElement('canvas');
  canvas.width = SKETCH_WIDTH;
  canvas.height = SKETCH_HEIGHT;
  drawSketch(canvas.getContext('2d'), model, images);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The sketch export produced no image'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Compose the branded sketch into a PNG Blob. The satellite image loads with crossOrigin="anonymous"; if
 * the canvas still taints, the tile is re-fetched (CORS-checked) and composed on a FRESH canvas, the same
 * fallback the Treatment Zone Mapper's export uses. A logo that fails to load is left out; it never blocks a save.
 */
export async function composeSketchPng({ mapImage, mapUrl, model }) {
  const logo = await loadLogo();
  try {
    if (!mapImage) throw new Error('no loaded map image');
    return await renderToBlob(model, { map: mapImage, logo });
  } catch {
    const res = await fetch(mapUrl);
    const bitmap = await createImageBitmap(await res.blob());
    return renderToBlob(model, { map: bitmap, logo });
  }
}
