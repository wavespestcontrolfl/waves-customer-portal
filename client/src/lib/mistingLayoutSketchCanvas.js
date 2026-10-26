// Misting layout sketch, step 3: the canvas drawing and PNG export (GATE_MISTING_LAYOUT_DESIGNER).
//
// Draws the model from mistingLayoutSketch.js: a header (logo, title, address, date), the satellite photo
// with the lines, numbered nozzles, risers, pump and no-mist zones over it, and a footer (legend, scale
// bar, concept note). The photo is drawn whole and nothing covers its bottom corners, so Google's own
// attribution in the static image stays visible.
import { MAP_HEIGHT, MAP_WIDTH } from '../components/tech/treatmentZoneSpray';
import {
  SKETCH_FOOTER_H,
  SKETCH_HEADER_H,
  SKETCH_HEIGHT,
  SKETCH_WIDTH,
  zoneLabel,
} from './mistingLayoutSketch';

const INK = '#04395E';
const MUTED = '#475569';
const COPPER = '#b87333';
const WARN = '#dc2626';
const PUMP = '#1d4ed8';
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
  outlinedText(ctx, zoneLabel(zone), zone.x, zone.y, 26);
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

// Eave nozzles are black with white digits, fence nozzles white with black digits, as on the screen.
function drawNozzle(ctx, nozzle) {
  const fence = nozzle.kind === 'fence';
  ctx.save();
  ctx.beginPath();
  ctx.arc(nozzle.x, nozzle.y, 17, 0, Math.PI * 2);
  ctx.fillStyle = fence ? '#fff' : '#000';
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = fence ? '#000' : '#fff';
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.font = `700 ${nozzle.number > 99 ? 15 : 20}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fence ? '#000' : '#fff';
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
  outlinedText(ctx, 'Pump', pump.x, pump.y + 40, 26);
}

function drawHeader(ctx, model, logo) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SKETCH_WIDTH, SKETCH_HEADER_H);
  const left = logo ? 130 : 30;
  if (logo) ctx.drawImage(logo, 24, 15, 100, 100);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `700 42px ${FONT}`;
  ctx.fillText(model.title, left, 62);
  ctx.fillStyle = MUTED;
  ctx.font = `400 28px ${FONT}`;
  ctx.fillText(model.address, left, 104, SKETCH_WIDTH - left - 330);
  ctx.textAlign = 'right';
  ctx.fillText(model.dateLabel, SKETCH_WIDTH - 30, 62);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, SKETCH_HEADER_H - 2);
  ctx.lineTo(SKETCH_WIDTH, SKETCH_HEADER_H - 2);
  ctx.stroke();
}

function drawLegend(ctx, model, top) {
  const rowH = 34;
  const boxH = 24 + model.legend.length * rowH;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(24, top, 560, boxH);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, top, 560, boxH);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.font = `400 26px ${FONT}`;
  model.legend.forEach((row, i) => ctx.fillText(row, 44, top + 28 + i * rowH));
  return boxH;
}

function drawScaleBar(ctx, model, top) {
  const x = SKETCH_WIDTH - 24 - model.scale.px;
  const y = top + 44;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x, y - 10);
  ctx.lineTo(x, y);
  ctx.lineTo(x + model.scale.px, y);
  ctx.lineTo(x + model.scale.px, y - 10);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = `400 26px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${model.scale.feet} ft`, x + model.scale.px / 2, y + 36);
}

function drawFooter(ctx, model) {
  const top = SKETCH_HEADER_H + MAP_HEIGHT;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, top, SKETCH_WIDTH, SKETCH_FOOTER_H);
  drawLegend(ctx, model, top + 14);
  drawScaleBar(ctx, model, top + 14);
  ctx.fillStyle = MUTED;
  ctx.font = `700 26px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(model.concept, 24, SKETCH_HEIGHT - 20, SKETCH_WIDTH - 48);
}

/**
 * Draw the whole sketch on a 2D context of SKETCH_WIDTH x SKETCH_HEIGHT.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} model from buildSketchModel
 * @param {{map: CanvasImageSource, logo?: CanvasImageSource|null}} images
 */
export function drawSketch(ctx, model, { map, logo = null }) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SKETCH_WIDTH, SKETCH_HEIGHT);
  drawHeader(ctx, model, logo);
  ctx.drawImage(map, 0, SKETCH_HEADER_H, MAP_WIDTH, MAP_HEIGHT);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, SKETCH_HEADER_H, MAP_WIDTH, MAP_HEIGHT);
  ctx.clip();
  ctx.translate(0, SKETCH_HEADER_H);
  model.zones.forEach((z) => drawZone(ctx, z));
  model.lines.forEach((l) => drawLine(ctx, l));
  model.risers.forEach((r) => drawRiser(ctx, r));
  if (model.pump) drawPump(ctx, model.pump);
  model.nozzles.forEach((n) => drawNozzle(ctx, n));
  ctx.restore();
  drawFooter(ctx, model);
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
