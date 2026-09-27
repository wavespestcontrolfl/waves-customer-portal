/**
 * ops/agents/inventory-agent-replay.js — assertReadOnly's error
 * classification (2026-09-27 pre-push review P1: the script's own
 * dedicated read-only pool doesn't cover the SHARED server/models/db pool
 * dispatchWithFallback's LLM ledger/trace/dispatch-metrics recording can
 * write through). This is a pure unit test of the classification logic
 * against a mocked `db.raw` — it never opens a real connection, so it can't
 * prove PGOPTIONS itself works end-to-end; that's what the live self-check
 * (this same function, run against the real shared db module before the
 * script does anything else) is for.
 */
const { assertReadOnly } = require('../../ops/agents/inventory-agent-replay');

function mockDb(behavior) {
  return { raw: jest.fn(behavior) };
}

describe('assertReadOnly', () => {
  test('a write rejected with a read-only-transaction error is exactly the expected, passing case', async () => {
    const db = mockDb(async () => {
      throw new Error('cannot execute UPDATE in a read-only transaction');
    });
    await expect(assertReadOnly(db)).resolves.toBeUndefined();
    expect(db.raw).toHaveBeenCalledTimes(1);
    expect(db.raw.mock.calls[0][0]).toMatch(/^UPDATE products_catalog/);
  });

  test('the write matches zero rows by construction, so it is a no-op even in the failure branch below', () => {
    // Documents the safety property directly: the id is a literal
    // impossible uuid, checked once here as a static guard against someone
    // loosening the WHERE clause later.
    expect(assertReadOnly.toString()).toContain("id = '00000000-0000-0000-0000-000000000000'");
  });

  test('a write that succeeds outright (no error at all) fails the self-check loudly', async () => {
    const db = mockDb(async () => ({ rowCount: 0 }));
    await expect(assertReadOnly(db)).rejects.toThrow(/READ-ONLY SELF-CHECK FAILED/);
  });

  test('an error that is NOT the read-only rejection (e.g. a connection failure) also fails the self-check, distinctly', async () => {
    const db = mockDb(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(assertReadOnly(db)).rejects.toThrow(/not with the expected read-only rejection/);
  });
});
