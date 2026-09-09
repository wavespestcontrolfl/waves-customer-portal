import { etDateString, addETDays } from '../lib/timezone';
/**
 * DEV HARNESS — renders the REAL PropertyTab (customer PortalPage) against a
 * stubbed property-preferences api so the Irrigation card — including the
 * minutes-per-zone → derived-inches line — can be eyeballed in a browser
 * with no database, backend, or login. Served by vite at
 * /preview-irrigation.html. NOT part of the app build.
 *
 * ?state= selects the derivation state the card renders:
 *   spray  (default) single head type → derived inches line
 *   mixed  spray+rotor → declines with the mixed-rates explanation
 *   notype no head type → asks for system type
 *   inches explicit weekly inches → derived figure defers to it
 *   legacyoff row the retired toggle left "off" with inputs — a note must
 *          say the schedule isn't being counted yet (legacyoffinches: the
 *          same with a typed Weekly Inches, which is suppressed too)
 *   daysonly only watering days saved — summary must not read as empty
 *   lawnplan standalone lawn-plan customer: no tier, no turf type, nothing
 *          entered yet — Inches must still render (server hasLawnCare) and
 *          the card must be open with no toggle (2026-08-27 bug)
 *
 * Demo persona is fictional (Jordan Rivera) — never real customer data.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '../index.css';
import '../styles/brand-tokens.css';
import api from '../utils/api';
import { PropertyTab, PortalGlassContext } from '../pages/PortalPage';
import { FONTS, COLORS as B } from '../theme-brand';

const params = new URLSearchParams(window.location.search);
const state = params.get('state') || 'spray';
const planState = params.get('plan') || 'dark';
let planInvalidated = false;
const plan = {
  validThrough: etDateString(addETDays(new Date(), 6)),
  title: planState === 'hold' ? 'Skip your turf watering this week' : planState === 'conditional' ? 'Check the rain before you water' : 'About 30 minutes per turf zone',
  summary: 'Between last week’s rain and your sprinkler schedule, your lawn got about 2.6 inches of water.',
  instruction: planState === 'hold' ? 'Skip your turf watering this week. Follow the plan in your weekly email if your grass begins to show signs of stress.' : planState === 'conditional'
    ? 'If half an inch or more of rain has fallen before your permitted watering day, skip that run. If less has fallen, run one cycle of about 30 minutes per turf zone.'
    : 'Run each turf zone about 30 minutes on your permitted watering day, during your area’s allowed hours.',
  note: 'This preview uses a synthetic watering plan. Your current plan comes from your weekly check-in.',
  restrictionNote: 'Follow your property’s assigned watering day and allowed hours.',
  forecast: '',
  guides: [
    { label: 'Find your sprinkler timer and its guide', url: 'https://www.wavespestcontrol.com/sprinkler-timers/' },
    { label: 'Rain Bird: how to run your timer by hand', url: 'https://www.wavespestcontrol.com/lawn-care/rain-bird-sprinkler-timer-guide/' },
    { label: 'Overwatering vs. underwatering', url: 'https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/' },
    { label: 'Mowing height for your grass type', url: 'https://www.wavespestcontrol.com/lawn-care/mowing-height-by-grass-type/' },
  ],
};
api.getWateringPlan = async () => ({ available: planState !== 'dark', plan: planState === 'empty' || planInvalidated ? null : plan });


const BASE_PREFS = {
  irrigationSystem: true,
  irrigationZones: 3,
  irrigationControllerLocation: 'Left side of garage, gray box',
  irrigationRunMinutes: 20,
  irrigationInchesPerWeek: null,
  wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'],
  irrigationSystemType: ['spray'],
  rainSensor: true,
  irrigationScheduleNotes: 'Each zone runs 20min',
  irrigationKnownIssues: '',
  petCount: 0,
  petsSecuredPlan: '',
  mowingDays: [],
  mowingTimeOfDay: null,
  mowingNotes: '',
  preferredDay: 'monday',
  preferredTime: 'morning',
  neighborhoodGateCode: '',
  propertyGateCode: '',
  garageCode: '',
  lockboxCode: '',
  sideGateAccess: '',
  hoaName: '',
  hoaCompany: '',
};

const STATES = {
  spray: {},
  mixed: { irrigationSystemType: ['spray', 'rotor'] },
  notype: { irrigationSystemType: [] },
  inches: { irrigationInchesPerWeek: 1.25 },
  legacyoff: {},
  legacyoffinches: { irrigationInchesPerWeek: 1.25 },
  daysonly: {
    irrigationZones: null, irrigationControllerLocation: '', irrigationRunMinutes: null,
    irrigationSystemType: [], rainSensor: false, irrigationScheduleNotes: '',
  },
  lawnplan: {
    irrigationZones: null, irrigationControllerLocation: '', irrigationRunMinutes: null,
    wateringDays: [], irrigationSystemType: [], rainSensor: false, irrigationScheduleNotes: '',
  },
};

const PREFS = { ...BASE_PREFS, ...(STATES[state] || {}) };

// The real GET carries the server's lawn eligibility alongside the row.
api.getPropertyPreferences = async () => ({ preferences: PREFS, hasLawnCare: true, irrigationSuppressed: state.startsWith('legacyoff') });
api.updatePropertyPreferences = async (patch) => {
  if (params.get('save') === 'fail') throw new Error('Synthetic save failure');
  planInvalidated = true;
  return { preferences: { ...PREFS, ...patch } };
};
api.getServicePreferences = async () => ({ preferences: {} });


const customer = {
  id: 'cust-demo-1',
  tier: state === 'lawnplan' ? null : 'Silver',
  firstName: 'Jordan',
  lastName: 'Rivera',
  address: { line1: '123 Sample Lane', city: 'Bradenton', state: 'FL', zip: '34205' },
  property: { lawnType: state === 'lawnplan' ? '' : 'St. Augustine', propertySqFt: 6200, bedSqFt: 450 },
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <MemoryRouter>
    <PortalGlassContext.Provider value={true}>
      <div style={{ maxWidth: 920, margin: '24px auto', padding: '0 16px', fontFamily: FONTS.body, color: B.glassNavy }}>
        <PropertyTab customer={customer}
          wateringPlanCustomerId={planState === 'mismatch' ? 'cust-demo-2' : null}
          onOpenWateringProperty={() => { window.location.search = '?plan=run'; }}
        />
      </div>
    </PortalGlassContext.Provider>
  </MemoryRouter>
);
