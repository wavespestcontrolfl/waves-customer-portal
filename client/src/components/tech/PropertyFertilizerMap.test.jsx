// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import PropertyFertilizerMap from './PropertyFertilizerMap';

afterEach(cleanup);
const endpoint = '/admin/schedule/example/property-areas/fertilizer-map';
const blank = '.'.repeat(48);
const saved = { version: 'v1', map: { cells: 'L' + blank.slice(1), landmarks: 'Lawn ends at the brick edge.' } };
const cell = name => screen.findByLabelText('Row 1, column 1, ' + name);
function open(request) {
  render(<PropertyFertilizerMap endpoint={endpoint} request={request} />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open fertilizer map' }));
}

it('reassigns one footprint to one crew and requires its boundary before saving', async () => {
  const request = vi.fn().mockResolvedValueOnce({ version: 'v0', map: null }).mockResolvedValueOnce(saved);
  open(request);
  fireEvent.click(await cell('Unmapped'));
  expect(screen.getByText('Save map')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Assign squares to'), { target: { value: 'T' } });
  fireEvent.click(await cell('Lawn crew'));
  fireEvent.change(screen.getByLabelText('Boundary landmarks'), { target: { value: 'Inside brick edge.' } });
  fireEvent.click(screen.getByText('Save map'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ version: 'v0', cells: 'T' + blank.slice(1), landmarks: 'Inside brick edge.' });
});

it('requires a fresh review after another crew saves a change', async () => {
  const request = vi.fn().mockResolvedValueOnce(saved)
    .mockRejectedValueOnce(Object.assign(new Error('Another crew updated this map.'), { status: 409 }))
    .mockResolvedValueOnce({ version: 'v2', map: { ...saved.map, cells: 'X' + blank.slice(1) } });
  open(request);
  await cell('Lawn crew');
  fireEvent.change(screen.getByLabelText('Boundary landmarks'), { target: { value: 'New edge.' } });
  fireEvent.click(screen.getByText('Save map'));
  fireEvent.click(await screen.findByText('Reload saved map'));
  expect(await cell('Fertilizer-free')).toBeInTheDocument();
  expect(screen.getByText('Save map')).toBeDisabled();
});
