// @vitest-environment jsdom
// The Equipment tab renders the seeded checklist shape
// ([{ category, items: [{ item, required, note }] }]) as grouped lines. It
// used to look for `label` / `name` on each group and print raw JSON.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminAuth', () => ({ getAdminAuthToken: () => 'test-token' }));

import TechProtocolsPage, { checklistGroups } from './TechProtocolsPage';

const ok = (body) => ({ ok: true, json: async () => body });
const CHECKLIST = {
  id: 'c1', service_line: 'termite', service_type: 'Termite Inspection / Treatment',
  checklist_items: [
    { category: 'Inspection', items: [{ item: 'Moisture meter', required: true }, { item: 'Foam drill kit', required: false, note: 'Treatment visits only' }] },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/admin/protocols/equipment')) return ok({ checklists: [CHECKLIST] });
    return ok({ photos: [], scripts: [] });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TechProtocolsPage equipment tab', () => {
  it('renders each checklist group with its items, marking optional ones', async () => {
    render(<MemoryRouter><TechProtocolsPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Equipment/ }));
    expect(await screen.findByText('Moisture meter')).toBeInTheDocument();
    expect(screen.getByText('Inspection')).toBeInTheDocument();
    expect(screen.getByText('Foam drill kit').closest('li')).toHaveTextContent('(optional)');
    expect(screen.getByText('Treatment visits only')).toBeInTheDocument();
    expect(screen.getByText('Moisture meter').closest('li')).not.toHaveTextContent('(optional)');
    expect(screen.queryByText(/"category"/)).not.toBeInTheDocument();
  });
});

describe('checklistGroups', () => {
  it('keeps older flat rows readable and drops empty entries', () => {
    expect(checklistGroups(['Flashlight', { label: 'Probe' }, { name: 'Ladder', required: true }, null])).toEqual([
      { category: '', items: [{ item: 'Flashlight', required: false, note: '' }] },
      { category: '', items: [{ item: 'Probe', required: false, note: '' }] },
      { category: '', items: [{ item: 'Ladder', required: true, note: '' }] },
    ]);
    expect(checklistGroups('not a list')).toEqual([]);
  });
});
