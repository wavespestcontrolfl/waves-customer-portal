// The animated mist over the saved misting layout picture on the customer estimate page (GATE_MISTING_LAYOUT_DESIGNER).
// A canvas over the PNG: the shared spray engine (lib/mistingSprayEngine) draws blue puffs from every nozzle and riser
// along its aim, in the 1280 by 960 map space, scaled to the rendered width. Nothing moves with prefers-reduced-motion
// (the picture already shows still mist wedges), while the card is offscreen, or while the tab is hidden.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createSprayEngine } from '../../lib/mistingSprayEngine';
import { LAYOUT_MAP_HEIGHT, LAYOUT_MAP_WIDTH, buildSprayModel } from '../../lib/mistingLayoutPublic';

const MAX_DPR = 2;

function contextOf(canvas) {
  try { return (canvas && canvas.getContext && canvas.getContext('2d')) || null; } catch { return null; }
}

function prefersReducedMotion() {
  try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    let query = null;
    try { query = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch { query = null; }
    if (!query) return undefined;
    const onChange = () => setReduced(Boolean(query.matches));
    onChange();
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', onChange);
      else if (query.removeListener) query.removeListener(onChange);
    };
  }, []);
  return reduced;
}

/** True while the element is on screen (always true where IntersectionObserver is missing). */
function useOnScreen(ref) {
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => setOnScreen(entry.isIntersecting));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

function useTabVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * @param {object} props
 * @param {object} props.geometry the public `mistingLayout.geometry` block
 * @param {boolean} props.ready the picture has loaded (nothing sprays over a blank frame)
 */
export default function MistingSprayOverlay({ geometry, ready = true }) {
  const canvasRef = useRef(null);
  const model = useMemo(() => buildSprayModel(geometry), [geometry]);
  const reduced = useReducedMotion();
  const onScreen = useOnScreen(canvasRef);
  const tabVisible = useTabVisible();
  const active = Boolean(model) && ready && !reduced && onScreen && tabVisible;
  const state = active ? 'animated' : 'still';

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = contextOf(canvas);
    if (!active || !ctx) return undefined;

    // Draw in map pixels; the backing store follows the rendered width (and the screen's pixel ratio), so the same
    // coordinates land on the same spot of the picture at any size.
    const fit = () => {
      const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
      if (!width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const scale = (width * dpr) / LAYOUT_MAP_WIDTH;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(LAYOUT_MAP_HEIGHT * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    };
    fit();
    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(fit);
      resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', fit);

    const engine = createSprayEngine(ctx, () => model);
    let frame = 0;
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      engine.tick(now);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fit);
      if (resizeObserver) resizeObserver.disconnect();
      engine.clear();
    };
  }, [active, model]);

  if (!model) return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="misting-spray"
      data-mode={state}
      width={LAYOUT_MAP_WIDTH}
      height={LAYOUT_MAP_HEIGHT}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
}
