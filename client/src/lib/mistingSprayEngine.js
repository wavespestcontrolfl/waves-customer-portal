// The misting spray animation, without React (GATE_MISTING_LAYOUT_DESIGNER). Shared by the staff designer's spray layer
// (components/admin/misting-designer/MistingSprayLayer) and the customer estimate page's overlay, so the two never drift.
//
// A few soft puffs per nozzle drift along the nozzle's aim and fade over about its throw (10 ft, 5 ft near water),
// in a loop. The engine draws into a 2D context in the 1280 by 960 map space; the caller owns the requestAnimationFrame
// loop (and stops it when hidden or offscreen) and calls tick(now) once per frame.
import { MAP_HEIGHT, MAP_WIDTH } from '../components/tech/treatmentZoneSpray';
import { aimReachPx, aimVector } from './mistingLayoutAim';
import { drawMistPuff } from './mistingLayoutMistDraw';

export const FRAME_MS = 1000 / 60;
const SPAWN_EVERY_MS = 100; // one puff per nozzle
const MAX_PARTICLES = 2500;
const SPREAD_RAD = 0.9;
const FRICTION = 0.985; // per 60 Hz frame

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

/**
 * @param {CanvasRenderingContext2D} ctx drawn in map pixels (the caller scales the canvas or the context)
 * @param {() => {nozzles: Array<{key:string,x:number,y:number}>, aims: Map<string, object>, lat: number, zoom: number}} getLive
 *   read on every spawn, so an edit does not restart the loop
 * @returns {{tick:(now:number)=>void, resume:()=>void, clear:()=>void}}
 */
export function createSprayEngine(ctx, getLive) {
  const parts = [];
  let last = 0;
  let sinceSpawn = 0;
  return {
    /** Advance the particles to `now` (a requestAnimationFrame timestamp) and draw the frame. */
    tick(now) {
      const dt = last ? Math.min(now - last, 100) : FRAME_MS;
      last = now;
      const k = dt / FRAME_MS;
      sinceSpawn += dt;
      if (sinceSpawn >= SPAWN_EVERY_MS) {
        sinceSpawn = 0;
        const { nozzles, aims, lat, zoom } = getLive();
        spawn(parts, nozzles, aims, lat, zoom);
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
    },
    /** After a pause: the next tick takes one frame of time, not the whole pause. */
    resume() { last = 0; },
    clear() { ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT); },
  };
}
