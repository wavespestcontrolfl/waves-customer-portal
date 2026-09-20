// A tiny, GENERAL evaluator for the shapes of raw SQL claimInvoiceForSend's
// atomic flip actually issues against a mocked 'invoices' row — used by
// every test file whose invoices-table double needs `.whereRaw(...)` to
// really filter (Codex round-2 P1, PR #4633: the flip now carries the
// first-delivery/review-hold guards as predicates, so a lost flip must be
// reachable in tests, not just a chainable no-op). Parses the boolean
// structure (NOT (...), AND-joined `col = 'lit'` / `col IS [NOT] NULL` /
// `col LIKE ?`) instead of matching any exact SQL string, so it keeps
// working if the production clause is reformatted.
function evaluateWhereRaw(sql, bindings, row) {
  const trimmed = String(sql).trim();
  const notMatch = /^NOT\s*\((.+)\)$/is.exec(trimmed);
  if (notMatch) return !evaluateAndClause(notMatch[1], bindings, row);
  return evaluateAndClause(trimmed, bindings, row);
}

function evaluateAndClause(clause, bindings, row) {
  const parts = clause.split(/\s+AND\s+/i);
  let bindingIndex = 0;
  return parts.every((rawPart) => {
    const part = rawPart.trim();
    let m;
    if ((m = /^(\w+)\s*=\s*'([^']*)'$/.exec(part))) {
      return row[m[1]] === m[2];
    }
    if ((m = /^(\w+)\s+IS\s+NULL$/i.exec(part))) {
      return row[m[1]] == null;
    }
    if ((m = /^(\w+)\s+IS\s+NOT\s+NULL$/i.exec(part))) {
      return row[m[1]] != null;
    }
    if ((m = /^(\w+)\s+LIKE\s+\?$/i.exec(part))) {
      const pattern = bindings?.[bindingIndex++];
      const value = row[m[1]];
      if (typeof value !== 'string' || typeof pattern !== 'string') return false;
      return pattern.endsWith('%') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
    }
    throw new Error(`sql-predicate test helper: unsupported whereRaw clause "${part}" in "${clause}"`);
  });
}

module.exports = { evaluateWhereRaw };
