// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiscountStacking, __resetDiscountStackingCache } from './useDiscountStacking';

function Probe() {
  const enabled = useDiscountStacking();
  return <div data-testid="state">{enabled ? 'on' : 'off'}</div>;
}

beforeEach(() => {
  __resetDiscountStackingCache();
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('useDiscountStacking', () => {
  it('starts off and turns on once the server reports the gate live', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) })));
    render(<Probe />);
    expect(screen.getByTestId('state')).toHaveTextContent('off');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('on'));
  });

  it('stays off for a dark gate, an error response, a thrown fetch, or a missing token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ enabled: false }) })));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    cleanup();

    __resetDiscountStackingCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    cleanup();

    __resetDiscountStackingCache();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    cleanup();

    __resetDiscountStackingCache();
    localStorage.removeItem('waves_admin_token');
    const noTokenFetch = vi.fn();
    vi.stubGlobal('fetch', noTokenFetch);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('off'));
    expect(noTokenFetch).not.toHaveBeenCalled();
  });

  it('asks the server once per session, however many surfaces ask', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(<><Probe /><Probe /><Probe /></>);
    await waitFor(() => expect(screen.getAllByTestId('state')[2]).toHaveTextContent('on'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/admin\/discounts\/stacking$/);
  });
});
