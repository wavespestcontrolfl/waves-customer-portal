/**
 * DEV HARNESS — the one-screen pest + lawn container (GATE_COMBO_FAST_COMPLETE): the REAL FastCompleteComboSheet with the
 * REAL pest and lawn sheets embedded, over synthetic data, a fake `request` for the sheets and a fake window.fetch for
 * the packet reads (no network, no API, no database). Served by `npx vite` at /preview-combo-fast-complete.html.
 * NOT part of the app build (no rollup input) — never a public route. Nothing is saved: the packet POST answers a
 * canned "done".
 */
import '../index.css';
import '../styles/brand-tokens.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import FastCompleteComboSheet from '../components/tech/FastCompleteComboSheet';

document.documentElement.classList.add('admin-app');
document.body.style.margin = '0';
document.body.style.background = '#fafafa';
localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'preview-op', role: 'technician' }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PEST_ID = 'svc-pest-preview';
const LAWN_ID = 'svc-lawn-preview';
const IDS = { celsius: 'bbbbbbbb-0000-4000-8000-000000000001', headway: 'bbbbbbbb-0000-4000-8000-000000000002', taurus: 'taurus' };
const CATALOG = [
  { id: IDS.celsius, name: 'Celsius WG', category: 'herbicide', formulation: 'WG', inventory_on_hand: '120.0000', inventory_unit: 'oz' },
  { id: IDS.headway, name: 'Headway G', category: 'fungicide', formulation: 'granular', inventory_on_hand: '300.0000', inventory_unit: 'lb' },
  { id: IDS.taurus, name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' },
];
const ADDRESS = { line1: '100 Sample Street', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
const LAWN_VISIT = {
  id: LAWN_ID, customerId: 'cust-preview', customerName: 'Jordan Sample', serviceType: 'Every 6 Weeks Lawn Care Service', status: 'confirmed',
  scheduledDate: '2026-10-05T13:00:00.000Z', propertyId: 'prop-preview', catalogServiceId: null, address: ADDRESS, hasPhone: true,
  category: 'lawn_care', serviceKey: 'lawn_care_recurring', isCallback: false, technicianId: null,
};
const PEST_VISIT = {
  id: PEST_ID, customerName: 'Jordan Sample', customerId: 'cust-preview', propertyId: 'prop-preview', catalogServiceId: 'cat-1',
  serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-05', address: ADDRESS, serviceKey: 'pest_general_quarterly', status: 'confirmed',
};
const SCORES = { turf_density: 78, weed_suppression: 64, color_health: 71, stress_damage: 58 };
const ASSESSMENT = { id: 'assessment-preview', confirmed_by_tech: false, observations: 'Thin turf along the sunny edge.', ...SCORES };
const REVIEW = { status: 'complete', findings: [], addedDetails: [], photoQuality: [], aiScores: SCORES };
const REPORT = 'WHAT WE FOUND\nGhost ants were trailing along the counter, light activity.\n\nWHAT WE DID AND WHY\nWe baited the counter edge and treated around the outside.\n\nWHAT TO EXPECT\nA few more ants near the bait for a few days.\n\nWHAT\'S NEXT\nKeeping the counters wiped helps the bait work.';

const PLANNED = [
  { productId: IDS.celsius, name: 'Celsius WG', applicationMethod: 'broadcast_spray', amount: 3.4, amountUnit: 'oz', treatedSqft: 5750, areaUnit: 'sqft', ratePer1000: 0.59, rateUnit: 'oz' },
];
const lawnContext = () => ({
  enabled: true, eligible: true, reason: null, visitType: 'recurring', findingsType: null, service: LAWN_VISIT, visitDate: '2026-10-05', turfHeightCapture: false,
  plannedProducts: { source: 'plan', items: PLANNED }, plannedProductsUnavailable: null,
  methods: [
    { value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false },
    { value: 'broadcast_spray', label: 'Broadcast spray', common: true, requiresSqft: true },
  ],
  assessment: { exists: false, id: null, confirmed: false }, photoStatus: null, previousFrontPhoto: null, readFailures: [],
});

// The sheets' fake admin API.
async function request(path, options = {}) {
  const bare = path.split('?')[0];
  if (bare.endsWith('/lawn-fast/context')) return lawnContext();
  if (bare.endsWith('/pest-recap/context')) return { ok: true, eligible: true, reportFlow: true, service: PEST_VISIT, products: CATALOG };
  if (bare.endsWith('/tech-rating-allowed')) return { allowed: true, firstVisit: false, scaleLabels: null };
  if (bare.endsWith('/tech-tips')) return { available: false, groups: [] };
  if (bare.endsWith('/promises')) return { available: false, promises: [] };
  if (bare.includes('/blog-posts')) return { available: false, posts: [] };
  if (bare.endsWith('/photos')) return { photos: [] };
  if (bare.endsWith('/treatment-zone/last')) return { available: false };
  if (bare.endsWith('/treatment-zone')) return { enabled: true, treatmentZone: null };
  if (bare === '/admin/schedule/generate-report') { await wait(600); return { report: REPORT }; }
  if (bare.endsWith('/voice-facts')) return { available: true, status: 'read', areas: ['Inside', 'Outside'], pests: ['ghost ants'] };
  if (bare.includes('/lawn-assessment/service/')) return { shotListEnabled: true, assessment: null };
  if (bare.endsWith('/lawn-assessment/assess')) { await wait(700); return { success: true, assessment: ASSESSMENT, visitAssessment: REVIEW, adjustedScores: SCORES, observations: ASSESSMENT.observations }; }
  if (bare.endsWith('/lawn-assessment/confirm')) return { success: true, confirmed: true, assessment: { ...ASSESSMENT, confirmed_by_tech: true }, visitAssessment: REVIEW };
  if (bare.endsWith('/property-areas')) return { enabled: true, propertyId: 'prop-preview', customerId: 'cust-preview', addressKey: 'preview', version: 'c'.repeat(64), areas: { beds: null, mosquito: null, lawn: { sqft: 5750, source: 'recorded', reviewedAt: null } } };
  if (bare === '/admin/dispatch/products/catalog') return { products: CATALOG };
  if (/^\/admin\/customers\//.test(bare)) return { customer: { email: 'jordan.sample@example.com' } };
  return {};
}

// The container's own reads go through adminFetch (window.fetch); answer them locally.
const MEMBERS = [
  { id: LAWN_ID, serviceType: 'Every 6 Weeks Lawn Care Service', status: 'confirmed', requiresForm: true },
  { id: PEST_ID, serviceType: 'Quarterly Pest Control', status: 'confirmed', requiresForm: true },
];
window.fetch = async (url, options = {}) => {
  const target = String(url);
  let body = {};
  if (options.method === 'POST') body = { packetId: 'packet-preview', state: 'done', payment: { state: 'payment_needed' } };
  else if (/\/admin\/schedule\?/.test(target)) body = { services: MEMBERS.map((m) => ({ ...m, visitId: 'visit-preview' })) };
  else if (/\/admin\/visit-closeouts\//.test(target)) body = { visitId: 'visit-preview', serviceDate: '2026-10-05', members: MEMBERS, packet: null };
  await wait(150);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function Preview() {
  const [closed, setClosed] = React.useState(null);
  if (closed) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: '48px 16px', fontSize: 16 }}>
        <p>{closed}</p>
        <p><a href={window.location.href}>Open the sheet again</a></p>
      </main>
    );
  }
  return (
    <FastCompleteComboSheet
      visitId="visit-preview"
      pest={{ service: { id: PEST_ID, customerName: 'Jordan Sample', serviceType: 'Quarterly Pest Control', address: '100 Sample Street, Bradenton', timeLabel: '9:00 AM', reportFlow: true, traceEligible: true, routedCustomerId: 'cust-preview', routedScheduledDate: '2026-10-05', routedPropertyId: 'prop-preview', routedAddress: '100 Sample Street, Bradenton', routedServiceType: null, routedServiceKey: 'pest_general_quarterly' } }}
      lawn={{ service: { id: LAWN_ID, customerName: 'Jordan Sample', serviceType: 'Every 6 Weeks Lawn Care Service', address: '100 Sample Street, Bradenton', customerId: 'cust-preview', fullAddress: '100 Sample Street, Bradenton, FL 34205', customerPhone: '+19415550100', timeLabel: '10:00 AM', routedCustomerId: 'cust-preview', routedScheduledDate: '2026-10-05', routedPropertyId: 'prop-preview', routedAddress: '100 Sample Street, Bradenton' } }}
      request={request}
      operatorId="preview-op"
      catalog={CATALOG}
      onClose={() => setClosed('Closed.')}
      onSaved={() => {}}
      onFullForm={() => setClosed('The long visit closeout would open here.')}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
