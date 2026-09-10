'use strict';
// The REAL App.jsx routes driven by the same fictional payloads the preview
// harnesses use (extracted by extract-preview-payloads.cjs). App.jsx wraps
// several of these pages in WavesShell that the previews omit, so shell
// chrome (header, universal footer, main landmark) is only provable here.
const fs = require('node:fs');
const path = require('node:path');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', `${name}.json`), 'utf8'));
const first = (obj) => Object.values(obj)[0].body;
// The tracker renders "Updated Ns ago" from Date.now() - vehicle.lastReportedAt, so a fixed fixture
// timestamp goes stale on every rerun; the en-route payload is stamped relative to the run instead.
const liveTrack = (body) => ({ ...body, vehicle: { ...body.vehicle, lastReportedAt: new Date(Date.now() - 45 * 1000).toISOString() } });
const T = (c) => c.repeat(64);

function reportHandle(payload) {
  return ({ method, path: p }) => {
    if (method === 'GET' && /\/api\/reports\/[a-f0-9]{64}\/data/.test(p)) return { body: payload };
    if (method === 'POST' && /\/api\/reports\/[a-f0-9]{64}\/events/.test(p)) return { body: { ok: true } };
    if (/\/referral-link/.test(p)) return { body: { url: 'https://example.invalid/r/jordan' } };
    return null;
  };
}
function projectHandle(payload) {
  return ({ method, path: p }) => {
    if (method === 'GET' && /\/api\/reports\/project\/[a-f0-9]{64}\/data/.test(p)) return { body: payload };
    if (method === 'POST' && /\/events/.test(p)) return { body: { ok: true } };
    return null;
  };
}

const hoverFirstCard = { name: 'hover-card', widths: [1440], fullPage: false, run: async (page) => { const c = page.locator('[data-glass="card"]').first(); await c.scrollIntoViewIfNeeded(); await c.hover(); } };

module.exports = [
  { id: 'spa-report-service', family: 'document-report', surface: 'customer', role: 'public token', route: '/report/:token (real route, WavesShell)',
    url: `/report/${T('c')}`, ready: 'css:h1', handle: reportHandle(first(fx('service-report-server-summary'))), settle: 1200, extraWidths: true,
    interactions: [hoverFirstCard, { name: 'ask-waves-focus', fullPage: false, run: async (page) => { const i = page.locator('.waves-ask-form input').first(); await i.scrollIntoViewIfNeeded(); await i.focus(); } }] },
  ...['lawn-v2', 'pest-v2', 'mosquito-v2', 'tree-shrub-v2'].map((s) => ({
    id: `spa-report-${s}`, family: 'document-report', surface: 'customer', role: 'public token', route: '/report/:token (real route, WavesShell)',
    url: `/report/${T('c')}`, ready: 'css:h1', handle: reportHandle(first(fx(`service-report-${s}`))), settle: 1200,
  })),
  ...['termite', 'cockroach', 'wdo'].map((s) => ({
    id: `spa-project-report-${s}`, family: 'document-report', surface: 'customer', role: 'public token', route: '/report/project/:token (real route, WavesShell)',
    url: `/report/project/${T('c')}`, ready: 'css:h1', handle: projectHandle(first(fx(`project-report-${s}`))), settle: 1000,
  })),
  { id: 'spa-track-en-route', family: 'flow', surface: 'customer', role: 'public token', route: '/track/:token (real route)',
    url: `/track/${T('b')}`, ready: 'Alex arrives in', settle: 900,
    handle: ({ method, path: p }) => { if (method === 'GET' && p === `/api/public/track/${T('b')}`) return { body: liveTrack(first(fx('track-en-route'))) }; if (/stops-ahead/.test(p)) return { body: { stopsAhead: 2 } }; return null; } },
  { id: 'spa-secure-pest', family: 'flow', surface: 'customer', role: 'public token', route: '/secure/:token (real route)',
    url: `/secure/${T('a')}`, ready: 'Quarterly Pest Control', settle: 900,
    handle: ({ method, path: p }) => (method === 'GET' && p === `/api/public/secure-card/${T('a')}` ? { body: first(fx('secure-pest')) } : null) },
  { id: 'spa-reschedule', family: 'flow', surface: 'customer', role: 'public token', route: '/reschedule/:token (real route)',
    url: `/reschedule/${T('a')}`, ready: 'Our best times for you', settle: 900,
    handle: ({ method, path: p }) => (method === 'GET' && p === `/api/public/reschedule/${T('a')}` ? { body: first(fx('schedule-flow-reschedule')) } : null) },
];
