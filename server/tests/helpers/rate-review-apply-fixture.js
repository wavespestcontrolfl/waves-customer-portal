/**
 * In-memory knex stand-in for the rate review APPLY lane tests (no
 * Postgres). Unlike the ranking fixture's scripted chain, this one keeps
 * REAL table state: where / whereIn / whereNull / orderBy / first / update /
 * insert (+ onConflict ignore|merge, returning) / delete / count over plain
 * arrays, one left join (alias-prefixed columns), and transactions that
 * ROLL BACK on a throw (structuredClone snapshot), so a test can assert what
 * a held apply left untouched and what an applied one wrote.
 *
 * Raw SQL is routed by shape: the plan-line visit loader
 * (rate-review-apply.js loadLineOpenVisits) reads the fixture's synthetic
 * `_line` / `_cadence` tags on scheduled_services rows.
 *
 * Every id, name and number here is invented.
 */
'use strict';

const CUSTOMER = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const VISIT = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROW = (n) => `40000000-0000-4000-8000-00000000000${n}`;
const TERM = (n) => `20000000-0000-4000-8000-00000000000${n}`;

function splitAlias(name) {
  const m = /^(\w+)(?:\s+as\s+(\w+))?$/i.exec(String(name).trim());
  return { table: m ? m[1] : String(name), alias: m && m[2] ? m[2] : null };
}

function uuid() {
  return `50000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
}

function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
  const na = Number(a); const nb = Number(b);
  if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) && /^\s*-?\d+(\.\d+)?\s*$/.test(String(a)) && /^\s*-?\d+(\.\d+)?\s*$/.test(String(b))) return na - nb;
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return String(a) === String(b) || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && String(a).trim() !== '' && String(b).trim() !== '' && Number(a) === Number(b));
}

class Query {
  constructor(db, tableExpr) {
    this.db = db;
    const { table, alias } = tableExpr ? splitAlias(tableExpr) : { table: null, alias: null };
    this.table = table;
    this.alias = alias;
    this.conds = []; // { bool, pred(rowCtx) }
    this.joins = [];
    this.order = [];
    this.projection = null;
    this.limitN = null;
    this.counting = null;
    this.pendingInsert = null;
    this.conflictCols = null;
    this.conflictMode = null;
    this.mergePatch = null;
    this.returningCols = null;
    this.calls = [];
  }

  // column → { source: 'base'|alias, col }
  resolveCol(name) {
    const parts = String(name).split('.');
    if (parts.length === 2) {
      const [prefix, col] = parts;
      if (prefix === this.alias || prefix === this.table) return { source: 'base', col };
      const join = this.joins.find((j) => j.alias === prefix || j.table === prefix);
      if (join) return { source: join.alias || join.table, col };
      return { source: 'base', col };
    }
    return { source: 'base', col: name };
  }

  valueOf(ctx, name) {
    const { source, col } = this.resolveCol(name);
    if (source === 'base') return ctx.row[col];
    const joined = ctx.joined[source];
    return joined ? joined[col] : undefined;
  }

  push(bool, pred) { this.conds.push({ bool, pred }); return this; }

  cond(bool, args, negate = false) {
    const [a, b, c] = args;
    if (typeof a === 'function') {
      const sub = new Query(this.db, null);
      sub.alias = this.alias; sub.table = this.table; sub.joins = this.joins;
      a.call(sub, sub);
      return this.push(bool, (ctx) => { const r = sub.evaluate(ctx); return negate ? !r : r; });
    }
    if (a && typeof a === 'object') {
      const entries = Object.entries(a);
      return this.push(bool, (ctx) => { const r = entries.every(([k, v]) => (v === null ? this.valueOf(ctx, k) == null : same(this.valueOf(ctx, k), v))); return negate ? !r : r; });
    }
    if (args.length === 2) return this.push(bool, (ctx) => { const r = b === null ? this.valueOf(ctx, a) == null : same(this.valueOf(ctx, a), b); return negate ? !r : r; });
    const op = String(b);
    return this.push(bool, (ctx) => {
      const v = this.valueOf(ctx, a);
      let r;
      if (op === '=') r = same(v, c);
      else if (op === '<>' || op === '!=') r = !same(v, c);
      else if (v == null) r = false;
      else if (op === '<=') r = compare(v, c) <= 0;
      else if (op === '>=') r = compare(v, c) >= 0;
      else if (op === '<') r = compare(v, c) < 0;
      else if (op === '>') r = compare(v, c) > 0;
      else throw new Error(`fake-knex: unsupported operator ${op}`);
      return negate ? !r : r;
    });
  }

  where(...args) { this.calls.push(['where', args]); return this.cond('and', args); }
  andWhere(...args) { return this.where(...args); }
  orWhere(...args) { this.calls.push(['orWhere', args]); return this.cond('or', args); }
  whereNot(...args) { this.calls.push(['whereNot', args]); return this.cond('and', args, true); }
  whereIn(col, values) { this.calls.push(['whereIn', [col, values]]); return this.push('and', (ctx) => values.some((v) => same(this.valueOf(ctx, col), v))); }
  orWhereIn(col, values) { return this.push('or', (ctx) => values.some((v) => same(this.valueOf(ctx, col), v))); }
  whereNotIn(col, values) { return this.push('and', (ctx) => !values.some((v) => same(this.valueOf(ctx, col), v))); }
  whereNull(col) { this.calls.push(['whereNull', [col]]); return this.push('and', (ctx) => this.valueOf(ctx, col) == null); }
  whereNotNull(col) { this.calls.push(['whereNotNull', [col]]); return this.push('and', (ctx) => this.valueOf(ctx, col) != null); }
  whereRaw() { return this; }
  leftJoin(tableExpr, left, right) { const { table, alias } = splitAlias(tableExpr); this.joins.push({ table, alias: alias || table, left, right }); return this; }
  join(...args) { return this.leftJoin(...args); }
  orderBy(col, dir = 'asc') { this.order.push({ col, dir }); return this; }
  orderByRaw() { return this; }
  limit(n) { this.limitN = n; return this; }
  forUpdate() { this.calls.push(['forUpdate', []]); this.db.log.push(['forUpdate', this.table]); return this; }
  noWait() { return this; }
  select(...cols) { this.projection = cols.flat(); return this; }
  count(spec) { this.counting = spec || { n: '*' }; return this; }
  returning(cols) { this.returningCols = Array.isArray(cols) ? cols : [cols]; return this; }
  onConflict(cols) { this.conflictCols = Array.isArray(cols) ? cols : [cols]; return this; }
  ignore() { this.conflictMode = 'ignore'; return this; }
  merge(patch) { this.conflictMode = 'merge'; this.mergePatch = patch || null; return this.then((v) => v); }

  evaluate(ctx) {
    if (!this.conds.length) return true;
    let result = this.conds[0].pred(ctx);
    for (const { bool, pred } of this.conds.slice(1)) result = bool === 'or' ? (result || pred(ctx)) : (result && pred(ctx));
    return result;
  }

  rows() {
    const base = this.db.store[this.table];
    if (!base) throw new Error(`fake-knex: unknown table ${this.table}`);
    const ctxs = base.map((row) => {
      const joined = {};
      for (const j of this.joins) {
        const other = this.db.store[j.table] || [];
        const leftRes = this.resolveColRaw(j.left);
        const rightRes = this.resolveColRaw(j.right);
        // one side names this join's alias, the other the base
        const [joinCol, baseCol] = leftRes.source === (j.alias || j.table) ? [leftRes.col, rightRes.col] : [rightRes.col, leftRes.col];
        joined[j.alias || j.table] = other.find((o) => same(o[joinCol], row[baseCol])) || null;
      }
      return { row, joined };
    }).filter((ctx) => this.evaluate(ctx));
    for (const { col, dir } of [...this.order].reverse()) {
      ctxs.sort((x, y) => { const c = compare(this.valueOf(x, col), this.valueOf(y, col)); return dir === 'desc' ? -c : c; });
    }
    return this.limitN != null ? ctxs.slice(0, this.limitN) : ctxs;
  }

  resolveColRaw(name) {
    const parts = String(name).split('.');
    if (parts.length === 2) {
      const [prefix, col] = parts;
      if (prefix === this.alias || prefix === this.table) return { source: 'base', col };
      return { source: prefix, col };
    }
    return { source: 'base', col: name };
  }

  project(ctx) {
    if (!this.projection || this.projection.includes('*') || this.projection.some((c) => /\.\*$/.test(String(c)))) {
      const out = { ...ctx.row };
      for (const j of this.joins) if (this.projection && this.projection.includes(`${j.alias}.*`)) Object.assign(out, ctx.joined[j.alias] || {});
      return out;
    }
    const out = {};
    for (const spec of this.projection) {
      const [expr, alias] = String(spec).split(/\s+as\s+/i);
      const { col } = this.resolveCol(expr);
      out[alias || col] = this.valueOf(ctx, expr);
    }
    return out;
  }

  async first(...cols) {
    this.calls.push(['first', cols]);
    if (this.counting) { const key = Object.keys(this.counting)[0] || 'n'; return { [key]: this.rows().length }; }
    if (cols.length) this.projection = cols.flat();
    const ctx = this.rows()[0];
    return ctx ? this.project(ctx) : null;
  }

  async update(patch, returning) {
    this.db.log.push(['update', this.table, patch]);
    const ctxs = this.rows();
    for (const ctx of ctxs) Object.assign(ctx.row, patch);
    if (returning) return ctxs.map((c) => ({ ...c.row }));
    return ctxs.length;
  }

  async del() { const ctxs = this.rows(); const ids = new Set(ctxs.map((c) => c.row)); this.db.store[this.table] = this.db.store[this.table].filter((r) => !ids.has(r)); return ctxs.length; }
  async delete() { return this.del(); }

  insert(rows) {
    this.db.log.push(['insert', this.table, rows]);
    this.pendingInsert = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  runInsert() {
    const table = this.db.store[this.table];
    if (!table) throw new Error(`fake-knex: unknown table ${this.table}`);
    const inserted = [];
    for (const raw of this.pendingInsert) {
      const row = { ...raw };
      if (row.id === undefined) row.id = uuid();
      if (row.created_at === undefined) row.created_at = new Date(this.db.clock.getTime() + table.length);
      if (this.conflictCols) {
        const existing = table.find((r) => this.conflictCols.every((c) => same(r[c], row[c])));
        if (existing) {
          if (this.conflictMode === 'merge') Object.assign(existing, this.mergePatch || row);
          continue; // ignore → nothing inserted
        }
      }
      table.push(row);
      inserted.push(row);
    }
    if (this.returningCols) return inserted.map((r) => { const out = {}; for (const c of this.returningCols) out[c] = r[c]; return out; });
    return inserted.length;
  }

  then(resolve, reject) {
    return Promise.resolve().then(() => {
      if (this.pendingInsert) return this.runInsert();
      if (this.counting) { const key = Object.keys(this.counting)[0] || 'n'; return [{ [key]: this.rows().length }]; }
      return this.rows().map((ctx) => this.project(ctx));
    }).then(resolve, reject);
  }
  catch(fn) { return this.then((v) => v).catch(fn); }

  async columnInfo() {
    const cols = this.db.columns[this.table] || Object.keys((this.db.store[this.table] || [])[0] || {});
    return Object.fromEntries(cols.map((c) => [c, { type: 'text' }]));
  }
}

const SCHEDULED_SERVICE_COLUMNS = ['id', 'customer_id', 'scheduled_date', 'status', 'estimated_price', 'primary_line_price', 'discount_type', 'discount_amount', 'discount_dollars',
  'discount_id', 'discount_name', 'discount_service_key_filter', 'discount_service_category_filter', 'discount_max_dollars', 'line_discount_id', 'line_discount_name', 'line_discount_type',
  'line_discount_amount', 'line_discount_dollars', 'annual_prepay_term_id', 'prepaid_amount', 'is_callback', 'is_recurring', 'recurring_parent_id', 'recurring_template_overrides',
  'service_type', 'service_id', 'service_key_snapshot', 'service_category_snapshot', 'updated_at'];

function createFakeDb(tables = {}) {
  const db = function db(tableExpr) { return new Query(db, tableExpr); };
  db.store = {};
  db.log = [];
  db.clock = new Date('2026-12-10T08:10:00Z');
  db.columns = { scheduled_services: SCHEDULED_SERVICE_COLUMNS };
  db.reset = (next = {}) => {
    const base = {
      customers: [], price_change_notices: [], rate_review_snapshots: [], rate_review_batches: [], scheduled_services: [], scheduled_service_addons: [],
      customer_plan_rates: [], plan_holds: [], annual_prepay_terms: [], audit_log: [], activity_log: [], notifications: [],
    };
    db.store = { ...base, ...structuredClone(next) };
    db.log = [];
    db.rawHandlers = [];
  };
  db.reset(tables);
  db.isTransaction = true;
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.fn = { now: () => new Date() };
  db.rawHandlers = [];
  db.raw = jest.fn(async (sql, bindings = []) => {
    for (const [re, fn] of db.rawHandlers) if (re.test(sql)) return fn(bindings, sql);
    if (/SELECT s\.id, s\.customer_id, s\.scheduled_date/.test(sql)) {
      const [customerId, fromDate, familyKey, cadence] = bindings;
      const rows = db.store.scheduled_services
        .filter((s) => same(s.customer_id, customerId) && s.scheduled_date >= fromDate && ['pending', 'confirmed', 'rescheduled'].includes(s.status)
          && (s.is_recurring || s.recurring_parent_id) && s._line === familyKey && s._cadence === cadence)
        .sort((a, b) => compare(a.scheduled_date, b.scheduled_date) || compare(a.id, b.id))
        .map((s) => ({ ...s }));
      return { rows };
    }
    if (/pg_(try_)?advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }] };
    throw new Error(`fake-knex: unexpected raw SQL ${String(sql).slice(0, 80)}`);
  });
  db.transaction = jest.fn(async (fn) => {
    const snapshot = structuredClone(db.store);
    try {
      return await fn(db);
    } catch (err) {
      db.store = snapshot;
      throw err;
    }
  });
  return db;
}

// ── the fake book ───────────────────────────────────────────────────────

const BATCH_KEY = '2026-12';
const TODAY = '2026-11-02'; // the owner schedules the December batch on Nov 2
const NOW = new Date('2026-11-02T14:00:00Z');

function batchRow(overrides = {}) {
  return { batch_key: BATCH_KEY, window_from: '2026-12-01', window_to: '2026-12-31', allowances: {}, config: {}, line_rph: {}, book_lines: 3, ...overrides };
}

function snapshotRow(n, overrides = {}) {
  return {
    id: ROW(n), batch_key: BATCH_KEY, customer_id: CUSTOMER(n), family_key: 'pest_control', cadence: 'quarterly', visits_per_year: 4,
    billing_lane: 'per_application', anniversary_date: '2025-12-05', anniversary_source: 'first_visit', tenure_months: 12,
    current_rate_cents: 11700, current_rate_source: 'visit_median', rate_unit: 'application', list_rate_cents: 12100, list_rate_source: 'engine',
    gap_pct: 3.3, usable_visits: 4, band: 'C', proposed_rate_cents: 12100, delta_cents: 400, annual_delta_cents: 1600, flags: [], status: 'approved',
    notice_id: null, ...overrides,
  };
}

function customerRow(n, overrides = {}) {
  return { id: CUSTOMER(n), billing_mode: 'per_application', billing_day: 1, per_application_fee: '117.00', monthly_rate: '39.00', deleted_at: null, ...overrides };
}

// A quarterly pest series: parent (completed first visit) + open children.
function pestSeries(n, dates, { price = '117.00', parentOverrides = {}, childOverrides = {} } = {}) {
  const parentId = VISIT(n * 100);
  const parent = {
    id: parentId, customer_id: CUSTOMER(n), scheduled_date: '2025-12-05', status: 'completed', estimated_price: price, primary_line_price: null,
    discount_type: null, discount_amount: null, discount_dollars: null, line_discount_id: null, line_discount_dollars: null, annual_prepay_term_id: null, prepaid_amount: null,
    is_callback: false, is_recurring: true, recurring_parent_id: null, recurring_template_overrides: null, _line: 'pest_control', _cadence: 'quarterly', ...parentOverrides,
  };
  const children = dates.map((d, i) => ({
    id: VISIT(n * 100 + i + 1), customer_id: CUSTOMER(n), scheduled_date: d, status: 'pending', estimated_price: price, primary_line_price: null,
    discount_type: null, discount_amount: null, discount_dollars: null, line_discount_id: null, line_discount_dollars: null, annual_prepay_term_id: null, prepaid_amount: null,
    is_callback: false, is_recurring: true, recurring_parent_id: parentId, recurring_template_overrides: null, _line: 'pest_control', _cadence: 'quarterly', ...childOverrides,
  }));
  return { parentId, parent, children, all: [parent, ...children] };
}

function noticeRow(n, overrides = {}) {
  return {
    id: `60000000-0000-4000-8000-00000000000${n}`, batch_id: '70000000-0000-4000-8000-000000000001', customer_id: CUSTOMER(n), current_amount_cents: 11700, new_amount_cents: 12100,
    cadence_label: 'application', effective_date: '2026-12-10', notice_token: `tok${n}`, status: 'sent', email_sent: true, sms_sent: true, sent_at: new Date('2026-11-02T15:00:00Z'),
    metadata: { source: 'rate_review', batch_key: BATCH_KEY, planned_send_date: TODAY, rate_unit: 'application', visits_per_year: 4, current_rate_source: 'visit_median' },
    rate_review_row_id: ROW(n), billing_lane: 'per_application', family_key: 'pest_control', noticed_current_cents: 11700, noticed_new_cents: 12100,
    applies_from_visit_id: null, applied_at: null, apply_hold_reason: null, apply_attempts: 0, ...overrides,
  };
}

module.exports = {
  CUSTOMER, VISIT, ROW, TERM, BATCH_KEY, TODAY, NOW,
  createFakeDb, batchRow, snapshotRow, customerRow, pestSeries, noticeRow, same,
};
