/** safeErrorText: a code-only log summary that never throws, even under a whole-module notification-service mock. */
describe('safeErrorText', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../services/notification-service');
  });

  test('uses notification-service safeErrorSummary (code or name only, never the message)', () => {
    jest.doMock('../services/notification-service', () => ({ safeErrorSummary: (err) => `summary:${err.code || err.name}` }));
    const { safeErrorText } = require('../services/safe-error-text');
    const err = Object.assign(new Error("bound phone '9415550123'"), { code: '57014' });
    expect(safeErrorText(err)).toBe('summary:57014');
  });

  test('a whole-module mock without the function falls back to a fixed string', () => {
    jest.doMock('../services/notification-service', () => ({}));
    const { safeErrorText } = require('../services/safe-error-text');
    expect(safeErrorText(new Error('9415550123'))).toBe('error');
  });

  test('a throwing summary or a failing require never throws out of a catch block', () => {
    jest.doMock('../services/notification-service', () => ({ safeErrorSummary: () => { throw new Error('boom'); } }));
    expect(require('../services/safe-error-text').safeErrorText(new Error('x'))).toBe('error');
    jest.resetModules();
    jest.doMock('../services/notification-service', () => { throw new Error('load failed'); });
    expect(require('../services/safe-error-text').safeErrorText(new Error('x'))).toBe('error');
  });
});
