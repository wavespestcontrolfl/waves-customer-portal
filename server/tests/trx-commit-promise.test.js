/**
 * commitPromiseOf — after-commit hooks must wait for the OUTERMOST
 * transaction, not a savepoint's release (codex #3590 r14).
 */
const { commitPromiseOf } = require('../utils/trx-commit-promise');

describe('commitPromiseOf', () => {
  test('top-level transaction returns its own executionPromise', () => {
    const p = Promise.resolve('root');
    expect(commitPromiseOf({ executionPromise: p })).toBe(p);
  });
  test('nested savepoint walks parentTransaction to the root', () => {
    const rootP = Promise.resolve('root');
    const root = { executionPromise: rootP };
    const sp1 = { executionPromise: Promise.resolve('sp1'), parentTransaction: root };
    const sp2 = { executionPromise: Promise.resolve('sp2'), parentTransaction: sp1 };
    expect(commitPromiseOf(sp2)).toBe(rootP);
  });
  test('non-transaction / missing promise returns null', () => {
    expect(commitPromiseOf(null)).toBe(null);
    expect(commitPromiseOf({})).toBe(null);
    expect(commitPromiseOf({ parentTransaction: {} })).toBe(null);
  });
});
