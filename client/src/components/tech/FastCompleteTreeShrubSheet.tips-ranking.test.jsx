// @vitest-environment jsdom
// Tree & Shrub Fast Complete: the tip picker lists no tip until the tech
// searches (owner 2026-10-12, the way the blog post is found). A watch item
// marked Seen lists nothing by itself; a search reads every tip, and a pick is
// always the tech's. Synthetic data only.
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

describe('the tip picker lists tips only for a search', () => {
  test('no watch list: no tip, no heading and no "Show all" until the tech searches', async () => {
    await openSheet(BASE_CONTEXT);
    expect(tipButtons()).toEqual([]);
    expect(screen.queryByText('For what you saw today')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search tips'), { target: { value: 'tip' } });
    expect(tipButtons()).toEqual(['Black film tip', 'Bloom tip', 'Cold tip', 'Fresh mulch weeds tip', 'Mulch tip', 'Water tip']);
  });

  test('a watch item marked Seen lists no tip by itself', async () => {
    await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    seen('Bed weeds');
    seen('Scale');
    expect(tipButtons()).toEqual([]);
    expect(screen.queryByText('For what you saw today')).toBeNull();
  });

  test('a search finds a tip by its label or keyword, a tip for a seen item included', async () => {
    await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    seen('Scale');
    fireEvent.change(screen.getByLabelText('Search tips'), { target: { value: 'cold' } });
    expect(tipButtons()).toEqual(['Cold tip']);
    fireEvent.change(screen.getByLabelText('Search tips'), { target: { value: 'sooty' } });
    expect(tipButtons()).toEqual(['Black film tip']);
  });

  test('the tech picks a found tip: it shows alone, and taking the seen item off the list keeps the pick', async () => {
    const request = await openSheet({ ...BASE_CONTEXT, watchList: WATCH_LIST });
    seen('Scale');
    fireEvent.change(screen.getByLabelText('Search tips'), { target: { value: 'film' } });
    fireEvent.click(within(document.body).getByRole('button', { name: /^Black film tip/ }));
    expect(screen.getByText('1 picked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Scale' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Scale' })).toBeNull());
    expect(tipButtons()).toEqual(['Black film tip']);
    expect(document.querySelector('.tech-visit-tip[aria-pressed="true"]').textContent).toMatch(/^Black film tip/);
    expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });
});
