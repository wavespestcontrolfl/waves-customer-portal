// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/admin/AdminCommandHeader', () => ({
  default: () => <div>Compliance navigation</div>,
}));

import CompliancePage from './CompliancePage';

describe('CompliancePage Staff authentication', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the current Phase-B Staff token for dashboard requests', async () => {
    localStorage.setItem('waves_admin_token', 'phase-b-staff-token');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<CompliancePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers?.Authorization).toBe('Bearer phase-b-staff-token');
    }
  });
});
