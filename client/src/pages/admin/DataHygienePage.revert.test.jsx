// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import DataHygienePage from './DataHygienePage';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('keeps a failed revert visible inside the dialog and allows retry or cancellation', async () => {
  let fail = true;
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      if (fail) throw Object.assign(new Error('Conflict'), { status: 409 });
      return {};
    }
    if (url.includes('/metrics')) return {};
    return { proposals: [{ id: 'proposal-fixture', status: 'approved', field: 'property_notes', proposedValue: 'Fixture value', customer: { name: 'Fixture customer' } }] };
  });
  render(<MemoryRouter><DataHygienePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Revert', exact: true }));
  let dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(adminFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Revert', exact: true }));
  dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revert change' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cannot revert because the live value changed after approval.');
  expect(within(dialog).getByRole('button', { name: 'Revert change' })).toBeEnabled();
  fail = false;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revert change' }));
  expect(await screen.findByText('Proposal reverted.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(adminFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toEqual([
    ['/admin/data-hygiene/proposals/proposal-fixture/revert', { method: 'POST', body: '{}' }],
    ['/admin/data-hygiene/proposals/proposal-fixture/revert', { method: 'POST', body: '{}' }],
  ]);
});
