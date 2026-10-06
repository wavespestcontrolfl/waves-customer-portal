// @vitest-environment jsdom
// Tree & Shrub Fast Complete: tips written for a watch item the tech marked
// Seen lead the tip picker under "For what you saw today". With nothing seen,
// no watch list (gate off) or a search, the picker is exactly today's. A pick
// is always the tech's. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CATALOG = [{ id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} }];
const VISIT = {
  id: 'svc-ts', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-ts', customerName: 'Pat Jones', serviceType: 'Tree & Shrub', address: '123 Main St', timeLabel: '2:00 PM' };
const WATCH_LIST = [
  { key: 'scale', label: 'Scale', signal: 'Possible scale', referOnly: false },
  { key: 'bed_weeds', label: 'Bed weeds', signal: 'Possible bed weeds', referOnly: false },
];
const BASE_CONTEXT = {
  eligible: true, reason: null, service: VISIT, products: CATALOG,
  monthProducts: [{ productId: 'iron', method: 'foliar_spray' }],
  lastVisit: { plantGroups: ['Palms'], areasTreated: [], products: [] },
  warnings: [],
};

// Library order: general first, then the two watch-matched tips, then more.
const tip = (id, label, extra = {}) => ({ id, label, keywords: [], copy: `${label} advice.`, ...extra });
const TIPS = {
  available: true,
  groups: [{
    id: 'tree_shrub',
    label: 'Trees and shrubs',
    tips: [
      tip('t_mulch', 'Mulch tip'),
      tip('t_water', 'Water tip'),
      tip('t_film', 'Black film tip', { watchKeys: ['scale', 'sooty_mold'], keywords: ['sooty'] }),
      tip('t_bloom', 'Bloom tip'),
      tip('t_weeds', 'Fresh mulch weeds tip', { watchKeys: ['bed_weeds'] }),
      tip('t_cold', 'Cold tip', { watchKeys: ['cold_freeze_damage'] }),
    ],
  }],
  lastSent: {},
  conditions: {},
};

function makeRequest(context) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/tree-shrub/fast-context')) return context;
    if (path.endsWith('/tech-tips')) return TIPS;
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(context) {
  const request = makeRequest(context);
  render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
  await screen.findByRole('button', { name: /^Chelated Iron Plus/ });
  await screen.findByLabelText('Search tips');
  return request;
}

const tipButtons = () => Array.from(document.querySelectorAll('.tech-visit-tip')).map((el) => el.querySelector('span').firstChild.textContent);
const seen = (label) => {
  const opener = screen.getByRole('button', { name: 'Add from watch list' });
  if (opener.getAttribute('aria-expanded') !== 'true') fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: label }));
};

describe('tip ranking by seen watch items', () => {
  test('no watch list: the picker is the library order with its four-tip preview', async () => {
    await openSheet(BASE_CONTEXT);
    expect(screen.queryByText('For what you saw today')).toBeNull();
    expect(tipButtons()).toEqual(['Mulch tip', 'Water tip', 'Black film tip', 'Bloom tip']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(tipButtons()).toEqual(['Mulch tip', 'Water tip', 'Black film tip', 'Bloom tip', 'Fresh mulch weeds tip', 'Cold tip']);
  });

  test('a watch list with nothing seen changes nothing', async () => {
    await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    expect(screen.queryByText('For what you saw today')).toBeNull();
    expect(tipButtons()).toEqual(['Mulch tip', 'Water tip', 'Black film tip', 'Bloom tip']);
  });

  test('seen items float the matching tips to the top under the heading, in library order, and select nothing', async () => {
    const request = await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    seen('Bed weeds');
    seen('Scale');
    const heading = await screen.findByText('For what you saw today');
    expect(heading.tagName).toBe('H4');
    expect(tipButtons()).toEqual(['Black film tip', 'Fresh mulch weeds tip', 'Mulch tip', 'Water tip', 'Bloom tip', 'Cold tip']);
    // nothing is picked for the tech
    expect(document.querySelectorAll('.tech-visit-tip[aria-pressed="true"]')).toHaveLength(0);
    // No pick, so no count line (the quiet section shows none until a pick).
    expect(screen.queryByText('1 picked')).toBeNull();
    expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });

  test('a seen item with no matching tip adds no heading', async () => {
    await openSheet({ ...BASE_CONTEXT, watchList: [{ key: 'whitefly', label: 'Whitefly', signal: 'Possible whitefly', referOnly: false }] });
    seen('Whitefly');
    expect(screen.queryByText('For what you saw today')).toBeNull();
    expect(tipButtons()).toEqual(['Mulch tip', 'Water tip', 'Black film tip', 'Bloom tip']);
  });

  test('search still finds every tip, floated or not', async () => {
    await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    seen('Scale');
    expect(screen.getByText('For what you saw today')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search tips'), { target: { value: 'cold' } });
    expect(tipButtons()).toEqual(['Cold tip']);
    expect(screen.queryByText('For what you saw today')).toBeNull();
    fireEvent.change(screen.getByLabelText('Search tips'), { target: { value: 'sooty' } });
    expect(tipButtons()).toEqual(['Black film tip']);
  });

  test('the tech picks a floated tip; taking the item off the list puts the tip back in order and keeps the pick', async () => {
    const request = await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    seen('Scale');
    fireEvent.click(within(document.body).getByRole('button', { name: /^Black film tip/ }));
    expect(screen.getByText('1 picked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Scale' }));
    await waitFor(() => expect(screen.queryByText('For what you saw today')).toBeNull());
    expect(tipButtons()).toEqual(['Mulch tip', 'Water tip', 'Black film tip', 'Bloom tip']);
    expect(document.querySelector('.tech-visit-tip[aria-pressed="true"]').textContent).toMatch(/^Black film tip/);
    expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });
});
