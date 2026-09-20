// Unit tests for the sql-predicate test helper itself (round-3 P2, PR
// #4633, commit ba77bf88e5): PostgreSQL three-valued logic means a
// comparison/LIKE against NULL is NULL (unknown), NOT(NULL) is NULL, and a
// WHERE clause that reduces to NULL matches NOTHING — the exact bug the
// production fix closed (a legacy scheduled row with no
// scheduled_send_error could never be claimed because the ORIGINAL,
// NULL-unsafe predicate evaluated to NULL for it). This suite pins the
// helper against both the original clause (proving it faithfully
// reproduces the bug) and the COALESCE'd fix (proving it faithfully
// reproduces the fix) — the OPPOSITE of what an earlier, NULL-folding
// version of this helper did.
const { evaluateWhereRaw } = require('./sql-predicate');

const STALE_SEND_PARK_ERROR = 'Recovered from stale sending claim — delivery unverified; check whether the customer received it, then resend or re-schedule manually';
const ORIGINAL_CLAUSE = "NOT (status = 'scheduled' AND scheduled_send_at IS NULL AND scheduled_send_error LIKE ?)";
const COALESCED_CLAUSE = "NOT (status = 'scheduled' AND scheduled_send_at IS NULL AND COALESCE(scheduled_send_error, '') LIKE ?)";
const bindings = [`${STALE_SEND_PARK_ERROR}%`];

describe('sql-predicate helper — three-valued (NULL) logic', () => {
  test('a bare comparison against NULL is NULL, not false — NOT(NULL) is also NULL, which does not match', () => {
    // scheduled_send_error LIKE ? on a row with NO error at all: NULL.
    // status = 'scheduled' (TRUE) AND scheduled_send_at IS NULL (TRUE) AND
    // NULL => NULL. NOT(NULL) => NULL. A WHERE reducing to NULL matches
    // NOTHING — the exact round-3 bug: an ordinary, never-parked scheduled
    // row with no error could never be claimed.
    const row = { status: 'scheduled', scheduled_send_at: null, scheduled_send_error: null };
    expect(evaluateWhereRaw(ORIGINAL_CLAUSE, bindings, row)).toBe(false);
  });

  test('COALESCE(scheduled_send_error, \'\') makes the SAME row match — the round-3 fix', () => {
    const row = { status: 'scheduled', scheduled_send_at: null, scheduled_send_error: null };
    expect(evaluateWhereRaw(COALESCED_CLAUSE, bindings, row)).toBe(true);
  });

  test('a genuinely parked row is excluded by the COALESCE\'d clause too', () => {
    const row = { status: 'scheduled', scheduled_send_at: null, scheduled_send_error: `${STALE_SEND_PARK_ERROR}: recovered` };
    expect(evaluateWhereRaw(COALESCED_CLAUSE, bindings, row)).toBe(false);
  });

  test('a row not even scheduled matches regardless of the error column (both clause forms)', () => {
    const row = { status: 'sent', scheduled_send_at: null, scheduled_send_error: null };
    expect(evaluateWhereRaw(ORIGINAL_CLAUSE, bindings, row)).toBe(true);
    expect(evaluateWhereRaw(COALESCED_CLAUSE, bindings, row)).toBe(true);
  });

  test('AND with an unknown operand is unknown unless the other side is already false', () => {
    // true AND NULL => NULL => does not match.
    expect(evaluateWhereRaw("status = 'scheduled' AND scheduled_send_error LIKE ?", ['x%'],
      { status: 'scheduled', scheduled_send_error: null })).toBe(false);
    // false AND NULL => false (short-circuits), still "does not match" but
    // for a different, non-UNKNOWN reason — both must read as no-match.
    expect(evaluateWhereRaw("status = 'scheduled' AND scheduled_send_error LIKE ?", ['x%'],
      { status: 'sent', scheduled_send_error: null })).toBe(false);
  });

  test('OR with an unknown operand is TRUE if the other side is true, else unknown', () => {
    expect(evaluateWhereRaw("status = 'scheduled' OR scheduled_send_error LIKE ?", ['x%'],
      { status: 'scheduled', scheduled_send_error: null })).toBe(true);
    expect(evaluateWhereRaw("status = 'scheduled' OR scheduled_send_error LIKE ?", ['x%'],
      { status: 'sent', scheduled_send_error: null })).toBe(false);
  });

  test('IS NULL / IS NOT NULL are always TRUE/FALSE, never UNKNOWN, even reading a NULL column', () => {
    expect(evaluateWhereRaw('scheduled_send_at IS NULL', [], { scheduled_send_at: null })).toBe(true);
    expect(evaluateWhereRaw('scheduled_send_at IS NOT NULL', [], { scheduled_send_at: null })).toBe(false);
  });

  test('COALESCE returns the first non-NULL argument, matching SQL semantics', () => {
    expect(evaluateWhereRaw("COALESCE(scheduled_send_error, '') = ''", [], { scheduled_send_error: null })).toBe(true);
    expect(evaluateWhereRaw("COALESCE(scheduled_send_error, '') = ''", [], { scheduled_send_error: 'x' })).toBe(false);
  });
});
