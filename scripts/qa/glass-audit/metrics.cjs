'use strict';
// In-page metrics for the Liquid Glass consistency audit. Runs inside the
// browser via page.evaluate — pure DOM/getComputedStyle, no network. Returns a
// JSON-serialisable snapshot of what actually painted.
/* global document, window, Element, HTMLElement */

function collectMetrics(opts) {
  const { sheetH1Min = 32, sheetH1Max = 40, sheetH2 = 26, sheetH3 = 20 } = opts || {};
  const html = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Same-origin iframes (the newsletter archive renders the article in a srcdoc iframe with
  // allow-same-origin) are traversed as part of the page: text, headings, glass, controls, overlays
  // and overflow all include their content, with boxes translated into the top page's coordinates
  // through the frame's rect. Cross-origin frames are opaque and skipped. Landmarks (main / header /
  // footer / sticky bars) stay top-document: an iframe is not a page shell.
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => { try { const d = f.contentDocument; if (!d || !d.body) return null; const r = f.getBoundingClientRect(); return { doc: d, dx: r.left + f.clientLeft, dy: r.top + f.clientTop, w: f.clientWidth }; } catch (e) { return null; } }).filter(Boolean);
  const docs = [{ doc: document, dx: 0, dy: 0 }, ...frames];
  const offsetOf = (el) => (el.ownerDocument === document ? { dx: 0, dy: 0 } : (frames.find((f) => f.doc === el.ownerDocument) || { dx: 0, dy: 0 }));
  const rect = (el) => { const r = el.getBoundingClientRect(); const o = offsetOf(el); return { left: r.left + o.dx, top: r.top + o.dy, right: r.right + o.dx, bottom: r.bottom + o.dy, width: r.width, height: r.height }; };
  const qsa = (s) => docs.flatMap((d) => Array.from(d.doc.querySelectorAll(s)));
  const cstyle = (el, pseudo) => el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  const visible = (el) => {
    const r = rect(el);
    if (r.width === 0 && r.height === 0) return false;
    // Off-canvas helpers (skip links parked at top:-100px) are not rendered UI.
    if (r.bottom + window.scrollY < 0) return false;
    const cs = cstyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    return true;
  };
  const snippet = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const sel = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const dg = el.getAttribute('data-glass') != null ? `[data-glass="${el.getAttribute('data-glass')}"]` : '';
    const acc = el.hasAttribute('data-glass-accent') ? '[data-glass-accent]' : '';
    const gt = el.getAttribute('data-gt') ? `[data-gt="${el.getAttribute('data-gt')}"]` : '';
    return `${frameTag(el)}${el.tagName.toLowerCase()}${id}${cls}${dg}${acc}${gt}`;
  };
  const round = (n) => Math.round(n * 100) / 100;
  const box = (el) => { const r = rect(el); return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) }; };
  const frameTag = (el) => (el.ownerDocument === document ? '' : 'iframe>');

  // ---- theme / scene ----
  const theme = {
    attr: html.getAttribute('data-glass-theme'),
    mounted: html.hasAttribute('data-glass-theme'),
    orbs: document.querySelectorAll('.glass-scene-orbs .glass-orb').length,
    orbLayers: document.querySelectorAll('.glass-scene-orbs').length,
    grain: document.querySelectorAll('.glass-scene-grain').length,
    htmlBackground: html.style.background ? html.style.background.slice(0, 80) + '…' : cstyle(html).backgroundImage.slice(0, 80),
    bodyBackground: cstyle(document.body).backgroundColor,
    adminApp: html.classList.contains('admin-app'),
    adminShell: !!document.querySelector('.admin-shell-v2'),
  };

  // ---- fonts ----
  const fontFaces = [];
  try { document.fonts.forEach((f) => { if (f.status === 'loaded') fontFaces.push(`${f.family} ${f.weight}`); }); } catch (e) { /* ignore */ }
  const famOf = (el) => (el ? cstyle(el).fontFamily : null);
  const fonts = {
    loaded: Array.from(new Set(fontFaces)).sort(),
    body: famOf(document.body),
    h1: famOf(document.querySelector('h1')),
    h2: famOf(document.querySelector('h2')),
    button: famOf(document.querySelector('button')),
    input: famOf(document.querySelector('input, select, textarea')),
  };

  // ---- text census ----
  const textEls = [];
  const seen = new Set();
  for (const d of docs) {
    const walker = d.doc.createTreeWalker(d.doc.body, 4 /* SHOW_TEXT */);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (!t) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      if (el.closest('script, style, noscript, svg, [aria-hidden="true"]')) continue;
      if (!visible(el)) continue;
      seen.add(el);
      const cs = cstyle(el);
      textEls.push({ el, cs, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), color: cs.color, family: cs.fontFamily.split(',')[0].replace(/["']/g, ''), text: t.slice(0, 50) });
    }
  }
  const sizeHist = {};
  const weightHist = {};
  const familyHist = {};
  const colorHist = {};
  for (const t of textEls) {
    sizeHist[t.size] = (sizeHist[t.size] || 0) + 1;
    weightHist[t.weight] = (weightHist[t.weight] || 0) + 1;
    familyHist[t.family] = (familyHist[t.family] || 0) + 1;
    colorHist[t.color] = (colorHist[t.color] || 0) + 1;
  }
  const under14 = textEls.filter((t) => t.size < 14).map((t) => ({ sel: sel(t.el), size: t.size, weight: t.weight, text: t.text, box: box(t.el) }));
  const over700 = textEls.filter((t) => t.weight > 700).map((t) => ({ sel: sel(t.el), size: t.size, weight: t.weight, text: t.text }));
  const offScale = textEls.filter((t) => ![14, 15, 16, 18, 20, 26, 32, 40].includes(t.size) && t.size >= 14 && !(t.size > 32 && t.size < 40)).map((t) => ({ sel: sel(t.el), size: t.size, text: t.text }));

  // ---- headings ----
  const headings = qsa('h1, h2, h3, h4').filter(visible).map((h) => {
    const cs = cstyle(h);
    return { tag: h.tagName.toLowerCase(), size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), color: cs.color, family: cs.fontFamily.split(',')[0].replace(/["']/g, ''), text: snippet(h), ls: cs.letterSpacing, lh: cs.lineHeight };
  });
  const h1s = headings.filter((h) => h.tag === 'h1');
  const headingIssues = [];
  for (const h of headings) {
    if (h.tag === 'h1' && (h.size < sheetH1Min - 0.5 || h.size > sheetH1Max + 0.5)) headingIssues.push({ ...h, why: `h1 ${h.size}px outside ${sheetH1Min}–${sheetH1Max}` });
    if (h.tag === 'h2' && Math.abs(h.size - sheetH2) > 0.5) headingIssues.push({ ...h, why: `h2 ${h.size}px ≠ ${sheetH2}` });
    if ((h.tag === 'h3' || h.tag === 'h4') && Math.abs(h.size - sheetH3) > 0.5) headingIssues.push({ ...h, why: `${h.tag} ${h.size}px ≠ ${sheetH3}` });
  }
  const eyebrows = qsa('[data-gt="eyebrow"]').filter(visible).map((e) => { const cs = cstyle(e); return { size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), ls: cs.letterSpacing, color: cs.color, tt: cs.textTransform, text: snippet(e) }; });

  // ---- glass surfaces ----
  const glassEls = qsa('[data-glass], [data-glass-accent]').filter(visible);
  const glass = glassEls.map((g) => {
    const cs = cstyle(g);
    const tier = g.hasAttribute('data-glass-accent') ? 'accent' : (g.getAttribute('data-glass') || 'card(bare)');
    const parentGlass = g.parentElement && g.parentElement.closest('[data-glass]');
    const bf = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
    return {
      tier, sel: sel(g), tag: g.tagName.toLowerCase(), radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 60), border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`, backdrop: bf, shadow: cs.boxShadow.slice(0, 90), nested: !!parentGlass, nestedBlur: !!parentGlass && bf !== 'none', position: cs.position, box: box(g), padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`, minHeight: cs.minHeight, height: round(rect(g).height),
    };
  });
  const tierHist = {};
  const radiusByTier = {};
  for (const g of glass) {
    tierHist[g.tier] = (tierHist[g.tier] || 0) + 1;
    radiusByTier[g.tier] = radiusByTier[g.tier] || {};
    radiusByTier[g.tier][g.radius] = (radiusByTier[g.tier][g.radius] || 0) + 1;
  }
  // Untagged frosted surfaces (inline backdrop-filter) and non-glass cards.
  const inlineBlur = [];
  const all = docs.flatMap((d) => Array.from(d.doc.body.querySelectorAll('*')));
  for (const el of all) {
    if (el.closest('.glass-scene-orbs, .glass-scene-grain, svg')) continue;
    if (el.hasAttribute('data-glass') || el.hasAttribute('data-glass-accent') || el.hasAttribute('data-glass-scrim')) continue;
    const cs = cstyle(el);
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bf && bf !== 'none' && visible(el)) inlineBlur.push({ sel: sel(el), backdrop: bf, bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, box: box(el) });
  }

  // ---- controls ----
  const controlSel = 'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"]';
  // Footer controls stay in the census (G-11/G-13 measure the universal footer); rows carry `inFooter`
  // so a consumer can allowlist them explicitly instead of the census hiding them.
  const controls = qsa(controlSel).filter(visible);
  const controlRows = controls.map((c) => {
    const cs = cstyle(c);
    const r = c.getBoundingClientRect();
    const kind = c.hasAttribute('data-glass-accent') ? 'accent' : c.getAttribute('data-glass') === 'chip' ? 'chip' : c.tagName.toLowerCase() === 'a' ? 'link' : c.tagName.toLowerCase();
    const inline = kind === 'link' && cs.display === 'inline';
    const name = c.getAttribute('aria-label') || snippet(c) || c.getAttribute('title') || c.getAttribute('placeholder') || '';
    const inFooter = !!c.closest('footer, [role="contentinfo"]');
    return { sel: sel(c), kind, inline, inFooter, h: round(r.height), w: round(r.width), size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), radius: cs.borderTopLeftRadius, color: cs.color, bg: cs.backgroundColor, name: name.slice(0, 40), outline: cs.outlineStyle, tt: cs.textTransform, box: box(c) };
  });
  // 44×44 is the target: a 20×44 icon control is as undersized as a 44×20 one.
  const smallControls = controlRows.filter((c) => !c.inline && c.h > 0 && c.w > 0 && (c.h < 44 || c.w < 44));
  const inputs = qsa('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea').filter(visible).map((i) => {
    const cs = cstyle(i);
    let ph = null;
    try { const p = cstyle(i, '::placeholder'); ph = { size: p.fontSize, color: p.color, style: p.fontStyle }; } catch (e) { /* ignore */ }
    return { sel: sel(i), h: round(i.getBoundingClientRect().height), size: parseFloat(cs.fontSize), radius: cs.borderTopLeftRadius, border: `${cs.borderTopWidth} ${cs.borderTopColor}`, bg: cs.backgroundColor, placeholder: ph, labelled: !!(i.labels && i.labels.length) || !!i.getAttribute('aria-label') || !!i.getAttribute('aria-labelledby') };
  });
  const iconOnlyUnnamed = controls.filter((c) => !snippet(c) && !c.getAttribute('aria-label') && !c.getAttribute('aria-labelledby') && !c.getAttribute('title') && (c.tagName === 'BUTTON' || c.getAttribute('role') === 'button')).map((c) => ({ sel: sel(c), box: box(c) }));

  // ---- layout ----
  const main = document.querySelector('main');
  const cards = glass.filter((g) => g.tier === 'card' || g.tier === 'card(bare)');
  const widestCard = cards.reduce((m, g) => (g.box.w > m ? g.box.w : m), 0);
  const cardLefts = Array.from(new Set(cards.map((g) => g.box.x))).sort((a, b) => a - b);
  const header = document.querySelector('[data-waves-shell-header], header');
  const footer = document.querySelector('footer[role="contentinfo"], footer');
  const stickyTop = Array.from(document.querySelectorAll('*')).filter((el) => { const cs = cstyle(el); return (cs.position === 'sticky' || cs.position === 'fixed') && parseFloat(cs.top) === 0 && visible(el) && el.getBoundingClientRect().width > vw * 0.5; }).map((el) => ({ sel: sel(el), h: round(el.getBoundingClientRect().height), pt: cstyle(el).paddingTop, position: cstyle(el).position }));
  const fixedBottom = Array.from(document.querySelectorAll('*')).filter((el) => { const cs = cstyle(el); return cs.position === 'fixed' && parseFloat(cs.bottom) === 0 && visible(el) && el.getBoundingClientRect().width > vw * 0.5; }).map((el) => ({ sel: sel(el), h: round(el.getBoundingClientRect().height), pb: cstyle(el).paddingBottom }));
  // Elements that extend past the right edge of the viewport (clipped by overflow-x: clip on html).
  // Children of a same-origin iframe are measured against THEIR frame's right edge: at desktop widths
  // the article frame is far narrower than the page, so page-level `vw` would hide internal overflow.
  const overflowers = [];
  const rightLimit = (el) => { const f = el.ownerDocument === document ? null : frames.find((x) => x.doc === el.ownerDocument); return f ? f.dx + f.w : vw; };
  for (const el of all) {
    if (el.closest('.glass-scene-orbs, .glass-scene-grain, svg, .gc-proof, .gc-marquee, .waves-chip-strip--drift')) continue;
    const r = rect(el);
    if (r.width > 0 && r.right > rightLimit(el) + 1 && visible(el)) overflowers.push({ sel: sel(el), right: round(r.right), w: round(r.width), y: round(r.top + window.scrollY), limit: round(rightLimit(el)) });
    if (overflowers.length >= 15) break;
  }
  // Each frame document's own horizontal overflow (html.scrollWidth of the top page cannot see it).
  const frameOverflow = frames.map((f) => ({ w: round(f.w), scrollWidth: f.doc.documentElement.scrollWidth, overflowX: f.doc.documentElement.scrollWidth - f.w }));
  const layout = {
    vw, vh, overflowers,
    scrollWidth: html.scrollWidth, overflowX: html.scrollWidth - vw, frameOverflow,
    docHeight: html.scrollHeight,
    mainWidth: main ? round(main.getBoundingClientRect().width) : null,
    mainCount: document.querySelectorAll('main').length,
    h1Count: h1s.length,
    // Footer geometry in DOCUMENT space (rect.top is viewport-relative; add the scroll offset before
    // comparing with vh / scrollHeight). belowFold = not inside the initial viewport; beyondDocument =
    // pushed past the document end (the placement regression the error-state assertions look for).
    footer: footer ? (() => { const fr = footer.getBoundingClientRect(); const docTop = fr.top + window.scrollY; return { present: true, role: footer.getAttribute('role'), h: round(fr.height), top: round(docTop), belowFold: docTop >= vh, beyondDocument: docTop > html.scrollHeight - 1 }; })() : { present: false },
    contentinfoCount: document.querySelectorAll('[role="contentinfo"], footer').length,
    header: header ? { sel: sel(header), h: round(header.getBoundingClientRect().height), position: cstyle(header).position, pt: cstyle(header).paddingTop } : null,
    stickyTop, fixedBottom,
    widestCard, cardLefts, cardCount: cards.length,
    gutterLeft: cardLefts.length ? cardLefts[0] : null,
    skipLink: !!document.querySelector('.waves-skip-link, .admin-skip-link'),
  };

  // ---- overlays ----
  const dialogs = qsa('[role="dialog"], [aria-modal="true"]').filter(visible).map((d) => { const cs = cstyle(d); return { sel: sel(d), label: d.getAttribute('aria-label') || d.getAttribute('aria-labelledby'), glass: d.getAttribute('data-glass'), radius: cs.borderTopLeftRadius, box: box(d), backdrop: cs.backdropFilter || cs.webkitBackdropFilter }; });
  const scrims = qsa('[data-glass-scrim]').filter(visible).map((s) => { const cs = cstyle(s); return { bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 50), backdrop: cs.backdropFilter || cs.webkitBackdropFilter }; });
  const bodyLocked = cstyle(document.body).overflow === 'hidden' || cstyle(html).overflow === 'hidden';

  // ---- status chips (no-chips ruling) ----
  const pills = textEls.filter((t) => { const cs = t.cs; const r = t.el.getBoundingClientRect(); return (cs.textTransform === 'uppercase' || parseFloat(cs.borderTopLeftRadius) >= 999 || cs.borderTopLeftRadius === '9999px') && r.height <= 32 && r.width <= 220 && t.el.tagName !== 'BUTTON' && t.el.tagName !== 'A' && !t.el.closest('button, a') && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && !t.el.closest('[data-gt="eyebrow"]'); }).map((t) => ({ sel: sel(t.el), text: t.text, size: t.size, bg: t.cs.backgroundColor, radius: t.cs.borderTopLeftRadius }));

  return {
    theme, fonts,
    text: { count: textEls.length, sizeHist, weightHist, familyHist, colorHist, under14, over700, offScale },
    headings, headingIssues, h1Count: h1s.length, eyebrows,
    glass: { count: glass.length, tierHist, radiusByTier, items: glass, nestedBlur: glass.filter((g) => g.nestedBlur).map((g) => ({ sel: g.sel, tier: g.tier, box: g.box })), inlineBlur },
    controls: { count: controlRows.length, small: smallControls, items: controlRows, inputs, iconOnlyUnnamed },
    layout, overlays: { dialogs, scrims, bodyLocked }, pills,
  };
}

module.exports = { collectMetrics };
