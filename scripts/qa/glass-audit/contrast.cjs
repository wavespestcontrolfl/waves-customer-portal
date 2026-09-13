'use strict';
// Contrast on the composited page: sample the screenshot pixels around each
// text element (its padding-edge corners, outside the glyphs) and compare
// with the computed text colour. Uses pngjs from the repo's devDependencies.
const { PNG } = require('pngjs');

function parseColor(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return null;
  const p = m[1].split(',').map((s) => parseFloat(s.trim()));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function lum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
// Translucent text paints as fg composited over the background; compare that, not the opaque channels.
function composite(fg, bg) {
  const a = fg.a == null ? 1 : Math.max(0, Math.min(1, fg.a));
  if (a >= 1) return fg;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}
function ratio(a, b) {
  const la = lum(a); const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function decode(buffer) { return PNG.sync.read(buffer); }
function pixel(png, x, y) {
  x = Math.max(0, Math.min(png.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(png.height - 1, Math.round(y)));
  const i = (png.width * y + x) << 2;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
}
// Sample a handful of points on the element's box edge (1px inside), and
// return the worst-case (lowest) contrast against the text colour plus the
// median background sample. dpr scales CSS px → screenshot px.
function sampleContrast(png, dpr, box, color) {
  const fg = parseColor(color);
  if (!fg) return null;
  const pts = [
    [box.x + 1, box.y + 1], [box.x + box.w - 2, box.y + 1],
    [box.x + 1, box.y + box.h - 2], [box.x + box.w - 2, box.y + box.h - 2],
    [box.x + box.w / 2, box.y + 1], [box.x + box.w / 2, box.y + box.h - 2],
  ];
  const samples = pts.map(([x, y]) => pixel(png, x * dpr, y * dpr));
  const ratios = samples.map((bg) => ratio(composite(fg, bg), bg));
  const min = Math.min(...ratios);
  const avg = samples.reduce((a, s) => ({ r: a.r + s.r / samples.length, g: a.g + s.g / samples.length, b: a.b + s.b / samples.length }), { r: 0, g: 0, b: 0 });
  return { min: Math.round(min * 100) / 100, avg: Math.round(ratio(composite(fg, avg), avg) * 100) / 100, alpha: fg.a, bg: `rgb(${Math.round(avg.r)}, ${Math.round(avg.g)}, ${Math.round(avg.b)})` };
}

module.exports = { decode, sampleContrast, parseColor, ratio, composite };
