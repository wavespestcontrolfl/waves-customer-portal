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
api.updatePropertyPreferences = async (patch) => ({ preferences: { ...PREFS, ...patch } });

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
        <PropertyTab customer={customer} />
      </div>
    </PortalGlassContext.Provider>
  </MemoryRouter>
);
