// @vitest-environment jsdom
// A portal ticket filed under a saved (secondary) property names that house
// where staff mark it handled — two identical requests from two houses must
// be distinguishable here (uncapped codex #4207 r2a P1).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows = { value: [] };
const requestPhotos = { value: [], unavailableCount: 0, error: '' };
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async (url) => {
    if (url.endsWith('/photos') && requestPhotos.error) {
      return { ok: false, status: 503, json: async () => ({ error: requestPhotos.error }) };
    }
    return {
      ok: true,
      json: async () => (url.endsWith('/photos')
        ? { photos: requestPhotos.value, unavailableCount: requestPhotos.unavailableCount }
        : { requests: rows.value }),
    };
  }),
}));

import { adminFetch } from '../../lib/adminFetch';
import CustomerRequestsPanel from './CustomerRequestsPanel';

afterEach(() => cleanup());
beforeEach(() => {
  rows.value = [];
  requestPhotos.value = [];
  requestPhotos.unavailableCount = 0;
  requestPhotos.error = '';
  adminFetch.mockClear();
});

describe('CustomerRequestsPanel property line', () => {
  it('names the saved property a ticket was filed under, and stays silent for property-less tickets', async () => {
    rows.value = [
      { id: 'r1', status: 'new', subject: 'Ants in kitchen', category: 'pest_sighting', createdAt: '2026-09-09T12:00:00Z',
        property: { id: '7', isPrimary: false, label: 'Lake house', address: '12 Shore Ln, Parrish, FL 34219' } },
      { id: 'r2', status: 'new', subject: 'Ants in kitchen', category: 'pest_sighting', createdAt: '2026-09-09T12:01:00Z' },
    ];
    render(<CustomerRequestsPanel customerId="c1" />);
    const lines = await screen.findAllByTestId('request-property');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Lake house · 12 Shore Ln, Parrish, FL 34219 (secondary property)');
    expect(screen.getAllByText('Ants in kitchen')).toHaveLength(2);
  });

  it('loads and renders request photos only when staff open the attachment strip', async () => {
    rows.value = [{
      id: 'r-photo', status: 'new', subject: 'Ant trail by sink', category: 'pest_issue',
      createdAt: '2026-09-09T12:00:00Z',
    }];
    requestPhotos.value = ['data:image/jpeg;base64,YQ==', 'data:image/png;base64,Yg=='];

    render(<CustomerRequestsPanel customerId="c1" />);
    const button = await screen.findByRole('button', { name: 'Check photos' });
    expect(adminFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(button);

    const images = await screen.findAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', requestPhotos.value[0]);
    expect(images[1]).toHaveAttribute('src', requestPhotos.value[1]);
    await waitFor(() => expect(adminFetch).toHaveBeenLastCalledWith('/admin/requests/r-photo/photos'));

    fireEvent.click(screen.getByRole('button', { name: 'Expand photo 1 for Ant trail by sink' }));
    expect(screen.getByAltText('Expanded request evidence for Ant trail by sink')).toHaveAttribute('src', requestPhotos.value[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByAltText('Expanded request evidence for Ant trail by sink')).not.toBeInTheDocument();
  });

  it('offers an on-demand photo check when the list row has no attachment count', async () => {
    rows.value = [{ id: 'r-no-count', status: 'new', subject: 'No count row', category: 'other' }];
    render(<CustomerRequestsPanel customerId="c1" />);

    const button = await screen.findByRole('button', { name: 'Check photos' });
    expect(adminFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(button);

    expect(await screen.findByText('No request photos are available.')).toBeInTheDocument();
    await waitFor(() => expect(adminFetch).toHaveBeenLastCalledWith('/admin/requests/r-no-count/photos'));
  });

  it('uses the detail response to warn when attachments are unavailable', async () => {
    rows.value = [{ id: 'r-unavailable', status: 'new', subject: 'HEIC evidence', category: 'pest_issue' }];
    requestPhotos.unavailableCount = 1;
    render(<CustomerRequestsPanel customerId="c1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check photos' }));
    expect(await screen.findByText('Some attached photos are unavailable.')).toBeInTheDocument();
    expect(screen.getByText('No request photos are available.')).toBeInTheDocument();
    requestPhotos.unavailableCount = 0;
    requestPhotos.value = ['data:image/jpeg;base64,YQ=='];
    fireEvent.click(screen.getByRole('button', { name: 'Retry unavailable photos' }));
    expect(await screen.findByAltText('Photo 1 for HEIC evidence')).toBeInTheDocument();
    expect(screen.queryByText('Some attached photos are unavailable.')).not.toBeInTheDocument();
  });

  it('offers a retry after a request photo read fails', async () => {
    rows.value = [{ id: 'r-photo', status: 'new', subject: 'Brown patch', category: 'lawn_concern' }];
    requestPhotos.error = 'Could not load request photos';
    requestPhotos.value = ['data:image/jpeg;base64,YQ=='];
    render(<CustomerRequestsPanel customerId="c1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check photos' }));
    expect(await screen.findByText('Could not load request photos')).toBeInTheDocument();
    requestPhotos.error = '';
    fireEvent.click(screen.getByRole('button', { name: 'Retry photos' }));

    expect(await screen.findByAltText('Photo 1 for Brown patch')).toHaveAttribute('src', requestPhotos.value[0]);
    expect(adminFetch).toHaveBeenCalledTimes(3);
  });
});
