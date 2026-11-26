// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { hasSessionToken } from './platform';

afterEach(() => vi.restoreAllMocks());

it('treats blocked browser storage as signed out instead of throwing', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
  expect(hasSessionToken()).toBe(false);
});
