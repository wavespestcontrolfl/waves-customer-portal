// @vitest-environment jsdom
// A portal ticket filed under a saved (secondary) property names that house
// where staff mark it handled — two identical requests from two houses must
// be distinguishable here (uncapped codex #4207 r2a P1).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rows = { value: [] };
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async () => ({ ok: true, json: async () => ({ requests: rows.value }) })),
}));

import CustomerRequestsPanel from './CustomerRequestsPanel';

afterEach(() => cleanup());

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
});
