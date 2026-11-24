// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import useAskDraftHold from './useAskDraftHold';
import { reloadHoldNames } from '../lib/reloadHolds';

afterEach(cleanup);

const held = () => reloadHoldNames().includes('ask-draft');

it('a question, a photo or a photo still converting holds; blank text does not', () => {
  const { rerender } = renderHook(({ prompt, photos, converting }) => useAskDraftHold(prompt, photos, converting), {
    initialProps: { prompt: '', photos: 0, converting: false },
  });
  expect(held()).toBe(false);
  rerender({ prompt: '   ', photos: 0 });
  expect(held()).toBe(false);
  rerender({ prompt: 'Who is next?', photos: 0 });
  expect(held()).toBe(true);
  rerender({ prompt: '', photos: 1 });
  expect(held()).toBe(true);
  rerender({ prompt: '', photos: 0, converting: true });
  expect(held()).toBe(true);
  rerender({ prompt: '', photos: 0, converting: false });
  expect(held()).toBe(false);
});

it('the hold ends when the composer unmounts', () => {
  const { unmount } = renderHook(() => useAskDraftHold('Who is next?', 0));
  expect(held()).toBe(true);
  unmount();
  expect(held()).toBe(false);
});

it('two composers hold until both drafts end', () => {
  const first = renderHook(({ prompt }) => useAskDraftHold(prompt), { initialProps: { prompt: 'One' } });
  const second = renderHook(({ prompt }) => useAskDraftHold(prompt), { initialProps: { prompt: 'Two' } });
  first.rerender({ prompt: '' });
  expect(held()).toBe(true);
  second.unmount();
  expect(held()).toBe(false);
});
