// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceOutlineComposerModal from './ServiceOutlineComposerModal';

// GATE_TS_OUTLINE: the Estimates list opens the composer on a Tree & Shrub outline with outlineServiceLine "tree_shrub".
function fakeAdminFetch() {
  return vi.fn(async (path) => {
    if (path === '/admin/service-outlines/preview') {
      return { outline: { title: 'Outline title', intro: 'Intro', sections: [] }, summary: {}, validation: { status: 'passed', errors: [], warnings: [] } };
    }
    if (path.endsWith('/events')) return { events: [] };
    return { packet: { id: path.split('/').pop(), status: 'draft' } };
  });
}

const ESTIMATE = {
  id: 'estimate-1',
  customerName: 'Test Customer',
  address: '100 Test Way, Sarasota',
  lawnServiceOutline: { id: 'lawn-packet' },
  treeShrubServiceOutline: { id: 'ts-packet' },
  pestServiceOutline: { id: 'pest-packet' },
};

const previewBody = (adminFetch) => JSON.parse(adminFetch.mock.calls.find(([path]) => path === '/admin/service-outlines/preview')[1].body);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ServiceOutlineComposerModal', () => {
  it('a Tree & Shrub open asks for the Tree & Shrub outline, with no grass and no product cards', async () => {
    const adminFetch = fakeAdminFetch();
    render(<ServiceOutlineComposerModal estimate={{ ...ESTIMATE, outlineServiceLine: 'tree_shrub' }} adminFetch={adminFetch} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Tree & Shrub service outline' })).toBeInTheDocument();
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/service-outlines/ts-packet'));
    expect(adminFetch).not.toHaveBeenCalledWith('/admin/service-outlines/lawn-packet');
    const body = previewBody(adminFetch);
    expect(body).toEqual(expect.objectContaining({ estimateId: 'estimate-1', serviceLine: 'tree_shrub', includeProductCards: false }));
    expect(body).not.toHaveProperty('turfType');
    expect(screen.queryByText('Turf type')).not.toBeInTheDocument();
    expect(screen.queryByText('Include approved product cards')).not.toBeInTheDocument();
  });

  it('a Pest Control open asks for the Pest Control outline and reads its own saved packet', async () => {
    const adminFetch = fakeAdminFetch();
    render(<ServiceOutlineComposerModal estimate={{ ...ESTIMATE, outlineServiceLine: 'pest_control' }} adminFetch={adminFetch} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Pest service outline' })).toBeInTheDocument();
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/service-outlines/pest-packet'));
    expect(adminFetch).not.toHaveBeenCalledWith('/admin/service-outlines/ts-packet');
    expect(previewBody(adminFetch)).toEqual(expect.objectContaining({ serviceLine: 'pest_control', includeProductCards: false }));
    expect(screen.queryByText('Turf type')).not.toBeInTheDocument();
  });

  it('a lawn open is the lawn composer as before', async () => {
    const adminFetch = fakeAdminFetch();
    render(<ServiceOutlineComposerModal estimate={ESTIMATE} adminFetch={adminFetch} onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Lawn service outline' })).toBeInTheDocument();
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/service-outlines/lawn-packet'));
    expect(previewBody(adminFetch)).not.toHaveProperty('serviceLine');
    expect(screen.getByText('Turf type')).toBeInTheDocument();
    expect(screen.getByText('Include approved product cards')).toBeInTheDocument();
  });
});
