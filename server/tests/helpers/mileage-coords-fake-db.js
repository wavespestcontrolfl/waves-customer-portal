'use strict';

// A tiny in-memory knex stand-in for the two tables the mileage coordinate fill touches (mileage_log and
// bouncie_webhook_log). Supports only the query shapes that code uses: where (object, column/value, operator,
// callback), orWhere, whereIn, whereNull, whereNotNull, orWhereNull, orderBy, limit, select, first and update.
const norm = (value) => (value instanceof Date ? value.getTime() : value);

function compare(left, op, right) {
  const a = norm(left);
  const b = norm(right);
  switch (op) {
    case '=': return a === b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    default: throw new Error(`fake db: operator ${op} not supported`);
  }
}

function makeBuilder(rows, joinWith = 'and') {
  const parts = [];
  const add = (join, test) => parts.push({ join, test });
  const state = { orderCol: null, max: Infinity };
  const builder = {
    where(a, b, c) { return builder.__where('and', a, b, c); },
    orWhere(a, b, c) { return builder.__where('or', a, b, c); },
    __where(join, a, b, c) {
      if (typeof a === 'function') {
        const sub = makeBuilder(rows);
        a.call(sub, sub);
        add(join, (row) => sub.__match(row));
      } else if (a && typeof a === 'object') {
        add(join, (row) => Object.entries(a).every(([col, val]) => compare(row[col], '=', val)));
      } else if (c === undefined) {
        add(join, (row) => compare(row[a], '=', b));
      } else {
        add(join, (row) => compare(row[a], b, c));
      }
      return builder;
    },
    whereIn(col, values) { add('and', (row) => values.includes(row[col])); return builder; },
    whereNull(col) { add('and', (row) => row[col] == null); return builder; },
    orWhereNull(col) { add('or', (row) => row[col] == null); return builder; },
    whereNotNull(col) { add('and', (row) => row[col] != null); return builder; },
    orderBy(col) { state.orderCol = col; return builder; },
    limit(n) { state.max = n; return builder; },
    __match(row) {
      let result = null;
      for (const part of parts) {
        const ok = part.test(row);
        result = result === null ? ok : part.join === 'or' ? result || ok : result && ok;
      }
      return result === null ? true : result;
    },
    __rows() {
      let out = rows.filter((row) => builder.__match(row));
      if (state.orderCol) out = [...out].sort((x, y) => (x[state.orderCol] < y[state.orderCol] ? -1 : 1));
      return out.slice(0, state.max);
    },
    select() { return Promise.resolve(builder.__rows().map((row) => ({ ...row }))); },
    first() { return Promise.resolve(builder.__rows()[0]); },
    update(patch) {
      const hit = builder.__rows();
      for (const row of hit) Object.assign(row, patch);
      return Promise.resolve(hit.length);
    },
    then(resolve, reject) { return builder.select().then(resolve, reject); },
  };
  return builder;
}

function makeFakeDb({ mileage = [], log = [] } = {}) {
  const tables = { mileage_log: mileage, bouncie_webhook_log: log };
  const conn = jest.fn((table) => {
    if (!tables[table]) throw new Error(`fake db: unknown table ${table}`);
    return makeBuilder(tables[table]);
  });
  conn.fn = { now: () => 'NOW' };
  conn.tables = tables;
  return conn;
}

module.exports = { makeFakeDb };
