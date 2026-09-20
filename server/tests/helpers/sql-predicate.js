// A tiny, GENERAL evaluator for the shapes of raw SQL claimInvoiceForSend's
// atomic flip actually issues against a mocked 'invoices' row — used by
// every test file whose invoices-table double needs `.whereRaw(...)` to
// really filter (Codex round-2 P1, PR #4633: the flip now carries the
// first-delivery/review-hold guards as predicates, so a lost flip must be
// reachable in tests, not just a chainable no-op).
//
// Round-3 P2 (ba77bf88e5): a comparison/LIKE against SQL NULL is NULL
// (unknown) in PostgreSQL, not false — `scheduled_send_error LIKE ?` on a
// row with no error at all is NULL, and NOT(NULL) is ALSO NULL, so a WHERE
// that reduces to NULL matches NOTHING (a genuinely NULL-safe predicate has
// to say so explicitly, e.g. COALESCE(scheduled_send_error, '') LIKE ?).
// This evaluator models that three-valued logic properly instead of
// folding NULL to false — a real recursive-descent parser over NOT/AND/OR,
// parenthesized groups, `<expr> = 'lit'`, `<expr> IS [NOT] NULL`,
// `<expr> LIKE ?`, and value expressions that are either a bare column
// reference or `COALESCE(expr, expr, ...)` — so it keeps working if the
// production clause is reformatted, and stays honest about NULL instead of
// special-casing the exact strings the codebase happens to use today.
//
// Booleans are represented as `true | false | null` (SQL UNKNOWN). Values
// are represented as the underlying JS value, or `undefined` for SQL NULL
// — kept distinct from the boolean tri-state so "a value is NULL" and "a
// condition is UNKNOWN" can never be confused with each other.

function tokenize(sql) {
  const re = /\s*('[^']*'|\(|\)|,|=|\?|[A-Za-z_][A-Za-z0-9_]*)\s*/g;
  const tokens = [];
  let match;
  let cursor = 0;
  while (cursor < sql.length) {
    re.lastIndex = cursor;
    match = re.exec(sql);
    if (!match || match.index !== cursor) {
      throw new Error(`sql-predicate test helper: could not tokenize "${sql}" at "${sql.slice(cursor)}"`);
    }
    tokens.push(match[1]);
    cursor = re.lastIndex;
  }
  return tokens;
}

function sqlAnd(a, b) {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

function sqlOr(a, b) {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

function sqlNot(a) {
  return a === null ? null : !a;
}

function sqlEquals(value, literal) {
  return value === undefined ? null : value === literal;
}

function sqlLike(value, pattern) {
  if (value === undefined || pattern === undefined) return null;
  if (typeof value !== 'string' || typeof pattern !== 'string') {
    throw new Error(`sql-predicate test helper: LIKE requires string operands, got ${JSON.stringify({ value, pattern })}`);
  }
  return pattern.endsWith('%') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function isStringLiteral(token) {
  return token.length >= 2 && token[0] === "'" && token[token.length - 1] === "'";
}

function stripQuotes(token) {
  return token.slice(1, -1);
}

class Parser {
  constructor(tokens, bindings, row) {
    this.tokens = tokens;
    this.bindings = bindings || [];
    this.bindingIndex = 0;
    this.row = row;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() {
    if (this.pos >= this.tokens.length) throw new Error('sql-predicate test helper: unexpected end of clause');
    return this.tokens[this.pos++];
  }
  isKeyword(token, word) { return typeof token === 'string' && token.toUpperCase() === word; }
  expect(word) {
    const token = this.next();
    if (typeof token !== 'string' || token.toUpperCase() !== word.toUpperCase()) {
      throw new Error(`sql-predicate test helper: expected "${word}", got "${token}"`);
    }
  }

  // OR is lowest precedence, then AND, then NOT, then a parenthesized group
  // or a single comparison — standard SQL precedence.
  parseOr() {
    let left = this.parseAnd();
    while (this.pos < this.tokens.length && this.isKeyword(this.peek(), 'OR')) {
      this.next();
      left = sqlOr(left, this.parseAnd());
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.pos < this.tokens.length && this.isKeyword(this.peek(), 'AND')) {
      this.next();
      left = sqlAnd(left, this.parseNot());
    }
    return left;
  }

  parseNot() {
    if (this.isKeyword(this.peek(), 'NOT')) {
      this.next();
      return sqlNot(this.parseNot());
    }
    return this.parseGroupOrComparison();
  }

  parseGroupOrComparison() {
    if (this.peek() === '(') {
      this.next();
      const value = this.parseOr();
      this.expect(')');
      return value;
    }
    const left = this.parseValue();
    const op = this.next();
    if (op === '=') {
      const literalToken = this.next();
      if (!isStringLiteral(literalToken)) throw new Error(`sql-predicate test helper: expected string literal after "=", got "${literalToken}"`);
      return sqlEquals(left, stripQuotes(literalToken));
    }
    if (this.isKeyword(op, 'IS')) {
      if (this.isKeyword(this.peek(), 'NOT')) {
        this.next();
        this.expect('NULL');
        return left !== undefined;
      }
      this.expect('NULL');
      return left === undefined;
    }
    if (this.isKeyword(op, 'LIKE')) {
      this.expect('?');
      const pattern = this.bindings[this.bindingIndex++];
      return sqlLike(left, pattern);
    }
    throw new Error(`sql-predicate test helper: unsupported operator "${op}"`);
  }

  // A value expression: a bare column reference, or COALESCE(expr, expr, ...)
  // resolving to the first non-NULL argument (SQL semantics).
  parseValue() {
    const token = this.next();
    if (isStringLiteral(token)) return stripQuotes(token);
    if (this.isKeyword(token, 'COALESCE')) {
      this.expect('(');
      const args = [this.parseValue()];
      while (this.peek() === ',') { this.next(); args.push(this.parseValue()); }
      this.expect(')');
      return args.find((arg) => arg !== undefined);
    }
    const value = this.row[token];
    return value == null ? undefined : value;
  }
}

function evaluateWhereRaw(sql, bindings, row) {
  const tokens = tokenize(String(sql).trim());
  const parser = new Parser(tokens, bindings, row);
  const result = parser.parseOr();
  if (parser.pos !== tokens.length) {
    throw new Error(`sql-predicate test helper: trailing tokens after "${sql}": ${tokens.slice(parser.pos).join(' ')}`);
  }
  // SQL semantics: a WHERE clause matches ONLY on TRUE — FALSE and UNKNOWN
  // (NULL) both exclude the row.
  return result === true;
}

module.exports = { evaluateWhereRaw };
