// @vitest-environment jsdom
// The Completed sub-tab reads /services customer-wide; under the saved-property
// MODEL the disclosure shows whenever the list is saved-shaped — even with ONE
// active entry, because a profile whose other houses were retired still lists
// their visits and reports here (GitHub codex #4207 r8 P2).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { VisitsTab } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', tier: 'Silver', property: {} };
const savedOnly = [{ id: 'cust-1:pa', key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa', isPrimaryProperty: true, isPrimaryProfile: true, address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } }];
const profileShaped = [{ id: 'cust-1' }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getServices.mockResolvedValue({ services: [] });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
});
afterEach(() => cleanup());

describe('Completed history disclosure under the saved-property model', () => {
  it('shows with a ONE-entry saved list (other houses may have been retired)', async () => {
    render(<VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" subTab="completed" onSubTabChange={() => {}} />);
    expect(await screen.findByTestId('completed-property-scope-notice')).toBeInTheDocument();
  });
  it('stays hidden on a profile-shaped list (gate off)', async () => {
    render(<VisitsTab customer={customer} properties={profileShaped} activePropertyId="cust-1" subTab="completed" onSubTabChange={() => {}} />);
    expect(screen.queryByTestId('completed-property-scope-notice')).not.toBeInTheDocument();
  });
  // App property scope (PR 4): the completed list is the selected house's —
  // read with propertyScoped=1 under the saved scope, echo-checked like the
  // schedule; a page served under another house withholds and re-reads.
  it('reads history scoped to the selected house and withholds a mismatched echo', async () => {
    const refresh = vi.fn();
    api.getServices.mockResolvedValue({ services: [{ id: 's1', date: '2026-09-01', type: 'Quarterly Pest Control' }], total: 1, propertyScope: { enabled: true, propertyId: 'pb', closed: false } });
    render(<VisitsTab customer={customer} properties={savedOnly} activePropertyId="cust-1:pa" selectedProperty={{ key: 'cust-1:pa', customerId: 'cust-1', propertyId: 'pa' }} subTab="completed" onSubTabChange={() => {}} onSavedScopeUnavailable={refresh} />);
    await waitFor(() => expect(api.getServices).toHaveBeenCalledWith({ limit: 100, propertyScoped: 1 }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText('Quarterly Pest Control')).not.toBeInTheDocument();
  });
  it('a profile-shaped list reads history customer-wide (no propertyScoped)', async () => {
    api.getServices.mockResolvedValue({ services: [], total: 0 });
    render(<VisitsTab customer={customer} properties={profileShaped} activePropertyId="cust-1" subTab="completed" onSubTabChange={() => {}} />);
    await waitFor(() => expect(api.getServices).toHaveBeenCalledWith({ limit: 100 }));
  });
});
