// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InstallPrompt from './InstallPrompt';

function renderPrompt() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <div className="portal-login-panel" />
      <InstallPrompt />
    </MemoryRouter>,
  );
}

function installEvent(outcome = 'declined') {
  const event = new Event('beforeinstallprompt');
  Object.assign(event, {
    prompt: vi.fn(),
    userChoice: Promise.resolve({ outcome }),
  });
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InstallPrompt', () => {
  it('renders in the login flow, clears safe areas, and hides after decline', async () => {
    renderPrompt();
    const event = installEvent('declined');
    fireEvent(window, event);
    await act(async () => { vi.advanceTimersByTime(30000); });

    const region = screen.getByRole('region', { name: 'Install Waves app' });
    expect(region).toHaveStyle({
      position: 'relative',
      paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 4px)',
    });
    expect(document.querySelector('.portal-login-panel')).toContainElement(region);
    expect(screen.getByRole('button', { name: 'Install' })).toHaveStyle({ minHeight: '44px' });
    expect(screen.getByRole('button', { name: 'Dismiss install prompt' })).toHaveStyle({ minWidth: '44px', minHeight: '44px' });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Install Waves app' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('pwaPromptDismissed')).toBe('1');
  });

  it('cancels its delayed show when unmounted', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { unmount } = renderPrompt();
    fireEvent(window, installEvent());

    const showTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30000);
    expect(showTimerIndex).toBeGreaterThanOrEqual(0);
    const showTimer = setTimeoutSpy.mock.results[showTimerIndex].value;

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(showTimer);
  });

  it('dismisses immediately when the browser reports installation', async () => {
    renderPrompt();
    fireEvent(window, installEvent('accepted'));
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole('region', { name: 'Install Waves app' })).toBeInTheDocument();

    fireEvent(window, new Event('appinstalled'));

    expect(screen.queryByRole('region', { name: 'Install Waves app' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('pwaPromptDismissed')).toBe('1');
  });
});
