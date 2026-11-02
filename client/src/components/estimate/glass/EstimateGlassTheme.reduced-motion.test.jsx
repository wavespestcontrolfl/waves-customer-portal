// @vitest-environment jsdom
// Motion audit 2026-11-02, M07: the estimate's square-foot count-up read
// Reduce Motion once, when the page mounted. A setting turned on while the
// estimate stays open must stop the count-up when the stat scrolls in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGlassTheme } from './EstimateGlassTheme';

let observers;
let preference;

class FakeIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    observers.push(this);
  }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

function scrollStatIntoView(stat) {
  const io = observers.find((o) => o.targets.has(stat));
  expect(io).toBeDefined();
  io.callback([{ isIntersecting: true, target: stat }]);
}

beforeEach(() => {
  observers = [];
  document.body.innerHTML = '<div id="root"><p>Lawn area</p><span data-testid="stat">1,234 sq ft</span></div>';
  preference = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  window.matchMedia = vi.fn().mockReturnValue(preference);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-glass-theme');
  document.documentElement.style.background = '';
  document.body.style.background = '';
  document.body.innerHTML = '';
});

describe('estimate square-foot count-up', () => {
  it('runs when motion is allowed', () => {
    const { unmount } = renderHook(() => useGlassTheme(true));
    const stat = document.querySelector('[data-testid="stat"]');
    const framesBefore = requestAnimationFrame.mock.calls.length;
    scrollStatIntoView(stat);
    expect(requestAnimationFrame.mock.calls.length).toBe(framesBefore + 1);
    unmount();
  });

  it('stays still when Reduce Motion turns on after the page opened', () => {
    const { unmount } = renderHook(() => useGlassTheme(true));
    const stat = document.querySelector('[data-testid="stat"]');
    preference.matches = true;
    const framesBefore = requestAnimationFrame.mock.calls.length;
    scrollStatIntoView(stat);
    expect(requestAnimationFrame.mock.calls.length).toBe(framesBefore);
    expect(stat.textContent).toBe('1,234 sq ft');
    unmount();
  });
});
