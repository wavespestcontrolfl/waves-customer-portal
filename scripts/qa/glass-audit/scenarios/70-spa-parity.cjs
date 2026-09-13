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
// The rest of the payload is a same-day state as well: track-public gates the stops-ahead poll on
// `isServiceDateToday(scheduled_date)` and the page renders an arrival window, so a fixture pinned
// to its capture date shows a live tracker for a visit that already happened. Every remaining stamp
// is shifted by whole days onto the run date with its time of day preserved.
const trackStamps = ['arrivedAt'];
const liveTrack = (body) => {
  const anchor = body.window && body.window.start;
  // Whole ET calendar days between the fixture's visit date and the run's. Adding 86,400,000 ms would
  // preserve the UTC clock, not the Eastern one: rebasing a September 9am stamp across the November
  // DST change lands it at 8am and silently rewrites the arrival-window evidence. `addETDaysAtWallClock`
  // rebuilds the same ET wall-clock time on the target ET date, which is what "9am stays 9am" means.
  const dayNumber = (ymd) => Math.round(Date.UTC(...ymd.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) / 86400000);
  const days = anchor ? dayNumber(etDateString(new Date())) - dayNumber(etDateString(new Date(anchor))) : 0;
  const shift = (iso) => (typeof iso === 'string' && iso ? addETDaysAtWallClock(new Date(iso), days).toISOString() : iso);
  const out = { ...body, vehicle: { ...body.vehicle, lastReportedAt: new Date(Date.now() - 45 * 1000).toISOString() } };
  if (body.window) out.window = { ...body.window, start: shift(body.window.start), end: shift(body.window.end) };
  for (const k of trackStamps) if (body[k]) out[k] = shift(body[k]);
  if (body.summary) out.summary = { ...body.summary, completedAt: shift(body.summary.completedAt) };
  return out;
};
// The reschedule fixture is a one-off extraction whose availability window is literal dates; once they
// are in the past the page still renders "Our best times for you" with slots production could never
// return. Every date is re-based so `rangeFrom` = today (ET calendar days, see 40-diagnostics-booking).
const { addETDays, addETDaysAtWallClock, etDateString } = require('../../../../server/utils/datetime-et');
const liveReschedule = (body) => {
  const from = body.availability && body.availability.rangeFrom;
  if (!from) return body;
  const dayNumber = (ymd) => Math.round(Date.UTC(...ymd.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) / 86400000);
  const base = dayNumber(from);
  const shift = (ymd) => (typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? etDateString(addETDays(new Date(), dayNumber(ymd) - base)) : ymd);
  const fullDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const slot = (s) => ({ ...s, date: shift(s.date) });
  const day = (d) => { const date = shift(d.date); return { ...d, date, fullDate: d.fullDate ? fullDate(date) : d.fullDate, slots: (d.slots || []).map(slot) }; };
  return {
    ...body,
    current: body.current ? { ...body.current, date: shift(body.current.date) } : body.current,
    // `slots` is the top-level ranked list ScheduleFlowPage feeds the picker; it is re-based like the day grid.
    availability: { ...body.availability, rangeFrom: shift(body.availability.rangeFrom), rangeTo: shift(body.availability.rangeTo), days: (body.availability.days || []).map(day), slots: (body.availability.slots || []).map(slot) },
  };
};
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
    handle: ({ method, path: p }) => (method === 'GET' && p === `/api/public/reschedule/${T('a')}` ? { body: liveReschedule(first(fx('schedule-flow-reschedule'))) } : null) },
];
