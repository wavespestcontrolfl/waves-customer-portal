'use strict';

// A small in-memory stand-in for the knex calls the negative keyword code makes (ad_negative_keywords,
// ad_negative_words, ad_campaigns, ad_search_terms), so the service tests run without a database. It supports exactly the
// chains negative-keyword-actions.js and ads-negative-keyword-buttons use; the real SQL (locks, constraints, the Eastern
// date count) runs in ad-negative-words-postgres.test.js. A thrown error inside a transaction restores the rows, like a
// rollback.
const { randomUUID } = require('crypto');

const UNIQUE = {
  ad_negative_keywords: ['campaign_id', 'text', 'match_type'],
  ad_negative_words: ['text'],
};
const DEFAULTS = {
  ad_negative_keywords: () => ({
    id: randomUUID(), match_type: 'phrase', google_resource_name: null, reason: null, metrics: null, decided_by: null,
    decided_at: null, pushed_at: null, removed_at: null, notified_at: null, last_error: null, created_at: new Date(), updated_at: new Date(),
  }),
  ad_negative_words: () => ({
    id: randomUUID(), match_type: 'phrase', added_by: null, removed_by: null, removed_at: null, created_at: new Date(), updated_at: new Date(),
  }),
  ad_search_terms: () => ({ id: randomUUID() }),
  ad_campaigns: () => ({ id: randomUUID() }),
};

function createFakeDb(seed = {}) {
  const tables = {
    ad_negative_keywords: [], ad_negative_words: [], ad_campaigns: [], ad_search_terms: [],
  };
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...(DEFAULTS[name]?.() || {}), ...r }));
  const calls = { raw: [], locks: [] };
  let tick = 0;

  function builder(spec) {
    const [name, alias] = String(spec).split(/\s+as\s+/i);
    const q = {
      table: name, alias: alias || name, joins: [], preds: [], order: [], max: null, proj: null, isDistinct: false, op: null, patch: null, rows: null, ret: null, ignore: false,
    };
    const col = (ctx, c) => {
      const [a, f] = c.includes('.') ? c.split('.') : [q.alias, c];
      return ctx[a]?.[f];
    };
    const api = {};
    const add = (fn) => { q.preds.push(fn); return api; };
    const eq = (a, b) => (a instanceof Date || b instanceof Date ? String(a) === String(b) : a === b);
    api.where = (a, b, c) => {
      if (typeof a === 'object') return add((ctx) => Object.entries(a).every(([k, v]) => eq(col(ctx, k), v)));
      if (c === undefined) return add((ctx) => eq(col(ctx, a), b));
      return add((ctx) => ({ '>': col(ctx, a) > c, '<': col(ctx, a) < c, '=': eq(col(ctx, a), c) }[b]));
    };
    api.whereNot = (k, v) => add((ctx) => !eq(col(ctx, k), v));
    api.whereIn = (k, vs) => add((ctx) => vs.includes(col(ctx, k)));
    api.whereNotNull = (k) => add((ctx) => col(ctx, k) != null);
    api.whereNull = (k) => add((ctx) => col(ctx, k) == null);
    api.whereRaw = (sql, binds) => {
      if (/notified_at AT TIME ZONE/.test(sql)) {
        const { etDateString } = require('../../utils/datetime-et');
        return add((ctx) => ctx[q.alias].notified_at && etDateString(new Date(ctx[q.alias].notified_at)) === binds[0]);
      }
      if (/lower\(search_term\) LIKE/.test(sql)) {
        const needle = String(binds[0]).slice(1, -1).replace(/\\(.)/g, '$1');
        return add((ctx) => String(ctx[q.alias].search_term).toLowerCase().includes(needle));
      }
      throw new Error(`fake db: unsupported whereRaw ${sql}`);
    };
    api.modify = (fn) => { fn(api); return api; };
    api.join = (table, left, right) => { const [t, al] = table.split(/\s+as\s+/i); q.joins.push({ t, al: al || t, left, right }); return api; };
    api.orderBy = (c, dir = 'asc') => { q.order.push([c, dir]); return api; };
    api.limit = (n) => { q.max = n; return api; };
    api.select = (...cols) => { q.proj = cols.flat(); return api; };
    api.distinct = (...cols) => { q.proj = cols.flat(); q.isDistinct = true; return api; };
    api.count = () => { q.op = 'count'; return api; };
    api.forUpdate = () => api;
    api.first = () => { q.max = 1; q.op = 'first'; return api; };
    api.insert = (rows) => { q.op = 'insert'; q.rows = [].concat(rows); return api; };
    api.onConflict = () => api;
    api.ignore = () => { q.ignore = true; return api; };
    api.update = (patch) => { q.op = 'update'; q.patch = patch; return api; };
    api.returning = (cols) => { q.ret = cols; return api; };

    const run = () => {
      if (q.op === 'insert') {
        const out = [];
        for (const raw of q.rows) {
          const row = { ...(DEFAULTS[name]?.() || {}), ...raw, created_at: new Date(1e12 + (tick += 1) * 1000) };
          if (typeof row.metrics === 'string') row.metrics = JSON.parse(row.metrics); // jsonb comes back parsed
          const keys = UNIQUE[name];
          const dup = keys && tables[name].some((r) => keys.every((k) => r[k] === row[k]));
          if (dup) {
            if (q.ignore) continue;
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          tables[name].push(row);
          out.push(row);
        }
        return q.ret ? out : out.length;
      }
      let rows = tables[name].map((r) => ({ [q.alias]: r }));
      for (const j of q.joins) {
        const next = [];
        for (const ctx of rows) {
          for (const r of tables[j.t]) {
            const withJoin = { ...ctx, [j.al]: r };
            if (col(withJoin, j.left) === col(withJoin, j.right)) next.push(withJoin);
          }
        }
        rows = next;
      }
      rows = rows.filter((ctx) => q.preds.every((p) => p(ctx)));
      for (const [c, dir] of [...q.order].reverse()) {
        rows.sort((x, y) => {
          const a = col(x, c); const b = col(y, c);
          const num = (v) => (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v); // numeric columns come back as strings
          const cmp = num(a) < num(b) ? -1 : num(a) > num(b) ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      if (q.op === 'update') {
        const touched = rows.map((ctx) => Object.assign(ctx[q.alias], q.patch));
        return q.ret ? touched : touched.length;
      }
      if (q.op === 'count') return [{ count: String(rows.length) }];
      if (q.max != null) rows = rows.slice(0, q.max);
      let out = rows.map((ctx) => {
        if (!q.proj) return ctx[q.alias];
        return Object.fromEntries(q.proj.map((c) => [c.split('.').pop(), col(ctx, c)]));
      });
      if (q.isDistinct) out = out.filter((r, i) => out.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) === i);
      return q.op === 'first' ? out[0] : out;
    };
    api.then = (resolve, reject) => { try { return Promise.resolve(run()).then(resolve, reject); } catch (err) { return Promise.reject(err); } };
    return api;
  }

  const db = (spec) => builder(spec);
  db.raw = jest.fn(async (sql, binds) => { calls.raw.push([sql, binds]); if (/pg_advisory_xact_lock/.test(sql)) calls.locks.push(binds[0]); return { rows: [] }; });
  const snapshot = () => JSON.stringify(tables, (k, v) => (v instanceof Date ? { __date: v.toISOString() } : v));
  const restore = (snap) => {
    const parsed = JSON.parse(snap, (k, v) => (v && v.__date ? new Date(v.__date) : v));
    for (const key of Object.keys(tables)) tables[key].splice(0, tables[key].length, ...parsed[key]);
  };
  const transaction = async (fn) => {
    const snap = snapshot();
    const trx = (spec) => builder(spec);
    trx.raw = db.raw;
    trx.transaction = transaction;
    try { return await fn(trx); } catch (err) { restore(snap); throw err; }
  };
  db.transaction = transaction;
  db.fn = { now: () => new Date() };
  db.tables = tables;
  db.calls = calls;
  return db;
}

module.exports = { createFakeDb };
