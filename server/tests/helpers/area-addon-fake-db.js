'use strict';

// A small in-memory fake of the tables the reader touches. Rows carry the columns the queries name (the
// joined add-on query reads prefixed columns "a." / "s.").
function fakeDb(tables, calls = []) {
  const get = (row, col) => row[col];
  const toPred = (a, b, c) => {
    if (typeof a === 'function') return (row) => evalGroup(a, row);
    if (a && typeof a === 'object') return (row) => Object.entries(a).every(([k, v]) => String(get(row, k)) === String(v));
    if (c === undefined) return (row) => String(get(row, a)) === String(b);
    if (b === '>') return (row) => String(get(row, a)) > String(c);
    throw new Error(`unsupported where ${a} ${b}`);
  };
  // The two raw SQL predicates the reader writes, evaluated the way Postgres would: the hold's expiry against the grace, and the
  // estimate's phone (last 10 digits) or address (letters and digits only).
  const digits = (value) => { const d = String(value || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
  const addressKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const rawPredicate = (sql, bindings) => {
    if (sql.includes('reservation_expires_at >= NOW()')) return (r) => r['s.reservation_expires_at'] != null && Date.parse(r['s.reservation_expires_at']) >= Date.now() - bindings[0] * 60000;
    if (sql.includes('customer_phone')) return (r) => digits(r.customer_phone) === bindings[0];
    if (sql.includes('lower(COALESCE(address')) return (r) => addressKey(r.address) === bindings[0];
    throw new Error(`unsupported raw ${sql}`);
  };
  // whereIn takes a list or a sub-query (evaluated at once, the first column of each row it selects).
  const inPred = (col, values) => {
    const list = Array.isArray(values) ? values : values._run().map((row) => Object.values(row)[0]);
    return (r) => list.map(String).includes(String(get(r, col)));
  };
  function evalGroup(fn, row) {
    const parts = [];
    const sub = {
      orWhereRaw(sql, bindings) { parts.push(['or', rawPredicate(sql, bindings)]); return sub; },
      where(...args) { parts.push(['and', toPred(...args)]); return sub; },
      whereNull(col) { parts.push(['and', (r) => get(r, col) == null]); return sub; },
      orWhere(...args) { parts.push(['or', toPred(...args)]); return sub; },
      orWhereNull(col) { parts.push(['or', (r) => get(r, col) == null]); return sub; },
      orWhereNot(col, v) { parts.push(['or', (r) => String(get(r, col)) !== String(v)]); return sub; },
      whereIn(col, values) { parts.push(['and', inPred(col, values)]); return sub; },
      orWhereIn(col, values) { parts.push(['or', inPred(col, values)]); return sub; },
    };
    fn.call(sub);
    return parts.reduce((acc, [op, pred], i) => (i === 0 ? pred(row) : (op === 'and' ? acc && pred(row) : acc || pred(row))), true);
  }
  const db = (spec) => {
    const [table] = String(spec).split(/\s+as\s+/i);
    calls.push(table);
    if (!Object.prototype.hasOwnProperty.call(tables, table)) throw new Error(`no such table ${table}`);
    if (typeof tables[table] === 'function') tables[table] = tables[table]();
    const preds = [];
    let cols = null; let max = Infinity; let single = false; let counting = null;
    const q = {
      where(...args) { preds.push(toPred(...args)); return q; },
      whereIn(col, values) { preds.push(inPred(col, values)); return q; },
      whereNotIn(col, values) { preds.push((r) => !values.includes(get(r, col))); return q; },
      whereNull(col) { preds.push((r) => get(r, col) == null); return q; },
      whereNot(col, v) {
        if (col && typeof col === 'object') Object.entries(col).forEach(([k, val]) => preds.push((r) => String(get(r, k)) !== String(val)));
        else preds.push((r) => String(get(r, col)) !== String(v));
        return q;
      },
      whereNotNull(col) { preds.push((r) => get(r, col) != null); return q; },
      whereRaw(sql, bindings) { preds.push(rawPredicate(sql, bindings)); return q; },
      modify(fn) { fn(q); return q; },
      orderBy() { return q; },
      join() { return q; },
      limit(n) { max = n; return q; },
      columnInfo: async () => Object.fromEntries(Object.keys((tables[table][0]) || (tables.__columns && tables.__columns[table]) || {}).map((c) => [c.replace(/^\w+\./, ''), {}])),
      count(spec) { counting = String(spec).split(/\s+as\s+/i)[1] || 'count'; return q; },
      select(...c) { cols = c; return q; },
      first(...c) { cols = c; single = true; return q; },
      _run() {
        const rows = tables[table].filter((row) => preds.every((p) => p(row))).slice(0, max);
        if (counting) return [{ [counting]: rows.length }];
        return rows.map((row) => (cols ? Object.fromEntries(cols.map((c) => {
          const [from, to] = c.split(/\s+as\s+/i);
          return [to || from.replace(/^\w+\./, ''), get(row, from)];
        })) : row));
      },
      then(resolve, reject) {
        try {
          const shaped = q._run();
          resolve(single ? shaped[0] : shaped);
        } catch (e) { reject(e); }
      },
    };
    return q;
  };
  db.calls = calls;
  return db;
}

module.exports = { fakeDb };
