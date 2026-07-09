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
import './glass-theme.css';

/**
 * Mounts the scene: html attribute, mesh background, and (full variant only)
 * the parallax orbs + film grain. Returns the orb container for pointer FX
 * plus a cleanup that restores everything it changed.
 */
export function applyGlassScene(variant) {
  const html = document.documentElement;
  const prevHtmlBg = html.style.background;
  const prevBodyBg = document.body.style.background;
  html.setAttribute('data-glass-theme', variant);
  // The 'pro' scene (invoices/receipts/statements) stays quiet: one soft
  // brand-tinted wash, no orbs, no grain — financial documents should feel
  // composed, not playful.
  html.style.background = variant === 'pro'
    ? [
      'radial-gradient(900px 600px at 80% -10%, rgba(10,126,194,.14), transparent 60%)',
      'radial-gradient(700px 500px at 0% 100%, rgba(4,57,94,.08), transparent 60%)',
      'linear-gradient(180deg,#EDF3F9 0%,#F8FAFC 50%,#EEF3F8 100%)',
    ].join(',')
    : [
      'radial-gradient(1100px 700px at 85% -10%, rgba(10,126,194,.40), transparent 60%)',
      'radial-gradient(900px 650px at -10% 30%, rgba(240,165,0,.16), transparent 55%)',
      'radial-gradient(1000px 900px at 75% 95%, rgba(6,90,140,.32), transparent 60%)',
      'radial-gradient(600px 400px at 40% 55%, rgba(56,170,225,.16), transparent 65%)',
      'radial-gradient(140% 120% at 50% 40%, rgba(255,255,255,0) 55%, rgba(4,57,94,.14) 100%)',
      'linear-gradient(180deg,#E0EEF9 0%,#F5FAFE 45%,#E5EFF7 100%)',
    ].join(',');
  document.body.style.setProperty('background', 'transparent', 'important');
  const root = document.getElementById('root');
  if (root) {
    root.style.position = 'relative';
    root.style.zIndex = '1';
  }

  let orbs = null;
  let grain = null;
  if (variant !== 'pro') {
    orbs = document.createElement('div');
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
    document.body.prepend(orbs);

    const grainSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.055"/></feComponentTransfer></filter><rect width="180" height="180" filter="url(%23n)"/></svg>';
    grain = document.createElement('div');
    grain.className = 'glass-scene-grain';
    grain.setAttribute('aria-hidden', 'true');
    grain.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(grainSvg).replace(/%2523/g, '%23')}")`;
    document.body.appendChild(grain);
  }

  const cleanup = () => {
    if (orbs) orbs.remove();
    if (grain) grain.remove();
    html.removeAttribute('data-glass-theme');
    html.style.background = prevHtmlBg;
    document.body.style.background = prevBodyBg;
  };
  return { orbs, cleanup };
}

/**
 * Cursor-follow specular + pointer/scroll parallax on the scene orbs.
 * No-ops (and returns a no-op cleanup) when there are no orbs — the pro
 * variant has no motion by design. The specular vars live on <html> so
 * per-frame pointer motion never feeds a consumer's MutationObserver
 * watching #root; var() resolution inherits from the root, and only the
 * :hover element renders its ::before, so a single global pair positions
 * the shine correctly.
 */
export function attachGlassPointerFx(html, orbs, reduced) {
  if (!orbs) return () => {};
  let raf = 0;
  let lastEvt = null;
  let px = 0;
  let py = 0;
  const orbEls = orbs.querySelectorAll('.glass-orb');
  const parallax = () => {
    if (reduced) return;
    const sy = window.scrollY;
    orbEls.forEach((c, i) => {
      const f = 0.015 + i * 0.012;
      const drift = Math.sin(sy / 900 + i * 1.7) * 24;
      c.style.transform = `translate(${px * -46 * ((i + 1) / orbEls.length) + drift}px, ${sy * f + py * -34 * ((i + 1) / orbEls.length)}px)`;
    });
  };
  const onMove = (e) => {
    lastEvt = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const t = lastEvt.target instanceof Element ? lastEvt.target.closest('[data-glass],[data-glass-accent]') : null;
      if (t) {
        const r = t.getBoundingClientRect();
        html.style.setProperty('--mx', `${((lastEvt.clientX - r.left) / r.width) * 100}%`);
        html.style.setProperty('--my', `${((lastEvt.clientY - r.top) / r.height) * 100}%`);
      }
      px = lastEvt.clientX / window.innerWidth - 0.5;
      py = lastEvt.clientY / window.innerHeight - 0.5;
      parallax();
    });
  };
  const onScroll = () => requestAnimationFrame(parallax);
  document.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    document.removeEventListener('pointermove', onMove);
    window.removeEventListener('scroll', onScroll);
    if (raf) cancelAnimationFrame(raf);
    html.style.removeProperty('--mx');
    html.style.removeProperty('--my');
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
 * both down on unmount — no auto-tagging, no observers. Legacy inline-styled
 * pages that need DOM tagging use useGlassTheme from EstimateGlassTheme.
 *
 * Layout effect, not effect: the theme attribute must be on <html> before
 * the browser paints the first frame, or every glass surface flashes its
 * un-themed (legacy-token) styling for a frame before the scene mounts.
 */
export function useGlassSurface(active, variant = 'full') {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const html = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { orbs, cleanup } = applyGlassScene(variant);
    const detachFx = attachGlassPointerFx(html, orbs, reduced);
    return () => {
      detachFx();
      cleanup();
    };
  }, [active, variant]);
}
