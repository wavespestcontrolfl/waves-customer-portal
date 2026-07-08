// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import useLockBodyScroll from './useLockBodyScroll';

function Locker({ active = true }) {
  useLockBodyScroll(active);
  return null;
}

describe('useLockBodyScroll', () => {
  beforeEach(() => {
    cleanup();
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.overflow = '';
    window.scrollTo = vi.fn();
  });

  it('pins the body at the current scroll offset while locked', () => {
    Object.defineProperty(window, 'scrollY', { value: 240, configurable: true });
    render(<Locker active />);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-240px');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores the original body styles and scroll position on unlock', () => {
    Object.defineProperty(window, 'scrollY', { value: 100, configurable: true });
    const { unmount } = render(<Locker active />);
    unmount();
    expect(document.body.style.position).toBe('');
    expect(document.body.style.top).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 100);
  });

  it('is a no-op when inactive', () => {
    render(<Locker active={false} />);
    expect(document.body.style.position).toBe('');
  });

  it('reference-counts nested locks so an inner unlock does not release the body early', () => {
    Object.defineProperty(window, 'scrollY', { value: 50, configurable: true });
    const outer = render(<Locker active />);
    const inner = render(<Locker active />);
    expect(document.body.style.position).toBe('fixed');

    // Inner overlay closes first — body must stay locked for the outer one.
    inner.unmount();
    expect(document.body.style.position).toBe('fixed');

    // Outer overlay closes — now the body is released.
    outer.unmount();
    expect(document.body.style.position).toBe('');
  });
});
