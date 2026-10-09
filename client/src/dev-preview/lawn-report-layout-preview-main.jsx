/**
 * DEV HARNESS: renders the real public ReportViewPage against saved synthetic lawn payloads so the
 * GATE_LAWN_REPORT_LAYOUT before/after can be eyeballed (and screenshotted) without a database or a
 * report token. Served by `npx vite` at
 *   /preview-lawn-report-layout.html?scenario=spot|granular|clean&layout=off|on
 * Payloads come from scripts/generate-lawn-report-layout-fixtures.js (the real server builders).
 * NOT part of the app build.
 */
import './freeze-preview-time';
import '../fonts.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ReportViewPage from '../pages/ReportViewPage';
import WavesShell from '../components/brand/WavesShell';

const FIXTURES = import.meta.glob('../pages/__fixtures__/lawn-layout/*.json', { eager: true, import: 'default' });
const LAYOUT_SCENARIOS = ['spot', 'granular', 'clean'];
// GATE_LAWN_REPORT_POLISH scenarios: a mixed-head system, a single-head system, 15 minutes on four days, and nothing on file; gate off ("base") and on.
const POLISH_SCENARIOS = ['mixed', 'single', 'fourday', 'nothing'];
const SCENARIOS = [...LAYOUT_SCENARIOS, ...POLISH_SCENARIOS];

const params = new URLSearchParams(window.location.search);
const scenario = SCENARIOS.includes(params.get('scenario')) ? params.get('scenario') : 'spot';
const layout = params.get('layout') === 'on' ? 'on' : 'off';
const polish = params.get('polish') === 'on' ? 'on' : 'off';
const isPolishScenario = POLISH_SCENARIOS.includes(scenario);
const fixtureName = isPolishScenario ? `${scenario}-${polish === 'on' ? 'polish' : 'base'}` : `${scenario}-${layout}`;
const payload = FIXTURES[`../pages/__fixtures__/lawn-layout/${fixtureName}.json`];

const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/reports/') && u.includes('/data')) return { ok: true, status: 200, json: async () => payload };
  if (u.includes('/api/reports/')) return { ok: true, status: 200, json: async () => ({}) };
  return realFetch(url, opts);
};

const chip = (active) => ({
  color: active ? '#0F172A' : '#fff',
  background: active ? '#FFD700' : 'transparent',
  border: '1px solid rgba(255,255,255,.25)',
  borderRadius: 6, padding: '3px 8px', textDecoration: 'none', fontWeight: 700,
});

function Bar() {
  const href = (s, l, pol) => `/preview-lawn-report-layout.html?scenario=${s}&layout=${l}&polish=${pol}`;
  return (
    <div data-preview-bar style={{
      position: 'fixed', bottom: 14, right: 14, zIndex: 9999, background: '#0F172A', color: '#fff', borderRadius: 10,
      padding: '8px 10px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
      fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, boxShadow: '0 8px 24px rgba(15,23,42,.35)',
    }}>
      {isPolishScenario ? (
        <>
          <span style={{ opacity: 0.6 }}>polish gate:</span>
          <a href={href(scenario, layout, 'off')} style={chip(polish === 'off')}>off</a>
          <a href={href(scenario, layout, 'on')} style={chip(polish === 'on')}>on</a>
        </>
      ) : (
        <>
          <span style={{ opacity: 0.6 }}>layout gate:</span>
          <a href={href(scenario, 'off', polish)} style={chip(layout === 'off')}>off</a>
          <a href={href(scenario, 'on', polish)} style={chip(layout === 'on')}>on</a>
        </>
      )}
      <span style={{ opacity: 0.6, marginLeft: 8 }}>visit:</span>
      {SCENARIOS.map((s) => <a key={s} href={href(s, layout, polish)} style={chip(s === scenario)}>{s}</a>)}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <>
    <MemoryRouter initialEntries={['/report/preview-token-000']}>
      <Routes>
        <Route path="/report/:token" element={<WavesShell><ReportViewPage /></WavesShell>} />
      </Routes>
    </MemoryRouter>
    <Bar />
  </>,
);
