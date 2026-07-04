/**
 * DEV HARNESS — renders the real customer EstimateViewPage ("universal
 * template") against canned fixtures so the template can be iterated in a
 * browser without a database or estimate token. NOT part of the app build
 * (vite only builds index.html); served by `npx vite` at
 * /preview-estimate.html?scenario=<pest|preslab|bundle|accepted>.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EstimateViewPage from '../pages/EstimateViewPage';

const SCENARIOS = ['pest', 'preslab', 'bundle', 'accepted'];
const scenario = (() => {
  const requested = new URLSearchParams(window.location.search).get('scenario');
  return SCENARIOS.includes(requested) ? requested : 'pest';
})();

// ── fixtures ────────────────────────────────────────────────────────────

const CONTACT = {
  customerFirstName: 'William',
  customerName: 'William Carter',
  customerEmail: 'william.carter@example.com',
  customerPhone: '9415550123',
  address: '10225 Kalamazoo Pl, Parrish, FL 34219',
};

const BASE_ESTIMATE = {
  id: 1,
  token: 'preview-token',
  slug: null,
  ...CONTACT,
  askToken: 'preview-ask-token',
  category: 'RESIDENTIAL',
  status: 'sent',
  satelliteUrl: null,
  intelligence: null,
  notes: null,
  licenseNumber: 'JB351547',
  showOneTimeOption: false,
  isOneTimeOnly: false,
  defaultServiceMode: 'recurring',
  acceptedServiceMode: null,
  acceptedFrequencyKey: null,
  billByInvoice: false,
  siteConfirmationHold: false,
  acceptance: { mode: 'standard_slot_pick' },
  membership: null,
};

const PEST_INTELLIGENCE = {
  eyebrow: 'Waves AI',
  title: 'Waves AI reviewed your property before pricing this estimate',
  body: 'We reviewed your home, lot, and pest-risk factors before pricing this plan.',
  metrics: [
    { label: 'Home size', value: '2,340 sq ft' },
    { label: 'Lot size', value: '0.21 acres' },
    { label: 'Year built', value: '2024' },
  ],
  signals: [],
};

// Pest service-preference toggles (SERVICE_PREFS interior_spray /
// exterior_sweep) — the "Skip parts you don't need" block. Real payloads
// carry these per frequency with renderFlags.showPestRecurringAddOns.
const PEST_ADD_ONS = [
  { key: 'interior_spray', label: 'Interior spraying', preChecked: true, detail: 'Save $10/visit if removed. No interior treatment — tech sprays and inspects the perimeter only.' },
  { key: 'exterior_sweep', label: 'Exterior eave sweep', preChecked: true, detail: 'Save $10/visit if removed. No eave/cobweb sweep on the exterior — tech still performs the perimeter treatment.' },
];

const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };

const pestFrequency = (key, label, monthly, perVisit, annual) => ({
  key,
  label,
  monthly,
  annual,
  perVisit,
  visitsPerYear: CADENCE_VISITS[key],
  included: [{ key: 'pest_control', label: 'Pest Control', detail: null }],
  addOns: PEST_ADD_ONS,
});

function pestScenario() {
  return {
    estimate: { ...BASE_ESTIMATE, serviceCategory: 'pest_control', intelligence: PEST_INTELLIGENCE },
    pricing: {
      services: [{
        key: 'pest_control',
        label: 'Pest Control',
        isRecurring: true,
        isPest: true,
        waveGuardTierEligible: true,
        defaultFrequencyKey: 'quarterly',
        // Real pest ladder (FREQUENCY_LADDER): quarterly / bi-monthly / monthly.
        // Quarterly = the $94/visit Bronze rounding-artifact repro
        // ($31.33/mo → $93.99/quarter vs $94 anchor).
        frequencies: [
          pestFrequency('quarterly', 'Quarterly', 31.33, 94, 375.96),
          pestFrequency('bi_monthly', 'Bi-monthly', 47, 94, 564),
          pestFrequency('monthly', 'Monthly', 55, 55, 660),
        ],
        setupFee: null,
        quoteRequired: false,
        copy: { priceWording: {} },
      }],
      renderFlags: { showRecurringSummary: false, showWaveGuardSetupFee: false, showPestRecurringAddOns: true },
      waveGuardTier: 'Bronze',
      askChips: ['How do you handle ants?', 'Can you treat inside?', 'When am I charged?', 'What happens after approval?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

function preslabScenario() {
  return {
    estimate: {
      ...BASE_ESTIMATE,
      serviceCategory: 'pre_slab_termiticide',
      isOneTimeOnly: true,
      defaultServiceMode: 'one_time',
    },
    pricing: {
      services: [],
      renderFlags: {},
      waveGuardTier: null,
      askChips: ['What product is used?', 'Do I get documentation?', 'What warranty is selected?', 'When should this be done?'],
      anchorOneTimePrice: 1850,
      oneTimeBreakdown: {
        total: 1850,
        items: [{
          service: 'pre_slab_termiticide',
          label: 'Pre-Slab Termiticide Treatment',
          amount: 1850,
          kind: 'charge',
          detail: 'Termidor HE soil treatment — measured slab area, documentation included',
        }],
      },
      setupFee: null,
      annualPrepayEligible: false,
      defaultServiceMode: 'one_time',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

function bundleScenario() {
  return {
    estimate: { ...BASE_ESTIMATE, serviceCategory: 'bundle', intelligence: PEST_INTELLIGENCE },
    pricing: {
      services: [
        {
          key: 'pest_control',
          label: 'Pest Control',
          isRecurring: true,
          isPest: true,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'quarterly',
          // $147 anchor, Gold 15% → $124.95/visit: a REAL savings line.
          frequencies: [{
            key: 'quarterly',
            label: 'Quarterly',
            monthly: 41.65,
            annual: 499.8,
            perVisit: 147,
            included: [{ key: 'pest_control', label: 'Pest Control', detail: null }],
            addOns: [],
          }],
          copy: { priceWording: {} },
        },
        {
          key: 'lawn_care',
          label: 'Lawn Care',
          isRecurring: true,
          isPest: false,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'standard',
          // $100/mo base, Gold 15% → $85/mo. Non-pest rows carry monthlyBase
          // (pre-discount monthly), never perVisit — mirrors the real payload.
          frequencies: [{
            key: 'standard',
            label: 'Lawn Program',
            serviceCategory: 'lawn_care',
            visitsPerYear: 8,
            monthly: 85,
            monthlyBase: 100,
            annual: 1020,
            billingFrequencyKey: 'monthly',
            included: [
              { key: 'fert', label: 'Fertilization + weed control', detail: '8 applications/year' },
              { key: 'pests', label: 'Chinch, sod webworm & turf pest response', detail: null },
            ],
            addOns: [],
          }],
          copy: { priceWording: {} },
        },
        {
          key: 'mosquito',
          label: 'Mosquito',
          isRecurring: true,
          isPest: false,
          waveGuardTierEligible: true,
          defaultFrequencyKey: 'monthly',
          // $61.18/mo base, Gold 15% → $52/mo (real payloads never set
          // perVisit on non-pest rows).
          frequencies: [{
            key: 'monthly',
            label: 'Monthly',
            serviceCategory: 'mosquito',
            visitsPerYear: 12,
            monthly: 52,
            monthlyBase: 61.18,
            annual: 624,
            included: [{ key: 'mosquito', label: 'Mosquito', detail: null }],
            addOns: [],
          }],
          copy: { priceWording: {} },
        },
      ],
      renderFlags: { showRecurringSummary: true, showWaveGuardSetupFee: false, showPestRecurringAddOns: false },
      waveGuardTier: 'Gold',
      combinedRecurring: { monthlySubtotal: 178.65, annualSubtotal: 2143.8, waveGuardTierLabel: 'Gold' },
      askChips: ['What is included in this plan?', 'How do you handle ants?', 'Are pets and kids safe?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
  };
}

function acceptedScenario() {
  const base = pestScenario();
  return {
    ...base,
    estimate: {
      ...base.estimate,
      status: 'accepted',
      acceptedServiceMode: 'recurring',
      acceptedFrequencyKey: 'quarterly',
      // Booked upcoming visit — the server resolves this via
      // findLinkedUpcomingAppointment and ships it on the acceptance
      // contract; the accepted card shows the date instead of
      // "we'll follow up".
      acceptance: {
        mode: 'existing_appointment',
        ctaLabel: 'Confirm invoice option',
        reason: null,
        appointment: {
          id: 'appt-preview-1',
          scheduledDate: '2026-07-09',
          windowStart: '09:00',
          windowEnd: '10:00',
          windowDisplay: '9:00–10:00 AM',
          serviceType: 'Quarterly Pest Control',
          status: 'confirmed',
        },
      },
    },
    cta: { ...base.cta, canAccept: false, terminalState: 'accepted' },
  };
}

const PAYLOADS = {
  pest: pestScenario,
  preslab: preslabScenario,
  bundle: bundleScenario,
  accepted: acceptedScenario,
};

// ── canned endpoint responses ───────────────────────────────────────────

const SLOTS = {
  nearby: true,
  primary: [
    { slotId: 's1', date: '2026-07-04', windowStart: '09:00', windowEnd: '10:00', routeOptimal: true, techFirstName: 'Adam' },
    { slotId: 's2', date: '2026-07-05', windowStart: '11:00', windowEnd: '12:00' },
    { slotId: 's3', date: '2026-07-07', windowStart: '09:00', windowEnd: '10:00' },
    { slotId: 's4', date: '2026-07-08', windowStart: '13:00', windowEnd: '14:00' },
    { slotId: 's5', date: '2026-07-09', windowStart: '09:00', windowEnd: '10:00', routeOptimal: true, techFirstName: 'Adam' },
    { slotId: 's6', date: '2026-07-10', windowStart: '15:00', windowEnd: '16:00' },
  ],
  expander: [
    { slotId: 's7', date: '2026-07-11', windowStart: '09:00', windowEnd: '10:00' },
    { slotId: 's8', date: '2026-07-12', windowStart: '10:00', windowEnd: '11:00' },
  ],
};

const REVIEWS = {
  reviews: [
    { reviewerName: 'Dana R.', starRating: 5, location: 'Parrish', text: 'Waves has been fantastic — always on time, super thorough, and the ants that plagued our lanai are completely gone.' },
    { reviewerName: 'Mike T.', starRating: 5, location: 'Sarasota', text: 'Great communication from booking to service day. The tech walked me through everything he treated around the house.' },
    { reviewerName: 'Karen L.', starRating: 5, location: 'Lakewood Ranch', text: 'We switched from a national chain and the difference is night and day. Family-owned and it shows in the service.' },
    { reviewerName: 'Josh P.', starRating: 5, location: 'Venice', text: 'Booked online in two minutes, tech showed up in the promised window, and the report with photos was a nice touch.' },
    { reviewerName: 'Elaine S.', starRating: 5, location: 'Bradenton', text: 'Our lawn was full of chinch bug damage — six months with Waves and it is the greenest yard on the street.' },
    { reviewerName: 'Robert G.', starRating: 5, location: 'Parrish', text: 'Honest pricing, no upsell pressure, and they actually answer the phone. Could not recommend them more highly.' },
  ],
  aggregate: { averageRating: '5.0', totalCount: 6 },
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  if (url.includes('/api/estimates/') && url.includes('/data')) {
    return respond(PAYLOADS[scenario]());
  }
  if (url.includes('/available-slots')) {
    const params = new URL(url, window.location.origin).searchParams;
    // Picked-date search: return a small subset so the flow is visible.
    if (params.get('date')) return respond({ nearby: false, primary: SLOTS.primary.slice(1, 3), expander: [] });
    return respond(SLOTS);
  }
  if (url.includes('/find-slots')) {
    return respond({ summary: 'Here’s what’s open around then:', nearby: true, primary: SLOTS.primary.slice(0, 3), expander: [] });
  }
  if (url.includes('/preferences')) {
    return respond({ saved: true });
  }
  if (url.includes('/reviews/featured')) {
    return respond(REVIEWS);
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
          href={`/preview-estimate.html?scenario=${s}`}
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
    <MemoryRouter initialEntries={['/estimate/preview-token']}>
      <Routes>
        <Route path="/estimate/:token" element={<EstimateViewPage />} />
      </Routes>
    </MemoryRouter>
    <ScenarioBar />
  </React.StrictMode>,
);
