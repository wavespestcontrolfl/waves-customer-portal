'use strict';

// assertFactCheckClear with the blog fact check on: a checker that did not run blocks the publish, and
// only a model outage (skipped 'api_error') is transient, so the Mac job keeps the terminal draft then.
function load(factCheck) {
  jest.resetModules();
  jest.doMock('../models/db', () => Object.assign(jest.fn(), { raw: jest.fn() }));
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  jest.doMock('../services/content/fact-check-gate', () => ({ evaluate: jest.fn().mockResolvedValue(factCheck) }));
  const evidence = jest.requireActual('../services/content/editorial-evidence');
  jest.doMock('../services/content/editorial-evidence', () => ({ ...evidence, enabled: () => true }));
  return require('../services/content-astro/astro-publisher')._internals.assertFactCheckClear;
}
const post = { title: 'Ghost ants', body: 'Body.', city: 'Venice', keyword: 'ghost ants', tag: 'ants' };

test.each([
  ['a model outage or timeout', 'api_error', true],
  ['a disabled checker', 'disabled', false],
  ['an empty body', 'empty_body', false],
])('%s blocks the publish as a review that did not run; transient = %s', async (_label, skipped, transient) => {
  const assertFactCheckClear = load({ pass: true, findings: [], checked: false, skipped });
  await expect(assertFactCheckClear(post, 'test')).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE', transient });
});

test('a completed clean check passes', async () => {
  const assertFactCheckClear = load({ pass: true, findings: [], checked: true });
  await expect(assertFactCheckClear(post, 'test')).resolves.toBeUndefined();
});
