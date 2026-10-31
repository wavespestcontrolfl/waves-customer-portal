// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAdminTableScroll } from './useAdminTableScroll';

let frames;
let nextFrame;
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function flushFrames() {
  for (let index = 0; index < 3; index += 1) act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  });
}
function Example(props) {
  useAdminTableScroll(props);
  return <main id="admin-main" />;
}
function setup(overrides = {}) {
  const props = { enabled: true, active: true, ready: false, scope: 'account-a', scrollTop: 320, onScroll: vi.fn(), resetKey: 'all:2', ...overrides };
  const rendered = render(<Example {...props} />);
  const container = rendered.container.querySelector('main');
  container.scrollTo = vi.fn(({ top }) => { container.scrollTop = top; });
  return { props, rendered, container };
}

it('waits for rows, restores the main container, and ignores record-detail scrolling', () => {
  const { props, rendered, container } = setup();
  flushFrames();
  expect(container.scrollTo).not.toHaveBeenCalled();
  rendered.rerender(<Example {...props} ready />);
  container.scrollTop = 0; // The shell's pathname reset happens before our frames.
  flushFrames();
  expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: 'instant' });
  container.scrollTop = 640;
  fireEvent.scroll(container);
  act(() => vi.advanceTimersByTime(150));
  expect(props.onScroll).toHaveBeenLastCalledWith(640);
  rendered.rerender(<Example {...props} ready scrollTop={640} />);
  flushFrames();
  expect(container.scrollTo).toHaveBeenCalledTimes(1);
  rendered.rerender(<Example {...props} ready active={false} scrollTop={640} />);
  container.scrollTop = 1800;
  fireEvent.scroll(container);
  act(() => vi.advanceTimersByTime(200));
  expect(props.onScroll).toHaveBeenCalledTimes(1);
  rendered.rerender(<Example {...props} ready scrollTop={640} />);
  flushFrames();
  expect(container.scrollTop).toBe(640);
});

it('discards a pending position when the account or query changes', () => {
  const { props, rendered, container } = setup({ ready: true, scrollTop: 0 });
  flushFrames();
  container.scrollTop = 900;
  fireEvent.scroll(container);
  rendered.rerender(<Example {...props} scope="account-b" scrollTop={70} />);
  flushFrames();
  act(() => vi.advanceTimersByTime(200));
  expect(container.scrollTop).toBe(70);
  expect(props.onScroll).not.toHaveBeenCalled();
  container.scrollTop = 1000;
  fireEvent.scroll(container);
  rendered.rerender(<Example {...props} scope="account-b" resetKey="changed:1" scrollTop={0} />);
  flushFrames();
  act(() => vi.advanceTimersByTime(200));
  expect(container.scrollTop).toBe(0);
  expect(props.onScroll).not.toHaveBeenCalled();
});

it('flushes the last list position when leaving before the debounce completes', () => {
  const { props, rendered, container } = setup({ ready: true });
  flushFrames();
  container.scrollTop = 450;
  fireEvent.scroll(container);
  rendered.unmount();
  act(() => vi.advanceTimersByTime(200));
  expect(props.onScroll).toHaveBeenCalledOnce();
  expect(props.onScroll).toHaveBeenCalledWith(450);
});
