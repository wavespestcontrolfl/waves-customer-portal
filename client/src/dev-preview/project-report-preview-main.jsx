/**
 * DEV HARNESS — renders the real public ProjectReportViewPage against canned
 * fixtures so the report/certificate template can be iterated in a browser
 * without a database or report token. NOT part of the app build (vite only
 * builds index.html); served by `npx vite` at
 * /preview-project-report.html?scenario=<key> — one scenario per project
 * type the viewer renders, so template edits can be reviewed collectively.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ProjectReportViewPage from '../pages/ProjectReportViewPage';

// ── fixtures ────────────────────────────────────────────────────────────

const BASE = {
  fdacsPdfAvailable: false,
  status: 'sent',
  title: '',
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

// Same contact block as the estimate harness's William Carter fixture so
// report scenarios can be mirrored against /preview-estimate.html.
const CARTER = {
  customerName: 'William Carter',
  customerEmail: 'william.carter@example.com',
  customerPhone: '9415550123',
  cityState: 'Parrish, FL',
  customerAddress: '10225 Kalamazoo Pl, Parrish, FL 34219',
};

// `chips` findings store a comma-joined string (multi_select convention) —
// fixtures mirror what the create form persists, keyed to each type's
// registry field set (server/services/project-types.js).
const PAYLOADS = {
  certificate: () => ({
    ...BASE,
    projectType: 'pre_treatment_termite_certificate',
    customerName: 'Anna Gomez',
    customerEmail: 'anna.gomez@example.com',
    customerPhone: '9415550188',
    cityState: 'Bradenton, FL',
    customerAddress: '4519 Barracuda Dr, Bradenton, FL 34208',
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
  // WDO links are also emailed to the third parties named on the FDACS form,
  // so the live payload redacts the homeowner's email/phone — mirror that.
  wdo: () => ({
    ...BASE,
    ...CARTER,
    customerEmail: null,
    customerPhone: null,
    projectType: 'wdo_inspection',
    fdacsPdfAvailable: true,
    title: 'WDO Inspection Service',
    findings: {
      property_address: '10225 Kalamazoo Pl, Parrish, FL 34219',
      structures_inspected: 'Main home and attached garage',
      structure_type: 'CMU / Concrete Masonry Unit',
      inspection_scope: 'Interior, attic access, garage, exterior perimeter',
      wdo_finding: 'No visible signs of WDO observed',
      inaccessible_areas: 'Attic beyond decked walkway; stored items in garage corners',
      previous_treatment_evidence: 'No',
      notice_location: 'Electrical Panel',
      treated_at_inspection: 'No',
    },
  }),
  report: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'pest_inspection',
    title: 'Ant activity — garage slab edge',
    findings: {
      inspection_type: 'Callback diagnostic',
      areas_inspected: 'Exterior perimeter, Foundation, Garage',
      severity: 'Moderate',
      pests_identified: 'Ghost ants (garage slab edge)',
      findings_observed: 'Active pest activity, Moisture concern',
      conducive_conditions: 'Vegetation touching structure, Moisture present',
      access_limitations: 'No limitations',
      customer_recommendations: 'Trim vegetation, Correct moisture issue',
    },
  }),
  termite: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'termite_inspection',
    title: 'Annual termite inspection',
    findings: {
      areas_inspected: 'Exterior perimeter, garage, attic access, bath traps',
      termite_type: 'None observed',
      activity_status: 'No activity',
      treatment_recommendation: 'Continue annual inspections; monitor mulch depth at foundation',
    },
  }),
  'termite-treatment': () => ({
    ...BASE,
    ...CARTER,
    projectType: 'termite_treatment',
    title: 'Subterranean termite treatment — east wall',
    findings: {
      target_termite: 'Subterranean termites',
      areas_treated: 'East exterior wall and garage slab expansion joint',
      treatment_method: 'Liquid perimeter',
      products_used: 'Termidor SC (fipronil 0.06%)',
      linear_feet_or_stations: '120 linear ft',
      gallons_or_amount: '148 gallons',
      followup_plan: '30-day activity recheck',
    },
  }),
  cockroach: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'cockroach',
    title: 'German roach cleanout — kitchen',
    findings: {
      species: 'German',
      activity_level: 'Moderate',
      activity_locations: 'Kitchen, Bathrooms',
      evidence_observed: 'Live roaches, Droppings',
      conducive_conditions: 'Food debris, Cardboard storage',
      work_completed: 'Bait placement, Insect growth regulator, Crack & crevice treatment',
      customer_prep: 'Remove food debris, No over-the-counter sprays',
    },
  }),
  'one-time-pest': () => ({
    ...BASE,
    ...CARTER,
    projectType: 'one_time_pest_treatment',
    title: 'Wasp nest removal — lanai',
    findings: {
      target_pest: 'Paper wasps',
      areas_inspected: 'Lanai frame, roofline, soffits',
      activity_level: 'Moderate',
      treatment_performed: 'Nest removal and residual treatment of lanai frame',
      products_used: 'Wasp-Freeze II, Tempo SC',
      customer_instructions: 'Keep lanai clear for 2 hours while treatment dries',
      followup_plan: 'None needed unless activity returns',
    },
  }),
  'one-time-lawn': () => ({
    ...BASE,
    ...CARTER,
    projectType: 'one_time_lawn_treatment',
    title: 'Chinch bug rescue treatment',
    findings: {
      turf_type: 'St. Augustine',
      lawn_condition: 'Fair',
      turf_color: 'Yellowing',
      weed_pressure: 'Light',
      insect_pressure: 'Confirmed',
      turf_issues: 'Chinch bug damage',
      work_completed: 'Insect control applied, Fertilizer applied',
      spot_treatment_areas: 'South lawn along driveway',
      customer_recommendations: 'Water deeply and less frequently, Avoid mowing too low',
    },
  }),
  flea: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'flea',
    title: 'Interior + yard flea treatment',
    findings: {
      evidence_level: 'Moderate',
      activity_areas: 'Interior, Pet resting area, Shaded yard',
      treatment_completed: 'Interior flea treatment, Exterior flea treatment, Growth regulator',
      contributing_conditions: 'Pets present, Shaded / moist yard',
      customer_prep: 'Vacuum daily for 2 weeks, Wash pet bedding, Treat pets through veterinarian',
    },
  }),
  'rodent-exclusion': () => ({
    ...BASE,
    ...CARTER,
    projectType: 'rodent_exclusion',
    title: 'Roofline exclusion — full seal',
    findings: {
      exclusion_areas: 'Roofline, Soffit / fascia, Garage',
      entry_points_addressed: 'Roof return gap, AC line penetration, Garage door gaps',
      exclusion_work_completed: 'Sealed entry point, Installed hardware cloth / mesh',
      exclusion_materials: 'Hardware cloth, Sealant',
      remaining_concerns: 'Trapping still active',
    },
  }),
  'rodent-trapping': () => ({
    ...BASE,
    ...CARTER,
    projectType: 'rodent_trapping',
    title: 'Attic trapping program — check 2',
    followupDate: '2026-07-05',
    findings: {
      species: 'Roof rat',
      evidence_observed: 'Droppings, Gnaw marks',
      traps_checked: '8',
      captures: '2',
      trap_actions: 'Captures removed, Traps reset',
      trap_activity_locations: 'Attic north end near AC handler',
      conducive_conditions: 'Roof returns, A/C line penetrations',
      work_completed: 'Traps checked, Captures removed, Traps reset',
      sanitation_recommendations: 'Remove pet food overnight, Reduce garage clutter',
      exclusion_recommendation: 'Recommended after activity stops',
      customer_reported: 'Heard noises in attic',
      customer_discussed: 'Informed of capture(s), Reviewed exclusion recommendation',
    },
  }),
  wildlife: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'wildlife_trapping',
    title: 'Raccoon trapping — attic entry',
    findings: {
      target_animal: 'Raccoon',
      evidence_observed: 'Droppings, Nesting material',
      entry_points: 'Roof returns, Soffit gaps',
      traps_checked: '2',
      captures: '1',
      trap_actions: 'Capture removed, Traps reset',
      customer_recommendations: 'Trim branches off roofline, Secure trash',
    },
  }),
  mosquito: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'mosquito_event',
    title: 'Event spray — backyard party',
    findings: {
      activity_level: 'Moderate',
      activity_locations: 'Backyard, Lanai / screened enclosure',
      treatment_completed: 'Barrier treatment, Resting-site treatment',
      treatment_zones: 'Backyard, Side yards, Lanai exterior',
      standing_water: 'Yes',
      breeding_sources: 'Plant saucers, Buckets',
      source_reduction: 'Emptied standing water, Flipped containers',
      sensitive_areas: 'Blooming plants / pollinators',
      sensitive_areas_avoided: 'Avoided',
      weather_conditions: 'Calm conditions',
      customer_recommendations: 'Empty standing water weekly, Keep gutters clear',
    },
  }),
  palm: () => ({
    ...BASE,
    ...CARTER,
    projectType: 'palm_injection',
    title: 'Palm nutrient treatment — 6 palms',
    findings: {
      palm_species: 'Sylvester and foxtail palms',
      palms_serviced: '6',
      palm_condition: 'Fair',
      condition_observations: 'Yellowing lower fronds, Thin canopy',
      deficiency_signs: 'Potassium deficiency signs, Magnesium deficiency signs',
      work_completed: 'Palm fertilizer applied, Liquid micronutrient treatment',
      customer_recommendations: 'Avoid over-pruning, Do not remove green fronds',
    },
  }),
  'bed-bug': () => ({
    ...BASE,
    ...CARTER,
    projectType: 'bed_bug',
    title: 'Bed bug treatment — primary bedroom',
    findings: {
      rooms_treated: 'Primary bedroom, guest bedroom',
      areas_inspected: 'Mattress seams, Box spring, Bed frame, Headboard',
      evidence_level: 'Moderate',
      evidence_observed: 'Live bed bugs, Cast skins',
      treatment_method: 'Chemical + heat',
      work_completed: 'Mattress / box spring treatment, Crack & crevice treatment, Baseboard treatment',
      prep_status: 'Completed',
      customer_prep: 'Dry bedding on high heat, Do not move items between rooms',
    },
  }),
};

const SCENARIOS = Object.keys(PAYLOADS);
const scenario = (() => {
  const requested = new URLSearchParams(window.location.search).get('scenario');
  return SCENARIOS.includes(requested) ? requested : 'certificate';
})();

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
      maxWidth: 'min(560px, calc(100vw - 28px))',
      background: '#0F172A', color: '#fff', borderRadius: 10,
      padding: '8px 10px', display: 'flex', gap: 6, alignItems: 'center',
      flexWrap: 'wrap',
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
