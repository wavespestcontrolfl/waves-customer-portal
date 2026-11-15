// @vitest-environment jsdom
// The Pets form's kinds: Dog, Cat and Other as before, plus chickens or other birds, a grass eater, a fish pond and beehives.
// Each pill stores a stable value that the technician's lawn visit brief reads (server/services/lawn-label-animal-lines.js).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    getWateringPlan: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab } from './PortalPage';

const customer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Gold', property: {} };
const blankPet = { name: '', type: '', breed: '', indoor: '', temperament: '' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getWateringPlan.mockResolvedValue({ available: false });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  api.updatePropertyPreferences.mockResolvedValue({ preferences: {}, saved: true });
  api.getPropertyPreferences.mockResolvedValue({ preferences: { petCount: 1, petsStructured: [{ ...blankPet }] }, hasLawnCare: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const KINDS = [
  ['Dog', 'Dog'], ['Cat', 'Cat'], ['Other', 'Other'],
  ['Birds', 'Chickens or other birds'],
  ['Grass eater', 'Rabbit, tortoise or other grass eater'],
  ['Fish pond', 'Fish pond'],
  ['Beehives', 'Beehives'],
];

describe('Pets form kinds', () => {
  it('shows Dog, Cat and Other and the four new kinds', async () => {
    render(<PropertyTab customer={customer} />);
    await screen.findByText('Pet 1');
    for (const [, label] of KINDS) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it.each(KINDS)('choosing the %s pill saves that stable value', async (value, label) => {
    render(<PropertyTab customer={customer} />);
    await screen.findByText('Pet 1');
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalled(), { timeout: 3000 });
    const sent = api.updatePropertyPreferences.mock.calls.at(-1)[0];
    expect(sent.petsStructured[0]).toMatchObject({ type: value });
  });

  it('a saved new kind shows as chosen, and the other fields stay available', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { petCount: 1, petsStructured: [{ ...blankPet, name: 'Shelly', type: 'Grass eater' }] }, hasLawnCare: false });
    render(<PropertyTab customer={customer} />);
    await screen.findByText('Pet 1');
    expect(screen.getByRole('button', { name: 'Rabbit, tortoise or other grass eater' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Pet 1 name')).toHaveValue('Shelly');
    expect(screen.getByLabelText('Pet 1 breed')).toBeInTheDocument();
  });
});
