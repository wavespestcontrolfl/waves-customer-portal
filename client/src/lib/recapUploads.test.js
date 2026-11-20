import { expect, it } from 'vitest';
import { holdForRecapUpload } from './recapUploads';
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
