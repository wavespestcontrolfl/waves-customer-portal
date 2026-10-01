// @vitest-environment jsdom
// Lawn re-service Fast Complete: suggestion tiles that start off, amounts only
// from last time, Complete gated on its required taps, and the /complete body
// contract (typed one_time_lawn_treatment findings, spot-treatment rows, the
// full form's customer-text defaults, no customerRecapMode).
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnReserviceSheet, {
  LAWN_CONDITION_OPTIONS, TURF_ISSUE_OPTIONS, WEED_PRESSURE_OPTIONS,
} from './FastCompleteLawnReserviceSheet';
import { PROJECT_TYPES } from '../../../../server/services/project-types.js';

// Each test mounts the whole sheet and taps through it: slow on a busy runner.
vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CATALOG = [
  { id: 'celsius', name: 'Celsius WG', category: 'herbicide', formulation: 'WG' },
  { id: 'talak', name: 'Talak 7.9%', category: 'insecticide', formulation: 'SC' },
  { id: 'headway', name: 'Headway G', category: 'fungicide', formulation: 'granular' },
  { id: 'empty', name: 'Empty Jug Surfactant', category: 'adjuvant', inventory_unit: 'fl_oz', inventory_on_hand: '0.0000' },
];

const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceKey: 'lawn_re_service',
  serviceType: 'Lawn Care Re-Service', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-lawn', customerName: 'Pat Jones', serviceType: 'Lawn Re-Service', address: '123 Main St', timeLabel: '2:00 PM' };

// The server's shapes (server/services/lawn-reservice-fast-context.js).
const CONTEXT = {
  enabled: true,
  eligible: true,
  reason: null,
  service: VISIT,
  customerRequest: { text: 'Weeds are back along the driveway.', pests: ['Weeds'] },
  products: CATALOG,
  lastVisit: {
    serviceRecordId: 'rec-1',
    serviceDate: '2026-09-20',
    serviceType: 'Lawn Care',
    products: [
      { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment' },
      { productId: 'talak', name: 'Talak 7.9%', totalAmount: 4, amountUnit: 'fl_oz', method: 'broadcast_spray' },
      { productId: 'headway', name: 'Headway G', totalAmount: null, amountUnit: null, method: null },
    ],
  },
};

function makeRequest({ context = CONTEXT, completeError = null } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/lawn-reservice/fast-context')) {
      // An array answers each read in turn (the last one repeats).
      const answer = Array.isArray(context) ? (context.length > 1 ? context.shift() : context[0]) : context;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (path.endsWith('/complete')) {
      if (completeError) throw completeError;
      return { success: true };
    }
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request = makeRequest(), props = {}) {
  render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} {...props} />);
  await screen.findByRole('button', { name: /^Celsius WG/ });
  return request;
}

const tile = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const editorFor = (name) => screen.getByRole('group', { name });
const enterAmount = (name, amount) => fireEvent.change(within(editorFor(name)).getByLabelText('How much?'), { target: { value: String(amount) } });
const completeButton = () => screen.getByRole('button', { name: 'Complete lawn re-service' });
const completeBody = async (request) => {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
};

// Celsius on with last time's amount; the three required taps set.
async function readyVisit(request) {
  await openSheet(request);
  fireEvent.click(tile('Celsius WG'));
  fireEvent.click(screen.getByRole('button', { name: 'Dollarweed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
}

describe('the typed form\'s option lists', () => {
  test('match server/services/project-types.js one_time_lawn_treatment exactly (the server rejects anything else)', () => {
    const fields = Object.fromEntries(PROJECT_TYPES.one_time_lawn_treatment.findingsFields.map((f) => [f.key, f]));
    expect(TURF_ISSUE_OPTIONS).toEqual(fields.turf_issues.options);
    expect(WEED_PRESSURE_OPTIONS).toEqual(fields.weed_pressure.options);
    expect(LAWN_CONDITION_OPTIONS).toEqual(fields.lawn_condition.options);
    expect(TURF_ISSUE_OPTIONS.some((option) => option.includes(','))).toBe(false);
  });
});

describe('products', () => {
  test('the last lawn visit\'s products are suggestions that start off, and nothing is assumed applied', async () => {
    await openSheet();
    for (const name of ['Celsius WG', 'Talak 7.9%', 'Headway G']) {
      expect(tile(name).getAttribute('aria-pressed')).toBe('false');
    }
    expect(screen.queryByRole('group', { name: 'Celsius WG' })).toBeNull();
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText('Select at least one product.')).toBeTruthy();
  });

  test('an amount fills only from last time, labeled; everything else is blank and required', async () => {
    await openSheet();
    fireEvent.click(tile('Celsius WG'));
    const celsius = editorFor('Celsius WG');
    expect(within(celsius).getByLabelText('How much?').value).toBe('1.5');
    expect(within(within(celsius).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'oz' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(celsius).getByText('last time')).toBeTruthy();
    // Only one method: no chips, never a measured area.
    expect(within(celsius).getByText('How: Spot treatment')).toBeTruthy();

    fireEvent.click(tile('Talak 7.9%'));
    const talak = editorFor('Talak 7.9%');
    expect(within(talak).getByLabelText('How much?').value).toBe('4');
    expect(within(within(talak).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'fl oz' }).getAttribute('aria-pressed')).toBe('true');

    // A last-visit row that recorded no amount: blank.
    fireEvent.click(tile('Headway G'));
    const headway = editorFor('Headway G');
    expect(within(headway).getByLabelText('How much?').value).toBe('');
    expect(within(headway).queryByText('last time')).toBeNull();

    // Typing over last time's amount clears the label.
    fireEvent.change(within(celsius).getByLabelText('How much?'), { target: { value: '2' } });
    expect(within(editorFor('Celsius WG')).queryByText('last time')).toBeNull();
  });

  test('a blank amount blocks Complete and names the product', async () => {
    const request = makeRequest();
    await readyVisit(request);
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(tile('Headway G'));
    expect(screen.getByText('Enter the amount for Headway G.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    enterAmount('Headway G', 0);
    expect(completeButton().disabled).toBe(true);
    enterAmount('Headway G', 6);
    expect(completeButton().disabled).toBe(false);
  });

  test('"+ Other product" adds any catalog product, blank, and it can be removed', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    const picker = screen.getByRole('dialog', { name: 'Add a product' });
    // A last-visit product already on the sheet is not offered again.
    fireEvent.click(within(picker).getByRole('button', { name: /Empty Jug Surfactant/ }));
    const editor = editorFor('Empty Jug Surfactant');
    expect(within(editor).getByLabelText('How much?').value).toBe('');
    expect(within(editor).getByText('How: Spot treatment')).toBeTruthy();
    // A tracked stock at zero holds Complete before the server refuses it.
    enterAmount('Empty Jug Surfactant', 2);
    expect(screen.getByText('Empty Jug Surfactant shows 0 in stock. Update inventory, then tap Check stock.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Empty Jug Surfactant' })).toBeNull();
    expect(completeButton().disabled).toBe(false);
  });

  test('a product at 0 stock holds Complete until Check stock reads it restocked', async () => {
    const restocked = { ...CONTEXT, products: CATALOG.map((p) => (p.id === 'empty' ? { ...p, inventory_on_hand: 64 } : p)) };
    const request = makeRequest({ context: [CONTEXT, restocked] });
    await readyVisit(request);
    fireEvent.click(screen.getByRole('button', { name: '+ Other product' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Add a product' })).getByRole('button', { name: /Empty Jug Surfactant/ }));
    enterAmount('Empty Jug Surfactant', 2);
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check stock' }));
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Check stock' })).toBeNull();
  });

  test('a property with no earlier lawn visit starts with no tiles and asks the tech to add what they applied', async () => {
    const request = makeRequest({ context: { ...CONTEXT, lastVisit: null } });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('No earlier lawn visit products on record. Add what you applied.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Other product' })).toBeTruthy();
  });
});

describe('what the customer said', () => {
  test('the booking words and chips lead the sheet when present', async () => {
    await openSheet();
    expect(screen.getByRole('heading', { name: 'They said' })).toBeTruthy();
    expect(screen.getByText('“Weeds are back along the driveway.”')).toBeTruthy();
    expect(screen.getByText('Weeds')).toBeTruthy();
  });

  test('no request, no section', async () => {
    const request = makeRequest({ context: { ...CONTEXT, customerRequest: null } });
    await openSheet(request);
    expect(screen.queryByRole('heading', { name: 'They said' })).toBeNull();
  });

  test('nothing is pre-selected in Treating for: the booking chips never map to a typed option', async () => {
    await openSheet();
    for (const label of TURF_ISSUE_OPTIONS) {
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false');
    }
  });
});

describe('required taps', () => {
  test('Complete waits for a product with an amount, one treating-for chip, pressure and condition, in that order', async () => {
    await openSheet();
    expect(screen.getByText('Select at least one product.')).toBeTruthy();
    fireEvent.click(tile('Celsius WG'));
    expect(screen.getByText('Select what you treated for.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sedge' }));
    expect(screen.getByText('Select the weed pressure.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.getByText('Select the lawn condition.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Good' }));
    expect(completeButton().disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('treating-for chips toggle off, and pressure and condition are one tap each', async () => {
    await openSheet();
    const chip = screen.getByRole('button', { name: 'Crabgrass' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Heavy' }));
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Heavy' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('the sheet offers no photos, scores, follow-up or home / not-home taps', async () => {
    await openSheet();
    expect(screen.queryByText(/photo/i)).toBeNull();
    expect(screen.queryByText(/follow-up/i)).toBeNull();
    expect(screen.queryByText(/not home/i)).toBeNull();
  });
});

describe('the /complete body', () => {
  test('is typed one_time_lawn_treatment findings with spot-treatment rows and the full form\'s customer-text defaults', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Talak 7.9%'));
    fireEvent.click(screen.getByRole('button', { name: 'Chinch bug damage' }));
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: '  Spot-treated the driveway edge.  ' } });
    const body = await completeBody(request);

    expect(body).toEqual({
      idempotencyKey: expect.any(String),
      visitOutcome: 'completed',
      // The live visit identity the server echo-checks (recapVisitIdentity).
      expectedVisit: {
        customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceType: 'Lawn Care Re-Service',
        scheduledDate: '2026-10-04', address: { line1: '123 Main St' },
      },
      products: [
        { productId: 'celsius', applicationMethod: 'spot_treatment', totalAmount: 1.5, amountUnit: 'oz', targets: [] },
        { productId: 'talak', applicationMethod: 'spot_treatment', totalAmount: 4, amountUnit: 'fl_oz', targets: [] },
      ],
      structuredFindings: {
        type: 'one_time_lawn_treatment',
        // Chips in the form's own option order, comma-joined.
        values: { lawn_condition: 'Fair', weed_pressure: 'Moderate', turf_issues: 'Chinch bug damage, Dollarweed' },
      },
      technicianNotes: 'Spot-treated the driveway edge.',
      sendCompletionSms: true,
      requestReview: false,
      includePayLink: true,
    });
    expect(body).not.toHaveProperty('customerRecapMode');
    expect(body).not.toHaveProperty('completionPhotos');
    expect(body.structuredFindings.values).not.toHaveProperty('work_completed');
    expect(new Set(body.products.map((p) => p.applicationMethod))).toEqual(new Set(['spot_treatment']));
  });

  test('a product left off the sheet is not sent, and an empty note is an empty string', async () => {
    const request = makeRequest();
    await readyVisit(request);
    const body = await completeBody(request);
    expect(body.products.map((p) => p.productId)).toEqual(['celsius']);
    expect(body.technicianNotes).toBe('');
  });

  test('a tsp amount goes to the server as fl oz, never mL', async () => {
    const request = makeRequest();
    await readyVisit(request);
    fireEvent.click(tile('Talak 7.9%'));
    const editor = editorFor('Talak 7.9%');
    fireEvent.click(within(within(editor).getByRole('group', { name: 'Unit' })).getByRole('button', { name: 'tsp' }));
    fireEvent.change(within(editor).getByLabelText('How much?'), { target: { value: '3' } });
    const body = await completeBody(request);
    expect(body.products[1]).toMatchObject({ productId: 'talak', totalAmount: 0.5, amountUnit: 'fl_oz', applicationMethod: 'spot_treatment' });
  });

  test('after Complete the saved view shows the summary, and Next stop closes the sheet', async () => {
    const onCompleted = vi.fn();
    const request = makeRequest();
    await openSheet(request, { onCompleted });
    fireEvent.click(tile('Celsius WG'));
    fireEvent.click(screen.getByRole('button', { name: 'Dollarweed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
    fireEvent.click(completeButton());
    expect(await screen.findByText('Celsius WG · Dollarweed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lawn re-service complete' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next stop' }));
    expect(onCompleted).toHaveBeenCalled();
  });
});

describe('full form and blocked visits', () => {
  test('Full form calls onFullForm', async () => {
    const onFullForm = vi.fn();
    await openSheet(makeRequest(), { onFullForm });
    fireEvent.click(screen.getByRole('button', { name: 'Full form' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
  });

  test('a gate that is off (404) says the visit needs the full form, and closing asks for a refresh', async () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    const onClose = vi.fn();
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={makeRequest({ context: err })} onClose={onClose} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledWith({ refresh: true });
  });

  test('a visit that is no longer a lawn re-service (409) needs the full form', async () => {
    const err = Object.assign(new Error('not_lawn_re_service'), { status: 409 });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={makeRequest({ context: err })} onClose={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
  });

  test('an ineligible visit (a grouped stop) needs the full form', async () => {
    const request = makeRequest({ context: { enabled: true, eligible: false, reason: 'grouped_visit', service: VISIT } });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('This visit needs the full form.')).toBeTruthy();
  });

  test('a stale schedule row (the visit moved to another day) is refused', async () => {
    const request = makeRequest({ context: { ...CONTEXT, service: { ...VISIT, scheduledDate: '2026-10-09' } } });
    render(<FastCompleteLawnReserviceSheet service={{ ...SERVICE, routedScheduledDate: '2026-10-04' }} request={request} onClose={() => {}} />);
    expect(await screen.findByText('This visit changed since your schedule loaded. Close and reopen it from the schedule.')).toBeTruthy();
  });

  test('a failed catalog read offers Try again instead of the full form', async () => {
    const request = makeRequest({ context: [{ enabled: true, eligible: false, reason: 'catalog_unavailable', service: VISIT }, CONTEXT] });
    render(<FastCompleteLawnReserviceSheet service={SERVICE} request={request} onClose={() => {}} />);
    expect(await screen.findByText('Couldn’t load this visit’s products. Try again.')).toBeTruthy();
    expect(screen.queryByText('This visit needs the full form.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Celsius WG/ })).toBeTruthy();
  });
});
