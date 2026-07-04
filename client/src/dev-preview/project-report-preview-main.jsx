/**
 * DEV HARNESS — renders the real public ProjectReportViewPage against canned
 * fixtures so the report/certificate template can be iterated in a browser
 * without a database or report token. NOT part of the app build (vite only
 * builds index.html); served by `npx vite` at
 * /preview-project-report.html?scenario=<certificate|report>.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProjectReportViewPage from '../pages/ProjectReportViewPage';

const SCENARIOS = ['certificate', 'report'];
const scenario = (() => {
  const requested = new URLSearchParams(window.location.search).get('scenario');
  return SCENARIOS.includes(requested) ? requested : 'certificate';
})();

// ── fixtures ────────────────────────────────────────────────────────────

const BASE = {
  fdacsPdfAvailable: false,
  status: 'sent',
  title: '',
  customerName: 'Anna Gomez',
  cityState: 'Bradenton, FL',
  customerAddress: '4519 Barracuda Dr, Bradenton, FL 34208',
  technicianName: 'Adam',
  projectDate: '2026-06-28',
  sentAt: '2026-06-28T18:30:00Z',
  recommendations: null,
  followupDate: null,
  followupFindings: null,
  followupCompletedAt: null,
  upcomingAppointment: null,
  photos: [],
};

const PAYLOADS = {
  certificate: () => ({
    ...BASE,
    projectType: 'pre_treatment_termite_certificate',
    findings: {
      treatment_address: '4519 Barracuda Dr, Bradenton, FL 34208',
      lot_block: 'Lot 14, Block B',
      subdivision: 'Harbor Point',
      permit_number: 'BLD-2026-04412',
      builder_contractor: 'Suncoast Custom Homes',
      treatment_date: '2026-06-28',
      treatment_time: '08:40',
      treatment_method: 'Soil barrier (chemical)',
      product_name: 'Termidor SC',
      epa_registration: '7969-210',
      active_ingredient: 'Fipronil',
      concentration_pct: '0.06',
      square_footage: '2450',
      linear_feet: '310',
      trench_depth_ft: '6 in',
      gallons_applied: '392',
      wdo_target: 'Subterranean termites',
      warranty_type: '1-year retreatment warranty',
      renewal_due: 'June 2027',
      applicator_name: 'Adam Benetti',
      applicator_fdacs_id: 'JE362022',
      applicator_attestation: 'I attest that the soil treatment described above was applied in accordance with the product label and Florida Building Code 1816.1.7.',
    },
  }),
  report: () => ({
    ...BASE,
    projectType: 'pest_inspection',
    findings: {
      areas_inspected: 'Kitchen, garage, exterior perimeter, attic access',
      activity_found: 'Ant trailing along the garage slab edge; no interior activity',
      treatment_performed: 'Perimeter barrier application and garage slab-edge treatment',
    },
  }),
};

// ── fetch mock ──────────────────────────────────────────────────────────

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  if (url.includes('/api/reports/project/') && url.includes('/data')) {
    return respond(PAYLOADS[scenario]());
  }
  if (url.startsWith('/api/')) {
    // Any other portal call is inert in the harness.
    return respond({ error: 'preview-harness: endpoint not mocked' }, 404);
  }
  return originalFetch(input, init);
};

// ── scenario switcher chrome ────────────────────────────────────────────

function ScenarioBar() {
  return (
    <div style={{
      position: 'fixed', bottom: 14, right: 14, zIndex: 9999,
      background: '#0F172A', color: '#fff', borderRadius: 10,
      padding: '8px 10px', display: 'flex', gap: 6, alignItems: 'center',
      fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12,
      boxShadow: '0 8px 24px rgba(15,23,42,.35)',
    }}>
      <span style={{ opacity: 0.6, marginRight: 2 }}>preview:</span>
      {SCENARIOS.map((s) => (
        <a
          key={s}
          href={`/preview-project-report.html?scenario=${s}`}
          style={{
            color: s === scenario ? '#0F172A' : '#fff',
            background: s === scenario ? '#FFD700' : 'transparent',
            border: '1px solid rgba(255,255,255,.25)',
            borderRadius: 6, padding: '3px 8px', textDecoration: 'none', fontWeight: 700,
          }}
        >
          {s}
        </a>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/report/project/preview-token']}>
      <Routes>
        <Route path="/report/project/:token" element={<ProjectReportViewPage />} />
      </Routes>
    </MemoryRouter>
    <ScenarioBar />
  </React.StrictMode>,
);
