// @vitest-environment jsdom
// "Take WaveGuard with you" (moving PR 2a, GATE_MOVING_PORTAL): nothing renders
// while the server says enabled:false; the button opens the customer's own
// moving page from the server's path and nothing else; a failure says so.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({ default: { getMovingEntry: vi.fn(), startMove: vi.fn() } }));
vi.mock('../brand/CustomerDialogHost', () => ({ showCustomerAlert: vi.fn() }));

import api from '../../utils/api';
import { showCustomerAlert } from '../brand/CustomerDialogHost';
import MovingEntry, { MOVING_BODY, MOVING_HEADLINE, openMovingPage, useMovingEntry } from './MovingEntry';

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});
afterEach(cleanup);

describe('useMovingEntry', () => {
  it('asks nothing when told not to (a cancelled account)', async () => {
    const off = renderHook(() => useMovingEntry(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getMovingEntry).not.toHaveBeenCalled();
    expect(off.result.current).toBe(false);
  });

  it('reads the server flag once; a failed read keeps the button hidden', async () => {
    api.getMovingEntry.mockResolvedValueOnce({ enabled: true });
    const on = renderHook(() => useMovingEntry());
    await waitFor(() => expect(on.result.current).toBe(true));
    api.getMovingEntry.mockRejectedValueOnce(new Error('offline'));
    const off = renderHook(() => useMovingEntry());
    await waitFor(() => expect(api.getMovingEntry).toHaveBeenCalledTimes(2));
    expect(off.result.current).toBe(false);
  });
});

describe('MovingEntry', () => {
  it('renders nothing while disabled', () => {
    const { container } = render(<MovingEntry enabled={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.startMove).not.toHaveBeenCalled();
  });

  it('section: the live cancel-card promise, and the button opens the moving page', async () => {
    api.startMove.mockResolvedValueOnce({ path: '/moving/abc123' });
    // My Plan's real values: muted is a color string, secondaryButton a style object.
    render(<MovingEntry enabled styles={{ muted: '#475569', secondaryButton: { minHeight: 40 } }} />);
    expect(screen.getByText('Moving?')).toBeInTheDocument();
    expect(screen.getByText(MOVING_BODY).style.color).toBe('rgb(71, 85, 105)');
    expect(screen.getByRole('button', { name: MOVING_HEADLINE }).style.minHeight).toBe('40px');
    fireEvent.click(screen.getByRole('button', { name: MOVING_HEADLINE }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/moving/abc123'));
    expect(showCustomerAlert).not.toHaveBeenCalled();
  });

  it('link variant opens the same page; a failure or an unexpected path alerts and navigates nowhere', async () => {
    api.startMove.mockRejectedValueOnce(new Error('We could not open the moving page. Please try again, or call us.'));
    render(<MovingEntry enabled variant="link" />);
    fireEvent.click(screen.getByRole('button', { name: `${MOVING_HEADLINE} instead` }));
    await waitFor(() => expect(showCustomerAlert).toHaveBeenCalledWith('We could not open the moving page. Please try again, or call us.'));
    expect(assign).not.toHaveBeenCalled();
    // The button is usable again after a failure.
    expect(screen.getByRole('button', { name: `${MOVING_HEADLINE} instead` })).not.toBeDisabled();

    api.startMove.mockResolvedValueOnce({ path: 'https://elsewhere.example/x' });
    expect(await openMovingPage()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});
