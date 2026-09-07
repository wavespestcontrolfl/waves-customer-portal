// @vitest-environment jsdom
// Sortable column headers are real buttons and the <th> announces the sort
// (UI audit 2026-09-07, TL-02).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ScheduleListView from './ScheduleListView';

const rows = ['Alpha', 'Beta'].map((name, i) => ({ id: `qa-${i}`, customerName: `Synthetic ${name}`, scheduledDate: '2026-09-09', status: 'confirmed' }));
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ services: rows, total: rows.length }) }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('exposes each sortable header as a button and reflects the sort through aria-sort', async () => {
  render(<ScheduleListView />);
  await screen.findByText('Synthetic Alpha');
  const customer = screen.getByRole('button', { name: 'Customer' });
  const th = customer.closest('th');
  expect(th).toHaveAttribute('aria-sort', 'none');
  customer.focus();
  expect(customer).toHaveFocus();
  fireEvent.click(customer);
  expect(th).toHaveAttribute('aria-sort', 'ascending');
  fireEvent.click(customer);
  expect(th).toHaveAttribute('aria-sort', 'descending');
  // The other sortable columns stay 'none' while Customer owns the sort.
  expect(screen.getByRole('button', { name: 'Service' }).closest('th')).toHaveAttribute('aria-sort', 'none');
});
