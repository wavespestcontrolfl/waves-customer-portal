/**
 * DEV HARNESS (uncommitted) — renders the real public ReportViewPage against
 * a canned fixture so coverage-card changes can be eyeballed in a browser
 * without a database or report token. Served by `npx vite` at
 * /preview-service-report.html?scenario=<key>. NOT part of the app build.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ReportViewPage from '../pages/ReportViewPage';
import legacyLawnReport from '../pages/__fixtures__/legacy-lawn-report.json';
import lawnReportV2 from '../pages/__fixtures__/lawn-report-v2.json';
import mosquitoReportV2 from '../pages/__fixtures__/mosquito-report-v2.json';

// Client-built coverage: strip the API serviceCoverage so the page's own
// normalizeServiceCoverage builds the section from raw locations — the code
// path PR #2798 changes.
// The coverage card only renders for non-V2 lines (hideCoverageCard is true
// for lawn/tree/pestV2/mosquitoV2) — preview as a plain pest report.
function asPest(payload) {
  const next = JSON.parse(JSON.stringify(payload));
  next.serviceLine = 'pest';
  next.serviceDisplayName = 'Quarterly Pest Control';
  next.serviceLineDisplay = 'Pest Control Visit';
  delete next.lawnAssessment;
  delete next.reportV2;
  delete next.lawnProgramOverview;
  return next;
}

const clientBuilt = asPest(legacyLawnReport);
delete clientBuilt.serviceCoverage;
clientBuilt.serviceLocations = [
  { id: 'loc-a', name: 'Perimeter', status: 'serviced' },
  { id: 'loc-b', name: 'Garage Interior', status: 'inspected' },
  { id: 'loc-c', name: 'Side Yard', status: 'skipped', skippedReason: 'heavy rain' },
  { id: 'loc-d', name: 'Detached Shed', status: 'not_serviced' },
  { id: 'loc-e', name: 'Lanai', status: 'needs_follow_up' },
];
clientBuilt.serviceAreas = [];

// Server-shaped coverage with the new skippedCount, exercising the chips row.
const serverSummary = asPest(legacyLawnReport);
serverSummary.serviceCoverage = {
  enabled: true,
  serviceLine: 'pest',
  title: 'Service Coverage',
  intro: 'Where your technician serviced, inspected, or could not service today.',
  summary: { completedCount: 2, inspectedCount: 1, inaccessibleCount: 0, needsAttentionCount: 1, skippedCount: 2 },
  legend: [],
  map: { available: false, markers: [] },
  items: [
    { id: 'i1', markerLabel: 'A', areaName: 'Perimeter', status: 'completed', statusLabel: 'Completed', customerDescription: 'Exterior perimeter service completed.' },
    { id: 'i2', markerLabel: 'B', areaName: 'Garage Interior', status: 'inspected', statusLabel: 'Inspected', customerDescription: 'Garage Interior inspected.' },
    { id: 'i3', markerLabel: 'C', areaName: 'Side Yard', status: 'skipped', statusLabel: 'Skipped', customerDescription: 'Service was skipped because heavy rain.' },
    { id: 'i4', markerLabel: 'D', areaName: 'Detached Shed', status: 'not_serviced', statusLabel: 'Not Serviced', customerDescription: 'This area was not serviced on this visit.' },
    { id: 'i5', markerLabel: 'E', areaName: 'Lanai', status: 'needs_follow_up', statusLabel: 'Follow-Up Recommended', customerDescription: 'Technician flagged this area for follow-up.' },
    { id: 'i6', markerLabel: 'F', areaName: 'Entry Points', status: 'completed', statusLabel: 'Completed', customerDescription: 'Entry points inspected and treated.' },
  ],
};

const SCENARIOS = {
  'client-built': clientBuilt,
  'server-summary': serverSummary,
  'lawn-v2': lawnReportV2,
  'mosquito-v2': mosquitoReportV2,
};
const scenario = new URLSearchParams(window.location.search).get('scenario') || 'server-summary';
const payload = SCENARIOS[scenario] || serverSummary;

const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/reports/') && u.includes('/data')) {
    return { ok: true, status: 200, json: async () => payload };
  }
  if (u.includes('/api/reports/')) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  return realFetch(url, opts);
};

// ── scenario switcher chrome (mirrors project-report-preview's bar) ────────
const SERVICE_SCENARIOS = Object.keys(SCENARIOS);
const PROJECT_SCENARIOS = [
  'certificate', 'wdo', 'report', 'termite', 'termite-narrative', 'termite-treatment',
  'termite-treatment-narrative', 'cockroach', 'one-time-pest', 'one-time-lawn', 'flea',
  'rodent-exclusion', 'rodent-trapping', 'wildlife', 'mosquito', 'palm', 'bed-bug',
];
const chip = (active) => ({
  color: active ? '#0F172A' : '#fff',
  background: active ? '#FFD700' : 'transparent',
  border: '1px solid rgba(255,255,255,.25)',
  borderRadius: 6, padding: '3px 8px', textDecoration: 'none', fontWeight: 700,
});

function ScenarioBar() {
  return (
    <div style={{
      position: 'fixed', bottom: 14, right: 14, zIndex: 9999,
      maxWidth: 'min(620px, calc(100vw - 28px))',
      background: '#0F172A', color: '#fff', borderRadius: 10,
      padding: '8px 10px', display: 'flex', gap: 6, alignItems: 'center',
      flexWrap: 'wrap',
      fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12,
      boxShadow: '0 8px 24px rgba(15,23,42,.35)',
    }}>
      <span style={{ opacity: 0.6, marginRight: 2 }}>service reports:</span>
      {SERVICE_SCENARIOS.map((s) => (
        <a key={s} href={`/preview-service-report.html?scenario=${s}`} style={chip(s === scenario)}>{s}</a>
      ))}
      <span style={{ opacity: 0.6, margin: '0 2px 0 8px' }}>project reports:</span>
      {PROJECT_SCENARIOS.map((s) => (
        <a key={s} href={`/preview-project-report.html?scenario=${s}`} style={chip(false)}>{s}</a>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <>
    <MemoryRouter initialEntries={['/report/preview-token-000']}>
      <Routes>
        <Route path="/report/:token" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>
    <ScenarioBar />
  </>,
);
