// @vitest-environment jsdom
// Estimator audit P2 (sync tearing): the glass-copy flag is module-global
// state read during render. The store must notify subscribers on change so
// the subscribed root re-renders — without it, a flag flip (e.g. token B
// loading glassDefault:false after token A's true survived the remount)
// never scheduled a re-render and components painted torn glass/plain copy.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  glassCopyActive,
  setGlassDefault,
  subscribeGlassDefault,
  useGlassCopyActive,
} from './estimate-glass-copy';

afterEach(() => {
  cleanup();
  act(() => setGlassDefault(false));
});

describe('glass-copy store', () => {
  it('notifies subscribers on a real change and not on a same-value set', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGlassDefault(listener);

    setGlassDefault(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(glassCopyActive()).toBe(true);

    setGlassDefault(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setGlassDefault(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setGlassDefault(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('useGlassCopyActive re-renders the subscriber when the flag flips', () => {
    function Probe() {
      const glass = useGlassCopyActive();
      return <div>{glass ? 'glass-copy-on' : 'glass-copy-off'}</div>;
    }
    render(<Probe />);
    expect(screen.getByText('glass-copy-off')).toBeInTheDocument();

    act(() => setGlassDefault(true));
    expect(screen.getByText('glass-copy-on')).toBeInTheDocument();

    act(() => setGlassDefault(false));
    expect(screen.getByText('glass-copy-off')).toBeInTheDocument();
  });
});
