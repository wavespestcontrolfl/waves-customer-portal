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
export const DEFAULT_ZOOM = 20;
export const FALLBACK_ZOOM = 19;

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

const BAND_RADIUS = 30;
const STAMP_STEP = 4;
const PULSE_MS = 1200;
const BREATH_MS = 3000;

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
  const mistLight = mixWithWhite(mist, 0.55);
  const head = hexToRgb(headColor);

  const ctx = canvas.getContext('2d');
  const accum = document.createElement('canvas');
  accum.width = width;
  accum.height = height;
  const actx = accum.getContext('2d');

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
      const jitter = BAND_RADIUS + (Math.random() - 0.5) * 8;
      const g = actx.createRadialGradient(p.x, p.y, 0, p.x, p.y, jitter);
      g.addColorStop(0, rgba(mistLight, 0.055));
      g.addColorStop(0.6, rgba(mist, 0.035));
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
    const alpha = Math.sin(Math.PI * Math.min(1, lifeT)) * 0.28;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    g.addColorStop(0, rgba(mixWithWhite(mist, 0.8), alpha));
    g.addColorStop(0.55, rgba(mistLight, alpha * 0.6));
    g.addColorStop(1, rgba(mist, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawHead = (x, y) => {
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

  if (reducedMotion) {
    stampBand(0, total);
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
        x: x + (Math.random() - 0.5) * 14,
        y: y + (Math.random() - 0.5) * 14,
        vx: Math.cos(perp) * speed,
        vy: Math.sin(perp) * speed - 6,
        r: 8 + Math.random() * 7,
        growth: 24 + Math.random() * 18,
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
      if (dist > paintedDist) {
        stampBand(paintedDist, dist);
        paintedDist = dist;
      }
      const p = pointAt(dist);
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

      drawBase();
      for (const puff of puffs) drawPuff(puff);

      const p = pointAt(t * total);
      const soft = Math.sin(Math.PI * t);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 95);
      g.addColorStop(0, rgba(mixWithWhite(mist, 0.85), 0.32 * soft));
      g.addColorStop(1, rgba(mist, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 95, 0, Math.PI * 2);
      ctx.fill();
      strokePath(BAND_RADIUS * 2, rgba(mistLight, 0.1 * soft));

      onStatus({ phase, pct: 1, feet: totalFeet });
      if (t >= 1) {
        phase = 'settled';
        phaseT = 0;
        onStatus({ phase, pct: 1, feet: totalFeet });
      }
    } else {
      phaseT += dt * 1000;
      const breath = 0.045 + 0.035 * (0.5 + 0.5 * Math.sin((2 * Math.PI * phaseT) / BREATH_MS));
      drawBase();
      strokePath(BAND_RADIUS * 2, rgba(mistLight, breath));
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

// Composite the satellite photo + settled mist band into one PNG data URL.
// The map <img> loads with crossOrigin="anonymous"; if the canvas still
// taints, re-fetch the tile via fetch() (CORS-checked) and retry once.
export async function composeSnapshot(mapImage, accum, mapUrl) {
  const c = document.createElement('canvas');
  c.width = MAP_WIDTH;
  c.height = MAP_HEIGHT;
  const ctx = c.getContext('2d');
  const draw = (img) => {
    ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.drawImage(img, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.drawImage(accum, 0, 0);
  };
  draw(mapImage);
  try {
    return c.toDataURL('image/png');
  } catch {
    const res = await fetch(mapUrl);
    const bitmap = await createImageBitmap(await res.blob());
    draw(bitmap);
    return c.toDataURL('image/png');
  }
}
