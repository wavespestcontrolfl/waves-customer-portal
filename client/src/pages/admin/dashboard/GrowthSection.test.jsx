// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import GrowthSection from './sections/GrowthSection';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const data = { kpis: { revenueMTD: 123, activeCustomers: 10, newCustomersThisMonth: 1 }, mrr: 456, revenueChart: { daily: [] } };
const props = {
  funnel: { funnel: {}, rates: {} },
  capAlloc: { channels: [] },
  kpis: { sales: { conversion: 50, booked: 1, leads: 2 }, membershipsSold: 3 },
  salesCapture: { captured: 100, missed: 100, captureRate: 50, wonCount: 1, lostCount: 1 },
};
const mount = (extra) => render(<MemoryRouter><GrowthSection {...props} {...extra} /></MemoryRouter>);

it('keeps independent growth panels usable when the main feed fails', () => {
  const retry = vi.fn();
  mount({ data: null, loadError: new Error('offline'), onRetry: retry });
  expect(screen.getByRole('alert')).toHaveTextContent('Growth data could not be loaded');
  for (const label of ['Sales capture', 'Lead → Booked', 'Marketing attribution', 'Estimate funnel']) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
  expect(screen.queryByText('Revenue MTD')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('labels retained growth and channel data as stale without removing it', () => {
  const retry = vi.fn();
  const error = new Error('offline');
  mount({ data, loadError: error, onRetry: retry,
    channelRoi: { sources: [{ sourceKey: 'paid', source: 'Paid search', customers: 1, jobs: 1, allInSpend: 20, revenue: 100 }] }, channelRoiError: error,
    leadFunnel: { sources: [{ sourceKey: 'paid', source: 'Paid search', leads: 3, completed: 1 }], totals: { leads: 3, completed: 1 } }, leadFunnelError: error,
  });
  expect(screen.getByText('Revenue MTD')).toBeInTheDocument();
  expect(screen.getAllByText('Paid search')).toHaveLength(2);
  const alerts = screen.getAllByRole('alert');
  expect(alerts).toHaveLength(3);
  for (const alert of alerts) expect(alert).toHaveTextContent('Showing last loaded data');
  for (const button of screen.getAllByRole('button', { name: 'Try again' })) fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(3);
});
