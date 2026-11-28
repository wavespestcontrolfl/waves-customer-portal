/**
 * Glass engine — the surface-agnostic core of the liquid-glass design system
 * (Phase 0 of the glass rollout; extracted 1:1 from EstimateGlassTheme so the
 * scene/tokens can be reused beyond the estimate page).
 *
 * What lives here is everything that does NOT depend on any page's DOM:
 * the scene builder (mesh background, orbs, grain), the pointer FX (cursor
 * specular + parallax), the confetti burst, and useGlassSurface — the hook
 * for surfaces that author their own data-glass markup natively.
 *
 * What deliberately does NOT live here: the auto-tagging classify() walker.
 * That bridge exists for legacy inline-styled pages (estimate + the pro
 * financial pages) and stays in EstimateGlassTheme.jsx. New surfaces must
 * write data-glass / data-glass-accent / data-gt attributes in their JSX and
 * call useGlassSurface — no DOM walking.
 *
 * All visual rules are in glass-theme.css, scoped under
 * html[data-glass-theme] so nothing leaks while a gate is off.
 */
import { useLayoutEffect } from 'react';
import { attachGlassMotion } from './glass-motion';
import './glass-theme.css';

let sharedScene = null;
let stillUsers = 0;

const SCENE_HTML_BACKGROUND = [
  'radial-gradient(1100px 700px at 85% -10%, rgba(10,126,194,.40), transparent 60%)',
  'radial-gradient(900px 650px at -10% 30%, rgba(240,165,0,.16), transparent 55%)',
  'radial-gradient(1000px 900px at 75% 95%, rgba(6,90,140,.32), transparent 60%)',
  'radial-gradient(600px 400px at 40% 55%, rgba(56,170,225,.16), transparent 65%)',
  'radial-gradient(140% 120% at 50% 40%, rgba(255,255,255,0) 55%, rgba(4,57,94,.14) 100%)',
  'linear-gradient(180deg,#E0EEF9 0%,#F5FAFE 45%,#E5EFF7 100%)',
].join(',');

function applySceneDom(html, scene) {
  html.setAttribute('data-glass-theme', '');
  // One scene for every customer page (owner 2026-09-03: invoices, receipts
  // and statements look like the estimate — the quieter wash is gone).
  html.style.background = SCENE_HTML_BACKGROUND;
  document.body.style.setProperty('background', 'transparent', 'important');
  if (scene.root) {
    scene.root.style.position = 'relative';
    scene.root.style.zIndex = '1';
  }
  if (!scene.orbs.isConnected) document.body.prepend(scene.orbs);
  if (!scene.grain.isConnected) document.body.appendChild(scene.grain);
}

/**
 * Mounts the one scene: html attribute, mesh background, the parallax orbs
 * + film grain. Returns the orb container for pointer FX
 * plus a cleanup that restores everything it changed. `motion: false` skips
 * the entrance engine (motion audit 2026-11-02, owner pick 3A: the customer
 * portal renders routine content at once); the static scene is identical.
 */
export function applyGlassScene({ motion = true } = {}) {
  const html = document.documentElement;
  if (!sharedScene) {
    const prevHtmlBg = html.style.background;
    const prevBodyBg = document.body.style.background;
    const root = document.getElementById('root');
    const prevRootPosition = root ? root.style.position : '';
    const prevRootZIndex = root ? root.style.zIndex : '';

    const orbs = document.createElement('div');
    orbs.className = 'glass-scene-orbs';
    orbs.setAttribute('aria-hidden', 'true');
    orbs.innerHTML = [
      ['10%', '6%', '380px', 'rgba(10,126,194,.36)'],
      ['62%', '22%', '460px', 'rgba(56,170,225,.34)'],
      ['22%', '62%', '420px', 'rgba(240,165,0,.18)'],
      ['72%', '74%', '340px', 'rgba(4,57,94,.28)'],
      ['44%', '40%', '220px', 'rgba(120,200,255,.28)'],
    ]
      .map((b) => `<div class="glass-orb" style="position:absolute;left:${b[0]};top:${b[1]};width:${b[2]};height:${b[2]};border-radius:50%;background:${b[3]};filter:blur(70px);will-change:transform;"></div>`)
      .join('')
      + '<div style="position:absolute;inset:-10%;background:radial-gradient(circle, rgba(4,57,94,.28) 0 1px, transparent 1.4px);background-size:24px 24px;opacity:.14;"></div>';

    const grainSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer></filter><rect width="180" height="180" filter="url(%23n)"/></svg>';
    const grain = document.createElement('div');
    grain.className = 'glass-scene-grain';
    grain.setAttribute('aria-hidden', 'true');
    grain.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(grainSvg).replace(/%2523/g, '%23')}")`;

    sharedScene = {
      users: 0,
      orbs,
      grain,
      prevHtmlBg,
      prevBodyBg,
      root,
      prevRootPosition,
      prevRootZIndex,
    };
    applySceneDom(html, sharedScene);
  } else if (!sharedScene.orbs?.isConnected || !sharedScene.grain?.isConnected || !html.hasAttribute('data-glass-theme')) {
    // Repair the active singleton in place so earlier consumers retain the
    // original style snapshot and never tear down a later consumer's mount.
    applySceneDom(html, sharedScene);
  }

  const scene = sharedScene;
  scene.users += 1;
  const detachMotion = motion ? attachGlassMotion() : () => {};
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    detachMotion();
    scene.users = Math.max(0, scene.users - 1);
    if (scene.users > 0 || sharedScene !== scene) return;
    if (scene.orbs) scene.orbs.remove();
    if (scene.grain) scene.grain.remove();
    html.removeAttribute('data-glass-theme');
    html.style.background = scene.prevHtmlBg;
    document.body.style.background = scene.prevBodyBg;
    if (scene.root) {
      scene.root.style.position = scene.prevRootPosition;
      scene.root.style.zIndex = scene.prevRootZIndex;
    }
    sharedScene = null;
  };
  return { orbs: scene.orbs, cleanup };
}

/**
 * Cursor-follow specular + pointer/scroll parallax on the scene orbs.
 * No-ops (and returns a no-op cleanup) when there are no orbs. Reduced motion
 * does NOT mount none — `applyGlassScene` always mounts the five orbs, and
 * what stops under `reduced` is the movement: no pointer listener at all, so
 * neither the orb parallax nor the cursor-follow specular runs, and the CSS
 * drops the transitions alongside. Static orbs are decoration, not motion, and
 * `prefers-reduced-motion` asks for neither removed (owner ruling C7,
 * DECISIONS 2026-09-11). The specular vars live on <html> so
 * per-frame pointer motion never feeds a consumer's MutationObserver
 * watching #root; var() resolution inherits from the root, and only the
 * :hover element renders its ::before, so a single global pair positions
 * the shine correctly.
 */
const pointerFxByOrbs = new WeakMap();

function createPointerFxEntry(html, orbs, initialReduced) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const orbEls = orbs.querySelectorAll('.glass-orb');
  let users = 0;
  let raf = 0;
  let pendingEvt = null;
  let px = 0;
  let py = 0;
  let motionReduced = initialReduced;

  const resetVisuals = () => {
    orbEls.forEach((orb) => orb.style.removeProperty('transform'));
    html.style.removeProperty('--mx');
    html.style.removeProperty('--my');
  };

  const parallax = () => {
    if (motionReduced) return;
    const sy = window.scrollY;
    orbEls.forEach((c, i) => {
      const f = 0.015 + i * 0.012;
      const drift = Math.sin(sy / 900 + i * 1.7) * 24;
      c.style.transform = `translate(${px * -46 * ((i + 1) / orbEls.length) + drift}px, ${sy * f + py * -34 * ((i + 1) / orbEls.length)}px)`;
    });
  };

  const flushFrame = () => {
    raf = 0;
    if (pendingEvt) {
      const evt = pendingEvt;
      pendingEvt = null;
      const t = evt.target instanceof Element ? evt.target.closest('[data-glass],[data-glass-accent]') : null;
      if (t) {
        const r = t.getBoundingClientRect();
        html.style.setProperty('--mx', `${((evt.clientX - r.left) / r.width) * 100}%`);
        html.style.setProperty('--my', `${((evt.clientY - r.top) / r.height) * 100}%`);
      }
      px = evt.clientX / window.innerWidth - 0.5;
      py = evt.clientY / window.innerHeight - 0.5;
    }
    parallax();
  };

  const scheduleFrame = () => {
    if (!raf) raf = requestAnimationFrame(flushFrame);
  };
  const onMove = (e) => {
    pendingEvt = e;
    scheduleFrame();
  };
  const onScroll = () => scheduleFrame();

  // Under reduced motion the pointer listener is never registered. Gating only
  // `parallax()` left `--mx`/`--my` tracking the cursor, so the specular
  // highlight went on sliding across every card — motion the user asked not to
  // see, from the one path that was not checking the flag.
  const syncPreference = () => {
    document.removeEventListener('pointermove', onMove);
    window.removeEventListener('scroll', onScroll);
    if (!motionReduced && users > 0) {
      document.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
      return;
    }
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pendingEvt = null;
    resetVisuals();
  };

  const onPreference = () => {
    motionReduced = preference.matches;
    syncPreference();
  };
  preference.addEventListener('change', onPreference);

  return {
    addOwner(reduced) {
      users += 1;
      if (!reduced) motionReduced = preference.matches;
      syncPreference();
    },
    removeOwner() {
      users = Math.max(0, users - 1);
      return users;
    },
    destroy() {
      document.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', onScroll);
      preference.removeEventListener('change', onPreference);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pendingEvt = null;
      resetVisuals();
    },
  };
}

export function attachGlassPointerFx(html, orbs, reduced) {
  if (!orbs) return () => {};
  let entry = pointerFxByOrbs.get(orbs);
  if (!entry) {
    entry = createPointerFxEntry(html, orbs, reduced);
    pointerFxByOrbs.set(orbs, entry);
  }
  entry.addOwner(reduced);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    if (entry.removeOwner() > 0) return;
    if (pointerFxByOrbs.get(orbs) === entry) pointerFxByOrbs.delete(orbs);
    entry.destroy();
  };
}

/**
 * Celebration burst for booking confirmation — exported for accept flows.
 * No-ops unless a glass theme is mounted or the user prefers reduced motion.
 */
export function fireGlassConfetti(cx, cy) {
  // Purely decorative: feature-detect and fail silent — callers sit inside
  // booking-success paths and must never see a visual error.
  if (!document.documentElement.hasAttribute('data-glass-theme')) return;
  if (typeof Element.prototype.animate !== 'function') return;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#F0A500', '#FFD666', '#0A7EC2', '#04395E', '#7CC7F0'];
  for (let i = 0; i < 30; i += 1) {
    const b = document.createElement('div');
    b.setAttribute('aria-hidden', 'true');
    b.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:9px;height:9px;border-radius:${i % 3 === 0 ? '50%' : '2px'};background:${colors[i % colors.length]};pointer-events:none;z-index:2000`;
    document.body.appendChild(b);
    const ang = Math.random() * Math.PI * 2;
    const v = 70 + Math.random() * 170;
    b.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${Math.cos(ang) * v}px,${Math.sin(ang) * v - 100}px) rotate(${Math.random() * 540 - 270}deg)`, opacity: 0 },
    ], { duration: 950 + Math.random() * 450, easing: 'cubic-bezier(.16,.8,.4,1)' }).onfinish = () => b.remove();
  }
}

/**
 * Theme hook for surfaces that author their own data-glass markup (portal,
 * reports, future glass adoptions). Mounts the scene + pointer FX and tears
 * both down on unmount. Entrances observe authored material tags; there is
 * no auto-tagging or computed-style classification. Legacy inline-styled
 * pages that need DOM tagging use useGlassTheme from EstimateGlassTheme.
 *
 * Layout effect, not effect: the theme attribute must be on <html> before
 * the browser paints the first frame, or every glass surface flashes its
 * un-themed (legacy-token) styling for a frame before the scene mounts.
 */
export function useGlassSurface(active, { motion = true } = {}) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const html = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { orbs, cleanup } = applyGlassScene({ motion });
    // `motion: false` (customer portal, motion audit 2026-11-02, owner pick
    // 3A): no entrance engine, no orb parallax or cursor specular, and
    // data-glass-still on <html> so the CSS drops the hover lift. The static
    // scene stays exactly as it is for every other surface.
    const detachFx = motion ? attachGlassPointerFx(html, orbs, reduced) : () => {};
    if (!motion) {
      stillUsers += 1;
      html.setAttribute('data-glass-still', '');
    }
    return () => {
      detachFx();
      if (!motion) {
        stillUsers = Math.max(0, stillUsers - 1);
        if (stillUsers === 0) html.removeAttribute('data-glass-still');
      }
      cleanup();
    };
  }, [active, motion]);
}
