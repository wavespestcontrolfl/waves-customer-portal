// @vitest-environment jsdom
// The truck check (GATE_TRUCK_KIT): the kit grouped by category, every item
// Here unless an earlier check already reported it, one tap per problem, one
// save that posts a state for every item; a kit the office changed reloads.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminAuth', () => ({ getAdminAuthToken: () => 'test-token' }));

import TechTruckCheckPage, { groupKit } from './TechTruckCheckPage';

const METER = { id: 'e1', name: 'Moisture meter', asset_tag: 'T-002', category: 'tool', serial_number: null, open_issue: null };
const SPRAYER = { id: 'e2', name: 'B&G sprayer', asset_tag: 'T-001', category: 'sprayer', serial_number: 'N124', open_issue: 'missing' };
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
let status;
let postResponse;
let posts;

beforeEach(() => {
  posts = [];
  status = () => ok({ enabled: true, truck: { id: 'v1', name: 'Synthetic truck', asset_tag: 'VEH-001' }, kit: [METER, SPRAYER], lastCheck: null, due: true, intervalDays: 7 });
  postResponse = () => ok({ check: { id: 'k1', item_count: 2, missing_count: 0, damaged_count: 1 } }, 201);
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return postResponse(); }
    return status();
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<MemoryRouter initialEntries={['/admin/today/truck-check']}>
  <Routes><Route path="/admin/today/truck-check" element={<TechTruckCheckPage />} /></Routes>
</MemoryRouter>);
const itemGroup = (name) => within(screen.getByRole('group', { name }));

describe('TechTruckCheckPage', () => {
  it('lists the kit by category, defaults a reported item to its issue and saves a state for every item', async () => {
    mount();
    expect(await screen.findByText('Moisture meter')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('Sprayers')).toBeInTheDocument();
    expect(screen.getByText('VEH-001 · Synthetic truck · Never checked')).toBeInTheDocument();
    // Reported missing last time: it stays Missing until the technician says Here.
    expect(itemGroup('B&G sprayer').getByRole('button', { name: 'Missing' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Note about B&G sprayer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save check (1 issue)' })).toBeInTheDocument();

    fireEvent.click(itemGroup('B&G sprayer').getByRole('button', { name: 'Here' }));
    expect(screen.getByRole('button', { name: "Everything's here" })).toBeInTheDocument();
    expect(screen.queryByLabelText('Note about B&G sprayer')).not.toBeInTheDocument();
    fireEvent.click(itemGroup('Moisture meter').getByRole('button', { name: 'Damaged' }));
    fireEvent.change(screen.getByLabelText('Note about Moisture meter'), { target: { value: 'Cracked screen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save check (1 issue)' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // One idempotency key per loaded list rides with the results.
    expect(posts[0].clientKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect({ results: posts[0].results }).toEqual({ results: [
      { equipmentId: 'e1', state: 'damaged', note: 'Cracked screen' },
      { equipmentId: 'e2', state: 'present', note: '' },
    ] });
    expect(await screen.findByText('Check saved')).toBeInTheDocument();
    expect(screen.getByText(/1 item needs the office's attention/)).toBeInTheDocument();
  });

  it('a kit the office changed is reloaded and the technician is asked to look again', async () => {
    mount();
    await screen.findByText('Moisture meter');
    postResponse = () => ok({ error: 'The truck list changed since it was loaded', code: 'kit_changed', kit: [] }, 409);
    fireEvent.click(screen.getByRole('button', { name: 'Save check (1 issue)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The office changed your truck list');
    await waitFor(() => expect(fetch.mock.calls.filter(([, o]) => !o?.method).length).toBe(2));
    expect(screen.queryByText('Check saved')).not.toBeInTheDocument();
  });

  it('no truck, an empty list and the gate off are plain messages, and a failed read offers a retry', async () => {
    status = () => ok({ enabled: true, truck: null, kit: [], lastCheck: null, due: false });
    mount();
    expect(await screen.findByText('No truck assigned to you')).toBeInTheDocument();
    cleanup();
    status = () => ok({ enabled: true, truck: { id: 'v1', name: 'Synthetic truck' }, kit: [], lastCheck: null, due: false });
    mount();
    expect(await screen.findByText('Nothing on the list yet')).toBeInTheDocument();
    cleanup();
    status = () => ok({ enabled: false }, 404);
    mount();
    expect(await screen.findByText('Truck checks are not turned on yet.')).toBeInTheDocument();
    cleanup();
    status = () => ok({ error: 'Database unavailable' }, 503);
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('groupKit', () => {
  it('groups in the order the server sent, with readable labels', () => {
    expect(groupKit([METER, SPRAYER, { id: 'e3', name: 'Gloves', category: 'safety' }, { id: 'e4', name: 'Thing', category: null }])).toEqual([
      { category: 'tool', label: 'Tools', items: [METER] },
      { category: 'sprayer', label: 'Sprayers', items: [SPRAYER] },
      { category: 'safety', label: 'Safety', items: [{ id: 'e3', name: 'Gloves', category: 'safety' }] },
      { category: 'other', label: 'Other', items: [{ id: 'e4', name: 'Thing', category: null }] },
    ]);
  });
});
