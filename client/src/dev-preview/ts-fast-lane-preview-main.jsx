/**
 * DEV HARNESS — the tree & shrub Fast Complete sheet, the REAL component
 * full-screen over synthetic data and a fake `request` (no network, no API,
 * no database). Served by `npx vite` at /preview-ts-fast-lane.html.
 * NOT part of the app build (no rollup input) — never a public route.
 * Same page setup as preview-lawn-fast-lane.html (admin-app class, the admin
 * entry's global stylesheets).
 */
import '../index.css';
import '../styles/brand-tokens.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import FastCompleteTreeShrubSheet from '../components/tech/FastCompleteTreeShrubSheet';

document.documentElement.classList.add('admin-app');
document.body.style.margin = '0';
document.body.style.background = '#fafafa';

// ── synthetic data ──────────────────────────────────────────────────────────
const CATALOG = [
  { id: 'merit', name: 'Merit 2F', category: 'insecticide', active_ingredient: 'imidacloprid', irac_group: '4A', tsFlags: { insectFamily: true, needsIracFrac: true } },
  { id: 'heritage', name: 'Heritage G', category: 'fungicide', formulation: 'granular', frac_group: '11', tsFlags: { needsIracFrac: true } },
  { id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} },
  { id: 'palmfert', name: 'Palm Special 8-2-12', category: 'fertilizer', tsFlags: { npBlackout: true } },
  { id: 'oil', name: 'SuffOil-X', category: 'insecticide', tsFlags: { insectFamily: true, needsIracFrac: true } },
];
const VISIT = {
  id: 'svc-preview', customerId: 'cust-preview', propertyId: 'prop-preview', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-08', address: { line1: '100 Sample Street' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-preview', customerName: 'Jordan Sample', serviceType: 'Tree & Shrub', address: '100 Sample Street', timeLabel: '9:00 AM' };
const CONTEXT = {
  eligible: true,
  reason: null,
  service: VISIT,
  products: CATALOG,
  monthProducts: [
    { productId: 'merit', method: 'foliar_spray', lastAmount: { totalAmount: 2, amountUnit: 'fl_oz', serviceDate: '2026-09-01' } },
    { productId: 'heritage', method: 'soil_drench' },
    { productId: 'iron', method: 'foliar_spray' },
    { productId: 'palmfert', method: 'granular_broadcast' },
  ],
  lastVisit: { plantGroups: ['Palms', 'Shrubs'], areasTreated: ['Front landscape'], products: [] },
  warnings: [],
};
const TIPS = {
  available: true,
  groups: [{
    id: 'tree_shrub',
    tips: [
      { id: 'ts-water', label: 'Water at the base', copy: 'Water at the base of shrubs in the morning, not over the leaves.', keywords: ['water'] },
      { id: 'ts-mulch', label: 'Keep mulch off trunks', copy: 'Pull mulch a few inches back from trunks and stems.', keywords: ['mulch'] },
    ],
  }],
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path) {
  if (path.endsWith('/tree-shrub/fast-context')) return CONTEXT;
  if (path.endsWith('/tech-tips')) return TIPS;
  if (path.endsWith('/complete')) { await wait(500); return { success: true }; }
  return {};
}

function Preview() {
  const [closed, setClosed] = React.useState(null);
  if (closed) return <main style={{ maxWidth: 480, margin: '0 auto', padding: '48px 16px', fontSize: 16 }}><p>{closed}</p></main>;
  return (
    <FastCompleteTreeShrubSheet
      service={SERVICE}
      request={request}
      onClose={() => setClosed('Closed without completing.')}
      onCompleted={() => setClosed('Visit completed (preview: nothing was saved).')}
      onFullForm={() => setClosed('The server would open the full form for this visit.')}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
