// Misting layout sketch, step 3: the canvas drawing and PNG export (GATE_MISTING_LAYOUT_DESIGNER).
//
// Draws the model from mistingLayoutSketch.js as a plain drawing: the satellite photo fills the frame, with the
// no-mist zones, lines, risers, pump, and each nozzle's numbered dot with its aim arrow and a translucent mist
// wedge (a PNG cannot animate, so no particles). A small scale bar sits in the bottom right corner. There is no
// title, legend or count on the picture: the estimate document shows those in its card around it. Nothing is drawn
// on the photo's bottom strip, where Google's own attribution sits.
import { MAP_HEIGHT, MAP_WIDTH } from '../components/tech/treatmentZoneSpray';
import { SKETCH_ATTRIBUTION_H, SKETCH_HEIGHT, SKETCH_WIDTH, zoneLabel } from './mistingLayoutSketch';
import { MIST_TRACE_STROKES, drawAimArrow, drawMistWedge } from './mistingLayoutMistDraw';

const COPPER = '#b87333';
const WARN = '#dc2626';
const CABINET_BODY = '#d8c59b';
const CABINET_LID = '#9a7f46';
const CABINET_EDGE = '#6b5428';
const NOZZLE_BLUE = '#0b6fb8';
// A nozzle near water or inside a no-mist zone: amber with a dark ring. One inside a zone also gets a dashed
// ring and a "!", so that warning does not rely on color alone.
const AMBER = '#f59e0b';
const AMBER_DARK = '#92400e';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

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

// `obstacles` are rectangles ({x, y, w, h}, here the scale bar) a label never lands on.
function drawLabels(ctx, model, obstacles) {
  const placed = obstacles.map((r) => ({ x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h }));
  model.zones.forEach((z) => drawLabelNear(ctx, zoneLabel(z), { x: z.x, y: z.y, gap: z.radiusPx + 6 }, model.nozzles, placed));
  if (model.pump) drawLabelNear(ctx, 'Pump', { x: model.pump.x, y: model.pump.y, gap: 22 }, model.nozzles, placed);
}

// A bed line (a landscape bed edge, with risers along it) is a thin dashed copper line with a white halo, not a mist trace.
function drawBedLine(ctx, line) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  polyline(ctx, line.points);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 7;
  ctx.setLineDash([]);
  ctx.stroke();
  polyline(ctx, line.points);
  ctx.strokeStyle = COPPER;
  ctx.lineWidth = 3.5;
  ctx.setLineDash([10, 7]);
  ctx.stroke();
  ctx.restore();
}

// The Treatment Zone Mapper's layered blue glow; a fence is dashed on the top stroke only.
function drawLine(ctx, line) {
  if (line.points.length < 2) return;
  if (line.kind === 'bed') { drawBedLine(ctx, line); return; }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  MIST_TRACE_STROKES.forEach((stroke, i) => {
    polyline(ctx, line.points);
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.setLineDash(line.kind === 'fence' && i === MIST_TRACE_STROKES.length - 1 ? [18, 12] : []);
    ctx.stroke();
  });
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

// The pump is drawn as its cabinet (Pynamite's Cube Pro): a tan box with a darker lid line.
function drawPump(ctx, pump) {
  ctx.save();
  ctx.fillStyle = CABINET_BODY;
  ctx.fillRect(pump.x - 17, pump.y - 14, 34, 28);
  ctx.fillStyle = CABINET_LID;
  ctx.fillRect(pump.x - 17, pump.y - 14, 34, 9);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(pump.x - 17, pump.y - 14, 34, 28);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = CABINET_EDGE;
  ctx.strokeRect(pump.x - 17, pump.y - 14, 34, 28);
  ctx.restore();
}

// ── Scale bar ────────────────────────────────────────────────────────────────
// A small white bar with a dark outline, in the bottom right corner above the attribution strip.
const SCALE_MARGIN = 24;

// Where the scale bar and its label sit, as a rectangle (labels keep clear of it).
export function scaleBarRect(model) {
  const w = Math.max(model.scale.px, 60) + 24;
  const h = 56;
  return { x: SKETCH_WIDTH - SCALE_MARGIN - w, y: BOTTOM_LIMIT - 12 - h, w, h };
}

function drawScaleBar(ctx, model) {
  const r = scaleBarRect(model);
  const x = r.x + (r.w - model.scale.px) / 2;
  const y = r.y + 20;
  const bar = () => {
    ctx.beginPath();
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x, y);
    ctx.lineTo(x + model.scale.px, y);
    ctx.lineTo(x + model.scale.px, y - 10);
  };
  ctx.save();
  ctx.lineJoin = 'round';
  bar();
  ctx.lineWidth = 9;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.stroke();
  bar();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
  outlinedText(ctx, `${model.scale.feet} ft`, r.x + r.w / 2, r.y + 44, 24);
}

/**
 * Draw the whole sketch on a 2D context of SKETCH_WIDTH x SKETCH_HEIGHT.
 * Order: the photo, the map marks (zones, lines, risers, pump, mist wedges, dots, arrows, numbers), the labels, the scale bar.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} model from buildSketchModel
 * @param {{map: CanvasImageSource}} images
 */
export function drawSketch(ctx, model, { map }) {
  ctx.drawImage(map, 0, 0, MAP_WIDTH, MAP_HEIGHT);
  model.zones.forEach((z) => drawZone(ctx, z));
  model.lines.forEach((l) => drawLine(ctx, l));
  // The aim marks (wedges, arrows) are ours to keep off the photo's bottom strip, where Google's attribution sits:
  // a nozzle near the bottom edge can aim down past it. The staff's own points (dots, risers, pump) are not clipped,
  // so a point they placed there is never lost from the picture.
  const aimMarks = (list, draw) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, MAP_WIDTH, BOTTOM_LIMIT);
    ctx.clip();
    list.forEach(draw);
    ctx.restore();
  };
  // Every riser carries a nozzle, so it sprays like one: a wedge under its triangle.
  aimMarks([...model.nozzles, ...model.risers], (n) => drawMistWedge(ctx, n, n.aimHeading, n.reachPx));
  model.risers.forEach((r) => drawRiser(ctx, r));
  if (model.pump) drawPump(ctx, model.pump);
  model.nozzles.forEach((n) => drawNozzle(ctx, n));
  // Arrows over the dots, so a neighbour's dot never hides one (a nozzle aimed along its line points at the
  // next dot); the digits over the arrows, so an arrow never hides a number.
  aimMarks(model.nozzles, (n) => drawAimArrow(ctx, n, n.aimHeading, n.nearWater, NOZZLE_R + 3, n.arrowPx));
  model.nozzles.forEach((n) => drawNozzleNumber(ctx, n));
  drawLabels(ctx, model, [scaleBarRect(model)]);
  drawScaleBar(ctx, model);
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
 * Compose the sketch into a PNG Blob. The satellite image loads with crossOrigin="anonymous"; if
 * the canvas still taints, the tile is re-fetched (CORS-checked) and composed on a FRESH canvas, the same
 * fallback the Treatment Zone Mapper's export uses.
 */
export async function composeSketchPng({ mapImage, mapUrl, model }) {
  try {
    if (!mapImage) throw new Error('no loaded map image');
    return await renderToBlob(model, { map: mapImage });
  } catch {
    const res = await fetch(mapUrl);
    const bitmap = await createImageBitmap(await res.blob());
    return renderToBlob(model, { map: bitmap });
  }
}
