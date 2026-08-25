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
};

const PREFS = { ...BASE_PREFS, ...(STATES[state] || {}) };

api.getPropertyPreferences = async () => ({ preferences: PREFS });
api.updatePropertyPreferences = async (patch) => ({ preferences: { ...PREFS, ...patch } });

const customer = {
  id: 'cust-demo-1',
  tier: 'Silver',
  firstName: 'Jordan',
  lastName: 'Rivera',
  address: { line1: '123 Sample Lane', city: 'Bradenton', state: 'FL', zip: '34205' },
  property: { lawnType: 'St. Augustine', propertySqFt: 6200, bedSqFt: 450 },
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
