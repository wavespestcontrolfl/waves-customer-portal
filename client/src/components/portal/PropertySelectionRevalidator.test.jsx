// @vitest-environment jsdom
import React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PortalReadProvider, usePortalRefresh } from '../../hooks/usePortalRead';
import PropertySelectionRevalidator from './PropertySelectionRevalidator';

vi.mock('../BiometricGate', () => ({ useBiometricLock: () => false }));

let portal;
function Probe() { portal = usePortalRefresh(); return null; }

describe('PropertySelectionRevalidator', () => {
  it('re-reads the property list on every shared refresh while active (the page keeps it active in every scope), and not otherwise', async () => {
    const refresh = vi.fn(async () => true);
    const view = render(
      <PortalReadProvider enabled>
        <PropertySelectionRevalidator active refresh={refresh} />
        <Probe />
      </PortalReadProvider>,
    );
    await act(async () => { await portal.refresh(); });
    expect(refresh).toHaveBeenCalledTimes(1);

    view.rerender(
      <PortalReadProvider enabled>
        <PropertySelectionRevalidator active={false} refresh={refresh} />
        <Probe />
      </PortalReadProvider>,
    );
    await act(async () => { await portal.refresh(); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a failed re-read never breaks the refresh cycle', async () => {
    const refresh = vi.fn(async () => { throw new Error('offline'); });
    render(
      <PortalReadProvider enabled>
        <PropertySelectionRevalidator active refresh={refresh} />
        <Probe />
      </PortalReadProvider>,
    );
    await act(async () => { await expect(portal.refresh()).resolves.toBeUndefined(); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
