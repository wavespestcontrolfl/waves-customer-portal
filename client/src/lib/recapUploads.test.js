// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { holdForRecapUpload, useRecapRecoveryHold } from './recapUploads';
import { reloadHoldNames } from './reloadHolds';

const held = () => reloadHoldNames().includes('recap-upload');

it('a recap clip upload holds the reload from its first step to its last; a second release does nothing', () => {
  const first = holdForRecapUpload();
  const second = holdForRecapUpload();
  expect(held()).toBe(true);
  first();
  first();
  expect(held()).toBe(true);
  second();
  expect(held()).toBe(false);
});

it('a mounted recovery store holds while it keeps a failed clip, until the last component that mounts it unmounts', () => {
  const store = { failedDrafts: new Map() };
  const page = renderHook(() => useRecapRecoveryHold(store));
  const capture = renderHook(() => useRecapRecoveryHold(store));
  expect(held()).toBe(false);
  store.failedDrafts.set('visit-1', { draft: {}, message: 'Upload failed' });
  expect(held()).toBe(true);
  capture.unmount();
  expect(held()).toBe(true);
  page.unmount();
  expect(held()).toBe(false);
});
