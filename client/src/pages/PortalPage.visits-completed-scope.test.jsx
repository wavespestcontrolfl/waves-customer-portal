// @vitest-environment jsdom
// The Completed sub-tab reads /services customer-wide; under the saved-property
// MODEL the disclosure shows whenever the list is saved-shaped — even with ONE
// active entry, because a profile whose other houses were retired still lists
// their visits and reports here (GitHub codex #4207 r8 P2).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    expect(await screen.findByTestId('completed-profile-wide-notice')).toBeInTheDocument();
  });
  it('stays hidden on a profile-shaped list (gate off)', async () => {
    render(<VisitsTab customer={customer} properties={profileShaped} activePropertyId="cust-1" subTab="completed" onSubTabChange={() => {}} />);
    expect(screen.queryByTestId('completed-profile-wide-notice')).not.toBeInTheDocument();
  });
});
