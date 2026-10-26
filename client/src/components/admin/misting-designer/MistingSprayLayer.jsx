// The spray layer of the misting layout designer: a canvas over the photo (under the arrows and nozzles) that
// shows where each nozzle's mist goes. In motion, a few soft puffs per nozzle drift along the nozzle's aim and
// fade over about its throw (10 ft, 5 ft near water), in a loop. It stops when the designer closes (unmount)
// and while the tab is hidden. With reduced motion, or Spray off, nothing moves: when directions are shown
// each nozzle gets a still mist wedge instead.
import { useEffect, useRef } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { aimReachPx, aimVector } from '../../../lib/mistingLayoutAim';
import { drawMistPuff, drawMistWedge } from '../../../lib/mistingLayoutMistDraw';

const FRAME_MS = 1000 / 60;
const SPAWN_EVERY_MS = 100; // one puff per nozzle
const MAX_PARTICLES = 2500;
const SPREAD_RAD = 0.9;
const FRICTION = 0.985; // per 60 Hz frame

function contextOf(canvas) {
  try { return (canvas && canvas.getContext && canvas.getContext('2d')) || null; } catch { return null; }
}

function spawn(parts, nozzles, aims, lat, zoom) {
  nozzles.forEach((n) => {
    const aim = aims.get(n.key);
    if (!aim || parts.length >= MAX_PARTICLES) return;
    const v = aimVector(aim.heading);
    const turn = (Math.random() - 0.5) * SPREAD_RAD;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const speed = aimReachPx(aim, lat, zoom) / (55 + Math.random() * 25);
    parts.push({
      x: n.x,
      y: n.y,
      vx: (v.x * c - v.y * s) * speed,
      vy: (v.x * s + v.y * c) * speed,
      life: 0,
      max: 60 + Math.random() * 30,
      r: 7 + Math.random() * 7,
    });
  });
}

export default function MistingSprayLayer({ nozzles, aims, lat, zoom, animate, wedges }) {
  const canvasRef = useRef(null);
  // The loop reads the newest nozzles and aims from here, so an edit does not restart it.
  const live = useRef({ nozzles, aims, lat, zoom });
  live.current = { nozzles, aims, lat, zoom };

  useEffect(() => {
    const ctx = contextOf(canvasRef.current);
    if (!animate || !ctx) return undefined;
    const parts = [];
    let frame = 0;
    let last = 0;
    let sinceSpawn = 0;

    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      const dt = last ? Math.min(now - last, 100) : FRAME_MS;
      last = now;
      const k = dt / FRAME_MS;
      sinceSpawn += dt;
      if (sinceSpawn >= SPAWN_EVERY_MS) {
        sinceSpawn = 0;
        const { nozzles: ns, aims: as, lat: la, zoom: zo } = live.current;
        spawn(parts, ns, as, la, zo);
      }
      ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        p.life += k;
        if (p.life >= p.max) { parts.splice(i, 1); continue; }
        const drag = FRICTION ** k;
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vx *= drag;
        p.vy *= drag;
        p.r += 0.12 * k;
        // The Treatment Zone Mapper's blue puff: a white-mixed core fading to clear, so it reads on lawn and roof alike.
        drawMistPuff(ctx, p.x, p.y, p.r, Math.sin((Math.PI * p.life) / p.max) * 0.6);
      }
    };
    const start = () => {
      if (frame || document.hidden) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    };
  }, [animate]);

  // Still frame: a mist wedge per nozzle, redrawn whenever the nozzles or their aims change.
  useEffect(() => {
    const ctx = contextOf(canvasRef.current);
    if (animate || !ctx) return;
    ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    if (!wedges) return;
    nozzles.forEach((n) => {
      const aim = aims.get(n.key);
      if (aim) drawMistWedge(ctx, n, aim.heading, aimReachPx(aim, lat, zoom));
    });
  }, [animate, wedges, nozzles, aims, lat, zoom]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="layout-spray"
      data-mode={animate ? 'animated' : wedges ? 'wedges' : 'off'}
      width={MAP_WIDTH}
      height={MAP_HEIGHT}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full"
      style={{ pointerEvents: 'none' }}
    />
  );
}
