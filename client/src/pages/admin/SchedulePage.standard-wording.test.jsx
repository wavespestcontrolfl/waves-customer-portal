// @vitest-environment jsdom
// The standard wording on the office Complete Service form
// (GATE_STANDARD_WORDING_PREVIEW, owner mockup approval 2026-10-03): while a
// typed visit's record says nothing was found (the rule that greys out
// Generate AI report), the form asks the server for the exact sentences the
// customer's report keeps and shows them read-only; a record with activity
// shows none, and nor does a server that answers unavailable.
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel, standardWordingProductRows } from './SchedulePage';

// The real served termite bait station form.
const BAIT_SCHEMA = {"type":"termite_bait_station","label":"Termite Bait Station Inspection","schemaVersion":2,"copyMapVersion":4,"fields":[{"key":"total_stations","label":"Total stations on property","type":"count","section":"Station inspection","options":null,"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"stations_checked","label":"Stations checked","type":"count","section":"Station inspection","options":null,"placeholder":null,"required":true,"requiredUnless":null,"internal":false,"detail":false,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"stations_inaccessible","label":"Stations inaccessible","type":"count","section":"Station inspection","options":null,"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"stations_with_activity","label":"Stations with termite activity","type":"count","section":"Station inspection","options":null,"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":false,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"termite_activity","label":"Termite activity","type":"select","section":"Termite activity","options":["None observed","Active termites present","Previous feeding noted"],"placeholder":null,"required":true,"requiredUnless":null,"internal":false,"detail":false,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"activity_signs","label":"Activity signs","type":"chips","section":"Termite activity","options":["Live termites in station","Mud tubing in station","Bait feeding","Previous feeding evidence","Favorable moisture / soil conditions"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"active_station_location","label":"Active station number / location","type":"text","section":"Termite activity","options":null,"placeholder":"Station #7, rear exterior wall…","required":false,"requiredUnless":null,"internal":false,"detail":false,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"bait_consumption","label":"Bait consumption","type":"select","section":"Bait condition","options":["None — bait intact","Light feeding","Moderate feeding","Heavy feeding"],"placeholder":null,"required":true,"requiredUnless":null,"internal":false,"detail":false,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"bait_actions","label":"Bait service performed","type":"chips","section":"Bait condition","options":["Bait replaced","Bait added","Monitor cartridge replaced","Station cleaned"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"bait_issues","label":"Bait condition issues","type":"chips","section":"Bait condition","options":["Excess moisture in station","Mold / deterioration"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"station_issues","label":"Station condition issues","type":"chips","section":"Station condition","options":["Cap damaged","Station missing","Station flooded","Station buried","Station obstructed","Mower damage","Needs replacement"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"station_actions","label":"Station service performed","type":"chips","section":"Station condition","options":["Obstruction removed","Re-secured","Relocated","Replaced"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"conducive_conditions","label":"Conducive conditions","type":"chips","section":"Conducive conditions","options":["Wood-to-ground contact","Mulch against foundation","Moisture near foundation","Irrigation hitting structure","Downspout drainage issues","Stacked firewood near structure","Tree roots / stumps","Soil grade above slab","Dense vegetation","Leaking hose bib"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false},{"key":"customer_recommendations","label":"Customer recommendations","type":"chips","section":"Recommendations","options":["Keep stations visible and accessible","Unlock gate on service day","Do not cover stations with mulch or rock","Do not remove station caps","Pull mulch back from foundation","Reduce moisture near foundation","Move firewood away from structure","Trim vegetation off walls","Correct irrigation spraying the structure"],"placeholder":null,"required":false,"requiredUnless":null,"internal":false,"detail":true,"autoFilled":false,"pesticideOnly":false,"tapOnly":false}],"photoCategories":["station","activity","foundation","conducive_condition","exterior","other"],"requiredFields":["stations_checked","termite_activity","bait_consumption"],"activity":{"indicatorKey":"termite_activity","label":"Termite Activity","deriveField":"termite_activity","deriveScores":{"None observed":0,"Previous feeding noted":1,"Active termites present":4},"techScoreLabels":{"0":"None","1":"Very low","2":"Low","3":"Moderate","4":"High","5":"Severe"}}};
const VISIT = {
  id: 'std-visit', customerId: 'std-customer', customerName: 'Synthetic Customer',
  serviceType: 'Termite Monitoring', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 90,
  completionProfile: { serviceKey: 'termite_monitoring', findingsType: 'termite_bait_station' },
  findingsSchema: BAIT_SCHEMA,
};
const WORDING = {
  available: true,
  headline: 'No termite activity was observed in the accessible bait stations today.',
  body: 'We inspected 14 termite bait stations around the exterior perimeter today.',
};

let calls;
let answer;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  calls = [];
  answer = () => WORDING;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (String(url).includes('/standard-wording')) {
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => answer() };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openForm(service = VISIT) {
  await act(async () => {
    render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={vi.fn().mockResolvedValue({})} />);
  });
  await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy(), { timeout: 10000 });
}
const field = (key) => document.getElementById(`typed-finding-termite_bait_station-${key}`);
const generate = () => screen.getAllByRole('button', { name: /generate ai/i })[0];
const set = (key, value) => fireEvent.change(field(key), { target: { value } });

describe('standardWordingProductRows', () => {
  it('sends each product\'s id, method and area as the completion submits them', () => {
    expect(standardWordingProductRows([
      { productId: 'p1', applicationMethod: 'bait_placement' },
      { productId: 'p2', applicationMethod: 'bait_placement', applicationArea: 'Pantry' },
    ], 'German Roach Cleanout', ['Kitchen'])).toEqual([
      { productId: 'p1', applicationMethod: 'bait_placement', applicationArea: 'Kitchen' },
      { productId: 'p2', applicationMethod: 'bait_placement', applicationArea: 'Pantry' },
    ]);
    // More than one area serviced: no area is assumed.
    expect(standardWordingProductRows([{ productId: 'p1', applicationMethod: 'bait_placement' }], 'German Roach Cleanout', ['Kitchen', 'Garage'])[0].applicationArea).toBeNull();
  });
});

describe('the standard wording card', () => {
  it('a nothing-found record shows the exact sentences the customer will read', async () => {
    await openForm();
    set('stations_checked', '14');
    set('termite_activity', 'None observed');
    set('bait_consumption', 'None — bait intact');
    const card = await screen.findByTestId('standard-wording');
    expect(card.textContent).toContain('Report the customer will see · standard wording');
    expect(card.textContent).toContain(WORDING.headline);
    expect(card.textContent).toContain(WORDING.body);
    expect(card.textContent).toContain('Nothing was found, so the report uses its standard wording instead of a write-up.');
    // Generate AI report is off, and looks off (the approved mockup).
    expect(generate().disabled).toBe(true);
    expect(generate().style.opacity).toBe('0.45');
    const last = calls.at(-1);
    expect(last.values).toMatchObject({ stations_checked: '14', termite_activity: 'None observed', bait_consumption: 'None — bait intact' });
    expect(last.activityScore).toBe(0);
    expect(last.backfill).toBe(false);
    expect(last.products).toEqual([]);
  });

  it('an office backdated closeout sends it, so the wording is dated as the closeout is', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
    await openForm({ ...VISIT, scheduledDate: '2020-01-06' });
    set('termite_activity', 'None observed');
    await screen.findByTestId('standard-wording');
    expect(calls.at(-1).backfill).toBe(true);
  });

  it('activity found: the card goes away and the form stops asking', async () => {
    await openForm();
    set('termite_activity', 'None observed');
    await screen.findByTestId('standard-wording');
    const asked = calls.length;
    set('termite_activity', 'Active termites present');
    await waitFor(() => expect(screen.queryByTestId('standard-wording')).toBeNull());
    expect(generate().disabled).toBe(false);
    expect(generate().style.opacity).toBe('1');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.length).toBe(asked);
  });

  it('a server that answers unavailable (the gate off) shows no card', async () => {
    answer = () => ({ available: false });
    await openForm();
    set('termite_activity', 'None observed');
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('standard-wording')).toBeNull();
  });

  it('an untyped visit never asks', async () => {
    await openForm({ ...VISIT, completionProfile: null, findingsSchema: null, serviceType: 'Quarterly Pest Control' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls).toEqual([]);
    expect(screen.queryByTestId('standard-wording')).toBeNull();
  });
});
