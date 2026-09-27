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
const { assertReadOnly, parseSince } = require('../../ops/agents/inventory-agent-replay');

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
    // Zero rows by construction, never an id assumed not to exist.
    expect(db.raw.mock.calls[0][0]).toMatch(/WHERE false$/);
  });

  test('the write matches zero rows by construction, so it is a no-op even in the failure branch below', () => {
    // Documents the safety property directly: an unconditional false
    // predicate, never an id assumed not to exist (Codex round 1 on #5080 —
    // nothing in the schema forbids the nil uuid), checked here as a static
    // guard against someone loosening the WHERE clause later.
    expect(assertReadOnly.toString()).toContain("'UPDATE products_catalog SET name = name WHERE false'");
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

// Codex round 2 on #5080: a bare --since date is Eastern midnight (the
// portal is Eastern-only), never UTC midnight; an unreadable one refuses.
describe('parseSince', () => {
  test('a bare date is Eastern midnight, in daylight and standard time alike', () => {
    expect(parseSince('2026-06-01').toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(parseSince('2026-01-15').toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  test('a full timestamp keeps its own offset; no value means everything', () => {
    expect(parseSince('2026-06-01T12:00:00Z').toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(parseSince(null).toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  test('an unreadable value refuses to run', () => {
    expect(() => parseSince('June first')).toThrow(/is not a date/);
  });
});
