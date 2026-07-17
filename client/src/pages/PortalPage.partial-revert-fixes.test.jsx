// @vitest-environment jsdom
// Pins the partial-revert interaction fixes (codex r3 on PR #2818):
// 1. PropertyTab flushes debounced edits when it unmounts (tab navigation),
//    so a later property switch can't repoint the delayed PUT at the newly
//    selected property's token.
// 2. DocumentSection hides Share/Download for stored documents the kept
//    server change marks file-less (downloadUrl: null / shareable: false).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab, DocumentSection } from './PortalPage';

// Matches the { customerId } session JWT payload tokenCustomerId decodes.
const fakeJwt = (customerId) => `h.${btoa(JSON.stringify({ customerId }))}.s`;

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  property: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
  api.updatePropertyPreferences.mockResolvedValue({ preferences: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PropertyTab pending-edit flush', () => {
  it('flushes a still-debounced edit when the tab unmounts', async () => {
    const { unmount } = render(<PropertyTab customer={customer} />);

    const input = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(input, { target: { value: 'Lift latch, no code' } });

    // Unmount inside the 1s debounce window — the save must leave NOW (one
    // microtask, before any property switch can swap the token), not fire
    // later from a stale timeout.
    expect(api.updatePropertyPreferences).not.toHaveBeenCalled();
    unmount();

    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1));
    expect(api.updatePropertyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ sideGateAccess: 'Lift latch, no code' }),
    );
  });

  it('serializes overlapping saves so an older PUT cannot overwrite a newer edit', async () => {
    let resolveFirst;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ preferences: {} });

    render(<PropertyTab customer={customer} />);
    const input = await screen.findByLabelText('Side Gate / Backyard Access');

    fireEvent.change(input, { target: { value: 'first value' } });
    fireEvent(window, new CustomEvent('waves:property-switching', { detail: { waiters: [] } }));
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1));

    // Second edit + flush while the first PUT is still in flight — it must
    // queue behind the first, not race it to the server.
    fireEvent.change(input, { target: { value: 'second value' } });
    fireEvent(window, new CustomEvent('waves:property-switching', { detail: { waiters: [] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);

    resolveFirst({ preferences: {} });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2));
    expect(api.updatePropertyPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ sideGateAccess: 'second value' }),
    );
  });

  it('drops pending edits when the token was swapped to another property', async () => {
    api.token = fakeJwt('cust-1');
    const { unmount } = render(<PropertyTab customer={customer} />);
    const input = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(input, { target: { value: 'gate code 4821' } });

    // Another tab switched properties: the storage handler adopts the new
    // token before this tab's portal unmounts. The unmount flush must NOT
    // write cust-1's edits under cust-2's identity.
    api.token = fakeJwt('cust-2');
    unmount();

    await new Promise((r) => setTimeout(r, 20));
    expect(api.updatePropertyPreferences).not.toHaveBeenCalled();
    delete api.token;
  });

  it('still saves on unmount while the token belongs to this property', async () => {
    api.token = fakeJwt('cust-1');
    const { unmount } = render(<PropertyTab customer={customer} />);
    const input = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(input, { target: { value: 'same identity save' } });

    unmount();

    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1));
    expect(api.updatePropertyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ sideGateAccess: 'same identity save' }),
    );
    delete api.token;
  });

  it('still flushes via the property-switching event while mounted', async () => {
    render(<PropertyTab customer={customer} />);

    const input = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(input, { target: { value: 'Gate stays open' } });

    const waiters = [];
    fireEvent(window, new CustomEvent('waves:property-switching', { detail: { waiters } }));

    expect(waiters).toHaveLength(1);
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1));
    expect(api.updatePropertyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ sideGateAccess: 'Gate stays open' }),
    );
  });
});

describe('DocumentSection file-less stored documents', () => {
  const section = { id: 'inspection_reports', label: 'Inspection Reports', icon: 'clipboard' };
  const baseProps = {
    section,
    emptyMessage: 'Nothing here yet',
    onDownload: vi.fn(),
    onShare: vi.fn(),
    onShareWithRealtor: vi.fn(),
    shareStatus: {},
    getExpirationBadge: () => null,
    formatDate: () => 'Jul 1, 2026',
    relativeTime: () => null,
    formatSize: () => null,
    customer,
    compact: false,
  };

  it('hides Share and Download when the server reports no stored file', () => {
    render(
      <DocumentSection
        {...baseProps}
        items={[{
          id: 'doc-1', title: 'Signed Agreement', documentType: 'agreement',
          downloadUrl: null, shareable: false,
        }]}
      />,
    );

    expect(screen.queryByRole('button', { name: /share signed agreement/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download signed agreement/i })).not.toBeInTheDocument();
    expect(screen.getByText('Not available online')).toBeInTheDocument();
  });

  it('keeps Share and Download for documents with a stored file', () => {
    render(
      <DocumentSection
        {...baseProps}
        items={[{
          id: 'doc-2', title: 'Insurance Certificate', documentType: 'insurance_cert',
          downloadUrl: '/api/documents/doc-2/download', shareable: true,
        }]}
      />,
    );

    expect(screen.getByRole('button', { name: /share insurance certificate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download insurance certificate/i })).toBeInTheDocument();
    expect(screen.queryByText('Not available online')).not.toBeInTheDocument();
  });
});
