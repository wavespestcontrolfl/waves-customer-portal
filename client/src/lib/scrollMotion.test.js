// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollBehavior } from './scrollMotion';

const original = window.matchMedia;
const setReduced = (matches) => {
  window.matchMedia = vi.fn((query) => ({ matches: query === '(prefers-reduced-motion: reduce)' && matches, media: query }));
};

afterEach(() => { window.matchMedia = original; });

describe('scrollBehavior', () => {
  it('scrolls smoothly when the device does not ask for reduced motion', () => {
    setReduced(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('jumps when Reduce Motion is on, read at call time', () => {
    setReduced(true);
    expect(scrollBehavior()).toBe('auto');
    setReduced(false);
    expect(scrollBehavior()).toBe('smooth');
  });
});
