// @vitest-environment jsdom
// New-home estimates (Moving PR B1): a move estimate is previewed with the setup
// fee waived in every mode. A new one sends options.moveId; a reopened one sends
// options.moveEstimateId; an ordinary estimate sends neither.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

const { openSend } = vi.hoisted(() => ({ openSend: vi.fn() }));
vi.mock('../../components/admin/EstimateSendDialog', () => ({ useEstimateSend: () => openSend }));

const result = { recurring: { tier: 'Bronze', grandTotal: 50, annualAfterDiscount: 600, services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, annual: 600 }] }, oneTime: { total: 0, items: [] }, results: {}, totals: { year2mo: 50, year1: 600 } };
const request = { profile: { homeSqFt: 2000, lotSqFt: 6000 }, selectedServices: ['PEST'], options: { pestTier: 'quarterly' } };
const editSource = { id: 'est-move', status: 'draft', editable: true, editVersion: 'v1', customerId: 'cust-1', customerName: 'QA Contact', customerPhone: '+19415550100', customerEmail: 'qa@example.invalid', address: '100 Example Court', propertyId: 'qa-property', inputs: { svcPest: true, homeSqFt: '2000', lotSqFt: '6000' }, engineRequest: request, result, token: 'tok' };
const moveSource = {
  move: { id: 'move-1', address: '123 Palm Ave, Venice, FL 34285', moveOutDate: '2026-11-01', moveInDate: '2026-11-14' },
  customer: { id: 'cust-1', name: 'QA Contact', phone: '+19415550100', email: 'qa@example.invalid' },
  isRecurringCustomer: false,
  source: { estimateId: 'est-old', inputs: { svcPest: true, homeSqFt: '2000' } },
  planServices: [], leftOut: [],
};
const response = (data, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data, clone() { return this; }, text: async () => JSON.stringify(data) });

let currentEdit;
let calculateBodies;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'fixture');
  calculateBodies = [];
  currentEdit = structuredClone(editSource);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
    const path = String(url);
    if (path.endsWith('/edit-source')) return response(currentEdit);
    if (path.endsWith('/estimate-source')) return response(moveSource);
    if (path.endsWith('/calculate-estimate')) {
      calculateBodies.push(JSON.parse(opts.body));
      return response(structuredClone(result));
    }
    if (path.includes('/discounts')) return response([]);
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const renderEditor = (props) => render(<MemoryRouter><EstimateToolViewV2 {...props} /></MemoryRouter>);
const generate = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^(Generate Estimate|Regenerate)$/ }));
  await waitFor(() => expect(calculateBodies.length).toBeGreaterThan(0));
  return calculateBodies[calculateBodies.length - 1].options || calculateBodies[calculateBodies.length - 1];
};

describe('new-home estimate setup-fee waiver in the builder', () => {
  it('a reopened move estimate sends moveEstimateId (never moveId) and shows the waiver banner', async () => {
    currentEdit = { ...editSource, moveEstimate: { moveId: 'move-1', moveOutDate: '2026-11-01', moveInDate: '2026-11-14' } };
    renderEditor({ editEstimateId: 'est-move' });
    await screen.findByDisplayValue('QA Contact');
    const banner = await screen.findByTestId('move-estimate-edit-banner');
    expect(banner).toHaveTextContent('New-home estimate for a move. The $99 setup fee is waived.');
    expect(banner).toHaveTextContent('Move-in Nov 14, 2026');
    const options = await generate();
    expect(options.moveEstimateId).toBe('est-move');
    expect(options).not.toHaveProperty('moveId');
    expect(options.existingCustomerId).toBe('cust-1');
  });

  it('an ordinary reopened estimate sends neither field and shows no banner', async () => {
    renderEditor({ editEstimateId: 'est-move' });
    await screen.findByDisplayValue('QA Contact');
    expect(screen.queryByTestId('move-estimate-edit-banner')).toBeNull();
    const options = await generate();
    expect(options).not.toHaveProperty('moveEstimateId');
    expect(options).not.toHaveProperty('moveId');
  });

  it('a new new-home estimate sends moveId (never moveEstimateId) and the banner dates read as calendar dates', async () => {
    renderEditor({ moveId: 'move-1', initialCustomerId: 'cust-1' });
    const banner = await screen.findByTestId('move-estimate-banner');
    await waitFor(() => expect(banner).toHaveTextContent('Move-out Nov 1, 2026 · Move-in Nov 14, 2026'));
    await screen.findByDisplayValue('123 Palm Ave, Venice, FL 34285');
    // The new house is measured again: the seed leaves the size blank.
    expect(screen.getByLabelText('Home Sq Ft')).toHaveValue(null);
    fireEvent.change(screen.getByLabelText('Home Sq Ft'), { target: { value: '2000' } });
    const options = await generate();
    expect(options.moveId).toBe('move-1');
    expect(options).not.toHaveProperty('moveEstimateId');
  });

  it('a move that fails to load keeps Generate off and offers a retry or a normal estimate, never a silent ordinary one', async () => {
    let attempts = 0;
    fetch.mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/estimate-source')) {
        attempts += 1;
        return attempts === 1 ? response({ error: 'Could not load the move for an estimate' }, 500) : response(moveSource);
      }
      if (path.includes('/discounts')) return response([]);
      return response({});
    });
    const onStartNew = vi.fn();
    renderEditor({ moveId: 'move-1', initialCustomerId: 'cust-1', onStartNew });
    const banner = await screen.findByTestId('move-estimate-banner');
    await waitFor(() => expect(banner).toHaveTextContent('Could not load the move for an estimate'));
    expect(screen.getByRole('button', { name: /^(Generate Estimate|Regenerate)$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start a normal estimate instead' }));
    expect(onStartNew).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByDisplayValue('123 Palm Ave, Venice, FL 34285');
    expect(attempts).toBe(2);
    expect(screen.getByRole('button', { name: /^(Generate Estimate|Regenerate)$/ })).not.toBeDisabled();
  });
});
