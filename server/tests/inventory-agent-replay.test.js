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
const { assertReadOnly, amazonReplayItems, siteOneReplayItems } = require('../../ops/agents/inventory-agent-replay');

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

// The replay decides SiteOne lines with the same invoice evidence the live
// agent reads (2026-09-27 pre-push audit): each item keeps its email id and
// the invoice's own line number, and the lines the live sweep never hands
// the agent are left out.
describe('siteOneReplayItems', () => {
  const email = { id: 'email-1' };

  test('keeps the email id and each line\'s own invoice line number', () => {
    const invoice = { lines: [
      { title: 'TAURUS SC 78OZ', quantity: 2, lineNo: 1, uom: 'EA' },
      { title: 'DEMAND CS 8OZ', quantity: 1, lineNo: 3, uom: 'EA' },
    ] };
    expect(siteOneReplayItems(email, invoice)).toEqual([
      { vendor: 'siteone', title: 'TAURUS SC 78OZ', quantity: 2, emailId: 'email-1', lineNo: 1, heldAs: null },
      { vendor: 'siteone', title: 'DEMAND CS 8OZ', quantity: 1, emailId: 'email-1', lineNo: 3, heldAs: null },
    ]);
  });

  test('leaves out zero-quantity lines and flags the lines the sweep holds for a person', () => {
    const invoice = { lines: [
      { title: 'NOT SHIPPED', quantity: 0, lineNo: 1, uom: 'EA' },
      { title: 'RETURNED BAIT', quantity: -1, lineNo: 2, uom: 'EA' },
      { title: 'CASE OF 4', quantity: 1, lineNo: 3, uom: 'CS' },
      { title: 'TAURUS SC 78OZ', quantity: 1, lineNo: 4, uom: 'EA' },
    ] };
    expect(siteOneReplayItems(email, invoice).map((item) => [item.title, item.heldAs])).toEqual([
      ['RETURNED BAIT', 'returned'], ['CASE OF 4', 'unverified'], ['TAURUS SC 78OZ', null],
    ]);
    expect(siteOneReplayItems(email, { ...invoice, problem: 'unverified' }).every((item) => item.heldAs)).toBe(true);
  });

  test('a pending or unreadable invoice yields nothing', () => {
    expect(siteOneReplayItems(email, null)).toEqual([]);
    expect(siteOneReplayItems(email, { pending: true, lines: [] })).toEqual([]);
  });
});

// An Amazon line the live sweep holds for a person is never decided by the
// replay (2026-09-27 pre-push audit): an explicitly invalid quantity (null)
// is not a quantity of 1.
describe('amazonReplayItems', () => {
  test('a null quantity or a missing order number is held, exactly as the sweep holds it', () => {
    expect(amazonReplayItems({ orderNumber: '111-2222222-3333333', items: [
      { title: 'Taurus SC Termiticide 78 oz', quantity: 2 },
      { title: 'Bifen XTS Insecticide 96 oz', quantity: null },
    ] })).toEqual([
      { vendor: 'amazon', title: 'Taurus SC Termiticide 78 oz', quantity: 2, heldAs: null },
      { vendor: 'amazon', title: 'Bifen XTS Insecticide 96 oz', quantity: 0, heldAs: 'unverified' },
    ]);
    expect(amazonReplayItems({ orderNumber: null, items: [{ title: 'Taurus SC Termiticide 78 oz', quantity: 1 }] }))
      .toEqual([{ vendor: 'amazon', title: 'Taurus SC Termiticide 78 oz', quantity: 1, heldAs: 'no_order_number' }]);
  });

  test('an unparsed email yields nothing', () => {
    expect(amazonReplayItems(null)).toEqual([]);
  });

  test('an itemless Delivered email is one no_items placeholder held for a person, as the live lane records it', () => {
    expect(amazonReplayItems({ orderNumber: '111-2222222-3333333', items: [] }, { subject: 'Delivered: 2 Lawn & Garden items' }))
      .toEqual([{ vendor: 'amazon', title: 'Delivered: 2 Lawn & Garden items', quantity: 1, heldAs: 'no_items' }]);
  });
});
