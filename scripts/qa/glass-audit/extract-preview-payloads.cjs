#!/usr/bin/env node
'use strict';
// Pull the fictional fixture payloads out of the repo's preview harnesses by
// calling their in-page stubbed fetch, so the same data can drive the REAL SPA
// routes (App.jsx wraps several pages in WavesShell that the previews omit).
//   node scripts/qa/glass-audit/extract-preview-payloads.cjs [--url http://127.0.0.1:23817]
/* global window */
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser } = require('../browser');

const root = path.resolve(__dirname, '../../..');
const outDir = path.join(__dirname, 'fixtures');
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const T = (c) => c.repeat(64);

const extractions = [
  { name: 'service-report-server-summary', page: '/preview-service-report.html?scenario=server-summary', calls: [`/api/reports/${T('c')}/data?mode=live`] },
  { name: 'service-report-lawn-v2', page: '/preview-service-report.html?scenario=lawn-v2', calls: [`/api/reports/${T('c')}/data?mode=live`] },
  { name: 'service-report-pest-v2', page: '/preview-service-report.html?scenario=pest-v2', calls: [`/api/reports/${T('c')}/data?mode=live`] },
  { name: 'service-report-mosquito-v2', page: '/preview-service-report.html?scenario=mosquito-v2', calls: [`/api/reports/${T('c')}/data?mode=live`] },
  { name: 'service-report-tree-shrub-v2', page: '/preview-service-report.html?scenario=tree-shrub-v2', calls: [`/api/reports/${T('c')}/data?mode=live`] },
  { name: 'project-report-termite', page: '/preview-project-report.html?scenario=termite', calls: [`/api/reports/project/${T('c')}/data`] },
  { name: 'project-report-cockroach', page: '/preview-project-report.html?scenario=cockroach', calls: [`/api/reports/project/${T('c')}/data`] },
  { name: 'project-report-wdo', page: '/preview-project-report.html?scenario=wdo', calls: [`/api/reports/project/${T('c')}/data`] },
  { name: 'secure-pest', page: '/preview-secure.html?v=pest', calls: [`/api/public/secure-card/${T('a')}`] },
  { name: 'track-en-route', page: '/preview-track.html?state=en_route', calls: [`/api/public/track/${T('b')}`] },
  { name: 'schedule-flow-reschedule', page: '/preview-schedule-flow.html', calls: [`/api/public/reschedule/${T('a')}`] },
];

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  // Browser launch lives INSIDE the protected block: if Playwright's binary is missing the server
  // must still be closed, or the child Vite keeps the checkout's port and breaks the next QA run.
  let server; let browser;
  const failures = [];
  try {
    server = await previewServer(root, urlArg);
    browser = await launchBrowser();
    for (const ex of extractions) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.route('**/*', (route) => { const u = new URL(route.request().url()); return u.origin === server.baseUrl && !u.pathname.startsWith('/api/') ? route.continue() : route.abort(); });
      await page.goto(server.baseUrl + ex.page, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const result = {}; const errors = [];
      for (const call of ex.calls) {
        try {
          const r = await page.evaluate(async (u) => { const r = await window.fetch(u); const text = await r.text(); let body; try { body = JSON.parse(text); } catch (e) { body = null; } return { ok: r.ok, status: r.status, body, isJson: body !== null }; }, call);
          if (!r.ok || !r.isJson) throw new Error(`HTTP ${r.status}${r.isJson ? '' : ' (non-JSON body)'}`);
          result[call] = { status: r.status, body: r.body };
        } catch (e) { errors.push(`${call}: ${String(e.message).slice(0, 120)}`); }
      }
      // Never replace a committed fixture with an error body: skip the write and fail the command instead.
      if (errors.length) { failures.push(`${ex.name}: ${errors.join('; ')}`); console.error(`${ex.name}: NOT written — ${errors.join('; ')}`); }
      else { fs.writeFileSync(path.join(outDir, `${ex.name}.json`), JSON.stringify(result, null, 2)); console.log(`${ex.name}: ${Object.entries(result).map(([k, v]) => `${k} → ${v.status}`).join(', ')}`); }
      await page.close();
    }
  } finally { if (browser) await browser.close(); if (server) await server.close(); }
  if (failures.length) { console.error(`${failures.length} extraction(s) failed; existing fixtures left untouched.`); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exit(1); });
