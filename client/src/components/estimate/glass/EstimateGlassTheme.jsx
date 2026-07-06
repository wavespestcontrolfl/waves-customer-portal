/**
 * EstimateGlassTheme — dark-launched liquid-glass theme for the customer
 * estimate page (PR A of docs/design/estimate-glass-plan.md; visual only,
 * strict 1:1 on data/behavior/copy).
 *
 * The estimate page is inline-styled throughout, so a class-based restyle
 * would mean rewriting ~3.4k lines in one PR. Instead this component ships
 * the approach validated during the owner design session
 * (docs/design/estimate-glass-blueprint.js): mount a scene layer, then tag
 * page elements with data attributes that the scoped stylesheet
 * (glass-theme.css, everything under html[data-glass-theme]) restyles. A
 * MutationObserver re-tags after React re-renders. PR C replaces the tagging
 * pass with real components; this keeps PR A reviewable and zero-risk — with
 * the gate off, nothing here mounts and no CSS applies.
 *
 * The surface-agnostic core (scene builder, pointer FX, confetti, stylesheet)
 * lives in src/glass/glass-engine.js so other surfaces can adopt glass
 * without this file's DOM-tagging bridge. What remains here is exactly the
 * legacy-page adapter: classify() and the observers that re-run it. Surfaces
 * that author their own data-glass markup use useGlassSurface from the
 * engine instead.
 *
 * Everything is torn down on unmount: html attribute, scene nodes,
 * observers, listeners. Stray data attributes are inert without the html
 * attribute, so they are left in place rather than walked again.
 */
import { useEffect } from 'react';
import {
  applyGlassScene,
  attachGlassPointerFx,
  fireGlassConfetti,
} from '../../../glass/glass-engine';

export { fireGlassConfetti };

const TINT = {
  'rgb(242, 238, 224)': 'rgba(244,239,224,.36)',
  'rgb(232, 244, 252)': 'rgba(222,240,252,.40)',
  'rgb(240, 247, 252)': 'rgba(235,246,252,.40)',
  'rgb(254, 247, 224)': 'rgba(254,247,224,.44)',
  'rgb(227, 245, 253)': 'rgba(222,242,253,.40)',
};
const PAGE_BG = ['rgb(250, 248, 243)', 'rgb(250, 250, 250)', 'rgb(248, 250, 251)', 'rgb(250, 251, 252)', 'rgb(247, 249, 251)'];
// Section titles that render as styled divs rather than real h2/h3 — the
// theme normalizes them onto the heading scale (visual only; text untouched).
const DIV_H2 = new Set(['Find a date & time that works for you', "Skip parts you don't need", 'Skip parts you don’t need']);
const DIV_H3 = new Set(['It’s all in the Waves app', "It's all in the Waves app", 'Add Lawn Care and save more']);

const ownText = (el) => {
  let s = '';
  for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
  return s.trim();
};

function classify(revealIO, statIO, pro) {
  for (const el of document.querySelectorAll('#root *')) {
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    if (PAGE_BG.includes(bg)) el.style.setProperty('background', 'transparent', 'important');

    // Selection can change WITHOUT a remount (FrequencySlider / SlotPicker
    // keyed buttons just get new inline background/color). Re-read the
    // React-owned inline style each pass and flip the tag so a newly
    // selected control goes gold and a deselected one returns to chip.
    if ((el.tagName === 'BUTTON' || el.tagName === 'A') && (el.hasAttribute('data-glass') || el.hasAttribute('data-glass-accent'))) {
      const inline = el.style.backgroundColor;
      if (inline) {
        const im = inline.match(/\d+(?:\.\d+)?/g);
        const alpha = im && im.length >= 4 ? parseFloat(im[3]) : 1;
        const dark = im && alpha > 0.5 && (0.2126 * im[0] + 0.7152 * im[1] + 0.0722 * im[2]) / 255 < 0.35;
        if (dark && el.hasAttribute('data-glass')) {
          el.removeAttribute('data-glass');
          el.setAttribute('data-glass-accent', '');
        } else if (!dark && el.hasAttribute('data-glass-accent') && (inline.startsWith('rgb(255') || TINT[inline] || inline === 'transparent' || alpha === 0)) {
          el.removeAttribute('data-glass-accent');
          el.setAttribute('data-glass', 'chip');
        }
      }
    }

    // gold accent: solid dark CTAs (buttons only; height gate skips small pills)
    const m = bg.match(/\d+/g);
    if (el.tagName === 'BUTTON' && m && bg.indexOf('rgba') !== 0 && !el.hasAttribute('data-glass-accent')) {
      const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
      if (lum < 0.35 && el.getBoundingClientRect().height >= 42) {
        el.setAttribute('data-glass-accent', '');
        if (cs.position === 'static') el.style.position = 'relative';
      }
    }

    // glass tiers for white / brand-tinted rounded surfaces
    if (!el.hasAttribute('data-glass') && !el.hasAttribute('data-glass-accent') && rad >= 8) {
      const tint = TINT[bg];
      if (bg === 'rgb(255, 255, 255)' || tint) {
        if (cs.position === 'static') el.style.position = 'relative';
        const interactive = el.tagName === 'BUTTON' || el.tagName === 'A';
        const nested = !!(el.parentElement && el.parentElement.closest('[data-glass]'));
        // Dialog cards (deposit / card-hold modals) sit directly inside a
        // fixed full-viewport overlay — they get the heavier modal tier and
        // their backdrop becomes a glass scrim.
        const parent = el.parentElement;
        const isModal = !interactive && parent && getComputedStyle(parent).position === 'fixed'
          && parent.getBoundingClientRect().width >= window.innerWidth * 0.9;
        if (isModal) parent.setAttribute('data-glass-scrim', '');
        el.setAttribute('data-glass', isModal ? 'modal' : interactive ? 'chip' : nested ? 'soft' : 'card');
        if (interactive && el.getBoundingClientRect().height <= 56) el.style.setProperty('border-radius', '999px', 'important');
        if (tint) el.style.setProperty('--glass-bg', tint);
      }
    }

    // iOS-style preference switches read oversized against glass — scale down
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      const track = el.parentElement;
      if (track && track.tagName === 'SPAN' && !track.style.transform) {
        track.style.setProperty('transform', 'scale(.7)');
        track.style.setProperty('transform-origin', 'right center');
      }
    }

    const own = ownText(el);
    if (!own) continue;

    // deepen washed-out slate greys toward brand navy (same lightness ladder)
    if (!el.style.color && !el.closest('[data-glass-accent]')) {
      const c = cs.color.match(/\d+/g);
      if (c) {
        const [r, g, b] = c.map(Number);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const L = (max + min) / 510;
        if (max - min < 46 && L > 0.3 && L < 0.76) el.style.setProperty('color', `hsl(216, 42%, ${Math.round(L * 78)}%)`, 'important');
      }
    }

    if (!el.hasAttribute('data-gt') && !el.closest('button, a') && !/^H[1-6]$/.test(el.tagName)) {
      const fs = parseFloat(cs.fontSize);
      if (DIV_H2.has(own)) el.setAttribute('data-gt', 'h2x');
      else if (DIV_H3.has(own)) el.setAttribute('data-gt', 'h3x');
      else if (/^\$[\d,.]+$/.test(own) && fs >= 18) {
        el.setAttribute('data-gt', 'metric');
        if (el.parentElement) el.parentElement.setAttribute('data-g-pricerow', '');
      } else if ((own === own.toUpperCase() || cs.textTransform === 'uppercase') && own.length >= 3 && own.length <= 60 && fs <= 16 && !/[@\d]/.test(own) && /[A-Za-z]/.test(own)) {
        el.setAttribute('data-gt', 'eyebrow');
      } else if (fs <= 12) el.setAttribute('data-gt', 'fine');
      else if (fs >= 13 && fs <= 19) {
        el.setAttribute('data-gt', 'body');
        if (parseInt(cs.fontWeight, 10) >= 700) el.style.setProperty('font-weight', '600', 'important');
      }
    }
  }

  // hero contact block: bolder tier
  let contact = null;
  for (const el of document.querySelectorAll('#root *')) {
    const t = el.textContent;
    if (t.includes('@') && t.includes('USA') && t.length < 170 && (!contact || el.contains(contact))) contact = el;
  }
  if (contact && !contact.hasAttribute('data-g-contact')) contact.setAttribute('data-g-contact', '');

  // footer: brand-blue text + icons
  const social = Array.from(document.querySelectorAll('a')).find((a) => (a.href || '').includes('facebook.com'));
  if (social) {
    let f = social.parentElement;
    while (f && !f.textContent.includes('All rights reserved')) f = f.parentElement;
    if (f && !f.hasAttribute('data-g-footer')) f.setAttribute('data-g-footer', '');
  }

  // compact stat tiles under the satellite image
  const satCard = Array.from(document.querySelectorAll('[data-glass="card"]')).find((c) => c.textContent.includes('Complexity') && c.textContent.includes('sq ft'));
  if (satCard) {
    satCard.querySelectorAll('[data-glass="soft"]').forEach((tile) => {
      const t = tile.textContent.trim();
      if (/^(HOME|LOT|POOL\/LANAI|COMPLEXITY)/i.test(t) && t.length < 40 && !tile.hasAttribute('data-g-stattile')) tile.setAttribute('data-g-stattile', '');
    });
  }

  // floating pill nav (estimate page only — financial pages keep their headers)
  const header = pro ? null : document.querySelector('header, [role="banner"]');
  if (header && !header.hasAttribute('data-g-nav')) {
    header.setAttribute('data-g-nav', '');
    Object.assign(header.style, { position: 'sticky', top: '10px', zIndex: '60', margin: '10px auto 0', maxWidth: '780px', borderRadius: '999px', padding: '8px 26px' });
    header.style.setProperty('background', 'linear-gradient(135deg,rgba(255,255,255,.42),rgba(255,255,255,.15)), rgba(255,255,255,.32)', 'important');
    header.style.setProperty('-webkit-backdrop-filter', 'blur(26px) saturate(185%)', 'important');
    header.style.setProperty('backdrop-filter', 'blur(26px) saturate(185%)', 'important');
    header.style.setProperty('border', '1px solid rgba(255,255,255,.65)', 'important');
    header.style.setProperty('box-shadow', '0 14px 40px rgba(4,57,94,.16), inset 0 1px 0 rgba(255,255,255,.6), inset 1px 1px 0 rgba(175,225,255,.3)', 'important');
  }

  // scroll-reveal (below-fold cards) + sq-ft count-up registration
  if (revealIO) {
    document.querySelectorAll('[data-glass="card"]').forEach((c) => {
      if (c.hasAttribute('data-g-revealed')) return;
      c.setAttribute('data-g-revealed', '');
      if (c.getBoundingClientRect().top > window.innerHeight * 0.92) {
        c.classList.add('glass-reveal-pending');
        revealIO.observe(c);
      }
    });
  }
  if (statIO) {
    for (const el of document.querySelectorAll('#root *')) {
      if (el.hasAttribute('data-g-stat')) continue;
      if (/^[\d,]+ sq ft$/.test(ownText(el))) {
        el.setAttribute('data-g-stat', '');
        statIO.observe(el);
      }
    }
  }
}

/**
 * Hook form of the theme — pages with multiple return branches (loading /
 * error / loaded) call this once at the top of the component instead of
 * mounting the component in every branch.
 */
export function useGlassTheme(active, variant = 'full') {
  useEffect(() => {
    if (!active) return undefined;
    const html = document.documentElement;
    const { orbs, cleanup: sceneCleanup } = applyGlassScene(variant);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pro = variant === 'pro';

    const revealIO = pro ? null : new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add('glass-reveal-in');
        en.target.classList.remove('glass-reveal-pending');
        revealIO.unobserve(en.target);
      });
    }, { threshold: 0.06 });

    const statIO = pro ? null : new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        statIO.unobserve(en.target);
        if (reduced) return;
        const node = Array.from(en.target.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim());
        const m = node && node.textContent.trim().match(/^([\d,]+) sq ft$/);
        if (!m) return;
        const target = parseInt(m[1].replace(/,/g, ''), 10);
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / 900);
          node.textContent = `${Math.round(target * (0.15 + 0.85 * p * p)).toLocaleString()} sq ft`;
          if (p < 1) requestAnimationFrame(step);
          else node.textContent = `${target.toLocaleString()} sq ft`;
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.5 });

    const run = () => classify(revealIO, statIO, pro);
    run();

    // Re-tag after React re-renders. childList covers mount/unmount;
    // attributeFilter ['style'] covers in-place selection changes (Codex rd2).
    // classify() itself writes styles/attributes, so after each run the
    // records it produced are flushed with takeRecords() to avoid a loop.
    let retagTimer = 0;
    const mo = new MutationObserver(() => {
      if (retagTimer) return;
      retagTimer = window.setTimeout(() => {
        retagTimer = 0;
        run();
        mo.takeRecords();
      }, 150);
    });
    const rootEl = document.getElementById('root');
    if (rootEl) mo.observe(rootEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

    // cursor-follow specular + pointer/scroll parallax on the orbs
    // (no orbs on the pro variant, so the engine attaches nothing there)
    const detachFx = attachGlassPointerFx(html, orbs, reduced);

    return () => {
      detachFx();
      if (retagTimer) clearTimeout(retagTimer);
      mo.disconnect();
      if (revealIO) revealIO.disconnect();
      if (statIO) statIO.disconnect();
      sceneCleanup();
    };
  }, [active, variant]);
}

export default function EstimateGlassTheme({ active, variant = 'full' }) {
  useGlassTheme(active, variant);
  return null;
}
