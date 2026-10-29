// @vitest-environment jsdom
// Visit history counts VISITS — one completed service day — not
// service_records rows: a quarterly pest visit that left a sibling record and
// an unfinished row next to it is still the customer's 2nd visit, not 4th.
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
const year = new Date().getFullYear();
const row = (id, date, status) => ({ id, date: `${year}-${date}`, type: 'Quarterly Pest Control', status, products: [] });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getServices.mockResolvedValue({
    services: [
      row('r4', '07-20', 'in_progress'),
      row('r3', '07-20', 'completed'),
      row('r2', '07-20', 'completed'),
      row('r1', '04-15', 'completed'),
    ],
    total: 4,
  });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
});
afterEach(() => cleanup());

describe('Visit history counts visit days, not records', () => {
  it('shows 2 visits this year and numbers the latest #2 of 2', async () => {
    render(<VisitsTab customer={customer} properties={[{ id: 'cust-1' }]} activePropertyId="cust-1" subTab="completed" onSubTabChange={() => {}} />);
    // Wait for the loaded history: the tile renders (as 0) before it arrives.
    expect(await screen.findByText('#1 of 2')).toBeInTheDocument();
    const label = screen.getByText(`${year} visits`);
    expect(label.previousSibling).toHaveTextContent(/^2$/);
    expect(screen.getAllByText('#2 of 2')).toHaveLength(2);
    expect(screen.getByText('#1 of 2')).toBeInTheDocument();
    expect(screen.queryByText(/of [34]$/)).not.toBeInTheDocument();
  });
});
