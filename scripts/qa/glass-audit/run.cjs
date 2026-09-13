#!/usr/bin/env node
'use strict';
// Liquid Glass consistency audit — rendered-evidence runner.
//
// SYNTHETIC UI QA. Frontend only. Every /api request is fulfilled locally from
// the scenario's fixture handler; anything unmatched returns 404 JSON and is
// recorded; external origins are blocked. Never reaches a database, a real
// customer record, a payment provider, or any outbound integration.
//
//   node scripts/qa/glass-audit/run.cjs [--only id,id] [--family fam] \
//        [--widths 390,1440] [--extra] [--url http://127.0.0.1:PORT] [--engine chromium|webkit]
//
// Output: .tmp/glass-audit/<run>/<scenario>/<state>-<width>.png + metrics.json,
//         .tmp/glass-audit/<run>/summary.json
/* global document, window */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('../browser');
const { collectMetrics } = require('./metrics.cjs');
const { decode, sampleContrast } = require('./contrast.cjs');
const { loadScenarios } = require('./scenarios/index.cjs');

const root = path.resolve(__dirname, '../..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const only = opt('only', '') ? opt('only').split(',') : null;
const family = opt('family', null);
const widths = opt('widths', '390,1440').split(',').map(Number);
const extraWidths = flag('extra') ? [320, 375, 430, 768, 1024] : [];
const engineName = opt('engine', 'chromium');
// Every capture records `engine`, so an unsupported value must not silently launch Chromium
// and attribute the evidence to an engine that was never tested.
if (!['chromium', 'webkit'].includes(engineName)) { console.error(`glass-audit: unsupported --engine "${engineName}" (chromium | webkit)`); process.exit(2); }
const runName = opt('run', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const outRoot = path.join(root, '.tmp/glass-audit', runName);
const heights = { 320: 568, 375: 667, 390: 844, 430: 932, 768: 1024, 1024: 768, 1440: 1000 };

const collectSrc = `(${collectMetrics.toString()})`;

// Contrast: sample a screenshot around small text (<=16px) and every control. Shared by the pristine
// state capture and every interaction capture — an opened sheet / menu / dialog is otherwise counted
// as inspected while any low-contrast text painted only inside it never reaches the digest.
// `fullPage` says which coordinate space the PNG is in: a full-page shot is the document, so boxes
// carry the scroll offset; a viewport-only shot (every interaction that does not opt into fullPage)
// is the viewport, where adding scrollY would sample pixels the image does not contain.
async function probeContrast(page, shotPath, fullPage) {
  const png = decode(fs.readFileSync(shotPath));
  const items = await page.evaluate((docSpace) => {
    const out = [];
    // Same-origin iframes (newsletter archive article) are walked too; their boxes are translated
    // into page coordinates through the frame's rect so the screenshot samples land on the text.
    const docs = [{ doc: document, dx: 0, dy: 0, tag: '' }];
    for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) { const fr = f.getBoundingClientRect(); docs.push({ doc: f.contentDocument, dx: fr.left + f.clientLeft, dy: fr.top + f.clientTop, tag: 'iframe>' }); } } catch (e) { /* cross-origin */ } }
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    for (const d of docs) {
      const walker = d.doc.createTreeWalker(d.doc.body, 4);
      let n; const seen = new Set();
      while ((n = walker.nextNode())) {
        const el = n.parentElement; if (!el || seen.has(el) || !n.textContent.trim()) continue; if (el.closest('svg, script, style, [aria-hidden="true"], .glass-scene-orbs')) continue; if (!vis(el)) continue; seen.add(el);
        const cs = getComputedStyle(el); const size = parseFloat(cs.fontSize); // large text (24px+, or 18.66px+ bold) is screened at 3:1 below, never skipped
        const r = el.getBoundingClientRect();
        out.push({ sel: d.tag + el.tagName.toLowerCase() + (el.getAttribute('data-glass') != null ? `[data-glass=${el.getAttribute('data-glass')}]` : '') + (el.hasAttribute('data-glass-accent') ? '[accent]' : ''), text: n.textContent.trim().slice(0, 40), size, weight: parseInt(cs.fontWeight, 10), color: cs.color, box: { x: r.left + d.dx + (docSpace ? window.scrollX : 0), y: r.top + d.dy + (docSpace ? window.scrollY : 0), w: r.width, h: r.height } });
      }
      // Text painted by form controls is not a DOM text node: an input's current value and its
      // ::placeholder (login, booking, quote, payment fields) are sampled explicitly.
      for (const el of d.doc.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=range]):not([type=color]), textarea, select')) {
        if (!vis(el) || el.closest('[aria-hidden="true"]')) continue;
        const cs = getComputedStyle(el); const size = parseFloat(cs.fontSize);
        const r = el.getBoundingClientRect();
        const box = { x: r.left + d.dx + (docSpace ? window.scrollX : 0), y: r.top + d.dy + (docSpace ? window.scrollY : 0), w: r.width, h: r.height };
        const tag = d.tag + el.tagName.toLowerCase() + (el.type ? `[type=${el.type}]` : '');
        const value = el.tagName === 'SELECT' ? (el.selectedOptions[0] ? el.selectedOptions[0].text : '') : (el.value || '');
        if (value.trim()) out.push({ sel: tag + '[value]', text: value.trim().slice(0, 40), size, weight: parseInt(cs.fontWeight, 10), color: cs.color, box });
        else if (el.placeholder && el.placeholder.trim()) {
          let ph = null; try { ph = getComputedStyle(el, '::placeholder'); } catch (e) { ph = null; }
          out.push({ sel: tag + '::placeholder', text: el.placeholder.trim().slice(0, 40), size: ph ? parseFloat(ph.fontSize) || size : size, weight: parseInt((ph && ph.fontWeight) || cs.fontWeight, 10), color: (ph && ph.color) || cs.color, box });
        }
      }
    }
    return out;
  }, fullPage);
  const contrast = [];
  let skipped = 0;
  for (const it of items) {
    if (it.box.w < 8 || it.box.h < 8) continue;
    // `pixel()` clamps out-of-range coordinates to the image edge, so a box outside the capture
    // (an off-screen skip link at y=-100, anything below a viewport-only shot) would be scored
    // against edge pixels and reported as a ~1:1 "finding" that nothing on screen can show.
    // Unsampleable is not the same as failing: those boxes are counted, not scored.
    if (it.box.x < 0 || it.box.y < 0 || it.box.x + it.box.w > png.width || it.box.y + it.box.h > png.height) { skipped += 1; continue; }
    const c = sampleContrast(png, 1, it.box, it.color);
    if (!c) continue;
    const large = it.size >= 24 || (it.size >= 18.66 && it.weight >= 700);
    const threshold = large ? 3 : 4.5;
    // Screen on the WORST sampled background (text over a gradient or variegated glass can be
    // unreadable at one edge while the averaged background still passes); `avg` is kept for the digest.
    if (c.min < threshold) contrast.push({ ...it, ...c, threshold });
  }
  return { contrast, contrastSampled: items.length, contrastOffscreen: skipped };
}

async function runState({ browser, baseUrl, scenario, state, width, report }) {
  const height = heights[width] || 900;
  const mobile = width <= 640;
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: mobile, isMobile: mobile && engineName === 'chromium', deviceScaleFactor: 1,
    timezoneId: 'America/New_York', serviceWorkers: 'block', reducedMotion: state.reducedMotion ? 'reduce' : 'no-preference',
    colorScheme: 'light', forcedColors: state.forcedColors ? 'active' : 'none',
  });
  const rec = { scenario: scenario.id, state: state.name, width, engine: engineName, url: null, pageErrors: [], consoleErrors: [], unmatched: [], external: [], apiCalls: [], screenshot: null, metrics: null, contrast: [], interactions: [], blockedSockets: [], failure: null };
  // `page.route()` below never sees a WebSocket handshake, so the /socket.io abort does not stop the
  // websocket-first connections TrackPage and the dispatch hooks open -- those would reach the real
  // backend through Vite's WS proxy and break the harness's frontend-only guarantee (and the evidence
  // would reflect live data, not the fixture). Routed on the CONTEXT, before any page exists, and the
  // socket is closed without `connectToServer()` so nothing is opened upstream.
  await context.routeWebSocket('**', (ws) => { rec.blockedSockets.push(String(ws.url()).slice(0, 160)); ws.close(); });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => rec.pageErrors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 300)); });
  await page.addInitScript((seed) => {
    try { for (const [k, v] of Object.entries(seed || {})) localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    if (navigator.serviceWorker) navigator.serviceWorker.register = async () => ({ scope: 'synthetic' });
  }, Object.assign({}, scenario.localStorage || {}, state.localStorage || {}));
  const handle = state.handle || scenario.handle || (() => null);
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== baseUrl) {
      // Fonts and static assets from the app origin only; block every external origin.
      rec.external.push(`${req.method()} ${url.origin}${url.pathname}`.slice(0, 160));
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/socket.io')) return route.continue();
    if (url.pathname.startsWith('/socket.io')) return route.abort();
    let body = null;
    try { body = req.postDataJSON(); } catch (e) { body = req.postData(); }
    const res = await handle({ method: req.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), body, url });
    rec.apiCalls.push(`${req.method()} ${url.pathname}${url.search}`.slice(0, 160));
    if (!res) {
      rec.unmatched.push(`${req.method()} ${url.pathname}${url.search}`.slice(0, 160));
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'glass-audit: endpoint not mocked' }) });
    }
    if (res.html) return route.fulfill({ status: res.status || 200, contentType: 'text/html', body: res.html });
    return route.fulfill({ status: res.status || 200, contentType: 'application/json', body: JSON.stringify(res.body === undefined ? res : res.body), headers: res.headers || {} });
  });
  const dir = path.join(outRoot, scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const target = baseUrl + (state.url || scenario.url);
    rec.url = state.url || scenario.url;
    const nav = await page.goto(target, { waitUntil: 'domcontentloaded' });
    // Vite answers unknown paths with the SPA fallback or a 404 page; a bad status must not pass as evidence.
    if (nav && nav.status() >= 400) throw new Error(`navigation returned HTTP ${nav.status()} for ${rec.url}`);
    const ready = state.ready || scenario.ready;
    if (ready) {
      if (typeof ready === 'function') await ready(page);
      else if (ready.startsWith('css:')) await page.locator(ready.slice(4)).first().waitFor({ timeout: 30000 });
      else await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), ready, { timeout: 30000 });
    }
    // server-html scenarios (email chrome, newsletter landing) use a system font stack and never load the SPA webfonts.
    if (scenario.fonts !== false) await waitForFonts(page);
    if (state.setup) await state.setup(page, rec);
    await page.waitForTimeout(state.settle ?? scenario.settle ?? 700);
    // Let scroll-reveal observers fire on everything before the full-page shot.
    rec.revealPending = await page.evaluate(async (hide) => {
      // Dev-only preview chrome (scenario switcher bars) is not part of the product surface.
      for (const sel of hide || []) document.querySelectorAll(sel).forEach((el) => { el.style.display = 'none'; });
      const h = document.documentElement.scrollHeight; const step = Math.max(240, window.innerHeight - 160);
      for (let y = 0; y < h; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 300));
      // Anything the IntersectionObserver still has not revealed is forced visible so the
      // evidence shows the composed page (the count is recorded: reveal is scroll-driven by design).
      const pending = document.querySelectorAll('.glass-reveal-pending');
      pending.forEach((el) => el.classList.remove('glass-reveal-pending'));
      await new Promise((r) => setTimeout(r, 250));
      return pending.length;
    }, scenario.hide || []);
    const shot = path.join(dir, `${state.name}-${width}.png`);
    const jsonPath = path.join(dir, `${state.name}-${width}.json`);
    // The JSON record is only written at the very end of this function, well after the screenshot below.
    // A rerun that reuses this state/width overwrites the PNG first; if the process dies before the JSON
    // rewrite, the OLD (successful) record would survive pointing at a now-incomplete screenshot and
    // analyze.cjs/matrix.cjs would keep counting it as inspected. Delete the stale record BEFORE the
    // screenshot so an interruption leaves no capture at all (NOT VERIFIED) instead of a fake success.
    try { fs.unlinkSync(jsonPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await page.screenshot({ path: shot, fullPage: !state.viewportOnly });
    rec.screenshot = path.relative(root, shot);
    rec.metrics = await page.evaluate(collectSrc + '(arguments[0])'.replace('arguments[0]', JSON.stringify(scenario.sheet || {})));
    // A measurement probe that throws is missing evidence, not "no violations": it fails the capture
    // (below) unless the scenario opted out of that probe. The error text is kept alongside.
    const probeFailures = [];
    try {
      const { contrast, contrastSampled, contrastOffscreen } = await probeContrast(page, shot, !state.viewportOnly);
      rec.contrast = contrast;
      rec.contrastSampled = contrastSampled;
      rec.contrastOffscreen = contrastOffscreen;
    } catch (e) { rec.contrastError = String(e.message); probeFailures.push(`contrast probe: ${String(e.message).slice(0, 120)}`); }
    // Keyboard focus ring probe on the PRISTINE page (before interactions open sheets / menus that trap or
    // drop focus): real Tab traversal (page.keyboard), so only elements actually in the
    // Tab order are reported and :focus-visible behaves as it does for a keyboard user. Resting
    // outline / box-shadow are snapshotted for every control first: glass controls carry decorative
    // elevation shadows, so a box-shadow only counts as a ring when it CHANGES on focus.
    if (!state.skipFocusProbe) {
      try {
        await page.evaluate(() => {
          window.__glassResting = new Map();
          // Same-origin iframes (newsletter archive article) are in the Tab order too: their controls are
          // snapshotted so a focused link inside the frame is judged against its own resting style.
          const docs = [document];
          for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) { /* cross-origin */ } }
          for (const d of docs) for (const el of d.querySelectorAll('a, button, input, select, textarea, [tabindex], [contenteditable]')) {
            const cs = d.defaultView.getComputedStyle(el);
            window.__glassResting.set(el, { shadow: cs.boxShadow, outline: `${cs.outlineStyle} ${cs.outlineWidth}` });
          }
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
          window.scrollTo(0, 0);
        });
        // Interactions (dialogs, sheets) can leave the document without focus; Tab then goes nowhere.
        await page.bringToFront();
        await page.evaluate(() => window.focus());
        const out = []; const seen = new Set();
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press('Tab');
          const row = await page.evaluate(() => {
            // Once Tab enters a same-origin iframe the top document's activeElement stays the IFRAME while
            // focus advances inside it; descend to the innermost focused element so the frame's controls
            // are inspected instead of the repeated IFRAME reading as wrap-around.
            let el = document.activeElement; let depth = '';
            while (el && el.tagName === 'IFRAME') {
              let inner = null; try { inner = el.contentDocument && el.contentDocument.activeElement; } catch (e) { inner = null; }
              if (!inner || inner === el.contentDocument.body) break;
              el = inner; depth += 'iframe>';
            }
            if (!el || el === document.body) return { end: true, active: el ? el.tagName : null, hasFocus: document.hasFocus() };
            const cs = el.ownerDocument.defaultView.getComputedStyle(el);
            const resting = window.__glassResting.get(el) || { shadow: cs.boxShadow, outline: '' };
            const outlineVisible = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
            const shadowChanged = cs.boxShadow !== resting.shadow && cs.boxShadow !== 'none';
            el.__glassProbeId = el.__glassProbeId || `${depth}${el.tagName}#${Math.random().toString(36).slice(2, 8)}`;
            return { id: el.__glassProbeId, sel: depth + el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''), name: (el.getAttribute('aria-label') || el.innerText || el.placeholder || '').trim().slice(0, 30), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, restingOutline: resting.outline, shadow: cs.boxShadow.slice(0, 60), restingShadow: resting.shadow.slice(0, 60), shadowChanged, ring: outlineVisible || shadowChanged };
          });
          if (row.end || seen.has(row.id)) { if (!out.length) rec.focusProbeNote = JSON.stringify(row); break; } // focus left the document or wrapped around
          seen.add(row.id); delete row.id; out.push(row);
        }
        // Tab traversal scrolls the page; restore the pristine scroll position for the interactions that follow.
        await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); });
        await page.waitForTimeout(150);
        rec.focusProbe = out;
      } catch (e) { rec.focusProbeError = String(e.message); probeFailures.push(`focus probe: ${String(e.message).slice(0, 120)}`); }
    }
    // Interactions (hover / focus / open overlay), each captured as its own shot.
    for (const ix of (state.interactions || scenario.interactions || [])) {
      if (ix.widths && !ix.widths.includes(width)) continue;
      const ixRec = { name: ix.name, ok: false, contrast: [] };
      try {
        await ix.run(page, { width, mobile });
        await page.waitForTimeout(ix.settle || 500);
        const s = path.join(dir, `${state.name}-${width}-${ix.name}.png`);
        await page.screenshot({ path: s, fullPage: !!ix.fullPage });
        ixRec.screenshot = path.relative(root, s);
        if (ix.metrics !== false) ixRec.metrics = await page.evaluate(collectSrc + '(' + JSON.stringify(scenario.sheet || {}) + ')');
        if (ix.probe) ixRec.probe = await ix.probe(page);
        // Same probe as the pristine-state shot, against the interaction's OWN screenshot: text painted
        // only inside an opened sheet / menu / dialog is otherwise never checked for contrast. A throw
        // here fails the interaction like any other probe throw (ixRec.ok stays false).
        ixRec.contrast = (await probeContrast(page, s, !!ix.fullPage)).contrast;
        ixRec.ok = true;
      } catch (e) { ixRec.error = String(e.message).slice(0, 300); }
      rec.interactions.push(ixRec);
    }
    // A failed interaction or probe is missing evidence: mark the capture failed (the main shot + metrics are kept).
    const badIx = rec.interactions.filter((i) => !i.ok);
    if (badIx.length) probeFailures.push(`interaction(s) failed: ${badIx.map((i) => `${i.name} (${i.error})`).join('; ')}`);
    // An uncaught exception in the rendered app is a runtime failure even when the page stayed mounted
    // long enough to be measured: it must not print [ok] or count as inspected.
    if (rec.pageErrors.length) probeFailures.push(`uncaught page error(s): ${rec.pageErrors.slice(0, 3).join('; ')}`);
    if (probeFailures.length) rec.failure = probeFailures.join(' | ').slice(0, 500);
  } catch (e) {
    rec.failure = String(e.message).slice(0, 500);
    try { const s = path.join(dir, `${state.name}-${width}-FAILED.png`); await page.screenshot({ path: s, fullPage: true }); rec.screenshot = path.relative(root, s); } catch (e2) { /* ignore */ }
  }
  await context.close();
  report.results.push(rec);
  const status = rec.failure ? 'FAIL' : 'ok';
  const m = rec.metrics;
  const brief = m ? `glass=${m.theme.mounted ? m.theme.attr === '' ? 'on' : m.theme.attr : 'OFF'} <14:${m.text.under14.length} >700:${m.text.over700.length} h1:${m.h1Count} small:${m.controls.small.length} ovx:${m.layout.overflowX} nestedBlur:${m.glass.nestedBlur.length} contrast:${rec.contrast.length} unmatched:${rec.unmatched.length} err:${rec.pageErrors.length}` : '';
  console.log(`[${status}] ${scenario.id} / ${state.name} @${width} ${brief}${rec.failure ? ' — ' + rec.failure : ''}`);
  fs.writeFileSync(path.join(dir, `${state.name}-${width}.json`), JSON.stringify(rec, null, 2));
}

// Server-rendered scenarios read static files from client/glass-audit-html/ (gitignored). They are
// re-rendered on every run that selects one, so neither a fresh checkout nor a stale cache is captured.
function ensureServerHtml(scenarios) {
  const needed = scenarios.filter((s) => s.surface === 'server-html');
  if (!needed.length) return;
  // Always re-render: the renderer is cheap and the gitignored files must reflect the CURRENT
  // email-template.js / public-newsletter.js, never a cached copy from an earlier checkout state.
  console.log(`glass-audit: rendering server HTML for ${needed.length} scenario(s)`);
  require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'render-server-html.cjs')], { stdio: 'inherit' });
  const still = needed.filter((s) => !fs.existsSync(path.join(root, 'client', s.url.replace(/^\//, ''))));
  if (still.length) throw new Error(`server HTML not rendered for: ${still.map((s) => s.id).join(', ')}`);
}

// Which engine's captures a run directory already holds: summary.json (written before the first capture
// and again at the end) or, failing that, any per-capture record's `engine` field.
function existingRunEngine(dir) {
  try { const prev = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); if (prev.engine) return prev.engine; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  for (const d of entries.filter((x) => x.isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, d.name)).filter((x) => x.endsWith('.json'))) {
      try { const rec = JSON.parse(fs.readFileSync(path.join(dir, d.name, f), 'utf8')); if (rec.engine) return rec.engine; } catch (e) { /* unreadable partial record */ }
    }
  }
  return null;
}

async function main() {
  // A fixture whose literal date has slipped into the past renders a state the public route can no
  // longer emit, so the capture would be filed as evidence of a screen that does not exist. Checked
  // before anything launches: stale evidence is worse than no evidence.
  require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'check-fixture-dates.cjs')], { stdio: 'inherit' });
  const report = { ...evidence(root), engine: engineName, widths: widths.concat(extraWidths), started: new Date().toISOString(), results: [] };
  const registry = loadScenarios();
  // A misspelled or stale --only id must fail BEFORE anything launches: silently dropping it would
  // produce a zero- or partial-capture run that exits 0 without auditing what was asked for.
  if (only) {
    const known = new Set(registry.map((s) => s.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`unknown scenario id(s) in --only: ${unknown.join(', ')}`);
  }
  if (family && !registry.some((s) => s.family === family)) throw new Error(`unknown --family: ${family}`);
  const scenarios = registry.filter((s) => (!only || only.includes(s.id)) && (!family || s.family === family));
  if (!scenarios.length) throw new Error('no scenarios selected (the --only ids exist but none is in --family)');
  // A run directory belongs to ONE engine: capture files are named <state>-<width>.*, so a WebKit
  // pass into a run that already holds Chromium captures (or vice versa) would overwrite that
  // engine's evidence. Refuse instead of silently replacing it; pick another --run name.
  // The engine is persisted BEFORE any capture (a summary skeleton), and an interrupted run that never
  // wrote a summary is still recognised from its per-capture records, which each carry `engine`.
  const heldEngine = existingRunEngine(outRoot);
  if (heldEngine && heldEngine !== engineName) throw new Error(`run "${runName}" already holds ${heldEngine} captures; use a different --run for ${engineName}`);
  fs.mkdirSync(outRoot, { recursive: true });
  if (!heldEngine) fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify({ ...report, partial: true }, null, 2));
  console.log(`glass-audit: ${scenarios.length} scenarios → ${path.relative(root, outRoot)}`);
  ensureServerHtml(scenarios);
  let server; let browser;
  try {
    server = await previewServer(root, opt('url', null));
    browser = engineName === 'webkit' ? await webkit.launch({ headless: true }) : await launchBrowser();
    for (const scenario of scenarios) {
      const states = scenario.states && scenario.states.length ? scenario.states : [{ name: 'default' }];
      for (const state of states) {
        const ws = state.widths || scenario.widths || widths.concat(scenario.extraWidths ? extraWidths : []);
        for (const width of ws) await runState({ browser, baseUrl: server.baseUrl, scenario, state, width, report });
      }
    }
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(report, null, 2));
    const failed = report.results.filter((r) => r.failure);
    console.log(`done: ${report.results.length} captures (${failed.length} failed), summary → ${path.relative(root, path.join(outRoot, 'summary.json'))}`);
    // A capture that could not produce evidence must fail the command (CI / scripted regression use).
    if (failed.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
