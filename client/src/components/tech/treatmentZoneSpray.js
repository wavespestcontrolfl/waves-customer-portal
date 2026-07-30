// client/src/components/tech/treatmentZoneSpray.js
//
// Geometry helpers + spray-mist animation engine for the Treatment Zone
// Mapper. Deliberately React-free (plain canvas + rAF) so the same engine can
// back a future server-side MP4/GIF renderer. Ported from the standalone
// treatment-zone sandbox (2026-07-18).
//
// Coordinate system: the Google Static Map is requested at 640x480 with
// scale=2, so the fetched image is 1280x960 physical pixels. ALL path math
// lives in that physical pixel space — metersPerPixel divides by MAP_SCALE.

export const MAP_LOGICAL_WIDTH = 640;
export const MAP_LOGICAL_HEIGHT = 480;
export const MAP_SCALE = 2;
export const MAP_WIDTH = MAP_LOGICAL_WIDTH * MAP_SCALE;
export const MAP_HEIGHT = MAP_LOGICAL_HEIGHT * MAP_SCALE;
// Owner ask (2026-07-23): frame the home tighter. Zoom 21 first, stepping
// down where Google has no imagery that deep — the traced zoom is saved in
// the payload, so all downstream px→ft/latLng math follows automatically.
export const ZOOM_ATTEMPTS = [21, 20, 19];
// Owner ask (2026-07-29): the default frame is sometimes TOO tight to finish
// the trace — the modal exposes −/+ zoom steps down to this floor (the max is
// whatever zoom the initial imagery probe accepted).
export const MIN_TRACE_ZOOM = 18;

export function staticMapUrl(lat, lng, zoom, apiKey) {
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: String(zoom),
    size: `${MAP_LOGICAL_WIDTH}x${MAP_LOGICAL_HEIGHT}`,
    scale: String(MAP_SCALE),
    maptype: 'satellite',
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

export function loadMapImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The satellite photo failed to load.'));
    img.src = url;
  });
}

// Over-zoomed satellite requests fail two different ways depending on the
// area: the image errors outright, or Google returns a valid-but-flat tile
// (solid black / "no imagery" gray). Sample luminance spread to catch the
// second kind — a real aerial photo is far busier than any placeholder.
function imageLooksBlank(image) {
  const SAMPLE = 64;
  try {
    const c = document.createElement('canvas');
    c.width = SAMPLE;
    c.height = SAMPLE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    const n = SAMPLE * SAMPLE;
    let sum = 0;
    const lums = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const o = i * 4;
      const lum = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      lums[i] = lum;
      sum += lum;
    }
    const mean = sum / n;
    let busy = 0;
    for (let i = 0; i < n; i += 1) {
      if (Math.abs(lums[i] - mean) > 10) busy += 1;
    }
    // Placeholder tiles are near-uniform (text glyphs are a tiny fraction of
    // pixels). Bias toward accepting: a false "blank" only costs one zoom step.
    return busy / n < 0.05;
  } catch {
    // Tainted canvas — can't inspect, accept the tile (same as before).
    return false;
  }
}

/** Try each zoom in order; resolve the first one with real imagery. */
export async function loadBestMapImage(lat, lng, apiKey, zooms = ZOOM_ATTEMPTS) {
  let lastErr = null;
  for (let i = 0; i < zooms.length; i += 1) {
    const zoom = zooms[i];
    const url = staticMapUrl(lat, lng, zoom, apiKey);
    try {
      const image = await loadMapImage(url);
      if (i < zooms.length - 1 && imageLooksBlank(image)) continue;
      return { image, url, zoom };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('The satellite photo failed to load.');
}

/**
 * Re-project already-dropped trace points when the tech steps the map zoom.
 * The Static Map re-centers on the same lat/lng, so one zoom step is a pure
 * 2× scale about the frame center — the points keep marking the same ground.
 */
export function rescalePointsForZoom(points, deltaZoom) {
  const f = Math.pow(2, deltaZoom);
  return points.map((p) => ({
    x: MAP_WIDTH / 2 + (p.x - MAP_WIDTH / 2) * f,
    y: MAP_HEIGHT / 2 + (p.y - MAP_HEIGHT / 2) * f,
  }));
}

// ── Home alignment (owner 2026-07-29) ───────────────────────────────────────
// Static Maps tiles are always north-up, so homes on angled lots render
// crooked. The fix: rotate the working frame about its center so the home's
// walls sit square. Rotation preserves scale, so px→ft math is untouched;
// only lat/lng conversion needs the point un-rotated back to map space first.

/**
 * Length-weighted dominant orientation of a traced loop, in the 90°-periodic
 * domain (walls and their perpendiculars agree). Returns radians in
 * (-π/4, π/4] — the rotation that squares the loop is the negative of this.
 *
 * Orientation-less loops return 0: when the 4θ resultant nearly cancels
 * (circles, octagons, organic lawn edges), atan2 of the float residue would
 * otherwise manufacture an arbitrary tilt that passes the alignment
 * threshold and rotates the frame for no reason (pre-push audit P1
 * 2026-07-30). Confidence = resultant magnitude / total length; a rectangle
 * scores ~1, a circle ~0.
 */
const ORIENTATION_MIN_CONFIDENCE = 0.35;
export function dominantAngleRad(points, closed) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const pts = closed && points.length > 2 ? [...points, points[0]] : points;
  let sx = 0;
  let sy = 0;
  let totalLen = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    totalLen += len;
    const ang = Math.atan2(dy, dx);
    sx += len * Math.cos(4 * ang);
    sy += len * Math.sin(4 * ang);
  }
  if (!totalLen || Math.hypot(sx, sy) / totalLen < ORIENTATION_MIN_CONFIDENCE) return 0;
  return Math.atan2(sy, sx) / 4;
}

/** Rotate points by -angleRad about the frame center (pairs buildAlignedBase). */
export function rotatePointsAboutCenter(points, angleRad) {
  const c = Math.cos(-angleRad);
  const s = Math.sin(-angleRad);
  return points.map((p) => {
    const dx = p.x - MAP_WIDTH / 2;
    const dy = p.y - MAP_HEIGHT / 2;
    return { x: MAP_WIDTH / 2 + dx * c - dy * s, y: MAP_HEIGHT / 2 + dx * s + dy * c };
  });
}

/** Inverse of rotatePointsAboutCenter for a single point (aligned → map px). */
export function unrotatePointAboutCenter(p, angleRad) {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const dx = p.x - MAP_WIDTH / 2;
  const dy = p.y - MAP_HEIGHT / 2;
  return { x: MAP_WIDTH / 2 + dx * c - dy * s, y: MAP_HEIGHT / 2 + dx * s + dy * c };
}

/**
 * Build the aligned working frame: fetch ONE ZOOM STEP LOWER (2× the ground
 * span at half the px density), rotate about the shared center, and let the
 * standard frame crop it at the original zoom's scale. The doubled source's
 * inscribed half-height (960px) always covers the crop's half-diagonal
 * (800px), so no rotation angle can expose blank corners.
 * Throws when the tile fails or the canvas taints (verified up front —
 * a tainted aligned frame could never be composited into the snapshot).
 */
export async function buildAlignedBase(lat, lng, zoom, apiKey, angleRad) {
  const img = await loadMapImage(staticMapUrl(lat, lng, zoom - 1, apiKey));
  const c = document.createElement('canvas');
  c.width = MAP_WIDTH;
  c.height = MAP_HEIGHT;
  const ctx = c.getContext('2d');
  ctx.translate(MAP_WIDTH / 2, MAP_HEIGHT / 2);
  ctx.rotate(-angleRad);
  ctx.scale(2, 2);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.getImageData(0, 0, 1, 1); // taint probe — throws on a CORS-dirty canvas
  // data: URL for the display <img> — the deployed CSP allows data: in
  // img-src (connect-src does not, but the taint probe above guarantees the
  // compose path never needs to re-fetch this URL).
  return { image: c, url: c.toDataURL('image/png') };
}

/** Meters per physical image pixel at this latitude/zoom (scale-2 imagery). */
export function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom) / MAP_SCALE;
}

export function pathLengthPx(points, closed) {
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (closed && points.length > 2) {
    const a = points[points.length - 1];
    const b = points[0];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

export function pxToFeet(px, lat, zoom) {
  return px * metersPerPixel(lat, zoom) * 3.28084;
}

/** Web-Mercator: physical image pixel -> lat/lng, given the map center + zoom. */
export function pixelToLatLng(px, center, zoom) {
  const worldSize = 256 * Math.pow(2, zoom);
  const cx = ((center.lng + 180) / 360) * worldSize;
  const siny = Math.sin((center.lat * Math.PI) / 180);
  const cy = (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * worldSize;
  const wx = cx + (px.x - MAP_WIDTH / 2) / MAP_SCALE;
  const wy = cy + (px.y - MAP_HEIGHT / 2) / MAP_SCALE;
  const lng = (wx / worldSize) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * wy) / worldSize;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

// ── Spray engine ─────────────────────────────────────────────────────────────

// Owner ask (2026-07-29): the mist band reads too small on-site — wider band,
// bigger puffs. Color tuning landed on FRIENDLY waves blue: the near-opaque
// navy build read like a shadow ("the color needs to be friendly, inviting"),
// so the band keeps a soft white-mixed core over the brand-blue mist.
const BAND_RADIUS = 44;
const BAND_JITTER = 12;
const STAMP_STEP = 4;
const STAMP_ALPHA_CORE = 0.075;
const STAMP_ALPHA_EDGE = 0.05;
const MIST_LIGHT_MIX = 0.45;
// Interior wash alphas — the baked footprint fill for interior-spray traces.
const INTERIOR_FILL_ALPHA = 0.12;
const INTERIOR_FILL_LIGHT_ALPHA = 0.05;
// Lawn highlight (owner 2026-07-30, iterated live: "focus on the lawn" →
// "only illuminate the lawn areas" → "not a box, it just should highlight
// the lawn areas"): the render paints a luminous turf-green highlight over
// the ACTUAL GRASS inside the traced property boundary — no polygon outline,
// no darkening of the rest of the photo. The traced loop is only the
// property scope; the grass is the subject. Turf is detected per-pixel
// (see the inverted not-roof/not-pool/not-white test below — SWFL lawns run
// green through browning tan). Never a flat FILL of the loop (codex P1
// #3038 r3). Fallback when the imagery is not pixel-readable: the classic
// clean outline.
const HIGHLIGHT_RGB = [96, 214, 116];
const HIGHLIGHT_ALPHA = 0.48;

/**
 * Turf pixel test, inverted on purpose: SWFL lawns run green through
 * browning tan, so "must be green" misses half the actual lawn. Exclude
 * what is clearly NOT turf — neutral gray (shingle roofs/drives/screens:
 * tiny channel spread), blue-dominant (pools), near-white (lanai frames,
 * bright concrete), and RED-DOMINANT (terracotta/barrel-tile roofs, mulch
 * beds — codex P1 #3075: r≫g passed the old test). Browning turf is warm
 * but never red-dominant (r-g ≲ 25); tile roofs and mulch run r-g ≈ 50-90.
 * Trees passing is fine — vegetation on the lawn. Pinned by
 * treatmentZoneSpray.turf.test.js.
 */
export function isTurfPixel(r, g, b) {
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return spread >= 18 && b < Math.max(r, g) && lum < 215 && (r - g) < 28;
}

/**
 * Confidently GREEN turf — excess-green AND green strictly above red.
 * Dry-tan turf/pavers (r > g) are deliberately excluded: tan is the
 * ambiguous band turf shares with beige hardscape, so it can never count
 * toward highlight confidence (codex P1 #3075: (160,140,100) passed a
 * green test that lacked the g > r requirement).
 */
export function isConfidentTurfPixel(r, g, b) {
  return (2 * g - r - b) >= 18 && g > r && b < g;
}

/**
 * The highlight-confidence verdict: a mask must light ≥1% of the traced
 * loop AND ≥35% of what it lights must be confidently green, or the caller
 * falls back to the truthful outline — a paver/beige-dominated area can
 * never save as a grass highlight.
 */
export function lawnMaskPasses({ insideCount, litCount, confidentCount }) {
  if (!insideCount || !litCount || litCount / insideCount < 0.01) return false;
  return confidentCount / litCount >= 0.35;
}

/**
 * Region growing from confidently-green seeds (codex P1 #3075): ambiguous
 * tan pixels only light when CONNECTED to confident green — a browning
 * patch inside the lawn stays lit, while a beige paver patio that never
 * touches grass is dropped entirely, no matter how much grass exists
 * elsewhere in the trace. 4-neighbor multi-source flood fill, constrained
 * by LOCAL COLOR CONTINUITY (codex P1 #3075 round 2): growth only crosses
 * into a neighbor whose color is close to the current pixel's, so gradual
 * grass→browning transitions propagate while the sharp edge onto an
 * ADJOINING paver/walkway stops the fill at the boundary.
 * `colors` is the RGBA byte array the pixels were classified from.
 */
const TURF_GROW_MAX_COLOR_STEP = 72;
export function growTurfRegion(eligible, confident, w, h, colors) {
  const kept = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (confident[i] && eligible[i]) {
      kept[i] = 1;
      stack.push(i);
    }
  }
  const smooth = (a, b) => {
    if (!colors) return true;
    const oa = a * 4;
    const ob = b * 4;
    return (
      Math.abs(colors[oa] - colors[ob])
      + Math.abs(colors[oa + 1] - colors[ob + 1])
      + Math.abs(colors[oa + 2] - colors[ob + 2])
    ) <= TURF_GROW_MAX_COLOR_STEP;
  };
  const tryGrow = (from, to) => {
    if (eligible[to] && !kept[to] && smooth(from, to)) {
      kept[to] = 1;
      stack.push(to);
    }
  };
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) tryGrow(i, i - 1);
    if (x < w - 1) tryGrow(i, i + 1);
    if (i >= w) tryGrow(i, i - w);
    if (i < w * (h - 1)) tryGrow(i, i + w);
  }
  return kept;
}

/**
 * Grass highlight mask: a width×height overlay canvas painting turf inside
 * the traced loop with the luminous green; everything else transparent.
 * Built at 320×240 and upscaled with a slight blur for soft organic edges.
 * Throws on a tainted source — callers fall back to the outline.
 */
export function buildLawnHighlightMask({ source, points, closed, width = MAP_WIDTH, height = MAP_HEIGHT }) {
  if (!closed || !Array.isArray(points) || points.length < 3) return null;
  const SW = 320;
  const SH = 240;
  const sc = document.createElement('canvas');
  sc.width = SW;
  sc.height = SH;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(source, 0, 0, SW, SH);
  const img = sctx.getImageData(0, 0, SW, SH);
  const pc = document.createElement('canvas');
  pc.width = SW;
  pc.height = SH;
  const pctx = pc.getContext('2d', { willReadFrequently: true });
  pctx.fillStyle = '#fff';
  pctx.beginPath();
  pctx.moveTo((points[0].x / width) * SW, (points[0].y / height) * SH);
  for (let i = 1; i < points.length; i += 1) {
    pctx.lineTo((points[i].x / width) * SW, (points[i].y / height) * SH);
  }
  pctx.closePath();
  pctx.fill();
  const poly = pctx.getImageData(0, 0, SW, SH);
  const n = SW * SH;
  const eligible = new Uint8Array(n);
  const confident = new Uint8Array(n);
  let insideCount = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    if (poly.data[o + 3] <= 127) continue;
    insideCount += 1;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    if (isTurfPixel(r, g, b)) {
      eligible[i] = 1;
      if (isConfidentTurfPixel(r, g, b)) confident[i] = 1;
    }
  }
  // Ambiguous tan only lights when CONNECTED to confident green through a
  // smooth color path — confident grass can't bless a detached paver patio,
  // and the sharp edge onto an adjoining walkway stops the fill
  // (codex P1 #3075).
  const kept = growTurfRegion(eligible, confident, SW, SH, img.data);
  const out = sctx.createImageData(SW, SH);
  const litA = Math.round(HIGHLIGHT_ALPHA * 255);
  let litCount = 0;
  let confidentCount = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    if (kept[i]) {
      litCount += 1;
      if (confident[i]) confidentCount += 1;
    }
    out.data[o] = HIGHLIGHT_RGB[0];
    out.data[o + 1] = HIGHLIGHT_RGB[1];
    out.data[o + 2] = HIGHLIGHT_RGB[2];
    out.data[o + 3] = kept[i] ? litA : 0;
  }
  // Confidence gates (codex P1s #3075): a mask that lights (almost) nothing
  // (fully dormant lawn, washed-out imagery), or whose lit area is NOT
  // dominated by confidently-green pixels, must not claim to be a grass
  // highlight — return null so callers fall back to the truthful outline
  // instead of baking hardscape into a customer report as treated lawn.
  if (!lawnMaskPasses({ insideCount, litCount, confidentCount })) return null;
  const oc = document.createElement('canvas');
  oc.width = SW;
  oc.height = SH;
  oc.getContext('2d').putImageData(out, 0, 0);
  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const mctx = mask.getContext('2d');
  try { mctx.filter = 'blur(3px)'; } catch { /* older engines: unfiltered upscale */ }
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(oc, 0, 0, width, height);
  // Hard-clip at the traced boundary: the soft-edge blur bleeds the glow
  // past the property line onto the NEIGHBOR'S grass (owner 2026-07-30 —
  // "not the neighbor lawn as well"). Soft edges stay inside; the boundary
  // itself is exact.
  try { mctx.filter = 'none'; } catch { /* mirror the guard above */ }
  mctx.globalCompositeOperation = 'destination-in';
  mctx.beginPath();
  mctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) mctx.lineTo(points[i].x, points[i].y);
  mctx.closePath();
  mctx.fill();
  mctx.globalCompositeOperation = 'source-over';
  return mask;
}
const PULSE_MS = 1200;
const BREATH_MS = 2400;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixWithWhite([r, g, b], amt) {
  return [
    Math.round(r + (255 - r) * amt),
    Math.round(g + (255 - g) * amt),
    Math.round(b + (255 - b) * amt),
  ];
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function startSprayEngine({
  canvas,
  width,
  height,
  points,
  closed,
  mistColor,
  headColor,
  // Waves mascot logo rides the line as the emitter (owner 2026-07-29 —
  // "use the waves logo instead of the circle"). Optional: falls back to the
  // original circle head when the image hasn't loaded.
  logoImage,
  // Interior spray showcase (owner 2026-07-29): the traced building footprint
  // floods with a soft brand-blue wash after the perimeter pass — interior
  // treatments finally render instead of looking like an untouched roof.
  interior = false,
  // Lawn outline animation (owner 2026-07-30 "now lets do it for lawn"):
  // instead of the spray-mist band, a clean brand-blue outline DRAWS itself
  // around the boundary with the mascot riding the tip, then breathes.
  // Lawn keeps its no-smoke ruling (owner 2026-07-28) — this is a line, not
  // a mist band, and there is never an interior fill (codex P1 #3038 r3).
  outlineMode = false,
  // The working satellite frame — outlineMode reads its pixels to build the
  // grass-aware spotlight mask (fail-soft when tainted/absent).
  baseImage = null,
  durationMs,
  totalFeet,
  reducedMotion,
  onStatus,
  onSettled,
}) {
  const pts = closed && points.length > 2 ? [...points, points[0]] : [...points];
  const segLens = [];
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segLens.push(l);
    cum.push(cum[i - 1] + l);
  }
  const total = cum[cum.length - 1] || 1;

  const mist = hexToRgb(mistColor);
  const mistLight = mixWithWhite(mist, MIST_LIGHT_MIX);
  const head = hexToRgb(headColor);

  const ctx = canvas.getContext('2d');
  const accum = document.createElement('canvas');
  accum.width = width;
  accum.height = height;
  const actx = accum.getContext('2d');
  // Lawn: the settled frame is the grass HIGHLIGHT (no box — owner
  // 2026-07-30). Falls back to the classic clean outline when the imagery
  // isn't pixel-readable.
  let lawnHighlight = false;
  if (outlineMode) {
    let baked = null;
    if (baseImage && closed && points.length > 2) {
      try {
        baked = buildLawnHighlightMask({ source: baseImage, points, closed, width, height });
      } catch { baked = null; }
    }
    lawnHighlight = Boolean(baked);
    actx.drawImage(baked || buildOutlineAccum({ width, height, points, closed, color: mistColor }), 0, 0);
  }

  let viewScale = 1;
  let stopped = false;
  let lastFrame = null;

  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    viewScale = w / width;
  };
  fit();
  // fit() clears the backing store when the size changes, so always repaint
  // the last frame — with reduced motion there is no rAF loop to repaint.
  const ro = new ResizeObserver(() => {
    fit();
    if (lastFrame) lastFrame();
  });
  ro.observe(canvas);

  const pointAt = (dist) => {
    const d = Math.max(0, Math.min(dist, total));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i += 1;
    const segStart = cum[i - 1];
    const segLen = segLens[i - 1] || 1;
    const t = (d - segStart) / segLen;
    const a = pts[i - 1];
    const b = pts[i];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  };

  const stampBand = (from, to) => {
    for (let d = from; d <= to; d += STAMP_STEP) {
      const p = pointAt(d);
      const jitter = BAND_RADIUS + (Math.random() - 0.5) * BAND_JITTER;
      const g = actx.createRadialGradient(p.x, p.y, 0, p.x, p.y, jitter);
      g.addColorStop(0, rgba(mistLight, STAMP_ALPHA_CORE));
      g.addColorStop(0.6, rgba(mist, STAMP_ALPHA_EDGE));
      g.addColorStop(1, rgba(mist, 0));
      actx.fillStyle = g;
      actx.beginPath();
      actx.arc(p.x, p.y, jitter, 0, Math.PI * 2);
      actx.fill();
    }
  };

  const drawBase = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    ctx.drawImage(accum, 0, 0);
  };

  const drawPuff = (p) => {
    const lifeT = p.age / p.life;
    const alpha = Math.sin(Math.PI * Math.min(1, lifeT)) * 0.32;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    g.addColorStop(0, rgba(mixWithWhite(mist, 0.5), alpha));
    g.addColorStop(0.55, rgba(mistLight, alpha * 0.6));
    g.addColorStop(1, rgba(mist, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawHead = (x, y) => {
    if (logoImage && logoImage.width) {
      // Waves mascot rides the line — soft white halo keeps it readable over
      // dark imagery. Kept upright (logos don't rotate along paths).
      const halo = ctx.createRadialGradient(x, y, 0, x, y, 52);
      halo.addColorStop(0, 'rgba(255,255,255,0.6)');
      halo.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, 52, 0, Math.PI * 2);
      ctx.fill();
      const w = 76;
      const h = w * (logoImage.height / logoImage.width);
      ctx.drawImage(logoImage, x - w / 2, y - h / 2, w, h);
      return;
    }
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 38);
    glow.addColorStop(0, rgba(head, 0.5));
    glow.addColorStop(1, rgba(head, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(head, 0.9);
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,236,220,0.95)';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  };

  const strokePath = (lineWidth, style) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };

  // Outline draw-in: stroke the path only up to `dist` px along its length.
  const strokePartial = (dist, lineWidth, style) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    let remaining = dist;
    for (let i = 1; i < pts.length && remaining > 0; i += 1) {
      const seg = segLens[i - 1];
      if (seg <= remaining) {
        ctx.lineTo(pts[i].x, pts[i].y);
        remaining -= seg;
      } else {
        const t = remaining / (seg || 1);
        ctx.lineTo(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t);
        remaining = 0;
      }
    }
    ctx.stroke();
  };

  // Blank the view without painting the accum — the draw-in phase must not
  // reveal the finished outline behind the growing line.
  const clearView = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  };

  // Interior wash needs a genuinely closed footprint — an open path has no
  // interior to claim.
  const fillInterior = interior && closed && points.length > 2;
  const fillPath = (target, style) => {
    target.fillStyle = style;
    target.beginPath();
    target.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) target.lineTo(points[i].x, points[i].y);
    target.closePath();
    target.fill();
  };

  // Draw the accum at a given opacity — the lawn highlight fades in with
  // this and breathes with it once settled.
  const drawBaseFaded = (alpha) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(accum, 0, 0);
    ctx.restore();
  };

  if (reducedMotion) {
    if (!outlineMode) {
      stampBand(0, total);
      if (fillInterior) {
        fillPath(actx, rgba(mist, INTERIOR_FILL_ALPHA));
        fillPath(actx, rgba(mistLight, INTERIOR_FILL_LIGHT_ALPHA));
      }
    }
    lastFrame = () => drawBase();
    lastFrame();
    onStatus({ phase: 'settled', pct: 1, feet: totalFeet });
    onSettled(accum);
    return {
      stop() {
        stopped = true;
        ro.disconnect();
      },
    };
  }

  let raf = 0;
  let phase = 'spraying';
  let prevTs = 0;
  let sprayT = 0;
  let phaseT = 0;
  let paintedDist = 0;
  let puffs = [];
  let spawnDebt = 0;
  let settledFired = false;

  const spawnPuffs = (x, y, angle, dt) => {
    spawnDebt += dt * 80;
    while (spawnDebt >= 1) {
      spawnDebt -= 1;
      const side = Math.random() < 0.5 ? 1 : -1;
      const perp = angle + (side * Math.PI) / 2 + (Math.random() - 0.5) * 0.9;
      const speed = 14 + Math.random() * 30;
      puffs.push({
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 18,
        vx: Math.cos(perp) * speed,
        vy: Math.sin(perp) * speed - 6,
        r: 12 + Math.random() * 9,
        growth: 34 + Math.random() * 24,
        age: 0,
        life: 0.9 + Math.random() * 0.5,
      });
    }
  };

  const frame = (ts) => {
    if (stopped) return;
    const dt = prevTs ? Math.min(0.05, (ts - prevTs) / 1000) : 0.016;
    prevTs = ts;

    if (phase === 'spraying') {
      sprayT += dt * 1000;
      const dist = Math.min(total, (sprayT / durationMs) * total);
      const p = pointAt(dist);
      if (outlineMode && lawnHighlight) {
        // Lawn: the highlight SWEEPS across the property revealing the lit
        // turf, with a shimmer riding the front edge (clipped to the turf
        // pixels via source-atop). No box, no line, no mascot (owner
        // 2026-07-30 "not a box, it just should highlight the lawn areas").
        const pct = dist / total;
        clearView();
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width * pct, height);
        ctx.clip();
        ctx.globalAlpha = Math.min(1, pct * 4);
        ctx.drawImage(accum, 0, 0);
        ctx.restore();
        const edge = width * pct;
        const shine = ctx.createLinearGradient(edge - 90, 0, edge, 0);
        shine.addColorStop(0, 'rgba(255,255,255,0)');
        shine.addColorStop(1, 'rgba(255,255,255,0.55)');
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = shine;
        ctx.fillRect(edge - 90, 0, 90, height);
        ctx.restore();
      } else if (outlineMode) {
        // Fallback (imagery not pixel-readable): the classic outline draws
        // itself with a soft glow tip. No mascot, no smoke.
        clearView();
        strokePartial(dist, 16, rgba(mist, 0.28));
        strokePartial(dist, 9, rgba([255, 255, 255], 0.6));
        strokePartial(dist, 4.5, rgba(mist, 0.92));
        const tip = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26);
        tip.addColorStop(0, 'rgba(255,255,255,0.85)');
        tip.addColorStop(0.5, rgba(mistLight, 0.5));
        tip.addColorStop(1, rgba(mist, 0));
        ctx.fillStyle = tip;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
        ctx.fill();
      } else {
        if (dist > paintedDist) {
          stampBand(paintedDist, dist);
          paintedDist = dist;
        }
        spawnPuffs(p.x, p.y, p.angle, dt);

        for (const puff of puffs) {
          puff.age += dt;
          puff.x += puff.vx * dt;
          puff.y += puff.vy * dt;
          puff.vx *= 0.985;
          puff.vy *= 0.985;
          puff.r += puff.growth * dt;
        }
        puffs = puffs.filter((q) => q.age < q.life);

        drawBase();
        for (const puff of puffs) drawPuff(puff);
        drawHead(p.x, p.y);
      }

      const pct = dist / total;
      onStatus({ phase, pct, feet: totalFeet * pct });

      if (dist >= total) {
        phase = 'pulse';
        phaseT = 0;
        if (!settledFired) {
          settledFired = true;
          onSettled(accum);
        }
      }
    } else if (phase === 'pulse') {
      phaseT += dt * 1000;
      const t = Math.min(1, phaseT / PULSE_MS);

      for (const puff of puffs) {
        puff.age += dt;
        puff.x += puff.vx * dt;
        puff.y += puff.vy * dt;
        puff.r += puff.growth * dt;
      }
      puffs = puffs.filter((q) => q.age < q.life);

      if (outlineMode && lawnHighlight) {
        // Highlight settles with a single gentle over-bright swell (second
        // accum pass stacks alpha on the turf pixels only).
        drawBaseFaded(1);
        ctx.save();
        ctx.globalAlpha = 0.35 * Math.sin(Math.PI * t);
        ctx.drawImage(accum, 0, 0);
        ctx.restore();
        onStatus({ phase, pct: 1, feet: totalFeet });
        if (t >= 1) {
          phase = 'settled';
          phaseT = 0;
          onStatus({ phase, pct: 1, feet: totalFeet });
        }
        lastFrame = drawBase;
        raf = requestAnimationFrame(frame);
        return;
      }
      drawBase();
      for (const puff of puffs) drawPuff(puff);

      // Interior wash floods in during the one-shot pulse sweep.
      if (fillInterior) fillPath(ctx, rgba(mist, INTERIOR_FILL_ALPHA * t));
      const p = pointAt(t * total);
      const soft = Math.sin(Math.PI * t);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 120);
      g.addColorStop(0, rgba(mixWithWhite(mist, 0.85), 0.32 * soft));
      g.addColorStop(1, rgba(mist, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 120, 0, Math.PI * 2);
      ctx.fill();
      // Outline fallback celebrates with a tight halo on the line, not a band.
      strokePath(outlineMode ? 12 : BAND_RADIUS * 2, rgba(mistLight, (outlineMode ? 0.3 : 0.12) * soft));

      onStatus({ phase, pct: 1, feet: totalFeet });
      if (t >= 1) {
        phase = 'settled';
        phaseT = 0;
        onStatus({ phase, pct: 1, feet: totalFeet });
      }
    } else {
      // Settled loop PULSES (owner 2026-07-29): the whole band breathes —
      // no crisp center line in spray mode (owner: "don't do the line in
      // between"). Outline mode breathes the LINE itself (lawn is a clean
      // outline by ruling, so the line is the subject there).
      phaseT += dt * 1000;
      const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * phaseT) / BREATH_MS - Math.PI / 2);
      if (outlineMode && lawnHighlight) {
        // The highlighted lawn breathes — deep enough to read from a phone
        // in the field.
        drawBaseFaded(0.55 + 0.45 * wave);
      } else if (outlineMode) {
        drawBase();
        strokePath(16, rgba(mist, 0.06 + 0.2 * wave));
        strokePath(4.5, rgba(mist, 0.2 + 0.55 * wave));
      } else {
        drawBase();
        if (fillInterior) fillPath(ctx, rgba(mist, INTERIOR_FILL_ALPHA * (0.6 + 0.4 * wave)));
        strokePath(BAND_RADIUS * 2 + 12, rgba(mist, 0.04 + 0.16 * wave));
        strokePath(BAND_RADIUS, rgba(mistLight, 0.06 + 0.18 * wave));
      }
    }

    lastFrame = drawBase;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}

// Build the fully-settled band offscreen in one pass. The modal composes and
// saves the snapshot from this the moment Play starts — the animation is
// presentation only, so closing the sheet mid-spray can never lose a trace.
// Lawn variant (owner 2026-07-28): a lawn is treated as an AREA, not a
// perimeter barrier — the spray-mist band read wrong on lawn reports. Bake a
// clean outline of the treated lawn instead: soft outer glow + crisp line.
// Deliberately NO interior fill: the traced loop commonly wraps the whole
// yard with the house inside it, and a filled polygon would permanently
// shade the roof as "treated turf" in the snapshot (codex P1 #3038 r3).
// The customer report animates the pulse; this is the settled frame.
export function buildOutlineAccum({ width, height, points, closed, color }) {
  const rgb = hexToRgb(color);
  const accum = document.createElement('canvas');
  accum.width = width;
  accum.height = height;
  const ctx = accum.getContext('2d');
  if (!Array.isArray(points) || points.length < 2) return accum;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    if (closed && points.length > 2) ctx.closePath();
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  trace();
  ctx.strokeStyle = rgba(rgb, 0.3);
  ctx.lineWidth = 16;
  ctx.stroke();
  // White casing under the core — brand blue alone sinks into dark roofs and
  // shaded turf (matches the report overlay casing, owner 2026-07-29/30).
  trace();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 9;
  ctx.stroke();
  trace();
  ctx.strokeStyle = rgba(rgb, 0.92);
  ctx.lineWidth = 4.5;
  ctx.stroke();
  return accum;
}

export function buildSettledAccum({ width, height, points, closed, mistColor, interior = false }) {
  const pts = closed && points.length > 2 ? [...points, points[0]] : [...points];
  const mist = hexToRgb(mistColor);
  const mistLight = mixWithWhite(mist, MIST_LIGHT_MIX);
  const accum = document.createElement('canvas');
  accum.width = width;
  accum.height = height;
  const actx = accum.getContext('2d');
  // Interior-spray traces bake the footprint wash into the snapshot (owner
  // 2026-07-29). Closed loops only — an open path has no interior.
  if (interior && closed && points.length > 2) {
    actx.beginPath();
    actx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) actx.lineTo(points[i].x, points[i].y);
    actx.closePath();
    actx.fillStyle = rgba(mist, INTERIOR_FILL_ALPHA);
    actx.fill();
    actx.fillStyle = rgba(mistLight, INTERIOR_FILL_LIGHT_ALPHA);
    actx.fill();
  }
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    for (let d = 0; d <= segLen; d += STAMP_STEP) {
      const t = d / segLen;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const jitter = BAND_RADIUS + (Math.random() - 0.5) * BAND_JITTER;
      const g = actx.createRadialGradient(x, y, 0, x, y, jitter);
      g.addColorStop(0, rgba(mistLight, STAMP_ALPHA_CORE));
      g.addColorStop(0.6, rgba(mist, STAMP_ALPHA_EDGE));
      g.addColorStop(1, rgba(mist, 0));
      actx.fillStyle = g;
      actx.beginPath();
      actx.arc(x, y, jitter, 0, Math.PI * 2);
      actx.fill();
    }
  }
  return accum;
}

// Composite the satellite photo + settled mist band into one PNG Blob.
// toBlob, NOT toDataURL + fetch(dataUrl): the deployed CSP's connect-src
// does not allow data: URLs (only img-src does), so fetching a data URL
// would be blocked in production before the upload ever fired.
// The map <img> loads with crossOrigin="anonymous"; if the canvas still
// taints, re-fetch the tile via fetch() (CORS-checked) and compose on a
// FRESH canvas — a tainted canvas stays tainted no matter what is drawn
// onto it afterwards.
// Map-only PNG export for the auto-trace upload — same taint fallback as
// composeSnapshot: when the loaded Static Maps image is not canvas-readable,
// re-fetch it as a blob and compose from the bitmap.
export async function exportMapPng(mapImage, mapUrl) {
  const compose = (img) => {
    const c = document.createElement('canvas');
    c.width = MAP_WIDTH;
    c.height = MAP_HEIGHT;
    c.getContext('2d').drawImage(img, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    return new Promise((resolve, reject) => {
      try {
        c.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Map export produced no image'))),
          'image/png'
        );
      } catch (err) {
        reject(err);
      }
    });
  };
  try {
    return await compose(mapImage);
  } catch {
    const res = await fetch(mapUrl);
    const bitmap = await createImageBitmap(await res.blob());
    return compose(bitmap);
  }
}

export async function composeSnapshot(mapImage, accum, mapUrl) {
  const compose = (img) => {
    const c = document.createElement('canvas');
    c.width = MAP_WIDTH;
    c.height = MAP_HEIGHT;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.drawImage(accum, 0, 0);
    return new Promise((resolve, reject) => {
      try {
        c.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Snapshot export produced no image'))),
          'image/png'
        );
      } catch (err) {
        reject(err);
      }
    });
  };
  try {
    return await compose(mapImage);
  } catch {
    const res = await fetch(mapUrl);
    const bitmap = await createImageBitmap(await res.blob());
    return compose(bitmap);
  }
}
