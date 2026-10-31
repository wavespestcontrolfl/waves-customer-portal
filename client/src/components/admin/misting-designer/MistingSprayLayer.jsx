// The spray layer of the misting layout designer: a canvas over the photo (under the arrows and nozzles) that
// shows where each nozzle's mist goes. In motion, a few soft puffs per nozzle drift along the nozzle's aim and
// fade over about its throw (10 ft, 5 ft near water), in a loop. It stops when the designer closes (unmount)
// and while the tab is hidden. With reduced motion, or Spray off, nothing moves: when directions are shown
// each nozzle gets a still mist wedge instead.
import { useEffect, useRef } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { aimReachPx } from '../../../lib/mistingLayoutAim';
import { drawMistWedge } from '../../../lib/mistingLayoutMistDraw';
import { createSprayEngine } from '../../../lib/mistingSprayEngine';

function contextOf(canvas) {
  try { return (canvas && canvas.getContext && canvas.getContext('2d')) || null; } catch { return null; }
}

export default function MistingSprayLayer({ nozzles, aims, lat, zoom, animate, wedges }) {
  const canvasRef = useRef(null);
  // The loop reads the newest nozzles and aims from here, so an edit does not restart it.
  const live = useRef({ nozzles, aims, lat, zoom });
  live.current = { nozzles, aims, lat, zoom };

  useEffect(() => {
    const ctx = contextOf(canvasRef.current);
    if (!animate || !ctx) return undefined;
    // The animation itself is the shared engine (lib/mistingSprayEngine); this layer owns the frame loop.
    const engine = createSprayEngine(ctx, () => live.current);
    let frame = 0;

    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      engine.tick(now);
    };
    const start = () => {
      if (frame || document.hidden) return;
      engine.resume();
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
      engine.clear();
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
